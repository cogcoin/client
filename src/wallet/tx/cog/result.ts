import type { PendingMutationRecord } from "../../types.js";
import type { WalletMutationFeeSummary } from "../common.js";
import type {
  CogMutationResult,
  CogResolvedSummary,
} from "./types.js";

export function createCogReuseResult(options: {
  kind: CogMutationResult["kind"];
  mutation: PendingMutationRecord;
  resolution: "confirmed" | "live";
  fees: WalletMutationFeeSummary;
  amountCogtoshi?: bigint;
  recipientScriptPubKeyHex?: string | null;
  recipientDomainName?: string | null;
  lockId?: number | null;
  resolved: CogResolvedSummary;
}): CogMutationResult {
  return {
    kind: options.kind,
    txid: options.mutation.attemptedTxid ?? "unknown",
    status: options.resolution,
    reusedExisting: true,
    amountCogtoshi: options.amountCogtoshi,
    recipientScriptPubKeyHex: options.recipientScriptPubKeyHex,
    recipientDomainName: options.recipientDomainName,
    lockId: options.lockId,
    resolved: options.resolved,
    fees: options.fees,
  };
}

export function createCogResult(options: {
  kind: CogMutationResult["kind"];
  mutation: PendingMutationRecord;
  builtTxid: string | null;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  fees: WalletMutationFeeSummary;
  amountCogtoshi?: bigint;
  recipientScriptPubKeyHex?: string | null;
  recipientDomainName?: string | null;
  lockId?: number | null;
  resolved: CogResolvedSummary;
}): CogMutationResult {
  return {
    kind: options.kind,
    txid: options.mutation.attemptedTxid ?? options.builtTxid ?? "unknown",
    status: options.status,
    reusedExisting: options.reusedExisting,
    amountCogtoshi: options.amountCogtoshi,
    recipientScriptPubKeyHex: options.recipientScriptPubKeyHex,
    recipientDomainName: options.recipientDomainName,
    lockId: options.lockId,
    resolved: options.resolved,
    fees: options.fees,
  };
}
