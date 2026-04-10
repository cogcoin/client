import { lookupDomain } from "@cogcoin/indexer/queries";

import type {
  WalletDomainView,
  WalletReadContext,
} from "./types.js";

export interface WalletDomainFilterOptions {
  anchoredOnly: boolean;
  listedOnly: boolean;
  mineableOnly: boolean;
}

export function isRootDomainName(name: string): boolean {
  return !name.includes("-");
}

export function isMineableWalletDomain(
  context: WalletReadContext,
  domain: WalletDomainView,
): boolean {
  const state = context.localState.state;
  const model = context.model;
  const snapshot = context.snapshot;

  if (state === null || model === null || snapshot === null) {
    return false;
  }

  if (!isRootDomainName(domain.name) || domain.anchored !== true || domain.readOnly || domain.ownerLocalIndex === null || domain.domainId === null) {
    return false;
  }

  const localRecord = state.domains.find((entry) => entry.name === domain.name);
  const ownerIdentity = model.identities.find((identity) => identity.index === domain.ownerLocalIndex);

  if (
    localRecord?.currentCanonicalAnchorOutpoint === null
    || localRecord?.currentCanonicalAnchorOutpoint === undefined
    || ownerIdentity?.address == null
    || ownerIdentity.readOnly
  ) {
    return false;
  }

  const chainDomain = lookupDomain(snapshot.state, domain.name);
  return chainDomain !== null && chainDomain.anchored;
}

export function filterWalletDomains(
  context: WalletReadContext,
  options: WalletDomainFilterOptions,
): WalletDomainView[] | null {
  if (context.model === null) {
    return null;
  }

  return context.model.domains.filter((domain) => {
    if (options.anchoredOnly && domain.anchored !== true) {
      return false;
    }

    if (options.listedOnly && domain.listingPriceCogtoshi === null) {
      return false;
    }

    if (options.mineableOnly && !isMineableWalletDomain(context, domain)) {
      return false;
    }

    return true;
  });
}
