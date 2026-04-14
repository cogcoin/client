import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import net from "node:net";

import { acquireFileLock, FileLockBusyError } from "../wallet/fs/lock.js";
import { writeRuntimeStatusFile } from "../wallet/fs/status-file.js";
import {
  INDEXER_DAEMON_SCHEMA_VERSION,
  INDEXER_DAEMON_SERVICE_API_VERSION,
  type ManagedIndexerDaemonRuntimeIdentity,
  type ManagedIndexerDaemonObservedStatus,
  type ManagedIndexerDaemonStatus,
} from "./types.js";
import { resolveManagedServicePaths, UNINITIALIZED_WALLET_ROOT_ID } from "./service-paths.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

interface DaemonRequest {
  id: string;
  method: "GetStatus" | "OpenSnapshot" | "ReadSnapshot" | "CloseSnapshot";
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
  close(): Promise<void>;
}

export type IndexerDaemonCompatibility =
  | "compatible"
  | "service-version-mismatch"
  | "wallet-root-mismatch"
  | "schema-mismatch"
  | "unreachable"
  | "protocol-error";

export interface IndexerDaemonProbeResult {
  compatibility: IndexerDaemonCompatibility;
  status: ManagedIndexerDaemonObservedStatus | null;
  client: IndexerDaemonClient | null;
  error: string | null;
}

export interface IndexerDaemonStopResult {
  status: "stopped" | "not-running";
  walletRootId: string;
}

export interface CoherentIndexerSnapshotLease {
  payload: IndexerSnapshotPayload;
  status: ManagedIndexerDaemonStatus;
}

type IndexerRuntimeIdentityLike = {
  serviceApiVersion: string;
  schemaVersion: string;
  walletRootId: string;
  daemonInstanceId: string;
  processId: number | null;
  startedAtUnixMs: number;
  state?: ManagedIndexerDaemonStatus["state"] | string;
};

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

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

function createIndexerDaemonClient(socketPath: string): IndexerDaemonClient {
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

      socket.setTimeout(15_000);
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
    async close() {
      return;
    },
  };
}

function validateIndexerRuntimeIdentity(
  identity: IndexerRuntimeIdentityLike,
  expectedWalletRootId: string,
): void {
  if (identity.serviceApiVersion !== INDEXER_DAEMON_SERVICE_API_VERSION) {
    throw new Error("indexer_daemon_service_version_mismatch");
  }

  if (identity.walletRootId !== expectedWalletRootId) {
    throw new Error("indexer_daemon_wallet_root_mismatch");
  }

  if (identity.schemaVersion !== INDEXER_DAEMON_SCHEMA_VERSION || identity.state === "schema-mismatch") {
    throw new Error("indexer_daemon_schema_mismatch");
  }
}

function validateIndexerDaemonStatus(
  status: ManagedIndexerDaemonObservedStatus,
  expectedWalletRootId: string,
): void {
  validateIndexerRuntimeIdentity(status, expectedWalletRootId);
}

function validateIndexerSnapshotHandle(
  handle: IndexerSnapshotHandle,
  expectedWalletRootId: string,
): void {
  validateIndexerRuntimeIdentity(handle, expectedWalletRootId);
}

function validateIndexerSnapshotPayload(
  payload: IndexerSnapshotPayload,
  handle: IndexerSnapshotHandle,
  expectedWalletRootId: string,
): void {
  validateIndexerRuntimeIdentity(payload, expectedWalletRootId);

  if (
    payload.token !== handle.token
    || payload.daemonInstanceId !== handle.daemonInstanceId
    || payload.processId !== handle.processId
    || payload.startedAtUnixMs !== handle.startedAtUnixMs
    || payload.snapshotSeq !== handle.snapshotSeq
    || payload.tipHeight !== handle.tipHeight
    || payload.tipHash !== handle.tipHash
    || payload.openedAtUnixMs !== handle.openedAtUnixMs
  ) {
    throw new Error("indexer_daemon_snapshot_identity_mismatch");
  }

  if (payload.tip === null) {
    if (payload.tipHeight !== null || payload.tipHash !== null) {
      throw new Error("indexer_daemon_snapshot_identity_mismatch");
    }
  } else if (payload.tip.height !== payload.tipHeight || payload.tip.blockHashHex !== payload.tipHash) {
    throw new Error("indexer_daemon_snapshot_identity_mismatch");
  }
}

function isUnreachableIndexerDaemonError(error: unknown): boolean {
  if (error instanceof Error) {
    if (
      error.message === "indexer_daemon_connection_closed"
      || error.message === "indexer_daemon_request_timeout"
      || error.message === "indexer_daemon_protocol_error"
    ) {
      return false;
    }

    if ("code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET";
    }
  }

  return false;
}

function buildStatusFromSnapshotHandle(handle: IndexerSnapshotHandle): ManagedIndexerDaemonStatus {
  return {
    serviceApiVersion: INDEXER_DAEMON_SERVICE_API_VERSION,
    binaryVersion: handle.binaryVersion,
    buildId: handle.buildId,
    updatedAtUnixMs: Math.max(handle.heartbeatAtUnixMs, handle.openedAtUnixMs),
    walletRootId: handle.walletRootId,
    daemonInstanceId: handle.daemonInstanceId,
    schemaVersion: INDEXER_DAEMON_SCHEMA_VERSION,
    state: handle.state,
    processId: handle.processId,
    startedAtUnixMs: handle.startedAtUnixMs,
    heartbeatAtUnixMs: handle.heartbeatAtUnixMs,
    ipcReady: true,
    rpcReachable: handle.rpcReachable,
    coreBestHeight: handle.coreBestHeight,
    coreBestHash: handle.coreBestHash,
    appliedTipHeight: handle.appliedTipHeight,
    appliedTipHash: handle.appliedTipHash,
    snapshotSeq: handle.snapshotSeq,
    backlogBlocks: handle.backlogBlocks,
    reorgDepth: handle.reorgDepth,
    lastAppliedAtUnixMs: handle.lastAppliedAtUnixMs,
    activeSnapshotCount: handle.activeSnapshotCount,
    lastError: handle.lastError,
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
      return {
        compatibility: error instanceof Error
          ? error.message === "indexer_daemon_service_version_mismatch"
            ? "service-version-mismatch"
            : error.message === "indexer_daemon_wallet_root_mismatch"
              ? "wallet-root-mismatch"
              : "schema-mismatch"
          : "protocol-error",
        status,
        client: null,
        error: error instanceof Error ? error.message : "indexer_daemon_protocol_error",
      };
    }
  } catch (error) {
    await client.close().catch(() => undefined);
    return {
      compatibility: isUnreachableIndexerDaemonError(error) ? "unreachable" : "protocol-error",
      status: null,
      client: null,
      error: isUnreachableIndexerDaemonError(error)
        ? null
        : error instanceof Error
          ? "indexer_daemon_protocol_error"
          : "indexer_daemon_protocol_error",
    };
  }
}

async function waitForIndexerDaemon(
  dataDir: string,
  walletRootId: string,
  timeoutMs: number,
): Promise<IndexerDaemonClient> {
  const paths = resolveManagedServicePaths(dataDir, walletRootId);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const probe = await probeIndexerDaemonAtSocket(paths.indexerDaemonSocketPath, walletRootId);

    if (probe.compatibility === "compatible" && probe.client !== null) {
      return probe.client;
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
        status: buildStatusFromSnapshotHandle(handle),
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
  return readJsonFile<ManagedIndexerDaemonObservedStatus>(paths.indexerDaemonStatusPath);
}

export async function attachOrStartIndexerDaemon(options: {
  dataDir: string;
  databasePath: string;
  walletRootId?: string;
  startupTimeoutMs?: number;
}): Promise<IndexerDaemonClient> {
  const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const paths = resolveManagedServicePaths(options.dataDir, walletRootId);
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  const existingProbe = await probeIndexerDaemonAtSocket(paths.indexerDaemonSocketPath, walletRootId);
  if (existingProbe.compatibility === "compatible" && existingProbe.client !== null) {
    return existingProbe.client;
  }

  if (existingProbe.compatibility !== "unreachable") {
    throw new Error(existingProbe.error ?? "indexer_daemon_protocol_error");
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
      if (liveProbe.compatibility === "compatible" && liveProbe.client !== null) {
        return liveProbe.client;
      }

      if (liveProbe.compatibility !== "unreachable") {
        throw new Error(liveProbe.error ?? "indexer_daemon_protocol_error");
      }

      await mkdir(paths.indexerServiceRoot, { recursive: true });
      const daemonEntryPath = fileURLToPath(new URL("./indexer-daemon-main.js", import.meta.url));
      const child = spawn(process.execPath, [
        daemonEntryPath,
        `--data-dir=${options.dataDir}`,
        `--database-path=${options.databasePath}`,
        `--wallet-root-id=${walletRootId}`,
      ], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      return await waitForIndexerDaemon(options.dataDir, walletRootId, startupTimeoutMs);
    } finally {
      await lock.release();
    }
  } catch (error) {
    if (error instanceof FileLockBusyError) {
      return waitForIndexerDaemon(options.dataDir, walletRootId, startupTimeoutMs);
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
    const status = await readJsonFile<ManagedIndexerDaemonStatus>(paths.indexerDaemonStatusPath);
    const processId = status?.processId ?? null;

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
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) {
        throw error;
      }
    }

    await waitForProcessExit(
      processId,
      options.shutdownTimeoutMs ?? 5_000,
      "indexer_daemon_stop_timeout",
    );
    await clearIndexerDaemonRuntimeArtifacts(paths);
    return {
      status: "stopped",
      walletRootId,
    };
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
  return readJsonFile<ManagedIndexerDaemonStatus>(paths.indexerDaemonStatusPath);
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
