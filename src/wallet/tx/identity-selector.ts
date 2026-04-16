import type { WalletReadContext } from "../read/index.js";
import { serializeDomainReg } from "../cogop/index.js";

type ReadyWalletMutationContext = WalletReadContext & {
  localState: { availability: "ready" };
  snapshot: NonNullable<WalletReadContext["snapshot"]>;
  model: NonNullable<WalletReadContext["model"]>;
};

type ResolvedIdentity = ReadyWalletMutationContext["model"]["identities"][number];

function normalizeDomainName(value: string, errorCode: string): string {
  const normalized = value.trim().toLowerCase();

  if (normalized.length === 0) {
    throw new Error(errorCode);
  }

  serializeDomainReg(normalized);
  return normalized;
}

export function getCanonicalIdentitySelector(identity: ResolvedIdentity): string {
  return identity.address ?? `spk:${identity.scriptPubKeyHex}`;
}

export function resolveIdentityBySelector(
  context: ReadyWalletMutationContext,
  selector: string,
  errorPrefix: string,
): ResolvedIdentity {
  const fundingIdentity = context.model.fundingIdentity ?? context.model.identities[0] ?? null;
  if (fundingIdentity === null) {
    throw new Error(`${errorPrefix}_sender_not_found`);
  }
  const trimmed = selector.trim();

  if (trimmed === "") {
    throw new Error(`${errorPrefix}_sender_selector_missing`);
  }
  void normalizeDomainName;
  return fundingIdentity;
}
