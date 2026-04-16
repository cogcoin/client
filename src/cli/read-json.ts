import { getBalance } from "@cogcoin/indexer/queries";

import {
  findDomainField,
  findWalletDomain,
  listDomainFields,
  listWalletLocks,
} from "../wallet/read/index.js";
import type {
  WalletDomainView,
  WalletFieldView,
  WalletLockView,
  WalletReadContext,
} from "../wallet/read/index.js";
import type { MiningControlPlaneView, MiningEventRecord } from "../wallet/mining/index.js";
import type { PendingMutationRecord } from "../wallet/types.js";
import type { JsonAvailabilityEntry, JsonPage } from "./output.js";
import {
  getAddressNextSteps,
  getBootstrapSyncNextStep,
  getFundingQuickstartGuidance,
  getIdsNextSteps,
  getLocksNextSteps,
} from "./workflow-hints.js";
import { getMutationRecommendation, getRepairRecommendation } from "./wallet-format.js";

export interface ReadJsonResult<T> {
  data: T;
  warnings: string[];
  explanations: string[];
  nextSteps: string[];
}

function decimalOrNull(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

function nonEmptyMessage(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.length === 0 ? null : value;
}

function isBitcoindAvailable(health: WalletReadContext["bitcoind"]["health"]): boolean {
  return health === "ready" || health === "starting";
}

function createBaseMessages(context: WalletReadContext): {
  warnings: string[];
  explanations: string[];
  nextSteps: string[];
} {
  const warnings: string[] = [];
  const explanations: string[] = [];
  const nextSteps: string[] = [];

  if (context.localState.availability !== "ready") {
    warnings.push(`Wallet state is ${context.localState.availability}.`);
  }

  if (context.nodeHealth !== "synced") {
    warnings.push(`Bitcoin publishability is ${context.nodeHealth}.`);
  }

  if (context.bitcoind.health !== "ready") {
    warnings.push(`Managed bitcoind is ${context.bitcoind.health}.`);
  }

  if (context.indexer.health !== "synced") {
    warnings.push(`Indexer service is ${context.indexer.health}.`);
  }

  const repairRecommendation = getRepairRecommendation(context);
  if (repairRecommendation !== null) {
    nextSteps.push(repairRecommendation);
  }

  if (repairRecommendation === null) {
    const bootstrapSync = getBootstrapSyncNextStep(context);
    if (bootstrapSync !== null) {
      nextSteps.push(bootstrapSync);
    }
  }

  const mutationRecommendation = getMutationRecommendation(context);
  if (mutationRecommendation !== null) {
    nextSteps.push(mutationRecommendation);
  }

  const localMessage = nonEmptyMessage(context.localState.message);
  if (localMessage !== null) {
    explanations.push(localMessage);
  }

  const nodeMessage = nonEmptyMessage(context.nodeMessage);
  if (nodeMessage !== null) {
    explanations.push(nodeMessage);
  }

  const bitcoindMessage = nonEmptyMessage(context.bitcoind.message);
  if (bitcoindMessage !== null) {
    explanations.push(bitcoindMessage);
  }

  const indexerMessage = nonEmptyMessage(context.indexer.message);
  if (indexerMessage !== null) {
    explanations.push(indexerMessage);
  }

  if (context.mining?.runtime.note !== null && context.mining?.runtime.note !== undefined) {
    explanations.push(context.mining.runtime.note);
  }

  return {
    warnings: dedupeStrings(warnings),
    explanations: dedupeStrings(explanations),
    nextSteps: dedupeStrings(nextSteps),
  };
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

export function buildAvailability(context: WalletReadContext): Record<string, JsonAvailabilityEntry> {
  const availability: Record<string, JsonAvailabilityEntry> = {
    wallet: {
      available: context.localState.availability === "ready",
      stale: false,
      reason: context.localState.message,
      state: context.localState.availability,
    },
    bitcoind: {
      available: isBitcoindAvailable(context.bitcoind.health),
      stale: context.bitcoind.health === "starting",
      reason: context.bitcoind.message,
      state: context.bitcoind.health,
      publishState: context.nodeHealth,
      replicaStatus: context.nodeStatus?.walletReplica?.proofStatus ?? context.bitcoind.status?.walletReplica?.proofStatus ?? null,
      serviceApiVersion: context.bitcoind.status?.serviceApiVersion ?? null,
      binaryVersion: context.bitcoind.status?.binaryVersion ?? null,
      buildId: context.bitcoind.status?.buildId ?? null,
      serviceInstanceId: context.bitcoind.status?.serviceInstanceId ?? null,
      processId: context.bitcoind.status?.processId ?? null,
      walletRootId: context.bitcoind.status?.walletRootId ?? context.nodeStatus?.walletRootId ?? null,
      chain: context.bitcoind.status?.chain ?? context.nodeStatus?.chain ?? null,
      dataDir: context.bitcoind.status?.dataDir ?? context.dataDir,
      runtimeRoot: context.bitcoind.status?.runtimeRoot ?? null,
      startedAtUnixMs: context.bitcoind.status?.startedAtUnixMs ?? null,
      heartbeatAtUnixMs: context.bitcoind.status?.heartbeatAtUnixMs ?? null,
      updatedAtUnixMs: context.bitcoind.status?.updatedAtUnixMs ?? null,
      lastError: context.bitcoind.status?.lastError ?? null,
      coreBestHeight: context.nodeStatus?.nodeBestHeight ?? null,
      coreBestHash: context.nodeStatus?.nodeBestHashHex ?? null,
    },
    indexer: {
      available: context.indexer.health !== "unavailable"
        && context.indexer.health !== "failed"
        && context.indexer.health !== "schema-mismatch"
        && context.indexer.health !== "service-version-mismatch"
        && context.indexer.health !== "wallet-root-mismatch",
      stale: context.indexer.health === "stale-heartbeat"
        || context.indexer.health === "catching-up"
        || context.indexer.health === "reorging"
        || context.indexer.health === "starting",
      reason: context.indexer.message,
      state: context.indexer.health,
      source: context.indexer.source ?? (context.indexer.status === null ? "none" : "probe"),
      serviceApiVersion: context.indexer.status?.serviceApiVersion ?? null,
      binaryVersion: context.indexer.status?.binaryVersion ?? null,
      buildId: context.indexer.status?.buildId ?? null,
      schemaVersion: context.indexer.status?.schemaVersion ?? null,
      daemonInstanceId: context.indexer.daemonInstanceId ?? context.indexer.status?.daemonInstanceId ?? null,
      processId: context.indexer.status?.processId ?? null,
      walletRootId: context.indexer.status?.walletRootId ?? null,
      startedAtUnixMs: context.indexer.status?.startedAtUnixMs ?? null,
      updatedAtUnixMs: context.indexer.status?.updatedAtUnixMs ?? null,
      snapshotSeq: context.indexer.snapshotSeq ?? context.indexer.status?.snapshotSeq ?? null,
      openedAtUnixMs: context.indexer.openedAtUnixMs,
      heartbeatAtUnixMs: context.indexer.status?.heartbeatAtUnixMs ?? null,
      activeSnapshotCount: context.indexer.status?.activeSnapshotCount ?? null,
      backlogBlocks: context.indexer.status?.backlogBlocks ?? null,
      reorgDepth: context.indexer.status?.reorgDepth ?? null,
      lastError: context.indexer.status?.lastError ?? null,
      appliedTipHeight: context.indexer.snapshotTip?.height ?? context.indexer.status?.appliedTipHeight ?? null,
      appliedTipHash: context.indexer.snapshotTip?.blockHashHex ?? context.indexer.status?.appliedTipHash ?? null,
      coreBestHeight: context.nodeStatus?.nodeBestHeight ?? context.indexer.status?.coreBestHeight ?? null,
      coreBestHash: context.nodeStatus?.nodeBestHashHex ?? context.indexer.status?.coreBestHash ?? null,
    },
  };

  if (context.mining !== undefined) {
    availability.hooks = {
      available: context.mining.hook.mode !== "unavailable",
      stale: context.mining.hook.operatorValidationState === "stale",
      reason: context.mining.hook.validationError ?? context.mining.hook.trustMessage,
      state: context.mining.hook.validationState,
      operatorValidationState: context.mining.hook.operatorValidationState,
      cooldownActive: context.mining.hook.cooldownActive,
    };
    availability.backgroundWorker = {
      available: context.mining.runtime.backgroundWorkerPid !== null,
      stale: context.mining.runtime.backgroundWorkerHealth === "stale-heartbeat"
        || context.mining.runtime.backgroundWorkerHealth === "stale-pid"
        || context.mining.runtime.backgroundWorkerHealth === "version-mismatch",
      reason: context.mining.runtime.note,
      state: context.mining.runtime.backgroundWorkerHealth,
    };
  }

  return availability;
}

function walletCogBalance(context: WalletReadContext): bigint | null {
  if (context.snapshot === null || context.model === null) {
    return null;
  }

  return getBalance(
    context.snapshot.state,
    new Uint8Array(Buffer.from(context.model.walletScriptPubKeyHex, "hex")),
  );
}

function mapWalletAddress(context: WalletReadContext) {
  const localDomains = context.model === null
    ? []
    : context.model.domains
      .filter((domain) => domain.localRelationship === "local")
      .map((domain) => domain.name)
      .sort((left, right) => left.localeCompare(right));

  return {
    address: context.model?.walletAddress ?? null,
    scriptPubKeyHex: context.model?.walletScriptPubKeyHex ?? null,
    localDomains,
    observedCogBalance: decimalOrNull(walletCogBalance(context)),
  };
}

function mapDomain(domain: WalletDomainView) {
  return {
    name: domain.name,
    domainId: domain.domainId,
    anchored: domain.anchored,
    ownerScriptPubKeyHex: domain.ownerScriptPubKeyHex,
    ownerAddress: domain.ownerAddress,
    localRelationship: domain.localRelationship,
    chainStatus: domain.chainStatus,
    foundingMessageText: domain.foundingMessageText,
    endpointText: domain.endpointText,
    delegateScriptPubKeyHex: domain.delegateScriptPubKeyHex,
    minerScriptPubKeyHex: domain.minerScriptPubKeyHex,
    fieldCount: domain.fieldCount,
    listingPriceCogtoshi: decimalOrNull(domain.listingPriceCogtoshi),
    activeLockCount: domain.activeLockCount,
    selfStakeCogtoshi: decimalOrNull(domain.selfStakeCogtoshi),
    supportedStakeCogtoshi: decimalOrNull(domain.supportedStakeCogtoshi),
    totalSupportedCogtoshi: decimalOrNull(domain.totalSupportedCogtoshi),
    totalRevokedCogtoshi: decimalOrNull(domain.totalRevokedCogtoshi),
    readOnly: domain.readOnly,
  };
}

function mapField(field: WalletFieldView) {
  return {
    domainName: field.domainName,
    domainId: field.domainId,
    fieldId: field.fieldId,
    name: field.name,
    permanent: field.permanent,
    hasValue: field.hasValue,
    format: field.format,
    preview: field.preview,
    rawValueHex: field.rawValueHex,
  };
}

function mapLock(lock: WalletLockView) {
  return {
    lockId: lock.lockId,
    status: lock.status,
    amountCogtoshi: lock.amountCogtoshi.toString(),
    timeoutHeight: lock.timeoutHeight,
    lockerScriptPubKeyHex: lock.lockerScriptPubKeyHex,
    lockerLocalIndex: lock.lockerLocalIndex,
    recipientDomainId: lock.recipientDomainId,
    recipientDomainName: lock.recipientDomainName,
    recipientLocal: lock.recipientLocal,
    claimableNow: lock.claimableNow,
    reclaimableNow: lock.reclaimableNow,
  };
}

function listPendingMutationsForDomain(
  context: WalletReadContext,
  domainName: string,
): PendingMutationRecord[] {
  return (context.localState.state?.pendingMutations ?? [])
    .filter((mutation) =>
      (mutation.domainName === domainName || mutation.recipientDomainName === domainName)
      && mutation.status !== "confirmed"
      && mutation.status !== "canceled",
    );
}

function mapPendingMutation(mutation: PendingMutationRecord) {
  return {
    kind: mutation.kind,
    domainName: mutation.domainName,
    recipientDomainName: mutation.recipientDomainName ?? null,
    fieldName: mutation.fieldName ?? null,
    status: mutation.status,
    senderScriptPubKeyHex: mutation.senderScriptPubKeyHex,
    recipientScriptPubKeyHex: mutation.recipientScriptPubKeyHex ?? null,
    amountCogtoshi: decimalOrNull(mutation.amountCogtoshi),
    priceCogtoshi: decimalOrNull(mutation.priceCogtoshi),
    lockId: mutation.lockId ?? null,
    txid: mutation.attemptedTxid ?? null,
    wtxid: mutation.attemptedWtxid ?? null,
    reviewPresent: mutation.reviewPayloadHex !== null && mutation.reviewPayloadHex !== undefined,
  };
}

function buildMiningStatusData(mining: MiningControlPlaneView) {
  return {
    runMode: mining.runtime.runMode,
    state: mining.runtime.miningState,
    bitcoindHealth: mining.runtime.bitcoindHealth,
    bitcoindServiceState: mining.runtime.bitcoindServiceState,
    managedCoreReplicaStatus: mining.runtime.bitcoindReplicaStatus,
    publishHealth: mining.runtime.nodeHealth,
    indexerHealth: mining.runtime.indexerHealth,
    indexerDaemonState: mining.runtime.indexerDaemonState,
    indexerTruthSource: mining.runtime.indexerTruthSource,
    indexerDaemonInstanceId: mining.runtime.indexerDaemonInstanceId,
    indexerSnapshotSeq: mining.runtime.indexerSnapshotSeq,
    indexerSnapshotOpenedAtUnixMs: mining.runtime.indexerSnapshotOpenedAtUnixMs,
    indexerReorgDepth: mining.runtime.indexerReorgDepth,
    tipHeight: mining.runtime.indexerTipHeight ?? mining.runtime.coreBestHeight,
    referencedBlockHashDisplay: mining.runtime.referencedBlockHashDisplay,
    currentDomain: mining.runtime.currentDomainName === null && mining.runtime.currentDomainId === null
      ? null
      : {
        domainId: mining.runtime.currentDomainId,
        name: mining.runtime.currentDomainName,
      },
    liveMiningFamilyInMempool: mining.runtime.liveMiningFamilyInMempool,
    publishDecision: mining.runtime.currentPublishDecision,
    fees: {
      currentFeeRateSatVb: mining.runtime.currentFeeRateSatVb,
      currentAbsoluteFeeSats: mining.runtime.currentAbsoluteFeeSats === null ? null : String(mining.runtime.currentAbsoluteFeeSats),
      currentBlockFeeSpentSats: mining.runtime.currentBlockFeeSpentSats,
      sessionFeeSpentSats: mining.runtime.sessionFeeSpentSats,
      lifetimeFeeSpentSats: mining.runtime.lifetimeFeeSpentSats,
    },
    worker: {
      pid: mining.runtime.backgroundWorkerPid,
      runId: mining.runtime.backgroundWorkerRunId,
      heartbeatAtUnixMs: mining.runtime.backgroundWorkerHeartbeatAtUnixMs,
      health: mining.runtime.backgroundWorkerHealth,
    },
    phase: mining.runtime.currentPhase,
    lastSuspendDetectedAtUnixMs: mining.runtime.lastSuspendDetectedAtUnixMs,
    pauseReason: mining.runtime.pauseReason,
    hookMode: mining.runtime.hookMode,
    hookValidationState: mining.runtime.lastValidationState,
    hookOperatorValidationState: mining.runtime.lastOperatorValidationState,
    hookCooldownActive: mining.hook.cooldownActive,
    providerState: mining.runtime.providerState,
    tipsAligned: mining.runtime.tipsAligned,
    sameDomainCompetitorSuppressed: mining.runtime.sameDomainCompetitorSuppressed,
    higherRankedCompetitorDomainCount: mining.runtime.higherRankedCompetitorDomainCount,
    dedupedCompetitorDomainCount: mining.runtime.dedupedCompetitorDomainCount,
    competitivenessGateIndeterminate: mining.runtime.competitivenessGateIndeterminate,
    mempoolSequenceCacheStatus: mining.runtime.mempoolSequenceCacheStatus,
    note: mining.runtime.note,
  };
}

export function buildStatusJson(context: WalletReadContext): ReadJsonResult<{
  wallet: Record<string, unknown>;
  btc: Record<string, unknown>;
  cog: Record<string, unknown>;
  domains: Record<string, unknown>;
  mining: Record<string, unknown> | null;
  hooks: Record<string, unknown> | null;
  availability: Record<string, JsonAvailabilityEntry>;
}> {
  const messages = createBaseMessages(context);

  return {
    ...messages,
    data: {
      wallet: {
        availability: context.localState.availability,
        walletRootId: context.model?.walletRootId ?? context.localState.walletRootId ?? context.nodeStatus?.walletRootId ?? null,
        unlockUntilUnixMs: context.localState.unlockUntilUnixMs,
        managedCoreReplicaStatus: context.nodeStatus?.walletReplica?.proofStatus ?? null,
      },
      btc: {
        serviceHealth: context.nodeHealth,
        managedServiceHealth: context.bitcoind.health,
        managedServiceState: context.bitcoind.status?.state ?? null,
        managedCoreReplicaStatus: context.nodeStatus?.walletReplica?.proofStatus ?? null,
        bestHeight: context.nodeStatus?.nodeBestHeight ?? null,
        bestHashHex: context.nodeStatus?.nodeBestHashHex ?? null,
        headerHeight: context.nodeStatus?.nodeHeaderHeight ?? null,
      },
      cog: {
        indexerHealth: context.indexer.health,
        indexerDaemonState: context.indexer.status?.state ?? null,
        indexerTruthSource: context.indexer.source ?? (context.indexer.status === null ? "none" : "probe"),
        indexerDaemonInstanceId: context.indexer.daemonInstanceId ?? context.indexer.status?.daemonInstanceId ?? null,
        indexerSnapshotSeq: context.indexer.snapshotSeq ?? context.indexer.status?.snapshotSeq ?? null,
        indexerSnapshotOpenedAtUnixMs: context.indexer.openedAtUnixMs,
        reorgDepth: context.indexer.status?.reorgDepth ?? null,
        tipHeight: context.indexer.snapshotTip?.height ?? null,
        tipHashHex: context.indexer.snapshotTip?.blockHashHex ?? null,
      },
      domains: {
        relatedCount: context.model?.domains.length ?? null,
        readOnlyIdentityCount: 0,
        pendingMutationCount: (context.localState.state?.pendingMutations ?? []).filter((mutation) =>
          mutation.status !== "confirmed" && mutation.status !== "canceled").length ?? null,
        pendingFamilyCount: 0,
      },
      mining: context.mining === undefined ? null : buildMiningStatusData(context.mining),
      hooks: context.mining === undefined
        ? null
        : {
          mode: context.mining.hook.mode,
          validationState: context.mining.hook.validationState,
          operatorValidationState: context.mining.hook.operatorValidationState,
          trustStatus: context.mining.hook.trustStatus,
          providerConfigured: context.mining.provider.configured,
          cooldownActive: context.mining.hook.cooldownActive,
        },
      availability: buildAvailability(context),
    },
  };
}

export function buildAddressJson(context: WalletReadContext): ReadJsonResult<{
  address: string | null;
  scriptPubKeyHex: string | null;
  network: string | null;
  availability: Record<string, JsonAvailabilityEntry>;
}> {
  const messages = createBaseMessages(context);
  return {
    ...messages,
    explanations: dedupeStrings([
      ...messages.explanations,
      ...(context.model?.walletAddress == null ? [] : [getFundingQuickstartGuidance()]),
    ]),
    nextSteps: dedupeStrings([
      ...messages.nextSteps,
      ...getAddressNextSteps(context, context.model?.walletAddress ?? null),
    ]),
    data: {
      address: context.model?.walletAddress ?? null,
      scriptPubKeyHex: context.model?.walletScriptPubKeyHex ?? null,
      network: context.localState.state?.network ?? context.nodeStatus?.chain ?? null,
      availability: buildAvailability(context),
    },
  };
}

export function buildIdsJson(
  context: WalletReadContext,
  page: JsonPage,
): ReadJsonResult<{
  addresses: ReturnType<typeof mapWalletAddress>[] | null;
  page: JsonPage;
  availability: Record<string, JsonAvailabilityEntry>;
}> {
  const messages = createBaseMessages(context);
  return {
    ...messages,
    nextSteps: dedupeStrings([
      ...messages.nextSteps,
      ...getIdsNextSteps(context.model?.walletAddress ?? null),
    ]),
    data: {
      addresses: context.model === null ? null : [mapWalletAddress(context)],
      page,
      availability: buildAvailability(context),
    },
  };
}

export function buildWalletStatusJson(context: WalletReadContext): ReadJsonResult<{
  lockState: string;
  unlockUntilUnixMs: number | null;
  walletAddress: string | null;
  walletScriptPubKeyHex: string | null;
  availability: Record<string, JsonAvailabilityEntry>;
}> {
  const messages = createBaseMessages(context);
  const lockState = context.localState.availability === "ready" && context.localState.unlockUntilUnixMs !== null
    ? "unlocked"
    : context.localState.availability;
  return {
    ...messages,
    data: {
      lockState,
      unlockUntilUnixMs: context.localState.unlockUntilUnixMs,
      walletAddress: context.model?.walletAddress ?? null,
      walletScriptPubKeyHex: context.model?.walletScriptPubKeyHex ?? null,
      availability: buildAvailability(context),
    },
  };
}

export function buildHooksStatusJson(mining: MiningControlPlaneView): ReadJsonResult<{
  mode: string;
  validationState: string;
  operatorValidationState: string;
  launchFingerprintState: string;
  fullFingerprintState: string;
  lastValidationAtUnixMs: number | null;
  lastValidationError: string | null;
  trustChecks: Record<string, unknown>;
}> {
  const warnings: string[] = [];
  const explanations: string[] = [];
  const nextSteps: string[] = [];

  if (mining.hook.operatorValidationState === "failed" || mining.hook.operatorValidationState === "stale") {
    warnings.push(`Mining hook validation is ${mining.hook.operatorValidationState}.`);
  }

  if (mining.hook.cooldownActive) {
    warnings.push("Mining hook launch is paused during the cooldown window.");
  }

  if (mining.hook.validationError !== null) {
    explanations.push(mining.hook.validationError);
  }

  if (mining.hook.trustMessage !== null) {
    explanations.push(mining.hook.trustMessage);
  }

  const launchFingerprintState = mining.hook.currentLaunchFingerprint === null
    ? "unavailable"
    : mining.hook.validatedLaunchFingerprint === null
      ? "not-validated"
      : mining.hook.currentLaunchFingerprint === mining.hook.validatedLaunchFingerprint
        ? "matched"
        : "stale";

  const fullFingerprintState = mining.hook.currentFullFingerprint === null
    ? (mining.hook.verifyUsed ? "unavailable" : "not-verified")
    : mining.hook.validatedFullFingerprint === null
      ? "not-validated"
      : mining.hook.currentFullFingerprint === mining.hook.validatedFullFingerprint
        ? "matched"
        : "stale";

  return {
    warnings: dedupeStrings(warnings),
    explanations: dedupeStrings(explanations),
    nextSteps: dedupeStrings(nextSteps),
    data: {
      mode: mining.hook.mode,
      validationState: mining.hook.validationState,
      operatorValidationState: mining.hook.operatorValidationState,
      launchFingerprintState,
      fullFingerprintState,
      lastValidationAtUnixMs: mining.hook.validatedAtUnixMs,
      lastValidationError: mining.hook.validationError,
      trustChecks: {
        trustStatus: mining.hook.trustStatus,
        trustMessage: mining.hook.trustMessage,
        entrypointExists: mining.hook.entrypointExists,
        packageStatus: mining.hook.packageStatus,
        packageMessage: mining.hook.packageMessage,
        cooldownUntilUnixMs: mining.hook.cooldownUntilUnixMs,
        cooldownActive: mining.hook.cooldownActive,
        consecutiveFailureCount: mining.hook.consecutiveFailureCount,
      },
    },
  };
}

export function buildMineStatusJson(mining: MiningControlPlaneView): ReadJsonResult<{
  runMode: string;
  state: string;
  tipHeight: number | null;
  referencedBlockHashDisplay: string | null;
  currentDomain: { domainId: number | null; name: string | null } | null;
  liveMiningFamilyInMempool: boolean | null;
  publishDecision: string | null;
  phase: string;
  lastSuspendDetectedAtUnixMs: number | null;
  pauseReason: string | null;
  fees: Record<string, unknown>;
  worker: Record<string, unknown>;
  availability: Record<string, JsonAvailabilityEntry>;
}> {
  const warnings: string[] = [];
  const explanations: string[] = [];
  const nextSteps: string[] = [];

  if (mining.runtime.miningState === "repair-required") {
    nextSteps.push("Run `cogcoin repair` before mining again.");
  } else if (mining.runtime.pauseReason === "zero-reward") {
    nextSteps.push("Wait for the next positive-reward target height; mining resumes automatically.");
  } else if (mining.runtime.currentPhase === "resuming") {
    nextSteps.push("Wait for mining to finish rechecking health after the local runtime resumed.");
  } else if (mining.runtime.miningState === "paused-stale" || mining.runtime.miningState === "paused") {
    nextSteps.push("Wait for the live mempool family to settle, or rerun mining when you want replacements to resume.");
  }

  if (mining.runtime.note !== null) {
    explanations.push(mining.runtime.note);
  }

  if (mining.runtime.lastError !== null) {
    warnings.push(mining.runtime.lastError);
  }

  return {
    warnings: dedupeStrings(warnings),
    explanations: dedupeStrings(explanations),
    nextSteps: dedupeStrings(nextSteps),
    data: {
      ...buildMiningStatusData(mining),
      availability: {
        hooks: {
          available: mining.hook.mode !== "unavailable",
          stale: mining.hook.operatorValidationState === "stale",
          reason: mining.hook.validationError,
          state: mining.hook.validationState,
          operatorValidationState: mining.hook.operatorValidationState,
          cooldownActive: mining.hook.cooldownActive,
        },
        bitcoind: {
          available: mining.runtime.bitcoindHealth === "ready" || mining.runtime.bitcoindHealth === "starting",
          stale: mining.runtime.bitcoindHealth === "starting",
          reason: mining.runtime.note,
          state: mining.runtime.bitcoindHealth,
          publishState: mining.runtime.nodeHealth,
          replicaStatus: mining.runtime.bitcoindReplicaStatus,
          coreBestHeight: mining.runtime.coreBestHeight,
          coreBestHash: mining.runtime.coreBestHash,
        },
        indexer: {
          available: mining.runtime.indexerHealth !== "unavailable"
            && mining.runtime.indexerHealth !== "failed"
            && mining.runtime.indexerHealth !== "schema-mismatch"
            && mining.runtime.indexerHealth !== "service-version-mismatch"
            && mining.runtime.indexerHealth !== "wallet-root-mismatch",
          stale: mining.runtime.indexerHealth === "stale-heartbeat"
            || mining.runtime.indexerHealth === "catching-up"
            || mining.runtime.indexerHealth === "reorging"
            || mining.runtime.indexerHealth === "starting",
          reason: mining.runtime.note,
          state: mining.runtime.indexerHealth,
          source: mining.runtime.indexerTruthSource,
          daemonInstanceId: mining.runtime.indexerDaemonInstanceId,
          snapshotSeq: mining.runtime.indexerSnapshotSeq,
          openedAtUnixMs: mining.runtime.indexerSnapshotOpenedAtUnixMs,
          reorgDepth: mining.runtime.indexerReorgDepth,
          appliedTipHeight: mining.runtime.indexerTipHeight,
          appliedTipHash: mining.runtime.indexerTipHash,
          coreBestHeight: mining.runtime.coreBestHeight,
          coreBestHash: mining.runtime.coreBestHash,
        },
        backgroundWorker: {
          available: mining.runtime.backgroundWorkerPid !== null,
          stale: mining.runtime.backgroundWorkerHealth === "stale-heartbeat"
            || mining.runtime.backgroundWorkerHealth === "stale-pid"
            || mining.runtime.backgroundWorkerHealth === "version-mismatch",
          reason: mining.runtime.note,
          state: mining.runtime.backgroundWorkerHealth,
        },
      },
    },
  };
}

export function buildMineLogJson(
  events: MiningEventRecord[],
  page: JsonPage,
  rotation: number[],
): ReadJsonResult<{
  events: MiningEventRecord[];
  truncated: boolean;
  rotation: number[];
  page: JsonPage;
}> {
  return {
    warnings: [],
    explanations: [],
    nextSteps: [],
    data: {
      events,
      truncated: page.truncated,
      rotation,
      page,
    },
  };
}

export function buildBalanceJson(context: WalletReadContext): ReadJsonResult<{
  assetLabel: string;
  totalCogtoshi: string | null;
  walletAddress: string | null;
  walletScriptPubKeyHex: string | null;
  pending: ReturnType<typeof mapPendingMutation>[];
  availability: Record<string, JsonAvailabilityEntry>;
}> {
  const messages = createBaseMessages(context);
  const total = walletCogBalance(context);

  return {
    ...messages,
    data: {
      assetLabel: "COG",
      totalCogtoshi: decimalOrNull(total),
      walletAddress: context.model?.walletAddress ?? null,
      walletScriptPubKeyHex: context.model?.walletScriptPubKeyHex ?? null,
      pending: (context.localState.state?.pendingMutations ?? [])
        .filter((mutation) =>
          (mutation.kind === "send" || mutation.kind === "lock" || mutation.kind === "claim")
          && mutation.status !== "confirmed"
          && mutation.status !== "canceled")
        .map(mapPendingMutation),
      availability: buildAvailability(context),
    },
  };
}

export function buildLocksJson(
  context: WalletReadContext,
  locks: WalletLockView[] | null,
  page: JsonPage,
): ReadJsonResult<{
  assetLabel: string;
  locks: ReturnType<typeof mapLock>[] | null;
  pending: ReturnType<typeof mapPendingMutation>[];
  page: JsonPage;
  availability: Record<string, JsonAvailabilityEntry>;
}> {
  const messages = createBaseMessages(context);
  return {
    ...messages,
    nextSteps: dedupeStrings([
      ...messages.nextSteps,
      ...getLocksNextSteps(locks),
    ]),
    data: {
      assetLabel: "COG",
      locks: locks?.map(mapLock) ?? null,
      pending: (context.localState.state?.pendingMutations ?? [])
        .filter((mutation) =>
          (mutation.kind === "lock" || mutation.kind === "claim")
          && mutation.status !== "confirmed"
          && mutation.status !== "canceled")
        .map(mapPendingMutation),
      page,
      availability: buildAvailability(context),
    },
  };
}

export function buildDomainsJson(
  context: WalletReadContext,
  domains: WalletDomainView[] | null,
  page: JsonPage,
): ReadJsonResult<{
  domains: ReturnType<typeof mapDomain>[] | null;
  page: JsonPage;
  availability: Record<string, JsonAvailabilityEntry>;
}> {
  const messages = createBaseMessages(context);
  return {
    ...messages,
    data: {
      domains: domains?.map(mapDomain) ?? null,
      page,
      availability: buildAvailability(context),
    },
  };
}

export function buildShowJson(
  context: WalletReadContext,
  domainName: string,
): ReadJsonResult<{
  domain: Record<string, unknown> | null;
  availability: Record<string, JsonAvailabilityEntry>;
}> {
  const messages = createBaseMessages(context);
  const found = findWalletDomain(context, domainName);

  return {
    ...messages,
    data: {
      domain: found === null
        ? null
        : {
          ...mapDomain(found.domain),
          pendingMutations: listPendingMutationsForDomain(context, domainName).map(mapPendingMutation),
        },
      availability: buildAvailability(context),
    },
  };
}

export function buildFieldsJson(
  context: WalletReadContext,
  domainName: string,
  fields: WalletFieldView[] | null,
  page: JsonPage,
): ReadJsonResult<{
  fields: ReturnType<typeof mapField>[] | null;
  page: JsonPage;
  availability: Record<string, JsonAvailabilityEntry>;
}> {
  const messages = createBaseMessages(context);
  return {
    ...messages,
    data: {
      fields: fields?.map(mapField) ?? null,
      page,
      availability: buildAvailability(context),
    },
  };
}

export function buildFieldJson(
  context: WalletReadContext,
  domainName: string,
  fieldName: string,
): ReadJsonResult<{
  field: ReturnType<typeof mapField> | null;
  availability: Record<string, JsonAvailabilityEntry>;
}> {
  const messages = createBaseMessages(context);
  const field = findDomainField(context, domainName, fieldName);
  return {
    ...messages,
    data: {
      field: field === null ? null : mapField(field),
      availability: buildAvailability(context),
    },
  };
}

export function listLocksForJson(
  context: WalletReadContext,
  options: {
    claimableOnly: boolean;
    reclaimableOnly: boolean;
  },
): WalletLockView[] | null {
  const locks = listWalletLocks(context);

  if (locks === null) {
    return null;
  }

  if (options.claimableOnly) {
    return locks.filter((lock) => lock.claimableNow);
  }

  if (options.reclaimableOnly) {
    return locks.filter((lock) => lock.reclaimableNow);
  }

  return locks;
}

export function listFieldsForJson(
  context: WalletReadContext,
  domainName: string,
): WalletFieldView[] | null {
  return listDomainFields(context, domainName);
}
