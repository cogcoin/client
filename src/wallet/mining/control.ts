import { randomBytes } from "node:crypto";

import { acquireFileLock } from "../fs/lock.js";
import { loadOrAutoUnlockWalletState, type WalletPrompter } from "../lifecycle.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../runtime.js";
import { saveWalletState } from "../state/storage.js";
import {
  createDefaultWalletSecretProvider,
  createWalletSecretReference,
  type WalletSecretProvider,
} from "../state/provider.js";
import type { HookClientStateRecord, WalletStateV1 } from "../types.js";
import type {
  WalletBitcoindStatus,
  WalletIndexerStatus,
  WalletLocalStateStatus,
  WalletNodeStatus,
} from "../read/types.js";
import { appendMiningEvent, getLastMiningEventTimestamp, loadMiningRuntimeStatus, readMiningEvents, saveMiningRuntimeStatus, followMiningEvents } from "./runtime-artifacts.js";
import { requestMiningGenerationPreemption } from "./coordination.js";
import {
  ensureMiningHookTemplate,
  inspectMiningHookState,
  shouldEnterHookCooldown,
  validateCustomMiningHook,
} from "./hooks.js";
import { normalizeMiningPublishState, normalizeMiningStateRecord } from "./state.js";
import { loadClientConfig, saveBuiltInMiningProviderConfig } from "./config.js";
import type {
  MiningControlPlaneView,
  MiningEventRecord,
  MiningProviderConfigRecord,
  MiningProviderInspection,
  MiningRuntimeStatusV1,
} from "./types.js";
import { MINING_WORKER_API_VERSION } from "./constants.js";

const WORKER_HEARTBEAT_STALE_MS = 15_000;

function normalizeHookMode(mode: HookClientStateRecord["mode"] | null | undefined): "builtin" | "custom" {
  return mode === "custom" ? "custom" : "builtin";
}

function createDefaultHookState(): HookClientStateRecord {
  return {
    mode: "builtin",
    validationState: "never",
    lastValidationAtUnixMs: null,
    lastValidationError: null,
    validatedLaunchFingerprint: null,
    validatedFullFingerprint: null,
    fullTrustWarningAcknowledgedAtUnixMs: null,
    consecutiveFailureCount: 0,
    cooldownUntilUnixMs: null,
  };
}

function createMiningEvent(
  kind: string,
  message: string,
  options: {
    level?: MiningEventRecord["level"];
    timestampUnixMs?: number;
  } = {},
): MiningEventRecord {
  return {
    schemaVersion: 1,
    timestampUnixMs: options.timestampUnixMs ?? Date.now(),
    level: options.level ?? "info",
    kind,
    message,
  };
}

function buildProviderInspection(options: {
  config: MiningProviderConfigRecord | null;
  error: string | null;
}): MiningProviderInspection {
  if (options.error !== null) {
    return {
      configured: false,
      provider: null,
      status: "error",
      message: options.error,
      modelOverride: null,
      extraPromptConfigured: false,
    };
  }

  if (options.config === null) {
    return {
      configured: false,
      provider: null,
      status: "missing",
      message: "Built-in mining provider is not configured yet.",
      modelOverride: null,
      extraPromptConfigured: false,
    };
  }

  return {
    configured: true,
    provider: options.config.provider,
    status: "ready",
    message: null,
    modelOverride: options.config.modelOverride,
    extraPromptConfigured: options.config.extraPrompt !== null && options.config.extraPrompt.length > 0,
  };
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
  hookMode: "builtin" | "custom",
  localState: WalletLocalStateStatus,
  nowUnixMs: number,
): MiningRuntimeStatusV1["providerState"] {
  const miningState = localState.state?.miningState === undefined
    ? null
    : normalizeMiningStateRecord(localState.state.miningState);
  const hookState = localState.state?.hookClientState.mining ?? null;
  const hookCooldownUntilUnixMs = hookState?.cooldownUntilUnixMs ?? null;
  const hookCooldownActive = hookCooldownUntilUnixMs !== null
    && hookCooldownUntilUnixMs > nowUnixMs;

  if (hookMode === "custom") {
    return hookState?.validationState === "failed" || hookCooldownActive
      ? "hook-error"
      : "n/a";
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

  if (provider.status === "error") {
    return "unavailable";
  }

  return "unavailable";
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
    || (options.nowUnixMs - runtime.backgroundWorkerHeartbeatAtUnixMs) > WORKER_HEARTBEAT_STALE_MS
  ) {
    return "stale-heartbeat";
  }

  return "healthy";
}

async function buildMiningRuntimeSnapshot(options: {
  nowUnixMs: number;
  localState: WalletLocalStateStatus;
  bitcoind: WalletBitcoindStatus;
  nodeStatus: WalletNodeStatus | null;
  hookMode: "builtin" | "custom";
  hookValidationState: MiningRuntimeStatusV1["lastValidationState"];
  hookOperatorValidationState: MiningRuntimeStatusV1["lastOperatorValidationState"];
  hookValidationAtUnixMs: number | null;
  hookCooldownActive: boolean;
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
  const providerState = mapProviderState(options.provider, options.hookMode, options.localState, options.nowUnixMs);
  const indexerDaemonState = mapIndexerDaemonState(options.indexer);
  const corePublishState = mapCorePublishState(options.nodeHealth, options.nodeStatus);
  const existing = options.existingRuntime;

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
    hookMode: options.hookMode,
    providerConfigured: options.provider.configured,
    providerKind: options.provider.provider,
    bitcoindHealth: options.bitcoind.health,
    bitcoindServiceState: options.nodeStatus?.serviceStatus?.state ?? null,
    bitcoindReplicaStatus: options.nodeStatus?.walletReplica?.proofStatus ?? null,
    nodeHealth: options.nodeHealth,
    indexerHealth: options.indexer.health,
    tipsAligned: options.tipsAligned,
    lastValidationState: options.hookValidationState,
    lastOperatorValidationState: options.hookOperatorValidationState,
    lastValidationAtUnixMs: options.hookValidationAtUnixMs,
    lastEventAtUnixMs: options.lastEventAtUnixMs,
    lastError: existing?.lastError ?? options.provider.message ?? options.indexer.message ?? null,
    note: options.hookMode === "custom" && options.hookCooldownActive
      ? "Custom mining hook launch is paused during the post-failure cooldown window."
      : options.hookMode === "custom" && options.hookOperatorValidationState !== "current"
        ? "Custom mining hook is selected, but it must be revalidated before it can launch."
        : state?.pauseReason === "zero-reward"
          ? "Mining is disabled because the target block reward is zero."
          : existing?.currentPhase === "resuming"
            ? "Mining discarded stale in-flight work after a large local runtime gap and is rechecking health."
            : existing?.currentPhase === "waiting-provider"
              ? "Mining is waiting for the sentence provider to recover."
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

async function persistWalletMiningHookState(options: {
  state: WalletStateV1;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
}): Promise<void> {
  await saveWalletState(
    {
      primaryPath: options.paths.walletStatePath,
      backupPath: options.paths.walletStateBackupPath,
    },
    options.state,
    {
      provider: options.provider,
      secretReference: createWalletSecretReference(options.state.walletRootId),
    },
  );
}

async function loadMiningProviderConfig(options: {
  paths: WalletRuntimePaths;
  provider: WalletSecretProvider;
}): Promise<{
  config: MiningProviderConfigRecord | null;
  error: string | null;
}> {
  try {
    const config = await loadClientConfig({
      path: options.paths.clientConfigPath,
      provider: options.provider,
    });
    return {
      config: config?.mining.builtIn ?? null,
      error: null,
    };
  } catch (error) {
    return {
      config: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function inspectMiningControlPlane(options: {
  provider?: WalletSecretProvider;
  localState: WalletLocalStateStatus;
  bitcoind: WalletBitcoindStatus;
  nodeStatus: WalletNodeStatus | null;
  nodeHealth: MiningRuntimeStatusV1["nodeHealth"];
  indexer: WalletIndexerStatus;
  verify?: boolean;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
}): Promise<MiningControlPlaneView> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const providerConfig = await loadMiningProviderConfig({
    paths,
    provider,
  });
  const hookState = options.localState.state?.hookClientState.mining ?? null;
  const hook = await inspectMiningHookState({
    hookRootPath: paths.hooksMiningDir,
    entrypointPath: paths.hooksMiningEntrypointPath,
    packagePath: paths.hooksMiningPackageJsonPath,
    localState: hookState,
    verify: options.verify ?? false,
  });
  const providerInspection = buildProviderInspection(providerConfig);
  const existingRuntime = await loadMiningRuntimeStatus(paths.miningStatusPath).catch(() => null);
  const lastEventAtUnixMs = await getLastMiningEventTimestamp(paths.miningEventsPath).catch(() => null);
  const nodeBestHeight = options.nodeStatus?.nodeBestHeight ?? null;
  const indexerHeight = options.indexer.snapshotTip?.height ?? null;
  const tipsAligned = nodeBestHeight === null || indexerHeight === null ? null : nodeBestHeight === indexerHeight;
  const runtime = await buildMiningRuntimeSnapshot({
    nowUnixMs,
    localState: options.localState,
    bitcoind: options.bitcoind,
    nodeStatus: options.nodeStatus,
    hookMode: normalizeHookMode(hook.mode === "unavailable" ? null : hook.mode),
    hookValidationState: hook.validationState === "unavailable" ? null : hook.validationState,
    hookOperatorValidationState: hook.operatorValidationState,
    hookValidationAtUnixMs: hook.validatedAtUnixMs,
    hookCooldownActive: hook.cooldownActive,
    provider: providerInspection,
    nodeHealth: options.nodeHealth,
    indexer: options.indexer,
    tipsAligned,
    lastEventAtUnixMs,
    existingRuntime,
  });

  return {
    runtime,
    hook,
    provider: providerInspection,
    lastEventAtUnixMs,
  };
}

export async function refreshMiningRuntimeStatus(options: {
  provider?: WalletSecretProvider;
  localState: WalletLocalStateStatus;
  bitcoind: WalletBitcoindStatus;
  nodeStatus: WalletNodeStatus | null;
  nodeHealth: MiningRuntimeStatusV1["nodeHealth"];
  indexer: WalletIndexerStatus;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
}): Promise<MiningControlPlaneView> {
  const view = await inspectMiningControlPlane(options);
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  await saveMiningRuntimeStatus(paths.miningStatusPath, view.runtime);
  return view;
}

export async function enableMiningHooks(options: {
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
}): Promise<MiningControlPlaneView> {
  if (!options.prompter.isInteractive) {
    throw new Error("mining_hooks_enable_requires_tty");
  }

  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const controlLock = await acquireFileLock(paths.miningControlLockPath, {
    purpose: "hooks-enable-mining",
  });

  try {
    const preemption = await requestMiningGenerationPreemption({
      paths,
      reason: "hooks-enable-mining",
    });
    const unlocked = await loadOrAutoUnlockWalletState({
      provider,
      nowUnixMs,
      paths,
    });

    try {
      if (unlocked === null) {
        throw new Error("wallet_locked");
      }

      const state = unlocked.state;
      state.hookClientState.mining ??= createDefaultHookState();

      if (state.hookClientState.mining.fullTrustWarningAcknowledgedAtUnixMs === null) {
        options.prompter.writeLine("Enabling a custom mining hook gives local JavaScript code full access to your user account.");
        const confirmation = await options.prompter.prompt("Type TRUST CUSTOM MINING HOOKS to continue: ");

        if (confirmation.trim() !== "TRUST CUSTOM MINING HOOKS") {
          throw new Error("mining_hooks_enable_trust_acknowledgement_required");
        }

        state.hookClientState.mining.fullTrustWarningAcknowledgedAtUnixMs = nowUnixMs;
      }

      const createdTemplate = await ensureMiningHookTemplate({
        hookRootPath: paths.hooksMiningDir,
        entrypointPath: paths.hooksMiningEntrypointPath,
        packagePath: paths.hooksMiningPackageJsonPath,
      });

      if (createdTemplate) {
        await persistWalletMiningHookState({ state, provider, paths });
        await appendMiningEvent(
          paths.miningEventsPath,
          createMiningEvent(
            "custom-hook-template-created",
            "Created the default mining hook template. Edit it, then rerun `cogcoin hooks enable mining`.",
            { timestampUnixMs: nowUnixMs },
          ),
        );
        await refreshMiningRuntimeStatus({
          provider,
          localState: {
            availability: "ready",
            walletRootId: state.walletRootId,
            state,
            source: unlocked.source,
            unlockUntilUnixMs: unlocked.session.unlockUntilUnixMs,
            hasPrimaryStateFile: true,
            hasBackupStateFile: true,
            hasUnlockSessionFile: true,
            message: null,
          },
          bitcoind: {
            health: "unavailable",
            status: null,
            message: "Managed bitcoind status unavailable during hook setup.",
          },
          nodeStatus: null,
          nodeHealth: "unavailable",
          indexer: {
            health: "unavailable",
            status: null,
            message: "Indexer status unavailable during hook setup.",
            snapshotTip: null,
            source: "none",
            daemonInstanceId: null,
            snapshotSeq: null,
            openedAtUnixMs: null,
          },
          nowUnixMs,
          paths,
        });
        throw new Error(`mining_hooks_enable_template_created:${paths.hooksMiningDir}`);
      }

      try {
        const validation = await validateCustomMiningHook({
          hookRootPath: paths.hooksMiningDir,
          entrypointPath: paths.hooksMiningEntrypointPath,
          packagePath: paths.hooksMiningPackageJsonPath,
        });
        state.hookClientState.mining = {
          ...state.hookClientState.mining,
          mode: "custom",
          validationState: "current",
          lastValidationAtUnixMs: nowUnixMs,
          lastValidationError: null,
          validatedLaunchFingerprint: validation.launchFingerprint,
          validatedFullFingerprint: validation.fullFingerprint,
          consecutiveFailureCount: 0,
          cooldownUntilUnixMs: null,
        };
        await persistWalletMiningHookState({ state, provider, paths });
        await appendMiningEvent(
          paths.miningEventsPath,
          createMiningEvent(
            "custom-hook-enabled",
            "Custom mining hook enabled after validation.",
            { timestampUnixMs: nowUnixMs },
          ),
        );
      } catch (error) {
        const validationError = error instanceof Error ? error.message : String(error);
        const consecutiveFailureCount = (state.hookClientState.mining.consecutiveFailureCount ?? 0) + 1;
        state.hookClientState.mining = {
          ...state.hookClientState.mining,
          validationState: "failed",
          lastValidationAtUnixMs: nowUnixMs,
          lastValidationError: validationError,
          validatedLaunchFingerprint: null,
          validatedFullFingerprint: null,
          consecutiveFailureCount,
          cooldownUntilUnixMs: shouldEnterHookCooldown({
            consecutiveFailureCount,
            nowUnixMs,
          }),
        };
        await persistWalletMiningHookState({ state, provider, paths });
        await appendMiningEvent(
          paths.miningEventsPath,
          createMiningEvent(
            "custom-hook-validation-failed",
            state.hookClientState.mining.lastValidationError ?? "Custom mining hook validation failed.",
            {
              level: "error",
              timestampUnixMs: nowUnixMs,
            },
          ),
        );
        throw new Error(`mining_hooks_enable_validation_failed:${validationError}`);
      }

      return refreshMiningRuntimeStatus({
        provider,
        localState: {
          availability: "ready",
          walletRootId: state.walletRootId,
          state,
          source: unlocked.source,
          unlockUntilUnixMs: unlocked.session.unlockUntilUnixMs,
          hasPrimaryStateFile: true,
          hasBackupStateFile: true,
          hasUnlockSessionFile: true,
          message: null,
        },
        bitcoind: {
          health: "unavailable",
          status: null,
          message: "Managed bitcoind status unavailable during hook setup.",
        },
        nodeStatus: null,
        nodeHealth: "unavailable",
        indexer: {
          health: "unavailable",
          status: null,
          message: "Indexer status unavailable during hook setup.",
          snapshotTip: null,
          source: "none",
          daemonInstanceId: null,
          snapshotSeq: null,
          openedAtUnixMs: null,
        },
        nowUnixMs,
        paths,
      });
    } finally {
      await preemption.release();
    }
  } finally {
    await controlLock.release();
  }
}

export async function disableMiningHooks(options: {
  provider?: WalletSecretProvider;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
}): Promise<MiningControlPlaneView> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const controlLock = await acquireFileLock(paths.miningControlLockPath, {
    purpose: "hooks-disable-mining",
  });

  try {
    const preemption = await requestMiningGenerationPreemption({
      paths,
      reason: "hooks-disable-mining",
    });
    const unlocked = await loadOrAutoUnlockWalletState({
      provider,
      nowUnixMs,
      paths,
    });

    try {
      if (unlocked === null) {
        throw new Error("wallet_locked");
      }

      const state = unlocked.state;
      state.hookClientState.mining = {
        ...createDefaultHookState(),
        mode: "builtin",
        fullTrustWarningAcknowledgedAtUnixMs: state.hookClientState.mining?.fullTrustWarningAcknowledgedAtUnixMs ?? null,
      };
      await persistWalletMiningHookState({ state, provider, paths });
      await appendMiningEvent(
        paths.miningEventsPath,
        createMiningEvent(
          "custom-hook-disabled",
          "Custom mining hook disabled. Built-in mining mode is active again.",
          { timestampUnixMs: nowUnixMs },
        ),
      );

      return refreshMiningRuntimeStatus({
        provider,
        localState: {
          availability: "ready",
          walletRootId: state.walletRootId,
          state,
          source: unlocked.source,
          unlockUntilUnixMs: unlocked.session.unlockUntilUnixMs,
          hasPrimaryStateFile: true,
          hasBackupStateFile: true,
          hasUnlockSessionFile: true,
          message: null,
        },
        bitcoind: {
          health: "unavailable",
          status: null,
          message: "Managed bitcoind status unavailable during hook setup.",
        },
        nodeStatus: null,
        nodeHealth: "unavailable",
        indexer: {
          health: "unavailable",
          status: null,
          message: "Indexer status unavailable during hook setup.",
          snapshotTip: null,
          source: "none",
          daemonInstanceId: null,
          snapshotSeq: null,
          openedAtUnixMs: null,
        },
        nowUnixMs,
        paths,
      });
    } finally {
      await preemption.release();
    }
  } finally {
    await controlLock.release();
  }
}

function normalizeProviderChoice(raw: string): "openai" | "anthropic" | null {
  const value = raw.trim().toLowerCase();
  return value === "openai" || value === "anthropic" ? value : null;
}

function writeBuiltInMiningProviderDisclosure(prompter: WalletPrompter): void {
  prompter.writeLine("Built-in mining provider disclosure:");
  prompter.writeLine("The built-in mining hook will send the following to the selected provider:");
  prompter.writeLine("- eligible anchored root domain names");
  prompter.writeLine("- the required five words for each root domain");
  prompter.writeLine("- target block height");
  prompter.writeLine("- referenced previous-block hash");
  prompter.writeLine("- optional extra prompt when configured");
}

async function promptForMiningProviderConfig(prompter: WalletPrompter): Promise<MiningProviderConfigRecord> {
  writeBuiltInMiningProviderDisclosure(prompter);
  const providerInput = await prompter.prompt("Provider (openai/anthropic): ");
  const provider = normalizeProviderChoice(providerInput);

  if (provider === null) {
    throw new Error("mining_setup_invalid_provider");
  }

  const apiKey = (await prompter.prompt("API key: ")).trim();

  if (apiKey.length === 0) {
    throw new Error("mining_setup_missing_api_key");
  }

  const extraPrompt = (await prompter.prompt("Extra prompt (optional, blank for none): ")).trim();
  const modelOverride = (await prompter.prompt("Model override (optional, blank for default): ")).trim();

  return {
    provider,
    apiKey,
    extraPrompt: extraPrompt.length === 0 ? null : extraPrompt,
    modelOverride: modelOverride.length === 0 ? null : modelOverride,
    updatedAtUnixMs: Date.now(),
  };
}

export async function setupBuiltInMining(options: {
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
}): Promise<MiningControlPlaneView> {
  if (!options.prompter.isInteractive) {
    throw new Error("mine_setup_requires_tty");
  }

  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const controlLock = await acquireFileLock(paths.miningControlLockPath, {
    purpose: "mine-setup",
  });

  try {
    const preemption = await requestMiningGenerationPreemption({
      paths,
      reason: "mine-setup",
    });
    const unlocked = await loadOrAutoUnlockWalletState({
      provider,
      nowUnixMs,
      paths,
    });

    try {
      if (unlocked === null) {
        throw new Error("wallet_locked");
      }

      const state = unlocked.state;
      await appendMiningEvent(
        paths.miningEventsPath,
        createMiningEvent(
          "mine-setup-started",
          "Started built-in mining provider setup.",
          { timestampUnixMs: nowUnixMs },
        ),
      );

      try {
        const config = await promptForMiningProviderConfig(options.prompter);
        config.updatedAtUnixMs = nowUnixMs;
        await saveBuiltInMiningProviderConfig({
          path: paths.clientConfigPath,
          provider,
          secretReference: createWalletSecretReference(state.walletRootId),
          config,
        });

        state.hookClientState.mining ??= createDefaultHookState();
        if (state.hookClientState.mining.mode === "disabled") {
          state.hookClientState.mining.mode = "builtin";
        }
        await persistWalletMiningHookState({ state, provider, paths });
        await appendMiningEvent(
          paths.miningEventsPath,
          createMiningEvent(
            "mine-setup-completed",
            `Configured the built-in ${config.provider} mining provider.`,
            { timestampUnixMs: nowUnixMs },
          ),
        );

        return refreshMiningRuntimeStatus({
          provider,
          localState: {
            availability: "ready",
            walletRootId: state.walletRootId,
            state,
            source: unlocked.source,
            unlockUntilUnixMs: unlocked.session.unlockUntilUnixMs,
            hasPrimaryStateFile: true,
            hasBackupStateFile: true,
            hasUnlockSessionFile: true,
            message: null,
          },
          bitcoind: {
            health: "unavailable",
            status: null,
            message: "Managed bitcoind status unavailable during mining setup.",
          },
          nodeStatus: null,
          nodeHealth: "unavailable",
          indexer: {
            health: "unavailable",
            status: null,
            message: "Indexer status unavailable during mining setup.",
            snapshotTip: null,
            source: "none",
            daemonInstanceId: null,
            snapshotSeq: null,
            openedAtUnixMs: null,
          },
          nowUnixMs,
          paths,
        });
      } catch (error) {
        await appendMiningEvent(
          paths.miningEventsPath,
          createMiningEvent(
            "mine-setup-failed",
            error instanceof Error ? error.message : String(error),
            {
              level: "error",
              timestampUnixMs: nowUnixMs,
            },
          ),
        );
        throw error;
      }
    } finally {
      await preemption.release();
    }
  } finally {
    await controlLock.release();
  }
}

export async function readMiningLog(options: {
  paths?: WalletRuntimePaths;
  limit?: number | null;
  all?: boolean;
}): Promise<MiningEventRecord[]> {
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  return readMiningEvents({
    eventsPath: paths.miningEventsPath,
    limit: options.limit,
    all: options.all,
  });
}

export async function followMiningLog(options: {
  paths?: WalletRuntimePaths;
  signal?: AbortSignal;
  onEvent: (event: MiningEventRecord) => void;
}): Promise<void> {
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  return followMiningEvents({
    eventsPath: paths.miningEventsPath,
    signal: options.signal,
    onEvent: options.onEvent,
  });
}
