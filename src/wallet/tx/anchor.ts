import { createHash, randomBytes } from "node:crypto";

import { encodeSentence } from "@cogcoin/scoring";
import { lookupDomain } from "@cogcoin/indexer/queries";

import { attachOrStartManagedBitcoindService } from "../../bitcoind/service.js";
import { createRpcClient } from "../../bitcoind/node.js";
import type {
  RpcDecodedPsbt,
  RpcListUnspentEntry,
} from "../../bitcoind/types.js";
import type { WalletPrompter } from "../lifecycle.js";
import { type WalletRuntimePaths } from "../runtime.js";
import {
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
  createWalletMutationFeeMetadata,
  mergeFixedWalletInputs,
  outpointKey,
  saveWalletStatePreservingUnlock,
  unlockTemporaryBuilderLocks,
  updateMutationRecord,
  type BuiltWalletMutationTransaction,
  type FixedWalletInput,
  type WalletMutationFeeSummary,
  type WalletMutationRpcClient,
} from "./common.js";
import {
  executeWalletMutationOperation,
  persistWalletMutationState,
  publishWalletMutation,
  resolveExistingWalletMutation,
} from "./executor.js";
import { upsertPendingMutation } from "./journal.js";

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
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
}

interface AnchorMutationOperation {
  state: WalletStateV1;
  normalizedDomainName: string;
  chainDomain: NonNullable<ReturnType<typeof lookupDomain>>;
  message: Awaited<ReturnType<typeof resolveFoundingMessage>>;
}

export interface AnchorDomainOptions {
  domainName: string;
  foundingMessageText?: string | null;
  promptForFoundingMessageWhenMissing?: boolean;
  feeRateSatVb?: number | null;
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
  fees: WalletMutationFeeSummary;
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
    outputs: [{ data: Buffer.from(opReturnData).toString("hex") }],
    changeAddress: options.state.funding.address,
    changePosition: 1,
    expectedOpReturnScriptHex: encodeOpReturnScript(opReturnData),
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

  if (funded.changepos === -1) {
    if (outputs.length !== 1) {
      throw new Error("wallet_anchor_unexpected_output_count");
    }
    return;
  }

  if (funded.changepos !== plan.changePosition || outputs.length !== 2) {
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
  feeSelection: {
    feeRateSatVb: number;
    source: "custom-satvb" | "estimated-next-block-plus-one" | "fallback-default";
  };
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

function upsertAnchoredDomainRecord(options: {
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
  nowUnixMs: number;
  paths: WalletRuntimePaths;
}): Promise<WalletStateV1> {
  return persistWalletMutationState(options);
}

async function reconcilePendingAnchorMutation(options: {
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  provider: WalletSecretProvider;
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
      foundingMessageText: options.foundingMessageText,
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
        ?? options.state.domains.find((domain) => domain.name === options.mutation.domainName)?.domainId
        ?? 0;
      const nextState = upsertAnchoredDomainRecord({
        state: upsertPendingMutation(options.state, liveMutation),
        domainName: options.mutation.domainName,
        domainId,
        foundingMessageText: options.foundingMessageText,
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
    const nextState = upsertPendingMutation(options.state, canceledMutation);
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

  const normalizedDomainName = normalizeDomainName(options.domainName);
  const execution = await executeWalletMutationOperation<
    AnchorMutationOperation,
    WalletAnchorRpcClient,
    null,
    BuiltWalletMutationTransaction,
    AnchorDomainResult
  >({
    ...options,
    controlLockPurpose: "wallet-anchor",
    preemptionReason: "wallet-anchor",
    async resolveOperation(readContext) {
      assertWalletMutationContextReady(readContext, "wallet_anchor");
      const message = await resolveFoundingMessage({
        foundingMessageText: options.foundingMessageText,
        promptForFoundingMessageWhenMissing: options.promptForFoundingMessageWhenMissing,
        prompter: options.prompter,
      });
      const state = readContext.localState.state;
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

      return {
        state,
        normalizedDomainName,
        chainDomain,
        message,
      };
    },
    createIntentFingerprint(operation) {
      return createIntentFingerprint([
        "anchor",
        operation.state.walletRootId,
        operation.normalizedDomainName,
        operation.state.funding.scriptPubKeyHex,
        operation.message.payloadHex ?? "",
      ]);
    },
    async resolveExistingMutation({ operation, existingMutation, execution }) {
      if (existingMutation === null) {
        return { state: operation.state, replacementFixedInputs: null, result: null };
      }

      return resolveExistingWalletMutation({
        existingMutation,
        execution,
        repairRequiredErrorCode: "wallet_anchor_repair_required",
        reconcileExistingMutation: (mutation) => reconcilePendingAnchorMutation({
          state: operation.state,
          mutation,
          provider: execution.provider,
          nowUnixMs: execution.nowUnixMs,
          paths: execution.paths,
          rpc: execution.rpc,
          walletName: execution.walletName,
          context: execution.readContext,
          foundingMessageText: operation.message.text,
        }),
        createReuseResult: ({ mutation, resolution, fees }) => ({
          domainName: operation.normalizedDomainName,
          txid: mutation.attemptedTxid ?? "unknown",
          status: resolution,
          reusedExisting: true,
          foundingMessageText: operation.message.text,
          fees,
        }),
      });
    },
    confirm({ operation }) {
      return confirmDirectAnchor(options.prompter, {
        domainName: operation.normalizedDomainName,
        walletAddress: operation.state.funding.address,
        foundingMessageText: operation.message.text,
      });
    },
    createDraftMutation({ operation, existingMutation, execution, intentFingerprintHex }) {
      return {
        mutation: createDraftAnchorMutation({
          state: operation.state,
          domainName: operation.normalizedDomainName,
          intentFingerprintHex,
          nowUnixMs: execution.nowUnixMs,
          feeSelection: execution.feeSelection,
          existing: existingMutation ?? null,
        }),
        prepared: null,
      };
    },
    async build({ operation, state, execution, replacementFixedInputs }) {
      const directAnchorPlan = buildDirectAnchorPlan({
        state,
        allUtxos: await execution.rpc.listUnspent(execution.walletName, 1),
        domainId: operation.chainDomain.domainId,
        foundingMessagePayloadHex: operation.message.payloadHex,
      });
      return buildWalletMutationTransactionWithReserveFallback({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        plan: {
          ...directAnchorPlan,
          fixedInputs: mergeFixedWalletInputs(directAnchorPlan.fixedInputs, replacementFixedInputs),
        },
        validateFundedDraft: validateDirectAnchorDraft,
        finalizeErrorCode: "wallet_anchor_finalize_failed",
        mempoolRejectPrefix: "wallet_anchor_mempool_rejected",
        feeRate: execution.feeSelection.feeRateSatVb,
      });
    },
    publish({ operation, state, execution, built, mutation }) {
      return publishWalletMutation({
        rpc: execution.rpc,
        walletName: execution.walletName,
        snapshotHeight: execution.readContext.snapshot?.tip?.height ?? null,
        built,
        mutation,
        state,
        provider: execution.provider,
        nowUnixMs: execution.nowUnixMs,
        paths: execution.paths,
        errorPrefix: "wallet_anchor",
        async afterAccepted({ state: acceptedState, broadcastingMutation, built, nowUnixMs }) {
          const finalStatus = anchorConfirmedOnSnapshot({
            snapshot: execution.readContext.snapshot!,
            state: acceptedState,
            domainName: operation.normalizedDomainName,
          }) ? "confirmed" : "live";
          const finalMutation = updateMutationRecord(broadcastingMutation, finalStatus, nowUnixMs, {
            attemptedTxid: built.txid,
            attemptedWtxid: built.wtxid,
            temporaryBuilderLockedOutpoints: [],
          });
          return {
            state: upsertAnchoredDomainRecord({
              state: upsertPendingMutation(acceptedState, finalMutation),
              domainName: operation.normalizedDomainName,
              domainId: operation.chainDomain.domainId,
              foundingMessageText: operation.message.text,
            }),
            mutation: finalMutation,
            status: finalStatus,
          };
        },
      });
    },
    createResult({ operation, mutation, built, status, reusedExisting, fees }) {
      return {
        domainName: operation.normalizedDomainName,
        txid: mutation.attemptedTxid ?? built?.txid ?? "unknown",
        status: status as AnchorDomainResult["status"],
        reusedExisting,
        foundingMessageText: operation.message.text,
        fees,
      };
    },
  });

  return execution.result;
}
