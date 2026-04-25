import { access, constants, readFile } from "node:fs/promises";

import { openClient } from "../../client.js";
import { openSqliteStore } from "../../sqlite/index.js";
import type { ClientTip } from "../../types.js";
import { writeRuntimeStatusFile } from "../../wallet/fs/status-file.js";
import { DEFAULT_SNAPSHOT_METADATA } from "../bootstrap.js";
import { createRpcClient } from "../node.js";
import { createBootstrapProgress } from "../progress/formatting.js";
import { resolveManagedServicePaths } from "../service-paths.js";
import type {
  ManagedBitcoindObservedStatus,
  ManagedBitcoindRuntimeConfig,
  ManagedIndexerDaemonStatus,
} from "../types.js";
import type {
  CoreTipStatus,
  IndexedTipStatus,
  IndexerDaemonLeaseStateResult,
  IndexerDaemonRuntimeState,
} from "./types.js";

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function readManagedBitcoindStatus(
  paths: ReturnType<typeof resolveManagedServicePaths>,
): Promise<ManagedBitcoindObservedStatus | null> {
  return readJsonFile<ManagedBitcoindObservedStatus>(paths.bitcoindStatusPath);
}

export function createIndexerSnapshotKey(appliedTip: ClientTip | null): string {
  return appliedTip === null
    ? "__null__"
    : [
      appliedTip.height,
      appliedTip.blockHashHex,
      appliedTip.stateHashHex ?? "",
    ].join(":");
}

export function createManagedBitcoindCookieUnavailableMessage(cookieFile: string): string {
  return `The managed Bitcoin RPC cookie file is unavailable at ${cookieFile} while preparing getblockchaininfo. The managed node is not running or is shutting down.`;
}

export async function readCoreTipStatus(
  paths: ReturnType<typeof resolveManagedServicePaths>,
): Promise<CoreTipStatus> {
  const runtimeConfig = await readJsonFile<ManagedBitcoindRuntimeConfig>(paths.bitcoindRuntimeConfigPath).catch(() => null);

  if (runtimeConfig?.rpc === undefined || runtimeConfig.rpc === null) {
    return {
      rpcReachable: false,
      coreBestHeight: null,
      coreBestHash: null,
      error: "managed_bitcoind_runtime_config_unavailable",
      prerequisiteUnavailable: true,
    };
  }

  try {
    await access(runtimeConfig.rpc.cookieFile, constants.R_OK);
  } catch {
    return {
      rpcReachable: false,
      coreBestHeight: null,
      coreBestHash: null,
      error: createManagedBitcoindCookieUnavailableMessage(runtimeConfig.rpc.cookieFile),
      prerequisiteUnavailable: true,
    };
  }

  try {
    const rpc = createRpcClient(runtimeConfig.rpc);
    const info = await rpc.getBlockchainInfo();
    return {
      rpcReachable: true,
      coreBestHeight: info.blocks,
      coreBestHash: info.bestblockhash,
      error: null,
      prerequisiteUnavailable: false,
    };
  } catch (error) {
    return {
      rpcReachable: false,
      coreBestHeight: null,
      coreBestHash: null,
      error: error instanceof Error ? error.message : String(error),
      prerequisiteUnavailable: false,
    };
  }
}

export async function readAppliedTipStatus(databasePath: string): Promise<IndexedTipStatus> {
  try {
    const store = await openSqliteStore({ filename: databasePath });

    try {
      const client = await openClient({ store });

      try {
        return {
          appliedTip: await client.getTip(),
          error: null,
          schemaMismatch: false,
        };
      } finally {
        await client.close();
      }
    } finally {
      await store.close().catch(() => undefined);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      appliedTip: null,
      error: message,
      schemaMismatch: message === "sqlite_store_schema_version_unsupported",
    };
  }
}

export function observeIndexerAppliedTip(
  state: IndexerDaemonRuntimeState,
  appliedTip: ClientTip | null,
  nowUnixMs: number,
): void {
  state.appliedTipHeight = appliedTip?.height ?? null;
  state.appliedTipHash = appliedTip?.blockHashHex ?? null;
  const snapshotKey = createIndexerSnapshotKey(appliedTip);

  if (state.lastSnapshotKey !== snapshotKey) {
    state.snapshotSeqCounter += 1;
    state.snapshotSeq = String(state.snapshotSeqCounter);
    state.lastSnapshotKey = snapshotKey;
    state.lastAppliedAtUnixMs = nowUnixMs;
  }
}

export function deriveIndexerDaemonLeaseState(options: {
  coreStatus: CoreTipStatus;
  appliedTip: ClientTip | null;
  hasSuccessfulCoreTipRefresh: boolean;
}): IndexerDaemonLeaseStateResult {
  if (options.coreStatus.error !== null) {
    return {
      state: options.coreStatus.prerequisiteUnavailable && !options.hasSuccessfulCoreTipRefresh ? "starting" : "failed",
      lastError: options.coreStatus.error,
      hasSuccessfulCoreTipRefresh: options.hasSuccessfulCoreTipRefresh,
    };
  }

  const nextHasSuccessfulCoreTipRefresh = true;

  if (
    options.coreStatus.coreBestHeight !== null
    && options.appliedTip?.height !== undefined
    && options.coreStatus.coreBestHash !== null
    && options.appliedTip?.blockHashHex !== undefined
  ) {
    return {
      state: options.coreStatus.coreBestHeight === options.appliedTip.height
        && options.coreStatus.coreBestHash === options.appliedTip.blockHashHex
        ? "synced"
        : "catching-up",
      lastError: null,
      hasSuccessfulCoreTipRefresh: nextHasSuccessfulCoreTipRefresh,
    };
  }

  return {
    state: "starting",
    lastError: null,
    hasSuccessfulCoreTipRefresh: nextHasSuccessfulCoreTipRefresh,
  };
}

export function buildIndexerDaemonStatus(state: IndexerDaemonRuntimeState): ManagedIndexerDaemonStatus {
  return {
    serviceApiVersion: "cogcoin/indexer-ipc/v1",
    binaryVersion: state.binaryVersion,
    buildId: null,
    updatedAtUnixMs: state.updatedAtUnixMs,
    walletRootId: state.walletRootId,
    daemonInstanceId: state.daemonInstanceId,
    schemaVersion: "cogcoin/indexer-db/v1",
    state: state.state,
    processId: process.pid ?? null,
    startedAtUnixMs: state.startedAtUnixMs,
    heartbeatAtUnixMs: state.heartbeatAtUnixMs,
    ipcReady: true,
    rpcReachable: state.rpcReachable,
    coreBestHeight: state.coreBestHeight,
    coreBestHash: state.coreBestHash,
    appliedTipHeight: state.appliedTipHeight,
    appliedTipHash: state.appliedTipHash,
    snapshotSeq: state.snapshotSeq,
    backlogBlocks:
      state.coreBestHeight === null || state.appliedTipHeight === null
        ? null
        : Math.max(state.coreBestHeight - state.appliedTipHeight, 0),
    reorgDepth: null,
    lastAppliedAtUnixMs: state.lastAppliedAtUnixMs,
    activeSnapshotCount: state.snapshots.size,
    lastError: state.lastError,
    backgroundFollowActive: state.backgroundFollowActive,
    bootstrapPhase: state.bootstrapPhase,
    bootstrapProgress: { ...state.bootstrapProgress },
    cogcoinSyncHeight: state.cogcoinSyncHeight,
    cogcoinSyncTargetHeight: state.cogcoinSyncTargetHeight,
  };
}

export async function writeIndexerDaemonStatus(
  paths: ReturnType<typeof resolveManagedServicePaths>,
  state: IndexerDaemonRuntimeState,
): Promise<ManagedIndexerDaemonStatus> {
  const status = buildIndexerDaemonStatus(state);
  await writeRuntimeStatusFile(paths.indexerDaemonStatusPath, status);
  return status;
}

export async function refreshIndexerDaemonStatus(options: {
  databasePath: string;
  paths: ReturnType<typeof resolveManagedServicePaths>;
  state: IndexerDaemonRuntimeState;
}): Promise<ManagedIndexerDaemonStatus> {
  const now = Date.now();
  options.state.heartbeatAtUnixMs = now;
  options.state.updatedAtUnixMs = now;

  const [coreStatus, indexedStatus] = await Promise.all([
    readCoreTipStatus(options.paths),
    readAppliedTipStatus(options.databasePath),
  ]);
  const backgroundStatus = await options.state.backgroundClient?.getNodeStatus().catch(() => null) ?? null;
  if (backgroundStatus?.following === true) {
    options.state.backgroundFollowError = null;
  }
  options.state.rpcReachable = coreStatus.rpcReachable;
  options.state.coreBestHeight = coreStatus.coreBestHeight;
  options.state.coreBestHash = coreStatus.coreBestHash;
  observeIndexerAppliedTip(options.state, indexedStatus.appliedTip, now);
  options.state.backgroundFollowActive = backgroundStatus?.following ?? (options.state.backgroundClient !== null);
  options.state.bootstrapPhase = backgroundStatus?.bootstrapPhase ?? (options.state.backgroundFollowActive ? "follow_tip" : "paused");
  options.state.bootstrapProgress = backgroundStatus?.bootstrapProgress ?? createBootstrapProgress(
    options.state.bootstrapPhase,
    DEFAULT_SNAPSHOT_METADATA,
  );
  options.state.cogcoinSyncHeight = backgroundStatus?.cogcoinSyncHeight ?? indexedStatus.appliedTip?.height ?? null;
  options.state.cogcoinSyncTargetHeight = backgroundStatus?.cogcoinSyncTargetHeight ?? coreStatus.coreBestHeight;

  if (backgroundStatus === null && options.state.backgroundFollowError !== null) {
    options.state.state = "failed";
    options.state.lastError = options.state.backgroundFollowError;
    options.state.backgroundFollowActive = false;
    options.state.bootstrapPhase = "error";
    options.state.bootstrapProgress = {
      ...createBootstrapProgress("error", DEFAULT_SNAPSHOT_METADATA),
      blocks: coreStatus.coreBestHeight,
      headers: coreStatus.coreBestHeight,
      targetHeight: coreStatus.coreBestHeight,
      message: options.state.backgroundFollowError,
      lastError: options.state.backgroundFollowError,
      updatedAt: now,
    };
    options.state.cogcoinSyncHeight = indexedStatus.appliedTip?.height ?? null;
    options.state.cogcoinSyncTargetHeight = coreStatus.coreBestHeight;
    return writeIndexerDaemonStatus(options.paths, options.state);
  }

  if (indexedStatus.schemaMismatch) {
    options.state.state = "schema-mismatch";
    options.state.lastError = indexedStatus.error;
    options.state.bootstrapPhase = "error";
    options.state.bootstrapProgress = {
      ...options.state.bootstrapProgress,
      phase: "error",
      message: indexedStatus.error ?? "Indexer schema mismatch.",
      lastError: indexedStatus.error,
      updatedAt: now,
    };
    return writeIndexerDaemonStatus(options.paths, options.state);
  }

  if (indexedStatus.error !== null) {
    options.state.state = "failed";
    options.state.lastError = indexedStatus.error;
    options.state.bootstrapPhase = "error";
    options.state.bootstrapProgress = {
      ...options.state.bootstrapProgress,
      phase: "error",
      message: indexedStatus.error,
      lastError: indexedStatus.error,
      updatedAt: now,
    };
    return writeIndexerDaemonStatus(options.paths, options.state);
  }

  const leaseState = deriveIndexerDaemonLeaseState({
    coreStatus,
    appliedTip: indexedStatus.appliedTip,
    hasSuccessfulCoreTipRefresh: options.state.hasSuccessfulCoreTipRefresh,
  });
  options.state.hasSuccessfulCoreTipRefresh = leaseState.hasSuccessfulCoreTipRefresh;
  options.state.state = leaseState.state;
  options.state.lastError = leaseState.lastError;
  if (options.state.lastError !== null) {
    options.state.bootstrapPhase = leaseState.state === "starting" ? "paused" : "error";
    options.state.bootstrapProgress = {
      ...options.state.bootstrapProgress,
      phase: options.state.bootstrapPhase,
      message: options.state.lastError,
      lastError: options.state.lastError,
      updatedAt: now,
    };
  } else if (backgroundStatus === null) {
    options.state.bootstrapPhase = leaseState.state === "synced" ? "follow_tip" : "paused";
    options.state.bootstrapProgress = {
      ...createBootstrapProgress(options.state.bootstrapPhase, DEFAULT_SNAPSHOT_METADATA),
      blocks: coreStatus.coreBestHeight,
      headers: coreStatus.coreBestHeight,
      targetHeight: coreStatus.coreBestHeight,
      updatedAt: now,
    };
    options.state.cogcoinSyncHeight = indexedStatus.appliedTip?.height ?? null;
    options.state.cogcoinSyncTargetHeight = coreStatus.coreBestHeight;
  }

  return writeIndexerDaemonStatus(options.paths, options.state);
}
