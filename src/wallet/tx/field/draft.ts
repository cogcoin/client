import { randomBytes } from "node:crypto";

import { lookupDomain } from "@cogcoin/indexer/queries";

import type { WalletRuntimePaths } from "../../runtime.js";
import type { WalletSecretProvider } from "../../state/provider.js";
import type {
  PendingMutationRecord,
  WalletStateV1,
} from "../../types.js";
import type { WalletReadContext } from "../../read/index.js";
import { findDomainField } from "../../read/index.js";
import {
  createWalletMutationFeeMetadata,
  unlockTemporaryBuilderLocks,
  updateMutationRecord,
} from "../common.js";
import { persistWalletMutationState } from "../executor.js";
import { upsertPendingMutation } from "../journal.js";
import type {
  FieldDraftMutationOptions,
  FieldRpcClient,
} from "./types.js";

export function createStandaloneFieldMutation(
  options: FieldDraftMutationOptions,
): PendingMutationRecord {
  if (options.existing !== null && options.existing !== undefined) {
    return {
      ...options.existing,
      kind: options.kind,
      domainName: options.domainName,
      senderScriptPubKeyHex: options.sender.scriptPubKeyHex,
      senderLocalIndex: options.sender.localIndex,
      fieldName: options.fieldName,
      fieldId: options.fieldId ?? null,
      fieldPermanent: options.fieldPermanent ?? null,
      fieldFormat: options.fieldFormat ?? null,
      fieldValueHex: options.fieldValueHex ?? null,
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
    fieldName: options.fieldName,
    fieldId: options.fieldId ?? null,
    fieldPermanent: options.fieldPermanent ?? null,
    fieldFormat: options.fieldFormat ?? null,
    fieldValueHex: options.fieldValueHex ?? null,
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

function isActiveMutationStatus(status: PendingMutationRecord["status"]): boolean {
  return status === "draft"
    || status === "broadcasting"
    || status === "broadcast-unknown"
    || status === "live"
    || status === "repair-required";
}

export function findActiveFieldCreateMutationByDomain(
  state: WalletStateV1,
  domainName: string,
  intentFingerprintHex: string,
): PendingMutationRecord | null {
  return (state.pendingMutations ?? []).find((mutation) =>
    mutation.kind === "field-create"
    && mutation.domainName === domainName
    && mutation.intentFingerprintHex !== intentFingerprintHex
    && isActiveMutationStatus(mutation.status)
  ) ?? null;
}

export function getObservedFieldState(
  context: WalletReadContext,
  domainName: string,
  fieldName: string,
): ReturnType<typeof findDomainField> {
  if (context.snapshot === null) {
    return null;
  }

  return findDomainField(context, domainName, fieldName);
}

function standaloneMutationConfirmedOnChain(
  mutation: PendingMutationRecord,
  context: WalletReadContext,
): boolean {
  const observed = mutation.fieldName == null
    ? null
    : getObservedFieldState(context, mutation.domainName, mutation.fieldName);
  const chainDomain = context.snapshot === null ? null : lookupDomain(context.snapshot.state, mutation.domainName);

  if (chainDomain === null || !chainDomain.anchored) {
    return false;
  }

  const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  if (ownerHex !== mutation.senderScriptPubKeyHex) {
    return false;
  }

  if (mutation.kind === "field-create") {
    return observed !== null
      && (mutation.fieldPermanent == null || observed.permanent === mutation.fieldPermanent);
  }

  if (mutation.kind === "field-clear") {
    return observed !== null && !observed.hasValue;
  }

  return observed !== null
    && observed.hasValue
    && observed.format === (mutation.fieldFormat ?? null)
    && observed.rawValueHex === (mutation.fieldValueHex ?? null);
}

function standaloneMutationNeedsRepair(
  mutation: PendingMutationRecord,
  context: WalletReadContext,
): boolean {
  if (context.snapshot === null) {
    return false;
  }

  const chainDomain = lookupDomain(context.snapshot.state, mutation.domainName);
  if (chainDomain === null || !chainDomain.anchored) {
    return true;
  }

  const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  if (ownerHex !== mutation.senderScriptPubKeyHex) {
    return true;
  }

  if (mutation.fieldName == null) {
    return false;
  }

  const observed = getObservedFieldState(context, mutation.domainName, mutation.fieldName);
  if (mutation.kind === "field-create") {
    return observed !== null
      && mutation.fieldPermanent !== null
      && observed.permanent !== mutation.fieldPermanent;
  }

  if (mutation.kind === "field-set") {
    return observed !== null
      && observed.hasValue
      && ((mutation.fieldFormat ?? null) !== observed.format || (mutation.fieldValueHex ?? null) !== observed.rawValueHex);
  }

  return false;
}

export async function reconcilePendingFieldMutation(options: {
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  provider: WalletSecretProvider;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
  rpc: FieldRpcClient;
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

  if (standaloneMutationConfirmedOnChain(options.mutation, options.context)) {
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

  if (standaloneMutationNeedsRepair(options.mutation, options.context)) {
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
