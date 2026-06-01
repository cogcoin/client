import { createHash } from "node:crypto";

import {
  getBalance,
  getBlockWinners,
  lookupDomain,
  lookupDomainById,
} from "@cogcoin/indexer/queries";
import {
  assaySentences,
  deriveBlendSeed,
  displayToInternalBlockhash,
  getWords,
  settleBlock,
} from "@cogcoin/scoring";

import { probeIndexerDaemon, readObservedIndexerDaemonStatus } from "../../bitcoind/indexer-daemon.js";
import { readManagedBitcoindObservedStatus } from "../../bitcoind/managed-runtime/bitcoind-status.js";
import { isRetryableManagedRpcError } from "../../bitcoind/retryable-rpc.js";
import { FOLLOW_VISIBLE_PRIOR_BLOCKS } from "../../bitcoind/client/follow-block-times.js";
import {
  attachOrStartManagedBitcoindService,
  probeManagedBitcoindService,
  stopManagedBitcoindService,
} from "../../bitcoind/service.js";
import { createRpcClient } from "../../bitcoind/node.js";
import type { ManagedBitcoindObservedStatus, ManagedIndexerDaemonObservedStatus, ProgressOutputMode } from "../../bitcoind/types.js";
import { COG_OPCODES, COG_PREFIX } from "../cogop/constants.js";
import { extractOpReturnPayloadFromScriptHex } from "../tx/register.js";
import {
  assertFixedInputPrefixMatches,
  buildWalletMutationTransaction,
  fundAndValidateWalletMutationDraft,
  isInsufficientFundsError,
  outpointKey as walletMutationOutpointKey,
  isAlreadyAcceptedError,
  isBroadcastUnknownError,
  reconcilePersistentPolicyLocks,
  resolveWalletMutationFeeSelection,
  saveWalletStatePreservingUnlock,
  type FixedWalletInput,
  type MutationSender,
  type WalletMutationRpcClient,
} from "../tx/common.js";
import type { WalletPrompter } from "../lifecycle.js";
import {
  openWalletReadContext,
  type WalletReadContext,
} from "../read/index.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../runtime.js";
import {
  createDefaultWalletSecretProvider,
  unlockClientPassword,
  withInteractiveWalletSecretProvider,
  type WalletSecretProvider,
} from "../state/provider.js";
import { bindClientPasswordPromptSessionPolicy } from "../state/client-password/session-policy.js";
import type {
  MiningStateRecord,
  OutpointRecord,
  WalletStateV1,
} from "../types.js";
import { serializeMine } from "../cogop/index.js";
import {
  appendMiningEvent,
  loadMiningRuntimeStatus,
  saveForegroundMiningHeartbeatStatus,
  type MiningRuntimeTipStatusRefresh,
} from "./runtime-artifacts.js";
import { loadClientConfig } from "./config.js";
import {
  MINING_LOOP_INTERVAL_MS,
  MINING_STATUS_HEARTBEAT_INTERVAL_MS,
  MINING_SUSPEND_GAP_THRESHOLD_MS,
} from "./constants.js";
import { setupBuiltInMining } from "./control.js";
import {
  applyMiningRuntimeStatusOverrides,
  buildPrePublishStatusOverrides,
  type MiningRuntimeStatusOverrides,
} from "./projection.js";
import {
  buildMiningGenerationRequest as buildMiningGenerationRequestModule,
  chooseBestLocalCandidate as chooseBestLocalCandidateModule,
  determineCorePublishState as determineCorePublishStateModule,
  ensureIndexerTruthIsCurrent as ensureIndexerTruthIsCurrentModule,
  generateCandidatesForDomains as generateCandidatesForDomainsModule,
  getIndexerTruthKey as getIndexerTruthKeyModule,
  refreshMiningCandidateFromCurrentState as refreshMiningCandidateFromCurrentStateModule,
  resolveEligibleAnchoredRoots as resolveEligibleAnchoredRootsModule,
} from "./candidate.js";
import {
  clearMiningGateCache as clearMiningGateCacheModule,
  runCompetitivenessGate as runCompetitivenessGateModule,
} from "./competitiveness.js";
import { createMiningEventRecord } from "./events.js";
import {
  buildMiningSettleWindowStatusOverrides,
  clearMiningProviderWait,
  createMiningRuntimeLoopState,
  defaultMiningStatePatch,
  discardMiningLoopTransientWork,
  hasBlockingMutation,
  setMiningTipSettleWindow,
  type MiningRuntimeLoopState,
} from "./engine-state.js";
import {
  createInsufficientFundsMiningPublishErrorMessage as createInsufficientFundsMiningPublishErrorMessageModule,
  createInsufficientFundsMiningPublishWaitingNote as createInsufficientFundsMiningPublishWaitingNoteModule,
  createMiningPlan as createMiningPlanModule,
  publishCandidate as publishCandidateModule,
  probeMiningFundingAvailability as probeMiningFundingAvailabilityModule,
  publishCandidateOnce as publishCandidateOnceModule,
  reconcileLiveMiningState as reconcileLiveMiningStateModule,
  resolveMiningConflictOutpoint as resolveMiningConflictOutpointModule,
  validateMiningDraft as validateMiningDraftModule,
} from "./publish.js";
import { runMiningPhaseMachine } from "./cycle.js";
import {
  attemptSaveMempool,
  handleDetectedMiningRuntimeResume,
  handleRecoverableMiningBitcoindFailure,
  isRecoverableMiningBitcoindError,
  refreshAndSaveMiningRuntimeStatus,
  resetMiningBitcoindRecoveryState,
  saveStopSnapshot,
} from "./lifecycle.js";
import {
  compareLexicographically,
  deriveMiningWordIndices,
  getBlockRewardCogtoshi,
  numberToSats,
  resolveBip39WordsFromIndices,
  rootDomain,
  tieBreakHash,
} from "./engine-utils.js";
import type {
  CompetitivenessDecision,
  MiningCandidate,
  MiningCooperativeYield,
  MiningPublishOutcome,
  MiningRpcClient,
} from "./engine-types.js";
import {
  observedIndexerStatusMatchesCoreTip,
  resolveReadContextCoreTip,
  resolveMiningReadiness,
  resolveReadyMiningReadContext,
} from "./engine-types.js";
import {
  isMiningGenerationAbortRequested,
  markMiningGenerationActive,
  markMiningGenerationInactive,
  readMiningGenerationActivity,
  readMiningPreemptionRequest,
  requestMiningGenerationPreemption,
} from "./coordination.js";
import {
  clearMiningPublishState,
  miningPublishIsInMempool,
  miningPublishMayStillExist,
  normalizeMiningPublishState,
  normalizeMiningStateRecord,
} from "./state.js";
import {
  runForegroundMining as runForegroundMiningSupervisor,
} from "./supervisor.js";
import {
  isMiningStopRequestedError,
  throwIfMiningStopRequested,
} from "./stop.js";
import { createMiningSentenceRequestLimits } from "./sentence-protocol.js";
import { generateMiningSentences, MiningProviderRequestError, type MiningSentenceGenerationRequest } from "./sentences.js";
import type { MiningControlPlaneView, MiningEventRecord, MiningRuntimeStatusV1 } from "./types.js";
import {
  type MiningFollowVisualizerState,
  type MiningProvisionalSentenceEntry,
  type MiningSentenceBoardEntry,
  type MiningRecentWinSummary,
  MiningFollowVisualizer,
} from "./visualizer.js";
import {
  createIndexedMiningFollowVisualizerState,
  findRecentMiningWin,
  loadMiningVisibleFollowBlockTimes,
  resolveFundingDisplaySats,
  resolveSettledBoard,
  syncMiningUiForCurrentTip,
  syncMiningVisualizerBalances,
  syncMiningVisualizerBlockTimes,
} from "./visualizer-sync.js";
import {
  ensureMiningMempoolRawTxSubscriber,
  pruneMiningMempoolIndexServicesForWallet,
  resolveMiningMempoolIndexCachePath,
  resolveMiningMempoolServiceIdentity,
} from "./mempool-index.js";

const BEST_BLOCK_POLL_INTERVAL_MS = 500;
const MINING_SUSPEND_HEARTBEAT_INTERVAL_MS = 1_000;
const MINING_FOREGROUND_TIP_STATUS_STALE_MS = 15_000;
const MINING_FOREGROUND_CORE_PROBE_TIMEOUT_MS = 3_000;

type MiningRunnerStatusOverrides = MiningRuntimeStatusOverrides;

interface MiningCycleResult {
  restartImmediately: boolean;
  restartNote?: string | null;
}

function continueMiningCycleNormally(): MiningCycleResult {
  return {
    restartImmediately: false,
  };
}

function restartMiningCycleImmediately(note?: string | null): MiningCycleResult {
  return {
    restartImmediately: true,
    restartNote: note,
  };
}

interface RunnerDependencies {
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  fetchImpl?: typeof fetch;
  requestMiningPreemption?: typeof requestMiningGenerationPreemption;
  runMiningLoopImpl?: typeof runMiningLoop;
  saveStopSnapshotImpl?: typeof saveStopSnapshot;
  shutdownGraceMs?: number;
  sleepImpl?: typeof sleep;
}

interface IndexerTruthKey {
  walletRootId: string;
  daemonInstanceId: string;
  snapshotSeq: string;
}

type MiningLoopState = MiningRuntimeLoopState;

interface MiningSuspendDetector {
  lastHeartbeatMonotonicMs: number;
  detectedAtUnixMs: number | null;
  monotonicNow: () => number;
  nowUnixMs: () => number;
  stop(): void;
}

interface MiningSuspendHeartbeatHandle {
  clear(): void;
}

interface MiningSuspendScheduler {
  every(intervalMs: number, callback: () => void): MiningSuspendHeartbeatHandle;
}

class MiningSuspendDetectedError extends Error {
  readonly detectedAtUnixMs: number;

  constructor(detectedAtUnixMs: number) {
    super("mining_runtime_resumed");
    this.detectedAtUnixMs = detectedAtUnixMs;
  }
}

const defaultMiningSuspendScheduler: MiningSuspendScheduler = {
  every(intervalMs: number, callback: () => void): MiningSuspendHeartbeatHandle {
    const timer = setInterval(callback, intervalMs);
    timer.unref?.();
    return {
      clear() {
        clearInterval(timer);
      },
    };
  },
};

const MINING_INDEXER_SNAPSHOT_REACQUIRE_ATTEMPTS = 3;
const MINING_INDEXER_SNAPSHOT_REACQUIRE_DELAY_MS = 50;

function refreshMiningSuspendDetector(detector: MiningSuspendDetector | undefined): void {
  if (detector === undefined) {
    return;
  }

  const monotonicNow = detector.monotonicNow();
  const gapMs = monotonicNow - detector.lastHeartbeatMonotonicMs;
  detector.lastHeartbeatMonotonicMs = monotonicNow;

  if (
    gapMs > MINING_SUSPEND_GAP_THRESHOLD_MS
    && detector.detectedAtUnixMs === null
  ) {
    detector.detectedAtUnixMs = detector.nowUnixMs();
  }
}

function createMiningSuspendDetector(options: {
  monotonicNow?: () => number;
  nowUnixMs?: () => number;
  scheduler?: MiningSuspendScheduler;
} = {}): MiningSuspendDetector {
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const nowUnixMs = options.nowUnixMs ?? Date.now;
  const scheduler = options.scheduler ?? defaultMiningSuspendScheduler;
  let heartbeat: MiningSuspendHeartbeatHandle | null = null;

  const detector: MiningSuspendDetector = {
    lastHeartbeatMonotonicMs: monotonicNow(),
    detectedAtUnixMs: null,
    monotonicNow,
    nowUnixMs,
    stop() {
      heartbeat?.clear();
      heartbeat = null;
    },
  };

  heartbeat = scheduler.every(
    MINING_SUSPEND_HEARTBEAT_INTERVAL_MS,
    () => {
      refreshMiningSuspendDetector(detector);
    },
  );
  return detector;
}

function throwIfMiningSuspendDetected(detector: MiningSuspendDetector | undefined): void {
  if (detector === undefined) {
    return;
  }

  refreshMiningSuspendDetector(detector);
  if (detector.detectedAtUnixMs === null) {
    return;
  }

  const detectedAtUnixMs = detector.detectedAtUnixMs;
  detector.detectedAtUnixMs = null;
  throw new MiningSuspendDetectedError(detectedAtUnixMs);
}

function stopMiningSuspendDetector(detector: MiningSuspendDetector | undefined): void {
  detector?.stop();
}

function clearMiningGateCache(walletRootId: string | null | undefined): void {
  clearMiningGateCacheModule(walletRootId);
}

export interface RunForegroundMiningOptions extends RunnerDependencies {
  dataDir: string;
  databasePath: string;
  clientVersion?: string | null;
  updateAvailable?: boolean;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  builtInSetupEnsured?: boolean;
  stdout?: { write(chunk: string): void };
  stderr?: { isTTY?: boolean; columns?: number; write(chunk: string): boolean | void };
  signal?: AbortSignal;
  progressOutput?: ProgressOutputMode;
  paths?: WalletRuntimePaths;
  visualizer?: MiningFollowVisualizer;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function shouldReacquireIndexerSnapshot(readContext: WalletReadContext): boolean {
  return observedIndexerStatusMatchesCoreTip(readContext)
    && (
      readContext.indexer.source !== "lease"
      || readContext.snapshot === null
      || readContext.model === null
    );
}

async function reacquireIndexerSnapshotReadContext(options: {
  readContext: WalletReadContext;
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  openReadContext: typeof openWalletReadContext;
  signal?: AbortSignal;
  throwIfInterrupted: () => void;
}): Promise<WalletReadContext> {
  let current = options.readContext;

  for (let attempt = 0; attempt < MINING_INDEXER_SNAPSHOT_REACQUIRE_ATTEMPTS; attempt += 1) {
    if (!shouldReacquireIndexerSnapshot(current)) {
      break;
    }

    options.throwIfInterrupted();
    if (attempt > 0) {
      await sleep(MINING_INDEXER_SNAPSHOT_REACQUIRE_DELAY_MS, options.signal);
      options.throwIfInterrupted();
    }

    const next = await options.openReadContext({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      secretProvider: options.provider,
      paths: options.paths,
    });
    await current.close().catch(() => undefined);
    current = next;
  }

  return current;
}

function writeStdout(stream: { write(chunk: string): void } | undefined, line: string): void {
  if (stream === undefined) {
    return;
  }

  stream.write(`${line}\n`);
}

function createEvent(
  kind: string,
  message: string,
  options: Partial<MiningEventRecord> = {},
): MiningEventRecord {
  return createMiningEventRecord(kind, message, options);
}

async function appendRuntimeTimingEvent(
  paths: WalletRuntimePaths,
  kind: string,
  message: string,
  options: Partial<MiningEventRecord>,
): Promise<void> {
  try {
    await appendEvent(paths, createEvent(kind, message, options));
  } catch {
    // Timing telemetry must not alter the mining decision path.
  }
}

async function timeMiningPublishabilityRpc<T>(options: {
  paths: WalletRuntimePaths;
  runId: string | null;
  kind: string;
  message: string;
  method: string;
  operation: () => Promise<T>;
}): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await options.operation();
    await appendRuntimeTimingEvent(options.paths, options.kind, options.message, {
      runId: options.runId,
      durationMs: performance.now() - startedAt,
      metrics: {
        outcome: "success",
        rpcMethod: options.method,
      },
    });
    return result;
  } catch (error) {
    await appendRuntimeTimingEvent(options.paths, options.kind, options.message, {
      level: "warn",
      runId: options.runId,
      durationMs: performance.now() - startedAt,
      metrics: {
        outcome: "error",
        rpcMethod: options.method,
        errorName: error instanceof Error ? error.name : "unknown",
      },
    });
    throw error;
  }
}

function createMiningLoopState(): MiningLoopState {
  return createMiningRuntimeLoopState();
}

function resolveMiningRunId(options: {
  runMode: "foreground" | "background";
  foregroundRunId: string | null;
  backgroundWorkerRunId: string | null;
}): string | null {
  return options.runMode === "foreground"
    ? options.foregroundRunId
    : options.backgroundWorkerRunId;
}

function createForegroundMiningLivenessOverrides(options: {
  runMode: "foreground" | "background";
  foregroundPid: number | null;
  foregroundRunId: string | null;
  nowUnixMs: number;
}): Pick<MiningRuntimeStatusOverrides, "foregroundPid" | "foregroundRunId" | "foregroundHeartbeatAtUnixMs"> {
  if (options.runMode !== "foreground" || options.foregroundRunId === null || options.foregroundPid === null) {
    return {
      foregroundPid: null,
      foregroundRunId: null,
      foregroundHeartbeatAtUnixMs: null,
    };
  }

  return {
    foregroundPid: options.foregroundPid,
    foregroundRunId: options.foregroundRunId,
    foregroundHeartbeatAtUnixMs: options.nowUnixMs,
  };
}

function mapIndexerDaemonStatusStateForMining(
  state: ManagedIndexerDaemonObservedStatus["state"] | undefined,
): MiningRuntimeStatusV1["indexerDaemonState"] {
  switch (state) {
    case "synced":
    case "catching-up":
    case "reorging":
    case "failed":
    case "schema-mismatch":
    case "service-version-mismatch":
      return state;
    case "starting":
    case "stopping":
      return "starting";
    default:
      return "unavailable";
  }
}

function resolveMiningRuntimeTipStatusRefreshFromIndexerStatus(
  status: ManagedIndexerDaemonObservedStatus,
): MiningRuntimeTipStatusRefresh {
  const tipsAligned = resolveObservedTipAlignment({
    coreBestHeight: status.coreBestHeight ?? null,
    coreBestHash: status.coreBestHash ?? null,
    indexerTipHeight: status.appliedTipHeight ?? null,
    indexerTipHash: status.appliedTipHash ?? null,
  });

  return {
    indexerDaemonState: mapIndexerDaemonStatusStateForMining(status.state),
    indexerDaemonInstanceId: status.daemonInstanceId ?? null,
    indexerSnapshotSeq: status.snapshotSeq ?? null,
    indexerSnapshotOpenedAtUnixMs: null,
    indexerTruthSource: "status-file",
    indexerHeartbeatAtUnixMs: status.heartbeatAtUnixMs ?? null,
    coreBestHeight: status.coreBestHeight ?? null,
    coreBestHash: status.coreBestHash ?? null,
    indexerTipHeight: status.appliedTipHeight ?? null,
    indexerTipHash: status.appliedTipHash ?? null,
    indexerStatusTipHeight: status.appliedTipHeight ?? null,
    indexerStatusTipHash: status.appliedTipHash ?? null,
    indexerObservedAtUnixMs: status.updatedAtUnixMs ?? status.heartbeatAtUnixMs ?? null,
    indexerReorgDepth: status.reorgDepth ?? null,
    indexerTipAligned: tipsAligned,
    tipsAligned,
    targetBlockHeight: status.coreBestHeight === null ? null : status.coreBestHeight + 1,
    referencedBlockHashDisplay: status.coreBestHash ?? null,
  };
}

function resolveObservedTipAlignment(options: {
  coreBestHeight: number | null;
  coreBestHash: string | null;
  indexerTipHeight: number | null;
  indexerTipHash: string | null;
}): boolean | null {
  if (options.coreBestHeight === null || options.indexerTipHeight === null) {
    return null;
  }

  if (options.coreBestHeight !== options.indexerTipHeight) {
    return false;
  }

  return options.coreBestHash === null
    || options.indexerTipHash === null
    || options.coreBestHash === options.indexerTipHash;
}

function mergeMiningRuntimeTipStatusRefresh(options: {
  indexerStatus: MiningRuntimeTipStatusRefresh | null;
  coreStatus: MiningRuntimeTipStatusRefresh | null;
}): MiningRuntimeTipStatusRefresh | null {
  if (options.indexerStatus === null) {
    return options.coreStatus;
  }

  if (options.coreStatus === null) {
    return options.indexerStatus;
  }

  const coreBestHeight = options.coreStatus.coreBestHeight ?? options.indexerStatus.coreBestHeight ?? null;
  const coreBestHash = options.coreStatus.coreBestHash ?? options.indexerStatus.coreBestHash ?? null;
  const indexerTipHeight = options.indexerStatus.indexerStatusTipHeight
    ?? options.indexerStatus.indexerTipHeight
    ?? null;
  const indexerTipHash = options.indexerStatus.indexerStatusTipHash
    ?? options.indexerStatus.indexerTipHash
    ?? null;
  const tipsAligned = resolveObservedTipAlignment({
    coreBestHeight,
    coreBestHash,
    indexerTipHeight,
    indexerTipHash,
  });

  return {
    ...options.indexerStatus,
    coreBestHeight,
    coreBestHash,
    corePublishState: options.coreStatus.corePublishState ?? options.indexerStatus.corePublishState ?? null,
    targetBlockHeight: coreBestHeight === null ? null : coreBestHeight + 1,
    referencedBlockHashDisplay: coreBestHash,
    indexerTipAligned: tipsAligned,
    tipsAligned,
  };
}

function indexerDaemonStatusIsFresh(
  status: ManagedIndexerDaemonObservedStatus,
  nowUnixMs: number,
): boolean {
  const observedAtUnixMs = status.updatedAtUnixMs ?? status.heartbeatAtUnixMs ?? null;

  return observedAtUnixMs !== null
    && (nowUnixMs - observedAtUnixMs) <= MINING_FOREGROUND_TIP_STATUS_STALE_MS
    && status.coreBestHeight !== null
    && status.coreBestHash !== null;
}

async function resolveMiningRuntimeTipStatusRefreshFromCoreProbe(options: {
  status: ManagedBitcoindObservedStatus | null;
  signal?: AbortSignal;
}): Promise<MiningRuntimeTipStatusRefresh | null> {
  if (options.status === null || options.status.state !== "ready") {
    return null;
  }

  const rpc = createRpcClient(options.status.rpc, {
    requestTimeoutMs: MINING_FOREGROUND_CORE_PROBE_TIMEOUT_MS,
    abortSignal: options.signal,
  });

  const [blockchain, network, mempool] = await Promise.all([
    rpc.getBlockchainInfo(),
    rpc.getNetworkInfo(),
    rpc.getMempoolInfo(),
  ]);
  const corePublishState = determineCorePublishState({
    blockchain,
    network,
    mempool,
  });

  return {
    coreBestHeight: blockchain.blocks,
    coreBestHash: blockchain.bestblockhash,
    corePublishState,
    targetBlockHeight: blockchain.blocks + 1,
    referencedBlockHashDisplay: blockchain.bestblockhash,
  };
}

function resolveMiningRuntimeTipStatusRefresh(
  readContext: WalletReadContext,
  options: { includeAttemptFields?: boolean } = {},
): MiningRuntimeTipStatusRefresh {
  const coreTip = resolveReadContextCoreTip(readContext);
  const coreBestHeight = coreTip.height;
  const coreBestHash = coreTip.hash;
  const indexerTipHeight = readContext.indexer.snapshotTip?.height ?? null;
  const indexerTipHash = readContext.indexer.snapshotTip?.blockHashHex ?? null;
  const tipsAligned = resolveObservedTipAlignment({
    coreBestHeight,
    coreBestHash,
    indexerTipHeight,
    indexerTipHash,
  });

  const liveStatus: MiningRuntimeTipStatusRefresh = {
    indexerDaemonState: readContext.indexer.health,
    indexerDaemonInstanceId: readContext.indexer.daemonInstanceId ?? null,
    indexerSnapshotSeq: readContext.indexer.snapshotSeq ?? null,
    indexerSnapshotOpenedAtUnixMs: readContext.indexer.openedAtUnixMs ?? null,
    indexerTruthSource: readContext.indexer.source ?? "none",
    indexerHeartbeatAtUnixMs: readContext.indexer.status?.heartbeatAtUnixMs ?? null,
    coreBestHeight,
    coreBestHash,
    indexerTipHeight,
    indexerTipHash,
    indexerStatusTipHeight: readContext.indexer.status?.appliedTipHeight ?? null,
    indexerStatusTipHash: readContext.indexer.status?.appliedTipHash ?? null,
    indexerObservedAtUnixMs: readContext.indexer.status?.updatedAtUnixMs
      ?? readContext.indexer.status?.heartbeatAtUnixMs
      ?? null,
    indexerReorgDepth: readContext.indexer.status?.reorgDepth ?? null,
    indexerTipAligned: tipsAligned,
    tipsAligned,
    targetBlockHeight: coreBestHeight === null ? null : coreBestHeight + 1,
    referencedBlockHashDisplay: coreBestHash,
  };

  if (options.includeAttemptFields === false) {
    return liveStatus;
  }

  return {
    ...liveStatus,
    attemptTargetBlockHeight: coreBestHeight === null ? null : coreBestHeight + 1,
    attemptReferencedBlockHashDisplay: coreBestHash,
    attemptIndexerSnapshotSeq: readContext.indexer.snapshotSeq ?? null,
  };
}

function startForegroundMiningStatusHeartbeat(options: {
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  foregroundPid: number | null;
  foregroundRunId: string | null;
  intervalMs: number;
  nowUnixMs: () => number;
  loadTipStatus?: (nowUnixMs: number) => Promise<MiningRuntimeTipStatusRefresh | null>;
  onSavedSnapshot?: (snapshot: MiningRuntimeStatusV1) => void;
}): () => void {
  if (options.runMode !== "foreground" || options.foregroundRunId === null || options.foregroundPid === null) {
    return () => undefined;
  }

  let refreshRunning = false;
  let refreshRequested = false;
  const runRefresh = () => {
    refreshRequested = true;
    if (refreshRunning) {
      return;
    }

    refreshRunning = true;
    void (async () => {
      while (refreshRequested) {
        refreshRequested = false;
        const heartbeatAtUnixMs = options.nowUnixMs();
        const tipStatus = await options.loadTipStatus?.(heartbeatAtUnixMs).catch(() => null) ?? null;
        const snapshot = await saveForegroundMiningHeartbeatStatus({
          statusPath: options.paths.miningStatusPath,
          foregroundPid: options.foregroundPid!,
          foregroundRunId: options.foregroundRunId!,
          heartbeatAtUnixMs,
          tipStatus,
        });
        if (snapshot !== null) {
          options.onSavedSnapshot?.(snapshot);
        }
      }
    })().catch(() => undefined).finally(() => {
      refreshRunning = false;
      if (refreshRequested) {
        runRefresh();
      }
    });
  };

  const timer = setInterval(() => {
    runRefresh();
  }, options.intervalMs);

  timer.unref();
  runRefresh();
  return () => {
    clearInterval(timer);
  };
}

async function appendEvent(paths: WalletRuntimePaths, event: MiningEventRecord): Promise<void> {
  await appendMiningEvent(paths.miningEventsPath, event);
}

function getIndexerTruthKey(
  readContext: WalletReadContext & {
    localState: { availability: "ready"; state: WalletStateV1 };
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
  },
): IndexerTruthKey | null {
  return getIndexerTruthKeyModule(readContext);
}

async function ensureIndexerTruthIsCurrent(options: {
  dataDir: string;
  truthKey: IndexerTruthKey | null;
}): Promise<void> {
  await ensureIndexerTruthIsCurrentModule(options);
}

function determineCorePublishState(info: {
  blockchain: Awaited<ReturnType<MiningRpcClient["getBlockchainInfo"]>>;
  network: Awaited<ReturnType<MiningRpcClient["getNetworkInfo"]>>;
  mempool: Awaited<ReturnType<MiningRpcClient["getMempoolInfo"]>>;
}): MiningRuntimeStatusV1["corePublishState"] {
  return determineCorePublishStateModule(info);
}

async function generateCandidatesForDomains(options: Parameters<typeof generateCandidatesForDomainsModule>[0]): Promise<MiningCandidate[]> {
  return await generateCandidatesForDomainsModule(options);
}

async function chooseBestLocalCandidate(candidates: MiningCandidate[]): Promise<MiningCandidate | null> {
  return await chooseBestLocalCandidateModule(candidates);
}

async function runCompetitivenessGate(options: Parameters<typeof runCompetitivenessGateModule>[0]): Promise<CompetitivenessDecision> {
  return await runCompetitivenessGateModule(options);
}

async function reconcileLiveMiningState(
  options: Parameters<typeof reconcileLiveMiningStateModule>[0],
): Promise<{ state: WalletStateV1; recentWin: MiningRecentWinSummary | null }> {
  return await reconcileLiveMiningStateModule(options);
}

export async function ensureBuiltInMiningSetupIfNeeded(options: {
  provider: WalletSecretProvider;
  prompter: WalletPrompter;
  paths: WalletRuntimePaths;
}): Promise<boolean> {
  const config = await loadClientConfig({
    path: options.paths.clientConfigPath,
    provider: options.provider,
  }).catch(() => null);
  const builtInConfig = config?.mining?.builtIn ?? null;

  if (builtInConfig !== null) {
    return true;
  }

  if (options.prompter.isInteractive === false) {
    return false;
  }

  await setupBuiltInMining({
    provider: options.provider,
    prompter: options.prompter,
    paths: options.paths,
  });
  return true;
}

async function performMiningCycle(options: {
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  foregroundPid: number | null;
  foregroundRunId: string | null;
  backgroundWorkerPid: number | null;
  backgroundWorkerRunId: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  openReadContext: typeof openWalletReadContext;
  attachService: typeof attachOrStartManagedBitcoindService;
  probeService: typeof probeManagedBitcoindService;
  stopService: typeof stopManagedBitcoindService;
  rpcFactory: (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  stdout?: { write(chunk: string): void };
  suspendDetector?: MiningSuspendDetector;
  generateCandidatesForDomainsImpl?: typeof generateCandidatesForDomains;
  runCompetitivenessGateImpl?: typeof runCompetitivenessGate;
  assaySentencesImpl?: typeof assaySentences;
  cooperativeYieldImpl?: MiningCooperativeYield;
  cooperativeYieldEvery?: number;
  visualizer?: MiningFollowVisualizer;
  loopState: MiningLoopState;
  nowImpl?: () => number;
}): Promise<MiningCycleResult> {
  const now = options.nowImpl ?? Date.now;
  const cycleStartedAtUnixMs = now();
  const runtimeRunId = resolveMiningRunId(options);
  const generateCandidatesForDomainsImpl = options.generateCandidatesForDomainsImpl ?? generateCandidatesForDomains;
  const runCompetitivenessGateImpl = options.runCompetitivenessGateImpl ?? runCompetitivenessGate;
  const throwIfStopping = () => {
    throwIfMiningStopRequested(options.signal);
  };
  let readContext: WalletReadContext | null = await options.openReadContext({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    secretProvider: options.provider,
    paths: options.paths,
  });
  let readContextClosed = false;

  try {
    throwIfStopping();
    throwIfMiningSuspendDetected(options.suspendDetector);
    let clearRecoveredBitcoindError = false;
    const saveCycleStatus = async (
      readContext: WalletReadContext,
      overrides: MiningRunnerStatusOverrides,
      includeVisualizer = true,
    ): Promise<MiningRuntimeStatusV1> => {
      const statusNowUnixMs = now();
      const resolvedOverrides = clearRecoveredBitcoindError && overrides.lastError === undefined
        ? {
          ...overrides,
          lastError: null,
        }
        : overrides;

      return await refreshAndSaveMiningRuntimeStatus({
        paths: options.paths,
        provider: options.provider,
        readContext,
        overrides: {
          ...buildMiningSettleWindowStatusOverrides(options.loopState, statusNowUnixMs),
          ...createForegroundMiningLivenessOverrides({
            runMode: options.runMode,
            foregroundPid: options.foregroundPid,
            foregroundRunId: options.foregroundRunId,
            nowUnixMs: statusNowUnixMs,
          }),
          cycleStartedAtUnixMs,
          ...resolveMiningRuntimeTipStatusRefresh(readContext),
          ...resolvedOverrides,
        },
        nowUnixMs: statusNowUnixMs,
        visualizer: includeVisualizer ? options.visualizer : undefined,
        visualizerState: includeVisualizer ? options.loopState.ui : undefined,
      });
    };
    const saveLiveCycleStatus = async (
      overrides: MiningRunnerStatusOverrides,
    ): Promise<MiningRuntimeStatusV1 | null> => {
      let liveReadContext: WalletReadContext | null = null;
      try {
        liveReadContext = await options.openReadContext({
          dataDir: options.dataDir,
          databasePath: options.databasePath,
          secretProvider: options.provider,
          paths: options.paths,
        });
        const statusNowUnixMs = now();
        const resolvedOverrides = clearRecoveredBitcoindError && overrides.lastError === undefined
          ? {
            ...overrides,
            lastError: null,
          }
          : overrides;

        return await refreshAndSaveMiningRuntimeStatus({
          paths: options.paths,
          provider: options.provider,
          readContext: liveReadContext,
          overrides: {
            ...buildMiningSettleWindowStatusOverrides(options.loopState, statusNowUnixMs),
            ...createForegroundMiningLivenessOverrides({
              runMode: options.runMode,
              foregroundPid: options.foregroundPid,
              foregroundRunId: options.foregroundRunId,
              nowUnixMs: statusNowUnixMs,
            }),
            cycleStartedAtUnixMs,
            ...resolveMiningRuntimeTipStatusRefresh(liveReadContext, { includeAttemptFields: false }),
            ...resolvedOverrides,
          },
          nowUnixMs: statusNowUnixMs,
          visualizer: options.visualizer,
          visualizerState: options.loopState.ui,
        });
      } catch {
        return null;
      } finally {
        await liveReadContext?.close().catch(() => undefined);
      }
    };

    readContext = await reacquireIndexerSnapshotReadContext({
      readContext,
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      provider: options.provider,
      paths: options.paths,
      openReadContext: options.openReadContext,
      signal: options.signal,
      throwIfInterrupted: () => {
        throwIfStopping();
        throwIfMiningSuspendDetected(options.suspendDetector);
      },
    });

    await saveCycleStatus(readContext, {
      runMode: options.runMode,
      foregroundPid: options.runMode === "foreground" ? options.foregroundPid : null,
      foregroundRunId: options.runMode === "foreground" ? options.foregroundRunId : null,
      foregroundHeartbeatAtUnixMs: options.runMode === "foreground" ? now() : null,
      backgroundWorkerPid: options.backgroundWorkerPid,
      backgroundWorkerRunId: options.backgroundWorkerRunId,
      backgroundWorkerHeartbeatAtUnixMs: options.runMode === "background" ? now() : null,
    }, false);

    if (readContext.localState.availability !== "ready" || readContext.localState.state === null) {
      clearMiningProviderWait(options.loopState);
      await saveCycleStatus(readContext, {
        runMode: options.runMode,
        currentPhase: "waiting",
        readinessBlocker: "wallet-state",
        lastError: null,
        note: "Wallet state must be locally available for mining to continue.",
      });
      return continueMiningCycleNormally();
    }

    const service = await options.attachService({
      dataDir: options.dataDir,
      chain: "main",
      startHeight: 0,
      walletRootId: readContext.localState.state.walletRootId,
    });
    throwIfStopping();
    throwIfMiningSuspendDetected(options.suspendDetector);
    const rpc = options.rpcFactory(service.rpc);
    const serviceZmq = service.zmq as { endpoint?: string; rawTxTopic?: "rawtx" } | undefined;
    const mempoolIndexCachePath = resolveMiningMempoolIndexCachePath(options.paths);
    const mempoolIndexServiceIdentity = resolveMiningMempoolServiceIdentity({
      dataDir: service.dataDir ?? options.dataDir,
      pid: service.pid,
      zmqEndpoint: serviceZmq?.endpoint ?? "unknown-zmq-endpoint",
      rawTxTopic: serviceZmq?.rawTxTopic,
    });
    const mempoolIndexRawTxSupported = serviceZmq?.rawTxTopic === "rawtx";
    await pruneMiningMempoolIndexServicesForWallet({
      walletRootId: readContext.localState.state.walletRootId,
      cachePath: mempoolIndexCachePath,
      serviceIdentity: mempoolIndexServiceIdentity,
    }).catch(() => undefined);
    if (mempoolIndexRawTxSupported && serviceZmq?.endpoint !== undefined) {
      await ensureMiningMempoolRawTxSubscriber({
        walletRootId: readContext.localState.state.walletRootId,
        serviceIdentity: mempoolIndexServiceIdentity,
        cachePath: mempoolIndexCachePath,
        zmqEndpoint: serviceZmq.endpoint,
        rawTxTopic: serviceZmq.rawTxTopic,
      }).catch(() => false);
    }
    const effectiveCoreTip = resolveReadContextCoreTip(readContext);
    const reconciliation = await reconcileLiveMiningState({
      state: readContext.localState.state,
      rpc,
      nodeBestHash: effectiveCoreTip.hash,
      nodeBestHeight: effectiveCoreTip.height,
      snapshotState: readContext.snapshot?.state ?? null,
    });
    throwIfStopping();
    const reconciledState = reconciliation.state;
    throwIfMiningSuspendDetected(options.suspendDetector);
    let effectiveReadContext = readContext as WalletReadContext & {
      localState: { availability: "ready"; state: WalletStateV1 };
    };
    const reconciledMiningStateChanged = JSON.stringify(reconciledState.miningState) !== JSON.stringify(
      readContext.localState.state.miningState,
    );

    if (reconciledMiningStateChanged) {
      effectiveReadContext = {
        ...readContext,
        localState: {
          ...readContext.localState,
          availability: "ready",
          state: reconciledState,
        },
      };
    }

    if (reconciliation.recentWin !== null) {
      options.loopState.ui.recentWin = reconciliation.recentWin;
    }

    if (effectiveReadContext.localState.state.miningState.currentTxid !== null) {
      options.loopState.ui.latestTxid = effectiveReadContext.localState.state.miningState.currentTxid;
    }

    const indexedTip = effectiveReadContext.snapshot?.tip ?? effectiveReadContext.indexer.snapshotTip ?? null;
    const visibleBlockTimes = await loadMiningVisibleFollowBlockTimes({
      rpc,
      indexedTipHeight: indexedTip?.height ?? null,
      indexedTipHashHex: indexedTip?.blockHashHex ?? null,
    }).catch(() => ({}));
    throwIfStopping();
    syncMiningVisualizerBlockTimes(options.loopState, visibleBlockTimes);
    const { targetBlockHeight, tipKey, tipChanged } = syncMiningUiForCurrentTip({
      loopState: options.loopState,
      snapshotState: effectiveReadContext.snapshot?.state ?? null,
      snapshotTipHeight: effectiveReadContext.snapshot?.tip?.height ?? effectiveReadContext.indexer.snapshotTip?.height ?? null,
      snapshotTipPreviousHashHex: effectiveReadContext.snapshot?.tip?.previousHashHex ?? effectiveReadContext.indexer.snapshotTip?.previousHashHex ?? null,
      nodeBestHeight: resolveReadContextCoreTip(effectiveReadContext).height,
      nodeBestHash: resolveReadContextCoreTip(effectiveReadContext).hash,
      recentWin: reconciliation.recentWin,
    });
    if (tipChanged) {
      setMiningTipSettleWindow(options.loopState, now());
      if (options.loopState.providerWaitNextRetryAtUnixMs === null) {
        clearMiningProviderWait(options.loopState);
      }
    }
    const displaySats = await resolveFundingDisplaySats(effectiveReadContext.localState.state, rpc).catch(() => null);
    syncMiningVisualizerBalances(options.loopState, effectiveReadContext, displaySats);

    const readiness = resolveMiningReadiness(effectiveReadContext);
    if (!readiness.ready) {
      clearMiningProviderWait(options.loopState);
      await saveCycleStatus(effectiveReadContext, {
        runMode: options.runMode,
        currentPhase: readiness.currentPhase,
        readinessBlocker: readiness.blocker,
        note: readiness.note,
      });
      return continueMiningCycleNormally();
    }

    if (reconciledMiningStateChanged) {
      await saveWalletStatePreservingUnlock({
        state: reconciledState,
        provider: options.provider,
        paths: options.paths,
      });
    }

    const readyReadContext = resolveReadyMiningReadContext(effectiveReadContext);
    if (readyReadContext === null) {
      clearMiningProviderWait(options.loopState);
      await saveCycleStatus(effectiveReadContext, {
        runMode: options.runMode,
        currentPhase: "waiting-indexer",
        readinessBlocker: "indexer-snapshot",
        note: "Mining is waiting for a coherent indexer snapshot lease.",
      });
      return continueMiningCycleNormally();
    }

    if (readyReadContext.localState.state.miningState.state === "repair-required") {
      clearMiningProviderWait(options.loopState);
      await saveCycleStatus(readyReadContext, {
        runMode: options.runMode,
        currentPhase: "waiting",
        lastError: null,
        note: "Mining is blocked until the current mining publish is repaired or reconciled.",
      });
      return continueMiningCycleNormally();
    }

    if (hasBlockingMutation(readyReadContext.localState.state)) {
      clearMiningProviderWait(options.loopState);
      const nextState = defaultMiningStatePatch(readyReadContext.localState.state, {
        state: "paused",
        pauseReason: "wallet-busy",
      });
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider: options.provider,
        paths: options.paths,
      });
      const blockedReadContext: WalletReadContext = {
        ...readyReadContext,
        localState: {
          ...readyReadContext.localState,
          availability: "ready",
          state: nextState,
        },
      };
      await saveCycleStatus(blockedReadContext, {
        runMode: options.runMode,
        currentPhase: "waiting",
        lastError: null,
        note: "Mining is paused while another wallet mutation is active.",
      });
      return continueMiningCycleNormally();
    }

    const preemptionRequest = await readMiningPreemptionRequest(options.paths);
    if (preemptionRequest !== null) {
      clearMiningProviderWait(options.loopState);
      const nextState = defaultMiningStatePatch(readyReadContext.localState.state, {
        state: readyReadContext.localState.state.miningState.livePublishInMempool
          && readyReadContext.localState.state.miningState.state === "paused-stale"
          ? "paused-stale"
          : "paused",
        pauseReason: preemptionRequest.reason,
      });
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider: options.provider,
        paths: options.paths,
      });
      await saveCycleStatus({
        ...readyReadContext,
        localState: {
          ...readyReadContext.localState,
          state: nextState,
        },
      }, {
        runMode: options.runMode,
        currentPhase: "waiting",
        lastError: null,
        note: "Mining is paused while another wallet command is preempting sentence generation.",
      });
      return continueMiningCycleNormally();
    }

    const [blockchainInfo, networkInfo, mempoolInfo] = await Promise.all([
      timeMiningPublishabilityRpc({
        paths: options.paths,
        runId: runtimeRunId,
        kind: "timing-publishability-getblockchaininfo",
        message: "Checked Bitcoin Core blockchain status for mining publishability.",
        method: "getblockchaininfo",
        operation: async () => await rpc.getBlockchainInfo(),
      }),
      timeMiningPublishabilityRpc({
        paths: options.paths,
        runId: runtimeRunId,
        kind: "timing-publishability-getnetworkinfo",
        message: "Checked Bitcoin Core network status for mining publishability.",
        method: "getnetworkinfo",
        operation: async () => await rpc.getNetworkInfo(),
      }),
      timeMiningPublishabilityRpc({
        paths: options.paths,
        runId: runtimeRunId,
        kind: "timing-publishability-getmempoolinfo",
        message: "Checked Bitcoin Core mempool status for mining publishability.",
        method: "getmempoolinfo",
        operation: async () => await rpc.getMempoolInfo(),
      }),
    ]);
    throwIfStopping();
    throwIfMiningSuspendDetected(options.suspendDetector);
    const corePublishState = determineCorePublishState({
      blockchain: blockchainInfo,
      network: networkInfo,
      mempool: mempoolInfo,
    });
    clearRecoveredBitcoindError = resetMiningBitcoindRecoveryState(
      options.loopState,
      readyReadContext.nodeStatus?.serviceStatus ?? { pid: service.pid },
    );

    const publishReadiness = resolveMiningReadiness(readyReadContext, { corePublishState });
    if (!publishReadiness.ready) {
      clearMiningProviderWait(options.loopState);
      const statusWriteStartedAt = performance.now();
      try {
        await saveCycleStatus(readyReadContext, {
          runMode: options.runMode,
          currentPhase: publishReadiness.currentPhase,
          corePublishState,
          readinessBlocker: publishReadiness.blocker,
          note: publishReadiness.note,
        });
        await appendRuntimeTimingEvent(
          options.paths,
          "timing-publishability-status-write",
          "Wrote mining publishability wait status.",
          {
            runId: runtimeRunId,
            durationMs: performance.now() - statusWriteStartedAt,
            metrics: {
              outcome: "success",
              corePublishState,
              readinessBlocker: publishReadiness.blocker ?? null,
            },
          },
        );
      } catch (error) {
        await appendRuntimeTimingEvent(
          options.paths,
          "timing-publishability-status-write",
          "Wrote mining publishability wait status.",
          {
            level: "warn",
            runId: runtimeRunId,
            durationMs: performance.now() - statusWriteStartedAt,
            metrics: {
              outcome: "error",
              corePublishState,
              readinessBlocker: publishReadiness.blocker ?? null,
              errorName: error instanceof Error ? error.name : "unknown",
            },
          },
        );
        throw error;
      }
      return continueMiningCycleNormally();
    }

    if (targetBlockHeight !== null && getBlockRewardCogtoshi(targetBlockHeight) === 0n) {
      clearMiningProviderWait(options.loopState);
      const nextState = defaultMiningStatePatch(readyReadContext.localState.state, {
        state: "paused",
        pauseReason: "zero-reward",
      });
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider: options.provider,
        paths: options.paths,
      });
      await saveCycleStatus({
        ...readyReadContext,
        localState: {
          ...readyReadContext.localState,
          state: nextState,
        },
      }, {
        runMode: options.runMode,
        currentPhase: "idle",
        currentPublishDecision: "publish-skipped-zero-reward",
        lastError: null,
        note: "Mining is disabled because the target block reward is zero.",
      });
      await appendEvent(options.paths, createEvent(
        "publish-skipped-zero-reward",
        "Skipped mining because the target block reward is zero.",
        {
          targetBlockHeight,
          referencedBlockHashDisplay: resolveReadContextCoreTip(readyReadContext).hash,
          runId: runtimeRunId,
        },
      ));
      return continueMiningCycleNormally();
    }

    const phaseResult = await runMiningPhaseMachine({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      provider: options.provider,
      paths: options.paths,
      runMode: options.runMode,
      backgroundWorkerRunId: runtimeRunId,
      readContext: readyReadContext,
      rpc,
      targetBlockHeight,
      tipKey,
      corePublishState,
      loopState: options.loopState,
      openReadContext: options.openReadContext,
      attachService: options.attachService,
      rpcFactory: options.rpcFactory,
      fetchImpl: options.fetchImpl,
      generateCandidatesForDomainsImpl,
      runCompetitivenessGateImpl,
      assaySentencesImpl: options.assaySentencesImpl,
      cooperativeYieldImpl: options.cooperativeYieldImpl,
      cooperativeYieldEvery: options.cooperativeYieldEvery,
      mempoolIndex: {
        rawTxSupported: mempoolIndexRawTxSupported,
        cachePath: mempoolIndexCachePath,
        serviceIdentity: mempoolIndexServiceIdentity,
      },
      nowImpl: now,
      saveCycleStatus: async (context, overrides) => await saveCycleStatus(context, overrides),
      saveLiveCycleStatus: options.foregroundRunId === null ? undefined : saveLiveCycleStatus,
      appendEvent: async (event) => await appendEvent(options.paths, event),
      stopSignal: options.signal,
      throwIfStopping,
      throwIfSuspendDetected: () => {
        throwIfMiningSuspendDetected(options.suspendDetector);
      },
    });
    if (phaseResult.restartImmediately) {
      if (readContext !== null && !readContextClosed) {
        await readContext.close();
        readContextClosed = true;
      }

      let freshReadContext = await options.openReadContext({
        dataDir: options.dataDir,
        databasePath: options.databasePath,
        secretProvider: options.provider,
        paths: options.paths,
      });
      readContext = freshReadContext;
      readContextClosed = false;
      freshReadContext = await reacquireIndexerSnapshotReadContext({
        readContext: freshReadContext,
        dataDir: options.dataDir,
        databasePath: options.databasePath,
        provider: options.provider,
        paths: options.paths,
        openReadContext: options.openReadContext,
        signal: options.signal,
        throwIfInterrupted: () => {
          throwIfStopping();
          throwIfMiningSuspendDetected(options.suspendDetector);
        },
      });
      readContext = freshReadContext;

      const freshReadiness = resolveMiningReadiness(freshReadContext);
      const freshCoreTip = resolveReadContextCoreTip(freshReadContext);
      const freshCoreBestHeight = freshCoreTip.height;
      const freshTargetBlockHeight = freshCoreBestHeight === null ? null : freshCoreBestHeight + 1;
      await saveCycleStatus(freshReadContext, {
        runMode: options.runMode,
        currentPhase: freshReadiness.ready ? "idle" : freshReadiness.currentPhase,
        readinessBlocker: freshReadiness.blocker,
        currentPublishDecision: null,
        targetBlockHeight: freshTargetBlockHeight,
        referencedBlockHashDisplay: freshCoreTip.hash,
        lastError: null,
        note: phaseResult.restartNote ?? (freshReadiness.ready ? null : freshReadiness.note),
      });
      return restartMiningCycleImmediately(phaseResult.restartNote);
    }

    return continueMiningCycleNormally();
  } catch (error) {
    if (isMiningStopRequestedError(error)) {
      return continueMiningCycleNormally();
    }

    if (error instanceof MiningSuspendDetectedError) {
      discardMiningLoopTransientWork(options.loopState, readContext?.localState.walletRootId ?? undefined);
      if (readContext !== null && !readContextClosed) {
        await readContext.close();
        readContextClosed = true;
      }
      await handleDetectedMiningRuntimeResume({
        dataDir: options.dataDir,
        databasePath: options.databasePath,
        provider: options.provider,
        paths: options.paths,
        runMode: options.runMode,
        foregroundPid: options.foregroundPid,
        foregroundRunId: options.foregroundRunId,
        backgroundWorkerPid: options.backgroundWorkerPid,
        backgroundWorkerRunId: options.backgroundWorkerRunId,
        detectedAtUnixMs: error.detectedAtUnixMs,
        openReadContext: options.openReadContext,
        visualizer: options.visualizer,
        loopState: options.loopState,
      });
      return continueMiningCycleNormally();
    }

    if (readContext !== null && isRecoverableMiningBitcoindError(error)) {
      await handleRecoverableMiningBitcoindFailure({
        error,
        dataDir: options.dataDir,
        provider: options.provider,
        paths: options.paths,
        runMode: options.runMode,
        foregroundPid: options.foregroundPid,
        foregroundRunId: options.foregroundRunId,
        readContext,
        loopState: options.loopState,
        cycleStartedAtUnixMs,
        attachService: options.attachService,
        probeService: options.probeService,
        stopService: options.stopService,
        nowUnixMs: now(),
        visualizer: options.visualizer,
      });
      return continueMiningCycleNormally();
    }

    throw error;
  } finally {
    if (readContext !== null && !readContextClosed) {
      await readContext.close();
    }
  }
}

async function runMiningLoop(options: {
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  foregroundPid?: number | null;
  foregroundRunId?: string | null;
  backgroundWorkerPid: number | null;
  backgroundWorkerRunId: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  openReadContext: typeof openWalletReadContext;
  attachService: typeof attachOrStartManagedBitcoindService;
  probeService?: typeof probeManagedBitcoindService;
  stopService?: typeof stopManagedBitcoindService;
  rpcFactory: (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  stdout?: { write(chunk: string): void };
  loopState?: MiningLoopState;
  visualizer?: MiningFollowVisualizer;
  nowImpl?: () => number;
  sleepImpl?: typeof sleep;
  suspendMonotonicNowImpl?: () => number;
  suspendScheduler?: MiningSuspendScheduler;
  generateCandidatesForDomainsImpl?: typeof generateCandidatesForDomains;
  runCompetitivenessGateImpl?: typeof runCompetitivenessGate;
  assaySentencesImpl?: typeof assaySentences;
  cooperativeYieldImpl?: MiningCooperativeYield;
  cooperativeYieldEvery?: number;
  foregroundHeartbeatIntervalMs?: number;
}): Promise<void> {
  const now = options.nowImpl ?? Date.now;
  const foregroundPid = options.runMode === "foreground" ? options.foregroundPid ?? process.pid : null;
  const foregroundRunId = options.runMode === "foreground" ? options.foregroundRunId ?? null : null;
  const runtimeRunId = resolveMiningRunId({
    runMode: options.runMode,
    foregroundRunId,
    backgroundWorkerRunId: options.backgroundWorkerRunId,
  });
  const suspendDetector = createMiningSuspendDetector({
    monotonicNow: options.suspendMonotonicNowImpl,
    nowUnixMs: now,
    scheduler: options.suspendScheduler,
  });
  const loopState = options.loopState ?? createMiningLoopState();
  const probeService = options.probeService ?? probeManagedBitcoindService;
  const stopService = options.stopService ?? stopManagedBitcoindService;
  const sleepImpl = options.sleepImpl ?? sleep;
  const stopForegroundHeartbeat = startForegroundMiningStatusHeartbeat({
    paths: options.paths,
    runMode: options.runMode,
    foregroundPid,
    foregroundRunId,
    intervalMs: options.foregroundHeartbeatIntervalMs ?? MINING_STATUS_HEARTBEAT_INTERVAL_MS,
    nowUnixMs: now,
    loadTipStatus: async (heartbeatAtUnixMs) => {
      if (options.signal?.aborted) {
        return null;
      }

      const runtime = await loadMiningRuntimeStatus(options.paths.miningStatusPath).catch(() => null);
      const walletRootId = runtime?.walletRootId ?? null;
      if (walletRootId === null) {
        return null;
      }

      let indexerTipStatus: MiningRuntimeTipStatusRefresh | null = null;
      const probe = await probeIndexerDaemon({
        dataDir: options.dataDir,
        walletRootId,
      }).catch(() => null);
      try {
        if (
          probe?.status !== null
          && probe?.status !== undefined
          && indexerDaemonStatusIsFresh(probe.status, heartbeatAtUnixMs)
        ) {
          indexerTipStatus = resolveMiningRuntimeTipStatusRefreshFromIndexerStatus(probe.status);
        }
      } finally {
        await probe?.client?.close().catch(() => undefined);
      }

      if (indexerTipStatus === null) {
        const status = await readObservedIndexerDaemonStatus({
          dataDir: options.dataDir,
          walletRootId,
        }).catch(() => null);
        if (status !== null && indexerDaemonStatusIsFresh(status, heartbeatAtUnixMs)) {
          indexerTipStatus = resolveMiningRuntimeTipStatusRefreshFromIndexerStatus(status);
        }
      }

      const bitcoindStatus = await readManagedBitcoindObservedStatus({
        dataDir: options.dataDir,
        walletRootId,
      }).catch(() => null);
      const coreTipStatus = await resolveMiningRuntimeTipStatusRefreshFromCoreProbe({
        status: bitcoindStatus,
        signal: options.signal,
      }).catch(() => null);
      return mergeMiningRuntimeTipStatusRefresh({
        indexerStatus: indexerTipStatus,
        coreStatus: coreTipStatus,
      });
    },
    onSavedSnapshot: (snapshot) => {
      options.visualizer?.update(snapshot, loopState.ui);
    },
  });

  try {
    await appendEvent(options.paths, createEvent(
      "runtime-start",
      `Started ${options.runMode} mining runtime.`,
      {
        runId: runtimeRunId,
      },
    ));

    while (!options.signal?.aborted) {
      try {
        throwIfMiningStopRequested(options.signal);
        throwIfMiningSuspendDetected(suspendDetector);
      } catch (error) {
        if (isMiningStopRequestedError(error)) {
          break;
        }

        if (!(error instanceof MiningSuspendDetectedError)) {
          throw error;
        }

        discardMiningLoopTransientWork(loopState, null);
        await handleDetectedMiningRuntimeResume({
          dataDir: options.dataDir,
          databasePath: options.databasePath,
          provider: options.provider,
          paths: options.paths,
          runMode: options.runMode,
          foregroundPid,
          foregroundRunId,
          backgroundWorkerPid: options.backgroundWorkerPid,
          backgroundWorkerRunId: options.backgroundWorkerRunId,
          detectedAtUnixMs: error.detectedAtUnixMs,
          openReadContext: options.openReadContext,
          visualizer: options.visualizer,
          loopState,
        });
        continue;
      }

      let cycleResult = continueMiningCycleNormally();
      try {
        cycleResult = await performMiningCycle({
          ...options,
          foregroundPid,
          foregroundRunId,
          suspendDetector,
          assaySentencesImpl: options.assaySentencesImpl,
          cooperativeYieldImpl: options.cooperativeYieldImpl,
          cooperativeYieldEvery: options.cooperativeYieldEvery,
          loopState,
          probeService,
          stopService,
        });
      } catch (error) {
        if (isMiningStopRequestedError(error)) {
          break;
        }

        throw error;
      }

      if (options.signal?.aborted) {
        break;
      }
      if (cycleResult.restartImmediately) {
        continue;
      }
      await sleepImpl(Math.min(MINING_LOOP_INTERVAL_MS, MINING_STATUS_HEARTBEAT_INTERVAL_MS), options.signal);
    }

    if (options.signal?.aborted) {
      await appendEvent(options.paths, createEvent(
        "runtime-stop",
        `Stopped ${options.runMode} mining runtime.`,
        {
          runId: runtimeRunId,
        },
      ));
      return;
    }

    const service = await options.attachService({
      dataDir: options.dataDir,
      chain: "main",
      startHeight: 0,
      walletRootId: undefined,
    }).catch(() => null);
    if (service !== null) {
      await attemptSaveMempool({
        rpc: options.rpcFactory(service.rpc),
        paths: options.paths,
        runId: runtimeRunId,
      });
    }
    await appendEvent(options.paths, createEvent(
      "runtime-stop",
      `Stopped ${options.runMode} mining runtime.`,
      {
        runId: runtimeRunId,
      },
    ));
  } finally {
    stopForegroundHeartbeat();
    stopMiningSuspendDetector(suspendDetector);
  }
}

export async function runForegroundMining(options: RunForegroundMiningOptions): Promise<void> {
  if (!options.prompter.isInteractive) {
    throw new Error("mine_requires_tty");
  }

  const miningPrompter = bindClientPasswordPromptSessionPolicy(
    options.prompter,
    "mining-indefinite",
  );
  const provider = withInteractiveWalletSecretProvider(
    options.provider ?? createDefaultWalletSecretProvider(),
    miningPrompter,
  );
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const openReadContext = options.openReadContext ?? openWalletReadContext;
  const attachService = options.attachService ?? attachOrStartManagedBitcoindService;
  const rpcFactory = options.rpcFactory ?? (
    (config: Parameters<typeof createRpcClient>[0]) => createRpcClient(config, {
      abortSignal: options.signal,
    }) as MiningRpcClient
  );
  const requestMiningPreemption = options.requestMiningPreemption ?? requestMiningGenerationPreemption;

  const setupReady = options.builtInSetupEnsured === true
    ? true
    : await ensureBuiltInMiningSetupIfNeeded({
      provider,
      prompter: miningPrompter,
      paths,
    });
  if (!setupReady) {
    throw new Error("Built-in mining provider is not configured. Run `cogcoin mine setup`.");
  }

  await unlockClientPassword(provider, miningPrompter);

  await runForegroundMiningSupervisor({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    clientVersion: options.clientVersion,
    updateAvailable: options.updateAvailable,
    stdout: options.stdout,
    stderr: options.stderr,
    signal: options.signal,
    progressOutput: options.progressOutput,
    visualizer: options.visualizer,
    fetchImpl: options.fetchImpl,
    shutdownGraceMs: options.shutdownGraceMs,
    runtime: {
      provider,
      paths,
      openReadContext,
      attachService,
      rpcFactory,
    },
    deps: {
      requestMiningPreemption,
      runMiningLoop: options.runMiningLoopImpl ?? runMiningLoop,
      saveStopSnapshot: options.saveStopSnapshotImpl,
      sleep: options.sleepImpl,
    },
  });
}

export async function performMiningCycleForTesting(options: {
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  foregroundPid?: number | null;
  foregroundRunId?: string | null;
  backgroundWorkerPid: number | null;
  backgroundWorkerRunId: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  openReadContext: typeof openWalletReadContext;
  attachService: typeof attachOrStartManagedBitcoindService;
  probeService?: typeof probeManagedBitcoindService;
  stopService?: typeof stopManagedBitcoindService;
  rpcFactory: (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  stdout?: { write(chunk: string): void };
  loopState?: MiningLoopState;
  nowImpl?: () => number;
  generateCandidatesForDomainsImpl?: typeof generateCandidatesForDomains;
  runCompetitivenessGateImpl?: typeof runCompetitivenessGate;
  assaySentencesImpl?: typeof assaySentences;
  cooperativeYieldImpl?: MiningCooperativeYield;
  cooperativeYieldEvery?: number;
}): Promise<void> {
  await performMiningCycle({
    ...options,
    foregroundPid: options.runMode === "foreground" ? options.foregroundPid ?? process.pid : null,
    foregroundRunId: options.runMode === "foreground" ? options.foregroundRunId ?? null : null,
    probeService: options.probeService ?? probeManagedBitcoindService,
    stopService: options.stopService ?? stopManagedBitcoindService,
    loopState: options.loopState ?? createMiningLoopState(),
  });
}

export async function runMiningLoopForTesting(options: {
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  foregroundPid?: number | null;
  foregroundRunId?: string | null;
  backgroundWorkerPid: number | null;
  backgroundWorkerRunId: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  openReadContext: typeof openWalletReadContext;
  attachService: typeof attachOrStartManagedBitcoindService;
  probeService?: typeof probeManagedBitcoindService;
  stopService?: typeof stopManagedBitcoindService;
  rpcFactory: (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  stdout?: { write(chunk: string): void };
  loopState?: MiningLoopState;
  visualizer?: MiningFollowVisualizer;
  nowImpl?: () => number;
  sleepImpl?: typeof sleep;
  suspendMonotonicNowImpl?: () => number;
  suspendScheduler?: MiningSuspendScheduler;
  generateCandidatesForDomainsImpl?: typeof generateCandidatesForDomains;
  runCompetitivenessGateImpl?: typeof runCompetitivenessGate;
  assaySentencesImpl?: typeof assaySentences;
  cooperativeYieldImpl?: MiningCooperativeYield;
  cooperativeYieldEvery?: number;
  foregroundHeartbeatIntervalMs?: number;
}): Promise<void> {
  await runMiningLoop({
    ...options,
  });
}

export function createMiningSuspendDetectorForTesting(options: {
  monotonicNow?: () => number;
  nowUnixMs?: () => number;
  scheduler?: MiningSuspendScheduler;
} = {}): MiningSuspendDetector {
  return createMiningSuspendDetector(options);
}

export function throwIfMiningSuspendDetectedForTesting(detector: MiningSuspendDetector): void {
  throwIfMiningSuspendDetected(detector);
}
