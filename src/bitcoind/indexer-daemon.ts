import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import net from "node:net";

import { acquireFileLock, FileLockBusyError } from "../wallet/fs/lock.js";
import { writeRuntimeStatusFile } from "../wallet/fs/status-file.js";
import {
  buildManagedIndexerStatusFromSnapshotHandle,
  mapIndexerDaemonTransportError,
  mapIndexerDaemonValidationError,
  resolveIndexerDaemonProbeDecision,
  validateIndexerDaemonStatus,
  validateIndexerSnapshotHandle,
  validateIndexerSnapshotPayload,
} from "./managed-runtime/indexer-policy.js";
import { readJsonFileIfPresent } from "./managed-runtime/status.js";
import type {
  IndexerDaemonCompatibility,
  ManagedIndexerDaemonProbeResult,
} from "./managed-runtime/types.js";
import {
  type BootstrapPhase,
  type BootstrapProgress,
  type ManagedIndexerDaemonObservedStatus,
  type ManagedIndexerDaemonStatus,
} from "./types.js";
import { resolveManagedServicePaths, UNINITIALIZED_WALLET_ROOT_ID } from "./service-paths.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const FORCE_KILL_TIMEOUT_MS = 5_000;
const INDEXER_DAEMON_REQUEST_TIMEOUT_MS = 15_000;
const INDEXER_DAEMON_RESUME_BACKGROUND_FOLLOW_REQUEST_TIMEOUT_MS = 35_000;
const INDEXER_DAEMON_BACKGROUND_FOLLOW_NOT_ACTIVE = "indexer_daemon_background_follow_not_active";

export type { IndexerDaemonCompatibility } from "./managed-runtime/types.js";

export const INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED =
  "indexer_daemon_background_follow_recovery_failed";

interface DaemonRequest {
  id: string;
  method:
    | "GetStatus"
    | "OpenSnapshot"
    | "ReadSnapshot"
    | "CloseSnapshot"
    | "ResumeBackgroundFollow";
  token?: string;
}

interface DaemonResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface IndexerSnapshotHandle {
  token: string;
  expiresAtUnixMs: number;
  serviceApiVersion: string;
  binaryVersion: string;
  buildId: string | null;
  walletRootId: string;
  daemonInstanceId: string;
  schemaVersion: string;
  processId: number | null;
  startedAtUnixMs: number;
  state: ManagedIndexerDaemonStatus["state"];
  heartbeatAtUnixMs: number;
  rpcReachable: boolean;
  coreBestHeight: number | null;
  coreBestHash: string | null;
  appliedTipHeight: number | null;
  appliedTipHash: string | null;
  snapshotSeq: string | null;
  backlogBlocks: number | null;
  reorgDepth: number | null;
  lastAppliedAtUnixMs: number | null;
  activeSnapshotCount: number;
  lastError: string | null;
  backgroundFollowActive: boolean;
  bootstrapPhase: BootstrapPhase | null;
  bootstrapProgress: BootstrapProgress | null;
  cogcoinSyncHeight: number | null;
  cogcoinSyncTargetHeight: number | null;
  tipHeight: number | null;
  tipHash: string | null;
  openedAtUnixMs: number;
}

export interface IndexerSnapshotPayload {
  token: string;
  stateBase64: string;
  serviceApiVersion: string;
  schemaVersion: string;
  walletRootId: string;
  daemonInstanceId: string;
  processId: number | null;
  startedAtUnixMs: number;
  snapshotSeq: string | null;
  tipHeight: number | null;
  tipHash: string | null;
  openedAtUnixMs: number;
  tip: {
    height: number;
    blockHashHex: string;
    previousHashHex: string | null;
    stateHashHex: string | null;
  } | null;
  expiresAtUnixMs: number;
}

export interface IndexerDaemonClient {
  getStatus(): Promise<ManagedIndexerDaemonObservedStatus>;
  openSnapshot(): Promise<IndexerSnapshotHandle>;
  readSnapshot(token: string): Promise<IndexerSnapshotPayload>;
  closeSnapshot(token: string): Promise<void>;
  resumeBackgroundFollow(): Promise<void>;
  close(): Promise<void>;
}
export type IndexerDaemonProbeResult = ManagedIndexerDaemonProbeResult<IndexerDaemonClient>;

export interface IndexerDaemonStopResult {
  status: "stopped" | "not-running";
  walletRootId: string;
}

export interface CoherentIndexerSnapshotLease {
  payload: IndexerSnapshotPayload;
  status: ManagedIndexerDaemonStatus;
}

type ManagedIndexerDaemonServiceLifetime = "persistent" | "ephemeral";
type ManagedIndexerDaemonOwnership = "attached" | "started";

async function isProcessAlive(pid: number | null): Promise<boolean> {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  errorCode: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!await isProcessAlive(pid)) {
      return;
    }

    await sleep(50);
  }

  throw new Error(errorCode);
}

async function clearIndexerDaemonRuntimeArtifacts(
  paths: ReturnType<typeof resolveManagedServicePaths>,
): Promise<void> {
  await rm(paths.indexerDaemonStatusPath, { force: true }).catch(() => undefined);
  await rm(paths.indexerDaemonSocketPath, { force: true }).catch(() => undefined);
}

function ignoreProcessNotFound(error: unknown): void {
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

  if (status === null || processId === null || !await isProcessAlive(processId)) {
    await clearIndexerDaemonRuntimeArtifacts(paths);
    return {
      status: "not-running",
      walletRootId,
    };
  }

  try {
    process.kill(processId, "SIGTERM");
  } catch (error) {
    ignoreProcessNotFound(error);
  }

  try {
    await waitForProcessExit(
      processId,
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      "indexer_daemon_stop_timeout",
    );
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "indexer_daemon_stop_timeout") {
      throw error;
    }

    try {
      process.kill(processId, "SIGKILL");
    } catch (killError) {
      ignoreProcessNotFound(killError);
    }

    await waitForProcessExit(
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

function createIndexerDaemonClient(
  socketPath: string,
  closeOptions: {
    dataDir: string;
    walletRootId: string;
    serviceLifetime: ManagedIndexerDaemonServiceLifetime;
    ownership: ManagedIndexerDaemonOwnership;
    shutdownTimeoutMs?: number;
  } | null = null,
): IndexerDaemonClient {
  let closed = false;

  async function sendRequest<T>(request: DaemonRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = "";
      let settled = false;

      const finish = (handler: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        socket.destroy();
        handler();
      };

      socket.setTimeout(
        request.method === "ResumeBackgroundFollow"
          ? INDEXER_DAEMON_RESUME_BACKGROUND_FOLLOW_REQUEST_TIMEOUT_MS
          : INDEXER_DAEMON_REQUEST_TIMEOUT_MS,
      );
      socket.on("connect", () => {
        socket.write(`${JSON.stringify(request)}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let newlineIndex = buffer.indexOf("\n");

        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);

          if (line.trim().length === 0) {
            newlineIndex = buffer.indexOf("\n");
            continue;
          }

          let response: DaemonResponse;

          try {
            response = JSON.parse(line) as DaemonResponse;
          } catch (error) {
            finish(() => reject(error));
            return;
          }

          if (response.id !== request.id) {
            newlineIndex = buffer.indexOf("\n");
            continue;
          }

          if (!response.ok) {
            finish(() => reject(new Error(response.error ?? "indexer_daemon_request_failed")));
            return;
          }

          finish(() => resolve(response.result as T));
          return;
        }
      });
      socket.on("timeout", () => {
        finish(() => reject(new Error("indexer_daemon_request_timeout")));
      });
      socket.on("error", (error) => {
        finish(() => reject(error));
      });
      socket.on("end", () => {
        if (!settled) {
          finish(() => reject(new Error("indexer_daemon_connection_closed")));
        }
      });
    });
  }

  return {
    getStatus() {
      return sendRequest<ManagedIndexerDaemonStatus>({
        id: randomUUID(),
        method: "GetStatus",
      });
    },
    openSnapshot() {
      return sendRequest<IndexerSnapshotHandle>({
        id: randomUUID(),
        method: "OpenSnapshot",
      });
    },
    readSnapshot(token: string) {
      return sendRequest<IndexerSnapshotPayload>({
        id: randomUUID(),
        method: "ReadSnapshot",
        token,
      });
    },
    async closeSnapshot(token: string) {
      await sendRequest<null>({
        id: randomUUID(),
        method: "CloseSnapshot",
        token,
      });
    },
    async resumeBackgroundFollow() {
      await sendRequest<null>({
        id: randomUUID(),
        method: "ResumeBackgroundFollow",
      });
    },
    async close() {
      if (closed) {
        return;
      }

      closed = true;

      if (closeOptions === null || closeOptions.serviceLifetime !== "ephemeral" || closeOptions.ownership === "attached") {
        return;
      }

      await stopIndexerDaemonService({
        dataDir: closeOptions.dataDir,
        walletRootId: closeOptions.walletRootId,
        shutdownTimeoutMs: closeOptions.shutdownTimeoutMs,
      });
    },
  };
}

async function probeIndexerDaemonAtSocket(
  socketPath: string,
  expectedWalletRootId: string,
): Promise<IndexerDaemonProbeResult> {
  const client = createIndexerDaemonClient(socketPath);

  try {
    const status = await client.getStatus();
    try {
      validateIndexerDaemonStatus(status, expectedWalletRootId);
      return {
        compatibility: "compatible",
        status,
        client,
        error: null,
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      return mapIndexerDaemonValidationError<IndexerDaemonClient>(error, status);
    }
  } catch (error) {
    await client.close().catch(() => undefined);
    return mapIndexerDaemonTransportError<IndexerDaemonClient>(error);
  }
}

async function waitForIndexerDaemon(
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
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const serviceLifetime = options.serviceLifetime ?? "persistent";
  const expectedBinaryVersion = options.expectedBinaryVersion ?? null;

  const startDaemon = async (): Promise<IndexerDaemonClient> => {
    await mkdir(paths.indexerServiceRoot, { recursive: true });
    const daemonEntryPath = fileURLToPath(new URL("./indexer-daemon-main.js", import.meta.url));
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
      dataDir: options.dataDir,
      walletRootId,
      serviceLifetime,
      ownership: "started",
      shutdownTimeoutMs: options.shutdownTimeoutMs,
    });
  };

  const existingProbe = await probeIndexerDaemonAtSocket(paths.indexerDaemonSocketPath, walletRootId);
  const existingDecision = resolveIndexerDaemonProbeDecision({
    probe: existingProbe,
    expectedBinaryVersion,
  });

  if (existingDecision.action === "attach" && existingProbe.client !== null) {
    try {
      return await requestBackgroundFollow(existingProbe.client, existingProbe.status);
    } catch {
      await existingProbe.client.close().catch(() => undefined);
    }
  }

  if (existingDecision.action === "replace" && existingProbe.client !== null) {
    await existingProbe.client.close().catch(() => undefined);
  }

  if (existingDecision.action === "reject") {
    throw new Error(existingDecision.error ?? "indexer_daemon_protocol_error");
  }

  try {
    const lock = await acquireFileLock(paths.indexerDaemonLockPath, {
      purpose: "indexer-daemon-start",
      walletRootId,
      dataDir: options.dataDir,
      databasePath: options.databasePath,
    });

    try {
      const liveProbe = await probeIndexerDaemonAtSocket(paths.indexerDaemonSocketPath, walletRootId);
      const liveDecision = resolveIndexerDaemonProbeDecision({
        probe: liveProbe,
        expectedBinaryVersion,
      });

      if (liveDecision.action === "attach" && liveProbe.client !== null) {
        try {
          return await requestBackgroundFollow(liveProbe.client, liveProbe.status);
        } catch {
          await liveProbe.client.close().catch(() => undefined);
          await stopIndexerDaemonServiceWithLockHeld({
            dataDir: options.dataDir,
            walletRootId,
            shutdownTimeoutMs: options.shutdownTimeoutMs,
            paths,
            processId: liveProbe.status?.processId ?? null,
          });
        }
      } else if (liveDecision.action === "replace" && liveProbe.client !== null) {
        await liveProbe.client.close().catch(() => undefined);
        await stopIndexerDaemonServiceWithLockHeld({
          dataDir: options.dataDir,
          walletRootId,
          shutdownTimeoutMs: options.shutdownTimeoutMs,
          paths,
          processId: liveProbe.status?.processId ?? null,
        });
      } else if (liveDecision.action === "reject") {
        throw new Error(liveDecision.error ?? "indexer_daemon_protocol_error");
      }

      const daemon = await startDaemon();

      try {
        return await requestBackgroundFollow(daemon);
      } catch (error) {
        await daemon.close().catch(() => undefined);
        throw new Error(INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED, { cause: error });
      }
    } finally {
      await lock.release();
    }
  } catch (error) {
    if (error instanceof FileLockBusyError) {
      await waitForIndexerDaemon(options.dataDir, walletRootId, startupTimeoutMs);
      return attachOrStartIndexerDaemon(options);
    }

    throw error;
  }
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

export type { DaemonRequest, DaemonResponse };
