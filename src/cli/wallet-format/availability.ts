import type { WalletReadContext } from "../../wallet/read/index.js";
import { formatMiningSummaryLine } from "../mining-format.js";
import {
  getClientUnlockRecommendation,
  getMutationRecommendation,
  getRepairRecommendation,
} from "../recommendations.js";
import { getBootstrapSyncNextStep } from "../workflow-hints.js";
import {
  formatIndexerTruthSource,
  formatMaybe,
  formatServiceHealth,
} from "./shared.js";

export function resolveWalletRootLabel(context: WalletReadContext): string {
  return context.model?.walletRootId
    ?? context.localState.walletRootId
    ?? context.nodeStatus?.walletRootId
    ?? "none";
}

export function appendServiceSummary(
  lines: string[],
  context: WalletReadContext,
): void {
  lines.push(`Managed bitcoind: ${formatServiceHealth(context.bitcoind.health)}`);
  if (context.bitcoind.message !== null) {
    lines.push(`Managed bitcoind note: ${context.bitcoind.message}`);
  }

  lines.push(`Bitcoin service: ${formatServiceHealth(context.nodeHealth)}`);

  if (context.nodeStatus !== null) {
    lines.push(`Bitcoin best height: ${formatMaybe(context.nodeStatus.nodeBestHeight)}`);
    lines.push(`Bitcoin headers: ${formatMaybe(context.nodeStatus.nodeHeaderHeight)}`);
  }

  if (context.nodeMessage !== null) {
    lines.push(`Bitcoin note: ${context.nodeMessage}`);
  }

  lines.push(`Indexer service: ${formatServiceHealth(context.indexer.health)}`);
  lines.push(`Indexer truth source: ${formatIndexerTruthSource(context.indexer.source)}`);
  if (context.indexer.daemonInstanceId !== null) {
    lines.push(`Indexer daemon instance: ${context.indexer.daemonInstanceId}`);
  }
  if (context.indexer.snapshotSeq !== null) {
    lines.push(`Indexer snapshot sequence: ${context.indexer.snapshotSeq}`);
  }
  if (context.indexer.status?.reorgDepth !== null && context.indexer.status?.reorgDepth !== undefined) {
    lines.push(`Indexer reorg depth: ${context.indexer.status.reorgDepth}`);
  }

  if (context.indexer.snapshotTip !== null) {
    lines.push(`Indexer tip height: ${context.indexer.snapshotTip.height}`);
  } else {
    lines.push("Indexer tip height: unavailable");
  }

  if (context.indexer.message !== null) {
    lines.push(`Indexer note: ${context.indexer.message}`);
  }

  if (context.mining !== undefined) {
    lines.push(`Mining: ${formatMiningSummaryLine(context.mining)}`);

    if (context.mining.runtime.note !== null) {
      lines.push(`Mining note: ${context.mining.runtime.note}`);
    }
  }
}

export function appendWalletAvailability(
  lines: string[],
  context: WalletReadContext,
): void {
  lines.push(`Wallet state: ${context.localState.availability}`);
  lines.push(`Wallet root: ${resolveWalletRootLabel(context)}`);

  if (context.localState.message !== null) {
    lines.push(`Wallet note: ${context.localState.message}`);
  }

  const nodeStatus = context.nodeStatus;
  const replica = nodeStatus?.walletReplica ?? null;

  if (replica !== null) {
    lines.push(`Managed Core wallet: ${replica.proofStatus ?? "not-proven"}`);
  }

  if (nodeStatus?.walletReplicaMessage) {
    lines.push(`Managed Core note: ${nodeStatus.walletReplicaMessage}`);
  }

  const repairRecommendation = getRepairRecommendation(context);
  if (repairRecommendation !== null) {
    lines.push(`Recommended next step: ${repairRecommendation}`);
  } else {
    const clientUnlockRecommendation = getClientUnlockRecommendation(context);
    if (clientUnlockRecommendation !== null) {
      lines.push(`Recommended next step: ${clientUnlockRecommendation}`);
    } else if (getBootstrapSyncNextStep(context) !== null) {
      lines.push(
        "Recommended next step: Run `cogcoin sync` to bootstrap assumeutxo and the managed Bitcoin/indexer state.",
      );
    }
  }

  const mutationRecommendation = getMutationRecommendation(context);
  if (mutationRecommendation !== null) {
    lines.push(`Mutation note: ${mutationRecommendation}`);
  }
}

export function getOverviewNextStep(context: WalletReadContext): string | null {
  const repairRecommendation = getRepairRecommendation(context);
  if (repairRecommendation !== null) {
    return repairRecommendation;
  }

  const clientUnlockRecommendation = getClientUnlockRecommendation(context);
  if (clientUnlockRecommendation !== null) {
    return clientUnlockRecommendation;
  }

  if (getBootstrapSyncNextStep(context) !== null) {
    return "Run `cogcoin sync` to bootstrap assumeutxo and the managed Bitcoin/indexer state.";
  }

  return getMutationRecommendation(context);
}
