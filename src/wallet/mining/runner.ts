import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
import {
  FileLockBusyError,
  acquireFileLock,
  clearOrphanedFileLock,
  readLockMetadata,
} from "../fs/lock.js";
import type { WalletPrompter } from "../lifecycle.js";
import {
  isMineableWalletDomain,
  openWalletReadContext,
  type WalletReadContext,
} from "../read/index.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../runtime.js";
import {
  createDefaultWalletSecretProvider,
  type WalletSecretProvider,
} from "../state/provider.js";
import type {
  MiningStateRecord,
  OutpointRecord,
  WalletStateV1,
} from "../types.js";
import { serializeMine } from "../cogop/index.js";
import {
  appendMiningEvent,
  loadMiningRuntimeStatus,
  saveMiningRuntimeStatus,
} from "./runtime-artifacts.js";
import { loadClientConfig } from "./config.js";
import {
  MINING_LOOP_INTERVAL_MS,
  MINING_SHUTDOWN_GRACE_MS,
  MINING_STATUS_HEARTBEAT_INTERVAL_MS,
  MINING_SUSPEND_GAP_THRESHOLD_MS,
  MINING_WORKER_API_VERSION,
} from "./constants.js";
import { inspectMiningControlPlane, setupBuiltInMining } from "./control.js";
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
  ReadyMiningReadContext,
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
const BACKGROUND_START_TIMEOUT_MS = 15_000;
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
  spawnWorkerProcess?: typeof spawn;
  waitForBackgroundHealthyImpl?: typeof waitForBackgroundHealthy;
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

export interface StartBackgroundMiningOptions extends RunnerDependencies {
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  builtInSetupEnsured?: boolean;
  paths?: WalletRuntimePaths;
}

export interface StopBackgroundMiningOptions extends RunnerDependencies {
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  paths?: WalletRuntimePaths;
}

export interface MiningStartResult {
  started: boolean;
  snapshot: MiningRuntimeStatusV1 | null;
}

interface MiningRuntimeTakeoverResult {
  controlLockCleared: boolean;
  replaced: boolean;
  snapshot: MiningRuntimeStatusV1 | null;
  terminatedPids: number[];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
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

function normalizeMiningPid(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function resolveMiningGenerationRequestPath(paths: WalletRuntimePaths): string {
  return join(paths.miningRoot, "generation-request.json");
}

function resolveMiningGenerationActivityPath(paths: WalletRuntimePaths): string {
  return join(paths.miningRoot, "generation-activity.json");
}

function createTakeoverStoppedMiningNote(livePublishInMempool: boolean | null | undefined): string {
  return livePublishInMempool
    ? "Mining runtime replaced. The last mining transaction may still confirm from mempool."
    : "Mining runtime replaced.";
}

function createStoppedMiningRuntimeSnapshotForTakeover(options: {
  snapshot: MiningRuntimeStatusV1 | null;
  walletRootId: string | null;
  nowUnixMs: number;
}): MiningRuntimeStatusV1 {
  const note = createTakeoverStoppedMiningNote(options.snapshot?.livePublishInMempool);

  if (options.snapshot !== null) {
    return {
      ...options.snapshot,
      updatedAtUnixMs: options.nowUnixMs,
      runMode: "stopped",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      backgroundWorkerHeartbeatAtUnixMs: null,
      backgroundWorkerHealth: null,
      currentPhase: "idle",
      note,
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
    indexerReorgDepth: null,
    indexerTipAligned: null,
    corePublishState: null,
    providerState: null,
    lastSuspendDetectedAtUnixMs: null,
    reconnectSettledUntilUnixMs: null,
    tipSettledUntilUnixMs: null,
    miningState: "idle",
    currentPhase: "idle",
    currentPublishState: "none",
    targetBlockHeight: null,
    referencedBlockHashDisplay: null,
    currentDomainId: null,
    currentDomainName: null,
    currentSentenceDisplay: null,
    currentCanonicalBlend: null,
    currentTxid: null,
    currentWtxid: null,
    livePublishInMempool: null,
    currentFeeRateSatVb: null,
    currentAbsoluteFeeSats: null,
    currentBlockFeeSpentSats: "0",
    sessionFeeSpentSats: "0",
    lifetimeFeeSpentSats: "0",
    sameDomainCompetitorSuppressed: null,
    higherRankedCompetitorDomainCount: null,
    dedupedCompetitorDomainCount: null,
    competitivenessGateIndeterminate: null,
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
    lastEventAtUnixMs: null,
    lastError: null,
    note,
  };
}

async function waitForMiningProcessExit(
  pid: number,
  timeoutMs: number,
  sleepImpl: typeof sleep = sleep,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!await isProcessAlive(pid)) {
      return true;
    }

    await sleepImpl(Math.min(250, Math.max(timeoutMs, 1)));
  }

  return !await isProcessAlive(pid);
}

async function terminateMiningRuntimePid(options: {
  pid: number;
  shutdownGraceMs: number;
  sleepImpl?: typeof sleep;
}): Promise<boolean> {
  if (!await isProcessAlive(options.pid)) {
    return false;
  }

  try {
    process.kill(options.pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) {
      throw error;
    }
  }

  if (await waitForMiningProcessExit(options.pid, options.shutdownGraceMs, options.sleepImpl)) {
    return true;
  }

  try {
    process.kill(options.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) {
      throw error;
    }
  }

  if (await waitForMiningProcessExit(options.pid, options.shutdownGraceMs, options.sleepImpl)) {
    return true;
  }

  throw new Error("mining_process_stop_timeout");
}

async function takeOverMiningRuntime(options: {
  paths: WalletRuntimePaths;
  reason: string;
  clearControlLockFile?: boolean;
  controlLockMetadata?: Awaited<ReturnType<typeof readLockMetadata>>;
  requestMiningPreemption?: typeof requestMiningGenerationPreemption;
  shutdownGraceMs?: number;
  sleepImpl?: typeof sleep;
}): Promise<MiningRuntimeTakeoverResult> {
  const snapshot = await loadMiningRuntimeStatus(options.paths.miningStatusPath).catch(() => null);
  const controlLockMetadata = options.controlLockMetadata ?? (
    options.clearControlLockFile === true
      ? await readLockMetadata(options.paths.miningControlLockPath).catch(() => null)
      : null
  );
  const generationActivity = await readMiningGenerationActivity(options.paths).catch(() => null);
  const shutdownGraceMs = options.shutdownGraceMs ?? MINING_SHUTDOWN_GRACE_MS;
  const requestPreemption = options.requestMiningPreemption ?? requestMiningGenerationPreemption;
  const controlLockPid = normalizeMiningPid(controlLockMetadata?.processId);
  const backgroundWorkerPid = normalizeMiningPid(snapshot?.backgroundWorkerPid);
  const generationOwnerPid = normalizeMiningPid(generationActivity?.generationOwnerPid);
  const terminatedPids: number[] = [];
  const discoveredPids = new Set<number>();

  for (const pid of [controlLockPid, backgroundWorkerPid, generationOwnerPid]) {
    if (
      pid === null
      || pid === process.pid
      || discoveredPids.has(pid)
      || !await isProcessAlive(pid)
    ) {
      continue;
    }

    discoveredPids.add(pid);
  }

  const shouldPreemptGeneration = discoveredPids.size > 0 && (
    generationActivity?.generationActive === true
    || snapshot?.currentPhase === "generating"
    || snapshot?.currentPhase === "scoring"
  );

  const preemption = shouldPreemptGeneration
    ? await requestPreemption({
      paths: options.paths,
      reason: options.reason,
      timeoutMs: Math.min(shutdownGraceMs, 15_000),
    }).catch(() => null)
    : null;

  try {
    for (const pid of discoveredPids) {
      if (await terminateMiningRuntimePid({
        pid,
        shutdownGraceMs,
        sleepImpl: options.sleepImpl,
      })) {
        terminatedPids.push(pid);
      }
    }
  } finally {
    await preemption?.release().catch(() => undefined);
  }

  const controlLockCleared = options.clearControlLockFile === true
    ? await clearOrphanedFileLock(options.paths.miningControlLockPath, isProcessAlive).catch(() => false)
    : false;

  await rm(resolveMiningGenerationRequestPath(options.paths), { force: true }).catch(() => undefined);
  await rm(resolveMiningGenerationActivityPath(options.paths), { force: true }).catch(() => undefined);

  const walletRootId = snapshot?.walletRootId
    ?? (typeof controlLockMetadata?.walletRootId === "string" ? controlLockMetadata.walletRootId : null);

  if (snapshot !== null || walletRootId !== null || terminatedPids.length > 0 || controlLockCleared) {
    await saveMiningRuntimeStatus(
      options.paths.miningStatusPath,
      createStoppedMiningRuntimeSnapshotForTakeover({
        snapshot,
        walletRootId,
        nowUnixMs: Date.now(),
      }),
    );
  }

  return {
    controlLockCleared,
    replaced: terminatedPids.length > 0,
    snapshot,
    terminatedPids,
  };
}

async function acquireMiningStartControlLock(options: {
  paths: WalletRuntimePaths;
  purpose: string;
  takeoverReason: string;
  requestMiningPreemption?: typeof requestMiningGenerationPreemption;
  shutdownGraceMs?: number;
  sleepImpl?: typeof sleep;
}) {
  while (true) {
    try {
      return await acquireFileLock(options.paths.miningControlLockPath, {
        purpose: options.purpose,
      });
    } catch (error) {
      if (!(error instanceof FileLockBusyError)) {
        throw error;
      }

      if (error.existingMetadata?.processId === process.pid) {
        throw error;
      }

      const takeover = await takeOverMiningRuntime({
        paths: options.paths,
        reason: options.takeoverReason,
        clearControlLockFile: true,
        controlLockMetadata: error.existingMetadata,
        requestMiningPreemption: options.requestMiningPreemption,
        shutdownGraceMs: options.shutdownGraceMs,
        sleepImpl: options.sleepImpl,
      });

      if (!takeover.replaced && !takeover.controlLockCleared) {
        throw error;
      }
    }
  }
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
  let readContext: WalletReadContext | null = await options.openReadContext({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    secretProvider: options.provider,
    paths: options.paths,
  });
  let readContextClosed = false;

  try {
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
    throwIfMiningSuspendDetected(options.suspendDetector);
    const rpc = options.rpcFactory(service.rpc);
    const reconciliation = await reconcileLiveMiningState({
      state: readContext.localState.state,
      rpc,
      nodeBestHash: readContext.nodeStatus?.nodeBestHashHex ?? null,
      nodeBestHeight: readContext.nodeStatus?.nodeBestHeight ?? null,
      snapshotState: readContext.snapshot?.state ?? null,
    });
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

    if (effectiveReadContext.localState.state.miningState.state === "repair-required") {
      clearMiningProviderWait(options.loopState);
      await saveCycleStatus(effectiveReadContext, {
        runMode: options.runMode,
        currentPhase: "waiting",
        lastError: null,
        note: "Mining is blocked until the current mining publish is repaired or reconciled.",
      });
      return;
    }

    if (hasBlockingMutation(effectiveReadContext.localState.state)) {
      clearMiningProviderWait(options.loopState);
      const nextState = defaultMiningStatePatch(effectiveReadContext.localState.state, {
        state: "paused",
        pauseReason: "wallet-busy",
      });
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider: options.provider,
        paths: options.paths,
      });
      effectiveReadContext = {
        ...effectiveReadContext,
        localState: {
          ...effectiveReadContext.localState,
          availability: "ready",
          state: nextState,
        },
      };
      await saveCycleStatus(effectiveReadContext, {
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
      const nextState = defaultMiningStatePatch(effectiveReadContext.localState.state, {
        state: effectiveReadContext.localState.state.miningState.livePublishInMempool
          && effectiveReadContext.localState.state.miningState.state === "paused-stale"
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
        ...effectiveReadContext,
        localState: {
          ...effectiveReadContext.localState,
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
    throwIfMiningSuspendDetected(options.suspendDetector);
    const corePublishState = determineCorePublishState({
      blockchain: blockchainInfo,
      network: networkInfo,
      mempool: mempoolInfo,
    });
    clearRecoveredBitcoindError = resetMiningBitcoindRecoveryState(
      options.loopState,
      effectiveReadContext.nodeStatus?.serviceStatus ?? { pid: service.pid },
    );

    if (targetBlockHeight !== null && getBlockRewardCogtoshi(targetBlockHeight) === 0n) {
      clearMiningProviderWait(options.loopState);
      const nextState = defaultMiningStatePatch(effectiveReadContext.localState.state, {
        state: "paused",
        pauseReason: "zero-reward",
      });
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider: options.provider,
        paths: options.paths,
      });
      await saveCycleStatus({
        ...effectiveReadContext,
        localState: {
          ...effectiveReadContext.localState,
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
          referencedBlockHashDisplay: effectiveReadContext.nodeStatus?.nodeBestHashHex ?? null,
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
      readContext: effectiveReadContext as ReadyMiningReadContext,
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
      throwIfSuspendDetected: () => {
        throwIfMiningSuspendDetected(options.suspendDetector);
      },
    });
  } catch (error) {
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
        throwIfMiningSuspendDetected(suspendDetector);
      } catch (error) {
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
      await sleepImpl(Math.min(MINING_LOOP_INTERVAL_MS, MINING_STATUS_HEARTBEAT_INTERVAL_MS), options.signal);
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

async function waitForBackgroundHealthy(paths: WalletRuntimePaths): Promise<MiningRuntimeStatusV1 | null> {
  const deadline = Date.now() + BACKGROUND_START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath).catch(() => null);
    if (
      snapshot !== null
      && snapshot.runMode === "background"
      && snapshot.backgroundWorkerHealth === "healthy"
    ) {
      return snapshot;
    }
    await sleep(250);
  }

  return loadMiningRuntimeStatus(paths.miningStatusPath).catch(() => null);
}

export async function runForegroundMining(options: RunForegroundMiningOptions): Promise<void> {
  if (!options.prompter.isInteractive) {
    throw new Error("mine_requires_tty");
  }

  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const openReadContext = options.openReadContext ?? openWalletReadContext;
  const attachService = options.attachService ?? attachOrStartManagedBitcoindService;
  const rpcFactory = options.rpcFactory ?? createRpcClient as (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  const requestMiningPreemption = options.requestMiningPreemption ?? requestMiningGenerationPreemption;
  const runMiningLoopImpl = options.runMiningLoopImpl ?? runMiningLoop;
  const saveStopSnapshotImpl = options.saveStopSnapshotImpl ?? saveStopSnapshot;
  let visualizer: MiningFollowVisualizer | null = options.visualizer ?? null;
  const ownsVisualizer = visualizer === null;

  const setupReady = options.builtInSetupEnsured === true
    ? true
    : await ensureBuiltInMiningSetupIfNeeded({
      provider,
      prompter: options.prompter,
      paths,
    });
  if (!setupReady) {
    throw new Error("Built-in mining provider is not configured. Run `cogcoin mine setup`.");
  }

  const controlLock = await acquireMiningStartControlLock({
    paths,
    purpose: "mine-foreground",
    takeoverReason: "mine-foreground-replace",
    requestMiningPreemption,
    shutdownGraceMs: options.shutdownGraceMs,
    sleepImpl: options.sleepImpl,
  });
  const abortController = new AbortController();
  const abortListener = () => {
    abortController.abort();
  };
  const handleSigint = () => abortController.abort();
  const handleSigterm = () => abortController.abort();

  try {
    await takeOverMiningRuntime({
      paths,
      reason: "mine-foreground-replace",
      requestMiningPreemption,
      shutdownGraceMs: options.shutdownGraceMs,
      sleepImpl: options.sleepImpl,
    });

    if (visualizer === null) {
      visualizer = new MiningFollowVisualizer({
        clientVersion: options.clientVersion,
        updateAvailable: options.updateAvailable,
        progressOutput: options.progressOutput ?? "auto",
        stream: options.stderr,
      });
    }

    options.signal?.addEventListener("abort", abortListener, { once: true });
    process.on("SIGINT", handleSigint);
    process.on("SIGTERM", handleSigterm);

    await runMiningLoopImpl({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      provider,
      paths,
      runMode: "foreground",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      signal: abortController.signal,
      fetchImpl: options.fetchImpl,
      openReadContext,
      attachService,
      rpcFactory,
      stdout: options.stdout,
      visualizer,
    });
    await saveStopSnapshotImpl({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      provider,
      paths,
      runMode: "foreground",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      note: "Foreground mining stopped cleanly.",
    });
  } finally {
    options.signal?.removeEventListener("abort", abortListener);
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    if (ownsVisualizer) {
      visualizer?.close();
    }
    await controlLock.release();
  }
}

export async function startBackgroundMining(options: StartBackgroundMiningOptions): Promise<MiningStartResult> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const requestMiningPreemption = options.requestMiningPreemption ?? requestMiningGenerationPreemption;
  const spawnWorkerProcess = options.spawnWorkerProcess ?? spawn;
  const waitForBackgroundHealthyImpl = options.waitForBackgroundHealthyImpl ?? waitForBackgroundHealthy;
  const setupReady = options.builtInSetupEnsured === true
    ? true
    : await ensureBuiltInMiningSetupIfNeeded({
      provider,
      prompter: options.prompter,
      paths,
    });
  if (!setupReady) {
    throw new Error("Built-in mining provider is not configured. Run `cogcoin mine setup`.");
  }

  let controlLock;
  try {
    controlLock = await acquireMiningStartControlLock({
      paths,
      purpose: "mine-start",
      takeoverReason: "mine-start-replace",
      requestMiningPreemption,
      shutdownGraceMs: options.shutdownGraceMs,
      sleepImpl: options.sleepImpl,
    });
  } catch (error) {
    if (error instanceof FileLockBusyError && error.existingMetadata?.processId === process.pid) {
      return {
        started: false,
        snapshot: await loadMiningRuntimeStatus(paths.miningStatusPath).catch(() => null),
      };
    }
    throw error;
  }

  try {
    await takeOverMiningRuntime({
      paths,
      reason: "mine-start-replace",
      requestMiningPreemption,
      shutdownGraceMs: options.shutdownGraceMs,
      sleepImpl: options.sleepImpl,
    });

    const runId = randomBytes(16).toString("hex");
    const workerMainPath = fileURLToPath(new URL("./worker-main.js", import.meta.url));
    const child = spawnWorkerProcess(process.execPath, [
      workerMainPath,
      `--data-dir=${options.dataDir}`,
      `--database-path=${options.databasePath}`,
      `--run-id=${runId}`,
    ], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    const snapshot = await waitForBackgroundHealthyImpl(paths);

    return {
      started: true,
      snapshot,
    };
  } finally {
    await controlLock.release();
  }
}

export async function stopBackgroundMining(options: StopBackgroundMiningOptions): Promise<MiningRuntimeStatusV1 | null> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const controlLock = await acquireFileLock(paths.miningControlLockPath, {
    purpose: "mine-stop",
  });

  try {
    const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath).catch(() => null);
    if (snapshot === null || snapshot.runMode !== "background" || snapshot.backgroundWorkerPid === null) {
      return snapshot;
    }

    const preemption = await requestMiningGenerationPreemption({
      paths,
      reason: "mine-stop",
      timeoutMs: Math.min(MINING_SHUTDOWN_GRACE_MS, 15_000),
    }).catch(() => null);

    process.kill(snapshot.backgroundWorkerPid, "SIGTERM");
    const deadline = Date.now() + MINING_SHUTDOWN_GRACE_MS;

    while (Date.now() < deadline) {
      try {
        process.kill(snapshot.backgroundWorkerPid, 0);
        await sleep(250);
      } catch (error) {
        if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") {
          break;
        }
      }
    }

    try {
      process.kill(snapshot.backgroundWorkerPid, "SIGKILL");
    } catch {
      // ignore
    }

    await saveStopSnapshot({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      provider,
      paths,
      runMode: "background",
      backgroundWorkerPid: snapshot.backgroundWorkerPid,
      backgroundWorkerRunId: snapshot.backgroundWorkerRunId,
      note: snapshot.livePublishInMempool
        ? "Background mining stopped. The last mining transaction may still confirm from mempool."
        : "Background mining stopped.",
    });
    await preemption?.release().catch(() => undefined);
    return loadMiningRuntimeStatus(paths.miningStatusPath);
  } finally {
    await controlLock.release();
  }
}

export async function runBackgroundMiningWorker(options: RunnerDependencies & {
  dataDir: string;
  databasePath: string;
  runId: string;
  provider?: WalletSecretProvider;
  paths?: WalletRuntimePaths;
}): Promise<void> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const openReadContext = options.openReadContext ?? openWalletReadContext;
  const attachService = options.attachService ?? attachOrStartManagedBitcoindService;
  const rpcFactory = options.rpcFactory ?? createRpcClient as (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  const abortController = new AbortController();

  process.on("SIGINT", () => abortController.abort());
  process.on("SIGTERM", () => abortController.abort());

  const initialContext = await openReadContext({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    secretProvider: provider,
    paths,
  });

  try {
    const initialView = await inspectMiningControlPlane({
      provider,
      localState: initialContext.localState,
      bitcoind: initialContext.bitcoind,
      nodeStatus: initialContext.nodeStatus,
      nodeHealth: initialContext.nodeHealth,
      indexer: initialContext.indexer,
      paths,
    });
    await saveMiningRuntimeStatus(paths.miningStatusPath, {
      ...initialView.runtime,
      walletRootId: initialContext.localState.walletRootId,
      workerApiVersion: MINING_WORKER_API_VERSION,
      workerBinaryVersion: process.version,
      workerBuildId: options.runId,
      runMode: "background",
      backgroundWorkerPid: process.pid,
      backgroundWorkerRunId: options.runId,
      backgroundWorkerHeartbeatAtUnixMs: Date.now(),
      currentPhase: "idle",
      updatedAtUnixMs: Date.now(),
    });
  } finally {
    await initialContext.close();
  }

  await runMiningLoop({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    provider,
    paths,
    runMode: "background",
    backgroundWorkerPid: process.pid,
    backgroundWorkerRunId: options.runId,
    signal: abortController.signal,
    fetchImpl: options.fetchImpl,
    openReadContext,
    attachService,
    rpcFactory,
  });
  await saveStopSnapshot({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    provider,
    paths,
    runMode: "background",
    backgroundWorkerPid: process.pid,
    backgroundWorkerRunId: options.runId,
    note: "Background mining worker stopped cleanly.",
  });
}

export async function takeOverMiningRuntimeForTesting(options: {
  paths: WalletRuntimePaths;
  reason: string;
  clearControlLockFile?: boolean;
  controlLockMetadata?: Awaited<ReturnType<typeof readLockMetadata>>;
  requestMiningPreemption?: typeof requestMiningGenerationPreemption;
  shutdownGraceMs?: number;
  sleepImpl?: typeof sleep;
}): Promise<MiningRuntimeTakeoverResult> {
  return await takeOverMiningRuntime(options);
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
