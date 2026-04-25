import type { openSqliteStore } from "../../sqlite/index.js";
import type { ClientTip } from "../../types.js";
import type {
  BootstrapPhase,
  BootstrapProgress,
  ManagedBitcoindClient,
  ManagedBitcoindObservedStatus,
  ManagedIndexerDaemonObservedStatus,
  ManagedIndexerDaemonState,
  ManagedIndexerDaemonStatus,
  ManagedIndexerSnapshotIdentity,
} from "../types.js";

export interface DaemonRequest {
  id: string;
  method:
    | "GetStatus"
    | "OpenSnapshot"
    | "ReadSnapshot"
    | "CloseSnapshot"
    | "ResumeBackgroundFollow";
  token?: string;
}

export interface DaemonResponse {
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

export interface IndexerDaemonStopResult {
  status: "stopped" | "not-running";
  walletRootId: string;
}

export interface CoherentIndexerSnapshotLease {
  payload: IndexerSnapshotPayload;
  status: ManagedIndexerDaemonStatus;
}

export type ManagedIndexerDaemonServiceLifetime = "persistent" | "ephemeral";
export type ManagedIndexerDaemonOwnership = "attached" | "started";

export interface LoadedSnapshotMaterial {
  token: string;
  stateBase64: string;
  tip: ClientTip | null;
  expiresAtUnixMs: number;
}

export interface LoadedSnapshot extends LoadedSnapshotMaterial, ManagedIndexerSnapshotIdentity {}

export interface CoreTipStatus {
  rpcReachable: boolean;
  coreBestHeight: number | null;
  coreBestHash: string | null;
  error: string | null;
  prerequisiteUnavailable: boolean;
}

export interface IndexedTipStatus {
  appliedTip: ClientTip | null;
  error: string | null;
  schemaMismatch: boolean;
}

export interface IndexerDaemonLeaseStateResult {
  state: ManagedIndexerDaemonState;
  lastError: string | null;
  hasSuccessfulCoreTipRefresh: boolean;
}

export interface IndexerDaemonRuntimeState {
  readonly daemonInstanceId: string;
  readonly binaryVersion: string;
  readonly startedAtUnixMs: number;
  readonly walletRootId: string;
  readonly snapshots: Map<string, LoadedSnapshot>;
  state: ManagedIndexerDaemonState;
  heartbeatAtUnixMs: number;
  updatedAtUnixMs: number;
  rpcReachable: boolean;
  coreBestHeight: number | null;
  coreBestHash: string | null;
  appliedTipHeight: number | null;
  appliedTipHash: string | null;
  snapshotSeqCounter: number;
  snapshotSeq: string | null;
  lastSnapshotKey: string | undefined;
  lastAppliedAtUnixMs: number | null;
  lastError: string | null;
  hasSuccessfulCoreTipRefresh: boolean;
  backgroundStore: Awaited<ReturnType<typeof openSqliteStore>> | null;
  backgroundClient: ManagedBitcoindClient | null;
  backgroundResumePromise: Promise<void> | null;
  backgroundFollowError: string | null;
  backgroundFollowActive: boolean;
  bootstrapPhase: BootstrapPhase;
  bootstrapProgress: BootstrapProgress;
  cogcoinSyncHeight: number | null;
  cogcoinSyncTargetHeight: number | null;
}
