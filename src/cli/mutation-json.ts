import type {
  AnchorDomainResult,
  BitcoinTransferResult,
  CogMutationResult,
  DomainAdminMutationResult,
  DomainMarketMutationResult,
  FieldMutationResult,
  RegisterDomainResult,
  ReputationMutationResult,
  WalletMutationFeeSummary,
} from "../wallet/tx/index.js";
import type {
  WalletInitializationResult,
  WalletRepairResult,
  WalletResetResult,
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
  fees: WalletMutationFeeSummary;
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
    fees: options.fees,
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

export function buildBitcoinTransferData(result: BitcoinTransferResult) {
  return buildOperationData({
    kind: "bitcoin-transfer",
    state: null,
    operation: {
      amountSats: result.amountSats.toString(),
      feeSats: result.feeSats.toString(),
      senderAddress: result.senderAddress,
      recipientAddress: result.recipientAddress,
      recipientScriptPubKeyHex: result.recipientScriptPubKeyHex,
      changeAddress: result.changeAddress,
      txid: result.txid,
      wtxid: result.wtxid,
    },
  });
}

export function buildRegisterMutationData(
  result: RegisterDomainResult,
  options: {
    forceRace: boolean;
  },
) {
  return {
    ...buildSingleTxMutationData({
      kind: "register",
      localStatus: result.status,
      txid: result.txid,
      reusedExisting: result.reusedExisting,
      fees: result.fees,
      intent: {
        domainName: result.domainName,
        registerKind: result.registerKind,
        forceRace: options.forceRace,
      },
    }),
    resolved: buildRegisterResolvedJson(result),
  };
}

export function buildDomainMarketMutationData(
  result: DomainMarketMutationResult,
  options: {
    commandKind: "transfer" | "sell" | "unsell" | "buy";
  },
) {
  const intent: Record<string, unknown> = {
    domainName: result.domainName,
    listedPriceCogtoshi: decimalOrNull(result.listedPriceCogtoshi),
    recipientScriptPubKeyHex: result.recipientScriptPubKeyHex ?? null,
  };

  const data = buildSingleTxMutationData({
    kind: options.commandKind,
    localStatus: result.status,
    txid: result.txid,
    reusedExisting: result.reusedExisting,
    fees: result.fees,
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
    fees: result.fees,
    intent: {
      amountCogtoshi: decimalOrNull(result.amountCogtoshi),
      recipientScriptPubKeyHex: result.recipientScriptPubKeyHex ?? null,
      recipientDomainName: result.recipientDomainName ?? null,
      lockId: result.lockId ?? null,
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
  return buildSingleTxMutationData({
    kind: "anchor",
    localStatus: result.status,
    txid: result.txid,
    reusedExisting: result.reusedExisting,
    fees: result.fees,
    intent: {
      domainName: result.domainName,
      foundingMessageIncluded: options.foundingMessageText !== null,
    },
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
    fees: result.fees,
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
  return {
    ...buildSingleTxMutationData({
      kind: result.kind,
      localStatus: result.status,
      txid: result.txid,
      reusedExisting: result.reusedExisting,
      fees: result.fees,
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
      fees: result.fees,
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

export function buildInitMutationData(result: WalletInitializationResult) {
  const after = {
    setupMode: result.setupMode,
    passwordAction: result.passwordAction,
    walletAction: result.walletAction,
    walletRootId: result.walletRootId,
    fundingAddress: result.fundingAddress,
  };

  return buildStateChangeData({
    kind: "init",
    state: after,
    before: null,
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
