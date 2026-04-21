import { readFile } from "node:fs/promises";

import type { IndexerSnapshotHandle } from "../indexer-daemon.js";
import {
  INDEXER_DAEMON_SCHEMA_VERSION,
  INDEXER_DAEMON_SERVICE_API_VERSION,
  type ManagedIndexerDaemonObservedStatus,
  type ManagedIndexerDaemonStatus,
  type ManagedIndexerTruthSource,
} from "../types.js";
import type { ManagedIndexerSnapshotLike, ManagedIndexerStatusProjection } from "./types.js";

export async function readJsonFileIfPresent<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export function buildManagedIndexerStatusFromSnapshotHandle(
  handle: IndexerSnapshotHandle,
): ManagedIndexerDaemonStatus {
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
    backgroundFollowActive: handle.backgroundFollowActive,
    bootstrapPhase: handle.bootstrapPhase,
    bootstrapProgress: handle.bootstrapProgress,
    cogcoinSyncHeight: handle.cogcoinSyncHeight,
    cogcoinSyncTargetHeight: handle.cogcoinSyncTargetHeight,
  };
}

export function resolveManagedIndexerStatusProjection(options: {
  daemonStatus: ManagedIndexerDaemonStatus | null;
  observedStatus?: ManagedIndexerDaemonObservedStatus | null;
  snapshot: ManagedIndexerSnapshotLike | null;
  source: ManagedIndexerTruthSource;
}): ManagedIndexerStatusProjection {
  const status = options.source === "lease"
    ? options.daemonStatus
    : options.observedStatus ?? options.daemonStatus;
  const source = status === null && options.snapshot === null ? "none" : options.source;

  return {
    status,
    source,
    snapshotTip: options.snapshot?.tip ?? null,
    daemonInstanceId: options.snapshot?.daemonInstanceId ?? status?.daemonInstanceId ?? null,
    snapshotSeq: options.snapshot?.snapshotSeq ?? status?.snapshotSeq ?? null,
    openedAtUnixMs: options.snapshot?.openedAtUnixMs ?? null,
  };
}
