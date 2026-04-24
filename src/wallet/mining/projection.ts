import type {
  WalletBitcoindStatus,
  WalletIndexerStatus,
  WalletLocalStateStatus,
  WalletNodeStatus,
} from "../read/types.js";
import type { WalletStateV1 } from "../types.js";
import type { MiningCandidate } from "./engine-types.js";
import { livePublishTargetsCandidateTip } from "./engine-state.js";
import { normalizeMiningPublishState, normalizeMiningStateRecord } from "./state.js";
import {
  MINING_WORKER_API_VERSION,
  MINING_WORKER_HEARTBEAT_STALE_MS,
} from "./constants.js";
import type { MiningProviderInspection, MiningRuntimeStatusV1 } from "./types.js";

export interface MiningRuntimeStatusOverrides {
  runMode?: MiningRuntimeStatusV1["runMode"];
  backgroundWorkerPid?: number | null;
  backgroundWorkerRunId?: string | null;
  backgroundWorkerHeartbeatAtUnixMs?: number | null;
  currentPhase?: MiningRuntimeStatusV1["currentPhase"];
  currentPublishState?: MiningRuntimeStatusV1["currentPublishState"];
  targetBlockHeight?: number | null;
  referencedBlockHashDisplay?: string | null;
  currentDomainId?: number | null;
  currentDomainName?: string | null;
  currentSentenceDisplay?: string | null;
  currentCanonicalBlend?: string | null;
  currentTxid?: string | null;
  currentWtxid?: string | null;
  currentFeeRateSatVb?: number | null;
  currentAbsoluteFeeSats?: number | null;
  currentBlockFeeSpentSats?: string;
  lastSuspendDetectedAtUnixMs?: number | null;
  reconnectSettledUntilUnixMs?: number | null;
  tipSettledUntilUnixMs?: number | null;
  providerState?: MiningRuntimeStatusV1["providerState"];
  corePublishState?: MiningRuntimeStatusV1["corePublishState"];
  currentPublishDecision?: string | null;
  sameDomainCompetitorSuppressed?: boolean | null;
  higherRankedCompetitorDomainCount?: number | null;
  dedupedCompetitorDomainCount?: number | null;
  competitivenessGateIndeterminate?: boolean | null;
  mempoolSequenceCacheStatus?: MiningRuntimeStatusV1["mempoolSequenceCacheStatus"];
  lastMempoolSequence?: string | null;
  lastCompetitivenessGateAtUnixMs?: number | null;
  lastError?: string | null;
  note?: string | null;
  livePublishInMempool?: boolean | null;
}

export function resolveWaitingProviderNote(
  providerState: MiningRuntimeStatusV1["providerState"] | null,
): string {
  switch (providerState) {
    case "backoff":
      return "Mining is waiting because the sentence provider had a transient failure and will be retried automatically.";
    case "rate-limited":
      return "Mining is waiting because the sentence provider is rate limited and will be retried automatically.";
    case "auth-error":
      return "Mining is waiting because the sentence provider rejected the configured API key.";
    case "not-found":
      return "Mining is waiting because the configured sentence-provider model was not found.";
    default:
      return "Mining is waiting for the sentence provider to recover.";
  }
}

export function buildPrePublishStatusOverrides(options: {
  state: WalletStateV1;
  candidate: MiningCandidate;
}): MiningRuntimeStatusOverrides {
  const replacing = options.state.miningState.currentTxid !== null;
  const replacingAcrossTips = replacing && !livePublishTargetsCandidateTip({
    liveState: options.state.miningState,
    candidate: options.candidate,
  });

  return {
    currentPhase: replacing ? "replacing" : "publishing",
    currentPublishDecision: replacing ? "replacing" : "publishing",
    targetBlockHeight: options.candidate.targetBlockHeight,
    referencedBlockHashDisplay: options.candidate.referencedBlockHashDisplay,
    currentDomainId: options.candidate.domainId,
    currentDomainName: options.candidate.domainName,
    currentSentenceDisplay: options.candidate.sentence,
    currentCanonicalBlend: options.candidate.canonicalBlend.toString(),
    note: replacing
      ? "Replacing the live mining transaction for the current tip."
      : "Broadcasting the best mining candidate for the current tip.",
    ...(replacingAcrossTips
      ? {
        currentPublishState: "none" as const,
        currentTxid: null,
        currentWtxid: null,
        livePublishInMempool: false,
        currentFeeRateSatVb: null,
        currentAbsoluteFeeSats: null,
        currentBlockFeeSpentSats: "0",
      }
      : {}),
  };
}

function resolveSnapshotOverride<T>(override: T | undefined, fallback: T): T {
  return override === undefined ? fallback : override;
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

function mapProviderState(
  provider: MiningProviderInspection,
  localState: WalletLocalStateStatus,
  existingRuntime: MiningRuntimeStatusV1 | null,
): MiningRuntimeStatusV1["providerState"] {
  const miningState = localState.state?.miningState === undefined
    ? null
    : normalizeMiningStateRecord(localState.state.miningState);

  if (
    existingRuntime?.currentPhase === "waiting-provider"
    && existingRuntime.providerState !== null
    && (miningState === null || miningState.state === "idle")
  ) {
    return existingRuntime.providerState;
  }

  if (miningState?.state === "paused" && miningState.pauseReason?.includes("rate-limit")) {
    return "rate-limited";
  }

  if (miningState?.state === "paused" && miningState.pauseReason?.includes("auth")) {
    return "auth-error";
  }

  if (miningState?.state === "paused" && miningState.pauseReason?.includes("provider")) {
    return "backoff";
  }

  if (provider.status === "ready") {
    return "ready";
  }

  return "unavailable";
}

function shouldReuseExistingProviderWait(options: {
  existingRuntime: MiningRuntimeStatusV1 | null;
  miningState: ReturnType<typeof normalizeMiningStateRecord> | null;
}): boolean {
  return options.existingRuntime?.currentPhase === "waiting-provider"
    && options.existingRuntime.providerState !== null
    && (options.miningState === null || options.miningState.state === "idle");
}

function mapIndexerDaemonState(indexer: WalletIndexerStatus): MiningRuntimeStatusV1["indexerDaemonState"] {
  if (indexer.health === "wallet-root-mismatch") {
    return "wallet-root-mismatch";
  }

  if (indexer.health === "service-version-mismatch") {
    return "service-version-mismatch";
  }

  if (indexer.health === "schema-mismatch") {
    return "schema-mismatch";
  }

  if (indexer.status !== null) {
    switch (indexer.status.state) {
      case "synced":
        return indexer.health === "stale-heartbeat" ? "stale-heartbeat" : "synced";
      case "catching-up":
        return indexer.health === "stale-heartbeat" ? "stale-heartbeat" : "catching-up";
      case "reorging":
        return indexer.health === "stale-heartbeat" ? "stale-heartbeat" : "reorging";
      case "starting":
      case "stopping":
        return indexer.health === "stale-heartbeat" ? "stale-heartbeat" : "starting";
      case "failed":
        return "failed";
      case "schema-mismatch":
        return "schema-mismatch";
      case "service-version-mismatch":
        return "service-version-mismatch";
      default:
        break;
    }
  }

  switch (indexer.health) {
    case "failed":
      return "failed";
    case "starting":
      return "starting";
    case "catching-up":
      return "catching-up";
    case "reorging":
      return "reorging";
    case "stale-heartbeat":
      return "stale-heartbeat";
    case "synced":
      return "synced";
    default:
      return "unavailable";
  }
}

function mapCorePublishState(
  nodeHealth: MiningRuntimeStatusV1["nodeHealth"],
  nodeStatus: WalletNodeStatus | null,
): MiningRuntimeStatusV1["corePublishState"] {
  if (nodeStatus === null || !nodeStatus.ready) {
    return "unknown";
  }

  if (nodeHealth === "catching-up") {
    return "ibd";
  }

  return "healthy";
}

async function deriveBackgroundWorkerHealth(options: {
  runtime: MiningRuntimeStatusV1 | null;
  localState: WalletLocalStateStatus;
  nowUnixMs: number;
}): Promise<MiningRuntimeStatusV1["backgroundWorkerHealth"]> {
  const runtime = options.runtime;

  if (runtime?.runMode !== "background") {
    return null;
  }

  if (
    runtime.walletRootId !== null
    && options.localState.walletRootId !== null
    && runtime.walletRootId !== options.localState.walletRootId
  ) {
    return "version-mismatch";
  }

  if (runtime.workerApiVersion !== null && runtime.workerApiVersion !== MINING_WORKER_API_VERSION) {
    return "version-mismatch";
  }

  if (!await isProcessAlive(runtime.backgroundWorkerPid)) {
    return "stale-pid";
  }

  if (
    runtime.backgroundWorkerHeartbeatAtUnixMs === null
    || (options.nowUnixMs - runtime.backgroundWorkerHeartbeatAtUnixMs) > MINING_WORKER_HEARTBEAT_STALE_MS
  ) {
    return "stale-heartbeat";
  }

  return "healthy";
}

export async function buildMiningRuntimeStatusSnapshot(options: {
  nowUnixMs: number;
  localState: WalletLocalStateStatus;
  bitcoind: WalletBitcoindStatus;
  nodeStatus: WalletNodeStatus | null;
  provider: MiningProviderInspection;
  nodeHealth: MiningRuntimeStatusV1["nodeHealth"];
  indexer: WalletIndexerStatus;
  tipsAligned: boolean | null;
  lastEventAtUnixMs: number | null;
  existingRuntime: MiningRuntimeStatusV1 | null;
}): Promise<MiningRuntimeStatusV1> {
  const state = options.localState.state?.miningState === undefined
    ? null
    : normalizeMiningStateRecord(options.localState.state.miningState);
  const backgroundWorkerHealth = await deriveBackgroundWorkerHealth({
    runtime: options.existingRuntime,
    localState: options.localState,
    nowUnixMs: options.nowUnixMs,
  });
  const providerState = mapProviderState(options.provider, options.localState, options.existingRuntime);
  const indexerDaemonState = mapIndexerDaemonState(options.indexer);
  const corePublishState = mapCorePublishState(options.nodeHealth, options.nodeStatus);
  const existing = options.existingRuntime;
  const reuseExistingProviderWait = shouldReuseExistingProviderWait({
    existingRuntime: existing,
    miningState: state,
  });

  void options.bitcoind;

  return {
    schemaVersion: 1,
    walletRootId: options.localState.walletRootId,
    workerApiVersion: existing?.workerApiVersion ?? null,
    workerBinaryVersion: existing?.workerBinaryVersion ?? null,
    workerBuildId: existing?.workerBuildId ?? null,
    updatedAtUnixMs: options.nowUnixMs,
    runMode: state?.runMode ?? existing?.runMode ?? "stopped",
    backgroundWorkerPid: existing?.backgroundWorkerPid ?? null,
    backgroundWorkerRunId: existing?.backgroundWorkerRunId ?? null,
    backgroundWorkerHeartbeatAtUnixMs: existing?.backgroundWorkerHeartbeatAtUnixMs ?? null,
    backgroundWorkerHealth,
    indexerDaemonState,
    indexerDaemonInstanceId: options.indexer.daemonInstanceId ?? null,
    indexerSnapshotSeq: options.indexer.snapshotSeq ?? null,
    indexerSnapshotOpenedAtUnixMs: options.indexer.openedAtUnixMs ?? null,
    indexerTruthSource: options.indexer.source ?? "none",
    indexerHeartbeatAtUnixMs: options.indexer.status?.heartbeatAtUnixMs ?? null,
    coreBestHeight: options.nodeStatus?.nodeBestHeight ?? options.indexer.status?.coreBestHeight ?? existing?.coreBestHeight ?? null,
    coreBestHash: options.nodeStatus?.nodeBestHashHex ?? options.indexer.status?.coreBestHash ?? existing?.coreBestHash ?? null,
    indexerTipHeight: options.indexer.snapshotTip?.height ?? options.indexer.status?.appliedTipHeight ?? null,
    indexerTipHash: options.indexer.snapshotTip?.blockHashHex ?? options.indexer.status?.appliedTipHash ?? null,
    indexerReorgDepth: options.indexer.status?.reorgDepth ?? null,
    indexerTipAligned: options.tipsAligned,
    corePublishState,
    providerState,
    lastSuspendDetectedAtUnixMs: existing?.lastSuspendDetectedAtUnixMs ?? null,
    reconnectSettledUntilUnixMs: existing?.reconnectSettledUntilUnixMs ?? null,
    tipSettledUntilUnixMs: existing?.tipSettledUntilUnixMs ?? null,
    miningState: state?.state ?? existing?.miningState ?? "idle",
    currentPhase: existing?.currentPhase ?? "idle",
    currentPublishState: normalizeMiningPublishState(
      state?.currentPublishState ?? options.existingRuntime?.currentPublishState ?? "none",
    ),
    targetBlockHeight: state?.currentBlockTargetHeight ?? existing?.targetBlockHeight ?? null,
    referencedBlockHashDisplay: state?.currentReferencedBlockHashDisplay ?? existing?.referencedBlockHashDisplay ?? null,
    currentDomainId: state?.currentDomainId ?? existing?.currentDomainId ?? null,
    currentDomainName: state?.currentDomain ?? existing?.currentDomainName ?? null,
    currentSentenceDisplay: state?.currentSentence ?? existing?.currentSentenceDisplay ?? null,
    currentCanonicalBlend: state?.currentScore ?? existing?.currentCanonicalBlend ?? null,
    currentTxid: state?.currentTxid ?? existing?.currentTxid ?? null,
    currentWtxid: state?.currentWtxid ?? existing?.currentWtxid ?? null,
    livePublishInMempool: state?.livePublishInMempool ?? existing?.livePublishInMempool ?? null,
    currentFeeRateSatVb: state?.currentFeeRateSatVb ?? existing?.currentFeeRateSatVb ?? null,
    currentAbsoluteFeeSats: state?.currentAbsoluteFeeSats ?? existing?.currentAbsoluteFeeSats ?? null,
    currentBlockFeeSpentSats: state?.currentBlockFeeSpentSats ?? existing?.currentBlockFeeSpentSats ?? "0",
    sessionFeeSpentSats: state?.sessionFeeSpentSats ?? existing?.sessionFeeSpentSats ?? "0",
    lifetimeFeeSpentSats: state?.lifetimeFeeSpentSats ?? existing?.lifetimeFeeSpentSats ?? "0",
    sameDomainCompetitorSuppressed: existing?.sameDomainCompetitorSuppressed ?? null,
    higherRankedCompetitorDomainCount: existing?.higherRankedCompetitorDomainCount ?? null,
    dedupedCompetitorDomainCount: existing?.dedupedCompetitorDomainCount ?? null,
    competitivenessGateIndeterminate: existing?.competitivenessGateIndeterminate ?? null,
    mempoolSequenceCacheStatus: existing?.mempoolSequenceCacheStatus ?? null,
    currentPublishDecision: state?.currentPublishDecision ?? existing?.currentPublishDecision ?? null,
    lastMempoolSequence: existing?.lastMempoolSequence ?? null,
    lastCompetitivenessGateAtUnixMs: existing?.lastCompetitivenessGateAtUnixMs ?? null,
    pauseReason: state?.pauseReason ?? options.existingRuntime?.pauseReason ?? null,
    providerConfigured: options.provider.configured,
    providerKind: options.provider.provider,
    bitcoindHealth: options.bitcoind.health,
    bitcoindServiceState: options.nodeStatus?.serviceStatus?.state ?? null,
    bitcoindReplicaStatus: options.nodeStatus?.walletReplica?.proofStatus ?? null,
    nodeHealth: options.nodeHealth,
    indexerHealth: options.indexer.health,
    tipsAligned: options.tipsAligned,
    lastEventAtUnixMs: options.lastEventAtUnixMs,
    lastError: reuseExistingProviderWait
      ? existing?.lastError ?? null
      : existing?.currentPhase === "waiting-bitcoin-network" || existing?.currentPhase === "waiting-indexer"
        ? existing?.lastError ?? options.provider.message ?? options.indexer.message ?? null
        : options.provider.message ?? options.indexer.message ?? null,
    note: state?.pauseReason === "zero-reward"
      ? "Mining is disabled because the target block reward is zero."
      : existing?.currentPhase === "resuming"
        ? "Mining discarded stale in-flight work after a large local runtime gap and is rechecking health."
        : reuseExistingProviderWait
          ? resolveWaitingProviderNote(existing?.providerState ?? providerState)
          : existing?.currentPhase === "waiting-indexer"
            ? "Mining is waiting for Bitcoin Core and the indexer to align."
            : existing?.currentPhase === "waiting-bitcoin-network"
              ? "Mining is waiting for the local Bitcoin node to become publishable."
              : state?.state === "repair-required"
                ? "Mining is blocked until the current mining publish is reconciled or `cogcoin repair` completes."
                : state?.state === "paused-stale" && state.livePublishInMempool
                  ? "A previously broadcast mining transaction is still in mempool for an older tip context. Wait for confirmation or rerun mining to replace it."
                  : state?.state === "paused" && state.livePublishInMempool
                    ? "Mining is paused, but the last mining transaction may still confirm from mempool without further fee bumps."
                    : state?.state === "paused"
                      ? "Mining is paused by another wallet command or local policy."
                      : options.provider.status === "missing"
                        ? "Run `cogcoin mine setup` to configure the built-in mining provider."
                        : options.indexer.health === "reorging"
                          ? "Mining remains stopped while the indexer replays a reorg and refreshes the coherent snapshot."
                          : options.indexer.health !== "synced" || options.nodeHealth !== "synced"
                            ? "Mining remains stopped until Bitcoin Core and the indexer are both healthy and aligned."
                            : null,
  };
}

export function applyMiningRuntimeStatusOverrides(options: {
  runtime: MiningRuntimeStatusV1;
  provider: MiningProviderInspection;
  overrides?: MiningRuntimeStatusOverrides;
  nowUnixMs?: number;
}): MiningRuntimeStatusV1 {
  const overrides = options.overrides ?? {};
  const resolvedCurrentPhase = resolveSnapshotOverride(overrides.currentPhase, options.runtime.currentPhase);
  const clearProviderWaitCarryover = overrides.currentPhase !== undefined
    && overrides.currentPhase !== "waiting-provider"
    && options.runtime.currentPhase === "waiting-provider";

  return {
    ...options.runtime,
    runMode: resolveSnapshotOverride(overrides.runMode, options.runtime.runMode),
    backgroundWorkerPid: resolveSnapshotOverride(overrides.backgroundWorkerPid, options.runtime.backgroundWorkerPid),
    backgroundWorkerRunId: resolveSnapshotOverride(overrides.backgroundWorkerRunId, options.runtime.backgroundWorkerRunId),
    backgroundWorkerHeartbeatAtUnixMs: resolveSnapshotOverride(
      overrides.backgroundWorkerHeartbeatAtUnixMs,
      options.runtime.backgroundWorkerHeartbeatAtUnixMs,
    ),
    currentPhase: resolvedCurrentPhase,
    currentPublishState: resolveSnapshotOverride(overrides.currentPublishState, options.runtime.currentPublishState),
    targetBlockHeight: resolveSnapshotOverride(overrides.targetBlockHeight, options.runtime.targetBlockHeight),
    referencedBlockHashDisplay: resolveSnapshotOverride(
      overrides.referencedBlockHashDisplay,
      options.runtime.referencedBlockHashDisplay,
    ),
    currentDomainId: resolveSnapshotOverride(overrides.currentDomainId, options.runtime.currentDomainId),
    currentDomainName: resolveSnapshotOverride(overrides.currentDomainName, options.runtime.currentDomainName),
    currentSentenceDisplay: resolveSnapshotOverride(
      overrides.currentSentenceDisplay,
      options.runtime.currentSentenceDisplay,
    ),
    currentCanonicalBlend: resolveSnapshotOverride(
      overrides.currentCanonicalBlend,
      options.runtime.currentCanonicalBlend,
    ),
    currentTxid: resolveSnapshotOverride(overrides.currentTxid, options.runtime.currentTxid),
    currentWtxid: resolveSnapshotOverride(overrides.currentWtxid, options.runtime.currentWtxid),
    currentFeeRateSatVb: resolveSnapshotOverride(overrides.currentFeeRateSatVb, options.runtime.currentFeeRateSatVb),
    currentAbsoluteFeeSats: resolveSnapshotOverride(
      overrides.currentAbsoluteFeeSats,
      options.runtime.currentAbsoluteFeeSats,
    ),
    currentBlockFeeSpentSats: resolveSnapshotOverride(
      overrides.currentBlockFeeSpentSats,
      options.runtime.currentBlockFeeSpentSats,
    ),
    lastSuspendDetectedAtUnixMs: resolveSnapshotOverride(
      overrides.lastSuspendDetectedAtUnixMs,
      options.runtime.lastSuspendDetectedAtUnixMs,
    ),
    reconnectSettledUntilUnixMs: resolveSnapshotOverride(
      overrides.reconnectSettledUntilUnixMs,
      options.runtime.reconnectSettledUntilUnixMs,
    ),
    tipSettledUntilUnixMs: resolveSnapshotOverride(
      overrides.tipSettledUntilUnixMs,
      options.runtime.tipSettledUntilUnixMs,
    ),
    providerState: resolveSnapshotOverride(
      overrides.providerState,
      clearProviderWaitCarryover
        ? (options.provider.status === "ready" ? "ready" : "unavailable")
        : options.runtime.providerState,
    ),
    corePublishState: resolveSnapshotOverride(overrides.corePublishState, options.runtime.corePublishState),
    currentPublishDecision: resolveSnapshotOverride(
      overrides.currentPublishDecision,
      options.runtime.currentPublishDecision,
    ),
    sameDomainCompetitorSuppressed: resolveSnapshotOverride(
      overrides.sameDomainCompetitorSuppressed,
      options.runtime.sameDomainCompetitorSuppressed,
    ),
    higherRankedCompetitorDomainCount: resolveSnapshotOverride(
      overrides.higherRankedCompetitorDomainCount,
      options.runtime.higherRankedCompetitorDomainCount,
    ),
    dedupedCompetitorDomainCount: resolveSnapshotOverride(
      overrides.dedupedCompetitorDomainCount,
      options.runtime.dedupedCompetitorDomainCount,
    ),
    competitivenessGateIndeterminate: resolveSnapshotOverride(
      overrides.competitivenessGateIndeterminate,
      options.runtime.competitivenessGateIndeterminate,
    ),
    mempoolSequenceCacheStatus: resolveSnapshotOverride(
      overrides.mempoolSequenceCacheStatus,
      options.runtime.mempoolSequenceCacheStatus,
    ),
    lastMempoolSequence: resolveSnapshotOverride(overrides.lastMempoolSequence, options.runtime.lastMempoolSequence),
    lastCompetitivenessGateAtUnixMs: resolveSnapshotOverride(
      overrides.lastCompetitivenessGateAtUnixMs,
      options.runtime.lastCompetitivenessGateAtUnixMs,
    ),
    lastError: resolveSnapshotOverride(
      overrides.lastError,
      clearProviderWaitCarryover ? null : options.runtime.lastError,
    ),
    note: resolveSnapshotOverride(
      overrides.note,
      clearProviderWaitCarryover ? null : options.runtime.note,
    ),
    livePublishInMempool: resolveSnapshotOverride(
      overrides.livePublishInMempool,
      options.runtime.livePublishInMempool,
    ),
    updatedAtUnixMs: options.nowUnixMs ?? Date.now(),
  };
}
