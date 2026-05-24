import { INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED } from "../../bitcoind/indexer-daemon.js";
import type { ManagedIndexerDaemonObservedStatus } from "../../bitcoind/types.js";
import type { WalletRuntimePaths } from "../runtime.js";
import { createMiningEventRecord } from "./events.js";
import {
  appendMiningEvent,
  loadMiningRuntimeStatus,
  saveMiningRuntimeStatus,
} from "./runtime-artifacts.js";
import type { MiningEventRecord, MiningRuntimeStatusV1 } from "./types.js";

export const MINING_INDEXER_ALIGNMENT_NOTE =
  "Mining is waiting for Bitcoin Core and the indexer to align.";
export const INDEXER_BACKGROUND_FOLLOW_RECOVERY_FAILURE_NOTE =
  "Managed indexer background follow could not recover; mining stopped before writing a fresh cycle snapshot. Run `cogcoin repair` if this persists, then retry.";

function createTakeoverStoppedMiningNote(livePublishInMempool: boolean | null | undefined): string {
  return livePublishInMempool
    ? "Mining runtime replaced. The last mining transaction may still confirm from mempool."
    : "Mining runtime replaced.";
}

function resolveMiningRuntimeRunId(snapshot: MiningRuntimeStatusV1): string | null {
  return snapshot.foregroundRunId ?? snapshot.backgroundWorkerRunId;
}

function createStoppedMiningRuntimeSnapshot(options: {
  snapshot: MiningRuntimeStatusV1 | null;
  walletRootId: string | null;
  nowUnixMs: number;
  note: string | null;
}): MiningRuntimeStatusV1 {
  if (options.snapshot !== null) {
    return {
      ...options.snapshot,
      updatedAtUnixMs: options.nowUnixMs,
      runMode: "stopped",
      foregroundPid: null,
      foregroundRunId: null,
      foregroundHeartbeatAtUnixMs: null,
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      backgroundWorkerHeartbeatAtUnixMs: null,
      backgroundWorkerHealth: null,
      currentPhase: "idle",
      readinessBlocker: null,
      note: options.note,
    };
  }

  return {
    schemaVersion: 1,
    walletRootId: options.walletRootId,
    workerApiVersion: null,
    workerBinaryVersion: null,
    workerBuildId: null,
    updatedAtUnixMs: options.nowUnixMs,
    runMode: "stopped",
    foregroundPid: null,
    foregroundRunId: null,
    foregroundHeartbeatAtUnixMs: null,
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    backgroundWorkerHeartbeatAtUnixMs: null,
    backgroundWorkerHealth: null,
    indexerDaemonState: null,
    indexerDaemonInstanceId: null,
    indexerSnapshotSeq: null,
    indexerSnapshotOpenedAtUnixMs: null,
    indexerTruthSource: undefined,
    indexerHeartbeatAtUnixMs: null,
    coreBestHeight: null,
    coreBestHash: null,
    indexerTipHeight: null,
    indexerTipHash: null,
    indexerStatusTipHeight: null,
    indexerStatusTipHash: null,
    indexerObservedAtUnixMs: null,
    indexerReorgDepth: null,
    indexerTipAligned: null,
    corePublishState: null,
    providerState: null,
    cycleStartedAtUnixMs: null,
    phaseEnteredAtUnixMs: null,
    lastSuspendDetectedAtUnixMs: null,
    reconnectSettledUntilUnixMs: null,
    tipSettledUntilUnixMs: null,
    miningState: "idle",
    currentPhase: "idle",
    currentPublishState: "none",
    targetBlockHeight: null,
    referencedBlockHashDisplay: null,
    attemptTargetBlockHeight: null,
    attemptReferencedBlockHashDisplay: null,
    attemptIndexerSnapshotSeq: null,
    currentDomainId: null,
    currentDomainName: null,
    currentSentenceDisplay: null,
    currentCanonicalBlend: null,
    currentTxid: null,
    currentWtxid: null,
    livePublishInMempool: null,
    livePublishTargetBlockHeight: null,
    livePublishReferencedBlockHashDisplay: null,
    livePublishTxid: null,
    livePublishDecision: null,
    livePublishStaleToCoreTip: null,
    currentFeeRateSatVb: null,
    currentAbsoluteFeeSats: null,
    currentBlockFeeSpentSats: "0",
    sessionFeeSpentSats: "0",
    lifetimeFeeSpentSats: "0",
    sameDomainCompetitorSuppressed: null,
    higherRankedCompetitorDomainCount: null,
    dedupedCompetitorDomainCount: null,
    competitivenessGateIndeterminate: null,
    competitivenessGateReason: null,
    competitivenessGateDiagnostics: null,
    mempoolSequenceCacheStatus: null,
    currentPublishDecision: null,
    lastMempoolSequence: null,
    lastCompetitivenessGateAtUnixMs: null,
    pauseReason: null,
    providerConfigured: false,
    providerKind: null,
    bitcoindHealth: "unavailable",
    bitcoindServiceState: null,
    bitcoindReplicaStatus: null,
    nodeHealth: "unavailable",
    indexerHealth: "unavailable",
    tipsAligned: null,
    readinessBlocker: null,
    lastEventAtUnixMs: null,
    lastError: null,
    note: options.note,
  };
}

export function createStoppedMiningRuntimeSnapshotForTakeover(options: {
  snapshot: MiningRuntimeStatusV1 | null;
  walletRootId: string | null;
  nowUnixMs: number;
}): MiningRuntimeStatusV1 {
  return createStoppedMiningRuntimeSnapshot({
    ...options,
    note: createTakeoverStoppedMiningNote(options.snapshot?.livePublishInMempool),
  });
}

export function isIndexerBackgroundFollowRecoveryFailure(error: unknown): error is Error {
  return error instanceof Error
    && error.message === INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED;
}

export function createIndexerFailureMiningRuntimeSnapshot(options: {
  snapshot: MiningRuntimeStatusV1 | null;
  walletRootId: string | null;
  nowUnixMs: number;
  errorMessage: string;
  note: string;
}): MiningRuntimeStatusV1 {
  return {
    ...createStoppedMiningRuntimeSnapshot({
      snapshot: options.snapshot,
      walletRootId: options.walletRootId,
      nowUnixMs: options.nowUnixMs,
      note: options.note,
    }),
    updatedAtUnixMs: options.nowUnixMs,
    runMode: "stopped",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    backgroundWorkerHeartbeatAtUnixMs: null,
    backgroundWorkerHealth: null,
    foregroundPid: null,
    foregroundRunId: null,
    foregroundHeartbeatAtUnixMs: null,
    indexerDaemonState: "failed",
    indexerHealth: "failed",
    currentPhase: "waiting-indexer",
    readinessBlocker: "indexer-daemon",
    lastEventAtUnixMs: options.nowUnixMs,
    lastError: options.errorMessage,
    note: options.note,
  };
}

export function createIndexerRecoveryFailureMiningRuntimeSnapshot(options: {
  snapshot: MiningRuntimeStatusV1 | null;
  walletRootId: string | null;
  nowUnixMs: number;
}): MiningRuntimeStatusV1 {
  return createIndexerFailureMiningRuntimeSnapshot({
    ...options,
    errorMessage: INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED,
    note: INDEXER_BACKGROUND_FOLLOW_RECOVERY_FAILURE_NOTE,
  });
}

function mapManagedIndexerStateToMiningState(
  state: ManagedIndexerDaemonObservedStatus["state"] | null | undefined,
): MiningRuntimeStatusV1["indexerDaemonState"] {
  switch (state) {
    case "starting":
    case "catching-up":
    case "reorging":
    case "synced":
    case "failed":
    case "schema-mismatch":
    case "service-version-mismatch":
      return state;
    case "stopping":
      return "starting";
    default:
      return "unavailable";
  }
}

function mapManagedIndexerHealth(
  state: ManagedIndexerDaemonObservedStatus["state"] | null | undefined,
): MiningRuntimeStatusV1["indexerHealth"] {
  switch (state) {
    case "synced":
      return "synced";
    case "catching-up":
      return "catching-up";
    case "reorging":
      return "reorging";
    case "starting":
    case "stopping":
      return "starting";
    case "failed":
      return "failed";
    case "schema-mismatch":
      return "schema-mismatch";
    case "service-version-mismatch":
      return "service-version-mismatch";
    default:
      return "unavailable";
  }
}

function isObservedIndexerTipAligned(status: ManagedIndexerDaemonObservedStatus | null): boolean | null {
  if (status === null) {
    return null;
  }

  return status.coreBestHeight !== null
    && status.appliedTipHeight !== null
    && status.appliedTipHeight === status.coreBestHeight
    && (
      status.coreBestHash === null
      || status.appliedTipHash === null
      || status.appliedTipHash === status.coreBestHash
    );
}

function isObservedIndexerReady(status: ManagedIndexerDaemonObservedStatus | null): boolean {
  return status?.state === "synced"
    && isObservedIndexerTipAligned(status) === true;
}

export function createMiningReadinessSnapshot(options: {
  walletRootId: string | null;
  observedStatus: ManagedIndexerDaemonObservedStatus | null;
  existingSnapshot?: MiningRuntimeStatusV1 | null;
  nowUnixMs: number;
}): MiningRuntimeStatusV1 {
  const status = options.observedStatus;
  const bitcoindReachable = status?.rpcReachable === true;
  const indexerTipAligned = isObservedIndexerTipAligned(status);
  const base = createStoppedMiningRuntimeSnapshot({
    snapshot: options.existingSnapshot ?? null,
    walletRootId: options.walletRootId,
    nowUnixMs: options.nowUnixMs,
    note: null,
  });
  const waitingForIndexer = !isObservedIndexerReady(status);
  const targetBlockHeight = status?.coreBestHeight === null || status?.coreBestHeight === undefined
    ? null
    : status.coreBestHeight + 1;
  const referencedBlockHashDisplay = status?.coreBestHash ?? null;
  const readinessBlocker: MiningRuntimeStatusV1["readinessBlocker"] = status === null
    ? "indexer-daemon"
    : status.state !== "synced"
      ? "indexer-daemon"
      : indexerTipAligned !== true
        ? "tip-alignment"
        : null;

  return {
    ...base,
    walletRootId: options.walletRootId,
    updatedAtUnixMs: options.nowUnixMs,
    runMode: "foreground",
    foregroundPid: null,
    foregroundRunId: null,
    foregroundHeartbeatAtUnixMs: null,
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    backgroundWorkerHeartbeatAtUnixMs: null,
    backgroundWorkerHealth: null,
    indexerDaemonState: mapManagedIndexerStateToMiningState(status?.state),
    indexerDaemonInstanceId: status?.daemonInstanceId ?? null,
    indexerSnapshotSeq: status?.snapshotSeq ?? null,
    indexerSnapshotOpenedAtUnixMs: null,
    indexerTruthSource: "probe",
    indexerHeartbeatAtUnixMs: status?.heartbeatAtUnixMs ?? null,
    coreBestHeight: status?.coreBestHeight ?? null,
    coreBestHash: status?.coreBestHash ?? null,
    indexerTipHeight: null,
    indexerTipHash: null,
    indexerStatusTipHeight: status?.appliedTipHeight ?? null,
    indexerStatusTipHash: status?.appliedTipHash ?? null,
    indexerObservedAtUnixMs: status?.updatedAtUnixMs ?? status?.heartbeatAtUnixMs ?? null,
    indexerReorgDepth: status?.reorgDepth ?? null,
    indexerTipAligned,
    corePublishState: bitcoindReachable ? "healthy" : null,
    currentPhase: waitingForIndexer ? "waiting-indexer" : "waiting",
    targetBlockHeight,
    referencedBlockHashDisplay,
    attemptTargetBlockHeight: targetBlockHeight,
    attemptReferencedBlockHashDisplay: referencedBlockHashDisplay,
    attemptIndexerSnapshotSeq: status?.snapshotSeq ?? null,
    providerConfigured: true,
    bitcoindHealth: bitcoindReachable ? "ready" : status === null ? "starting" : "unavailable",
    bitcoindServiceState: bitcoindReachable ? "ready" : status === null ? "starting" : null,
    bitcoindReplicaStatus: options.existingSnapshot?.bitcoindReplicaStatus ?? "not-proven",
    nodeHealth: bitcoindReachable ? "synced" : status === null ? "starting" : "unavailable",
    indexerHealth: mapManagedIndexerHealth(status?.state),
    tipsAligned: indexerTipAligned,
    readinessBlocker,
    lastError: status?.lastError ?? null,
    note: status === null
      ? "Mining is waiting for managed indexer readiness."
      : waitingForIndexer
        ? readinessBlocker === "tip-alignment"
          ? MINING_INDEXER_ALIGNMENT_NOTE
          : "Mining is waiting for managed indexer readiness."
        : "Mining preflight completed; starting foreground mining.",
  };
}

export async function recordMiningReadinessSnapshot(options: {
  paths: WalletRuntimePaths;
  walletRootId: string | null;
  observedStatus: ManagedIndexerDaemonObservedStatus | null;
  nowUnixMs: number;
}): Promise<MiningRuntimeStatusV1> {
  const snapshot = await loadMiningRuntimeStatus(options.paths.miningStatusPath).catch(() => null);
  const nextSnapshot = createMiningReadinessSnapshot({
    walletRootId: options.walletRootId,
    observedStatus: options.observedStatus,
    existingSnapshot: snapshot,
    nowUnixMs: options.nowUnixMs,
  });
  await saveMiningRuntimeStatus(options.paths.miningStatusPath, nextSnapshot);
  return nextSnapshot;
}

function createRuntimeErrorEventOptions(
  snapshot: MiningRuntimeStatusV1,
  nowUnixMs: number,
  errorMessage: string,
): Partial<MiningEventRecord> {
  return {
    level: "error",
    timestampUnixMs: nowUnixMs,
    targetBlockHeight: snapshot.targetBlockHeight,
    referencedBlockHashDisplay: snapshot.referencedBlockHashDisplay,
    domainId: snapshot.currentDomainId,
    domainName: snapshot.currentDomainName,
    txid: snapshot.currentTxid,
    feeRateSatVb: snapshot.currentFeeRateSatVb,
    feeSats: snapshot.currentAbsoluteFeeSats === null
      ? null
      : String(snapshot.currentAbsoluteFeeSats),
    score: snapshot.currentCanonicalBlend,
    reason: errorMessage,
    runId: resolveMiningRuntimeRunId(snapshot),
  };
}

export async function recordMiningIndexerRuntimeError(options: {
  paths: WalletRuntimePaths;
  walletRootId?: string | null;
  nowUnixMs: number;
  errorMessage: string;
  eventMessage: string;
  note?: string;
}): Promise<MiningRuntimeStatusV1> {
  const snapshot = await loadMiningRuntimeStatus(options.paths.miningStatusPath).catch(() => null);
  const walletRootId = options.walletRootId ?? snapshot?.walletRootId ?? null;
  const nextSnapshot = options.errorMessage === INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED
    ? createIndexerRecoveryFailureMiningRuntimeSnapshot({
      snapshot,
      walletRootId,
      nowUnixMs: options.nowUnixMs,
    })
    : createIndexerFailureMiningRuntimeSnapshot({
      snapshot,
      walletRootId,
      nowUnixMs: options.nowUnixMs,
      errorMessage: options.errorMessage,
      note: options.note ?? `Managed indexer preflight failed: ${options.errorMessage}`,
    });
  await saveMiningRuntimeStatus(options.paths.miningStatusPath, nextSnapshot);
  await appendMiningEvent(
    options.paths.miningEventsPath,
    createMiningEventRecord(
      "runtime-error",
      options.eventMessage,
      createRuntimeErrorEventOptions(nextSnapshot, options.nowUnixMs, options.errorMessage),
    ),
  );
  return nextSnapshot;
}
