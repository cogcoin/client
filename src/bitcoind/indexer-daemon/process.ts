import { mkdir, rm } from "node:fs/promises";

import { acquireFileLock } from "../../wallet/fs/lock.js";
import { writeRuntimeStatusFile } from "../../wallet/fs/status-file.js";
import { readJsonFileIfPresent } from "../managed-runtime/status.js";
import type { ManagedIndexerDaemonStatus } from "../types.js";
import { resolveManagedServicePaths, UNINITIALIZED_WALLET_ROOT_ID } from "../service-paths.js";
import type { IndexerDaemonStopResult } from "./types.js";
import { probeIndexerDaemonAtSocket } from "./client.js";

export const DEFAULT_INDEXER_DAEMON_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_INDEXER_DAEMON_SHUTDOWN_TIMEOUT_MS = 5_000;
const FORCE_KILL_TIMEOUT_MS = 5_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function isIndexerDaemonProcessAlive(pid: number | null): Promise<boolean> {
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

export async function waitForIndexerDaemonProcessExit(
  pid: number,
  timeoutMs: number,
  errorCode: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!await isIndexerDaemonProcessAlive(pid)) {
      return;
    }

    await sleep(50);
  }

  throw new Error(errorCode);
}

export async function clearIndexerDaemonRuntimeArtifacts(
  paths: ReturnType<typeof resolveManagedServicePaths>,
): Promise<void> {
  await rm(paths.indexerDaemonStatusPath, { force: true }).catch(() => undefined);
  await rm(paths.indexerDaemonSocketPath, { force: true }).catch(() => undefined);
}

export function ignoreIndexerDaemonProcessNotFound(error: unknown): void {
  if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) {
    throw error;
  }
}

export async function stopIndexerDaemonServiceWithLockHeld(options: {
  dataDir: string;
  walletRootId?: string;
  shutdownTimeoutMs?: number;
  paths?: ReturnType<typeof resolveManagedServicePaths>;
  processId?: number | null;
}): Promise<IndexerDaemonStopResult> {
  const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const paths = options.paths ?? resolveManagedServicePaths(options.dataDir, walletRootId);
  const status = await readJsonFileIfPresent<ManagedIndexerDaemonStatus>(paths.indexerDaemonStatusPath);
  const processId = options.processId ?? status?.processId ?? null;

  if (status === null || processId === null || !await isIndexerDaemonProcessAlive(processId)) {
    await clearIndexerDaemonRuntimeArtifacts(paths);
    return {
      status: "not-running",
      walletRootId,
    };
  }

  try {
    process.kill(processId, "SIGTERM");
  } catch (error) {
    ignoreIndexerDaemonProcessNotFound(error);
  }

  try {
    await waitForIndexerDaemonProcessExit(
      processId,
      options.shutdownTimeoutMs ?? DEFAULT_INDEXER_DAEMON_SHUTDOWN_TIMEOUT_MS,
      "indexer_daemon_stop_timeout",
    );
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "indexer_daemon_stop_timeout") {
      throw error;
    }

    try {
      process.kill(processId, "SIGKILL");
    } catch (killError) {
      ignoreIndexerDaemonProcessNotFound(killError);
    }

    await waitForIndexerDaemonProcessExit(
      processId,
      FORCE_KILL_TIMEOUT_MS,
      "indexer_daemon_stop_timeout",
    );
  }

  await clearIndexerDaemonRuntimeArtifacts(paths);
  return {
    status: "stopped",
    walletRootId,
  };
}

export async function waitForIndexerDaemon(
  dataDir: string,
  walletRootId: string,
  timeoutMs: number,
): Promise<void> {
  const paths = resolveManagedServicePaths(dataDir, walletRootId);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const probe = await probeIndexerDaemonAtSocket(paths.indexerDaemonSocketPath, walletRootId);

    if (probe.compatibility === "compatible" && probe.client !== null) {
      await probe.client.close().catch(() => undefined);
      return;
    }

    if (probe.compatibility !== "unreachable") {
      throw new Error(probe.error ?? "indexer_daemon_protocol_error");
    }

    await sleep(250);
  }

  throw new Error("indexer_daemon_start_timeout");
}

export async function stopIndexerDaemonService(options: {
  dataDir: string;
  walletRootId?: string;
  shutdownTimeoutMs?: number;
}): Promise<IndexerDaemonStopResult> {
  const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const paths = resolveManagedServicePaths(options.dataDir, walletRootId);
  const lock = await acquireFileLock(paths.indexerDaemonLockPath, {
    purpose: "indexer-daemon-stop",
    walletRootId,
    dataDir: options.dataDir,
  });

  try {
    return await stopIndexerDaemonServiceWithLockHeld({
      ...options,
      walletRootId,
      paths,
    });
  } finally {
    await lock.release();
  }
}

export async function shutdownIndexerDaemonForTesting(options: {
  dataDir: string;
  walletRootId?: string;
}): Promise<void> {
  await stopIndexerDaemonService(options).catch(async () => {
    const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
    const paths = resolveManagedServicePaths(options.dataDir, walletRootId);
    await rm(paths.indexerDaemonSocketPath, { force: true }).catch(() => undefined);
  });
}

export async function readIndexerDaemonStatusForTesting(options: {
  dataDir: string;
  walletRootId?: string;
}): Promise<ManagedIndexerDaemonStatus | null> {
  const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const paths = resolveManagedServicePaths(options.dataDir, walletRootId);
  return readJsonFileIfPresent<ManagedIndexerDaemonStatus>(paths.indexerDaemonStatusPath);
}

export async function writeIndexerDaemonStatusForTesting(
  options: {
    dataDir: string;
    walletRootId?: string;
  },
  status: ManagedIndexerDaemonStatus,
): Promise<void> {
  const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const paths = resolveManagedServicePaths(options.dataDir, walletRootId);
  await mkdir(paths.indexerServiceRoot, { recursive: true });
  await writeRuntimeStatusFile(paths.indexerDaemonStatusPath, status);
}
