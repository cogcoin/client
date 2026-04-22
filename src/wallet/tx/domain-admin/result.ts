import type { PendingMutationRecord } from "../../types.js";
import type { WalletMutationFeeSummary } from "../common.js";
import type {
  DomainAdminMutationResult,
  DomainAdminVariant,
  StandaloneDomainAdminOperation,
} from "./types.js";

function createResolvedSummary(operation: StandaloneDomainAdminOperation) {
  return {
    sender: operation.resolvedSender,
    target: operation.payload.resolvedTarget,
    effect: operation.payload.resolvedEffect,
  };
}

export function createDomainAdminReuseResult(options: {
  variant: DomainAdminVariant;
  operation: StandaloneDomainAdminOperation;
  mutation: PendingMutationRecord;
  resolution: "confirmed" | "live";
  fees: WalletMutationFeeSummary;
}): DomainAdminMutationResult {
  return {
    kind: options.variant.kind,
    domainName: options.operation.normalizedDomainName,
    txid: options.mutation.attemptedTxid ?? "unknown",
    status: options.resolution,
    reusedExisting: true,
    recipientScriptPubKeyHex: options.operation.payload.recipientScriptPubKeyHex ?? null,
    endpointValueHex: options.operation.payload.endpointValueHex ?? null,
    resolved: createResolvedSummary(options.operation),
    fees: options.fees,
  };
}

export function createDomainAdminResult(options: {
  variant: DomainAdminVariant;
  operation: StandaloneDomainAdminOperation;
  mutation: PendingMutationRecord;
  builtTxid: string | null;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  fees: WalletMutationFeeSummary;
}): DomainAdminMutationResult {
  return {
    kind: options.variant.kind,
    domainName: options.operation.normalizedDomainName,
    txid: options.mutation.attemptedTxid ?? options.builtTxid ?? "unknown",
    status: options.status,
    reusedExisting: options.reusedExisting,
    recipientScriptPubKeyHex: options.operation.payload.recipientScriptPubKeyHex ?? null,
    endpointValueHex: options.operation.payload.endpointValueHex ?? null,
    resolved: createResolvedSummary(options.operation),
    fees: options.fees,
  };
}
