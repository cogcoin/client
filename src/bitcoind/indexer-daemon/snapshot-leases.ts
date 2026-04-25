import { randomUUID } from "node:crypto";

import { serializeIndexerState } from "@cogcoin/indexer";

import { openClient } from "../../client.js";
import { openSqliteStore } from "../../sqlite/index.js";
import type { ManagedIndexerDaemonStatus } from "../types.js";
import type {
  IndexerDaemonRuntimeState,
  IndexerSnapshotHandle,
  IndexerSnapshotPayload,
  LoadedSnapshot,
  LoadedSnapshotMaterial,
} from "./types.js";

export async function loadSnapshotMaterial(
  databasePath: string,
  snapshotTtlMs: number,
): Promise<LoadedSnapshotMaterial> {
  const store = await openSqliteStore({ filename: databasePath });

  try {
    const client = await openClient({ store });

    try {
      const [tip, state] = await Promise.all([client.getTip(), client.getState()]);
      return {
        token: randomUUID(),
        stateBase64: Buffer.from(serializeIndexerState(state)).toString("base64"),
        tip,
        expiresAtUnixMs: Date.now() + snapshotTtlMs,
      };
    } finally {
      await client.close();
    }
  } finally {
    await store.close().catch(() => undefined);
  }
}

export function storeSnapshotLease(options: {
  state: IndexerDaemonRuntimeState;
  material: LoadedSnapshotMaterial;
  nowUnixMs: number;
}): LoadedSnapshot {
  const snapshot: LoadedSnapshot = {
    ...options.material,
    serviceApiVersion: "cogcoin/indexer-ipc/v1",
    schemaVersion: "cogcoin/indexer-db/v1",
    walletRootId: options.state.walletRootId,
    daemonInstanceId: options.state.daemonInstanceId,
    processId: process.pid ?? null,
    startedAtUnixMs: options.state.startedAtUnixMs,
    snapshotSeq: options.state.snapshotSeq,
    tipHeight: options.material.tip?.height ?? null,
    tipHash: options.material.tip?.blockHashHex ?? null,
    openedAtUnixMs: options.nowUnixMs,
  };
  options.state.snapshots.set(snapshot.token, snapshot);
  return snapshot;
}

export function createSnapshotHandle(options: {
  snapshot: LoadedSnapshot;
  status: ManagedIndexerDaemonStatus;
  binaryVersion: string;
}): IndexerSnapshotHandle {
  return {
    token: options.snapshot.token,
    expiresAtUnixMs: options.snapshot.expiresAtUnixMs,
    serviceApiVersion: options.snapshot.serviceApiVersion,
    binaryVersion: options.binaryVersion,
    buildId: null,
    walletRootId: options.snapshot.walletRootId,
    daemonInstanceId: options.snapshot.daemonInstanceId,
    schemaVersion: options.snapshot.schemaVersion,
    processId: options.snapshot.processId,
    startedAtUnixMs: options.snapshot.startedAtUnixMs,
    state: options.status.state,
    heartbeatAtUnixMs: options.status.heartbeatAtUnixMs,
    rpcReachable: options.status.rpcReachable,
    coreBestHeight: options.status.coreBestHeight,
    coreBestHash: options.status.coreBestHash,
    appliedTipHeight: options.status.appliedTipHeight,
    appliedTipHash: options.status.appliedTipHash,
    snapshotSeq: options.snapshot.snapshotSeq,
    backlogBlocks: options.status.backlogBlocks,
    reorgDepth: options.status.reorgDepth,
    lastAppliedAtUnixMs: options.status.lastAppliedAtUnixMs,
    activeSnapshotCount: options.status.activeSnapshotCount,
    lastError: options.status.lastError,
    backgroundFollowActive: options.status.backgroundFollowActive ?? false,
    bootstrapPhase: options.status.bootstrapPhase ?? null,
    bootstrapProgress: options.status.bootstrapProgress ?? null,
    cogcoinSyncHeight: options.status.cogcoinSyncHeight ?? null,
    cogcoinSyncTargetHeight: options.status.cogcoinSyncTargetHeight ?? null,
    tipHeight: options.snapshot.tipHeight,
    tipHash: options.snapshot.tipHash,
    openedAtUnixMs: options.snapshot.openedAtUnixMs,
  };
}

export function readSnapshotLease(options: {
  state: IndexerDaemonRuntimeState;
  token?: string;
}): {
  changed: boolean;
  payload: IndexerSnapshotPayload | null;
  error: string | null;
} {
  const snapshot = options.token ? options.state.snapshots.get(options.token) : null;

  if (!snapshot || snapshot.expiresAtUnixMs <= Date.now()) {
    if (options.token) {
      options.state.snapshots.delete(options.token);
      return {
        changed: true,
        payload: null,
        error: "indexer_daemon_snapshot_invalid",
      };
    }

    return {
      changed: false,
      payload: null,
      error: "indexer_daemon_snapshot_invalid",
    };
  }

  if (snapshot.snapshotSeq !== options.state.snapshotSeq) {
    options.state.snapshots.delete(snapshot.token);
    return {
      changed: true,
      payload: null,
      error: "indexer_daemon_snapshot_rotated",
    };
  }

  return {
    changed: false,
    payload: {
      token: snapshot.token,
      stateBase64: snapshot.stateBase64,
      serviceApiVersion: snapshot.serviceApiVersion,
      schemaVersion: snapshot.schemaVersion,
      walletRootId: snapshot.walletRootId,
      daemonInstanceId: snapshot.daemonInstanceId,
      processId: snapshot.processId,
      startedAtUnixMs: snapshot.startedAtUnixMs,
      snapshotSeq: snapshot.snapshotSeq,
      tipHeight: snapshot.tipHeight,
      tipHash: snapshot.tipHash,
      openedAtUnixMs: snapshot.openedAtUnixMs,
      tip: snapshot.tip,
      expiresAtUnixMs: snapshot.expiresAtUnixMs,
    },
    error: null,
  };
}

export function closeSnapshotLease(
  state: IndexerDaemonRuntimeState,
  token?: string,
): boolean {
  if (!token) {
    return false;
  }

  return state.snapshots.delete(token);
}

export function pruneExpiredSnapshotLeases(
  state: IndexerDaemonRuntimeState,
  nowUnixMs: number,
): boolean {
  let changed = false;

  for (const [token, snapshot] of state.snapshots.entries()) {
    if (snapshot.expiresAtUnixMs <= nowUnixMs) {
      state.snapshots.delete(token);
      changed = true;
    }
  }

  return changed;
}
