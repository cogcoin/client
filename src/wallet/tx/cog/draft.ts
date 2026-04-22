import { randomBytes } from "node:crypto";

import { getLock } from "@cogcoin/indexer/queries";

import type { WalletRuntimePaths } from "../../runtime.js";
import type { WalletSecretProvider } from "../../state/provider.js";
import type {
  PendingMutationRecord,
  WalletStateV1,
} from "../../types.js";
import type { WalletReadContext } from "../../read/index.js";
import {
  createWalletMutationFeeMetadata,
  saveWalletStatePreservingUnlock,
  unlockTemporaryBuilderLocks,
  updateMutationRecord,
} from "../common.js";
import { upsertPendingMutation } from "../journal.js";
import type {
  CogDraftMutationOptions,
  WalletCogRpcClient,
} from "./types.js";
import { ZERO_PREIMAGE_HEX } from "./types.js";

export function createCogDraftMutation(
  options: CogDraftMutationOptions,
): PendingMutationRecord {
  if (options.existing !== null && options.existing !== undefined) {
    return {
      ...options.existing,
      kind: options.kind,
      domainName: options.domainName ?? "",
      senderScriptPubKeyHex: options.sender.scriptPubKeyHex,
      senderLocalIndex: options.sender.localIndex,
      recipientScriptPubKeyHex: options.recipientScriptPubKeyHex ?? null,
      recipientDomainName: options.recipientDomainName ?? null,
      amountCogtoshi: options.amountCogtoshi ?? null,
      timeoutHeight: options.timeoutHeight ?? null,
      conditionHex: options.conditionHex ?? null,
      lockId: options.lockId ?? null,
      preimageHex: options.preimageHex ?? null,
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
    domainName: options.domainName ?? "",
    parentDomainName: null,
    senderScriptPubKeyHex: options.sender.scriptPubKeyHex,
    senderLocalIndex: options.sender.localIndex,
    recipientScriptPubKeyHex: options.recipientScriptPubKeyHex ?? null,
    recipientDomainName: options.recipientDomainName ?? null,
    amountCogtoshi: options.amountCogtoshi ?? null,
    timeoutHeight: options.timeoutHeight ?? null,
    conditionHex: options.conditionHex ?? null,
    lockId: options.lockId ?? null,
    preimageHex: options.preimageHex ?? null,
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

export async function reconcilePendingCogMutation(options: {
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  provider: WalletSecretProvider;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
  rpc: WalletCogRpcClient;
  walletName: string;
  context: WalletReadContext;
}): Promise<{
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  resolution: "confirmed" | "live" | "repair-required" | "continue";
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

  if (options.mutation.kind === "claim" && options.context.snapshot !== null && options.mutation.lockId != null) {
    const lock = getLock(options.context.snapshot.state, options.mutation.lockId);
    const expectedStatus = options.mutation.preimageHex === ZERO_PREIMAGE_HEX ? "reclaimed" : "claimed";
    if (
      lock !== null
      && lock.status === expectedStatus
      && Buffer.from(lock.resolverScriptPubKey ?? new Uint8Array()).toString("hex") === options.mutation.senderScriptPubKeyHex
    ) {
      await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
      const confirmed = updateMutationRecord(options.mutation, "confirmed", options.nowUnixMs, {
        temporaryBuilderLockedOutpoints: [],
      });
      const nextState = {
        ...upsertPendingMutation(options.state, confirmed),
        stateRevision: options.state.stateRevision + 1,
        lastWrittenAtUnixMs: options.nowUnixMs,
      };
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider: options.provider,
        nowUnixMs: options.nowUnixMs,
        paths: options.paths,
      });
      return { state: nextState, mutation: confirmed, resolution: "confirmed" };
    }
  }

  const known = options.mutation.attemptedTxid === null
    ? false
    : await options.rpc.getRawTransaction(options.mutation.attemptedTxid, true).then(() => true).catch(() => false);
  if (known) {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
    const live = updateMutationRecord(options.mutation, "live", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    const nextState = {
      ...upsertPendingMutation(options.state, live),
      stateRevision: options.state.stateRevision + 1,
      lastWrittenAtUnixMs: options.nowUnixMs,
    };
    await saveWalletStatePreservingUnlock({
      state: nextState,
      provider: options.provider,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });
    return { state: nextState, mutation: live, resolution: "live" };
  }

  return { state: options.state, mutation: options.mutation, resolution: "continue" };
}
