import type { ManagedBitcoindHealth, ManagedIndexerTruthSource } from "../../bitcoind/types.js";

export type MiningServiceHealth =
  | "synced"
  | "catching-up"
  | "reorging"
  | "starting"
  | "stale-heartbeat"
  | "failed"
  | "schema-mismatch"
  | "service-version-mismatch"
  | "wallet-root-mismatch"
  | "unavailable";

export type MiningProviderKind = "openai" | "anthropic";

export type MiningModelSelectionSource = "catalog" | "custom" | "legacy-default" | "legacy-custom";

export interface MiningProviderConfigRecord {
  provider: MiningProviderKind;
  apiKey: string;
  extraPrompt: string | null;
  modelOverride: string | null;
  modelSelectionSource: MiningModelSelectionSource;
  updatedAtUnixMs: number;
}

export interface ClientConfigV1 {
  schemaVersion: 1;
  mining: {
    builtIn: MiningProviderConfigRecord | null;
  };
}

export interface MiningEventRecord {
  schemaVersion: 1;
  timestampUnixMs: number;
  level: "info" | "warn" | "error";
  kind: string;
  message: string;
  targetBlockHeight?: number | null;
  referencedBlockHashDisplay?: string | null;
  domainId?: number | null;
  domainName?: string | null;
  txid?: string | null;
  feeRateSatVb?: number | null;
  feeSats?: string | null;
  score?: string | null;
  reason?: string | null;
  runId?: string | null;
}

export interface MiningRuntimeStatusV1 {
  schemaVersion: 1;
  walletRootId: string | null;
  workerApiVersion: "cogcoin/mining-worker/v1" | null;
  workerBinaryVersion: string | null;
  workerBuildId: string | null;
  updatedAtUnixMs: number;
  runMode: "stopped" | "foreground" | "background";
  backgroundWorkerPid: number | null;
  backgroundWorkerRunId: string | null;
  backgroundWorkerHeartbeatAtUnixMs: number | null;
  backgroundWorkerHealth: "healthy" | "stale-pid" | "stale-heartbeat" | "version-mismatch" | null;
  indexerDaemonState:
    | "unavailable"
    | "starting"
    | "catching-up"
    | "reorging"
    | "synced"
    | "stale-heartbeat"
    | "failed"
    | "schema-mismatch"
    | "service-version-mismatch"
    | "wallet-root-mismatch"
    | null;
  indexerDaemonInstanceId: string | null;
  indexerSnapshotSeq?: string | null;
  indexerSnapshotOpenedAtUnixMs?: number | null;
  indexerTruthSource?: ManagedIndexerTruthSource;
  indexerHeartbeatAtUnixMs: number | null;
  coreBestHeight: number | null;
  coreBestHash: string | null;
  indexerTipHeight: number | null;
  indexerTipHash: string | null;
  indexerReorgDepth: number | null;
  indexerTipAligned: boolean | null;
  corePublishState:
    | "unknown"
    | "network-inactive"
    | "no-outbound-peers"
    | "ibd"
    | "mempool-loading"
    | "healthy"
    | null;
  providerState: "ready" | "backoff" | "unavailable" | "rate-limited" | "auth-error" | "not-found" | null;
  lastSuspendDetectedAtUnixMs: number | null;
  reconnectSettledUntilUnixMs: number | null;
  tipSettledUntilUnixMs: number | null;
  miningState:
    | "idle"
    | "live"
    | "paused"
    | "paused-stale"
    | "repair-required";
  currentPhase:
    | "idle"
    | "generating"
    | "scoring"
    | "publishing"
    | "replacing"
    | "waiting"
    | "waiting-provider"
    | "waiting-bitcoin-network"
    | "waiting-indexer"
    | "resuming";
  currentPublishState:
    | "none"
    | "broadcasting"
    | "broadcast-unknown"
    | "in-mempool";
  targetBlockHeight: number | null;
  referencedBlockHashDisplay: string | null;
  currentDomainId: number | null;
  currentDomainName: string | null;
  currentSentenceDisplay: string | null;
  currentCanonicalBlend: string | null;
  currentTxid: string | null;
  currentWtxid: string | null;
  livePublishInMempool: boolean | null;
  currentFeeRateSatVb: number | null;
  currentAbsoluteFeeSats: number | null;
  currentBlockFeeSpentSats: string;
  sessionFeeSpentSats: string;
  lifetimeFeeSpentSats: string;
  sameDomainCompetitorSuppressed: boolean | null;
  higherRankedCompetitorDomainCount: number | null;
  dedupedCompetitorDomainCount: number | null;
  competitivenessGateIndeterminate: boolean | null;
  mempoolSequenceCacheStatus: "reused" | "refreshed" | null;
  currentPublishDecision: string | null;
  lastMempoolSequence: string | null;
  lastCompetitivenessGateAtUnixMs: number | null;
  pauseReason: string | null;
  providerConfigured: boolean;
  providerKind: MiningProviderKind | null;
  bitcoindHealth: ManagedBitcoindHealth;
  bitcoindServiceState: "starting" | "ready" | "stopping" | "failed" | null;
  bitcoindReplicaStatus: "not-proven" | "ready" | "missing" | "mismatch" | null;
  nodeHealth: MiningServiceHealth;
  indexerHealth: MiningServiceHealth;
  tipsAligned: boolean | null;
  lastEventAtUnixMs: number | null;
  lastError: string | null;
  note: string | null;
}

export interface MiningProviderInspection {
  configured: boolean;
  provider: MiningProviderKind | null;
  status: "ready" | "missing" | "error";
  message: string | null;
  modelId: string | null;
  effectiveModel: string | null;
  modelOverride: string | null;
  modelSelectionSource: MiningModelSelectionSource | null;
  usingDefaultModel: boolean | null;
  extraPromptConfigured: boolean;
  estimatedDailyCostUsd: number | null;
  estimatedDailyCostDisplay: string | null;
}

export interface MiningControlPlaneView {
  runtime: MiningRuntimeStatusV1;
  provider: MiningProviderInspection;
  lastEventAtUnixMs: number | null;
}
