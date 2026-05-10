import { access, constants, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  attachOrStartIndexerDaemon,
  probeIndexerDaemon,
  readSnapshotWithRetry,
} from "../../bitcoind/indexer-daemon.js";
import { probeManagedBitcoindService } from "../../bitcoind/service.js";
import { resolveManagedServicePaths } from "../../bitcoind/service-paths.js";
import type { ManagedBitcoindObservedStatus, ManagedBitcoindServiceStatus } from "../../bitcoind/types.js";
import { openClient } from "../../client.js";
import { openSqliteStore } from "../../sqlite/index.js";
import { clearOrphanedFileLock } from "../fs/lock.js";
import type { WalletRepairContext, WalletRepairResult } from "./types.js";

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
    case "rawtx-zmq-missing":
      return "rawtx-zmq-missing";
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

export async function reportRepairProgress(
  context: Pick<WalletRepairContext, "progress">,
  code: string,
  message: string,
): Promise<void> {
  await context.progress({ code, message });
}

export function isManagedBitcoindStartupWarmupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return message === "managed_bitcoind_service_starting"
    || message === "bitcoind_rpc_timeout"
    || message === "bitcoind_cookie_timeout"
    || /^bitcoind_rpc_[^_]+_-28(?:_|$)/.test(message)
    || message.startsWith("The managed Bitcoin RPC cookie file is unavailable at ")
    || message.startsWith("The managed Bitcoin RPC cookie file could not be read at ");
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

export function isManagedBitcoindRpcUnavailableError(error: unknown): boolean {
  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") {
      return true;
    }
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return error.message === "bitcoind_cookie_timeout"
    || error.message.includes("cookie file is unavailable")
    || error.message.includes("ECONNREFUSED")
    || error.message.includes("ECONNRESET")
    || error.message.includes("socket hang up");
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
  await clearManagedBitcoindArtifactRoot(servicePaths.walletRuntimeRoot);
}

async function readManagedBitcoindStatusAtRoot(
  serviceRoot: string,
): Promise<ManagedBitcoindObservedStatus | null> {
  try {
    return JSON.parse(await readFile(join(serviceRoot, "bitcoind-status.json"), "utf8")) as ManagedBitcoindObservedStatus;
  } catch {
    return null;
  }
}

async function clearManagedBitcoindArtifactRoot(serviceRoot: string): Promise<void> {
  await rm(join(serviceRoot, "bitcoind-status.json"), { force: true }).catch(() => undefined);
  await rm(join(serviceRoot, "bitcoind.pid"), { force: true }).catch(() => undefined);
  await rm(join(serviceRoot, "bitcoind.ready"), { force: true }).catch(() => undefined);
  await rm(join(serviceRoot, "bitcoind-config.json"), { force: true }).catch(() => undefined);
  await rm(join(serviceRoot, "bitcoind-wallet.json"), { force: true }).catch(() => undefined);
}

async function stopManagedBitcoindPid(pid: number | null): Promise<void> {
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

  await waitForProcessExit(pid, 15_000, "managed_bitcoind_stop_timeout");
}

export async function clearManagedBitcoindArtifactsForDataDir(
  servicePaths: ReturnType<typeof resolveManagedServicePaths>,
  dataDir: string,
): Promise<void> {
  const serviceRoots = new Set<string>([servicePaths.walletRuntimeRoot]);

  const runtimeEntries = await readdir(servicePaths.runtimeRoot, { withFileTypes: true }).catch((error) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  });

  for (const entry of runtimeEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const serviceRoot = join(servicePaths.runtimeRoot, entry.name);
    const status = await readManagedBitcoindStatusAtRoot(serviceRoot);

    if (status?.dataDir === dataDir) {
      serviceRoots.add(serviceRoot);
    }
  }

  for (const serviceRoot of serviceRoots) {
    const status = await readManagedBitcoindStatusAtRoot(serviceRoot);

    if (status?.dataDir === dataDir) {
      await stopManagedBitcoindPid(status.processId);
    }

    await clearManagedBitcoindArtifactRoot(serviceRoot);
  }
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
