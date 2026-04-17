import type {
  AnchorDomainResult,
  CogMutationResult,
  DomainAdminMutationResult,
  DomainMarketMutationResult,
  FieldMutationResult,
  RegisterDomainResult,
  ReputationMutationResult,
  WalletMutationFeeSummary,
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
  },
) {
  return {
    ...buildSingleTxMutationPreviewData({
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

export function buildDomainMarketPreviewData(
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

  const data = buildSingleTxMutationPreviewData({
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

export function buildCogPreviewData(
  result: CogMutationResult,
  options: {
    commandKind: "send" | "claim" | "reclaim" | "cog-lock";
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

export function buildAnchorPreviewData(
  result: AnchorDomainResult,
  options: {
    foundingMessageText: string | null;
  },
) {
  return buildSingleTxMutationPreviewData({
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

export function buildFieldPreviewData(result: FieldMutationResult) {
  return {
    ...buildSingleTxMutationPreviewData({
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

export function buildReputationPreviewData(result: ReputationMutationResult) {
  const data = buildSingleTxMutationPreviewData({
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

export function buildMineSetupPreviewData(view: MiningControlPlaneView) {
  return buildStateChangePreviewData({
    kind: "mine-setup",
    state: {
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
