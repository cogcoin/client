import type { WalletReadContext } from "../../wallet/read/index.js";
import { formatMiningSummaryLine } from "../mining-format.js";
import { getOverviewNextStep, resolveWalletRootLabel } from "./availability.js";
import {
  formatIndexerTruthSource,
  formatMaybe,
  formatServiceHealth,
} from "./shared.js";
import {
  formatPendingMutationSummaryLabel,
  isReputationMutation,
} from "./pending.js";
import { formatCogAmount } from "./shared.js";
import { formatFieldFormat } from "../../wallet/read/index.js";

interface OverviewEntry {
  text: string;
  ok: boolean;
}

function overviewEntry(text: string, ok: boolean): OverviewEntry {
  return { text, ok };
}

function formatOverviewSection(
  header: string,
  entries: readonly OverviewEntry[],
): string {
  return [header, ...entries.map((entry) => `${entry.ok ? "✓" : "✗"} ${entry.text}`)].join("\n");
}

function isMiningOverviewOk(
  mining: NonNullable<WalletReadContext["mining"]>,
): boolean {
  return mining.runtime.bitcoindHealth === "ready"
    && mining.runtime.nodeHealth === "synced"
    && mining.runtime.indexerHealth === "synced"
    && mining.runtime.miningState !== "repair-required"
    && mining.runtime.miningState !== "paused-stale"
    && !(mining.runtime.miningState === "paused" && mining.runtime.livePublishInMempool === true);
}

function buildOverviewPathsSection(context: WalletReadContext): OverviewEntry[] {
  return [
    overviewEntry(`DB path: ${context.databasePath}`, true),
    overviewEntry(`Bitcoin datadir: ${context.dataDir}`, true),
  ];
}

function buildOverviewWalletSection(context: WalletReadContext): OverviewEntry[] {
  const lines = [
    overviewEntry(`State: ${context.localState.availability}`, context.localState.availability === "ready"),
    overviewEntry(`Root: ${resolveWalletRootLabel(context)}`, resolveWalletRootLabel(context) !== "none"),
  ];

  if (context.localState.message !== null) {
    lines.push(overviewEntry(`Note: ${context.localState.message}`, false));
  }

  const nodeStatus = context.nodeStatus;
  const replica = nodeStatus?.walletReplica ?? null;

  if (replica !== null) {
    lines.push(overviewEntry(`Managed Core wallet: ${replica.proofStatus ?? "not-proven"}`, replica.proofStatus === "ready"));
  }

  if (nodeStatus?.walletReplicaMessage) {
    lines.push(overviewEntry(`Managed Core note: ${nodeStatus.walletReplicaMessage}`, replica?.proofStatus === "ready"));
  }

  return lines;
}

function buildOverviewServicesSection(context: WalletReadContext): OverviewEntry[] {
  const bitcoindOk = context.bitcoind.health === "ready";
  const nodeOk = context.nodeHealth === "synced";
  const indexerOk = context.indexer.health === "synced";
  const lines = [
    overviewEntry(`Managed bitcoind: ${formatServiceHealth(context.bitcoind.health)}`, bitcoindOk),
  ];

  if (context.bitcoind.message !== null) {
    lines.push(overviewEntry(`Managed bitcoind note: ${context.bitcoind.message}`, bitcoindOk));
  }

  lines.push(overviewEntry(`Bitcoin service: ${formatServiceHealth(context.nodeHealth)}`, nodeOk));

  if (context.nodeStatus !== null) {
    lines.push(overviewEntry(`Bitcoin best height: ${formatMaybe(context.nodeStatus.nodeBestHeight)}`, nodeOk));
    lines.push(overviewEntry(`Bitcoin headers: ${formatMaybe(context.nodeStatus.nodeHeaderHeight)}`, nodeOk));
  }

  if (context.nodeMessage !== null) {
    lines.push(overviewEntry(`Bitcoin note: ${context.nodeMessage}`, nodeOk));
  }

  lines.push(overviewEntry(`Indexer service: ${formatServiceHealth(context.indexer.health)}`, indexerOk));
  lines.push(overviewEntry(`Indexer truth source: ${formatIndexerTruthSource(context.indexer.source)}`, indexerOk));

  if (context.indexer.daemonInstanceId !== null && context.indexer.daemonInstanceId !== undefined) {
    lines.push(overviewEntry(`Indexer daemon instance: ${context.indexer.daemonInstanceId}`, indexerOk));
  }

  if (context.indexer.snapshotSeq !== null && context.indexer.snapshotSeq !== undefined) {
    lines.push(overviewEntry(`Indexer snapshot sequence: ${context.indexer.snapshotSeq}`, indexerOk));
  }

  if (context.indexer.status?.reorgDepth !== null && context.indexer.status?.reorgDepth !== undefined) {
    lines.push(overviewEntry(`Indexer reorg depth: ${context.indexer.status.reorgDepth}`, indexerOk));
  }

  lines.push(overviewEntry(`Indexer tip height: ${context.indexer.snapshotTip === null ? "unavailable" : context.indexer.snapshotTip.height}`, indexerOk));

  if (context.indexer.message !== null) {
    lines.push(overviewEntry(`Indexer note: ${context.indexer.message}`, indexerOk));
  }

  if (context.mining !== undefined) {
    const miningOk = isMiningOverviewOk(context.mining);
    lines.push(overviewEntry(`Mining: ${formatMiningSummaryLine(context.mining)}`, miningOk));

    if (context.mining.runtime.note !== null) {
      lines.push(overviewEntry(`Mining note: ${context.mining.runtime.note}`, miningOk));
    }
  }

  return lines;
}

function buildOverviewLocalInventorySection(context: WalletReadContext): OverviewEntry[] {
  if (context.model === null) {
    return [overviewEntry("Status: Wallet-derived sections unavailable", false)];
  }

  return [
    overviewEntry("Local wallet address: 1", true),
    overviewEntry(`Locally related domains: ${context.model.domains.length}`, true),
  ];
}

function buildOverviewPendingWorkSection(context: WalletReadContext): OverviewEntry[] {
  const pendingMutations = (context.localState.state?.pendingMutations ?? [])
    .filter((mutation) =>
      mutation.status !== "confirmed" && mutation.status !== "canceled"
    );

  if (pendingMutations.length === 0) {
    return [overviewEntry("Status: none", true)];
  }

  const lines: OverviewEntry[] = [];

  for (const mutation of pendingMutations) {
    lines.push(overviewEntry(
      `Mutation: ${formatPendingMutationSummaryLabel(mutation)}  ${mutation.status}  sender spk:${mutation.senderScriptPubKeyHex}${mutation.priceCogtoshi === undefined || mutation.priceCogtoshi === null ? "" : `  price ${formatCogAmount(mutation.priceCogtoshi)}`}${mutation.amountCogtoshi === undefined || mutation.amountCogtoshi === null ? "" : `  amount ${formatCogAmount(mutation.amountCogtoshi)}`}${isReputationMutation(mutation) ? "" : mutation.recipientDomainName === undefined || mutation.recipientDomainName === null ? "" : `  domain ${mutation.recipientDomainName}`}${mutation.lockId === undefined || mutation.lockId === null ? "" : `  lock ${mutation.lockId}`}${mutation.recipientScriptPubKeyHex === undefined || mutation.recipientScriptPubKeyHex === null ? "" : `  recipient spk:${mutation.recipientScriptPubKeyHex}`}${mutation.kind === "endpoint" ? (mutation.endpointValueHex === "" ? "  endpoint clear" : `  endpoint-bytes ${(mutation.endpointValueHex?.length ?? 0) / 2}`) : ""}${mutation.kind === "field-create" || mutation.kind === "field-set" ? `  format ${formatFieldFormat(mutation.fieldFormat ?? 0)}` : ""}${mutation.kind === "field-clear" ? "  clear" : ""}${mutation.reviewPayloadHex === undefined || mutation.reviewPayloadHex === null ? "" : "  review"}`,
      false,
    ));
  }

  return lines;
}

export function formatWalletOverviewReport(
  context: WalletReadContext,
  version: string,
): string {
  const parts = [
    `\n⛭ Cogcoin Status v${version} ⛭`,
    formatOverviewSection("Paths", buildOverviewPathsSection(context)),
    formatOverviewSection("Wallet", buildOverviewWalletSection(context)),
    formatOverviewSection("Services", buildOverviewServicesSection(context)),
    formatOverviewSection("Local Inventory", buildOverviewLocalInventorySection(context)),
    formatOverviewSection("Pending Work", buildOverviewPendingWorkSection(context)),
  ];
  const nextStep = getOverviewNextStep(context);

  if (nextStep !== null) {
    parts.push(`Next step: ${nextStep}`);
  }

  return parts.join("\n\n");
}
