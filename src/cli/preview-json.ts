import type {
  AnchorDomainResult,
  ClearPendingAnchorResult,
  CogMutationResult,
  DomainAdminMutationResult,
  DomainMarketMutationResult,
  FieldMutationResult,
  RegisterDomainResult,
  ReputationMutationResult,
} from "../wallet/tx/index.js";
import type { WalletRepairResult, WalletResetPreview } from "../wallet/lifecycle.js";
import type { MiningControlPlaneView, MiningRuntimeStatusV1 } from "../wallet/mining/index.js";
import {
  buildCogResolvedJson,
  buildDomainAdminResolvedJson,
  buildDomainMarketResolvedJson,
  buildFieldResolvedJson,
  buildRegisterResolvedJson,
  buildReputationResolvedJson,
  decimalOrNull,
} from "./mutation-resolved-json.js";

function normalizeTxSummary(txid: string | null | undefined, wtxid: string | null | undefined) {
  return {
    txid: txid ?? null,
    wtxid: wtxid ?? null,
  };
}

export function buildSingleTxMutationPreviewData(options: {
  kind: string;
  localStatus: string;
  txid: string | null | undefined;
  wtxid?: string | null | undefined;
  reusedExisting: boolean;
  intent: Record<string, unknown>;
  journalKind?: string | null;
  intentFingerprintHex?: string | null;
}) {
  return {
    resultType: "single-tx-mutation" as const,
    mutation: {
      kind: options.kind,
      journalKind: options.journalKind ?? options.kind,
      localStatus: options.localStatus,
      reusedExisting: options.reusedExisting,
      intentFingerprintHex: options.intentFingerprintHex ?? null,
    },
    transaction: normalizeTxSummary(options.txid, options.wtxid),
    intent: options.intent,
  };
}

export function buildFamilyMutationPreviewData(options: {
  familyKind: string;
  familyStatus: string;
  reusedExisting: boolean;
  intent: Record<string, unknown>;
  currentStep?: string | null;
  tx1Txid?: string | null | undefined;
  tx1Wtxid?: string | null | undefined;
  tx2Txid?: string | null | undefined;
  tx2Wtxid?: string | null | undefined;
  intentFingerprintHex?: string | null;
}) {
  return {
    resultType: "family-mutation" as const,
    family: {
      kind: options.familyKind,
      localStatus: options.familyStatus,
      reusedExisting: options.reusedExisting,
      currentStep: options.currentStep ?? null,
      intentFingerprintHex: options.intentFingerprintHex ?? null,
    },
    transactions: {
      tx1: normalizeTxSummary(options.tx1Txid, options.tx1Wtxid),
      tx2: normalizeTxSummary(options.tx2Txid, options.tx2Wtxid),
    },
    intent: options.intent,
  };
}

export function buildStateChangePreviewData(options: {
  kind: string;
  state: Record<string, unknown>;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}) {
  return {
    resultType: "state-change" as const,
    stateChange: {
      kind: options.kind,
      before: options.before ?? null,
      after: options.after ?? null,
    },
    state: options.state,
  };
}

export function buildOperationPreviewData(options: {
  kind: string;
  state?: Record<string, unknown> | null;
  operation: Record<string, unknown>;
}) {
  return {
    resultType: "operation" as const,
    operation: {
      kind: options.kind,
      ...options.operation,
    },
    state: options.state ?? null,
  };
}

export function buildRegisterPreviewData(
  result: RegisterDomainResult,
  options: {
    forceRace: boolean;
    fromIdentity: string | null;
  },
) {
  return {
    ...buildSingleTxMutationPreviewData({
      kind: "register",
      localStatus: result.status,
      txid: result.txid,
      reusedExisting: result.reusedExisting,
      intent: {
        domainName: result.domainName,
        registerKind: result.registerKind,
        forceRace: options.forceRace,
        fromIdentitySelector: options.fromIdentity,
      },
    }),
    resolved: buildRegisterResolvedJson(result),
  };
}

export function buildDomainMarketPreviewData(
  result: DomainMarketMutationResult,
  options: {
    commandKind: "transfer" | "sell" | "unsell" | "buy";
    fromIdentity?: string | null;
  },
) {
  const intent: Record<string, unknown> = {
    domainName: result.domainName,
    listedPriceCogtoshi: decimalOrNull(result.listedPriceCogtoshi),
    recipientScriptPubKeyHex: result.recipientScriptPubKeyHex ?? null,
  };

  if (options.commandKind === "buy") {
    intent.fromIdentitySelector = options.fromIdentity ?? null;
  }

  const data = buildSingleTxMutationPreviewData({
    kind: options.commandKind,
    localStatus: result.status,
    txid: result.txid,
    reusedExisting: result.reusedExisting,
    intent,
    journalKind: result.kind,
  });

  if (options.commandKind !== "buy") {
    return {
      ...data,
      resolved: buildDomainMarketResolvedJson(result, options.commandKind),
    };
  }

  return {
    ...data,
    resolved: buildDomainMarketResolvedJson(result, options.commandKind),
  };
}

export function buildCogPreviewData(
  result: CogMutationResult,
  options: {
    commandKind: "send" | "claim" | "reclaim" | "cog-lock";
    fromIdentity: string | null;
    timeoutBlocksOrDuration?: string | null;
    timeoutHeight?: string | null;
    conditionHex?: string | null;
  },
) {
  const data = buildSingleTxMutationPreviewData({
    kind: options.commandKind,
    localStatus: result.status,
    txid: result.txid,
    reusedExisting: result.reusedExisting,
    intent: {
      amountCogtoshi: decimalOrNull(result.amountCogtoshi),
      recipientScriptPubKeyHex: result.recipientScriptPubKeyHex ?? null,
      recipientDomainName: result.recipientDomainName ?? null,
      lockId: result.lockId ?? null,
      fromIdentitySelector: options.fromIdentity,
      timeoutBlocksOrDuration: options.timeoutBlocksOrDuration ?? null,
      timeoutHeight: options.timeoutHeight ?? null,
      conditionHex: options.conditionHex ?? null,
    },
    journalKind: result.kind,
  });

  return {
    ...data,
    resolved: buildCogResolvedJson(result, options.commandKind),
  };
}

export function buildAnchorPreviewData(
  result: AnchorDomainResult,
  options: {
    foundingMessageText: string | null;
  },
) {
  return buildFamilyMutationPreviewData({
    familyKind: "anchor",
    familyStatus: result.status,
    reusedExisting: result.reusedExisting,
    currentStep: result.status === "confirmed" ? "confirmed" : "submitted",
    tx1Txid: result.tx1Txid,
    tx2Txid: result.tx2Txid,
    intent: {
      domainName: result.domainName,
      dedicatedIndex: result.dedicatedIndex,
      foundingMessageIncluded: options.foundingMessageText !== null,
    },
  });
}

export function buildAnchorClearPreviewData(
  result: ClearPendingAnchorResult,
) {
  const before = result.cleared
    ? {
      localAnchorIntent: "reserved",
      dedicatedIndex: result.releasedDedicatedIndex,
      familyStatus: result.previousFamilyStatus,
      familyStep: result.previousFamilyStep,
    }
    : null;
  const after = result.cleared
    ? {
      localAnchorIntent: "none",
      dedicatedIndex: null,
      familyStatus: "canceled",
      familyStep: result.previousFamilyStep,
    }
    : null;

  return buildStateChangePreviewData({
    kind: "anchor-clear",
    state: {
      domainName: result.domainName,
      cleared: result.cleared,
      previousFamilyStatus: result.previousFamilyStatus,
      previousFamilyStep: result.previousFamilyStep,
      releasedDedicatedIndex: result.releasedDedicatedIndex,
    },
    before,
    after,
  });
}

export function buildDomainAdminPreviewData(
  result: DomainAdminMutationResult,
  options: {
    commandKind:
      | "domain-endpoint-set"
      | "domain-endpoint-clear"
      | "domain-delegate-set"
      | "domain-delegate-clear"
      | "domain-miner-set"
      | "domain-miner-clear"
      | "domain-canonical";
  },
) {
  const data = buildSingleTxMutationPreviewData({
    kind: options.commandKind,
    localStatus: result.status,
    txid: result.txid,
    reusedExisting: result.reusedExisting,
    intent: {
      domainName: result.domainName,
      recipientScriptPubKeyHex: result.recipientScriptPubKeyHex ?? null,
      endpointValueHex: result.endpointValueHex ?? null,
      endpointByteLength: result.endpointValueHex === null || result.endpointValueHex === undefined
        ? null
        : result.endpointValueHex.length / 2,
    },
    journalKind: result.kind,
  });

  return {
    ...data,
    resolved: buildDomainAdminResolvedJson(result),
  };
}

export function buildFieldPreviewData(result: FieldMutationResult) {
  if (result.family) {
    return {
      ...buildFamilyMutationPreviewData({
      familyKind: "field",
      familyStatus: result.status,
      reusedExisting: result.reusedExisting,
      currentStep: result.status === "confirmed" ? "confirmed" : "submitted",
      tx1Txid: result.tx1Txid ?? null,
      tx2Txid: result.tx2Txid ?? null,
      intent: {
        domainName: result.domainName,
        fieldName: result.fieldName,
        fieldId: result.fieldId,
        permanent: result.permanent,
        format: result.format,
      },
      }),
      resolved: buildFieldResolvedJson(result),
    };
  }

  return {
    ...buildSingleTxMutationPreviewData({
    kind: result.kind,
    localStatus: result.status,
    txid: result.txid,
    reusedExisting: result.reusedExisting,
    intent: {
      domainName: result.domainName,
      fieldName: result.fieldName,
      fieldId: result.fieldId,
      permanent: result.permanent,
      format: result.format,
    },
    }),
    resolved: buildFieldResolvedJson(result),
  };
}

export function buildReputationPreviewData(result: ReputationMutationResult) {
  const data = buildSingleTxMutationPreviewData({
    kind: result.kind === "give" ? "rep-give" : "rep-revoke",
    localStatus: result.status,
    txid: result.txid,
    reusedExisting: result.reusedExisting,
    intent: {
      sourceDomainName: result.sourceDomainName,
      targetDomainName: result.targetDomainName,
      amountCogtoshi: result.amountCogtoshi.toString(),
      reviewIncluded: result.reviewIncluded,
    },
  });

  return {
    ...data,
    resolved: buildReputationResolvedJson(result),
  };
}

export function buildWalletLockPreviewData(result: { walletRootId: string | null }) {
  return buildStateChangePreviewData({
    kind: "wallet-lock",
    state: {
      walletRootId: result.walletRootId,
      locked: true,
    },
  });
}

export function buildResetPreviewData(result: WalletResetPreview) {
  return buildOperationPreviewData({
    kind: "reset",
    state: {
      dataRoot: result.dataRoot,
      trackedProcessKinds: result.trackedProcessKinds,
      willDeleteOsSecrets: result.willDeleteOsSecrets,
      bootstrapSnapshot: result.bootstrapSnapshot,
      bitcoinDataDir: result.bitcoinDataDir,
      walletPrompt: result.walletPrompt,
    },
    operation: {
      dataRoot: result.dataRoot,
      confirmationPhrase: result.confirmationPhrase,
      walletPrompt: result.walletPrompt,
      bootstrapSnapshot: result.bootstrapSnapshot,
      bitcoinDataDir: result.bitcoinDataDir,
      trackedProcessKinds: result.trackedProcessKinds,
      willDeleteOsSecrets: result.willDeleteOsSecrets,
      removedPaths: result.removedPaths,
    },
  });
}

export function buildRepairPreviewData(result: WalletRepairResult) {
  return buildStateChangePreviewData({
    kind: "repair",
    state: {
      walletRootId: result.walletRootId,
      recoveredFromBackup: result.recoveredFromBackup,
      recreatedManagedCoreWallet: result.recreatedManagedCoreWallet,
      bitcoindServiceAction: result.bitcoindServiceAction,
      bitcoindCompatibilityIssue: result.bitcoindCompatibilityIssue,
      managedCoreReplicaAction: result.managedCoreReplicaAction,
      bitcoindPostRepairHealth: result.bitcoindPostRepairHealth,
      resetIndexerDatabase: result.resetIndexerDatabase,
      indexerDaemonAction: result.indexerDaemonAction,
      indexerCompatibilityIssue: result.indexerCompatibilityIssue,
      indexerPostRepairHealth: result.indexerPostRepairHealth,
      miningPreRepairRunMode: result.miningPreRepairRunMode,
      miningResumeAction: result.miningResumeAction,
      miningPostRepairRunMode: result.miningPostRepairRunMode,
      miningResumeError: result.miningResumeError,
      note: result.note,
    },
  });
}

function summarizeRuntime(snapshot: MiningRuntimeStatusV1 | null) {
  if (snapshot === null) {
    return null;
  }

  return {
    runMode: snapshot.runMode,
    miningState: snapshot.miningState,
    currentPhase: snapshot.currentPhase,
    backgroundWorkerPid: snapshot.backgroundWorkerPid,
    backgroundWorkerRunId: snapshot.backgroundWorkerRunId,
    note: snapshot.note,
  };
}

export function buildHooksPreviewData(
  kind: "hooks-enable-mining" | "hooks-disable-mining" | "mine-setup",
  view: MiningControlPlaneView,
) {
  return buildStateChangePreviewData({
    kind,
    state: {
      hook: {
        mode: view.hook.mode,
        validationState: view.hook.validationState,
        operatorValidationState: view.hook.operatorValidationState,
        validationError: view.hook.validationError,
        cooldownActive: view.hook.cooldownActive,
      },
      provider: {
        configured: view.provider.configured,
        provider: view.provider.provider,
        status: view.provider.status,
      },
      runtime: summarizeRuntime(view.runtime),
    },
  });
}

export function buildMineStartPreviewData(result: { started: boolean; snapshot: MiningRuntimeStatusV1 | null }) {
  return buildStateChangePreviewData({
    kind: "mine-start",
    state: {
      started: result.started,
      runtime: summarizeRuntime(result.snapshot),
    },
  });
}

export function buildMineStopPreviewData(snapshot: MiningRuntimeStatusV1 | null) {
  return buildStateChangePreviewData({
    kind: "mine-stop",
    state: {
      stopped: snapshot !== null,
      runtime: summarizeRuntime(snapshot),
      note: snapshot?.note ?? "Background mining was not active.",
    },
  });
}
