import { rm } from "node:fs/promises";
import { join } from "node:path";

import { createRpcClient } from "../../bitcoind/node.js";
import { attachOrStartManagedBitcoindService } from "../../bitcoind/service.js";
import type { ProgressOutputMode } from "../../bitcoind/types.js";
import {
  FileLockBusyError,
  acquireFileLock,
  clearOrphanedFileLock,
  readLockMetadata,
} from "../fs/lock.js";
import { openWalletReadContext } from "../read/index.js";
import type { WalletRuntimePaths } from "../runtime.js";
import type { WalletSecretProvider } from "../state/provider.js";
import { destroyAllClientPasswordSessionsResolved } from "../state/client-password/session.js";
import {
  readMiningGenerationActivity,
  requestMiningGenerationPreemption,
} from "./coordination.js";
import {
  MINING_SHUTDOWN_GRACE_MS,
} from "./constants.js";
import { saveStopSnapshot } from "./lifecycle.js";
import type { MiningRpcClient } from "./engine-types.js";
import {
  loadMiningRuntimeStatus,
  saveMiningRuntimeStatus,
} from "./runtime-artifacts.js";
import type { MiningRuntimeStatusV1 } from "./types.js";
import { MiningFollowVisualizer } from "./visualizer.js";

type OpenReadContext = typeof openWalletReadContext;
type AttachService = typeof attachOrStartManagedBitcoindService;
type RpcFactory = (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
type RequestMiningPreemption = typeof requestMiningGenerationPreemption;
type SaveStopSnapshot = typeof saveStopSnapshot;
type ProcessKill = typeof process.kill;

interface MiningLoopRunnerOptions {
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  backgroundWorkerPid: number | null;
  backgroundWorkerRunId: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  openReadContext: OpenReadContext;
  attachService: AttachService;
  rpcFactory: RpcFactory;
  stdout?: { write(chunk: string): void };
  visualizer?: MiningFollowVisualizer;
}

type RunMiningLoop = (options: MiningLoopRunnerOptions) => Promise<void>;

export interface MiningSupervisorRuntimeContext {
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  openReadContext: OpenReadContext;
  attachService: AttachService;
  rpcFactory: RpcFactory;
}

interface MiningSupervisorDependencies {
  requestMiningPreemption: RequestMiningPreemption;
  saveStopSnapshot: SaveStopSnapshot;
  runMiningLoop: RunMiningLoop;
  loadRuntimeStatus: typeof loadMiningRuntimeStatus;
  saveRuntimeStatus: typeof saveMiningRuntimeStatus;
  acquireLock: typeof acquireFileLock;
  clearOrphanedLock: typeof clearOrphanedFileLock;
  readLockMetadata: typeof readLockMetadata;
  sleep: typeof sleep;
  removeFile: typeof rm;
  nowUnixMs: () => number;
  processKill: ProcessKill;
  processPid: number;
}

export interface MiningSupervisorTakeoverResult {
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

function createOneShotClientPasswordSessionDestroyer(): () => void {
  let destroyed = false;

  return () => {
    if (destroyed) {
      return;
    }

    destroyed = true;
    destroyAllClientPasswordSessionsResolved();
  };
}

function resolveSupervisorDependencies(
  overrides: Partial<MiningSupervisorDependencies> = {},
): MiningSupervisorDependencies {
  return {
    requestMiningPreemption: overrides.requestMiningPreemption ?? requestMiningGenerationPreemption,
    saveStopSnapshot: overrides.saveStopSnapshot ?? saveStopSnapshot,
    runMiningLoop: overrides.runMiningLoop ?? (() => {
      throw new Error("mining_supervisor_run_loop_missing");
    }),
    loadRuntimeStatus: overrides.loadRuntimeStatus ?? loadMiningRuntimeStatus,
    saveRuntimeStatus: overrides.saveRuntimeStatus ?? saveMiningRuntimeStatus,
    acquireLock: overrides.acquireLock ?? acquireFileLock,
    clearOrphanedLock: overrides.clearOrphanedLock ?? clearOrphanedFileLock,
    readLockMetadata: overrides.readLockMetadata ?? readLockMetadata,
    sleep: overrides.sleep ?? sleep,
    removeFile: overrides.removeFile ?? rm,
    nowUnixMs: overrides.nowUnixMs ?? Date.now,
    processKill: overrides.processKill ?? process.kill.bind(process),
    processPid: overrides.processPid ?? process.pid,
  };
}

async function isProcessAlive(
  pid: number | null,
  deps: MiningSupervisorDependencies,
): Promise<boolean> {
  if (pid === null) {
    return false;
  }

  try {
    deps.processKill(pid, 0);
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
  deps: MiningSupervisorDependencies,
): Promise<boolean> {
  const deadline = deps.nowUnixMs() + timeoutMs;

  while (deps.nowUnixMs() < deadline) {
    if (!await isProcessAlive(pid, deps)) {
      return true;
    }

    await deps.sleep(Math.min(250, Math.max(timeoutMs, 1)));
  }

  return !await isProcessAlive(pid, deps);
}

async function terminateMiningRuntimePid(options: {
  pid: number;
  shutdownGraceMs: number;
  deps: MiningSupervisorDependencies;
}): Promise<boolean> {
  if (!await isProcessAlive(options.pid, options.deps)) {
    return false;
  }

  try {
    options.deps.processKill(options.pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) {
      throw error;
    }
  }

  if (await waitForMiningProcessExit(options.pid, options.shutdownGraceMs, options.deps)) {
    return true;
  }

  try {
    options.deps.processKill(options.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) {
      throw error;
    }
  }

  if (await waitForMiningProcessExit(options.pid, options.shutdownGraceMs, options.deps)) {
    return true;
  }

  throw new Error("mining_process_stop_timeout");
}

export async function takeOverMiningRuntime(options: {
  paths: WalletRuntimePaths;
  reason: string;
  clearControlLockFile?: boolean;
  controlLockMetadata?: Awaited<ReturnType<typeof readLockMetadata>>;
  shutdownGraceMs?: number;
  deps?: Partial<MiningSupervisorDependencies>;
}): Promise<MiningSupervisorTakeoverResult> {
  const deps = resolveSupervisorDependencies(options.deps);
  const snapshot = await deps.loadRuntimeStatus(options.paths.miningStatusPath).catch(() => null);
  const controlLockMetadata = options.controlLockMetadata ?? (
    options.clearControlLockFile === true
      ? await deps.readLockMetadata(options.paths.miningControlLockPath).catch(() => null)
      : null
  );
  const generationActivity = await readMiningGenerationActivity(options.paths).catch(() => null);
  const shutdownGraceMs = options.shutdownGraceMs ?? MINING_SHUTDOWN_GRACE_MS;
  const controlLockPid = normalizeMiningPid(controlLockMetadata?.processId);
  const backgroundWorkerPid = normalizeMiningPid(snapshot?.backgroundWorkerPid);
  const generationOwnerPid = normalizeMiningPid(generationActivity?.generationOwnerPid);
  const terminatedPids: number[] = [];
  const discoveredPids = new Set<number>();

  for (const pid of [controlLockPid, backgroundWorkerPid, generationOwnerPid]) {
    if (
      pid === null
      || pid === deps.processPid
      || discoveredPids.has(pid)
      || !await isProcessAlive(pid, deps)
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
    ? await deps.requestMiningPreemption({
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
        deps,
      })) {
        terminatedPids.push(pid);
      }
    }
  } finally {
    await preemption?.release().catch(() => undefined);
  }

  const controlLockCleared = options.clearControlLockFile === true
    ? await deps.clearOrphanedLock(
      options.paths.miningControlLockPath,
      async (pid) => await isProcessAlive(pid, deps),
    ).catch(() => false)
    : false;

  await deps.removeFile(resolveMiningGenerationRequestPath(options.paths), { force: true }).catch(() => undefined);
  await deps.removeFile(resolveMiningGenerationActivityPath(options.paths), { force: true }).catch(() => undefined);

  const walletRootId = snapshot?.walletRootId
    ?? (typeof controlLockMetadata?.walletRootId === "string" ? controlLockMetadata.walletRootId : null);

  if (snapshot !== null || walletRootId !== null || terminatedPids.length > 0 || controlLockCleared) {
    await deps.saveRuntimeStatus(
      options.paths.miningStatusPath,
      createStoppedMiningRuntimeSnapshotForTakeover({
        snapshot,
        walletRootId,
        nowUnixMs: deps.nowUnixMs(),
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
  shutdownGraceMs?: number;
  deps: MiningSupervisorDependencies;
}) {
  while (true) {
    try {
      return await options.deps.acquireLock(options.paths.miningControlLockPath, {
        purpose: options.purpose,
      });
    } catch (error) {
      if (!(error instanceof FileLockBusyError)) {
        throw error;
      }

      if (error.existingMetadata?.processId === options.deps.processPid) {
        throw error;
      }

      const takeover = await takeOverMiningRuntime({
        paths: options.paths,
        reason: options.takeoverReason,
        clearControlLockFile: true,
        controlLockMetadata: error.existingMetadata,
        shutdownGraceMs: options.shutdownGraceMs,
        deps: options.deps,
      });

      if (!takeover.replaced && !takeover.controlLockCleared) {
        throw error;
      }
    }
  }
}

export async function runForegroundMining(options: {
  dataDir: string;
  databasePath: string;
  clientVersion?: string | null;
  updateAvailable?: boolean;
  stdout?: { write(chunk: string): void };
  stderr?: { isTTY?: boolean; columns?: number; write(chunk: string): boolean | void };
  signal?: AbortSignal;
  progressOutput?: ProgressOutputMode;
  visualizer?: MiningFollowVisualizer;
  fetchImpl?: typeof fetch;
  shutdownGraceMs?: number;
  runtime: MiningSupervisorRuntimeContext;
  deps?: Partial<MiningSupervisorDependencies>;
}): Promise<void> {
  const deps = resolveSupervisorDependencies(options.deps);
  let visualizer: MiningFollowVisualizer | null = options.visualizer ?? null;
  const ownsVisualizer = visualizer === null;
  const destroyClientPasswordSessions = createOneShotClientPasswordSessionDestroyer();
  const controlLock = await acquireMiningStartControlLock({
    paths: options.runtime.paths,
    purpose: "mine-foreground",
    takeoverReason: "mine-foreground-replace",
    shutdownGraceMs: options.shutdownGraceMs,
    deps,
  });
  const abortController = new AbortController();
  const abortListener = () => {
    abortController.abort();
  };
  const handleSigint = () => abortController.abort();
  const handleSigterm = () => {
    process.once("exit", destroyClientPasswordSessions);
    abortController.abort();
  };

  try {
    await takeOverMiningRuntime({
      paths: options.runtime.paths,
      reason: "mine-foreground-replace",
      shutdownGraceMs: options.shutdownGraceMs,
      deps,
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

    await deps.runMiningLoop({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      provider: options.runtime.provider,
      paths: options.runtime.paths,
      runMode: "foreground",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      signal: abortController.signal,
      fetchImpl: options.fetchImpl,
      openReadContext: options.runtime.openReadContext,
      attachService: options.runtime.attachService,
      rpcFactory: options.runtime.rpcFactory,
      stdout: options.stdout,
      visualizer,
    });
    await deps.saveStopSnapshot({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      provider: options.runtime.provider,
      paths: options.runtime.paths,
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
    destroyClientPasswordSessions();
  }
}
