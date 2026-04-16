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
  const snapshot = context.snapshot;

  if (state === null || context.model === null || snapshot === null) {
    return false;
  }

  if (!isRootDomainName(domain.name) || domain.anchored !== true || domain.readOnly || domain.localRelationship !== "local" || domain.domainId === null) {
    return false;
  }

  const localRecord = state.domains.find((entry) => entry.name === domain.name);
  if (localRecord?.currentCanonicalAnchorOutpoint == null) {
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
