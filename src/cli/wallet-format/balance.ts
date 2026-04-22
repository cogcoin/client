import { getBalance } from "@cogcoin/indexer/queries";

import { isRootDomainName } from "../../wallet/read/index.js";
import type {
  WalletDomainView,
  WalletReadContext,
} from "../../wallet/read/index.js";
import { loadBalanceArtText } from "../art.js";
import {
  formatNextStepLines,
  getFundingQuickstartGuidance,
} from "../workflow-hints.js";
import { appendWalletAvailability } from "./availability.js";
import {
  formatBitcoinAmount,
  formatCogAmount,
  formatServiceHealth,
} from "./shared.js";

const BALANCE_QUICKSTART_THRESHOLD_SATS = 150_000n;
const BALANCE_BUY_ROOT_THRESHOLD_SATS = 100_000n;
const BALANCE_MINING_THRESHOLD_SATS = 10_000n;

function renderBalanceArtLine(
  templateLine: string,
  label: string,
  value: string,
): string {
  const labelIndex = templateLine.indexOf(label);

  if (labelIndex === -1) {
    throw new Error(`balance_art_label_missing_${label}`);
  }

  const fieldStart = labelIndex + label.length;
  const borderIndex = Math.max(templateLine.lastIndexOf("│"), templateLine.lastIndexOf("|"));

  if (borderIndex <= fieldStart) {
    throw new Error(`balance_art_field_invalid_${label}`);
  }

  const fieldWidth = borderIndex - fieldStart;
  const fieldValue = value.slice(0, fieldWidth).padEnd(fieldWidth, " ");
  const rendered = `${templateLine.slice(0, fieldStart)}${fieldValue}${templateLine.slice(borderIndex)}`;

  if (rendered.length !== templateLine.length) {
    throw new Error(`balance_art_render_width_invalid_${label}`);
  }

  return rendered;
}

function renderBalanceArtCard(
  context: WalletReadContext & {
    model: NonNullable<WalletReadContext["model"]>;
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
  },
): string[] {
  const templateLines = loadBalanceArtText().split("\n");
  const fundingAddress = context.model.walletAddress ?? "unavailable";
  const spendableCog = getBalance(
    context.snapshot.state,
    new Uint8Array(Buffer.from(context.model.walletScriptPubKeyHex, "hex")),
  );

  return templateLines.map((line) => {
    if (line.includes("Funding address:")) {
      return renderBalanceArtLine(line, "Funding address:", ` ${fundingAddress}`);
    }

    if (line.includes("Bitcoin Balance:")) {
      return renderBalanceArtLine(line, "Bitcoin Balance:", ` ${formatBitcoinAmount(context.fundingSpendableSats ?? null)}`);
    }

    if (line.includes("Cogcoin Balance:")) {
      return renderBalanceArtLine(line, "Cogcoin Balance:", ` ${formatCogAmount(spendableCog)}`);
    }

    if (line.includes("mempool.space/address/")) {
      return renderBalanceArtLine(line, "mempool.space/address/", fundingAddress);
    }

    return line;
  });
}

function hasRegisteredOrAnchoredDomain(
  model: NonNullable<WalletReadContext["model"]>,
): boolean {
  return model.domains.some((domain) =>
    domain.localRelationship === "local"
    && (domain.chainStatus === "registered-unanchored" || domain.chainStatus === "anchored")
  );
}

function listBalanceDomainsByStatus(
  model: NonNullable<WalletReadContext["model"]>,
  status: "anchored" | "registered-unanchored",
): WalletDomainView[] {
  return model.domains
    .filter((domain) => domain.localRelationship === "local" && domain.chainStatus === status)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function shouldShowBalanceQuickstart(
  context: WalletReadContext & {
    model: NonNullable<WalletReadContext["model"]>;
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
  },
): boolean {
  return context.fundingSpendableSats !== null
    && context.fundingSpendableSats < BALANCE_QUICKSTART_THRESHOLD_SATS
    && !hasRegisteredOrAnchoredDomain(context.model);
}

function formatBalanceDomainSection(
  title: string,
  icon: string,
  domains: readonly WalletDomainView[],
  emptyLabel: string,
): string[] {
  const domainItems = domains.map((domain) => `${icon} ${domain.name}`);

  const wrappedDomainLines: string[] = [];
  let currentLine = "";

  for (const item of domainItems) {
    const candidate = currentLine.length === 0 ? item : `${currentLine}, ${item}`;
    if (candidate.length <= 80) {
      currentLine = candidate;
      continue;
    }

    if (currentLine.length > 0) {
      wrappedDomainLines.push(currentLine);
    }
    currentLine = item;
  }

  if (currentLine.length > 0) {
    wrappedDomainLines.push(currentLine);
  }

  return [
    title,
    ...(domains.length === 0
      ? [emptyLabel]
      : wrappedDomainLines),
  ];
}

function getBalanceNextSteps(
  context: WalletReadContext & {
    model: NonNullable<WalletReadContext["model"]>;
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
  },
): string[] {
  const anchoredDomains = listBalanceDomainsByStatus(context.model, "anchored");
  const anchoredRootDomains = anchoredDomains.filter((domain) => isRootDomainName(domain.name));
  const unanchoredDomains = listBalanceDomainsByStatus(context.model, "registered-unanchored");

  if (anchoredRootDomains.length > 0) {
    if (context.fundingSpendableSats !== null && context.fundingSpendableSats < BALANCE_MINING_THRESHOLD_SATS) {
      return [`Transfer BTC to ${context.model.walletAddress ?? "this wallet address"} so your anchored root domain can keep mining.`];
    }

    if (context.fundingSpendableSats !== null && context.fundingSpendableSats > BALANCE_MINING_THRESHOLD_SATS) {
      if (context.mining?.provider.status === "missing") {
        return ["Run `cogcoin mine setup` to configure your mining provider."];
      }
      return ["Run `cogcoin mine` to start mining with your anchored root domain."];
    }

    return [];
  }

  if (unanchoredDomains.length > 0) {
    return [`Run \`cogcoin anchor ${unanchoredDomains[0]!.name}\` to anchor your unanchored domain.`];
  }

  if (context.fundingSpendableSats !== null && context.fundingSpendableSats > BALANCE_BUY_ROOT_THRESHOLD_SATS) {
    return ["Buy a 6+ character root domain with `cogcoin register <root>`."];
  }

  return [];
}

function listPendingBalanceLines(context: WalletReadContext): string[] {
  const lines: string[] = [];

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

  return lines;
}

function formatReadyBalanceReport(
  context: WalletReadContext & {
    model: NonNullable<WalletReadContext["model"]>;
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
  },
): string {
  const anchoredDomains = listBalanceDomainsByStatus(context.model, "anchored");
  const unanchoredDomains = listBalanceDomainsByStatus(context.model, "registered-unanchored");
  const nextStepLines = formatNextStepLines(getBalanceNextSteps(context));
  const lines = [
    "",
    ...renderBalanceArtCard(context),
    "",
    ...formatBalanceDomainSection(
      "Anchored Domains",
      "⌂",
      anchoredDomains,
      "--- No anchored domains ---",
    ),
    "",
    ...formatBalanceDomainSection(
      "Unanchored Domains",
      "~",
      unanchoredDomains,
      "--- No unanchored domains ---",
    ),
  ];

  if (shouldShowBalanceQuickstart(context)) {
    lines.push("");
    lines.push(`Quickstart: ${getFundingQuickstartGuidance()}`);
  }

  if (nextStepLines.length > 0) {
    lines.push("");
    lines.push(...nextStepLines);
  }

  const pendingLines = listPendingBalanceLines(context);
  if (pendingLines.length > 0) {
    lines.push("");
    lines.push(...pendingLines);
  }

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

  return formatReadyBalanceReport(context as WalletReadContext & {
    model: NonNullable<WalletReadContext["model"]>;
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
  });
}
