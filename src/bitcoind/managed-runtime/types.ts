import type { ClientTip } from "../../types.js";
import type { ManagedServicePaths } from "../service-paths.js";
import type {
  ManagedBitcoindObservedStatus,
  ManagedIndexerDaemonObservedStatus,
  ManagedIndexerTruthSource,
} from "../types.js";
import type {
  WalletBitcoindStatus,
  WalletIndexerStatus,
  WalletNodeStatus,
  WalletServiceHealth,
  WalletSnapshotView,
} from "../../wallet/read/types.js";

export type ManagedBitcoindServiceCompatibility =
  | "compatible"
  | "service-version-mismatch"
  | "wallet-root-mismatch"
  | "runtime-mismatch"
  | "unreachable"
  | "protocol-error";

export interface ManagedBitcoindServiceProbeResult {
  compatibility: ManagedBitcoindServiceCompatibility;
  status: ManagedBitcoindObservedStatus | null;
  error: string | null;
}

export interface ManagedBitcoindStatusCandidate {
  status: ManagedBitcoindObservedStatus;
  statusPath: string;
}

export type IndexerDaemonCompatibility =
  | "compatible"
  | "service-version-mismatch"
  | "wallet-root-mismatch"
  | "schema-mismatch"
  | "unreachable"
  | "protocol-error";

export interface ManagedIndexerDaemonProbeResult<TClient> {
  compatibility: IndexerDaemonCompatibility;
  status: ManagedIndexerDaemonObservedStatus | null;
  client: TClient | null;
  error: string | null;
}

export interface ManagedBitcoindProbeDecision {
  action: "attach" | "start" | "reject";
  error: string | null;
}

export interface IndexerDaemonProbeDecision {
  action: "attach" | "replace" | "start" | "reject";
  error: string | null;
}

export interface ManagedRuntimeLockLike {
  release(): Promise<void>;
}

export type ManagedBitcoindRuntimePathsLike = ManagedServicePaths;

export type ManagedIndexerRuntimePathsLike = ManagedServicePaths;

export interface ManagedBitcoindRuntimeOptionsLike {
  dataDir: string;
  walletRootId: string;
  startupTimeoutMs: number;
}

export interface ManagedIndexerRuntimeOptionsLike {
  dataDir: string;
  walletRootId: string;
  startupTimeoutMs: number;
  shutdownTimeoutMs?: number;
  expectedBinaryVersion?: string | null;
}

export interface ManagedIndexerSnapshotLike {
  tip: ClientTip | null;
  daemonInstanceId?: string | null;
  snapshotSeq?: string | null;
  openedAtUnixMs?: number | null;
}

export interface ManagedIndexerStatusProjection {
  status: ManagedIndexerDaemonObservedStatus | null;
  source: ManagedIndexerTruthSource;
  snapshotTip: ClientTip | null;
  daemonInstanceId: string | null;
  snapshotSeq: string | null;
  openedAtUnixMs: number | null;
}

export interface ManagedWalletNodeConnection<TNodeHandle, TRpc> {
  handle: TNodeHandle | null;
  rpc: TRpc | null;
  status: WalletNodeStatus | null;
  observedStatus: ManagedBitcoindObservedStatus | null;
  error: string | null;
}

export interface ManagedWalletReadServiceBundle<TNodeHandle, TRpc, TDaemonClient> {
  node: ManagedWalletNodeConnection<TNodeHandle, TRpc>;
  bitcoind: WalletBitcoindStatus;
  nodeHealth: WalletServiceHealth;
  nodeMessage: string | null;
  daemonClient: TDaemonClient | null;
  indexer: WalletIndexerStatus;
  snapshot: WalletSnapshotView | null;
  close(): Promise<void>;
}
