import { access, constants, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
  attachOrStartIndexerDaemon,
  probeIndexerDaemon,
  readSnapshotWithRetry,
} from "../../bitcoind/indexer-daemon.js";
import { probeManagedBitcoindService } from "../../bitcoind/service.js";
import { resolveManagedServicePaths } from "../../bitcoind/service-paths.js";
import type { ManagedBitcoindServiceStatus } from "../../bitcoind/types.js";
import { openClient } from "../../client.js";
import { openSqliteStore } from "../../sqlite/index.js";
import { clearOrphanedFileLock } from "../fs/lock.js";
import type { WalletRepairResult } from "./types.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureIndexerDatabaseHealthy(options: {
  databasePath: string;
  dataDir: string;
  walletRootId: string;
  resetIfNeeded: boolean;
}): Promise<boolean> {
  try {
    if (await pathExists(options.databasePath)) {
      const header = await readFile(options.databasePath).then((buffer) => buffer.subarray(0, 16).toString("utf8"));

      if (header.length > 0 && header !== "SQLite format 3\u0000") {
        throw new Error("indexer_database_not_sqlite");
      }
    }

    const store = await openSqliteStore({ filename: options.databasePath });

    try {
      const client = await openClient({ store });
      try {
        await client.getTip();
      } finally {
        await client.close();
      }
    } finally {
      await store.close();
    }

    return false;
  } catch {
    if (!options.resetIfNeeded) {
      throw new Error("wallet_repair_indexer_reset_requires_yes");
    }

    await rm(options.databasePath, { force: true }).catch(() => undefined);
    await rm(`${options.databasePath}-wal`, { force: true }).catch(() => undefined);
    await rm(`${options.databasePath}-shm`, { force: true }).catch(() => undefined);
    await mkdir(dirname(options.databasePath), { recursive: true });
    return true;
  }
}

export function mapIndexerCompatibilityToRepairIssue(
  compatibility: Awaited<ReturnType<typeof probeIndexerDaemon>>["compatibility"],
): WalletRepairResult["indexerCompatibilityIssue"] {
  switch (compatibility) {
    case "service-version-mismatch":
      return "service-version-mismatch";
    case "wallet-root-mismatch":
      return "wallet-root-mismatch";
    case "schema-mismatch":
      return "schema-mismatch";
    default:
      return "none";
  }
}

export function mapBitcoindCompatibilityToRepairIssue(
  compatibility: Awaited<ReturnType<typeof probeManagedBitcoindService>>["compatibility"],
): WalletRepairResult["bitcoindCompatibilityIssue"] {
  switch (compatibility) {
    case "service-version-mismatch":
      return "service-version-mismatch";
    case "wallet-root-mismatch":
      return "wallet-root-mismatch";
    case "runtime-mismatch":
      return "runtime-mismatch";
    default:
      return "none";
  }
}

export function mapBitcoindRepairHealth(options: {
  serviceState: ManagedBitcoindServiceStatus["state"] | null;
  catchingUp: boolean;
  replica: { proofStatus?: "missing" | "mismatch" | "ready" | "not-proven" } | null;
}): WalletRepairResult["bitcoindPostRepairHealth"] {
  if (options.serviceState === null) {
    return "unavailable";
  }

  if (options.serviceState === "starting" || options.serviceState === "stopping") {
    return "starting";
  }

  if (options.serviceState !== "ready") {
    return "failed";
  }

  if (options.replica?.proofStatus === "missing" || options.replica?.proofStatus === "mismatch") {
    return "failed";
  }

  if (options.catchingUp) {
    return "catching-up";
  }

  return "ready";
}

function mapLeaseStateToRepairHealth(state: string): WalletRepairResult["indexerPostRepairHealth"] {
  switch (state) {
    case "synced":
      return "synced";
    case "catching-up":
    case "reorging":
      return "catching-up";
    case "starting":
    case "stopping":
      return "starting";
    default:
      return "failed";
  }
}

const INDEXER_DAEMON_HEARTBEAT_STALE_MS = 15_000;

export async function verifyIndexerPostRepairHealth(options: {
  daemon: Awaited<ReturnType<typeof attachOrStartIndexerDaemon>>;
  probeIndexerDaemon: typeof probeIndexerDaemon;
  dataDir: string;
  walletRootId: string;
  nowUnixMs: number;
}): Promise<{
  health: WalletRepairResult["indexerPostRepairHealth"];
  daemonInstanceId: string;
}> {
  try {
    const lease = await readSnapshotWithRetry(options.daemon, options.walletRootId);
    return {
      health: mapLeaseStateToRepairHealth(lease.status.state),
      daemonInstanceId: lease.status.daemonInstanceId,
    };
  } catch (leaseError) {
    const probe = await options.probeIndexerDaemon({
      dataDir: options.dataDir,
      walletRootId: options.walletRootId,
    });

    try {
      if (
        probe.compatibility === "compatible"
        && probe.status !== null
        && (options.nowUnixMs - probe.status.heartbeatAtUnixMs) <= INDEXER_DAEMON_HEARTBEAT_STALE_MS
        && (probe.status.state === "starting" || probe.status.state === "catching-up" || probe.status.state === "reorging")
      ) {
        return {
          health: mapLeaseStateToRepairHealth(probe.status.state),
          daemonInstanceId: probe.status.daemonInstanceId,
        };
      }
    } finally {
      await probe.client?.close().catch(() => undefined);
    }

    throw leaseError;
  }
}

export async function isProcessAlive(pid: number | null): Promise<boolean> {
  if (pid === null) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }

    return true;
  }
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs = 15_000,
  errorCode = "indexer_daemon_stop_timeout",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!await isProcessAlive(pid)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(errorCode);
}

export async function clearIndexerDaemonArtifacts(
  servicePaths: ReturnType<typeof resolveManagedServicePaths>,
): Promise<void> {
  await rm(servicePaths.indexerDaemonStatusPath, { force: true }).catch(() => undefined);
  await rm(servicePaths.indexerDaemonSocketPath, { force: true }).catch(() => undefined);
}

export async function clearManagedBitcoindArtifacts(
  servicePaths: ReturnType<typeof resolveManagedServicePaths>,
): Promise<void> {
  await rm(servicePaths.bitcoindStatusPath, { force: true }).catch(() => undefined);
  await rm(servicePaths.bitcoindPidPath, { force: true }).catch(() => undefined);
  await rm(servicePaths.bitcoindReadyPath, { force: true }).catch(() => undefined);
  await rm(servicePaths.bitcoindWalletStatusPath, { force: true }).catch(() => undefined);
}

export async function stopRecordedManagedProcess(
  pid: number | null,
  errorCode: string,
): Promise<void> {
  if (pid === null || !await isProcessAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) {
      throw error;
    }
  }

  try {
    await waitForProcessExit(pid, 5_000, errorCode);
    return;
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) {
        throw error;
      }
    }
  }

  await waitForProcessExit(pid, 5_000, errorCode);
}

export async function clearOrphanedRepairLocks(lockPaths: readonly string[]): Promise<void> {
  for (const lockPath of lockPaths) {
    await clearOrphanedFileLock(lockPath, isProcessAlive);
  }
}
