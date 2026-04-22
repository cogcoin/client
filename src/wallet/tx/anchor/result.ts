import type { PendingMutationRecord } from "../../types.js";
import type { WalletMutationFeeSummary } from "../common.js";
import type { AnchorMutationOperation } from "./intent.js";

export interface AnchorDomainResult {
  domainName: string;
  txid: string;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  foundingMessageText?: string | null;
  fees: WalletMutationFeeSummary;
}

export function createAnchorReuseResult(options: {
  operation: AnchorMutationOperation;
  mutation: PendingMutationRecord;
  resolution: "confirmed" | "live";
  fees: WalletMutationFeeSummary;
}): AnchorDomainResult {
  return {
    domainName: options.operation.normalizedDomainName,
    txid: options.mutation.attemptedTxid ?? "unknown",
    status: options.resolution,
    reusedExisting: true,
    foundingMessageText: options.operation.message.text,
    fees: options.fees,
  };
}

export function createAnchorResult(options: {
  operation: AnchorMutationOperation;
  mutation: PendingMutationRecord;
  builtTxid: string | null;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  fees: WalletMutationFeeSummary;
}): AnchorDomainResult {
  return {
    domainName: options.operation.normalizedDomainName,
    txid: options.mutation.attemptedTxid ?? options.builtTxid ?? "unknown",
    status: options.status,
    reusedExisting: options.reusedExisting,
    foundingMessageText: options.operation.message.text,
    fees: options.fees,
  };
}
