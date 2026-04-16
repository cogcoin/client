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
import type {
  WalletInitializationResult,
  WalletExportResult,
  WalletImportResult,
  WalletDeleteResult,
  WalletRepairResult,
  WalletResetResult,
  WalletRestoreResult,
  WalletUnlockResult,
} from "../wallet/lifecycle.js";
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

export function buildSingleTxMutationData(options: {
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

export function buildFamilyMutationData(options: {
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

export function buildStateChangeData(options: {
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

export function buildOperationData(options: {
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

export function buildRegisterMutationData(
  result: RegisterDomainResult,
  options: {
    forceRace: boolean;
    fromIdentity: string | null;
  },
) {
  return {
    ...buildSingleTxMutationData({
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

export function buildDomainMarketMutationData(
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

  const data = buildSingleTxMutationData({
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

export function buildCogMutationData(
  result: CogMutationResult,
  options: {
    commandKind: "send" | "claim" | "reclaim" | "cog-lock";
    fromIdentity: string | null;
    timeoutBlocksOrDuration?: string | null;
    timeoutHeight?: string | null;
    conditionHex?: string | null;
  },
) {
  const data = buildSingleTxMutationData({
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

export function buildAnchorMutationData(
  result: AnchorDomainResult,
  options: {
    foundingMessageText: string | null;
  },
) {
  return buildFamilyMutationData({
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

export function buildAnchorClearMutationData(
  result: ClearPendingAnchorResult,
) {
  const before = result.cleared
    ? {
      localAnchorIntent: result.previousLocalAnchorIntent,
      dedicatedIndex: result.previousDedicatedIndex,
      familyStatus: result.previousFamilyStatus,
      familyStep: result.previousFamilyStep,
    }
    : null;
  const after = result.cleared
    ? {
      localAnchorIntent: result.resultingLocalAnchorIntent,
      dedicatedIndex: result.resultingDedicatedIndex,
      familyStatus: result.canceledActiveFamilies > 0 || result.clearedReservedFamilies > 0 ? "canceled" : null,
      familyStep: result.previousFamilyStep,
    }
    : null;

  return buildStateChangeData({
    kind: "anchor-clear",
    state: {
      domainName: result.domainName,
      cleared: result.cleared,
      previousFamilyStatus: result.previousFamilyStatus,
      previousFamilyStep: result.previousFamilyStep,
      releasedDedicatedIndex: result.releasedDedicatedIndex,
      forced: result.forced,
      clearedReservedFamilies: result.clearedReservedFamilies,
      canceledActiveFamilies: result.canceledActiveFamilies,
      releasedDedicatedIndices: result.releasedDedicatedIndices,
      affectedFamilies: result.affectedFamilies,
      previousLocalAnchorIntent: result.previousLocalAnchorIntent,
      previousDedicatedIndex: result.previousDedicatedIndex,
      resultingLocalAnchorIntent: result.resultingLocalAnchorIntent,
      resultingDedicatedIndex: result.resultingDedicatedIndex,
    },
    before,
    after,
  });
}

export function buildResetMutationData(result: WalletResetResult) {
  return buildOperationData({
    kind: "reset",
    state: {
      dataRoot: result.dataRoot,
      factoryResetReady: result.factoryResetReady,
      walletAction: result.walletAction,
      walletOldRootId: result.walletOldRootId,
      walletNewRootId: result.walletNewRootId,
      bootstrapSnapshot: result.bootstrapSnapshot,
      bitcoinDataDir: result.bitcoinDataDir,
      stoppedProcesses: result.stoppedProcesses,
      secretCleanupStatus: result.secretCleanupStatus,
    },
    operation: {
      dataRoot: result.dataRoot,
      factoryResetReady: result.factoryResetReady,
      stoppedProcesses: result.stoppedProcesses,
      secretCleanupStatus: result.secretCleanupStatus,
      deletedSecretRefs: result.deletedSecretRefs,
      failedSecretRefs: result.failedSecretRefs,
      preservedSecretRefs: result.preservedSecretRefs,
      walletAction: result.walletAction,
      walletOldRootId: result.walletOldRootId,
      walletNewRootId: result.walletNewRootId,
      bootstrapSnapshot: result.bootstrapSnapshot,
      bitcoinDataDir: result.bitcoinDataDir,
      removedPaths: result.removedPaths,
    },
  });
}

export function buildWalletDeleteMutationData(result: WalletDeleteResult) {
  return buildOperationData({
    kind: "wallet-delete",
    state: {
      seedName: result.seedName,
      walletRootId: result.walletRootId,
      deleted: result.deleted,
    },
    operation: {
      seedName: result.seedName,
      walletRootId: result.walletRootId,
      deleted: result.deleted,
    },
  });
}

export function buildDomainAdminMutationData(
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
  const data = buildSingleTxMutationData({
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

export function buildFieldMutationData(result: FieldMutationResult) {
  if (result.family) {
    return {
      ...buildFamilyMutationData({
      familyKind: "field",
      familyStatus: result.status,
      reusedExisting: result.reusedExisting,
      currentStep: result.status === "confirmed" ? "confirmed" : "submitted",
      tx1Txid: result.tx1Txid ?? null,
      tx2Txid: result.tx2Txid ?? null,
      intent: {
        domainName: result.domainName,
        fieldName: result.fieldName,
        expectedFieldId: result.fieldId,
        permanent: result.permanent,
        format: result.format,
      },
      }),
      resolved: buildFieldResolvedJson(result),
    };
  }

  return {
    ...buildSingleTxMutationData({
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

export function buildReputationMutationData(result: ReputationMutationResult) {
  const data = buildSingleTxMutationData({
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

export function buildWalletLockMutationData(result: { walletRootId: string | null }) {
  const after = {
    walletRootId: result.walletRootId,
    locked: true,
  };

  return buildStateChangeData({
    kind: "wallet-lock",
    state: after,
    after,
  });
}

export function buildInitMutationData(result: WalletInitializationResult) {
  const after = {
    seedName: "main",
    walletRootId: result.walletRootId,
    fundingAddress: result.fundingAddress,
    unlockUntilUnixMs: result.unlockUntilUnixMs,
    locked: false,
  };

  return buildStateChangeData({
    kind: "init",
    state: after,
    before: null,
    after,
  });
}

export function buildRestoreMutationData(result: WalletRestoreResult) {
  const after = {
    seedName: result.seedName ?? null,
    walletRootId: result.walletRootId,
    fundingAddress: result.fundingAddress,
    unlockUntilUnixMs: result.unlockUntilUnixMs,
    locked: false,
  };

  return buildStateChangeData({
    kind: "restore",
    state: after,
    after,
  });
}

export function buildUnlockMutationData(result: WalletUnlockResult) {
  const after = {
    walletRootId: result.state.walletRootId,
    locked: false,
    unlockUntilUnixMs: result.unlockUntilUnixMs,
    fundingAddress: result.state.funding.address,
    source: result.source,
  };

  return buildStateChangeData({
    kind: "unlock",
    state: after,
    after,
  });
}

export function buildWalletExportMutationData(result: WalletExportResult) {
  const state = {
    walletRootId: result.walletRootId,
    archivePath: result.archivePath,
  };

  return buildOperationData({
    kind: "wallet-export",
    state,
    operation: {
      walletRootId: result.walletRootId,
      archivePath: result.archivePath,
      exportMode: "trusted-quiescent",
    },
  });
}

export function buildWalletImportMutationData(result: WalletImportResult) {
  const after = {
    walletRootId: result.walletRootId,
    archivePath: result.archivePath,
    fundingAddress: result.fundingAddress,
    unlockUntilUnixMs: result.unlockUntilUnixMs,
  };

  return buildStateChangeData({
    kind: "wallet-import",
    state: after,
    after,
  });
}

export function buildRepairMutationData(result: WalletRepairResult) {
  const after = {
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
  };

  return buildStateChangeData({
    kind: "repair",
    state: after,
    after,
  });
}
