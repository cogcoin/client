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

function bytesToHex(value: Uint8Array | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return Buffer.from(value).toString("hex");
}

function scriptMatches(value: Uint8Array | null | undefined, scriptPubKeyHex: string): boolean {
  return bytesToHex(value) === scriptPubKeyHex;
}

export interface MineableWalletDomainResolution {
  domainId: number;
  domainName: string;
  sender: {
    localIndex: number;
    scriptPubKeyHex: string;
    address: string;
  };
}

export function resolveMineableWalletDomain(
  context: WalletReadContext,
  domain: WalletDomainView,
): MineableWalletDomainResolution | null {
  const state = context.localState.state;
  const model = context.model;
  const snapshot = context.snapshot;

  if (state === null || model === null || snapshot === null || model.walletAddress == null) {
    return null;
  }

  if (!isRootDomainName(domain.name) || domain.anchored !== true || domain.readOnly || domain.domainId === null) {
    return null;
  }

  const chainDomain = lookupDomain(snapshot.state, domain.name);
  if (chainDomain === null || !chainDomain.anchored || chainDomain.domainId !== domain.domainId) {
    return null;
  }

  const walletScriptPubKeyHex = model.walletScriptPubKeyHex;
  const authorized = scriptMatches(chainDomain.ownerScriptPubKey, walletScriptPubKeyHex)
    || scriptMatches(chainDomain.delegate, walletScriptPubKeyHex)
    || scriptMatches(chainDomain.miner, walletScriptPubKeyHex);

  return authorized
    ? {
      domainId: chainDomain.domainId,
      domainName: chainDomain.name,
      sender: {
        localIndex: 0,
        scriptPubKeyHex: walletScriptPubKeyHex,
        address: model.walletAddress,
      },
    }
    : null;
}

export function isMineableWalletDomain(
  context: WalletReadContext,
  domain: WalletDomainView,
): boolean {
  return resolveMineableWalletDomain(context, domain) !== null;
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
