import { getBalance } from "@cogcoin/indexer/queries";

import type { WalletReadContext } from "../../wallet/read/index.js";
import { appendWalletAvailability } from "./availability.js";
import { formatCogAmount } from "./shared.js";

export function formatIdentityListReport(
  context: WalletReadContext,
  _options: {
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
  const balance = context.snapshot === null
    ? null
    : getBalance(
      context.snapshot.state,
      new Uint8Array(Buffer.from(context.model.walletScriptPubKeyHex, "hex")),
    );
  lines.push(
    `${context.model.walletAddress ?? `spk:${context.model.walletScriptPubKeyHex}`}  balance ${balance === null ? "unavailable" : formatCogAmount(balance)}  domains ${domains.length === 0 ? "none" : domains.join(", ")}`,
  );

  return lines.join("\n");
}
