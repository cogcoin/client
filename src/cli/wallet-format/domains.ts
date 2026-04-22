import { findWalletDomain } from "../../wallet/read/index.js";
import type {
  WalletDomainView,
  WalletReadContext,
} from "../../wallet/read/index.js";
import { appendWalletAvailability } from "./availability.js";
import {
  formatCogAmount,
  formatMaybe,
  formatServiceHealth,
} from "./shared.js";
import {
  formatPendingMutationDomainLabel,
  listPendingDomainMutations,
  listPendingDomainShowMutations,
  listPendingFieldMutations,
} from "./pending.js";

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

export function formatDomainReport(
  context: WalletReadContext,
  domainName: string,
): string {
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
