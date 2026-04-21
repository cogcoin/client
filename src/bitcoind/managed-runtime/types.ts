import type { ClientTip } from "../../types.js";
import type {
  ManagedBitcoindObservedStatus,
  ManagedIndexerDaemonObservedStatus,
  ManagedIndexerTruthSource,
} from "../types.js";

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
