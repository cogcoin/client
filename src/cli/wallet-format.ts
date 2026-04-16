import {
  findDomainField,
  findWalletDomain,
  formatFieldFormat,
  listDomainFields,
  listWalletLocks,
} from "../wallet/read/index.js";
import type {
  WalletDomainView,
  WalletFieldView,
  WalletReadContext,
} from "../wallet/read/index.js";
import type { PendingMutationRecord } from "../wallet/types.js";
import { formatMiningSummaryLine } from "./mining-format.js";
import { getBootstrapSyncNextStep } from "./workflow-hints.js";

function formatCogAmount(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 100_000_000n;
  const fraction = absolute % 100_000_000n;
  return `${sign}${whole.toString()}.${fraction.toString().padStart(8, "0")} COG`;
}

function formatServiceHealth(health: string): string {
  return health.replaceAll("-", " ");
}

function formatMaybe(value: string | number | null): string {
  return value === null ? "unavailable" : String(value);
}

function formatIndexerTruthSource(source: WalletReadContext["indexer"]["source"]): string {
  switch (source) {
    case "lease":
      return "coherent snapshot lease";
    case "probe":
      return "live daemon probe";
    case "status-file":
      return "advisory status file";
    default:
      return "none";
  }
}

function formatUnlockExpiry(unlockUntilUnixMs: number | null): string {
  if (unlockUntilUnixMs === null) {
    return "locked";
  }

  return `unlocked until ${new Date(unlockUntilUnixMs).toISOString()}`;
}

function isReputationMutation(
  mutation: PendingMutationRecord,
): mutation is PendingMutationRecord & { kind: "rep-give" | "rep-revoke"; recipientDomainName: string } {
  return (mutation.kind === "rep-give" || mutation.kind === "rep-revoke")
    && mutation.recipientDomainName !== undefined
    && mutation.recipientDomainName !== null;
}

function formatPendingMutationKind(mutation: PendingMutationRecord): string {
  if (mutation.kind === "sell" && mutation.priceCogtoshi === 0n) {
    return "unsell";
  }

  if (mutation.kind === "claim" && mutation.preimageHex === "0000000000000000000000000000000000000000000000000000000000000000") {
    return "reclaim";
  }

  if (mutation.kind === "endpoint" && mutation.endpointValueHex === "") {
    return "endpoint-clear";
  }

  if (mutation.kind === "delegate" && mutation.recipientScriptPubKeyHex === null) {
    return "delegate-clear";
  }

  if (mutation.kind === "miner" && mutation.recipientScriptPubKeyHex === null) {
    return "miner-clear";
  }

  return mutation.kind;
}

function formatPendingMutationSummaryLabel(mutation: PendingMutationRecord): string {
  if (isReputationMutation(mutation)) {
    return `${formatPendingMutationKind(mutation)} ${mutation.domainName}->${mutation.recipientDomainName}`;
  }

  return `${formatPendingMutationKind(mutation)}${mutation.domainName === "" ? "" : ` ${mutation.domainName}`}${mutation.fieldName == null ? "" : `.${mutation.fieldName}`}`;
}

function formatPendingMutationDomainLabel(mutation: PendingMutationRecord): string {
  if (isReputationMutation(mutation)) {
    return `${formatPendingMutationKind(mutation)} ${mutation.domainName}->${mutation.recipientDomainName}`;
  }

  const kind = mutation.kind === "endpoint" && mutation.endpointValueHex === ""
    ? "endpoint-clear"
    : mutation.kind === "delegate" && mutation.recipientScriptPubKeyHex === null
      ? "delegate-clear"
      : mutation.kind === "miner" && mutation.recipientScriptPubKeyHex === null
        ? "miner-clear"
        : formatPendingMutationKind(mutation);

  return kind;
}

export function getRepairRecommendation(context: WalletReadContext): string | null {
  if (context.localState.availability === "uninitialized") {
    return "Run `cogcoin init` to create a new local wallet root.";
  }

  if (context.localState.availability === "local-state-corrupt") {
    return "Run `cogcoin repair` to recover local wallet state.";
  }

  if (
    context.bitcoind.health === "service-version-mismatch"
    || context.bitcoind.health === "wallet-root-mismatch"
    || context.bitcoind.health === "runtime-mismatch"
    || context.bitcoind.health === "replica-missing"
    || context.bitcoind.health === "replica-mismatch"
    || context.bitcoind.health === "failed"
  ) {
    return "Run `cogcoin repair` to recover the managed bitcoind service and Core wallet replica.";
  }

  if (
    context.indexer.health === "failed"
    || context.indexer.health === "schema-mismatch"
    || context.indexer.health === "service-version-mismatch"
    || context.indexer.health === "wallet-root-mismatch"
  ) {
    return "Run `cogcoin repair` to recover the managed indexer daemon and local indexer artifacts.";
  }

  if (
    context.localState.state?.miningState.state === "repair-required"
    || (context.localState.state?.pendingMutations ?? []).some((mutation) => mutation.status === "repair-required")
  ) {
    return "Run `cogcoin repair` before relying on local wallet state.";
  }

  return null;
}

export function getMutationRecommendation(context: WalletReadContext): string | null {
  const pendingMutations = context.localState.state?.pendingMutations ?? [];
  const unresolved = pendingMutations.find((mutation) =>
    mutation.status === "broadcast-unknown" || mutation.status === "repair-required"
  );

  if (unresolved === undefined) {
    return null;
  }

  if (unresolved.status === "repair-required") {
    return "Run `cogcoin repair` before starting another mutation.";
  }

  if (unresolved.kind === "register") {
    return `Rerun \`cogcoin register ${unresolved.domainName}\` to reconcile the pending registration, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "anchor") {
    return `Rerun \`cogcoin anchor ${unresolved.domainName}\` to reconcile the pending anchor, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "transfer") {
    return `Rerun \`cogcoin transfer ${unresolved.domainName}\` with the same target to reconcile the pending transfer, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "sell") {
    const command = unresolved.priceCogtoshi === 0n ? "unsell" : "sell";
    return `Rerun \`cogcoin ${command} ${unresolved.domainName}\` to reconcile the pending listing change, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "buy") {
    return `Rerun \`cogcoin buy ${unresolved.domainName}\` to reconcile the pending purchase, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "endpoint") {
    return unresolved.endpointValueHex === ""
      ? `Rerun \`cogcoin domain endpoint clear ${unresolved.domainName}\` to reconcile the pending endpoint clear, or run \`cogcoin repair\` if it remains unresolved.`
      : `Rerun \`cogcoin domain endpoint set ${unresolved.domainName} ...\` to reconcile the pending endpoint update, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "delegate") {
    return unresolved.recipientScriptPubKeyHex === null
      ? `Rerun \`cogcoin domain delegate clear ${unresolved.domainName}\` to reconcile the pending delegate clear, or run \`cogcoin repair\` if it remains unresolved.`
      : `Rerun \`cogcoin domain delegate set ${unresolved.domainName} ...\` to reconcile the pending delegate update, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "miner") {
    return unresolved.recipientScriptPubKeyHex === null
      ? `Rerun \`cogcoin domain miner clear ${unresolved.domainName}\` to reconcile the pending miner clear, or run \`cogcoin repair\` if it remains unresolved.`
      : `Rerun \`cogcoin domain miner set ${unresolved.domainName} ...\` to reconcile the pending miner update, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "canonical") {
    return `Rerun \`cogcoin domain canonical ${unresolved.domainName}\` to reconcile the pending canonical update, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "field-create") {
    return `Rerun \`cogcoin field create ${unresolved.domainName} ${unresolved.fieldName} ...\` to reconcile the pending field creation, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "field-set") {
    return `Rerun \`cogcoin field set ${unresolved.domainName} ${unresolved.fieldName} ...\` to reconcile the pending field update, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "field-clear") {
    return `Rerun \`cogcoin field clear ${unresolved.domainName} ${unresolved.fieldName}\` to reconcile the pending field clear, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "rep-give") {
    return `Rerun \`cogcoin rep give ${unresolved.domainName} ${unresolved.recipientDomainName ?? "..."} ...\` to reconcile the pending reputation support, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "rep-revoke") {
    return `Rerun \`cogcoin rep revoke ${unresolved.domainName} ${unresolved.recipientDomainName ?? "..."} ...\` to reconcile the pending reputation revoke, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "send") {
    return "Rerun the same `cogcoin send ...` command to reconcile the pending transfer, or run `cogcoin repair` if it remains unresolved.";
  }

  if (unresolved.kind === "lock") {
    return "Rerun the same `cogcoin cog lock ...` command to reconcile the pending lock, or run `cogcoin repair` if it remains unresolved.";
  }

  return unresolved.preimageHex === "0000000000000000000000000000000000000000000000000000000000000000"
    ? "Rerun the same `cogcoin reclaim ...` command to reconcile the pending reclaim, or run `cogcoin repair` if it remains unresolved."
    : "Rerun the same `cogcoin claim ...` command to reconcile the pending claim, or run `cogcoin repair` if it remains unresolved.";
}

function appendPendingMutationSummary(lines: string[], context: WalletReadContext): void {
  const pendingMutations = (context.localState.state?.pendingMutations ?? [])
    .filter((mutation) =>
      mutation.status !== "confirmed" && mutation.status !== "canceled"
    );

  if (pendingMutations.length === 0) {
    lines.push("Pending mutations: none");
    return;
  }

  for (const mutation of pendingMutations) {
    lines.push(
      `Pending mutation: ${formatPendingMutationSummaryLabel(mutation)}  ${mutation.status}  sender spk:${mutation.senderScriptPubKeyHex}${mutation.priceCogtoshi === undefined || mutation.priceCogtoshi === null ? "" : `  price ${formatCogAmount(mutation.priceCogtoshi)}`}${mutation.amountCogtoshi === undefined || mutation.amountCogtoshi === null ? "" : `  amount ${formatCogAmount(mutation.amountCogtoshi)}`}${isReputationMutation(mutation) ? "" : mutation.recipientDomainName === undefined || mutation.recipientDomainName === null ? "" : `  domain ${mutation.recipientDomainName}`}${mutation.lockId === undefined || mutation.lockId === null ? "" : `  lock ${mutation.lockId}`}${mutation.recipientScriptPubKeyHex === undefined || mutation.recipientScriptPubKeyHex === null ? "" : `  recipient spk:${mutation.recipientScriptPubKeyHex}`}${mutation.kind === "endpoint" ? (mutation.endpointValueHex === "" ? "  endpoint clear" : `  endpoint-bytes ${(mutation.endpointValueHex?.length ?? 0) / 2}`) : ""}${mutation.kind === "field-create" || mutation.kind === "field-set" ? `  format ${formatFieldFormat(mutation.fieldFormat ?? 0)}` : ""}${mutation.kind === "field-clear" ? "  clear" : ""}${mutation.reviewPayloadHex === undefined || mutation.reviewPayloadHex === null ? "" : "  review"}`,
    );
  }
}

function listPendingDomainMutations(context: WalletReadContext, domainName: string) {
  return (context.localState.state?.pendingMutations ?? [])
    .filter((mutation) =>
      (mutation.kind === "register"
        || mutation.kind === "transfer"
        || mutation.kind === "sell"
        || mutation.kind === "buy"
        || mutation.kind === "anchor"
        || mutation.kind === "endpoint"
        || mutation.kind === "delegate"
        || mutation.kind === "miner"
        || mutation.kind === "canonical"
        || mutation.kind === "field-create"
        || mutation.kind === "field-set"
        || mutation.kind === "field-clear")
      && mutation.domainName === domainName
      && mutation.status !== "confirmed"
      && mutation.status !== "canceled"
    );
}

function listPendingDomainShowMutations(context: WalletReadContext, domainName: string) {
  return (context.localState.state?.pendingMutations ?? [])
    .filter((mutation) =>
      (
        mutation.kind === "register"
        || mutation.kind === "transfer"
        || mutation.kind === "sell"
        || mutation.kind === "buy"
        || mutation.kind === "anchor"
        || mutation.kind === "endpoint"
        || mutation.kind === "delegate"
        || mutation.kind === "miner"
        || mutation.kind === "canonical"
        || mutation.kind === "field-create"
        || mutation.kind === "field-set"
        || mutation.kind === "field-clear"
        || mutation.kind === "rep-give"
        || mutation.kind === "rep-revoke"
      )
      && (mutation.domainName === domainName || mutation.recipientDomainName === domainName)
      && mutation.status !== "confirmed"
      && mutation.status !== "canceled"
    );
}

function listPendingFieldMutations(
  context: WalletReadContext,
  domainName: string,
  fieldName?: string,
) {
  return (context.localState.state?.pendingMutations ?? [])
    .filter((mutation) =>
      (mutation.kind === "field-create" || mutation.kind === "field-set" || mutation.kind === "field-clear")
      && mutation.domainName === domainName
      && (fieldName === undefined || mutation.fieldName === fieldName)
      && mutation.status !== "confirmed"
      && mutation.status !== "canceled"
    );
}

function appendServiceSummary(lines: string[], context: WalletReadContext): void {
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

function appendWalletAvailability(lines: string[], context: WalletReadContext): void {
  lines.push(`Wallet state: ${context.localState.availability}`);
  lines.push(`Wallet root: ${context.model?.walletRootId ?? context.localState.walletRootId ?? context.nodeStatus?.walletRootId ?? "none"}`);
  lines.push(`Wallet unlock: ${formatUnlockExpiry(context.localState.unlockUntilUnixMs)}`);

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
    const bootstrapSync = getBootstrapSyncNextStep(context);
    if (bootstrapSync !== null) {
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

interface OverviewEntry {
  text: string;
  ok: boolean;
}

function overviewEntry(text: string, ok: boolean): OverviewEntry {
  return { text, ok };
}

function formatOverviewSection(header: string, entries: readonly OverviewEntry[]): string {
  return [header, ...entries.map((entry) => `${entry.ok ? "✓" : "✗"} ${entry.text}`)].join("\n");
}

function isMiningOverviewOk(mining: NonNullable<WalletReadContext["mining"]>): boolean {
  return mining.runtime.bitcoindHealth === "ready"
    && mining.runtime.nodeHealth === "synced"
    && mining.runtime.indexerHealth === "synced"
    && mining.runtime.miningState !== "repair-required"
    && mining.runtime.miningState !== "paused-stale"
    && !(mining.runtime.miningState === "paused" && mining.runtime.liveMiningFamilyInMempool === true);
}

function buildOverviewPathsSection(context: WalletReadContext): OverviewEntry[] {
  return [
    overviewEntry(`DB path: ${context.databasePath}`, true),
    overviewEntry(`Bitcoin datadir: ${context.dataDir}`, true),
  ];
}

function buildOverviewWalletSection(context: WalletReadContext): OverviewEntry[] {
  const walletRoot = context.model?.walletRootId ?? context.localState.walletRootId ?? context.nodeStatus?.walletRootId ?? "none";
  const lines = [
    overviewEntry(`State: ${context.localState.availability}`, context.localState.availability === "ready"),
    overviewEntry(`Root: ${walletRoot}`, walletRoot !== "none"),
    overviewEntry(`Unlock: ${formatUnlockExpiry(context.localState.unlockUntilUnixMs)}`, context.localState.unlockUntilUnixMs !== null),
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
    overviewEntry("Read-only identities: 0", true),
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

function getOverviewNextStep(context: WalletReadContext): string | null {
  const repairRecommendation = getRepairRecommendation(context);
  if (repairRecommendation !== null) {
    return repairRecommendation;
  }

  if (getBootstrapSyncNextStep(context) !== null) {
    return "Run `cogcoin sync` to bootstrap assumeutxo and the managed Bitcoin/indexer state.";
  }

  return getMutationRecommendation(context);
}

export function formatWalletOverviewReport(context: WalletReadContext, version: string): string {
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

export function formatDetailedWalletStatusReport(context: WalletReadContext): string {
  const lines = ["Cogcoin Wallet Status"];
  appendWalletAvailability(lines, context);
  appendServiceSummary(lines, context);

  if (context.model === null) {
    lines.push("Wallet details are unavailable until the encrypted wallet state can be read.");
    return lines.join("\n");
  }

  lines.push(`Wallet address: ${context.model.walletAddress ?? "unavailable"}`);
  lines.push(`Wallet script: spk:${context.model.walletScriptPubKeyHex ?? "unavailable"}`);
  lines.push("Local wallet addresses: 1");
  lines.push(`Locally related domains: ${context.model.domains.length}`);
  appendPendingMutationSummary(lines, context);

  return lines.join("\n");
}

export function formatFundingAddressReport(context: WalletReadContext): string {
  const lines = ["BTC Wallet Address"];

  if (context.model === null) {
    appendWalletAvailability(lines, context);
    return lines.join("\n");
  }

  lines.push(`Address: ${context.model.walletAddress ?? "unavailable"}`);
  lines.push(`ScriptPubKey: spk:${context.model.walletScriptPubKeyHex}`);

  return lines.join("\n");
}

export function formatIdentityListReport(
  context: WalletReadContext,
  options: {
    limit?: number | null;
    all?: boolean;
  } = {},
): string {
  const lines = ["Wallet Address"];

  if (context.model === null) {
    appendWalletAvailability(lines, context);
    return lines.join("\n");
  }

  const domains = context.model.domains
    .filter((domain) => domain.localRelationship === "local")
    .map((domain) => domain.name)
    .sort();
  const balance = context.model.identities[0]?.observedCogBalance ?? null;
  lines.push(
    `${context.model.walletAddress ?? `spk:${context.model.walletScriptPubKeyHex}`}  balance ${balance === null ? "unavailable" : formatCogAmount(balance)}  domains ${domains.length === 0 ? "none" : domains.join(", ")}`,
  );

  return lines.join("\n");
}

export function formatBalanceReport(context: WalletReadContext): string {
  const lines = ["COG Balance"];

  if (context.model === null) {
    appendWalletAvailability(lines, context);
    return lines.join("\n");
  }

  if (context.snapshot === null) {
    lines.push(`Indexer-backed balances are unavailable while the indexer is ${formatServiceHealth(context.indexer.health)}.`);
    return lines.join("\n");
  }

  const spendableTotal = context.model.identities.reduce((sum, identity) =>
    identity.observedCogBalance === null ? sum : sum + identity.observedCogBalance,
  0n);

  lines.push(`Spendable total: ${formatCogAmount(spendableTotal)}`);
  lines.push(`${context.model.walletAddress ?? `spk:${context.model.walletScriptPubKeyHex}`}  ${formatCogAmount(spendableTotal)}`);

  for (const mutation of (context.localState.state?.pendingMutations ?? [])
    .filter((entry) =>
      (entry.kind === "send" || entry.kind === "lock" || entry.kind === "claim")
      && entry.status !== "confirmed"
      && entry.status !== "canceled"
    )) {
    const label = mutation.kind === "claim" && mutation.preimageHex === "0000000000000000000000000000000000000000000000000000000000000000"
      ? "reclaim"
      : mutation.kind;
    lines.push(`Pending: ${label}  ${mutation.status}${mutation.amountCogtoshi === null || mutation.amountCogtoshi === undefined ? "" : `  ${formatCogAmount(mutation.amountCogtoshi)}`}`);
  }

  return lines.join("\n");
}

export function formatLocksReport(
  context: WalletReadContext,
  options: {
    claimableOnly?: boolean;
    reclaimableOnly?: boolean;
    limit?: number | null;
    all?: boolean;
  } = {},
): string {
  const lines = ["COG Locks"];

  if (context.model === null) {
    appendWalletAvailability(lines, context);
    return lines.join("\n");
  }

  const locks = listWalletLocks(context);

  if (locks === null) {
    lines.push(`Lock state is unavailable while the indexer is ${formatServiceHealth(context.indexer.health)}.`);
    return lines.join("\n");
  }

  let filteredLocks = locks;

  if (options.claimableOnly) {
    filteredLocks = filteredLocks.filter((lock) => lock.claimableNow);
  } else if (options.reclaimableOnly) {
    filteredLocks = filteredLocks.filter((lock) => lock.reclaimableNow);
  }

  const totalMatching = filteredLocks.length;

  if (!options.all && options.limit !== null && options.limit !== undefined) {
    filteredLocks = filteredLocks.slice(0, options.limit);
  }

  if (filteredLocks.length === 0) {
    lines.push("No locally related active locks.");
    return lines.join("\n");
  }

  for (const lock of filteredLocks) {
    const role = lock.lockerLocalIndex !== null ? `locker ${lock.lockerLocalIndex}` : "recipient";
    const action = lock.claimableNow
      ? "claimable-now"
      : lock.reclaimableNow
        ? "reclaimable-now"
        : "not-actionable-now";
    lines.push(
      `lock:${lock.lockId}  ${formatCogAmount(lock.amountCogtoshi)}  timeout ${lock.timeoutHeight}  domain ${lock.recipientDomainName ?? lock.recipientDomainId}  ${role}  ${action}`,
    );
  }

  for (const mutation of (context.localState.state?.pendingMutations ?? [])
    .filter((entry) =>
      (entry.kind === "lock" || entry.kind === "claim")
      && entry.status !== "confirmed"
      && entry.status !== "canceled"
    )) {
    const label = mutation.kind === "claim" && mutation.preimageHex === "0000000000000000000000000000000000000000000000000000000000000000"
      ? "reclaim"
      : mutation.kind;
    lines.push(`Pending: ${label}  ${mutation.status}${mutation.lockId === null || mutation.lockId === undefined ? "" : `  lock:${mutation.lockId}`}${mutation.recipientDomainName === null || mutation.recipientDomainName === undefined ? "" : `  domain ${mutation.recipientDomainName}`}`);
  }

  if (!options.all && options.limit !== null && options.limit !== undefined && totalMatching > options.limit) {
    lines.push(`Showing first ${filteredLocks.length} of ${totalMatching}. Use --limit <n> or --all for more.`);
  }

  return lines.join("\n");
}

export function formatDomainsReport(
  context: WalletReadContext,
  options: {
    limit?: number | null;
    all?: boolean;
    domains?: WalletDomainView[] | null;
    activeFilters?: string[];
  } = {},
): string {
  const lines = ["Domains"];

  if (context.model === null) {
    appendWalletAvailability(lines, context);
    return lines.join("\n");
  }

  const visibleDomains = options.domains ?? context.model.domains;

  if (visibleDomains.length === 0) {
    if ((options.activeFilters?.length ?? 0) > 0) {
      lines.push(`No locally related domains matched the active filters (${options.activeFilters!.join(", ")}).`);
      return lines.join("\n");
    }

    lines.push("No locally related domains.");
    return lines.join("\n");
  }

  const renderedDomains = options.all || options.limit === null || options.limit === undefined
    ? visibleDomains
    : visibleDomains.slice(0, options.limit);

  for (const domain of renderedDomains) {
    const pending = listPendingDomainMutations(context, domain.name);
    const pendingFieldMutations = listPendingFieldMutations(context, domain.name);
    const pendingText = pending.length === 0
      ? ""
      : `  pending ${pending.map((mutation) =>
        mutation.kind === "sell" && mutation.priceCogtoshi === 0n
          ? `unsell:${mutation.status}`
          : mutation.kind === "endpoint" && mutation.endpointValueHex === ""
            ? `endpoint-clear:${mutation.status}`
            : mutation.kind === "delegate" && mutation.recipientScriptPubKeyHex === null
              ? `delegate-clear:${mutation.status}`
              : mutation.kind === "miner" && mutation.recipientScriptPubKeyHex === null
                ? `miner-clear:${mutation.status}`
          : `${mutation.kind}:${mutation.status}`
      ).join(",")}`;
    const pendingFieldsText = pendingFieldMutations.length === 0
      ? ""
      : `  field-pending ${pendingFieldMutations.map((mutation) =>
        `${mutation.fieldName}:${mutation.kind}:${mutation.status}`
      ).join(",")}`;
    lines.push(
      `${domain.name}  ${domain.chainStatus}  ${domain.localRelationship}  owner ${domain.ownerAddress ?? domain.ownerScriptPubKeyHex ?? "unknown"}  fields ${formatMaybe(domain.fieldCount)}${pendingText}${pendingFieldsText}`,
    );
  }

  if (!options.all && options.limit !== null && options.limit !== undefined && visibleDomains.length > options.limit) {
    lines.push(`Showing first ${renderedDomains.length} of ${visibleDomains.length}. Use --limit <n> or --all for more.`);
  }

  return lines.join("\n");
}

export function formatDomainReport(context: WalletReadContext, domainName: string): string {
  const lines = [`Domain: ${domainName}`];

  if (context.snapshot === null && context.model?.domains.find((domain) => domain.name === domainName) === undefined) {
    lines.push(`Domain state is unavailable while the indexer is ${formatServiceHealth(context.indexer.health)}.`);
    return lines.join("\n");
  }

  const view = findWalletDomain(context, domainName);

  if (view === null) {
    lines.push("Domain not found.");
    return lines.join("\n");
  }

  lines.push(`Domain ID: ${formatMaybe(view.domain.domainId)}`);
  lines.push(`Anchored: ${view.domain.anchored === null ? "unknown" : (view.domain.anchored ? "yes" : "no")}`);
  lines.push(`Owner: ${view.domain.ownerAddress ?? view.domain.ownerScriptPubKeyHex ?? "unknown"}`);
  lines.push(`Local relationship: ${view.localRelationship}`);
  lines.push(`Listing price: ${view.domain.listingPriceCogtoshi === null ? "none" : formatCogAmount(view.domain.listingPriceCogtoshi)}`);
  lines.push(`Field count: ${formatMaybe(view.domain.fieldCount)}`);
  if (
    view.domain.selfStakeCogtoshi !== null
    || view.domain.supportedStakeCogtoshi !== null
    || view.domain.totalSupportedCogtoshi !== null
    || view.domain.totalRevokedCogtoshi !== null
  ) {
    lines.push(`Reputation self-stake: ${view.domain.selfStakeCogtoshi === null ? "unavailable" : formatCogAmount(view.domain.selfStakeCogtoshi)}`);
    lines.push(`Reputation supported stake: ${view.domain.supportedStakeCogtoshi === null ? "unavailable" : formatCogAmount(view.domain.supportedStakeCogtoshi)}`);
    lines.push(`Reputation total supported: ${view.domain.totalSupportedCogtoshi === null ? "unavailable" : formatCogAmount(view.domain.totalSupportedCogtoshi)}`);
    lines.push(`Reputation total revoked: ${view.domain.totalRevokedCogtoshi === null ? "unavailable" : formatCogAmount(view.domain.totalRevokedCogtoshi)}`);
  }
  lines.push(`Delegate: ${view.domain.delegateScriptPubKeyHex ?? "none"}`);
  lines.push(`Designated miner: ${view.domain.minerScriptPubKeyHex ?? "none"}`);
  lines.push(`Endpoint: ${view.domain.endpointText ?? "none"}`);
  lines.push(`Founding message: ${view.domain.foundingMessageText ?? "none"}`);
  for (const mutation of listPendingDomainShowMutations(context, domainName)) {
    lines.push(`Pending mutation: ${formatPendingMutationDomainLabel(mutation)}  ${mutation.status}`);
  }
  for (const mutation of listPendingFieldMutations(context, domainName)) {
    lines.push(`Pending field mutation: ${mutation.fieldName ?? "unknown"}  ${mutation.kind}  ${mutation.status}`);
  }

  return lines.join("\n");
}

function renderFieldLine(field: WalletFieldView): string {
  return `${field.name}  id ${field.fieldId}  ${field.permanent ? "permanent" : "mutable"}  ${field.hasValue ? formatFieldFormat(field.format) : "empty"}  ${field.preview ?? "(no value)"}`;
}

export function formatFieldsReport(
  context: WalletReadContext,
  domainName: string,
  options: {
    limit?: number | null;
    all?: boolean;
  } = {},
): string {
  const lines = [`Fields: ${domainName}`];

  if (context.snapshot === null) {
    lines.push(`Field state is unavailable while the indexer is ${formatServiceHealth(context.indexer.health)}.`);
    return lines.join("\n");
  }

  const fields = listDomainFields(context, domainName);

  if (fields === null) {
    lines.push("Domain not found.");
    return lines.join("\n");
  }

  const renderedFields = options.all || options.limit === null || options.limit === undefined
    ? fields
    : fields.slice(0, options.limit);

  if (renderedFields.length === 0) {
    lines.push("No fields found.");
  } else {
    for (const field of renderedFields) {
      lines.push(renderFieldLine(field));
    }
  }

  for (const mutation of listPendingFieldMutations(context, domainName)) {
    lines.push(`Pending field mutation: ${mutation.fieldName ?? "unknown"}  ${mutation.kind}  ${mutation.status}`);
  }

  if (!options.all && options.limit !== null && options.limit !== undefined && fields.length > options.limit) {
    lines.push(`Showing first ${renderedFields.length} of ${fields.length}. Use --limit <n> or --all for more.`);
  }

  return lines.join("\n");
}

export function formatFieldReport(context: WalletReadContext, domainName: string, fieldName: string): string {
  const lines = [`Field: ${domainName}.${fieldName}`];

  if (context.snapshot === null) {
    lines.push(`Field state is unavailable while the indexer is ${formatServiceHealth(context.indexer.health)}.`);
    return lines.join("\n");
  }

  const field = findDomainField(context, domainName, fieldName);
  const pendingMutations = listPendingFieldMutations(context, domainName, fieldName);

  if (field === null) {
    lines.push("Field not found.");
  } else {
    lines.push(`Domain ID: ${field.domainId}`);
    lines.push(`Field ID: ${field.fieldId}`);
    lines.push(`Permanent: ${field.permanent ? "yes" : "no"}`);
    lines.push(`Has value: ${field.hasValue ? "yes" : "no"}`);
    lines.push(`Format: ${formatFieldFormat(field.format)}`);
    lines.push(`Preview: ${field.preview ?? "(no value)"}`);
    lines.push(`Raw value hex: ${field.rawValueHex ?? "none"}`);
  }

  for (const mutation of pendingMutations) {
    lines.push(`Pending field mutation: ${mutation.kind}  ${mutation.status}`);
  }

  return lines.join("\n");
}
