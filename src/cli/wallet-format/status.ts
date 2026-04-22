import type { WalletReadContext } from "../../wallet/read/index.js";
import { appendServiceSummary, appendWalletAvailability } from "./availability.js";
import { appendPendingMutationSummary } from "./pending.js";

export function formatDetailedWalletStatusReport(
  context: WalletReadContext,
): string {
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
