import { createHash, randomBytes } from "node:crypto";

import { encodeSentence } from "@cogcoin/scoring";
import { lookupDomain } from "@cogcoin/indexer/queries";

import { attachOrStartManagedBitcoindService } from "../../bitcoind/service.js";
import { createRpcClient } from "../../bitcoind/node.js";
import type {
  RpcDecodedPsbt,
  RpcListUnspentEntry,
} from "../../bitcoind/types.js";
import { acquireFileLock } from "../fs/lock.js";
import type { WalletPrompter } from "../lifecycle.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../runtime.js";
import {
  createDefaultWalletSecretProvider,
  type WalletSecretProvider,
} from "../state/provider.js";
import type {
  DomainRecord,
  PendingMutationRecord,
  WalletStateV1,
} from "../types.js";
import {
  serializeDomainAnchor,
  validateDomainName,
} from "../cogop/index.js";
import { openWalletReadContext, type WalletReadContext } from "../read/index.js";
import {
  assertWalletMutationContextReady,
  buildWalletMutationTransactionWithReserveFallback,
  isAlreadyAcceptedError,
  isBroadcastUnknownError,
  outpointKey,
  pauseMiningForWalletMutation,
  saveWalletStatePreservingUnlock,
  unlockTemporaryBuilderLocks,
  updateMutationRecord,
  type BuiltWalletMutationTransaction,
  type FixedWalletInput,
  type WalletMutationRpcClient,
} from "./common.js";
import { findPendingMutationByIntent, upsertPendingMutation } from "./journal.js";

interface WalletAnchorRpcClient extends WalletMutationRpcClient {
  getBlockchainInfo(): Promise<{ blocks: number }>;
  sendRawTransaction(hex: string): Promise<string>;
  getRawMempool(): Promise<string[]>;
}

interface DirectAnchorPlan {
  fixedInputs: FixedWalletInput[];
  outputs: unknown[];
  changeAddress: string;
  changePosition: number;
  expectedOpReturnScriptHex: string;
  expectedAnchorScriptHex: string;
  expectedAnchorValueSats: bigint;
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
}

export interface AnchorDomainOptions {
  domainName: string;
  foundingMessageText?: string | null;
  promptForFoundingMessageWhenMissing?: boolean;
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletAnchorRpcClient;
}

export interface AnchorDomainResult {
  domainName: string;
  txid: string;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  foundingMessageText?: string | null;
}

function normalizeDomainName(domainName: string): string {
  const normalized = domainName.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("wallet_anchor_missing_domain");
  }
  validateDomainName(normalized);
  return normalized;
}

function encodeOpReturnScript(payload: Uint8Array): string {
  if (payload.length <= 75) {
    return Buffer.concat([
      Buffer.from([0x6a, payload.length]),
      Buffer.from(payload),
    ]).toString("hex");
  }

  return Buffer.concat([
    Buffer.from([0x6a, 0x4c, payload.length]),
    Buffer.from(payload),
  ]).toString("hex");
}

function satsToBtcNumber(value: bigint): number {
  return Number(value) / 100_000_000;
}

function valueToSats(value: number | string): bigint {
  const text = typeof value === "number" ? value.toFixed(8) : value;
  const match = /^(-?)(\d+)(?:\.(\d{0,8}))?$/.exec(text.trim());

  if (match == null) {
    throw new Error(`wallet_anchor_invalid_amount_${text}`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  const fraction = BigInt((match[3] ?? "").padEnd(8, "0"));
  return sign * ((whole * 100_000_000n) + fraction);
}

function createIntentFingerprint(parts: Array<string | number | bigint>): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part)).join("\n"))
    .digest("hex");
}

function sortUtxos(entries: RpcListUnspentEntry[]): RpcListUnspentEntry[] {
  return entries
    .slice()
    .sort((left, right) =>
      right.amount - left.amount
      || left.txid.localeCompare(right.txid)
      || left.vout - right.vout);
}

function isSpendableFundingUtxo(entry: RpcListUnspentEntry, fundingScriptPubKeyHex: string): boolean {
  return entry.scriptPubKey === fundingScriptPubKeyHex
    && entry.confirmations >= 1
    && entry.spendable !== false
    && entry.safe !== false;
}

function encodeFoundingMessage(
  foundingMessageText: string | null | undefined,
): Promise<{ text: string | null; payloadHex: string | null }> {
  const trimmed = foundingMessageText?.trim() ?? "";
  if (trimmed === "") {
    return Promise.resolve({
      text: null,
      payloadHex: null,
    });
  }

  return encodeSentence(trimmed)
    .then((payload) => ({
      text: trimmed,
      payloadHex: Buffer.from(payload).toString("hex"),
    }))
    .catch((error) => {
      throw new Error(error instanceof Error ? `wallet_anchor_invalid_message_${error.message}` : "wallet_anchor_invalid_message");
    });
}

function extractAnchorInvalidMessageReason(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);

  if (message === "wallet_anchor_invalid_message") {
    return null;
  }

  if (!message.startsWith("wallet_anchor_invalid_message_")) {
    return null;
  }

  const reason = message.slice("wallet_anchor_invalid_message_".length).trim();
  return reason === "" ? null : reason;
}

async function resolveFoundingMessage(options: {
  foundingMessageText: string | null | undefined;
  promptForFoundingMessageWhenMissing?: boolean;
  prompter: WalletPrompter;
}): Promise<{ text: string | null; payloadHex: string | null }> {
  if (!options.promptForFoundingMessageWhenMissing || options.foundingMessageText != null) {
    return encodeFoundingMessage(options.foundingMessageText ?? null);
  }

  for (;;) {
    const answer = await options.prompter.prompt("Founding message (optional, press Enter to skip): ");

    try {
      return await encodeFoundingMessage(answer);
    } catch (error) {
      const reason = extractAnchorInvalidMessageReason(error);
      options.prompter.writeLine("Founding message cannot be encoded in canonical Coglex.");
      if (reason !== null) {
        options.prompter.writeLine(`Reason: ${reason}`);
      }
    }
  }
}

async function confirmDirectAnchor(
  prompter: WalletPrompter,
  options: {
    domainName: string;
    walletAddress: string;
    foundingMessageText: string | null;
  },
): Promise<void> {
  prompter.writeLine(`You are anchoring "${options.domainName}".`);
  prompter.writeLine(`Wallet address: ${options.walletAddress}`);
  prompter.writeLine("Anchoring publishes a standalone DOMAIN_ANCHOR from the local wallet address.");

  if (options.foundingMessageText !== null) {
    prompter.writeLine("The founding message bytes will be public in mempool and on-chain.");
    prompter.writeLine(`Founding message: ${options.foundingMessageText}`);
  }

  const answer = (await prompter.prompt("Type the domain name to continue: ")).trim();
  if (answer !== options.domainName) {
    throw new Error("wallet_anchor_confirmation_rejected");
  }
}

function buildDirectAnchorPlan(options: {
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  domainId: number;
  foundingMessagePayloadHex: string | null;
}): DirectAnchorPlan {
  const fundingUtxos = sortUtxos(options.allUtxos.filter((entry) =>
    isSpendableFundingUtxo(entry, options.state.funding.scriptPubKeyHex)
  ));
  const foundingPayload = options.foundingMessagePayloadHex === null
    ? undefined
    : Buffer.from(options.foundingMessagePayloadHex, "hex");
  const opReturnData = serializeDomainAnchor(options.domainId, foundingPayload).opReturnData;

  return {
    fixedInputs: [],
    outputs: [
      { data: Buffer.from(opReturnData).toString("hex") },
      { [options.state.funding.address]: satsToBtcNumber(BigInt(options.state.anchorValueSats)) },
    ],
    changeAddress: options.state.funding.address,
    changePosition: 2,
    expectedOpReturnScriptHex: encodeOpReturnScript(opReturnData),
    expectedAnchorScriptHex: options.state.funding.scriptPubKeyHex,
    expectedAnchorValueSats: BigInt(options.state.anchorValueSats),
    allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    eligibleFundingOutpointKeys: new Set(fundingUtxos.map((entry) => outpointKey({ txid: entry.txid, vout: entry.vout }))),
  };
}

function validateDirectAnchorDraft(
  decoded: RpcDecodedPsbt,
  funded: BuiltWalletMutationTransaction["funded"],
  plan: DirectAnchorPlan,
): void {
  const outputs = decoded.tx.vout;

  if (outputs[0]?.scriptPubKey?.hex !== plan.expectedOpReturnScriptHex) {
    throw new Error("wallet_anchor_opreturn_mismatch");
  }

  if (outputs[1]?.scriptPubKey?.hex !== plan.expectedAnchorScriptHex) {
    throw new Error("wallet_anchor_anchor_output_mismatch");
  }

  if (valueToSats(outputs[1]?.value ?? 0) !== plan.expectedAnchorValueSats) {
    throw new Error("wallet_anchor_anchor_value_mismatch");
  }

  if (funded.changepos === -1) {
    if (outputs.length !== 2) {
      throw new Error("wallet_anchor_unexpected_output_count");
    }
    return;
  }

  if (funded.changepos !== plan.changePosition || outputs.length !== 3) {
    throw new Error("wallet_anchor_change_position_mismatch");
  }

  if (outputs[funded.changepos]?.scriptPubKey?.hex !== plan.allowedFundingScriptPubKeyHex) {
    throw new Error("wallet_anchor_change_output_mismatch");
  }
}

function createDraftAnchorMutation(options: {
  state: WalletStateV1;
  domainName: string;
  intentFingerprintHex: string;
  nowUnixMs: number;
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
    temporaryBuilderLockedOutpoints: [],
  };
}

function upsertAnchoredDomainRecord(options: {
  state: WalletStateV1;
  domainName: string;
  domainId: number;
  txid: string;
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
    currentCanonicalAnchorOutpoint: {
      txid: options.txid,
      vout: 1,
      valueSats: options.state.anchorValueSats,
    },
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

function anchorConfirmedOnSnapshot(options: {
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
  unlockUntilUnixMs: number;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
}): Promise<WalletStateV1> {
  const nextState = {
    ...options.state,
    stateRevision: options.state.stateRevision + 1,
    lastWrittenAtUnixMs: options.nowUnixMs,
  };
  await saveWalletStatePreservingUnlock({
    state: nextState,
    provider: options.provider,
    unlockUntilUnixMs: options.unlockUntilUnixMs,
    nowUnixMs: options.nowUnixMs,
    paths: options.paths,
  });
  return nextState;
}

async function reconcilePendingAnchorMutation(options: {
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  provider: WalletSecretProvider;
  unlockUntilUnixMs: number;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
  rpc: WalletAnchorRpcClient;
  walletName: string;
  context: WalletReadContext;
  foundingMessageText: string | null;
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

  if (options.context.snapshot !== null && anchorConfirmedOnSnapshot({
    snapshot: options.context.snapshot,
    state: options.state,
    domainName: options.mutation.domainName,
  })) {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
    const confirmedMutation = updateMutationRecord(options.mutation, "confirmed", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    const chainDomain = lookupDomain(options.context.snapshot.state, options.mutation.domainName);
    const nextState = upsertAnchoredDomainRecord({
      state: upsertPendingMutation(options.state, confirmedMutation),
      domainName: options.mutation.domainName,
      domainId: chainDomain?.domainId ?? 0,
      txid: options.mutation.attemptedTxid ?? "unknown",
      foundingMessageText: options.foundingMessageText,
    });
    return {
      state: await saveState({
        state: nextState,
        provider: options.provider,
        unlockUntilUnixMs: options.unlockUntilUnixMs,
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
        ?? options.state.domains.find((domain) => domain.name === options.mutation.domainName)?.domainId
        ?? 0;
      const nextState = upsertAnchoredDomainRecord({
        state: upsertPendingMutation(options.state, liveMutation),
        domainName: options.mutation.domainName,
        domainId,
        txid: options.mutation.attemptedTxid,
        foundingMessageText: options.foundingMessageText,
      });
      return {
        state: await saveState({
          state: nextState,
          provider: options.provider,
          unlockUntilUnixMs: options.unlockUntilUnixMs,
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
    const nextState = upsertPendingMutation(options.state, canceledMutation);
    return {
      state: await saveState({
        state: nextState,
        provider: options.provider,
        unlockUntilUnixMs: options.unlockUntilUnixMs,
        nowUnixMs: options.nowUnixMs,
        paths: options.paths,
      }),
      mutation: canceledMutation,
      resolution: "not-seen",
    };
  }

  return {
    state: options.state,
    mutation: options.mutation,
    resolution: "continue",
  };
}

function ensureSameTipHeight(context: WalletReadContext, bestHeight: number, errorCode: string): void {
  if (context.snapshot?.tip?.height !== bestHeight) {
    throw new Error(errorCode);
  }
}

export async function anchorDomain(options: AnchorDomainOptions): Promise<AnchorDomainResult> {
  if (!options.prompter.isInteractive) {
    throw new Error("wallet_anchor_requires_tty");
  }

  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const normalizedDomainName = normalizeDomainName(options.domainName);
  const controlLock = await acquireFileLock(paths.walletControlLockPath, {
    purpose: "wallet-anchor",
    walletRootId: null,
  });

  try {
    const miningPreemption = await pauseMiningForWalletMutation({
      paths,
      reason: "wallet-anchor",
    });
    const readContext = await (options.openReadContext ?? openWalletReadContext)({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      secretProvider: provider,
      walletControlLockHeld: true,
      paths,
    });

    try {
      assertWalletMutationContextReady(readContext, "wallet_anchor");
      const message = await resolveFoundingMessage({
        foundingMessageText: options.foundingMessageText,
        promptForFoundingMessageWhenMissing: options.promptForFoundingMessageWhenMissing,
        prompter: options.prompter,
      });
      const state = readContext.localState.state;
      const unlockUntilUnixMs = readContext.localState.unlockUntilUnixMs;
      const chainDomain = lookupDomain(readContext.snapshot.state, normalizedDomainName);

      if (chainDomain === null) {
        throw new Error("wallet_anchor_domain_not_found");
      }
      if (chainDomain.anchored) {
        throw new Error("wallet_anchor_domain_already_anchored");
      }

      const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
      const localScriptHexes = new Set([
        state.funding.scriptPubKeyHex,
        ...(state.localScriptPubKeyHexes ?? []),
      ]);

      if (!localScriptHexes.has(ownerHex)) {
        throw new Error("wallet_anchor_owner_not_locally_controlled");
      }

      if (state.funding.address.trim() === "") {
        throw new Error("wallet_anchor_owner_identity_not_supported");
      }

      const intentFingerprintHex = createIntentFingerprint([
        "anchor",
        state.walletRootId,
        normalizedDomainName,
        state.funding.scriptPubKeyHex,
        message.payloadHex ?? "",
      ]);
      const node = await (options.attachService ?? attachOrStartManagedBitcoindService)({
        dataDir: options.dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: state.walletRootId,
      });
      const rpc = (options.rpcFactory ?? createRpcClient)(node.rpc);
      const walletName = state.managedCoreWallet.walletName;
      const existingMutation = findPendingMutationByIntent(state, intentFingerprintHex);
      let workingState = state;

      if (existingMutation !== null) {
        const reconciled = await reconcilePendingAnchorMutation({
          state,
          mutation: existingMutation,
          provider,
          unlockUntilUnixMs,
          nowUnixMs,
          paths,
          rpc,
          walletName,
          context: readContext,
          foundingMessageText: message.text,
        });
        workingState = reconciled.state;

        if (reconciled.resolution === "confirmed" || reconciled.resolution === "live") {
          return {
            domainName: normalizedDomainName,
            txid: reconciled.mutation.attemptedTxid ?? "unknown",
            status: reconciled.resolution,
            reusedExisting: true,
            foundingMessageText: message.text,
          };
        }

        if (reconciled.resolution === "repair-required") {
          throw new Error("wallet_anchor_repair_required");
        }
      }

      await confirmDirectAnchor(options.prompter, {
        domainName: normalizedDomainName,
        walletAddress: state.funding.address,
        foundingMessageText: message.text,
      });

      let nextState = upsertPendingMutation(
        workingState,
        createDraftAnchorMutation({
          state: workingState,
          domainName: normalizedDomainName,
          intentFingerprintHex,
          nowUnixMs,
          existing: existingMutation ?? null,
        }),
      );
      nextState = await saveState({
        state: nextState,
        provider,
        unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      const built = await buildWalletMutationTransactionWithReserveFallback({
        rpc,
        walletName,
        state: nextState,
        plan: buildDirectAnchorPlan({
          state: nextState,
          allUtxos: await rpc.listUnspent(walletName, 1),
          domainId: chainDomain.domainId,
          foundingMessagePayloadHex: message.payloadHex,
        }),
        validateFundedDraft: validateDirectAnchorDraft,
        finalizeErrorCode: "wallet_anchor_finalize_failed",
        mempoolRejectPrefix: "wallet_anchor_mempool_rejected",
      });

      const currentMutation = nextState.pendingMutations?.find((mutation) => mutation.intentFingerprintHex === intentFingerprintHex)
        ?? createDraftAnchorMutation({
          state: nextState,
          domainName: normalizedDomainName,
          intentFingerprintHex,
          nowUnixMs,
        });
      const broadcastingMutation = updateMutationRecord(
        currentMutation,
        "broadcasting",
        nowUnixMs,
        {
          attemptedTxid: built.txid,
          attemptedWtxid: built.wtxid,
          temporaryBuilderLockedOutpoints: built.temporaryBuilderLockedOutpoints,
        },
      );
      nextState = await saveState({
        state: upsertPendingMutation(nextState, broadcastingMutation),
        provider,
        unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      ensureSameTipHeight(readContext, (await rpc.getBlockchainInfo()).blocks, "wallet_anchor_tip_mismatch");

      let accepted = false;
      try {
        await rpc.sendRawTransaction(built.rawHex);
        accepted = true;
      } catch (error) {
        if (isAlreadyAcceptedError(error)) {
          accepted = true;
        } else if (isBroadcastUnknownError(error)) {
          const unknownMutation = updateMutationRecord(broadcastingMutation, "broadcast-unknown", nowUnixMs, {
            attemptedTxid: built.txid,
            attemptedWtxid: built.wtxid,
            temporaryBuilderLockedOutpoints: built.temporaryBuilderLockedOutpoints,
          });
          await saveState({
            state: upsertPendingMutation(nextState, unknownMutation),
            provider,
            unlockUntilUnixMs,
            nowUnixMs,
            paths,
          });
          throw new Error("wallet_anchor_broadcast_unknown");
        } else {
          await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
          const canceledMutation = updateMutationRecord(broadcastingMutation, "canceled", nowUnixMs, {
            attemptedTxid: built.txid,
            attemptedWtxid: built.wtxid,
            temporaryBuilderLockedOutpoints: [],
          });
          await saveState({
            state: upsertPendingMutation(nextState, canceledMutation),
            provider,
            unlockUntilUnixMs,
            nowUnixMs,
            paths,
          });
          throw error;
        }
      }

      if (!accepted) {
        throw new Error("wallet_anchor_broadcast_failed");
      }

      await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
      const finalStatus = anchorConfirmedOnSnapshot({
        snapshot: readContext.snapshot,
        state: nextState,
        domainName: normalizedDomainName,
      }) ? "confirmed" : "live";
      const finalMutation = updateMutationRecord(broadcastingMutation, finalStatus, nowUnixMs, {
        attemptedTxid: built.txid,
        attemptedWtxid: built.wtxid,
        temporaryBuilderLockedOutpoints: [],
      });
      nextState = upsertAnchoredDomainRecord({
        state: upsertPendingMutation(nextState, finalMutation),
        domainName: normalizedDomainName,
        domainId: chainDomain.domainId,
        txid: built.txid,
        foundingMessageText: message.text,
      });
      nextState = await saveState({
        state: nextState,
        provider,
        unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      return {
        domainName: normalizedDomainName,
        txid: built.txid,
        status: finalStatus,
        reusedExisting: false,
        foundingMessageText: message.text,
      };
    } finally {
      await readContext.close();
      await miningPreemption.release();
    }
  } finally {
    await controlLock.release();
  }
}
