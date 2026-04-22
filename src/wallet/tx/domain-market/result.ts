import type { PendingMutationRecord } from "../../types.js";
import type { WalletMutationFeeSummary } from "../common.js";
import type {
  BuyDomainMutationOperation,
  DomainMarketMutationResult,
  SellDomainMutationOperation,
  TransferDomainMutationOperation,
} from "./types.js";

export function createTransferReuseResult(options: {
  operation: TransferDomainMutationOperation;
  mutation: PendingMutationRecord;
  resolution: "confirmed" | "live";
  fees: WalletMutationFeeSummary;
}): DomainMarketMutationResult {
  return {
    kind: "transfer",
    domainName: options.operation.normalizedDomainName,
    txid: options.mutation.attemptedTxid ?? "unknown",
    status: options.resolution,
    reusedExisting: true,
    recipientScriptPubKeyHex: options.operation.recipient.scriptPubKeyHex,
    resolved: {
      sender: options.operation.resolvedSender,
      recipient: options.operation.resolvedRecipient,
      economicEffect: options.operation.resolvedEconomicEffect,
    },
    fees: options.fees,
  };
}

export function createTransferResult(options: {
  operation: TransferDomainMutationOperation;
  mutation: PendingMutationRecord;
  builtTxid: string | null;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  fees: WalletMutationFeeSummary;
}): DomainMarketMutationResult {
  return {
    kind: "transfer",
    domainName: options.operation.normalizedDomainName,
    txid: options.mutation.attemptedTxid ?? options.builtTxid ?? "unknown",
    status: options.status,
    reusedExisting: options.reusedExisting,
    recipientScriptPubKeyHex: options.operation.recipient.scriptPubKeyHex,
    resolved: {
      sender: options.operation.resolvedSender,
      recipient: options.operation.resolvedRecipient,
      economicEffect: options.operation.resolvedEconomicEffect,
    },
    fees: options.fees,
  };
}

export function createSellReuseResult(options: {
  operation: SellDomainMutationOperation;
  mutation: PendingMutationRecord;
  resolution: "confirmed" | "live";
  fees: WalletMutationFeeSummary;
}): DomainMarketMutationResult {
  return {
    kind: "sell",
    domainName: options.operation.normalizedDomainName,
    txid: options.mutation.attemptedTxid ?? "unknown",
    status: options.resolution,
    reusedExisting: true,
    listedPriceCogtoshi: options.operation.listedPriceCogtoshi,
    resolved: {
      sender: options.operation.resolvedSender,
      economicEffect: options.operation.resolvedEconomicEffect,
    },
    fees: options.fees,
  };
}

export function createSellResult(options: {
  operation: SellDomainMutationOperation;
  mutation: PendingMutationRecord;
  builtTxid: string | null;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  fees: WalletMutationFeeSummary;
}): DomainMarketMutationResult {
  return {
    kind: "sell",
    domainName: options.operation.normalizedDomainName,
    txid: options.mutation.attemptedTxid ?? options.builtTxid ?? "unknown",
    status: options.status,
    reusedExisting: options.reusedExisting,
    listedPriceCogtoshi: options.operation.listedPriceCogtoshi,
    resolved: {
      sender: options.operation.resolvedSender,
      economicEffect: options.operation.resolvedEconomicEffect,
    },
    fees: options.fees,
  };
}

export function createBuyReuseResult(options: {
  operation: BuyDomainMutationOperation;
  mutation: PendingMutationRecord;
  resolution: "confirmed" | "live";
  fees: WalletMutationFeeSummary;
}): DomainMarketMutationResult {
  return {
    kind: "buy",
    domainName: options.operation.normalizedDomainName,
    txid: options.mutation.attemptedTxid ?? "unknown",
    status: options.resolution,
    reusedExisting: true,
    listedPriceCogtoshi: options.operation.listingPriceCogtoshi,
    resolvedBuyer: options.operation.resolvedBuyer,
    resolvedSeller: options.operation.resolvedSeller,
    fees: options.fees,
  };
}

export function createBuyResult(options: {
  operation: BuyDomainMutationOperation;
  mutation: PendingMutationRecord;
  builtTxid: string | null;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  fees: WalletMutationFeeSummary;
}): DomainMarketMutationResult {
  return {
    kind: "buy",
    domainName: options.operation.normalizedDomainName,
    txid: options.mutation.attemptedTxid ?? options.builtTxid ?? "unknown",
    status: options.status,
    reusedExisting: options.reusedExisting,
    listedPriceCogtoshi: options.operation.listingPriceCogtoshi,
    resolvedBuyer: options.operation.resolvedBuyer,
    resolvedSeller: options.operation.resolvedSeller,
    fees: options.fees,
  };
}
