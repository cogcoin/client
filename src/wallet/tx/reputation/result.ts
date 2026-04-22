import type { PendingMutationRecord } from "../../types.js";
import type { WalletMutationFeeSummary } from "../common.js";
import type {
  ReputationMutationKind,
  ReputationMutationResult,
  StandaloneReputationOperation,
} from "./types.js";

function mapResultKind(kind: ReputationMutationKind): ReputationMutationResult["kind"] {
  return kind === "rep-give" ? "give" : "revoke";
}

export function createReputationReuseResult(options: {
  kind: ReputationMutationKind;
  operation: StandaloneReputationOperation;
  amountCogtoshi: bigint;
  mutation: PendingMutationRecord;
  resolution: "confirmed" | "live";
  fees: WalletMutationFeeSummary;
}): ReputationMutationResult {
  return {
    kind: mapResultKind(options.kind),
    sourceDomainName: options.operation.normalizedSourceDomainName,
    targetDomainName: options.operation.normalizedTargetDomainName,
    amountCogtoshi: options.amountCogtoshi,
    txid: options.mutation.attemptedTxid ?? "unknown",
    status: options.resolution,
    reusedExisting: true,
    reviewIncluded: options.operation.review.payloadHex !== null,
    resolved: options.operation.resolved,
    fees: options.fees,
  };
}

export function createReputationResult(options: {
  kind: ReputationMutationKind;
  operation: StandaloneReputationOperation;
  amountCogtoshi: bigint;
  mutation: PendingMutationRecord;
  builtTxid: string | null;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  fees: WalletMutationFeeSummary;
}): ReputationMutationResult {
  return {
    kind: mapResultKind(options.kind),
    sourceDomainName: options.operation.normalizedSourceDomainName,
    targetDomainName: options.operation.normalizedTargetDomainName,
    amountCogtoshi: options.amountCogtoshi,
    txid: options.mutation.attemptedTxid ?? options.builtTxid ?? "unknown",
    status: options.status,
    reusedExisting: options.reusedExisting,
    reviewIncluded: options.operation.review.payloadHex !== null,
    resolved: options.operation.resolved,
    fees: options.fees,
  };
}
