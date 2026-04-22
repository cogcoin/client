import { randomBytes } from "node:crypto";

import { lookupDomain } from "@cogcoin/indexer/queries";

import type { WalletRuntimePaths } from "../../runtime.js";
import type { WalletSecretProvider } from "../../state/provider.js";
import type {
  PendingMutationRecord,
  WalletStateV1,
} from "../../types.js";
import type { WalletReadContext } from "../../read/index.js";
import {
  createWalletMutationFeeMetadata,
  unlockTemporaryBuilderLocks,
  updateMutationRecord,
} from "../common.js";
import {
  persistWalletMutationState,
} from "../executor.js";
import { upsertPendingMutation } from "../journal.js";
import type {
  ReputationDraftMutationOptions,
  ReputationRpcClient,
} from "./types.js";

export function createReputationDraftMutation(
  options: ReputationDraftMutationOptions,
): PendingMutationRecord {
  if (options.existing !== null && options.existing !== undefined) {
    return {
      ...options.existing,
      kind: options.kind,
      domainName: options.sourceDomainName,
      senderScriptPubKeyHex: options.sender.scriptPubKeyHex,
      senderLocalIndex: options.sender.localIndex,
      recipientDomainName: options.targetDomainName,
      amountCogtoshi: options.amountCogtoshi,
      reviewPayloadHex: options.reviewPayloadHex,
      status: "draft",
      lastUpdatedAtUnixMs: options.nowUnixMs,
      attemptedTxid: null,
      attemptedWtxid: null,
      ...createWalletMutationFeeMetadata(options.feeSelection),
      temporaryBuilderLockedOutpoints: [],
    };
  }

  return {
    mutationId: randomBytes(12).toString("hex"),
    kind: options.kind,
    domainName: options.sourceDomainName,
    parentDomainName: null,
    senderScriptPubKeyHex: options.sender.scriptPubKeyHex,
    senderLocalIndex: options.sender.localIndex,
    amountCogtoshi: options.amountCogtoshi,
    recipientDomainName: options.targetDomainName,
    reviewPayloadHex: options.reviewPayloadHex,
    intentFingerprintHex: options.intentFingerprintHex,
    status: "draft",
    createdAtUnixMs: options.nowUnixMs,
    lastUpdatedAtUnixMs: options.nowUnixMs,
    attemptedTxid: null,
    attemptedWtxid: null,
    ...createWalletMutationFeeMetadata(options.feeSelection),
    temporaryBuilderLockedOutpoints: [],
  };
}

function mutationNeedsRepair(
  mutation: PendingMutationRecord,
  context: WalletReadContext,
): boolean {
  if (context.snapshot === null || mutation.recipientDomainName == null) {
    return false;
  }

  const sourceDomain = lookupDomain(context.snapshot.state, mutation.domainName);
  const targetDomain = lookupDomain(context.snapshot.state, mutation.recipientDomainName);

  if (sourceDomain === null || targetDomain === null) {
    return true;
  }

  return !sourceDomain.anchored
    || !targetDomain.anchored
    || Buffer.from(sourceDomain.ownerScriptPubKey).toString("hex") !== mutation.senderScriptPubKeyHex;
}

export async function reconcilePendingReputationMutation(options: {
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  provider: WalletSecretProvider;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
  rpc: ReputationRpcClient;
  walletName: string;
  context: WalletReadContext;
}): Promise<{
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  resolution: "confirmed" | "live" | "repair-required" | "not-seen" | "continue";
}> {
  if (options.mutation.status === "confirmed" || options.mutation.status === "live") {
    return {
      state: options.state,
      mutation: options.mutation,
      resolution: options.mutation.status,
    };
  }

  if (options.mutation.status === "repair-required") {
    return {
      state: options.state,
      mutation: options.mutation,
      resolution: "repair-required",
    };
  }

  const walletTx = options.mutation.attemptedTxid === null
    ? null
    : await options.rpc.getTransaction(options.walletName, options.mutation.attemptedTxid).catch(() => null);

  if (walletTx !== null) {
    await unlockTemporaryBuilderLocks(
      options.rpc,
      options.walletName,
      options.mutation.temporaryBuilderLockedOutpoints,
    );
    const status = walletTx.confirmations > 0 ? "confirmed" : "live";
    const nextMutation = updateMutationRecord(options.mutation, status, options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    let nextState = upsertPendingMutation(options.state, nextMutation);
    nextState = await persistWalletMutationState({
      state: nextState,
      provider: options.provider,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });
    return {
      state: nextState,
      mutation: nextMutation,
      resolution: status,
    };
  }

  if (mutationNeedsRepair(options.mutation, options.context)) {
    await unlockTemporaryBuilderLocks(
      options.rpc,
      options.walletName,
      options.mutation.temporaryBuilderLockedOutpoints,
    );
    const repair = updateMutationRecord(options.mutation, "repair-required", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    let nextState = upsertPendingMutation(options.state, repair);
    nextState = await persistWalletMutationState({
      state: nextState,
      provider: options.provider,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });
    return { state: nextState, mutation: repair, resolution: "repair-required" };
  }

  if (
    options.mutation.status === "broadcast-unknown"
    || options.mutation.status === "draft"
    || options.mutation.status === "broadcasting"
  ) {
    await unlockTemporaryBuilderLocks(
      options.rpc,
      options.walletName,
      options.mutation.temporaryBuilderLockedOutpoints,
    );
    const canceled = updateMutationRecord(options.mutation, "canceled", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    let nextState = upsertPendingMutation(options.state, canceled);
    nextState = await persistWalletMutationState({
      state: nextState,
      provider: options.provider,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });
    return { state: nextState, mutation: canceled, resolution: "not-seen" };
  }

  return {
    state: options.state,
    mutation: options.mutation,
    resolution: "continue",
  };
}
