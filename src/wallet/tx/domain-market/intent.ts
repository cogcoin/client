import { createHash } from "node:crypto";

import {
  getBalance,
  getListing,
  lookupDomain,
} from "@cogcoin/indexer/queries";

import { validateDomainName } from "../../cogop/index.js";
import {
  assertWalletMutationContextReady,
  createFundingMutationSender,
} from "../common.js";
import {
  getCanonicalIdentitySelector,
} from "../identity-selector.js";
import { normalizeBtcTarget } from "../targets.js";
import type {
  BuyOperationContext,
  DomainMarketResolvedBuyerSummary,
  DomainMarketResolvedEconomicEffect,
  DomainMarketResolvedRecipientSummary,
  DomainMarketResolvedSellerSummary,
  DomainMarketResolvedSenderSummary,
  DomainOperationContext,
} from "./types.js";

export function normalizeDomainMarketDomainName(domainName: string): string {
  const normalized = domainName.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("wallet_domain_missing_domain");
  }
  validateDomainName(normalized);
  return normalized;
}

export function parseCogAmountToCogtoshi(raw: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{0,8}))?$/.exec(raw.trim());

  if (match == null) {
    throw new Error(`wallet_sell_invalid_amount_${raw}`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  const fraction = BigInt((match[3] ?? "").padEnd(8, "0"));
  return sign * ((whole * 100_000_000n) + fraction);
}

export function createDomainMarketIntentFingerprint(parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\n"))
    .digest("hex");
}

export function createResolvedDomainMarketSenderSummary(
  sender: MutationSender,
  selector: string,
): DomainMarketResolvedSenderSummary {
  return {
    selector,
    localIndex: sender.localIndex,
    scriptPubKeyHex: sender.scriptPubKeyHex,
    address: sender.address,
  };
}

export function createResolvedDomainMarketRecipientSummary(
  recipient: ReturnType<typeof normalizeBtcTarget>,
): DomainMarketResolvedRecipientSummary {
  return {
    scriptPubKeyHex: recipient.scriptPubKeyHex,
    address: recipient.address,
    opaque: recipient.opaque,
  };
}

export function createTransferEconomicEffectSummary(
  clearsListing: boolean,
): DomainMarketResolvedEconomicEffect {
  return {
    kind: "ownership-transfer",
    clearsListing,
  };
}

export function createSellEconomicEffectSummary(
  listedPriceCogtoshi: bigint,
): DomainMarketResolvedEconomicEffect {
  if (listedPriceCogtoshi === 0n) {
    return {
      kind: "listing-clear",
      listedPriceCogtoshi: "0",
    };
  }

  return {
    kind: "listing-set",
    listedPriceCogtoshi: listedPriceCogtoshi.toString(),
  };
}

export function resolveOwnedDomainOperation(
  context: WalletReadContext,
  domainName: string,
  errorPrefix: string,
): DomainOperationContext {
  assertWalletMutationContextReady(context, errorPrefix);
  const chainDomain = lookupDomain(context.snapshot.state, domainName);

  if (chainDomain === null) {
    throw new Error(`${errorPrefix}_domain_not_found`);
  }

  if (chainDomain.anchored) {
    throw new Error(`${errorPrefix}_domain_anchored`);
  }

  const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  if (ownerHex !== context.localState.state.funding.scriptPubKeyHex || context.model.walletAddress == null) {
    throw new Error(`${errorPrefix}_owner_not_locally_controlled`);
  }

  return {
    readContext: context,
    state: context.localState.state,
    sender: createFundingMutationSender(context.localState.state),
    senderSelector: context.model.walletAddress,
    chainDomain,
  };
}

export function resolveBuyOperation(
  context: WalletReadContext,
  domainName: string,
  fromIdentity: string | null = null,
): BuyOperationContext {
  void fromIdentity;
  assertWalletMutationContextReady(context, "wallet_buy");
  const chainDomain = lookupDomain(context.snapshot.state, domainName);

  if (chainDomain === null) {
    throw new Error("wallet_buy_domain_not_found");
  }

  if (chainDomain.anchored) {
    throw new Error("wallet_buy_domain_anchored");
  }

  const listing = getListing(context.snapshot!.state, chainDomain.domainId);
  if (listing === null) {
    throw new Error("wallet_buy_domain_not_listed");
  }

  if (context.model.walletAddress === null) {
    throw new Error("wallet_buy_funding_identity_unavailable");
  }

  const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  if (ownerHex === context.localState.state.funding.scriptPubKeyHex) {
    throw new Error("wallet_buy_already_owner");
  }

  if (getBalance(context.snapshot.state, context.localState.state.funding.scriptPubKeyHex) < listing.priceCogtoshi) {
    throw new Error("wallet_buy_insufficient_cog_balance");
  }

  return {
    readContext: context,
    state: context.localState.state,
    sender: createFundingMutationSender(context.localState.state),
    senderSelector: context.model.walletAddress,
    chainDomain,
    listingPriceCogtoshi: listing.priceCogtoshi,
    buyerSelector: context.model.walletAddress,
  };
}

export function createResolvedBuyerSummary(
  selector: string,
  sender: MutationSender,
): DomainMarketResolvedBuyerSummary {
  return {
    selector,
    localIndex: sender.localIndex,
    scriptPubKeyHex: sender.scriptPubKeyHex,
    address: sender.address,
  };
}

export function createResolvedSellerSummary(
  scriptPubKeyHex: string,
  address: string | null,
): DomainMarketResolvedSellerSummary {
  return {
    scriptPubKeyHex,
    address,
  };
}

import type { WalletReadContext } from "../../read/index.js";
import type { MutationSender } from "../common.js";
