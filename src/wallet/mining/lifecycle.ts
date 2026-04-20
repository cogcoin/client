import { createRpcClient } from "../../bitcoind/node.js";
import {
  attachOrStartManagedBitcoindService,
  probeManagedBitcoindService,
  stopManagedBitcoindService,
} from "../../bitcoind/service.js";
import { isRetryableManagedRpcError } from "../../bitcoind/retryable-rpc.js";
import type { WalletReadContext } from "../read/index.js";
import { openWalletReadContext } from "../read/index.js";
import type { WalletRuntimePaths } from "../runtime.js";
import type { WalletSecretProvider } from "../state/provider.js";
import { saveWalletStatePreservingUnlock } from "../tx/common.js";
import type { WalletStateV1 } from "../types.js";
import { appendMiningEvent, saveMiningRuntimeStatus } from "./runtime-artifacts.js";
import { inspectMiningControlPlane } from "./control.js";
import {
  applyMiningRuntimeStatusOverrides,
  type MiningRuntimeStatusOverrides,
} from "./projection.js";
import {
  buildMiningSettleWindowStatusOverrides,
  defaultMiningStatePatch,
  discardMiningLoopTransientWork,
  setMiningReconnectSettleWindow,
  type MiningRuntimeLoopState,
} from "./engine-state.js";
import { createIndexedMiningFollowVisualizerState } from "./visualizer-sync.js";
import { createMiningEventRecord } from "./events.js";
import type { MiningRpcClient } from "./engine-types.js";
import type { MiningRuntimeStatusV1 } from "./types.js";
import { reconcileLiveMiningState } from "./publish.js";
import type { MiningFollowVisualizer, MiningFollowVisualizerState } from "./visualizer.js";
import { clearMiningGateCache } from "./competitiveness.js";

const MINING_BITCOIN_RECOVERY_GRACE_MS = 15_000;
const MINING_BITCOIN_RECOVERY_RESTART_COOLDOWN_MS = 60_000;
const MINING_BITCOIN_RECOVERY_NOTE =
  "Mining lost contact with the local Bitcoin RPC service and is waiting for it to recover.";

interface MiningBitcoindRecoveryIdentity {
  serviceInstanceId: string | null;
  processId: number | null;
}

export async function refreshAndSaveMiningRuntimeStatus(options: {
  paths: WalletRuntimePaths;
  provider: WalletSecretProvider;
  readContext: WalletReadContext;
  overrides?: MiningRuntimeStatusOverrides;
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
  const snapshot = applyMiningRuntimeStatusOverrides({
    runtime: view.runtime,
    provider: view.provider,
    overrides: options.overrides,
  });
  await saveMiningRuntimeStatus(options.paths.miningStatusPath, snapshot);
  options.visualizer?.update(snapshot, options.visualizerState);
  return snapshot;
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
  loopState: MiningRuntimeLoopState,
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

export function resetMiningBitcoindRecoveryState(
  loopState: MiningRuntimeLoopState,
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

export function isRecoverableMiningBitcoindError(error: unknown): boolean {
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
  loopState: MiningRuntimeLoopState;
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

export async function handleRecoverableMiningBitcoindFailure(options: {
  error: unknown;
  dataDir: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  readContext: WalletReadContext;
  loopState: MiningRuntimeLoopState;
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

  await refreshAndSaveMiningRuntimeStatus({
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

export async function handleDetectedMiningRuntimeResume(options: {
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  backgroundWorkerPid: number | null;
  backgroundWorkerRunId: string | null;
  detectedAtUnixMs: number;
  openReadContext?: typeof openWalletReadContext;
  visualizer?: MiningFollowVisualizer;
  loopState: MiningRuntimeLoopState;
}): Promise<void> {
  const readContext = await (options.openReadContext ?? openWalletReadContext)({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    secretProvider: options.provider,
    paths: options.paths,
  });

  try {
    clearMiningGateCache(readContext.localState.walletRootId);
    setMiningReconnectSettleWindow(options.loopState, options.detectedAtUnixMs);
    await refreshAndSaveMiningRuntimeStatus({
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

  await appendMiningEvent(
    options.paths.miningEventsPath,
    createMiningEventRecord(
      "system-resumed",
      "Detected a large local runtime gap, discarded stale in-flight mining work, and resumed health checks from scratch.",
      {
        level: "warn",
        runId: options.backgroundWorkerRunId,
        timestampUnixMs: options.detectedAtUnixMs,
      },
    ),
  );
}

export async function saveStopSnapshot(options: {
  dataDir: string;
  databasePath: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  runMode: "foreground" | "background";
  backgroundWorkerPid: number | null;
  backgroundWorkerRunId: string | null;
  note: string | null;
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
}): Promise<void> {
  const openReadContextImpl = options.openReadContext ?? openWalletReadContext;
  const attachServiceImpl = options.attachService ?? attachOrStartManagedBitcoindService;
  const rpcFactory = options.rpcFactory ?? createRpcClient as (config: Parameters<typeof createRpcClient>[0]) => MiningRpcClient;
  const readContext = await openReadContextImpl({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    secretProvider: options.provider,
    paths: options.paths,
  });

  try {
    let localState = readContext.localState;

    if (localState.availability === "ready" && localState.state !== null) {
      const service = await attachServiceImpl({
        dataDir: options.dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: localState.state.walletRootId,
      }).catch(() => null);

      if (service !== null) {
        const rpc = rpcFactory(service.rpc);
        const reconciledState = (await reconcileLiveMiningState({
          state: localState.state,
          rpc,
          nodeBestHash: readContext.nodeStatus?.nodeBestHashHex ?? null,
          nodeBestHeight: readContext.nodeStatus?.nodeBestHeight ?? null,
          snapshotState: readContext.snapshot?.state ?? null,
        })).state;
        const stopState = defaultMiningStopState(reconciledState);
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

    await refreshAndSaveMiningRuntimeStatus({
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

function defaultMiningStopState(state: WalletStateV1): WalletStateV1 {
  return defaultMiningStatePatch(state, {
    runMode: "stopped",
    state: state.miningState.livePublishInMempool
      ? state.miningState.state === "paused-stale"
        ? "paused-stale"
        : "paused"
      : state.miningState.state === "repair-required"
        ? "repair-required"
        : "idle",
    pauseReason: state.miningState.livePublishInMempool
      ? state.miningState.state === "paused-stale"
        ? "stale-block-context"
        : "user-stopped"
      : state.miningState.state === "repair-required"
        ? state.miningState.pauseReason
        : null,
  });
}

export async function attemptSaveMempool(options: {
  rpc: MiningRpcClient;
  paths: WalletRuntimePaths;
  runId: string | null;
}): Promise<void> {
  try {
    await options.rpc.saveMempool?.();
  } catch {
    // ignore
  } finally {
    await appendMiningEvent(
      options.paths.miningEventsPath,
      createMiningEventRecord(
        "savemempool-attempted",
        "Attempted to persist the local mempool before stopping mining.",
        {
          runId: options.runId,
        },
      ),
    );
  }
}
