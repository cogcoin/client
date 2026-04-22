import type { ParsedCliArgs } from "../../types.js";
import { anchorMutationCommandSpec } from "./anchor.js";
import { bitcoinTransferCommandSpec } from "./bitcoin-transfer.js";
import { cogMutationCommandSpec } from "./cog.js";
import { domainAdminMutationCommandSpec } from "./domain-admin.js";
import { domainMarketMutationCommandSpec } from "./domain-market.js";
import { fieldMutationCommandSpec } from "./field.js";
import { registerMutationCommandSpec } from "./register.js";
import { reputationMutationCommandSpec } from "./reputation.js";
import type { WalletMutationCommandSpec } from "./types.js";

const walletMutationCommandSpecs = new Map<
  NonNullable<ParsedCliArgs["command"]>,
  WalletMutationCommandSpec
>([
  ["bitcoin-transfer", bitcoinTransferCommandSpec],
  ["anchor", anchorMutationCommandSpec],
  ["register", registerMutationCommandSpec],
  ["transfer", domainMarketMutationCommandSpec],
  ["sell", domainMarketMutationCommandSpec],
  ["unsell", domainMarketMutationCommandSpec],
  ["buy", domainMarketMutationCommandSpec],
  ["domain-endpoint-set", domainAdminMutationCommandSpec],
  ["domain-endpoint-clear", domainAdminMutationCommandSpec],
  ["domain-delegate-set", domainAdminMutationCommandSpec],
  ["domain-delegate-clear", domainAdminMutationCommandSpec],
  ["domain-miner-set", domainAdminMutationCommandSpec],
  ["domain-miner-clear", domainAdminMutationCommandSpec],
  ["domain-canonical", domainAdminMutationCommandSpec],
  ["field-create", fieldMutationCommandSpec],
  ["field-set", fieldMutationCommandSpec],
  ["field-clear", fieldMutationCommandSpec],
  ["send", cogMutationCommandSpec],
  ["cog-lock", cogMutationCommandSpec],
  ["claim", cogMutationCommandSpec],
  ["reclaim", cogMutationCommandSpec],
  ["rep-give", reputationMutationCommandSpec],
  ["rep-revoke", reputationMutationCommandSpec],
]);

export function getWalletMutationCommandSpec(
  command: ParsedCliArgs["command"],
): WalletMutationCommandSpec | null {
  if (command === null) {
    return null;
  }

  return walletMutationCommandSpecs.get(command) ?? null;
}
