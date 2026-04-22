import { randomBytes } from "node:crypto";

import { getListing, lookupDomain } from "@cogcoin/indexer/queries";

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
  saveWalletStatePreservingUnlock,
  unlockTemporaryBuilderLocks,
  updateMutationRecord,
} from "../common.js";
import { upsertPendingMutation } from "../journal.js";
import type {
  DomainMarketDraftMutationOptions,
  DomainMarketRpcClient,
} from "./types.js";

export function reserveTransferredDomainRecord(options: {
  state: WalletStateV1;
  domainName: string;
  domainId: number | null;
  currentOwnerScriptPubKeyHex: string;
  nowUnixMs: number;
}): WalletStateV1 {
  const existing = options.state.domains.find((domain) => domain.name === options.domainName) ?? null;
  const domains: DomainRecord[] = options.state.domains.some((domain) => domain.name === options.domainName)
    ? options.state.domains.map((domain) => {
      if (domain.name !== options.domainName) {
        return domain;
      }

      return {
        ...domain,
        domainId: options.domainId ?? domain.domainId,
        currentOwnerScriptPubKeyHex: options.currentOwnerScriptPubKeyHex,
        canonicalChainStatus: "registered-unanchored",
        birthTime: domain.birthTime ?? Math.floor(options.nowUnixMs / 1000),
      };
    })
    : [
      ...options.state.domains,
      {
        name: options.domainName,
        domainId: options.domainId,
        currentOwnerScriptPubKeyHex: options.currentOwnerScriptPubKeyHex,
        canonicalChainStatus: "registered-unanchored",
        foundingMessageText: existing?.foundingMessageText ?? null,
        birthTime: Math.floor(options.nowUnixMs / 1000),
      },
    ];

  return {
    ...options.state,
    domains,
  };
}

export function createDomainMarketDraftMutation(
  options: DomainMarketDraftMutationOptions,
): PendingMutationRecord {
  if (options.existing !== null && options.existing !== undefined) {
    return {
      ...options.existing,
      kind: options.kind,
      parentDomainName: options.parentDomainName ?? null,
      senderScriptPubKeyHex: options.sender.scriptPubKeyHex,
      senderLocalIndex: options.sender.localIndex,
      recipientScriptPubKeyHex: options.recipientScriptPubKeyHex ?? null,
      priceCogtoshi: options.priceCogtoshi ?? null,
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
    parentDomainName: options.parentDomainName ?? null,
    senderScriptPubKeyHex: options.sender.scriptPubKeyHex,
    senderLocalIndex: options.sender.localIndex,
    recipientScriptPubKeyHex: options.recipientScriptPubKeyHex ?? null,
    priceCogtoshi: options.priceCogtoshi ?? null,
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

export function getTransferStatusAfterAcceptance(options: {
  snapshot: WalletReadContext["snapshot"];
  domainName: string;
  recipientScriptPubKeyHex: string;
}): "live" | "confirmed" {
  const chainDomain = options.snapshot === null ? null : lookupDomain(options.snapshot.state, options.domainName);
  if (chainDomain === null) {
    return "live";
  }

  return Buffer.from(chainDomain.ownerScriptPubKey).toString("hex") === options.recipientScriptPubKeyHex
    ? "confirmed"
    : "live";
}

export function getSellStatusAfterAcceptance(options: {
  snapshot: WalletReadContext["snapshot"];
  domainName: string;
  senderScriptPubKeyHex: string;
  listedPriceCogtoshi: bigint;
}): "live" | "confirmed" {
  const chainDomain = options.snapshot === null ? null : lookupDomain(options.snapshot.state, options.domainName);
  if (chainDomain === null) {
    return "live";
  }

  const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  const listing = getListing(options.snapshot!.state, chainDomain.domainId);

  if (options.listedPriceCogtoshi === 0n) {
    return ownerHex === options.senderScriptPubKeyHex && listing === null ? "confirmed" : "live";
  }

  return ownerHex === options.senderScriptPubKeyHex && listing?.priceCogtoshi === options.listedPriceCogtoshi
    ? "confirmed"
    : "live";
}

export function getBuyStatusAfterAcceptance(options: {
  snapshot: WalletReadContext["snapshot"];
  domainName: string;
  buyerScriptPubKeyHex: string;
}): "live" | "confirmed" {
  const chainDomain = options.snapshot === null ? null : lookupDomain(options.snapshot.state, options.domainName);
  if (chainDomain === null) {
    return "live";
  }

  return Buffer.from(chainDomain.ownerScriptPubKey).toString("hex") === options.buyerScriptPubKeyHex
    ? "confirmed"
    : "live";
}

export async function reconcilePendingDomainMarketMutation(options: {
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  provider: WalletSecretProvider;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
  rpc: DomainMarketRpcClient;
  walletName: string;
  context: WalletReadContext;
}): Promise<{
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  resolution: "confirmed" | "live" | "repair-required" | "not-seen" | "continue";
}> {
  if (options.mutation.status === "repair-required") {
    return {
      state: options.state,
      mutation: options.mutation,
      resolution: "repair-required",
    };
  }

  const chainDomain = options.context.snapshot === null
    ? null
    : lookupDomain(options.context.snapshot.state, options.mutation.domainName);

  if (chainDomain !== null) {
    const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
    const listing = getListing(options.context.snapshot!.state, chainDomain.domainId);

    if (options.mutation.kind === "transfer") {
      if (ownerHex === options.mutation.recipientScriptPubKeyHex) {
        await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
        const confirmed = updateMutationRecord(options.mutation, "confirmed", options.nowUnixMs, {
          temporaryBuilderLockedOutpoints: [],
        });
        const nextState = reserveTransferredDomainRecord({
          state: upsertPendingMutation(options.state, confirmed),
          domainName: options.mutation.domainName,
          domainId: chainDomain.domainId,
          currentOwnerScriptPubKeyHex: ownerHex,
          nowUnixMs: options.nowUnixMs,
        });
        await saveWalletStatePreservingUnlock({
          state: nextState,
          provider: options.provider,
          nowUnixMs: options.nowUnixMs,
          paths: options.paths,
        });
        return { state: nextState, mutation: confirmed, resolution: "confirmed" };
      }

      if (ownerHex !== options.mutation.senderScriptPubKeyHex) {
        const repair = updateMutationRecord(options.mutation, "repair-required", options.nowUnixMs, {
          temporaryBuilderLockedOutpoints: [],
        });
        const nextState = upsertPendingMutation(options.state, repair);
        await saveWalletStatePreservingUnlock({
          state: nextState,
          provider: options.provider,
          nowUnixMs: options.nowUnixMs,
          paths: options.paths,
        });
        return { state: nextState, mutation: repair, resolution: "repair-required" };
      }
    }

    if (options.mutation.kind === "sell") {
      const targetPrice = options.mutation.priceCogtoshi ?? 0n;
      if (ownerHex === options.mutation.senderScriptPubKeyHex) {
        if (targetPrice === 0n && listing === null) {
          await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
          const confirmed = updateMutationRecord(options.mutation, "confirmed", options.nowUnixMs, {
            temporaryBuilderLockedOutpoints: [],
          });
          const nextState = upsertPendingMutation(options.state, confirmed);
          await saveWalletStatePreservingUnlock({
            state: nextState,
            provider: options.provider,
            nowUnixMs: options.nowUnixMs,
            paths: options.paths,
          });
          return { state: nextState, mutation: confirmed, resolution: "confirmed" };
        }

        if (targetPrice > 0n && listing?.priceCogtoshi === targetPrice) {
          await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
          const confirmed = updateMutationRecord(options.mutation, "confirmed", options.nowUnixMs, {
            temporaryBuilderLockedOutpoints: [],
          });
          const nextState = upsertPendingMutation(options.state, confirmed);
          await saveWalletStatePreservingUnlock({
            state: nextState,
            provider: options.provider,
            nowUnixMs: options.nowUnixMs,
            paths: options.paths,
          });
          return { state: nextState, mutation: confirmed, resolution: "confirmed" };
        }
      } else {
        const repair = updateMutationRecord(options.mutation, "repair-required", options.nowUnixMs, {
          temporaryBuilderLockedOutpoints: [],
        });
        const nextState = upsertPendingMutation(options.state, repair);
        await saveWalletStatePreservingUnlock({
          state: nextState,
          provider: options.provider,
          nowUnixMs: options.nowUnixMs,
          paths: options.paths,
        });
        return { state: nextState, mutation: repair, resolution: "repair-required" };
      }
    }

    if (options.mutation.kind === "buy") {
      if (ownerHex === options.mutation.senderScriptPubKeyHex) {
        await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
        const confirmed = updateMutationRecord(options.mutation, "confirmed", options.nowUnixMs, {
          temporaryBuilderLockedOutpoints: [],
        });
        const nextState = reserveTransferredDomainRecord({
          state: upsertPendingMutation(options.state, confirmed),
          domainName: options.mutation.domainName,
          domainId: chainDomain.domainId,
          currentOwnerScriptPubKeyHex: ownerHex,
          nowUnixMs: options.nowUnixMs,
        });
        await saveWalletStatePreservingUnlock({
          state: nextState,
          provider: options.provider,
          nowUnixMs: options.nowUnixMs,
          paths: options.paths,
        });
        return { state: nextState, mutation: confirmed, resolution: "confirmed" };
      }

      if (listing === null) {
        const repair = updateMutationRecord(options.mutation, "repair-required", options.nowUnixMs, {
          temporaryBuilderLockedOutpoints: [],
        });
        const nextState = upsertPendingMutation(options.state, repair);
        await saveWalletStatePreservingUnlock({
          state: nextState,
          provider: options.provider,
          nowUnixMs: options.nowUnixMs,
          paths: options.paths,
        });
        return { state: nextState, mutation: repair, resolution: "repair-required" };
      }
    }
  }

  if (options.mutation.attemptedTxid !== null) {
    const mempool: string[] = await options.rpc.getRawMempool().catch(() => []);
    if (mempool.includes(options.mutation.attemptedTxid)) {
      await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
      const live = updateMutationRecord(options.mutation, "live", options.nowUnixMs, {
        temporaryBuilderLockedOutpoints: [],
      });
      let nextState = upsertPendingMutation(options.state, live);
      if (live.kind === "transfer" || live.kind === "buy") {
        nextState = reserveTransferredDomainRecord({
          state: nextState,
          domainName: live.domainName,
          domainId: chainDomain?.domainId ?? null,
          currentOwnerScriptPubKeyHex: live.kind === "transfer"
            ? (live.recipientScriptPubKeyHex ?? live.senderScriptPubKeyHex)
            : live.senderScriptPubKeyHex,
          nowUnixMs: options.nowUnixMs,
        });
      }
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider: options.provider,
        nowUnixMs: options.nowUnixMs,
        paths: options.paths,
      });
      return { state: nextState, mutation: live, resolution: "live" };
    }
  }

  if (
    options.mutation.status === "broadcast-unknown"
    || options.mutation.status === "live"
    || options.mutation.status === "draft"
    || options.mutation.status === "broadcasting"
  ) {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
    const canceled = updateMutationRecord(options.mutation, "canceled", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    const nextState = upsertPendingMutation(options.state, canceled);
    await saveWalletStatePreservingUnlock({
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
