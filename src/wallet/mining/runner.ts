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

import { probeIndexerDaemon } from "../../bitcoind/indexer-daemon.js";
import { isRetryableManagedRpcError } from "../../bitcoind/retryable-rpc.js";
import { FOLLOW_VISIBLE_PRIOR_BLOCKS } from "../../bitcoind/client/follow-block-times.js";
import {
  attachOrStartManagedBitcoindService,
  probeManagedBitcoindService,
  stopManagedBitcoindService,
} from "../../bitcoind/service.js";
import { createRpcClient } from "../../bitcoind/node.js";
import type { ProgressOutputMode } from "../../bitcoind/types.js";
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
  isMineableWalletDomain,
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
import { appendMiningEvent } from "./runtime-artifacts.js";
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
import { resolveReadyMiningReadContext } from "./engine-types.js";
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

const BEST_BLOCK_POLL_INTERVAL_MS = 500;
const MINING_SUSPEND_HEARTBEAT_INTERVAL_MS = 1_000;

type MiningRunnerStatusOverrides = MiningRuntimeStatusOverrides;

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

function createMiningLoopState(): MiningLoopState {
  return createMiningRuntimeLoopState();
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

  if (config?.mining.builtIn !== null) {
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
}): Promise<void> {
  const now = options.nowImpl ?? Date.now;
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
          ...resolvedOverrides,
        },
        visualizer: includeVisualizer ? options.visualizer : undefined,
        visualizerState: includeVisualizer ? options.loopState.ui : undefined,
      });
    };

    await saveCycleStatus(readContext, {
      runMode: options.runMode,
      backgroundWorkerPid: options.backgroundWorkerPid,
      backgroundWorkerRunId: options.backgroundWorkerRunId,
      backgroundWorkerHeartbeatAtUnixMs: options.runMode === "background" ? now() : null,
    }, false);

    if (readContext.localState.availability !== "ready" || readContext.localState.state === null) {
      clearMiningProviderWait(options.loopState);
      await saveCycleStatus(readContext, {
        runMode: options.runMode,
        currentPhase: "waiting",
        lastError: null,
        note: "Wallet state must be locally available for mining to continue.",
      });
      return;
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
    const reconciliation = await reconcileLiveMiningState({
      state: readContext.localState.state,
      rpc,
      nodeBestHash: readContext.nodeStatus?.nodeBestHashHex ?? null,
      nodeBestHeight: readContext.nodeStatus?.nodeBestHeight ?? null,
      snapshotState: readContext.snapshot?.state ?? null,
    });
    throwIfStopping();
    const reconciledState = reconciliation.state;
    throwIfMiningSuspendDetected(options.suspendDetector);
    let effectiveReadContext = readContext as WalletReadContext & {
      localState: { availability: "ready"; state: WalletStateV1 };
    };

    if (JSON.stringify(reconciledState.miningState) !== JSON.stringify(readContext.localState.state.miningState)) {
      await saveWalletStatePreservingUnlock({
        state: reconciledState,
        provider: options.provider,
        paths: options.paths,
      });
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
      nodeBestHeight: effectiveReadContext.nodeStatus?.nodeBestHeight ?? null,
      nodeBestHash: effectiveReadContext.nodeStatus?.nodeBestHashHex ?? null,
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

    const readyReadContext = resolveReadyMiningReadContext(effectiveReadContext);
    if (readyReadContext === null) {
      clearMiningProviderWait(options.loopState);
      await saveCycleStatus(effectiveReadContext, {
        runMode: options.runMode,
        currentPhase: "waiting-indexer",
        lastError: null,
        note: "Mining is waiting for Bitcoin Core and the indexer to align.",
      });
      return;
    }

    if (readyReadContext.localState.state.miningState.state === "repair-required") {
      clearMiningProviderWait(options.loopState);
      await saveCycleStatus(readyReadContext, {
        runMode: options.runMode,
        currentPhase: "waiting",
        lastError: null,
        note: "Mining is blocked until the current mining publish is repaired or reconciled.",
      });
      return;
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
      return;
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
      return;
    }

    const [blockchainInfo, networkInfo, mempoolInfo] = await Promise.all([
      rpc.getBlockchainInfo(),
      rpc.getNetworkInfo(),
      rpc.getMempoolInfo(),
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
          referencedBlockHashDisplay: readyReadContext.nodeStatus?.nodeBestHashHex ?? null,
          runId: options.backgroundWorkerRunId,
        },
      ));
      return;
    }

    await runMiningPhaseMachine({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      provider: options.provider,
      paths: options.paths,
      runMode: options.runMode,
      backgroundWorkerRunId: options.backgroundWorkerRunId,
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
      nowImpl: now,
      saveCycleStatus: async (context, overrides) => await saveCycleStatus(context, overrides),
      appendEvent: async (event) => await appendEvent(options.paths, event),
      stopSignal: options.signal,
      throwIfStopping,
      throwIfSuspendDetected: () => {
        throwIfMiningSuspendDetected(options.suspendDetector);
      },
    });
  } catch (error) {
    if (isMiningStopRequestedError(error)) {
      return;
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
        backgroundWorkerPid: options.backgroundWorkerPid,
        backgroundWorkerRunId: options.backgroundWorkerRunId,
        detectedAtUnixMs: error.detectedAtUnixMs,
        openReadContext: options.openReadContext,
        visualizer: options.visualizer,
        loopState: options.loopState,
      });
      return;
    }

    if (readContext !== null && isRecoverableMiningBitcoindError(error)) {
      await handleRecoverableMiningBitcoindFailure({
        error,
        dataDir: options.dataDir,
        provider: options.provider,
        paths: options.paths,
        runMode: options.runMode,
        readContext,
        loopState: options.loopState,
        attachService: options.attachService,
        probeService: options.probeService,
        stopService: options.stopService,
        nowUnixMs: now(),
        visualizer: options.visualizer,
      });
      return;
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
}): Promise<void> {
  const suspendDetector = createMiningSuspendDetector({
    monotonicNow: options.suspendMonotonicNowImpl,
    nowUnixMs: options.nowImpl ?? Date.now,
    scheduler: options.suspendScheduler,
  });
  const loopState = options.loopState ?? createMiningLoopState();
  const probeService = options.probeService ?? probeManagedBitcoindService;
  const stopService = options.stopService ?? stopManagedBitcoindService;
  const sleepImpl = options.sleepImpl ?? sleep;

  try {
    await appendEvent(options.paths, createEvent(
      "runtime-start",
      `Started ${options.runMode} mining runtime.`,
      {
        runId: options.backgroundWorkerRunId,
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
          backgroundWorkerPid: options.backgroundWorkerPid,
          backgroundWorkerRunId: options.backgroundWorkerRunId,
          detectedAtUnixMs: error.detectedAtUnixMs,
          openReadContext: options.openReadContext,
          visualizer: options.visualizer,
          loopState,
        });
        continue;
      }

      try {
        await performMiningCycle({
          ...options,
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
      await sleepImpl(Math.min(MINING_LOOP_INTERVAL_MS, MINING_STATUS_HEARTBEAT_INTERVAL_MS), options.signal);
    }

    if (options.signal?.aborted) {
      await appendEvent(options.paths, createEvent(
        "runtime-stop",
        `Stopped ${options.runMode} mining runtime.`,
        {
          runId: options.backgroundWorkerRunId,
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
        runId: options.backgroundWorkerRunId,
      });
    }
    await appendEvent(options.paths, createEvent(
      "runtime-stop",
      `Stopped ${options.runMode} mining runtime.`,
      {
        runId: options.backgroundWorkerRunId,
      },
    ));
  } finally {
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
