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
  MINING_NETWORK_SETTLE_WINDOW_MS,
  MINING_PROVIDER_BACKOFF_BASE_MS,
  MINING_PROVIDER_BACKOFF_MAX_MS,
  MINING_SHUTDOWN_GRACE_MS,
  MINING_STATUS_HEARTBEAT_INTERVAL_MS,
  MINING_SUSPEND_GAP_THRESHOLD_MS,
  MINING_TIP_SETTLE_WINDOW_MS,
  MINING_WORKER_API_VERSION,
} from "./constants.js";
import { inspectMiningControlPlane, setupBuiltInMining } from "./control.js";
import {
  applyMiningRuntimeStatusOverrides,
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
import { livePublishTargetsCandidateTip as livePublishTargetsCandidateTipModule } from "./engine-state.js";
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
  createEmptyMiningFollowVisualizerState,
  type MiningFollowVisualizerState,
  type MiningProvisionalSentenceEntry,
  type MiningSentenceBoardEntry,
  type MiningRecentWinSummary,
  MiningFollowVisualizer,
} from "./visualizer.js";

const BEST_BLOCK_POLL_INTERVAL_MS = 500;
const BACKGROUND_START_TIMEOUT_MS = 15_000;
const MINING_BITCOIN_RECOVERY_GRACE_MS = 15_000;
const MINING_BITCOIN_RECOVERY_RESTART_COOLDOWN_MS = 60_000;
const MINING_SUSPEND_HEARTBEAT_INTERVAL_MS = 1_000;
const MINING_MEMPOOL_COOPERATIVE_YIELD_EVERY = 25;
const MINING_BITCOIN_RECOVERY_NOTE =
  "Mining lost contact with the local Bitcoin RPC service and is waiting for it to recover.";

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

interface CachedCompetitorEntry {
  txid: string;
  effectiveFeeRate: number;
  domainId: number;
  domainName: string;
  sentence: string;
  senderScriptHex: string;
  encodedSentenceBytesHex: string;
  bip39WordIndices: number[];
  canonicalBlend: bigint;
}

interface IndexerTruthKey {
  walletRootId: string;
  daemonInstanceId: string;
  snapshotSeq: string;
}

interface CachedMempoolTxContext {
  txid: string;
  effectiveFeeRate: number;
  senderScriptHex: string | null;
  rawTransaction: Awaited<ReturnType<MiningRpcClient["getRawTransaction"]>>;
  payload: Uint8Array | null;
}

interface MiningCompetitivenessCacheRecord {
  indexerDaemonInstanceId: string;
  indexerSnapshotSeq: string;
  referencedBlockHashDisplay: string;
  localAssayTupleKey: string;
  excludedTxidsKey: string;
  mempoolSequence: string;
  txids: string[];
  txContexts: Map<string, CachedMempoolTxContext>;
  decision: CompetitivenessDecision;
}

function resolveSettledWinnerRequiredWords(options: {
  domainId: number;
  bip39WordIndices?: readonly number[] | null;
  snapshotTipPreviousHashHex?: string | null;
}): readonly string[] {
  const storedWords = resolveBip39WordsFromIndices(options.bip39WordIndices);

  if (storedWords.length > 0) {
    return storedWords;
  }

  if (
    options.snapshotTipPreviousHashHex === null
    || options.snapshotTipPreviousHashHex === undefined
    || !Number.isInteger(options.domainId)
    || options.domainId <= 0
  ) {
    return [];
  }

  return resolveBip39WordsFromIndices(
    deriveMiningWordIndices(
      Buffer.from(displayToInternalBlockhash(options.snapshotTipPreviousHashHex), "hex"),
      options.domainId,
    ),
  );
}

interface RankedMiningSentenceEntry {
  domainId: number;
  domainName: string;
  sentence: string;
  canonicalBlend: bigint;
  senderScriptHex: string;
  encodedSentenceBytesHex: string;
  bip39WordIndices: number[];
  txid: string | null;
  txIndex: number;
}

interface MiningLoopState {
  attemptedTipKey: string | null;
  currentTipKey: string | null;
  selectedCandidateTipKey: string | null;
  selectedCandidate: MiningCandidate | null;
  ui: MiningFollowVisualizerState;
  waitingNote: string | null;
  providerWaitState: "backoff" | "rate-limited" | "auth-error" | "not-found" | null;
  providerWaitLastError: string | null;
  providerWaitNextRetryAtUnixMs: number | null;
  providerTransientFailureCount: number;
  bitcoinRecoveryFirstFailureAtUnixMs: number | null;
  bitcoinRecoveryFirstUnreachableAtUnixMs: number | null;
  bitcoinRecoveryLastRestartAttemptAtUnixMs: number | null;
  bitcoinRecoveryServiceInstanceId: string | null;
  bitcoinRecoveryProcessId: number | null;
  reconnectSettledUntilUnixMs: number | null;
  tipSettledUntilUnixMs: number | null;
}

interface MiningSuspendDetector {
  lastHeartbeatMonotonicMs: number;
  detectedAtUnixMs: number | null;
  monotonicNow: () => number;
  nowUnixMs: () => number;
  stop(): void;
}

interface MiningBitcoindRecoveryIdentity {
  serviceInstanceId: string | null;
  processId: number | null;
}

interface MiningSuspendHeartbeatHandle {
  clear(): void;
}

interface MiningSuspendScheduler {
  every(intervalMs: number, callback: () => void): MiningSuspendHeartbeatHandle;
}

function resolveMiningProviderBackoffDelayMs(consecutiveFailureCount: number): number {
  const exponent = Math.max(consecutiveFailureCount - 1, 0);
  return Math.min(MINING_PROVIDER_BACKOFF_BASE_MS * (2 ** exponent), MINING_PROVIDER_BACKOFF_MAX_MS);
}

function clearMiningProviderWait(
  loopState: MiningLoopState,
  resetTransientFailureCount = true,
): void {
  loopState.providerWaitState = null;
  loopState.providerWaitLastError = null;
  loopState.providerWaitNextRetryAtUnixMs = null;
  if (resetTransientFailureCount) {
    loopState.providerTransientFailureCount = 0;
  }
}

function recordTransientMiningProviderWait(options: {
  loopState: MiningLoopState;
  error: MiningProviderRequestError;
  nowUnixMs: number;
}): void {
  options.loopState.providerTransientFailureCount += 1;
  options.loopState.providerWaitState = options.error.providerState === "rate-limited"
    ? "rate-limited"
    : "backoff";
  options.loopState.providerWaitLastError = options.error.message;
  options.loopState.providerWaitNextRetryAtUnixMs = options.nowUnixMs
    + resolveMiningProviderBackoffDelayMs(options.loopState.providerTransientFailureCount);
}

function recordTerminalMiningProviderWait(options: {
  loopState: MiningLoopState;
  error: MiningProviderRequestError;
}): void {
  clearMiningProviderWait(options.loopState);
  if (options.error.providerState !== "auth-error" && options.error.providerState !== "not-found") {
    throw new Error("mining_provider_wait_state_invalid");
  }
  options.loopState.providerWaitState = options.error.providerState;
  options.loopState.providerWaitLastError = options.error.message;
}

function isTransientMiningProviderError(error: MiningProviderRequestError): boolean {
  return error.providerState === "unavailable" || error.providerState === "rate-limited";
}

class MiningSuspendDetectedError extends Error {
  readonly detectedAtUnixMs: number;

  constructor(detectedAtUnixMs: number) {
    super("mining_runtime_resumed");
    this.detectedAtUnixMs = detectedAtUnixMs;
  }
}

class MiningPublishRejectedError extends Error {
  readonly revertedState: WalletStateV1;

  constructor(message: string, revertedState: WalletStateV1) {
    super(message);
    this.name = "MiningPublishRejectedError";
    this.revertedState = revertedState;
  }
}

interface OverlayDomainState {
  domainId: number;
  name: string | null;
  anchored: boolean;
  ownerScriptHex: string | null;
  delegateScriptHex: string | null;
  minerScriptHex: string | null;
}

type SupportedAncestorOperation =
  | { kind: "domain-reg"; name: string; senderScriptHex: string | null }
  | { kind: "domain-transfer"; domainId: number; recipientScriptHex: string; senderScriptHex: string | null }
  | { kind: "domain-anchor"; domainId: number; senderScriptHex: string | null }
  | { kind: "set-delegate"; domainId: number; delegateScriptHex: string | null }
  | { kind: "set-miner"; domainId: number; minerScriptHex: string | null };

const miningGateCache = new Map<string, MiningCompetitivenessCacheRecord>();

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

function defaultMiningCooperativeYield(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function maybeYieldDuringMempoolScan(options: {
  iteration: number;
  cooperativeYield?: MiningCooperativeYield;
  cooperativeYieldEvery?: number;
}): Promise<void> {
  const yieldEvery = options.cooperativeYieldEvery ?? MINING_MEMPOOL_COOPERATIVE_YIELD_EVERY;
  if (yieldEvery <= 0 || options.iteration === 0 || (options.iteration % yieldEvery) !== 0) {
    return;
  }

  await (options.cooperativeYield ?? defaultMiningCooperativeYield)();
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

function cloneMiningState(state: MiningStateRecord): MiningStateRecord {
  const normalized = normalizeMiningStateRecord(state);
  return {
    ...normalized,
    currentBip39WordIndices: normalized.currentBip39WordIndices === null ? null : [...normalized.currentBip39WordIndices],
    sharedMiningConflictOutpoint: normalized.sharedMiningConflictOutpoint === null
      ? null
      : { ...normalized.sharedMiningConflictOutpoint },
  };
}

function hasBlockingMutation(state: WalletStateV1): boolean {
  return (state.pendingMutations ?? []).some((mutation) =>
    mutation.status === "draft"
    || mutation.status === "broadcasting"
    || mutation.status === "broadcast-unknown"
    || mutation.status === "live"
    || mutation.status === "repair-required"
  );
}

function outpointKey(outpoint: OutpointRecord | null): string | null {
  return outpoint === null ? null : `${outpoint.txid}:${outpoint.vout}`;
}

function satsToBtc(value: bigint): number {
  return Number(value) / 100_000_000;
}

function createMiningLoopState(): MiningLoopState {
  return {
    attemptedTipKey: null,
    currentTipKey: null,
    selectedCandidateTipKey: null,
    selectedCandidate: null,
    ui: createEmptyMiningFollowVisualizerState(),
    waitingNote: null,
    providerWaitState: null,
    providerWaitLastError: null,
    providerWaitNextRetryAtUnixMs: null,
    providerTransientFailureCount: 0,
    bitcoinRecoveryFirstFailureAtUnixMs: null,
    bitcoinRecoveryFirstUnreachableAtUnixMs: null,
    bitcoinRecoveryLastRestartAttemptAtUnixMs: null,
    bitcoinRecoveryServiceInstanceId: null,
    bitcoinRecoveryProcessId: null,
    reconnectSettledUntilUnixMs: null,
    tipSettledUntilUnixMs: null,
  };
}

export function createMiningLoopStateForTesting(): MiningLoopState {
  return createMiningLoopState();
}

function expireMiningSettleWindows(loopState: MiningLoopState, nowUnixMs: number): void {
  if (
    loopState.reconnectSettledUntilUnixMs !== null
    && loopState.reconnectSettledUntilUnixMs <= nowUnixMs
  ) {
    loopState.reconnectSettledUntilUnixMs = null;
  }

  if (
    loopState.tipSettledUntilUnixMs !== null
    && loopState.tipSettledUntilUnixMs <= nowUnixMs
  ) {
    loopState.tipSettledUntilUnixMs = null;
  }
}

function setMiningReconnectSettleWindow(loopState: MiningLoopState, nowUnixMs: number): void {
  loopState.reconnectSettledUntilUnixMs = nowUnixMs + MINING_NETWORK_SETTLE_WINDOW_MS;
}

function setMiningTipSettleWindow(loopState: MiningLoopState, nowUnixMs: number): void {
  loopState.tipSettledUntilUnixMs = nowUnixMs + MINING_TIP_SETTLE_WINDOW_MS;
}

function buildMiningSettleWindowStatusOverrides(
  loopState: MiningLoopState,
  nowUnixMs: number,
): Pick<MiningRunnerStatusOverrides, "reconnectSettledUntilUnixMs" | "tipSettledUntilUnixMs"> {
  expireMiningSettleWindows(loopState, nowUnixMs);
  return {
    reconnectSettledUntilUnixMs: loopState.reconnectSettledUntilUnixMs,
    tipSettledUntilUnixMs: loopState.tipSettledUntilUnixMs,
  };
}

function buildMiningTipKey(bestBlockHash: string | null, targetBlockHeight: number | null): string | null {
  if (bestBlockHash === null || targetBlockHeight === null) {
    return null;
  }

  return `${bestBlockHash}:${targetBlockHeight}`;
}

function resetMiningUiForTip(loopState: MiningLoopState, targetBlockHeight: number | null): void {
  const preservedTxid = loopState.ui.latestTxid;
  const preservedFundingAddress = loopState.ui.fundingAddress;

  loopState.ui = {
    ...createEmptyMiningFollowVisualizerState(),
    fundingAddress: preservedFundingAddress,
    latestTxid: preservedTxid,
  };
  loopState.selectedCandidateTipKey = null;
  loopState.selectedCandidate = null;
  loopState.waitingNote = null;
}

export function resetMiningUiForTipForTesting(loopState: MiningLoopState, targetBlockHeight: number | null): void {
  resetMiningUiForTip(loopState, targetBlockHeight);
}

function resolveProvisionalBroadcastTxidForCandidate(options: {
  candidate: MiningCandidate;
  liveState: MiningStateRecord | null | undefined;
}): string | null {
  if (options.liveState === null || options.liveState === undefined) {
    return null;
  }

  const liveState = normalizeMiningStateRecord(options.liveState);
  if (
    liveState.currentTxid === null
    || liveState.currentPublishState !== "in-mempool"
    || liveState.livePublishInMempool !== true
  ) {
    return null;
  }

  if (
    liveState.currentDomain !== options.candidate.domainName
    || liveState.currentDomainId !== options.candidate.domainId
    || liveState.currentSentence !== options.candidate.sentence
    || liveState.currentBlockTargetHeight !== options.candidate.targetBlockHeight
    || liveState.currentReferencedBlockHashDisplay !== options.candidate.referencedBlockHashDisplay
  ) {
    return null;
  }

  return liveState.currentTxid;
}

function fallbackSettledWinnerDomainName(domainId: number): string {
  return `domain-${domainId}`;
}

function resolveCurrentMinedBlockBoard(options: {
  snapshotState: NonNullable<WalletReadContext["snapshot"]>["state"] | null | undefined;
  snapshotTipHeight: number | null;
  snapshotTipPreviousHashHex: string | null;
  nodeBestHeight: number | null;
}): {
  settledBlockHeight: number | null;
  settledBoardEntries: MiningSentenceBoardEntry[];
} {
  const settledBlockHeight = options.snapshotTipHeight ?? null;

  if (settledBlockHeight === null) {
    return {
      settledBlockHeight,
      settledBoardEntries: [],
    };
  }

  if (options.snapshotState === null || options.snapshotState === undefined) {
    return {
      settledBlockHeight,
      settledBoardEntries: [],
    };
  }

  const settledBoardEntries = (getBlockWinners(options.snapshotState, settledBlockHeight) ?? [])
    .slice()
    .sort((left, right) => left.rank - right.rank || left.txIndex - right.txIndex)
    .slice(0, 5)
    .map((winner) => ({
      rank: winner.rank,
      domainName: lookupDomainById(options.snapshotState!, winner.domainId)?.name ?? fallbackSettledWinnerDomainName(winner.domainId),
      sentence: winner.sentenceText ?? "[unavailable]",
      requiredWords: resolveSettledWinnerRequiredWords({
        domainId: winner.domainId,
        bip39WordIndices: (winner as typeof winner & { bip39WordIndices?: number[] }).bip39WordIndices,
        snapshotTipPreviousHashHex: options.snapshotTipPreviousHashHex,
      }),
    }));

  return {
    settledBlockHeight,
    settledBoardEntries,
  };
}

export function resolveSettledBoardForTesting(options: {
  snapshotState: NonNullable<WalletReadContext["snapshot"]>["state"] | null | undefined;
  snapshotTipHeight: number | null;
  snapshotTipPreviousHashHex?: string | null;
  nodeBestHeight: number | null;
}): {
  settledBlockHeight: number | null;
  settledBoardEntries: MiningSentenceBoardEntry[];
} {
  return resolveCurrentMinedBlockBoard({
    ...options,
    snapshotTipPreviousHashHex: options.snapshotTipPreviousHashHex ?? null,
  });
}

function syncMiningUiSettledBoard(
  loopState: MiningLoopState,
  snapshotState: NonNullable<WalletReadContext["snapshot"]>["state"] | null | undefined,
  snapshotTipHeight: number | null,
  snapshotTipPreviousHashHex: string | null,
): void {
  const settledBoard = resolveCurrentMinedBlockBoard({
    snapshotState,
    snapshotTipHeight,
    snapshotTipPreviousHashHex,
    nodeBestHeight: null,
  });
  loopState.ui.settledBlockHeight = settledBoard.settledBlockHeight;
  loopState.ui.settledBoardEntries = settledBoard.settledBoardEntries;
}

function syncMiningUiForCurrentTip(options: {
  loopState: MiningLoopState;
  snapshotState: NonNullable<WalletReadContext["snapshot"]>["state"] | null | undefined;
  snapshotTipHeight: number | null;
  snapshotTipPreviousHashHex: string | null;
  nodeBestHeight: number | null;
  nodeBestHash: string | null;
  recentWin: MiningRecentWinSummary | null;
}): {
  targetBlockHeight: number | null;
  tipKey: string | null;
  tipChanged: boolean;
} {
  const targetBlockHeight = options.nodeBestHeight === null
    ? null
    : options.nodeBestHeight + 1;
  const tipKey = buildMiningTipKey(options.nodeBestHash, targetBlockHeight);
  const priorTipKey = options.loopState.currentTipKey;
  const tipChanged = tipKey !== null && tipKey !== priorTipKey;

  if (tipKey !== priorTipKey) {
    options.loopState.currentTipKey = tipKey;
    resetMiningUiForTip(options.loopState, targetBlockHeight);

    if (options.recentWin !== null) {
      options.loopState.ui.recentWin = options.recentWin;
    }
  }

  syncMiningUiSettledBoard(
    options.loopState,
    options.snapshotState,
    options.snapshotTipHeight,
    options.snapshotTipPreviousHashHex,
  );

  return {
    targetBlockHeight,
    tipKey,
    tipChanged,
  };
}

function setMiningUiCandidate(
  loopState: MiningLoopState,
  candidate: MiningCandidate,
  liveState?: MiningStateRecord | null,
): void {
  loopState.ui.latestSentence = candidate.sentence;
  loopState.ui.provisionalRequiredWords = [...candidate.bip39Words];
  loopState.ui.provisionalEntry = {
    domainName: candidate.domainName,
    sentence: candidate.sentence,
  };
  loopState.ui.provisionalBroadcastTxid = resolveProvisionalBroadcastTxidForCandidate({
    candidate,
    liveState,
  });
}

function getSelectedCandidateForTip(loopState: MiningLoopState, tipKey: string | null): MiningCandidate | null {
  if (tipKey === null || loopState.selectedCandidateTipKey !== tipKey) {
    return null;
  }

  return loopState.selectedCandidate;
}

export function getSelectedCandidateForTipForTesting(
  loopState: MiningLoopState,
  tipKey: string | null,
): MiningCandidate | null {
  return getSelectedCandidateForTip(loopState, tipKey);
}

function cacheSelectedCandidateForTip(
  loopState: MiningLoopState,
  tipKey: string | null,
  candidate: MiningCandidate,
  liveState?: MiningStateRecord | null,
): void {
  loopState.selectedCandidateTipKey = tipKey;
  loopState.selectedCandidate = candidate;
  setMiningUiCandidate(loopState, candidate, liveState);
}

export function cacheSelectedCandidateForTipForTesting(
  loopState: MiningLoopState,
  tipKey: string | null,
  candidate: MiningCandidate,
  liveState?: MiningStateRecord | null,
): void {
  cacheSelectedCandidateForTip(loopState, tipKey, candidate, liveState);
}

function clearSelectedCandidate(loopState: MiningLoopState): void {
  loopState.selectedCandidateTipKey = null;
  loopState.selectedCandidate = null;
}

function clearMiningUiTransientCandidate(loopState: MiningLoopState): void {
  loopState.ui.provisionalRequiredWords = [];
  loopState.ui.provisionalEntry = {
    domainName: null,
    sentence: null,
  };
  loopState.ui.provisionalBroadcastTxid = null;
  loopState.ui.latestSentence = null;
}

function discardMiningLoopTransientWork(
  loopState: MiningLoopState,
  walletRootId: string | null | undefined,
): void {
  clearMiningGateCache(walletRootId);
  clearSelectedCandidate(loopState);
  clearMiningUiTransientCandidate(loopState);
  loopState.waitingNote = null;
  clearMiningProviderWait(loopState);
}

function resolveMiningBitcoindRecoveryIdentity(
  value:
    | {
      serviceInstanceId?: string | null;
      processId?: number | null;
    }
    | {
      pid?: number | null;
    }
    | null
    | undefined,
): MiningBitcoindRecoveryIdentity {
  const raw = (value ?? {}) as {
    serviceInstanceId?: string | null;
    processId?: number | null;
    pid?: number | null;
  };

  return {
    serviceInstanceId: raw.serviceInstanceId ?? null,
    processId: raw.processId ?? raw.pid ?? null,
  };
}

function miningBitcoindRecoveryIdentityMatches(
  left: MiningBitcoindRecoveryIdentity,
  right: MiningBitcoindRecoveryIdentity,
): boolean {
  if (left.serviceInstanceId !== null && right.serviceInstanceId !== null) {
    return left.serviceInstanceId === right.serviceInstanceId;
  }

  if (left.processId !== null && right.processId !== null) {
    return left.processId === right.processId;
  }

  return false;
}

function rememberMiningBitcoindRecoveryIdentity(
  loopState: MiningLoopState,
  value:
    | {
      serviceInstanceId?: string | null;
      processId?: number | null;
    }
    | {
      pid?: number | null;
    }
    | null
    | undefined,
): boolean {
  const next = resolveMiningBitcoindRecoveryIdentity(value);
  if (next.serviceInstanceId === null && next.processId === null) {
    return false;
  }

  const previous: MiningBitcoindRecoveryIdentity = {
    serviceInstanceId: loopState.bitcoinRecoveryServiceInstanceId,
    processId: loopState.bitcoinRecoveryProcessId,
  };
  const changed = (
    previous.serviceInstanceId !== null
    || previous.processId !== null
  ) && !miningBitcoindRecoveryIdentityMatches(previous, next);

  loopState.bitcoinRecoveryServiceInstanceId = next.serviceInstanceId ?? (
    next.processId !== null && previous.processId === next.processId
      ? previous.serviceInstanceId
      : null
  );
  loopState.bitcoinRecoveryProcessId = next.processId ?? (
    next.serviceInstanceId !== null && previous.serviceInstanceId === next.serviceInstanceId
      ? previous.processId
      : null
  );

  return changed;
}

function resetMiningBitcoindRecoveryState(
  loopState: MiningLoopState,
  value?:
    | {
      serviceInstanceId?: string | null;
      processId?: number | null;
    }
    | {
      pid?: number | null;
    }
    | null,
): boolean {
  const hadRecovery = loopState.bitcoinRecoveryFirstFailureAtUnixMs !== null;
  loopState.bitcoinRecoveryFirstFailureAtUnixMs = null;
  loopState.bitcoinRecoveryFirstUnreachableAtUnixMs = null;
  loopState.bitcoinRecoveryLastRestartAttemptAtUnixMs = null;
  if (value !== undefined) {
    rememberMiningBitcoindRecoveryIdentity(loopState, value);
  }
  return hadRecovery;
}

function isMiningBitcoindRecoveryPidAlive(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }

    return false;
  }
}

function describeRecoverableMiningBitcoindError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecoverableMiningBitcoindError(error: unknown): boolean {
  if (isRetryableManagedRpcError(error)) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  if ("code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET") {
      return true;
    }
  }

  return error.message === "managed_bitcoind_service_start_timeout"
    || error.message === "bitcoind_cookie_timeout"
    || error.message.includes("cookie file is unavailable")
    || error.message.includes("cookie file could not be read")
    || error.message.includes("ECONNREFUSED")
    || error.message.includes("ECONNRESET")
    || error.message.includes("socket hang up");
}

async function attachManagedBitcoindForRecovery(options: {
  dataDir: string;
  walletRootId: string | undefined;
  attachService: typeof attachOrStartManagedBitcoindService;
  loopState: MiningLoopState;
}): Promise<boolean> {
  try {
    const service = await options.attachService({
      dataDir: options.dataDir,
      chain: "main",
      startHeight: 0,
      walletRootId: options.walletRootId,
    });
    const serviceStatus = await service.refreshServiceStatus?.().catch(() => null);
    rememberMiningBitcoindRecoveryIdentity(
      options.loopState,
      serviceStatus ?? { pid: service.pid },
    );
    return true;
  } catch (error) {
    if (!isRecoverableMiningBitcoindError(error)) {
      throw error;
    }

    return false;
  }
}

async function resolveFundingDisplaySats(state: WalletStateV1, rpc: MiningRpcClient): Promise<bigint> {
  const utxos = await rpc.listUnspent(state.managedCoreWallet.walletName, 0);

  return utxos.reduce((sum, entry) => {
    if (
      entry.scriptPubKey !== state.funding.scriptPubKeyHex
      || entry.spendable === false
    ) {
      return sum;
    }

    return sum + numberToSats(entry.amount);
  }, 0n);
}

export async function resolveFundingDisplaySatsForTesting(state: WalletStateV1, rpc: MiningRpcClient): Promise<bigint> {
  return resolveFundingDisplaySats(state, rpc);
}

async function loadMiningVisibleFollowBlockTimes(options: {
  rpc: MiningRpcClient;
  indexedTipHeight: number | null;
  indexedTipHashHex: string | null;
}): Promise<Record<number, number>> {
  if (options.indexedTipHeight === null || options.indexedTipHashHex === null) {
    return {};
  }

  const blockTimesByHeight: Record<number, number> = {};
  let currentHeight = options.indexedTipHeight;
  let currentHashHex: string | null = options.indexedTipHashHex;

  for (let offset = 0; offset <= FOLLOW_VISIBLE_PRIOR_BLOCKS; offset += 1) {
    if (currentHeight < 0 || currentHashHex === null) {
      break;
    }

    const block = await options.rpc.getBlock(currentHashHex);

    if (typeof block.time === "number") {
      blockTimesByHeight[currentHeight] = block.time;
    }

    currentHashHex = block.previousblockhash ?? null;
    currentHeight -= 1;
  }

  return blockTimesByHeight;
}

export async function loadMiningVisibleFollowBlockTimesForTesting(options: {
  rpc: MiningRpcClient;
  indexedTipHeight: number | null;
  indexedTipHashHex: string | null;
}): Promise<Record<number, number>> {
  return loadMiningVisibleFollowBlockTimes(options);
}

function syncMiningVisualizerBalances(
  loopState: MiningLoopState,
  readContext: WalletReadContext & { localState: { availability: "ready"; state: WalletStateV1 } },
  balanceSats: bigint | null,
): void {
  loopState.ui.fundingAddress = readContext.model?.walletAddress ?? readContext.localState.state.funding.address;
  loopState.ui.balanceCogtoshi = readContext.snapshot === null
    ? null
    : getBalance(readContext.snapshot.state, readContext.localState.state.funding.scriptPubKeyHex);
  loopState.ui.balanceSats = balanceSats;
}

function createIndexedMiningFollowVisualizerState(
  readContext: WalletReadContext,
): MiningFollowVisualizerState {
  const uiState = createEmptyMiningFollowVisualizerState();
  const localState = readContext.localState;
  const settledBoard = resolveCurrentMinedBlockBoard({
    snapshotState: readContext.snapshot?.state ?? null,
    snapshotTipHeight: readContext.snapshot?.tip?.height ?? readContext.indexer.snapshotTip?.height ?? null,
    snapshotTipPreviousHashHex: readContext.snapshot?.tip?.previousHashHex ?? readContext.indexer.snapshotTip?.previousHashHex ?? null,
    nodeBestHeight: readContext.nodeStatus?.nodeBestHeight ?? null,
  });

  uiState.settledBlockHeight = settledBoard.settledBlockHeight;
  uiState.settledBoardEntries = settledBoard.settledBoardEntries;
  if (localState.availability === "ready" && localState.state !== null) {
    uiState.fundingAddress = readContext.model?.walletAddress ?? localState.state.funding.address;
  }

  if (readContext.snapshot !== null && localState.availability === "ready" && localState.state !== null) {
    uiState.balanceCogtoshi = getBalance(
      readContext.snapshot.state,
      localState.state.funding.scriptPubKeyHex,
    );
  }

  return uiState;
}

function syncMiningVisualizerBlockTimes(loopState: MiningLoopState, blockTimesByHeight: Record<number, number>): void {
  loopState.ui.visibleBlockTimesByHeight = { ...blockTimesByHeight };
}

export function syncMiningVisualizerBlockTimesForTesting(
  loopState: MiningLoopState,
  blockTimesByHeight: Record<number, number>,
): void {
  syncMiningVisualizerBlockTimes(loopState, blockTimesByHeight);
}

function findRecentMiningWin(
  snapshotState: NonNullable<WalletReadContext["snapshot"]>["state"] | null | undefined,
  txid: string | null,
  targetBlockHeight: number | null,
): MiningRecentWinSummary | null {
  if (snapshotState === null || snapshotState === undefined || txid === null || targetBlockHeight === null) {
    return null;
  }

  const winners = getBlockWinners(snapshotState, targetBlockHeight) ?? [];
  const winner = winners.find((entry) => entry.txidHex === txid) ?? null;

  if (winner === null) {
    return null;
  }

  return {
    rank: winner.rank,
    rewardCogtoshi: winner.rewardCogtoshi,
    blockHeight: winner.height,
  };
}

function computeIntentFingerprint(state: WalletStateV1, candidate: MiningCandidate): string {
  return createHash("sha256")
    .update([
      "mine",
      state.walletRootId,
      candidate.domainId,
      candidate.referencedBlockHashDisplay,
      Buffer.from(candidate.encodedSentenceBytes).toString("hex"),
    ].join("\n"))
    .digest("hex");
}

function defaultMiningStatePatch(
  state: WalletStateV1,
  patch: Partial<MiningStateRecord>,
): WalletStateV1 {
  return {
    ...state,
    miningState: {
      ...cloneMiningState(state.miningState),
      ...patch,
      currentPublishState: normalizeMiningPublishState(
        patch.currentPublishState ?? state.miningState.currentPublishState,
      ),
    },
  };
}

function decodeMinePayload(payload: Uint8Array): {
  domainId: number;
  referencedBlockPrefixHex: string;
  sentenceBytes: Uint8Array;
} | null {
  if (payload.length < 68 || Buffer.from(payload.subarray(0, 3)).toString("utf8") !== "COG" || payload[3] !== 0x01) {
    return null;
  }

  return {
    domainId: Buffer.from(payload).readUInt32BE(4),
    referencedBlockPrefixHex: Buffer.from(payload.subarray(8, 12)).toString("hex"),
    sentenceBytes: payload.subarray(12, 72),
  };
}

function bytesToHex(value: Uint8Array | null | undefined): string | null {
  return value == null ? null : Buffer.from(value).toString("hex");
}

function readU32BE(bytes: Uint8Array, offset: number): number | null {
  if ((offset + 4) > bytes.length) {
    return null;
  }

  return Buffer.from(bytes.subarray(offset, offset + 4)).readUInt32BE(0);
}

function readLenPrefixedScriptHex(bytes: Uint8Array, offset: number): { scriptHex: string; nextOffset: number } | null {
  const length = bytes[offset];

  if (length === undefined || (offset + 1 + length) > bytes.length) {
    return null;
  }

  return {
    scriptHex: Buffer.from(bytes.subarray(offset + 1, offset + 1 + length)).toString("hex"),
    nextOffset: offset + 1 + length,
  };
}

function parseSupportedAncestorOperation(context: CachedMempoolTxContext): SupportedAncestorOperation | null | "unsupported" {
  const payload = context.payload;

  if (payload === null) {
    return null;
  }

  if (
    payload.length < 4
    || payload[0] !== COG_PREFIX[0]
    || payload[1] !== COG_PREFIX[1]
    || payload[2] !== COG_PREFIX[2]
  ) {
    return null;
  }

  const opcode = payload[3];

  if (opcode === COG_OPCODES.DOMAIN_REG) {
    const nameLength = payload[4];

    if (nameLength === undefined || (5 + nameLength) !== payload.length) {
      return "unsupported";
    }

    return {
      kind: "domain-reg",
      name: Buffer.from(payload.subarray(5, 5 + nameLength)).toString("utf8"),
      senderScriptHex: context.senderScriptHex,
    };
  }

  if (opcode === COG_OPCODES.DOMAIN_TRANSFER) {
    const domainId = readU32BE(payload, 4);
    const recipient = domainId === null ? null : readLenPrefixedScriptHex(payload, 8);

    if (domainId === null || recipient === null || recipient.nextOffset !== payload.length) {
      return "unsupported";
    }

    return {
      kind: "domain-transfer",
      domainId,
      recipientScriptHex: recipient.scriptHex,
      senderScriptHex: context.senderScriptHex,
    };
  }

  if (opcode === COG_OPCODES.DOMAIN_ANCHOR) {
    const domainId = readU32BE(payload, 4);

    if (domainId === null) {
      return "unsupported";
    }

    return {
      kind: "domain-anchor",
      domainId,
      senderScriptHex: context.senderScriptHex,
    };
  }

  if (opcode === COG_OPCODES.SET_DELEGATE || opcode === COG_OPCODES.SET_MINER) {
    const domainId = readU32BE(payload, 4);

    if (domainId === null) {
      return "unsupported";
    }

    if (payload.length === 8) {
      return opcode === COG_OPCODES.SET_DELEGATE
        ? { kind: "set-delegate", domainId, delegateScriptHex: null }
        : { kind: "set-miner", domainId, minerScriptHex: null };
    }

    const target = readLenPrefixedScriptHex(payload, 8);
    if (target === null || target.nextOffset !== payload.length) {
      return "unsupported";
    }

    return opcode === COG_OPCODES.SET_DELEGATE
      ? { kind: "set-delegate", domainId, delegateScriptHex: target.scriptHex }
      : { kind: "set-miner", domainId, minerScriptHex: target.scriptHex };
  }

  return "unsupported";
}

function getAncestorTxids(context: CachedMempoolTxContext, txContexts: Map<string, CachedMempoolTxContext>): string[] {
  return context.rawTransaction.vin
    .map((vin) => vin.txid ?? null)
    .filter((txid): txid is string => txid !== null && txContexts.has(txid));
}

function topologicallyOrderAncestorContexts(options: {
  txid: string;
  txContexts: Map<string, CachedMempoolTxContext>;
}): CachedMempoolTxContext[] | null {
  const visited = new Map<string, "visiting" | "visited">();
  const ordered: CachedMempoolTxContext[] = [];
  const root = options.txContexts.get(options.txid);
  if (root === undefined) {
    return [];
  }

  const stack = getAncestorTxids(root, options.txContexts)
    .reverse()
    .map((txid) => ({
      txid,
      expanded: false,
    }));

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const state = visited.get(frame.txid);

    if (frame.expanded) {
      if (state !== "visiting") {
        continue;
      }

      visited.set(frame.txid, "visited");
      const context = options.txContexts.get(frame.txid);
      if (context !== undefined) {
        ordered.push(context);
      }
      continue;
    }

    if (state === "visited") {
      continue;
    }

    if (state === "visiting") {
      return null;
    }

    const context = options.txContexts.get(frame.txid);
    if (context === undefined) {
      continue;
    }

    visited.set(frame.txid, "visiting");
    stack.push({
      txid: frame.txid,
      expanded: true,
    });

    const parents = getAncestorTxids(context, options.txContexts);
    for (let index = parents.length - 1; index >= 0; index -= 1) {
      const parentTxid = parents[index]!;
      const parentState = visited.get(parentTxid);
      if (parentState === "visiting") {
        return null;
      }

      if (parentState !== "visited") {
        stack.push({
          txid: parentTxid,
          expanded: false,
        });
      }
    }
  }

  return ordered;
}

function cloneOverlayDomainFromConfirmed(
  readContext: WalletReadContext & { snapshot: NonNullable<WalletReadContext["snapshot"]> },
  domainId: number,
): OverlayDomainState | null {
  const domain = lookupDomainById(readContext.snapshot.state, domainId);

  if (domain === null) {
    return null;
  }

  return {
    domainId,
    name: domain.name,
    anchored: domain.anchored,
    ownerScriptHex: bytesToHex(domain.ownerScriptPubKey),
    delegateScriptHex: bytesToHex(domain.delegate),
    minerScriptHex: bytesToHex(domain.miner),
  };
}

function applySupportedAncestorOperation(options: {
  readContext: WalletReadContext & { snapshot: NonNullable<WalletReadContext["snapshot"]> };
  overlay: Map<number, OverlayDomainState>;
  nextDomainId: number;
  operation: SupportedAncestorOperation;
}): { nextDomainId: number; indeterminate: boolean } {
  const ensureDomain = (domainId: number): OverlayDomainState | null => {
    const existing = options.overlay.get(domainId);
    if (existing !== undefined) {
      return existing;
    }

    const confirmed = cloneOverlayDomainFromConfirmed(options.readContext, domainId);
    if (confirmed === null) {
      return null;
    }

    options.overlay.set(domainId, confirmed);
    return confirmed;
  };

  if (options.operation.kind === "domain-reg") {
    if (!rootDomain(options.operation.name)) {
      return { nextDomainId: options.nextDomainId, indeterminate: true };
    }

    if (lookupDomain(options.readContext.snapshot.state, options.operation.name) !== null) {
      return { nextDomainId: options.nextDomainId, indeterminate: true };
    }

    options.overlay.set(options.nextDomainId, {
      domainId: options.nextDomainId,
      name: options.operation.name,
      anchored: false,
      ownerScriptHex: options.operation.senderScriptHex,
      delegateScriptHex: null,
      minerScriptHex: null,
    });
    return {
      nextDomainId: options.nextDomainId + 1,
      indeterminate: false,
    };
  }

  const domain = ensureDomain(options.operation.domainId);
  if (domain === null) {
    return { nextDomainId: options.nextDomainId, indeterminate: true };
  }

  if (options.operation.kind === "domain-transfer") {
    domain.ownerScriptHex = options.operation.recipientScriptHex;
    options.overlay.set(domain.domainId, domain);
    return { nextDomainId: options.nextDomainId, indeterminate: false };
  }

  if (options.operation.kind === "domain-anchor") {
    domain.anchored = true;
    if (options.operation.senderScriptHex !== null) {
      domain.ownerScriptHex = options.operation.senderScriptHex;
    }
    options.overlay.set(domain.domainId, domain);
    return { nextDomainId: options.nextDomainId, indeterminate: false };
  }

  if (options.operation.kind === "set-delegate") {
    domain.delegateScriptHex = options.operation.delegateScriptHex;
    options.overlay.set(domain.domainId, domain);
    return { nextDomainId: options.nextDomainId, indeterminate: false };
  }

  domain.minerScriptHex = options.operation.minerScriptHex;
  options.overlay.set(domain.domainId, domain);
  return { nextDomainId: options.nextDomainId, indeterminate: false };
}

async function resolveOverlayAuthorizedMiningDomain(options: {
  readContext: WalletReadContext & { snapshot: NonNullable<WalletReadContext["snapshot"]> };
  txid: string;
  txContexts: Map<string, CachedMempoolTxContext>;
  domainId: number;
  senderScriptHex: string;
}): Promise<OverlayDomainState | "indeterminate" | null> {
  const orderedAncestors = topologicallyOrderAncestorContexts({
    txid: options.txid,
    txContexts: options.txContexts,
  });

  if (orderedAncestors === null) {
    return "indeterminate";
  }

  const overlay = new Map<number, OverlayDomainState>();
  let nextDomainId = options.readContext.snapshot.state.consensus.nextDomainId;

  for (const ancestor of orderedAncestors) {
    const parsed = parseSupportedAncestorOperation(ancestor);

    if (parsed === "unsupported") {
      return "indeterminate";
    }

    if (parsed === null) {
      continue;
    }

    const applied = applySupportedAncestorOperation({
      readContext: options.readContext,
      overlay,
      nextDomainId,
      operation: parsed,
    });
    nextDomainId = applied.nextDomainId;

    if (applied.indeterminate) {
      return "indeterminate";
    }
  }

  const domain = overlay.get(options.domainId) ?? cloneOverlayDomainFromConfirmed(options.readContext, options.domainId);
  if (domain === null || domain.name === null || !rootDomain(domain.name) || !domain.anchored) {
    return null;
  }

  const authorized = domain.ownerScriptHex === options.senderScriptHex
    || domain.delegateScriptHex === options.senderScriptHex
    || domain.minerScriptHex === options.senderScriptHex;
  return authorized ? domain : null;
}

function buildStatusSnapshot(
  view: MiningControlPlaneView,
  overrides: MiningRunnerStatusOverrides = {},
): MiningRuntimeStatusV1 {
  return applyMiningRuntimeStatusOverrides({
    runtime: view.runtime,
    provider: view.provider,
    overrides,
  });
}

function buildPrePublishStatusOverrides(options: {
  state: WalletStateV1;
  candidate: MiningCandidate;
}): MiningRunnerStatusOverrides {
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

async function refreshAndSaveStatus(options: {
  paths: WalletRuntimePaths;
  provider: WalletSecretProvider;
  readContext: WalletReadContext;
  overrides?: MiningRunnerStatusOverrides;
  visualizer?: MiningFollowVisualizer;
  visualizerState?: MiningFollowVisualizerState;
}): Promise<MiningRuntimeStatusV1> {
  const view = await inspectMiningControlPlane({
    provider: options.provider,
    localState: options.readContext.localState,
    bitcoind: options.readContext.bitcoind,
    nodeStatus: options.readContext.nodeStatus,
    nodeHealth: options.readContext.nodeHealth,
    indexer: options.readContext.indexer,
    paths: options.paths,
  });
  const snapshot = buildStatusSnapshot(view, options.overrides);
  await saveMiningRuntimeStatus(options.paths.miningStatusPath, snapshot);
  options.visualizer?.update(snapshot, options.visualizerState);
  return snapshot;
}

async function appendEvent(paths: WalletRuntimePaths, event: MiningEventRecord): Promise<void> {
  await appendMiningEvent(paths.miningEventsPath, event);
}

async function handleRecoverableMiningBitcoindFailure(options: {
  error: unknown;
  dataDir: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  readContext: WalletReadContext;
  loopState: MiningLoopState;
  attachService: typeof attachOrStartManagedBitcoindService;
  probeService: typeof probeManagedBitcoindService;
  stopService: typeof stopManagedBitcoindService;
  nowUnixMs: number;
  visualizer?: MiningFollowVisualizer;
}): Promise<void> {
  const failureMessage = describeRecoverableMiningBitcoindError(options.error);
  const walletRootId = options.readContext.localState.walletRootId ?? undefined;

  if (options.loopState.bitcoinRecoveryFirstFailureAtUnixMs === null) {
    options.loopState.bitcoinRecoveryFirstFailureAtUnixMs = options.nowUnixMs;
  }

  let restartedService = false;
  const probe = await options.probeService({
    dataDir: options.dataDir,
    chain: "main",
    startHeight: 0,
    walletRootId,
  }).catch((probeError) => {
    if (!isRecoverableMiningBitcoindError(probeError)) {
      throw probeError;
    }

    return null;
  });

  if (probe !== null) {
    if (probe.compatibility === "compatible") {
      rememberMiningBitcoindRecoveryIdentity(options.loopState, probe.status);
      options.loopState.bitcoinRecoveryFirstUnreachableAtUnixMs = null;
    } else if (probe.compatibility === "unreachable") {
      const identityChanged = rememberMiningBitcoindRecoveryIdentity(options.loopState, probe.status);
      const livePid = isMiningBitcoindRecoveryPidAlive(probe.status?.processId ?? null);

      if (identityChanged || options.loopState.bitcoinRecoveryFirstUnreachableAtUnixMs === null) {
        options.loopState.bitcoinRecoveryFirstUnreachableAtUnixMs = options.nowUnixMs;
      }

      if (!livePid) {
        restartedService = await attachManagedBitcoindForRecovery({
          dataDir: options.dataDir,
          walletRootId,
          attachService: options.attachService,
          loopState: options.loopState,
        });
      } else {
        const graceElapsed = (
          options.loopState.bitcoinRecoveryFirstUnreachableAtUnixMs !== null
          && options.nowUnixMs - options.loopState.bitcoinRecoveryFirstUnreachableAtUnixMs
            >= MINING_BITCOIN_RECOVERY_GRACE_MS
        );
        const cooldownElapsed = (
          options.loopState.bitcoinRecoveryLastRestartAttemptAtUnixMs === null
          || options.nowUnixMs - options.loopState.bitcoinRecoveryLastRestartAttemptAtUnixMs
            >= MINING_BITCOIN_RECOVERY_RESTART_COOLDOWN_MS
        );

        if (graceElapsed && cooldownElapsed) {
          options.loopState.bitcoinRecoveryLastRestartAttemptAtUnixMs = options.nowUnixMs;
          await options.stopService({
            dataDir: options.dataDir,
            walletRootId,
          }).catch((stopError) => {
            if (!isRecoverableMiningBitcoindError(stopError)) {
              throw stopError;
            }
          });
          await attachManagedBitcoindForRecovery({
            dataDir: options.dataDir,
            walletRootId,
            attachService: options.attachService,
            loopState: options.loopState,
          });
          restartedService = true;
        }
      }
    } else {
      throw new Error(probe.error ?? "managed_bitcoind_protocol_error");
    }
  }

  if (restartedService) {
    discardMiningLoopTransientWork(options.loopState, walletRootId);
    setMiningReconnectSettleWindow(options.loopState, options.nowUnixMs);
  }

  await refreshAndSaveStatus({
    paths: options.paths,
    provider: options.provider,
    readContext: options.readContext,
    overrides: {
      runMode: options.runMode,
      currentPhase: "waiting-bitcoin-network",
      lastError: failureMessage,
      note: MINING_BITCOIN_RECOVERY_NOTE,
      ...buildMiningSettleWindowStatusOverrides(options.loopState, options.nowUnixMs),
    },
    visualizer: options.visualizer,
    visualizerState: options.loopState.ui,
  });
}

async function handleDetectedMiningRuntimeResume(options: {
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  backgroundWorkerPid: number | null;
  backgroundWorkerRunId: string | null;
  detectedAtUnixMs: number;
  openReadContext: typeof openWalletReadContext;
  visualizer?: MiningFollowVisualizer;
  loopState: MiningLoopState;
}): Promise<void> {
  const readContext = await options.openReadContext({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    secretProvider: options.provider,
    paths: options.paths,
  });

  try {
    clearMiningGateCache(readContext.localState.walletRootId);
    setMiningReconnectSettleWindow(options.loopState, options.detectedAtUnixMs);
    await refreshAndSaveStatus({
      paths: options.paths,
      provider: options.provider,
      readContext,
      overrides: {
        runMode: options.runMode,
        backgroundWorkerPid: options.backgroundWorkerPid,
        backgroundWorkerRunId: options.backgroundWorkerRunId,
        backgroundWorkerHeartbeatAtUnixMs: options.runMode === "background" ? Date.now() : null,
        currentPhase: "resuming",
        lastSuspendDetectedAtUnixMs: options.detectedAtUnixMs,
        note: "Mining discarded stale in-flight work after a large local runtime gap and is rechecking health.",
        ...buildMiningSettleWindowStatusOverrides(options.loopState, options.detectedAtUnixMs),
      },
      visualizer: options.visualizer,
      visualizerState: createIndexedMiningFollowVisualizerState(readContext),
    });
  } finally {
    await readContext.close();
  }

  await appendEvent(options.paths, createEvent(
    "system-resumed",
    "Detected a large local runtime gap, discarded stale in-flight mining work, and resumed health checks from scratch.",
    {
      level: "warn",
      runId: options.backgroundWorkerRunId,
      timestampUnixMs: options.detectedAtUnixMs,
    },
  ));
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

function createMiningPlan(options: Parameters<typeof createMiningPlanModule>[0]) {
  return createMiningPlanModule(options);
}

export function createMiningPlanForTesting(options: Parameters<typeof createMiningPlanModule>[0]) {
  return createMiningPlanModule(options);
}

function validateMiningDraft(
  decoded: Parameters<typeof validateMiningDraftModule>[0],
  funded: Parameters<typeof validateMiningDraftModule>[1],
  plan: Parameters<typeof validateMiningDraftModule>[2],
): void {
  validateMiningDraftModule(decoded, funded, plan);
}

export function validateMiningDraftForTesting(
  decoded: Parameters<typeof validateMiningDraftModule>[0],
  funded: Parameters<typeof validateMiningDraftModule>[1],
  plan: Parameters<typeof validateMiningDraftModule>[2],
): void {
  validateMiningDraftModule(decoded, funded, plan);
}

function resolveEligibleAnchoredRoots(context: WalletReadContext) {
  return resolveEligibleAnchoredRootsModule(context);
}

function refreshMiningCandidateFromCurrentState(
  context: ReadyMiningReadContext,
  candidate: MiningCandidate,
): MiningCandidate | null {
  return refreshMiningCandidateFromCurrentStateModule(context, candidate);
}

export function refreshMiningCandidateFromCurrentStateForTesting(
  context: ReadyMiningReadContext,
  candidate: MiningCandidate,
): MiningCandidate | null {
  return refreshMiningCandidateFromCurrentStateModule(context, candidate);
}

function resolveMiningConflictOutpoint(options: Parameters<typeof resolveMiningConflictOutpointModule>[0]): OutpointRecord | null {
  return resolveMiningConflictOutpointModule(options);
}

export function resolveMiningConflictOutpointForTesting(
  options: Parameters<typeof resolveMiningConflictOutpointModule>[0],
): OutpointRecord | null {
  return resolveMiningConflictOutpointModule(options);
}

function createInsufficientFundsMiningPublishWaitingNote(): string {
  return createInsufficientFundsMiningPublishWaitingNoteModule();
}

function createInsufficientFundsMiningPublishErrorMessage(): string {
  return createInsufficientFundsMiningPublishErrorMessageModule();
}

async function probeMiningFundingAvailability(
  options: Parameters<typeof probeMiningFundingAvailabilityModule>[0],
): Promise<void> {
  await probeMiningFundingAvailabilityModule(options);
}

function buildMiningGenerationRequest(options: Parameters<typeof buildMiningGenerationRequestModule>[0]): MiningSentenceGenerationRequest {
  return buildMiningGenerationRequestModule(options);
}

export function buildMiningGenerationRequestForTesting(options: {
  targetBlockHeight: number;
  referencedBlockHashDisplay: string;
  generatedAtUnixMs?: number;
  requestId?: string;
  domains: Array<{
    domainId: number;
    domainName: string;
    requiredWords: [string, string, string, string, string];
  }>;
  domainExtraPrompts?: Record<string, string>;
  extraPrompt?: string | null;
}): MiningSentenceGenerationRequest {
  return buildMiningGenerationRequestModule({
    ...options,
    domainExtraPrompts: options.domainExtraPrompts ?? {},
    extraPrompt: options.extraPrompt ?? null,
  });
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

function livePublishTargetsCandidateTip(options: {
  liveState: MiningStateRecord;
  candidate: MiningCandidate;
}): boolean {
  return livePublishTargetsCandidateTipModule(options);
}

async function reconcileLiveMiningState(
  options: Parameters<typeof reconcileLiveMiningStateModule>[0],
): Promise<{ state: WalletStateV1; recentWin: MiningRecentWinSummary | null }> {
  return await reconcileLiveMiningStateModule(options);
}

async function publishCandidateOnce(options: Parameters<typeof publishCandidateOnceModule>[0]): Promise<{
  state: WalletStateV1;
  txid: string | null;
  decision: string;
}> {
  return await publishCandidateOnceModule({
    ...options,
    appendEventFn: appendEvent,
  });
}

async function publishCandidate(options: {
  candidate: MiningCandidate;
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  fallbackState: WalletStateV1;
  openReadContext: typeof openWalletReadContext;
  attachService: typeof attachOrStartManagedBitcoindService;
  rpcFactory: (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  runId: string | null;
  publishAttempt?: typeof publishCandidateOnce;
  appendEventFn?: typeof appendEvent;
}): Promise<MiningPublishOutcome> {
  return await publishCandidateModule({
    ...options,
    appendEventFn: options.appendEventFn ?? appendEvent,
  });
}

export async function publishCandidateForTesting(options: {
  candidate: MiningCandidate;
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  fallbackState: WalletStateV1;
  openReadContext: typeof openWalletReadContext;
  attachService: typeof attachOrStartManagedBitcoindService;
  rpcFactory: (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  runId: string | null;
  publishAttempt?: typeof publishCandidateOnce;
  appendEventFn?: typeof appendEvent;
}): Promise<MiningPublishOutcome> {
  return await publishCandidate({
    ...options,
    appendEventFn: options.appendEventFn ?? appendEvent,
  });
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

      return await refreshAndSaveStatus({
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

async function saveStopSnapshot(options: {
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  backgroundWorkerPid: number | null;
  backgroundWorkerRunId: string | null;
  note: string | null;
}): Promise<void> {
  const readContext = await openWalletReadContext({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    secretProvider: options.provider,
    paths: options.paths,
  });

  try {
    let localState = readContext.localState;

    if (localState.availability === "ready" && localState.state !== null) {
      const service = await attachOrStartManagedBitcoindService({
        dataDir: options.dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: localState.state.walletRootId,
      }).catch(() => null);

      if (service !== null) {
        const rpc = createRpcClient(service.rpc) as MiningRpcClient;
        const reconciledState = (await reconcileLiveMiningState({
          state: localState.state,
          rpc,
          nodeBestHash: readContext.nodeStatus?.nodeBestHashHex ?? null,
          nodeBestHeight: readContext.nodeStatus?.nodeBestHeight ?? null,
          snapshotState: readContext.snapshot?.state ?? null,
        })).state;
        const stopState = defaultMiningStatePatch(reconciledState, {
          runMode: "stopped",
          state: reconciledState.miningState.livePublishInMempool
            ? reconciledState.miningState.state === "paused-stale"
              ? "paused-stale"
              : "paused"
            : reconciledState.miningState.state === "repair-required"
              ? "repair-required"
              : "idle",
          pauseReason: reconciledState.miningState.livePublishInMempool
            ? reconciledState.miningState.state === "paused-stale"
              ? "stale-block-context"
              : "user-stopped"
            : reconciledState.miningState.state === "repair-required"
              ? reconciledState.miningState.pauseReason
              : null,
        });
        await saveWalletStatePreservingUnlock({
          state: stopState,
          provider: options.provider,
          paths: options.paths,
        });
        localState = {
          ...localState,
          state: stopState,
        };
      }
    }

    await refreshAndSaveStatus({
      paths: options.paths,
      provider: options.provider,
      readContext: {
        ...readContext,
        localState,
      },
      overrides: {
        runMode: "stopped",
        backgroundWorkerPid: options.runMode === "background" ? null : options.backgroundWorkerPid,
        backgroundWorkerRunId: options.runMode === "background" ? null : options.backgroundWorkerRunId,
        backgroundWorkerHeartbeatAtUnixMs: options.runMode === "background" ? null : Date.now(),
        currentPhase: "idle",
        note: options.note,
      },
    });
  } finally {
    await readContext.close();
  }
}

async function attemptSaveMempool(rpc: MiningRpcClient, paths: WalletRuntimePaths, runId: string | null): Promise<void> {
  try {
    await rpc.saveMempool?.();
  } catch {
    // ignore
  } finally {
    await appendEvent(paths, createEvent(
      "savemempool-attempted",
      "Attempted to persist the local mempool before stopping mining.",
      {
        runId,
      },
    ));
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
      await attemptSaveMempool(options.rpcFactory(service.rpc), options.paths, options.backgroundWorkerRunId);
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

export async function handleDetectedMiningRuntimeResumeForTesting(options: {
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  backgroundWorkerPid: number | null;
  backgroundWorkerRunId: string | null;
  detectedAtUnixMs: number;
  openReadContext: typeof openWalletReadContext;
  visualizer?: MiningFollowVisualizer;
  loopState?: MiningLoopState;
}): Promise<void> {
  await handleDetectedMiningRuntimeResume({
    ...options,
    loopState: options.loopState ?? createMiningLoopState(),
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

export async function runCompetitivenessGateForTesting(options: {
  rpc: MiningRpcClient;
  readContext: WalletReadContext & {
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
  };
  candidate: MiningCandidate;
  currentTxid: string | null;
  assaySentencesImpl?: typeof assaySentences;
  cooperativeYieldImpl?: MiningCooperativeYield;
  cooperativeYieldEvery?: number;
}): Promise<CompetitivenessDecision> {
  return await runCompetitivenessGate({
    rpc: options.rpc,
    readContext: options.readContext,
    candidate: options.candidate,
    currentTxid: options.currentTxid,
    assaySentencesImpl: options.assaySentencesImpl,
    cooperativeYield: options.cooperativeYieldImpl,
    cooperativeYieldEvery: options.cooperativeYieldEvery,
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

export function topologicallyOrderAncestorTxidsForTesting(options: {
  txid: string;
  txContexts: Map<string, {
    txid: string;
    rawTransaction: Awaited<ReturnType<MiningRpcClient["getRawTransaction"]>>;
  }>;
}): string[] | null {
  const ordered = topologicallyOrderAncestorContexts({
    txid: options.txid,
    txContexts: options.txContexts as Map<string, CachedMempoolTxContext>,
  });
  return ordered?.map((context) => context.txid) ?? null;
}

export function buildPrePublishStatusOverridesForTesting(options: {
  state: WalletStateV1;
  candidate: MiningCandidate;
}): MiningRunnerStatusOverrides {
  return buildPrePublishStatusOverrides(options);
}

export function buildStatusSnapshotForTesting(
  view: MiningControlPlaneView,
  overrides: MiningRunnerStatusOverrides = {},
): MiningRuntimeStatusV1 {
  return buildStatusSnapshot(view, overrides);
}

export function shouldKeepCurrentTipLivePublishForTesting(options: {
  liveState: MiningStateRecord;
  candidate: {
    domainId: number;
    sender: MutationSender;
    encodedSentenceBytes: Uint8Array;
    referencedBlockHashDisplay: string;
    targetBlockHeight: number;
  };
}): boolean {
  return livePublishTargetsCandidateTip(options as {
    liveState: MiningStateRecord;
    candidate: MiningCandidate;
  });
}
