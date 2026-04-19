import { acquireFileLock } from "../fs/lock.js";
import type { WalletPrompter } from "../lifecycle.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../runtime.js";
import {
  createDefaultWalletSecretProvider,
  createWalletSecretReference,
  type WalletSecretProvider,
} from "../state/provider.js";
import { loadWalletState } from "../state/storage.js";
import { isRootDomainName } from "../read/filter.js";
import type {
  WalletBitcoindStatus,
  WalletIndexerStatus,
  WalletLocalStateStatus,
  WalletNodeStatus,
} from "../read/types.js";
import {
  appendMiningEvent,
  getLastMiningEventTimestamp,
  loadMiningRuntimeStatus,
  readMiningEvents,
  saveMiningRuntimeStatus,
  followMiningEvents,
} from "./runtime-artifacts.js";
import { requestMiningGenerationPreemption } from "./coordination.js";
import { normalizeMiningPublishState, normalizeMiningStateRecord } from "./state.js";
import { loadClientConfig, saveBuiltInMiningProviderConfig } from "./config.js";
import type {
  MiningControlPlaneView,
  MiningEventRecord,
  MiningProviderConfigByProvider,
  MiningModelSelectionSource,
  MiningProviderConfigRecord,
  MiningProviderInspection,
  MiningProviderKind,
  MiningRuntimeStatusV1,
} from "./types.js";
import {
  MINING_WORKER_API_VERSION,
  MINING_WORKER_HEARTBEAT_STALE_MS,
} from "./constants.js";
import {
  estimateBuiltInModelDailyCost,
  getBuiltInProviderModelCatalog,
  getRecommendedBuiltInProviderModel,
  MINING_MODEL_DAILY_COST_ESTIMATE_ASSUMPTION,
  resolveBuiltInProviderSelection,
} from "./provider-model.js";

const KEEP_CURRENT_MODEL_SELECTION = "__keep_current__";

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
  eligibleRootCount: number | null;
}): MiningProviderInspection {
  if (options.error !== null) {
    return {
      configured: false,
      provider: null,
      status: "error",
      message: options.error,
      modelId: null,
      effectiveModel: null,
      modelOverride: null,
      modelSelectionSource: null,
      usingDefaultModel: null,
      extraPromptConfigured: false,
      estimatedDailyCostUsd: null,
      estimatedDailyCostDisplay: null,
    };
  }

  if (options.config === null) {
    return {
      configured: false,
      provider: null,
      status: "missing",
      message: "Built-in mining provider is not configured yet.",
      modelId: null,
      effectiveModel: null,
      modelOverride: null,
      modelSelectionSource: null,
      usingDefaultModel: null,
      extraPromptConfigured: false,
      estimatedDailyCostUsd: null,
      estimatedDailyCostDisplay: null,
    };
  }

  const selection = resolveBuiltInProviderSelection(options.config);
  const estimate = options.eligibleRootCount === null
    ? null
    : estimateBuiltInModelDailyCost(
      options.config.provider,
      selection.modelId,
      options.eligibleRootCount,
    );

  return {
    configured: true,
    provider: options.config.provider,
    status: "ready",
    message: null,
    modelId: selection.modelId,
    effectiveModel: selection.effectiveModel,
    modelOverride: options.config.modelOverride,
    modelSelectionSource: selection.modelSelectionSource,
    usingDefaultModel: selection.usingDefaultModel,
    extraPromptConfigured: options.config.extraPrompt !== null && options.config.extraPrompt.length > 0,
    estimatedDailyCostUsd: estimate?.estimatedDailyCostUsd ?? null,
    estimatedDailyCostDisplay: estimate?.estimatedDailyCostDisplay ?? null,
  };
}

function countEligibleAnchoredRoots(localState: WalletLocalStateStatus): number | null {
  const state = localState.state;

  if (state === null || state === undefined) {
    return null;
  }

  let count = 0;
  for (const domain of state.domains) {
    if (
      isRootDomainName(domain.name)
      && domain.canonicalChainStatus === "anchored"
      && domain.currentOwnerScriptPubKeyHex === state.funding.scriptPubKeyHex
    ) {
      count += 1;
    }
  }

  return count;
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

  if (existingRuntime?.currentPhase === "waiting-provider" && existingRuntime.providerState !== null) {
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

async function buildMiningRuntimeSnapshot(options: {
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
    lastError: existing?.lastError ?? options.provider.message ?? options.indexer.message ?? null,
    note: state?.pauseReason === "zero-reward"
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
  const providerInspection = buildProviderInspection({
    ...providerConfig,
    eligibleRootCount: countEligibleAnchoredRoots(options.localState),
  });
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
    provider: providerInspection,
    nodeHealth: options.nodeHealth,
    indexer: options.indexer,
    tipsAligned,
    lastEventAtUnixMs,
    existingRuntime,
  });

  return {
    runtime,
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

function normalizeProviderChoice(raw: string): "openai" | "anthropic" | null {
  const value = raw.trim().toLowerCase();
  return value === "openai" || value === "anthropic" ? value : null;
}

function describeModelSelectionSource(source: MiningModelSelectionSource): string {
  switch (source) {
    case "catalog":
      return "catalog";
    case "custom":
      return "custom";
    case "legacy-default":
      return "legacy-default";
    case "legacy-custom":
      return "legacy-custom";
    default:
      throw new Error(`unsupported_model_selection_source:${String(source)}`);
  }
}

function writeBuiltInMiningProviderDisclosure(prompter: WalletPrompter): void {
  prompter.writeLine("Built-in mining provider disclosure:");
  prompter.writeLine("The built-in mining provider will send the following to the selected provider:");
  prompter.writeLine("- eligible anchored root domain names");
  prompter.writeLine("- the required five words for each root domain");
  prompter.writeLine("- target block height");
  prompter.writeLine("- referenced previous-block hash");
  prompter.writeLine("- optional extra prompt when configured");
}

async function promptForMiningProviderModelSelectionFallback(
  prompter: WalletPrompter,
  options: NonNullable<WalletPrompter["selectOption"]> extends (options: infer T) => Promise<string> ? T : never,
): Promise<string> {
  prompter.writeLine(options.message);
  for (const [index, option] of options.options.entries()) {
    const description = option.description == null || option.description.length === 0
      ? ""
      : ` - ${option.description}`;
    prompter.writeLine(`${index + 1}. ${option.label}${description}`);
  }
  if (options.footer != null && options.footer.length > 0) {
    prompter.writeLine(options.footer);
  }

  while (true) {
    const answer = (await prompter.prompt(`Choice [1-${options.options.length}]: `)).trim();

    if (/^(q|quit|esc|escape)$/i.test(answer)) {
      throw new Error("mining_setup_canceled");
    }

    const choice = Number.parseInt(answer, 10);

    if (Number.isInteger(choice) && choice >= 1 && choice <= options.options.length) {
      return options.options[choice - 1]!.value;
    }

    prompter.writeLine(`Enter a number from 1 to ${options.options.length}, or q to cancel.`);
  }
}

function formatMiningProviderDisplayName(provider: MiningProviderKind): string {
  return provider === "openai" ? "OpenAI" : "Anthropic";
}

async function promptMiningSetupYesNo(
  prompter: WalletPrompter,
  message: string,
  defaultAnswer: boolean,
): Promise<boolean> {
  const prompt = `${message}${defaultAnswer ? " [Y/n]: " : " [y/N]: "}`;

  while (true) {
    const answer = (await prompter.prompt(prompt)).trim().toLowerCase();

    if (answer.length === 0) {
      return defaultAnswer;
    }

    if (answer === "y" || answer === "yes") {
      return true;
    }

    if (answer === "n" || answer === "no") {
      return false;
    }

    if (answer === "q" || answer === "quit" || answer === "esc" || answer === "escape") {
      throw new Error("mining_setup_canceled");
    }

    prompter.writeLine("Enter y or n, or q to cancel.");
  }
}

function buildMiningProviderModelSelectorOptions(
  provider: MiningProviderKind,
  eligibleRootCount: number,
  currentConfig: MiningProviderConfigRecord | null,
): {
  initialValue: string | null;
  options: Array<{
    label: string;
    description: string | null;
    value: string;
  }>;
} {
  const catalogOptions = getBuiltInProviderModelCatalog(provider).map((entry) => {
    const estimate = estimateBuiltInModelDailyCost(provider, entry.modelId, eligibleRootCount);
    return {
      label: entry.label,
      description: `${entry.modelId} - ${estimate?.estimatedDailyCostDisplay ?? "n/a"}`,
      value: entry.modelId,
    };
  });
  const selection = currentConfig === null ? null : resolveBuiltInProviderSelection(currentConfig);
  const options = [...catalogOptions];
  let initialValue: string | null = getRecommendedBuiltInProviderModel(provider);

  if (selection !== null) {
    if (selection.modelSelectionSource === "custom" || selection.modelSelectionSource === "legacy-custom") {
      initialValue = "custom";
    } else if (catalogOptions.some((entry) => entry.value === selection.modelId)) {
      initialValue = selection.modelId;
    } else {
      options.push({
        label: "Current configured model",
        description: `${selection.modelId} - current saved setting`,
        value: KEEP_CURRENT_MODEL_SELECTION,
      });
      initialValue = KEEP_CURRENT_MODEL_SELECTION;
    }
  }

  options.push({
    label: "Custom model ID...",
    description: "",
    value: "custom",
  });

  return {
    initialValue,
    options,
  };
}

async function promptForMiningProviderConfig(
  prompter: WalletPrompter,
  eligibleRootCount: number,
  options: {
    currentConfig?: MiningProviderConfigRecord | null;
    rememberedConfigs?: MiningProviderConfigByProvider;
  } = {},
): Promise<MiningProviderConfigRecord> {
  writeBuiltInMiningProviderDisclosure(prompter);
  const currentConfig = options.currentConfig ?? null;
  const rememberedConfigs = options.rememberedConfigs ?? {};
  let provider: MiningProviderKind;
  let rememberedConfig = currentConfig;
  let reuseSavedApiKey = false;

  if (currentConfig !== null) {
    const useDifferentProviderOrApiKey = await promptMiningSetupYesNo(
      prompter,
      "Use a different provider or API key?",
      false,
    );

    if (!useDifferentProviderOrApiKey) {
      provider = currentConfig.provider;
      reuseSavedApiKey = true;
    } else {
      const providerInput = await prompter.prompt("Provider (openai/anthropic): ");
      const selectedProvider = normalizeProviderChoice(providerInput);

      if (selectedProvider === null) {
        throw new Error("mining_setup_invalid_provider");
      }

      provider = selectedProvider;
      rememberedConfig = rememberedConfigs[provider] ?? null;
      if (rememberedConfig !== null) {
        reuseSavedApiKey = await promptMiningSetupYesNo(
          prompter,
          `Use saved ${formatMiningProviderDisplayName(provider)} API key?`,
          true,
        );
      }
    }
  } else {
    const providerInput = await prompter.prompt("Provider (openai/anthropic): ");
    const selectedProvider = normalizeProviderChoice(providerInput);

    if (selectedProvider === null) {
      throw new Error("mining_setup_invalid_provider");
    }

    provider = selectedProvider;
    rememberedConfig = rememberedConfigs[provider] ?? null;
    if (rememberedConfig !== null) {
      reuseSavedApiKey = await promptMiningSetupYesNo(
        prompter,
        `Use saved ${formatMiningProviderDisplayName(provider)} API key?`,
        true,
      );
    }
  }

  const selectorModelOptions = buildMiningProviderModelSelectorOptions(provider, eligibleRootCount, rememberedConfig);
  const selectorOptions = {
    message: "Choose the mining model:",
    options: selectorModelOptions.options,
    initialValue: selectorModelOptions.initialValue,
    footer: MINING_MODEL_DAILY_COST_ESTIMATE_ASSUMPTION,
  };
  const selectedModelId = prompter.selectOption == null
    ? await promptForMiningProviderModelSelectionFallback(prompter, selectorOptions)
    : await prompter.selectOption(selectorOptions);
  let modelSelectionSource: MiningModelSelectionSource;
  let modelOverride: string | null;

  if (selectedModelId === KEEP_CURRENT_MODEL_SELECTION) {
    if (rememberedConfig === null) {
      throw new Error("mining_setup_missing_model_id");
    }

    modelSelectionSource = rememberedConfig.modelSelectionSource;
    modelOverride = rememberedConfig.modelOverride;
  } else if (selectedModelId === "custom") {
    const currentCustomModel = rememberedConfig !== null
      && (rememberedConfig.modelSelectionSource === "custom" || rememberedConfig.modelSelectionSource === "legacy-custom")
      ? rememberedConfig.modelOverride
      : null;
    const customModelId = (await prompter.prompt(
      currentCustomModel === null
        ? "Custom model ID: "
        : `Custom model ID (blank to keep current: ${currentCustomModel}): `,
    )).trim();

    if (customModelId.length === 0) {
      if (currentCustomModel === null) {
        throw new Error("mining_setup_missing_model_id");
      }

      modelSelectionSource = rememberedConfig?.modelSelectionSource ?? "custom";
      modelOverride = currentCustomModel;
    } else {
      modelSelectionSource = "custom";
      modelOverride = customModelId;
    }
  } else {
    modelSelectionSource = "catalog";
    modelOverride = selectedModelId;
  }

  const apiKey = reuseSavedApiKey && rememberedConfig !== null
    ? rememberedConfig.apiKey
    : (await prompter.prompt("API key: ")).trim();

  if (apiKey.length === 0) {
    throw new Error("mining_setup_missing_api_key");
  }

  const extraPromptInput = (await prompter.prompt(
    rememberedConfig === null
      ? "Extra prompt (optional, blank for none): "
      : `Extra prompt (optional, blank to keep current: ${rememberedConfig.extraPrompt ?? "none"}): `,
  )).trim();
  const extraPrompt = extraPromptInput.length === 0
    ? rememberedConfig?.extraPrompt ?? null
    : extraPromptInput;

  return {
    provider,
    apiKey,
    extraPrompt: extraPrompt === null || extraPrompt.length === 0 ? null : extraPrompt,
    modelOverride,
    modelSelectionSource,
    updatedAtUnixMs: Date.now(),
  };
}

export async function promptForMiningProviderConfigForTesting(
  prompter: WalletPrompter,
  eligibleRootCount: number,
  options: {
    currentConfig?: MiningProviderConfigRecord | null;
    rememberedConfigs?: MiningProviderConfigByProvider;
  } = {},
): Promise<MiningProviderConfigRecord> {
  return await promptForMiningProviderConfig(prompter, eligibleRootCount, options);
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
    try {
      const loaded = await loadWalletState({
        primaryPath: paths.walletStatePath,
        backupPath: paths.walletStateBackupPath,
      }, {
        provider,
      });
      const localState: WalletLocalStateStatus = {
        availability: "ready",
        clientPasswordReadiness: "ready",
        unlockRequired: false,
        walletRootId: loaded.state.walletRootId,
        state: loaded.state,
        source: loaded.source,
        hasPrimaryStateFile: true,
        hasBackupStateFile: true,
        message: null,
      };
      const eligibleRootCount = countEligibleAnchoredRoots(localState) ?? 0;
      const clientConfig = await loadClientConfig({
        path: paths.clientConfigPath,
        provider,
      }).catch(() => null);

      await appendMiningEvent(
        paths.miningEventsPath,
        createMiningEvent(
          "mine-setup-started",
          "Started built-in mining provider setup.",
          { timestampUnixMs: nowUnixMs },
        ),
      );

      try {
        const config = await promptForMiningProviderConfig(options.prompter, eligibleRootCount, {
          currentConfig: clientConfig?.mining.builtIn ?? null,
          rememberedConfigs: clientConfig?.mining.builtInByProvider ?? {},
        });
        config.updatedAtUnixMs = nowUnixMs;
        await saveBuiltInMiningProviderConfig({
          path: paths.clientConfigPath,
          provider,
          secretReference: createWalletSecretReference(loaded.state.walletRootId),
          config,
        });
        await appendMiningEvent(
          paths.miningEventsPath,
          createMiningEvent(
            "mine-setup-completed",
            `Configured the built-in ${config.provider} mining provider with model ${config.modelOverride} (${describeModelSelectionSource(config.modelSelectionSource)}).`,
            { timestampUnixMs: nowUnixMs },
          ),
        );

        return refreshMiningRuntimeStatus({
          provider,
          localState,
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
        if (error instanceof Error && error.message === "mining_setup_canceled") {
          await appendMiningEvent(
            paths.miningEventsPath,
            createMiningEvent(
              "mine-setup-canceled",
              "Canceled built-in mining provider setup.",
              {
                level: "warn",
                timestampUnixMs: nowUnixMs,
              },
            ),
          );
          throw error;
        }
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
