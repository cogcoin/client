import { getBalance } from "@cogcoin/indexer/queries";

import type { WalletReadContext } from "../read/index.js";
import { serializeDomainReg } from "../cogop/index.js";

type ReadyWalletMutationContext = WalletReadContext & {
  localState: { availability: "ready" };
  snapshot: NonNullable<WalletReadContext["snapshot"]>;
  model: NonNullable<WalletReadContext["model"]>;
};

export interface ResolvedWalletIdentity {
  index: 0;
  scriptPubKeyHex: string;
  address: string | null;
  observedCogBalance: bigint | null;
  readOnly: false;
}

function resolveWalletIdentity(context: ReadyWalletMutationContext): ResolvedWalletIdentity {
  return {
    index: 0,
    scriptPubKeyHex: context.model.walletScriptPubKeyHex,
    address: context.model.walletAddress,
    observedCogBalance: getBalance(
      context.snapshot.state,
      new Uint8Array(Buffer.from(context.model.walletScriptPubKeyHex, "hex")),
    ),
    readOnly: false,
  };
}

function normalizeDomainName(value: string, errorCode: string): string {
  const normalized = value.trim().toLowerCase();

  if (normalized.length === 0) {
    throw new Error(errorCode);
  }

  serializeDomainReg(normalized);
  return normalized;
}

export function getCanonicalIdentitySelector(identity: ResolvedWalletIdentity): string {
  return identity.address ?? `spk:${identity.scriptPubKeyHex}`;
}

export function resolveIdentityBySelector(
  context: ReadyWalletMutationContext,
  selector: string,
  errorPrefix: string,
): ResolvedWalletIdentity {
  const walletIdentity = resolveWalletIdentity(context);
  if (walletIdentity.address === null && walletIdentity.scriptPubKeyHex.length === 0) {
    throw new Error(`${errorPrefix}_sender_not_found`);
  }
  const trimmed = selector.trim();

  if (trimmed === "") {
    throw new Error(`${errorPrefix}_sender_selector_missing`);
  }
  void normalizeDomainName;
  return walletIdentity;
}
