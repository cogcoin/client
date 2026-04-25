import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { acquireFileLock, FileLockBusyError } from "../../wallet/fs/lock.js";
import {
  buildManagedIndexerStatusFromSnapshotHandle,
  validateIndexerSnapshotHandle,
  validateIndexerSnapshotPayload,
} from "../managed-runtime/indexer-policy.js";
import { attachOrStartManagedIndexerRuntime } from "../managed-runtime/indexer-runtime.js";
import { readJsonFileIfPresent } from "../managed-runtime/status.js";
import type {
  IndexerDaemonCompatibility,
  ManagedIndexerDaemonProbeResult,
} from "../managed-runtime/types.js";
import type { ManagedIndexerDaemonObservedStatus } from "../types.js";
import { resolveManagedServicePaths, UNINITIALIZED_WALLET_ROOT_ID } from "../service-paths.js";
import {
  createIndexerDaemonClient,
  probeIndexerDaemonAtSocket,
} from "./client.js";
import {
  DEFAULT_INDEXER_DAEMON_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_INDEXER_DAEMON_STARTUP_TIMEOUT_MS,
  sleep,
  stopIndexerDaemonService as stopIndexerDaemonServiceInternal,
  stopIndexerDaemonServiceWithLockHeld,
  waitForIndexerDaemon,
} from "./process.js";
import type {
  CoherentIndexerSnapshotLease,
  IndexerDaemonClient,
  IndexerDaemonStopResult,
  ManagedIndexerDaemonServiceLifetime,
} from "./types.js";

export type { IndexerDaemonCompatibility } from "../managed-runtime/types.js";

export const INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED =
  "indexer_daemon_background_follow_recovery_failed";

const INDEXER_DAEMON_BACKGROUND_FOLLOW_NOT_ACTIVE = "indexer_daemon_background_follow_not_active";

export type IndexerDaemonProbeResult = ManagedIndexerDaemonProbeResult<IndexerDaemonClient>;

export async function probeIndexerDaemon(options: {
  dataDir: string;
  walletRootId?: string;
}): Promise<IndexerDaemonProbeResult> {
  const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const paths = resolveManagedServicePaths(options.dataDir, walletRootId);
  return probeIndexerDaemonAtSocket(paths.indexerDaemonSocketPath, walletRootId);
}

export async function readSnapshotWithRetry(
  daemon: IndexerDaemonClient,
  expectedWalletRootId: string,
): Promise<CoherentIndexerSnapshotLease> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const handle = await daemon.openSnapshot();

    try {
      validateIndexerSnapshotHandle(handle, expectedWalletRootId);
      const payload = await daemon.readSnapshot(handle.token);
      validateIndexerSnapshotPayload(payload, handle, expectedWalletRootId);
      return {
        payload,
        status: buildManagedIndexerStatusFromSnapshotHandle(handle),
      };
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof Error)
        || (error.message !== "indexer_daemon_snapshot_invalid" && error.message !== "indexer_daemon_snapshot_rotated")
        || attempt > 0
      ) {
        throw error;
      }
    } finally {
      await daemon.closeSnapshot(handle.token).catch(() => undefined);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("indexer_daemon_snapshot_invalid");
}

export async function readObservedIndexerDaemonStatus(options: {
  dataDir: string;
  walletRootId?: string;
}): Promise<ManagedIndexerDaemonObservedStatus | null> {
  const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const paths = resolveManagedServicePaths(options.dataDir, walletRootId);
  return readJsonFileIfPresent<ManagedIndexerDaemonObservedStatus>(paths.indexerDaemonStatusPath);
}

export async function attachOrStartIndexerDaemon(options: {
  dataDir: string;
  databasePath: string;
  walletRootId?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  serviceLifetime?: ManagedIndexerDaemonServiceLifetime;
  ensureBackgroundFollow?: boolean;
  expectedBinaryVersion?: string | null;
}): Promise<IndexerDaemonClient> {
  const requestBackgroundFollow = async (
    client: IndexerDaemonClient,
    observedStatus: ManagedIndexerDaemonObservedStatus | null = null,
  ): Promise<IndexerDaemonClient> => {
    if (options.ensureBackgroundFollow !== true) {
      return client;
    }

    if (observedStatus?.backgroundFollowActive === true) {
      return client;
    }

    await client.resumeBackgroundFollow();
    const status = await client.getStatus();

    if (status.backgroundFollowActive !== true) {
      throw new Error(INDEXER_DAEMON_BACKGROUND_FOLLOW_NOT_ACTIVE);
    }

    return client;
  };
  const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const paths = resolveManagedServicePaths(options.dataDir, walletRootId);
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_INDEXER_DAEMON_STARTUP_TIMEOUT_MS;
  const serviceLifetime = options.serviceLifetime ?? "persistent";
  const expectedBinaryVersion = options.expectedBinaryVersion ?? null;

  const startDaemon = async (): Promise<IndexerDaemonClient> => {
    await mkdir(paths.indexerServiceRoot, { recursive: true });
    const daemonEntryPath = fileURLToPath(new URL("../indexer-daemon-main.js", import.meta.url));
    const spawnOptions = serviceLifetime === "ephemeral"
      ? {
        stdio: "ignore" as const,
      }
      : {
        detached: true,
        stdio: "ignore" as const,
      };
    const child = spawn(process.execPath, [
      daemonEntryPath,
      `--data-dir=${options.dataDir}`,
      `--database-path=${options.databasePath}`,
      `--wallet-root-id=${walletRootId}`,
    ], {
      ...spawnOptions,
    });
    if (serviceLifetime !== "ephemeral") {
      child.unref();
    }

    try {
      await waitForIndexerDaemon(options.dataDir, walletRootId, startupTimeoutMs);
    } catch (error) {
      if (child.pid !== undefined) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          // ignore shutdown failures while unwinding startup errors
        }
      }
      throw error;
    }

    return createIndexerDaemonClient(paths.indexerDaemonSocketPath, {
      serviceLifetime,
      ownership: "started",
      shutdownOwnedDaemon: async () => {
        await stopIndexerDaemonService({
          dataDir: options.dataDir,
          walletRootId,
          shutdownTimeoutMs: options.shutdownTimeoutMs,
        });
      },
    });
  };

  return attachOrStartManagedIndexerRuntime({
    ...options,
    walletRootId,
    startupTimeoutMs,
    expectedBinaryVersion,
  }, {
    getPaths: (runtimeOptions) => resolveManagedServicePaths(runtimeOptions.dataDir, runtimeOptions.walletRootId),
    probeDaemon: async (runtimeOptions, runtimePaths) =>
      probeIndexerDaemonAtSocket(runtimePaths.indexerDaemonSocketPath, runtimeOptions.walletRootId),
    requestBackgroundFollow,
    closeClient: async (client) => {
      await client.close();
    },
    acquireStartLock: async (runtimeOptions, runtimePaths) =>
      acquireFileLock(runtimePaths.indexerDaemonLockPath, {
        purpose: "indexer-daemon-start",
        walletRootId: runtimeOptions.walletRootId,
        dataDir: runtimeOptions.dataDir,
        databasePath: runtimeOptions.databasePath,
      }),
    startDaemon: async () => startDaemon(),
    stopWithLockHeld: async (runtimeOptions, _runtimePaths, processId) =>
      stopIndexerDaemonServiceWithLockHeld({
        dataDir: runtimeOptions.dataDir,
        walletRootId: runtimeOptions.walletRootId,
        shutdownTimeoutMs: runtimeOptions.shutdownTimeoutMs,
        paths: resolveManagedServicePaths(runtimeOptions.dataDir, runtimeOptions.walletRootId),
        processId,
      }),
    isLockBusyError: (error) => error instanceof FileLockBusyError,
    sleep,
  });
}

export async function stopIndexerDaemonService(options: {
  dataDir: string;
  walletRootId?: string;
  shutdownTimeoutMs?: number;
}): Promise<IndexerDaemonStopResult> {
  return stopIndexerDaemonServiceInternal({
    ...options,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_INDEXER_DAEMON_SHUTDOWN_TIMEOUT_MS,
  });
}
