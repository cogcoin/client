import { randomBytes } from "node:crypto";

import {
  lookupDomain,
  resolveCanonical,
} from "@cogcoin/indexer/queries";

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
import { persistWalletMutationState } from "../executor.js";
import { upsertPendingMutation } from "../journal.js";
import type {
  DomainAdminDraftMutationOptions,
  DomainAdminRpcClient,
} from "./types.js";
import { bytesToHex } from "./intent.js";

export function createDomainAdminDraftMutation(
  options: DomainAdminDraftMutationOptions,
): PendingMutationRecord {
  if (options.existing !== null && options.existing !== undefined) {
    return {
      ...options.existing,
      kind: options.kind,
      domainName: options.domainName,
      senderScriptPubKeyHex: options.sender.scriptPubKeyHex,
      senderLocalIndex: options.sender.localIndex,
      recipientScriptPubKeyHex: options.recipientScriptPubKeyHex ?? null,
      endpointValueHex: options.endpointValueHex ?? null,
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
    domainName: options.domainName,
    parentDomainName: null,
    senderScriptPubKeyHex: options.sender.scriptPubKeyHex,
    senderLocalIndex: options.sender.localIndex,
    recipientScriptPubKeyHex: options.recipientScriptPubKeyHex ?? null,
    endpointValueHex: options.endpointValueHex ?? null,
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

function mutationConfirmedOnChain(
  mutation: PendingMutationRecord,
  context: WalletReadContext,
): boolean {
  if (context.snapshot === null) {
    return false;
  }

  const chainDomain = lookupDomain(context.snapshot.state, mutation.domainName);
  if (chainDomain === null || !chainDomain.anchored) {
    return false;
  }

  const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  if (ownerHex !== mutation.senderScriptPubKeyHex) {
    return false;
  }

  if (mutation.kind === "endpoint") {
    return bytesToHex(chainDomain.endpoint) === (mutation.endpointValueHex ?? "");
  }

  if (mutation.kind === "delegate") {
    return bytesToHex(chainDomain.delegate) === (mutation.recipientScriptPubKeyHex ?? "");
  }

  if (mutation.kind === "miner") {
    return bytesToHex(chainDomain.miner) === (mutation.recipientScriptPubKeyHex ?? "");
  }

  if (chainDomain.domainId === null) {
    return false;
  }

  return resolveCanonical(
    context.snapshot.state,
    Buffer.from(mutation.senderScriptPubKeyHex, "hex"),
  ) === chainDomain.domainId;
}

function mutationNeedsRepair(
  mutation: PendingMutationRecord,
  context: WalletReadContext,
): boolean {
  if (context.snapshot === null) {
    return false;
  }

  const chainDomain = lookupDomain(context.snapshot.state, mutation.domainName);
  if (chainDomain === null) {
    return false;
  }

  return !chainDomain.anchored || Buffer.from(chainDomain.ownerScriptPubKey).toString("hex") !== mutation.senderScriptPubKeyHex;
}

export async function reconcilePendingAdminMutation(options: {
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  provider: WalletSecretProvider;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
  rpc: DomainAdminRpcClient;
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

  if (mutationConfirmedOnChain(options.mutation, options.context)) {
    await unlockTemporaryBuilderLocks(
      options.rpc,
      options.walletName,
      options.mutation.temporaryBuilderLockedOutpoints,
    );
    const confirmed = updateMutationRecord(options.mutation, "confirmed", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    let nextState = upsertPendingMutation(options.state, confirmed);
    nextState = await persistWalletMutationState({
      state: nextState,
      provider: options.provider,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });
    return { state: nextState, mutation: confirmed, resolution: "confirmed" };
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

  const known = options.mutation.attemptedTxid === null
    ? false
    : await options.rpc.getRawTransaction(options.mutation.attemptedTxid, true).then(() => true).catch(() => false);
  if (known) {
    await unlockTemporaryBuilderLocks(
      options.rpc,
      options.walletName,
      options.mutation.temporaryBuilderLockedOutpoints,
    );
    const live = updateMutationRecord(options.mutation, "live", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    let nextState = upsertPendingMutation(options.state, live);
    nextState = await persistWalletMutationState({
      state: nextState,
      provider: options.provider,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });
    return { state: nextState, mutation: live, resolution: "live" };
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
