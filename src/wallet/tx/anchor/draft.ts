import { randomBytes } from "node:crypto";

import { lookupDomain } from "@cogcoin/indexer/queries";

import type { WalletRuntimePaths } from "../../runtime.js";
import type { WalletSecretProvider } from "../../state/provider.js";
import type {
  DomainRecord,
  PendingMutationRecord,
  WalletStateV1,
} from "../../types.js";
import type { WalletReadContext } from "../../read/index.js";
import {
  createWalletMutationFeeMetadata,
  unlockTemporaryBuilderLocks,
  updateMutationRecord,
  type WalletMutationFeeSelection,
} from "../common.js";
import { persistWalletMutationState } from "../executor.js";
import { upsertPendingMutation } from "../journal.js";
import type { AnchorMutationOperation, WalletAnchorRpcClient } from "./intent.js";

export function createDraftAnchorMutation(options: {
  state: WalletStateV1;
  domainName: string;
  intentFingerprintHex: string;
  nowUnixMs: number;
  feeSelection: WalletMutationFeeSelection;
  existing?: PendingMutationRecord | null;
}): PendingMutationRecord {
  const existing = options.existing ?? null;
  if (existing !== null) {
    return {
      ...existing,
      kind: "anchor",
      domainName: options.domainName,
      parentDomainName: null,
      senderScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
      senderLocalIndex: 0,
      intentFingerprintHex: options.intentFingerprintHex,
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
    kind: "anchor",
    domainName: options.domainName,
    parentDomainName: null,
    senderScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    senderLocalIndex: 0,
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

export function upsertAnchoredDomainRecord(options: {
  state: WalletStateV1;
  domainName: string;
  domainId: number;
  foundingMessageText: string | null;
}): WalletStateV1 {
  const domains = options.state.domains.slice();
  const existingIndex = domains.findIndex((entry) => entry.name === options.domainName);
  const current = existingIndex >= 0 ? domains[existingIndex]! : null;
  const nextRecord: DomainRecord = {
    name: options.domainName,
    domainId: options.domainId,
    currentOwnerScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    canonicalChainStatus: "anchored",
    foundingMessageText: options.foundingMessageText ?? current?.foundingMessageText ?? null,
    birthTime: current?.birthTime ?? options.state.lastWrittenAtUnixMs,
  };

  if (existingIndex >= 0) {
    domains[existingIndex] = nextRecord;
  } else {
    domains.push(nextRecord);
  }

  return {
    ...options.state,
    domains,
  };
}

export function anchorConfirmedOnSnapshot(options: {
  snapshot: NonNullable<WalletReadContext["snapshot"]>;
  state: WalletStateV1;
  domainName: string;
}): boolean {
  const chainDomain = lookupDomain(options.snapshot.state, options.domainName);
  if (chainDomain === null || !chainDomain.anchored) {
    return false;
  }

  const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  return ownerHex === options.state.funding.scriptPubKeyHex
    || (options.state.localScriptPubKeyHexes ?? []).includes(ownerHex);
}

async function saveState(options: {
  state: WalletStateV1;
  provider: WalletSecretProvider;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
}): Promise<WalletStateV1> {
  return persistWalletMutationState(options);
}

export async function reconcilePendingAnchorMutation(options: {
  operation: AnchorMutationOperation;
  mutation: PendingMutationRecord;
  provider: WalletSecretProvider;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
  rpc: WalletAnchorRpcClient;
  walletName: string;
  context: WalletReadContext;
}): Promise<{
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  resolution: "confirmed" | "live" | "repair-required" | "not-seen" | "continue";
}> {
  if (options.mutation.status === "repair-required") {
    return {
      state: options.operation.state,
      mutation: options.mutation,
      resolution: "repair-required",
    };
  }

  if (options.context.snapshot !== null && anchorConfirmedOnSnapshot({
    snapshot: options.context.snapshot,
    state: options.operation.state,
    domainName: options.mutation.domainName,
  })) {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
    const confirmedMutation = updateMutationRecord(options.mutation, "confirmed", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    const chainDomain = lookupDomain(options.context.snapshot.state, options.mutation.domainName);
    const nextState = upsertAnchoredDomainRecord({
      state: upsertPendingMutation(options.operation.state, confirmedMutation),
      domainName: options.mutation.domainName,
      domainId: chainDomain?.domainId ?? 0,
      foundingMessageText: options.operation.message.text,
    });
    return {
      state: await saveState({
        state: nextState,
        provider: options.provider,
        nowUnixMs: options.nowUnixMs,
        paths: options.paths,
      }),
      mutation: confirmedMutation,
      resolution: "confirmed",
    };
  }

  if (options.mutation.attemptedTxid !== null) {
    const mempool: string[] = await options.rpc.getRawMempool().catch(() => []);
    if (mempool.includes(options.mutation.attemptedTxid)) {
      await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
      const liveMutation = updateMutationRecord(options.mutation, "live", options.nowUnixMs, {
        temporaryBuilderLockedOutpoints: [],
      });
      const domainId = (options.context.snapshot === null
        ? null
        : lookupDomain(options.context.snapshot.state, options.mutation.domainName)?.domainId)
        ?? options.operation.state.domains.find((domain) => domain.name === options.mutation.domainName)?.domainId
        ?? 0;
      const nextState = upsertAnchoredDomainRecord({
        state: upsertPendingMutation(options.operation.state, liveMutation),
        domainName: options.mutation.domainName,
        domainId,
        foundingMessageText: options.operation.message.text,
      });
      return {
        state: await saveState({
          state: nextState,
          provider: options.provider,
          nowUnixMs: options.nowUnixMs,
          paths: options.paths,
        }),
        mutation: liveMutation,
        resolution: "live",
      };
    }
  }

  if (
    options.mutation.status === "broadcast-unknown"
    || options.mutation.status === "live"
    || options.mutation.status === "draft"
    || options.mutation.status === "broadcasting"
  ) {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
    const canceledMutation = updateMutationRecord(options.mutation, "canceled", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    const nextState = upsertPendingMutation(options.operation.state, canceledMutation);
    return {
      state: await saveState({
        state: nextState,
        provider: options.provider,
        nowUnixMs: options.nowUnixMs,
        paths: options.paths,
      }),
      mutation: canceledMutation,
      resolution: "not-seen",
    };
  }

  return {
    state: options.operation.state,
    mutation: options.mutation,
    resolution: "continue",
  };
}
