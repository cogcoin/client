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
  return identity.selectors.find((selector) => selector.startsWith("id:")) ?? `id:${identity.index}`;
}

export function resolveIdentityBySelector(
  context: ReadyWalletMutationContext,
  selector: string,
  errorPrefix: string,
): ResolvedIdentity {
  const trimmed = selector.trim();

  if (trimmed === "") {
    throw new Error(`${errorPrefix}_sender_selector_missing`);
  }

  if (trimmed.startsWith("id:")) {
    const index = Number.parseInt(trimmed.slice(3), 10);
    const identity = context.model.identities.find((entry) => entry.index === index) ?? null;

    if (identity === null) {
      throw new Error(`${errorPrefix}_sender_not_found`);
    }

    return identity;
  }

  if (trimmed.startsWith("domain:")) {
    const domainName = normalizeDomainName(trimmed.slice(7), `${errorPrefix}_sender_selector_invalid_domain`);
    const domain = context.model.domains.find((entry) => entry.name === domainName) ?? null;

    if (domain === null || domain.ownerLocalIndex === null) {
      throw new Error(`${errorPrefix}_sender_not_found`);
    }

    const identity = context.model.identities.find((entry) => entry.index === domain.ownerLocalIndex) ?? null;

    if (identity === null) {
      throw new Error(`${errorPrefix}_sender_not_found`);
    }

    return identity;
  }

  if (trimmed.startsWith("spk:")) {
    const scriptPubKeyHex = trimmed.slice(4).toLowerCase();
    const identity = context.model.identities.find((entry) => entry.scriptPubKeyHex === scriptPubKeyHex) ?? null;

    if (identity === null) {
      throw new Error(`${errorPrefix}_sender_not_found`);
    }

    return identity;
  }

  const normalizedAddress = trimmed.toLowerCase();
  const identity = context.model.identities.find((entry) => entry.address?.toLowerCase() === normalizedAddress) ?? null;

  if (identity === null) {
    throw new Error(`${errorPrefix}_sender_not_found`);
  }

  return identity;
}
