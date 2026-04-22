import { createHash } from "node:crypto";

import { encodeSentence } from "@cogcoin/scoring";
import {
  getBalance,
  lookupDomain,
} from "@cogcoin/indexer/queries";

import {
  serializeRepCommit,
  serializeRepRevoke,
  validateDomainName,
} from "../../cogop/index.js";
import {
  assertWalletMutationContextReady,
  createFundingMutationSender,
  type MutationSender,
} from "../common.js";
import type {
  ReadyWalletReadContext,
  ReputationMutationKind,
  ReputationOperation,
  ReputationResolvedEffect,
  ReputationResolvedReviewSummary,
  ReputationResolvedSenderSummary,
  ReputationResolvedSummary,
  ReputationReview,
  StandaloneReputationOperation,
} from "./types.js";

function createSupportKey(sourceDomainId: number, targetDomainId: number): string {
  return `${sourceDomainId}:${targetDomainId}`;
}

export function normalizeReputationDomainName(domainName: string, errorCode: string): string {
  const normalized = domainName.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error(errorCode);
  }
  validateDomainName(normalized);
  return normalized;
}

export function createReputationIntentFingerprint(parts: Array<string | number | bigint>): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part)).join("\n"))
    .digest("hex");
}

export function createResolvedReputationSenderSummary(
  sender: MutationSender,
  selector: string,
): ReputationResolvedSenderSummary {
  return {
    selector,
    localIndex: sender.localIndex,
    scriptPubKeyHex: sender.scriptPubKeyHex,
    address: sender.address,
  };
}

export function createResolvedReputationSummary(options: {
  kind: "give" | "revoke";
  sender: MutationSender;
  senderSelector: string;
  amountCogtoshi: bigint;
  review: ReputationReview;
  selfStake: boolean;
}): ReputationResolvedSummary {
  return {
    sender: createResolvedReputationSenderSummary(options.sender, options.senderSelector),
    effect: options.kind === "give"
      ? {
        kind: "give-support",
        burnCogtoshi: options.amountCogtoshi.toString(),
      }
      : {
        kind: "revoke-support",
        burnCogtoshi: options.amountCogtoshi.toString(),
      },
    review: {
      included: options.review.payloadHex !== null,
      byteLength: options.review.payload?.length ?? null,
    },
    selfStake: options.selfStake,
  };
}

export function describeReputationEffect(effect: ReputationResolvedEffect): string {
  if (effect.kind === "give-support") {
    return `burn ${effect.burnCogtoshi} cogtoshi to publish support`;
  }

  return `revoke visible support with no refund of the previously burned ${effect.burnCogtoshi} cogtoshi`;
}

export function describeReputationReview(review: ReputationResolvedReviewSummary): string {
  if (!review.included || review.byteLength === null) {
    return "none";
  }

  return `included (${review.byteLength} bytes)`;
}

export function resolveReputationOperation(
  context: ReadyWalletReadContext,
  sourceDomainName: string,
  targetDomainName: string,
  errorPrefix: string,
): ReputationOperation {
  assertWalletMutationContextReady(context, errorPrefix);

  const sourceDomain = lookupDomain(context.snapshot.state, sourceDomainName);
  if (sourceDomain === null) {
    throw new Error(`${errorPrefix}_source_domain_not_found`);
  }
  if (!sourceDomain.anchored) {
    throw new Error(`${errorPrefix}_source_domain_not_anchored`);
  }

  const targetDomain = lookupDomain(context.snapshot.state, targetDomainName);
  if (targetDomain === null) {
    throw new Error(`${errorPrefix}_target_domain_not_found`);
  }
  if (!targetDomain.anchored) {
    throw new Error(`${errorPrefix}_target_domain_not_anchored`);
  }

  const ownerHex = Buffer.from(sourceDomain.ownerScriptPubKey).toString("hex");
  if (ownerHex !== context.localState.state.funding.scriptPubKeyHex || context.model.walletAddress == null) {
    throw new Error(`${errorPrefix}_source_owner_not_locally_controlled`);
  }

  return {
    readContext: context,
    state: context.localState.state,
    sender: createFundingMutationSender(context.localState.state),
    senderSelector: context.model.walletAddress,
    sourceDomain,
    targetDomain,
    availableBalanceCogtoshi: getBalance(context.snapshot.state, sourceDomain.ownerScriptPubKey),
    currentNetSupportCogtoshi: context.snapshot.state.consensus.supportByPair.get(
      createSupportKey(sourceDomain.domainId, targetDomain.domainId),
    ) ?? 0n,
  };
}

export async function encodeReputationReviewText(
  reviewText: string | null | undefined,
  errorPrefix: string,
): Promise<ReputationReview> {
  const trimmed = reviewText?.trim() ?? "";

  if (trimmed === "") {
    return {
      text: null,
      payload: undefined,
      payloadHex: null,
    };
  }

  return encodeSentence(trimmed)
    .then((payload) => ({
      text: trimmed,
      payload,
      payloadHex: Buffer.from(payload).toString("hex"),
    }))
    .catch((error) => {
      throw new Error(error instanceof Error ? `${errorPrefix}_invalid_review_${error.message}` : `${errorPrefix}_invalid_review`);
    });
}

export async function resolveStandaloneReputationOperation(options: {
  readContext: ReadyWalletReadContext;
  sourceDomainName: string;
  targetDomainName: string;
  amountCogtoshi: bigint;
  reviewText: string | null | undefined;
  kind: ReputationMutationKind;
  errorPrefix: string;
}): Promise<StandaloneReputationOperation> {
  const normalizedSourceDomainName = normalizeReputationDomainName(
    options.sourceDomainName,
    `${options.errorPrefix}_missing_source_domain`,
  );
  const normalizedTargetDomainName = normalizeReputationDomainName(
    options.targetDomainName,
    `${options.errorPrefix}_missing_target_domain`,
  );
  const operation = resolveReputationOperation(
    options.readContext,
    normalizedSourceDomainName,
    normalizedTargetDomainName,
    options.errorPrefix,
  );

  if (operation.availableBalanceCogtoshi < options.amountCogtoshi) {
    throw new Error(`${options.errorPrefix}_insufficient_cog_balance`);
  }

  if (options.kind === "rep-revoke") {
    if (operation.sourceDomain.domainId === operation.targetDomain.domainId) {
      throw new Error(`${options.errorPrefix}_self_revoke_not_allowed`);
    }
    if (options.amountCogtoshi > operation.currentNetSupportCogtoshi) {
      throw new Error(`${options.errorPrefix}_amount_exceeds_net_support`);
    }
  }

  const review = await encodeReputationReviewText(options.reviewText, options.errorPrefix);
  const selfStake = operation.sourceDomain.domainId === operation.targetDomain.domainId;

  return {
    ...operation,
    normalizedSourceDomainName,
    normalizedTargetDomainName,
    review,
    resolved: createResolvedReputationSummary({
      kind: options.kind === "rep-give" ? "give" : "revoke",
      sender: operation.sender,
      senderSelector: operation.senderSelector,
      amountCogtoshi: options.amountCogtoshi,
      review,
      selfStake,
    }),
  };
}

export function createStandaloneReputationFingerprint(options: {
  kind: ReputationMutationKind;
  operation: StandaloneReputationOperation;
  amountCogtoshi: bigint;
}): string {
  return createReputationIntentFingerprint([
    options.kind,
    options.operation.state.walletRootId,
    options.operation.sourceDomain.name,
    options.operation.targetDomain.name,
    options.amountCogtoshi,
    options.operation.review.payloadHex ?? "",
  ]);
}

export function createReputationOpReturnData(options: {
  kind: ReputationMutationKind;
  operation: StandaloneReputationOperation;
  amountCogtoshi: bigint;
}): Uint8Array {
  return options.kind === "rep-give"
    ? serializeRepCommit(
      options.operation.sourceDomain.domainId,
      options.operation.targetDomain.domainId,
      options.amountCogtoshi,
      options.operation.review.payload,
    ).opReturnData
    : serializeRepRevoke(
      options.operation.sourceDomain.domainId,
      options.operation.targetDomain.domainId,
      options.amountCogtoshi,
      options.operation.review.payload,
    ).opReturnData;
}
