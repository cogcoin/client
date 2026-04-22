import { formatFieldFormat } from "../../wallet/read/index.js";
import type { WalletReadContext } from "../../wallet/read/index.js";
import type { PendingMutationRecord } from "../../wallet/types.js";
import { formatCogAmount } from "./shared.js";

export function isReputationMutation(
  mutation: PendingMutationRecord,
): mutation is PendingMutationRecord & {
  kind: "rep-give" | "rep-revoke";
  recipientDomainName: string;
} {
  return (mutation.kind === "rep-give" || mutation.kind === "rep-revoke")
    && mutation.recipientDomainName !== undefined
    && mutation.recipientDomainName !== null;
}

export function formatPendingMutationKind(
  mutation: PendingMutationRecord,
): string {
  if (mutation.kind === "sell" && mutation.priceCogtoshi === 0n) {
    return "unsell";
  }

  if (mutation.kind === "claim" && mutation.preimageHex === "0000000000000000000000000000000000000000000000000000000000000000") {
    return "reclaim";
  }

  if (mutation.kind === "endpoint" && mutation.endpointValueHex === "") {
    return "endpoint-clear";
  }

  if (mutation.kind === "delegate" && mutation.recipientScriptPubKeyHex === null) {
    return "delegate-clear";
  }

  if (mutation.kind === "miner" && mutation.recipientScriptPubKeyHex === null) {
    return "miner-clear";
  }

  return mutation.kind;
}

export function formatPendingMutationSummaryLabel(
  mutation: PendingMutationRecord,
): string {
  if (isReputationMutation(mutation)) {
    return `${formatPendingMutationKind(mutation)} ${mutation.domainName}->${mutation.recipientDomainName}`;
  }

  return `${formatPendingMutationKind(mutation)}${mutation.domainName === "" ? "" : ` ${mutation.domainName}`}${mutation.fieldName == null ? "" : `.${mutation.fieldName}`}`;
}

export function formatPendingMutationDomainLabel(
  mutation: PendingMutationRecord,
): string {
  if (isReputationMutation(mutation)) {
    return `${formatPendingMutationKind(mutation)} ${mutation.domainName}->${mutation.recipientDomainName}`;
  }

  const kind = mutation.kind === "endpoint" && mutation.endpointValueHex === ""
    ? "endpoint-clear"
    : mutation.kind === "delegate" && mutation.recipientScriptPubKeyHex === null
      ? "delegate-clear"
      : mutation.kind === "miner" && mutation.recipientScriptPubKeyHex === null
        ? "miner-clear"
        : formatPendingMutationKind(mutation);

  return kind;
}

export function appendPendingMutationSummary(
  lines: string[],
  context: WalletReadContext,
): void {
  const pendingMutations = (context.localState.state?.pendingMutations ?? [])
    .filter((mutation) =>
      mutation.status !== "confirmed" && mutation.status !== "canceled"
    );

  if (pendingMutations.length === 0) {
    lines.push("Pending mutations: none");
    return;
  }

  for (const mutation of pendingMutations) {
    lines.push(
      `Pending mutation: ${formatPendingMutationSummaryLabel(mutation)}  ${mutation.status}  sender spk:${mutation.senderScriptPubKeyHex}${mutation.priceCogtoshi === undefined || mutation.priceCogtoshi === null ? "" : `  price ${formatCogAmount(mutation.priceCogtoshi)}`}${mutation.amountCogtoshi === undefined || mutation.amountCogtoshi === null ? "" : `  amount ${formatCogAmount(mutation.amountCogtoshi)}`}${isReputationMutation(mutation) ? "" : mutation.recipientDomainName === undefined || mutation.recipientDomainName === null ? "" : `  domain ${mutation.recipientDomainName}`}${mutation.lockId === undefined || mutation.lockId === null ? "" : `  lock ${mutation.lockId}`}${mutation.recipientScriptPubKeyHex === undefined || mutation.recipientScriptPubKeyHex === null ? "" : `  recipient spk:${mutation.recipientScriptPubKeyHex}`}${mutation.kind === "endpoint" ? (mutation.endpointValueHex === "" ? "  endpoint clear" : `  endpoint-bytes ${(mutation.endpointValueHex?.length ?? 0) / 2}`) : ""}${mutation.kind === "field-create" || mutation.kind === "field-set" ? `  format ${formatFieldFormat(mutation.fieldFormat ?? 0)}` : ""}${mutation.kind === "field-clear" ? "  clear" : ""}${mutation.reviewPayloadHex === undefined || mutation.reviewPayloadHex === null ? "" : "  review"}`,
    );
  }
}

export function listPendingDomainMutations(
  context: WalletReadContext,
  domainName: string,
) {
  return (context.localState.state?.pendingMutations ?? [])
    .filter((mutation) =>
      (mutation.kind === "register"
        || mutation.kind === "transfer"
        || mutation.kind === "sell"
        || mutation.kind === "buy"
        || mutation.kind === "anchor"
        || mutation.kind === "endpoint"
        || mutation.kind === "delegate"
        || mutation.kind === "miner"
        || mutation.kind === "canonical"
        || mutation.kind === "field-create"
        || mutation.kind === "field-set"
        || mutation.kind === "field-clear")
      && mutation.domainName === domainName
      && mutation.status !== "confirmed"
      && mutation.status !== "canceled"
    );
}

export function listPendingDomainShowMutations(
  context: WalletReadContext,
  domainName: string,
) {
  return (context.localState.state?.pendingMutations ?? [])
    .filter((mutation) =>
      (
        mutation.kind === "register"
        || mutation.kind === "transfer"
        || mutation.kind === "sell"
        || mutation.kind === "buy"
        || mutation.kind === "anchor"
        || mutation.kind === "endpoint"
        || mutation.kind === "delegate"
        || mutation.kind === "miner"
        || mutation.kind === "canonical"
        || mutation.kind === "field-create"
        || mutation.kind === "field-set"
        || mutation.kind === "field-clear"
        || mutation.kind === "rep-give"
        || mutation.kind === "rep-revoke"
      )
      && (mutation.domainName === domainName || mutation.recipientDomainName === domainName)
      && mutation.status !== "confirmed"
      && mutation.status !== "canceled"
    );
}

export function listPendingFieldMutations(
  context: WalletReadContext,
  domainName: string,
  fieldName?: string,
) {
  return (context.localState.state?.pendingMutations ?? [])
    .filter((mutation) =>
      (mutation.kind === "field-create" || mutation.kind === "field-set" || mutation.kind === "field-clear")
      && mutation.domainName === domainName
      && (fieldName === undefined || mutation.fieldName === fieldName)
      && mutation.status !== "confirmed"
      && mutation.status !== "canceled"
    );
}
