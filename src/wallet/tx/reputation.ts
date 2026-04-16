import { createHash, randomBytes } from "node:crypto";

import { encodeSentence } from "@cogcoin/scoring";
import {
  getBalance,
  lookupDomain,
} from "@cogcoin/indexer/queries";

import { attachOrStartManagedBitcoindService } from "../../bitcoind/service.js";
import { createRpcClient } from "../../bitcoind/node.js";
import type {
  RpcDecodedPsbt,
  RpcListUnspentEntry,
  RpcWalletTransaction,
} from "../../bitcoind/types.js";
import { acquireFileLock } from "../fs/lock.js";
import type { WalletPrompter } from "../lifecycle.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../runtime.js";
import {
  createDefaultWalletSecretProvider,
  type WalletSecretProvider,
} from "../state/provider.js";
import type {
  OutpointRecord,
  PendingMutationRecord,
  WalletStateV1,
} from "../types.js";
import {
  serializeRepCommit,
  serializeRepRevoke,
  validateDomainName,
} from "../cogop/index.js";
import { openWalletReadContext, type WalletReadContext } from "../read/index.js";
import {
  assertFixedInputPrefixMatches,
  assertFundingInputsAfterFixedPrefix,
  assertWalletMutationContextReady,
  buildWalletMutationTransactionWithReserveFallback,
  formatCogAmount,
  getDecodedInputScriptPubKeyHex,
  isAlreadyAcceptedError,
  isBroadcastUnknownError,
  outpointKey,
  pauseMiningForWalletMutation,
  saveWalletStatePreservingUnlock,
  unlockTemporaryBuilderLocks,
  updateMutationRecord,
  type BuiltWalletMutationTransaction,
  type FixedWalletInput,
  type MutationSender,
  type WalletMutationRpcClient,
} from "./common.js";
import {
  confirmTypedAcknowledgement as confirmSharedTypedAcknowledgement,
  confirmYesNo as confirmSharedYesNo,
} from "./confirm.js";
import { getCanonicalIdentitySelector } from "./identity-selector.js";
import { findPendingMutationByIntent, upsertPendingMutation } from "./journal.js";

type ReputationMutationKind = "rep-give" | "rep-revoke";

interface ReputationRpcClient extends WalletMutationRpcClient {
  getBlockchainInfo(): Promise<{ blocks: number }>;
  sendRawTransaction(hex: string): Promise<string>;
  getTransaction(walletName: string, txid: string): Promise<RpcWalletTransaction>;
}

interface ReputationPlan {
  sender: MutationSender;
  changeAddress: string;
  fixedInputs: FixedWalletInput[];
  outputs: unknown[];
  changePosition: number;
  expectedOpReturnScriptHex: string;
  expectedAnchorScriptHex: string;
  expectedAnchorValueSats: bigint;
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
  errorPrefix: string;
}

interface ReputationOperation {
  readContext: WalletReadContext & {
    localState: {
      availability: "ready";
      state: WalletStateV1;
      unlockUntilUnixMs: number;
    };
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
    model: NonNullable<WalletReadContext["model"]>;
  };
  state: WalletStateV1;
  unlockUntilUnixMs: number;
  sender: MutationSender;
  senderSelector: string;
  anchorOutpoint: OutpointRecord;
  sourceDomain: NonNullable<ReturnType<typeof lookupDomain>>;
  targetDomain: NonNullable<ReturnType<typeof lookupDomain>>;
  availableBalanceCogtoshi: bigint;
  currentNetSupportCogtoshi: bigint;
}

interface ReputationReview {
  text: string | null;
  payload: Uint8Array | undefined;
  payloadHex: string | null;
}

interface BuiltReputationTransaction extends BuiltWalletMutationTransaction {}

export interface ReputationMutationResult {
  kind: "give" | "revoke";
  sourceDomainName: string;
  targetDomainName: string;
  amountCogtoshi: bigint;
  txid: string;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  reviewIncluded: boolean;
  resolved?: ReputationResolvedSummary | null;
}

export interface ReputationResolvedSenderSummary {
  selector: string;
  localIndex: number;
  scriptPubKeyHex: string;
  address: string;
}

export type ReputationResolvedEffect =
  | { kind: "give-support"; burnCogtoshi: string }
  | { kind: "revoke-support"; burnCogtoshi: string };

export interface ReputationResolvedReviewSummary {
  included: boolean;
  byteLength: number | null;
}

export interface ReputationResolvedSummary {
  sender: ReputationResolvedSenderSummary;
  effect: ReputationResolvedEffect;
  review: ReputationResolvedReviewSummary;
  selfStake: boolean;
}

interface ReputationBaseOptions {
  sourceDomainName: string;
  targetDomainName: string;
  amountCogtoshi: bigint;
  reviewText?: string | null;
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  assumeYes?: boolean;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => ReputationRpcClient;
}

export interface GiveReputationOptions extends ReputationBaseOptions {}

export interface RevokeReputationOptions extends ReputationBaseOptions {}

function normalizeDomainName(domainName: string, errorCode: string): string {
  const normalized = domainName.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error(errorCode);
  }
  validateDomainName(normalized);
  return normalized;
}

function createSupportKey(sourceDomainId: number, targetDomainId: number): string {
  return `${sourceDomainId}:${targetDomainId}`;
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
    throw new Error(`wallet_reputation_invalid_amount_${text}`);
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

function createResolvedReputationSenderSummary(
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

function createResolvedReputationSummary(options: {
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

function describeReputationEffect(effect: ReputationResolvedEffect): string {
  if (effect.kind === "give-support") {
    return `burn ${effect.burnCogtoshi} cogtoshi to publish support`;
  }

  return `revoke visible support with no refund of the previously burned ${effect.burnCogtoshi} cogtoshi`;
}

function describeReputationReview(review: ReputationResolvedReviewSummary): string {
  if (!review.included || review.byteLength === null) {
    return "none";
  }

  return `included (${review.byteLength} bytes)`;
}

function resolveAnchorOutpointForSender(
  state: WalletStateV1,
  sender: NonNullable<WalletReadContext["model"]>["identities"][number],
  errorPrefix: string,
): OutpointRecord {
  const anchoredDomain = state.domains.find((domain) =>
    domain.currentOwnerLocalIndex === sender.index
    && domain.canonicalChainStatus === "anchored"
  ) ?? null;

  if (anchoredDomain?.currentCanonicalAnchorOutpoint === null || anchoredDomain === null) {
    throw new Error(`${errorPrefix}_anchor_outpoint_unavailable`);
  }

  return {
    txid: anchoredDomain.currentCanonicalAnchorOutpoint.txid,
    vout: anchoredDomain.currentCanonicalAnchorOutpoint.vout,
  };
}

function resolveReputationOperation(
  context: WalletReadContext,
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
  const ownerIdentity = context.model.identities.find((identity) => identity.scriptPubKeyHex === ownerHex) ?? null;

  if (ownerIdentity === null || ownerIdentity.address === null) {
    throw new Error(`${errorPrefix}_source_owner_not_locally_controlled`);
  }

  if (ownerIdentity.readOnly) {
    throw new Error(`${errorPrefix}_source_owner_read_only`);
  }

  return {
    readContext: context,
    state: context.localState.state,
    unlockUntilUnixMs: context.localState.unlockUntilUnixMs,
    sender: {
      localIndex: ownerIdentity.index,
      scriptPubKeyHex: ownerIdentity.scriptPubKeyHex,
      address: ownerIdentity.address,
    },
    senderSelector: getCanonicalIdentitySelector(ownerIdentity),
    anchorOutpoint: resolveAnchorOutpointForSender(context.localState.state, ownerIdentity, errorPrefix),
    sourceDomain,
    targetDomain,
    availableBalanceCogtoshi: getBalance(context.snapshot.state, sourceDomain.ownerScriptPubKey),
    currentNetSupportCogtoshi: context.snapshot.state.consensus.supportByPair.get(
      createSupportKey(sourceDomain.domainId, targetDomain.domainId),
    ) ?? 0n,
  };
}

function buildPlanForReputationOperation(options: {
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  sender: MutationSender;
  anchorOutpoint: OutpointRecord;
  opReturnData: Uint8Array;
  errorPrefix: string;
}): ReputationPlan {
  const fundingUtxos = options.allUtxos.filter((entry) =>
    entry.scriptPubKey === options.state.funding.scriptPubKeyHex
    && entry.confirmations >= 1
    && entry.spendable !== false
    && entry.safe !== false
  );
  const anchorUtxo = options.allUtxos.find((entry) =>
    entry.txid === options.anchorOutpoint.txid
    && entry.vout === options.anchorOutpoint.vout
    && entry.scriptPubKey === options.sender.scriptPubKeyHex
    && entry.confirmations >= 1
    && entry.spendable !== false
    && entry.safe !== false
  );

  if (anchorUtxo === undefined) {
    throw new Error(`${options.errorPrefix}_anchor_utxo_missing`);
  }

  return {
    sender: options.sender,
    changeAddress: options.state.funding.address,
    fixedInputs: [
      { txid: anchorUtxo.txid, vout: anchorUtxo.vout },
    ],
    outputs: [
      { data: Buffer.from(options.opReturnData).toString("hex") },
      { [options.sender.address]: satsToBtcNumber(BigInt(options.state.anchorValueSats)) },
    ],
    changePosition: 2,
    expectedOpReturnScriptHex: encodeOpReturnScript(options.opReturnData),
    expectedAnchorScriptHex: options.sender.scriptPubKeyHex,
    expectedAnchorValueSats: BigInt(options.state.anchorValueSats),
    allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    eligibleFundingOutpointKeys: new Set(fundingUtxos.map((entry) => outpointKey({ txid: entry.txid, vout: entry.vout }))),
    errorPrefix: options.errorPrefix,
  };
}

function validateFundedDraft(
  decoded: RpcDecodedPsbt,
  funded: BuiltReputationTransaction["funded"],
  plan: ReputationPlan,
): void {
  const inputs = decoded.tx.vin;
  const outputs = decoded.tx.vout;

  if (inputs.length === 0) {
    throw new Error(`${plan.errorPrefix}_missing_sender_input`);
  }

  assertFixedInputPrefixMatches(inputs, plan.fixedInputs, `${plan.errorPrefix}_sender_input_mismatch`);

  if (getDecodedInputScriptPubKeyHex(decoded, 0) !== plan.sender.scriptPubKeyHex) {
    throw new Error(`${plan.errorPrefix}_sender_input_mismatch`);
  }

  assertFundingInputsAfterFixedPrefix({
    decoded,
    fixedInputs: plan.fixedInputs,
    allowedFundingScriptPubKeyHex: plan.allowedFundingScriptPubKeyHex,
    eligibleFundingOutpointKeys: plan.eligibleFundingOutpointKeys,
    errorCode: `${plan.errorPrefix}_unexpected_funding_input`,
  });

  if (outputs[0]?.scriptPubKey?.hex !== plan.expectedOpReturnScriptHex) {
    throw new Error(`${plan.errorPrefix}_opreturn_mismatch`);
  }

  if (outputs[1]?.scriptPubKey?.hex !== plan.expectedAnchorScriptHex) {
    throw new Error(`${plan.errorPrefix}_anchor_output_mismatch`);
  }

  if (valueToSats(outputs[1]?.value ?? 0) !== plan.expectedAnchorValueSats) {
    throw new Error(`${plan.errorPrefix}_anchor_value_mismatch`);
  }

  if (funded.changepos === -1) {
    if (outputs.length !== 2) {
      throw new Error(`${plan.errorPrefix}_unexpected_output_count`);
    }
    return;
  }

  if (funded.changepos !== plan.changePosition || outputs.length !== 3) {
    throw new Error(`${plan.errorPrefix}_change_position_mismatch`);
  }

  if (outputs[funded.changepos]?.scriptPubKey?.hex !== plan.allowedFundingScriptPubKeyHex) {
    throw new Error(`${plan.errorPrefix}_change_output_mismatch`);
  }
}

async function buildTransaction(options: {
  rpc: ReputationRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: ReputationPlan;
}): Promise<BuiltReputationTransaction> {
  return buildWalletMutationTransactionWithReserveFallback({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
    plan: options.plan,
    validateFundedDraft,
    finalizeErrorCode: `${options.plan.errorPrefix}_finalize_failed`,
    mempoolRejectPrefix: `${options.plan.errorPrefix}_mempool_rejected`,
    reserveCandidates: options.state.proactiveReserveOutpoints,
  });
}

function createDraftMutation(options: {
  kind: ReputationMutationKind;
  sourceDomainName: string;
  targetDomainName: string;
  amountCogtoshi: bigint;
  sender: MutationSender;
  intentFingerprintHex: string;
  nowUnixMs: number;
  reviewPayloadHex: string | null;
  existing?: PendingMutationRecord | null;
}): PendingMutationRecord {
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
    temporaryBuilderLockedOutpoints: [],
  };
}

async function saveUpdatedMutationState(options: {
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

async function reconcilePendingReputationMutation(options: {
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  provider: WalletSecretProvider;
  unlockUntilUnixMs: number;
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
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
    const status = walletTx.confirmations > 0 ? "confirmed" : "live";
    const nextMutation = updateMutationRecord(options.mutation, status, options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    let nextState = upsertPendingMutation(options.state, nextMutation);
    nextState = await saveUpdatedMutationState({
      state: nextState,
      provider: options.provider,
      unlockUntilUnixMs: options.unlockUntilUnixMs,
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
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
    const repair = updateMutationRecord(options.mutation, "repair-required", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    let nextState = upsertPendingMutation(options.state, repair);
    nextState = await saveUpdatedMutationState({
      state: nextState,
      provider: options.provider,
      unlockUntilUnixMs: options.unlockUntilUnixMs,
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
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
    const canceled = updateMutationRecord(options.mutation, "canceled", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    let nextState = upsertPendingMutation(options.state, canceled);
    nextState = await saveUpdatedMutationState({
      state: nextState,
      provider: options.provider,
      unlockUntilUnixMs: options.unlockUntilUnixMs,
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

async function confirmYesNo(
  prompter: WalletPrompter,
  message: string,
  errorCode: string,
  options: {
    assumeYes?: boolean;
    requiresTtyErrorCode: string;
  },
): Promise<void> {
  await confirmSharedYesNo(prompter, message, {
    assumeYes: options.assumeYes,
    errorCode,
    requiresTtyErrorCode: options.requiresTtyErrorCode,
  });
}

async function confirmTyped(
  prompter: WalletPrompter,
  expected: string,
  prompt: string,
  errorCode: string,
  options: {
    assumeYes?: boolean;
    requiresTtyErrorCode: string;
    typedAckRequiredErrorCode: string;
  },
): Promise<void> {
  await confirmSharedTypedAcknowledgement(prompter, {
    assumeYes: options.assumeYes,
    expected,
    prompt,
    errorCode,
    requiresTtyErrorCode: options.requiresTtyErrorCode,
    typedAckRequiredErrorCode: options.typedAckRequiredErrorCode,
  });
}

async function confirmReputationMutation(
  prompter: WalletPrompter,
  options: {
    kind: "give" | "revoke";
    sourceDomainName: string;
    targetDomainName: string;
    amountCogtoshi: bigint;
    reviewText: string | null;
    resolved: ReputationResolvedSummary;
    assumeYes?: boolean;
  },
): Promise<void> {
  prompter.writeLine(`${options.kind === "give" ? "Giving" : "Revoking"} reputation from "${options.sourceDomainName}" to "${options.targetDomainName}".`);
  prompter.writeLine(`Resolved sender: ${options.resolved.sender.selector} (${options.resolved.sender.address})`);
  prompter.writeLine(`Burn amount: ${formatCogAmount(options.amountCogtoshi)}`);
  prompter.writeLine(`Effect: ${describeReputationEffect(options.resolved.effect)}.`);
  prompter.writeLine(`Review: ${describeReputationReview(options.resolved.review)}.`);

  if (options.reviewText !== null) {
    prompter.writeLine("Warning: review text will be encoded and published publicly in the mempool and on-chain.");
  }

  if (options.kind === "give" && options.resolved.selfStake) {
    prompter.writeLine("Self-stake: yes.");
    prompter.writeLine("Warning: this is self-stake.");
    prompter.writeLine("Self-stake is irrevocable and cannot later be revoked.");
    await confirmTyped(
      prompter,
      options.sourceDomainName,
      `Type ${options.sourceDomainName} to continue: `,
      "wallet_rep_give_confirmation_rejected",
      {
        assumeYes: options.assumeYes,
        requiresTtyErrorCode: "wallet_rep_give_requires_tty",
        typedAckRequiredErrorCode: "wallet_rep_give_typed_ack_required",
      },
    );
    return;
  }

  await confirmYesNo(
    prompter,
    options.kind === "give"
      ? "This burns COG to publish a reputation commitment."
      : "This revokes visible support but the burned COG is not refunded.",
    options.kind === "give"
      ? "wallet_rep_give_confirmation_rejected"
      : "wallet_rep_revoke_confirmation_rejected",
    {
      assumeYes: options.assumeYes,
      requiresTtyErrorCode: options.kind === "give"
        ? "wallet_rep_give_requires_tty"
        : "wallet_rep_revoke_requires_tty",
    },
  );
}

async function encodeReviewText(
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

async function sendBuiltTransaction(options: {
  rpc: ReputationRpcClient;
  walletName: string;
  snapshotHeight: number | null;
  built: BuiltReputationTransaction;
  mutation: PendingMutationRecord;
  state: WalletStateV1;
  provider: WalletSecretProvider;
  unlockUntilUnixMs: number;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
  errorPrefix: string;
}): Promise<{
  state: WalletStateV1;
  mutation: PendingMutationRecord;
}> {
  let nextState = options.state;
  const broadcasting = updateMutationRecord(options.mutation, "broadcasting", options.nowUnixMs, {
    attemptedTxid: options.built.txid,
    attemptedWtxid: options.built.wtxid,
    temporaryBuilderLockedOutpoints: options.built.temporaryBuilderLockedOutpoints,
  });
  nextState = upsertPendingMutation(nextState, broadcasting);
  nextState = await saveUpdatedMutationState({
    state: nextState,
    provider: options.provider,
    unlockUntilUnixMs: options.unlockUntilUnixMs,
    nowUnixMs: options.nowUnixMs,
    paths: options.paths,
  });

  if (options.snapshotHeight !== null && options.snapshotHeight !== (await options.rpc.getBlockchainInfo()).blocks) {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.built.temporaryBuilderLockedOutpoints);
    throw new Error(`${options.errorPrefix}_tip_mismatch`);
  }

  try {
    await options.rpc.sendRawTransaction(options.built.rawHex);
  } catch (error) {
    if (!isAlreadyAcceptedError(error)) {
      if (isBroadcastUnknownError(error)) {
        const unknown = updateMutationRecord(broadcasting, "broadcast-unknown", options.nowUnixMs, {
          attemptedTxid: options.built.txid,
          attemptedWtxid: options.built.wtxid,
          temporaryBuilderLockedOutpoints: options.built.temporaryBuilderLockedOutpoints,
        });
        nextState = upsertPendingMutation(nextState, unknown);
        nextState = await saveUpdatedMutationState({
          state: nextState,
          provider: options.provider,
          unlockUntilUnixMs: options.unlockUntilUnixMs,
          nowUnixMs: options.nowUnixMs,
          paths: options.paths,
        });
        throw new Error(`${options.errorPrefix}_broadcast_unknown`);
      }

      await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.built.temporaryBuilderLockedOutpoints);
      const canceled = updateMutationRecord(broadcasting, "canceled", options.nowUnixMs, {
        attemptedTxid: options.built.txid,
        attemptedWtxid: options.built.wtxid,
        temporaryBuilderLockedOutpoints: [],
      });
      nextState = upsertPendingMutation(nextState, canceled);
      nextState = await saveUpdatedMutationState({
        state: nextState,
        provider: options.provider,
        unlockUntilUnixMs: options.unlockUntilUnixMs,
        nowUnixMs: options.nowUnixMs,
        paths: options.paths,
      });
      throw error;
    }
  }

  await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.built.temporaryBuilderLockedOutpoints);
  const live = updateMutationRecord(broadcasting, "live", options.nowUnixMs, {
    attemptedTxid: options.built.txid,
    attemptedWtxid: options.built.wtxid,
    temporaryBuilderLockedOutpoints: [],
  });
  nextState = upsertPendingMutation(nextState, live);
  nextState = await saveUpdatedMutationState({
    state: nextState,
    provider: options.provider,
    unlockUntilUnixMs: options.unlockUntilUnixMs,
    nowUnixMs: options.nowUnixMs,
    paths: options.paths,
  });
  return { state: nextState, mutation: live };
}

async function submitReputationMutation(options: ReputationBaseOptions & {
  kind: ReputationMutationKind;
  errorPrefix: string;
}): Promise<ReputationMutationResult> {
  if (!options.prompter.isInteractive && options.assumeYes !== true) {
    throw new Error(`${options.errorPrefix}_requires_tty`);
  }

  if (options.amountCogtoshi <= 0n) {
    throw new Error(`${options.errorPrefix}_invalid_amount`);
  }

  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const controlLock = await acquireFileLock(paths.walletControlLockPath, {
    purpose: options.errorPrefix,
    walletRootId: null,
  });

  try {
    const miningPreemption = await pauseMiningForWalletMutation({
      paths,
      reason: options.errorPrefix,
    });
    const readContext = await (options.openReadContext ?? openWalletReadContext)({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      secretProvider: provider,
      walletControlLockHeld: true,
      paths,
    });

    try {
      const normalizedSourceDomainName = normalizeDomainName(options.sourceDomainName, `${options.errorPrefix}_missing_source_domain`);
      const normalizedTargetDomainName = normalizeDomainName(options.targetDomainName, `${options.errorPrefix}_missing_target_domain`);
      const operation = resolveReputationOperation(
        readContext,
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

      const review = await encodeReviewText(options.reviewText, options.errorPrefix);
      const selfStake = operation.sourceDomain.domainId === operation.targetDomain.domainId;
      const resolved = createResolvedReputationSummary({
        kind: options.kind === "rep-give" ? "give" : "revoke",
        sender: operation.sender,
        senderSelector: operation.senderSelector,
        amountCogtoshi: options.amountCogtoshi,
        review,
        selfStake,
      });
      const intentFingerprintHex = createIntentFingerprint([
        options.kind,
        operation.state.walletRootId,
        operation.sourceDomain.name,
        operation.targetDomain.name,
        options.amountCogtoshi,
        review.payloadHex ?? "",
      ]);

      const node = await (options.attachService ?? attachOrStartManagedBitcoindService)({
        dataDir: options.dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: operation.state.walletRootId,
      });
      const rpc = (options.rpcFactory ?? createRpcClient)(node.rpc);
      const walletName = operation.state.managedCoreWallet.walletName;
      const existingMutation = findPendingMutationByIntent(operation.state, intentFingerprintHex);

      if (existingMutation !== null) {
        const reconciled = await reconcilePendingReputationMutation({
          state: operation.state,
          mutation: existingMutation,
          provider,
          unlockUntilUnixMs: operation.unlockUntilUnixMs,
          nowUnixMs,
          paths,
          rpc,
          walletName,
          context: readContext,
        });

        if (reconciled.resolution === "confirmed" || reconciled.resolution === "live") {
          return {
            kind: options.kind === "rep-give" ? "give" : "revoke",
            sourceDomainName: normalizedSourceDomainName,
            targetDomainName: normalizedTargetDomainName,
            amountCogtoshi: options.amountCogtoshi,
            txid: reconciled.mutation.attemptedTxid ?? "unknown",
            status: reconciled.resolution,
            reusedExisting: true,
            reviewIncluded: review.payloadHex !== null,
            resolved,
          };
        }

        if (reconciled.resolution === "repair-required") {
          throw new Error(`${options.errorPrefix}_repair_required`);
        }
      }

      await confirmReputationMutation(options.prompter, {
        kind: options.kind === "rep-give" ? "give" : "revoke",
        sourceDomainName: normalizedSourceDomainName,
        targetDomainName: normalizedTargetDomainName,
        amountCogtoshi: options.amountCogtoshi,
        reviewText: review.text,
        resolved,
        assumeYes: options.assumeYes,
      });

      let nextState = upsertPendingMutation(
        operation.state,
        createDraftMutation({
          kind: options.kind,
          sourceDomainName: normalizedSourceDomainName,
          targetDomainName: normalizedTargetDomainName,
          amountCogtoshi: options.amountCogtoshi,
          sender: operation.sender,
          intentFingerprintHex,
          nowUnixMs,
          reviewPayloadHex: review.payloadHex,
          existing: existingMutation,
        }),
      );
      nextState = await saveUpdatedMutationState({
        state: nextState,
        provider,
        unlockUntilUnixMs: operation.unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      const opReturnData = options.kind === "rep-give"
        ? serializeRepCommit(
          operation.sourceDomain.domainId,
          operation.targetDomain.domainId,
          options.amountCogtoshi,
          review.payload,
        ).opReturnData
        : serializeRepRevoke(
          operation.sourceDomain.domainId,
          operation.targetDomain.domainId,
          options.amountCogtoshi,
          review.payload,
        ).opReturnData;
      const built = await buildTransaction({
        rpc,
        walletName,
        state: nextState,
        plan: buildPlanForReputationOperation({
          state: nextState,
          allUtxos: await rpc.listUnspent(walletName, 1),
          sender: operation.sender,
          anchorOutpoint: operation.anchorOutpoint,
          opReturnData,
          errorPrefix: options.errorPrefix,
        }),
      });

      const final = await sendBuiltTransaction({
        rpc,
        walletName,
        snapshotHeight: readContext.snapshot?.tip?.height ?? null,
        built,
        mutation: nextState.pendingMutations!.find((mutation) => mutation.intentFingerprintHex === intentFingerprintHex)!,
        state: nextState,
        provider,
        unlockUntilUnixMs: operation.unlockUntilUnixMs,
        nowUnixMs,
        paths,
        errorPrefix: options.errorPrefix,
      });

      return {
        kind: options.kind === "rep-give" ? "give" : "revoke",
        sourceDomainName: normalizedSourceDomainName,
        targetDomainName: normalizedTargetDomainName,
        amountCogtoshi: options.amountCogtoshi,
        txid: final.mutation.attemptedTxid ?? built.txid,
        status: "live",
        reusedExisting: false,
        reviewIncluded: review.payloadHex !== null,
        resolved,
      };
    } finally {
      await readContext.close();
      await miningPreemption.release();
    }
  } finally {
    await controlLock.release();
  }
}

export async function giveReputation(
  options: GiveReputationOptions,
): Promise<ReputationMutationResult> {
  return submitReputationMutation({
    ...options,
    kind: "rep-give",
    errorPrefix: "wallet_rep_give",
  });
}

export async function revokeReputation(
  options: RevokeReputationOptions,
): Promise<ReputationMutationResult> {
  return submitReputationMutation({
    ...options,
    kind: "rep-revoke",
    errorPrefix: "wallet_rep_revoke",
  });
}
