import { createHash, randomBytes } from "node:crypto";

import { getBalance, getLock, lookupDomain } from "@cogcoin/indexer/queries";

import { attachOrStartManagedBitcoindService } from "../../bitcoind/service.js";
import { createRpcClient } from "../../bitcoind/node.js";
import type {
  RpcDecodedPsbt,
  RpcListUnspentEntry,
  RpcTransaction,
} from "../../bitcoind/types.js";
import type { WalletPrompter } from "../lifecycle.js";
import { type WalletRuntimePaths } from "../runtime.js";
import {
  type WalletSecretProvider,
} from "../state/provider.js";
import type {
  PendingMutationRecord,
  WalletStateV1,
} from "../types.js";
import {
  serializeCogClaim,
  serializeCogLock,
  serializeCogTransfer,
} from "../cogop/index.js";
import { openWalletReadContext, type WalletReadContext } from "../read/index.js";
import {
  assertFixedInputPrefixMatches,
  assertFundingInputsAfterFixedPrefix,
  assertWalletMutationContextReady,
  buildWalletMutationTransactionWithReserveFallback,
  createFundingMutationSender,
  createWalletMutationFeeMetadata,
  formatCogAmount,
  getDecodedInputScriptPubKeyHex,
  isLocalWalletScript,
  mergeFixedWalletInputs,
  outpointKey,
  saveWalletStatePreservingUnlock,
  unlockTemporaryBuilderLocks,
  updateMutationRecord,
  type BuiltWalletMutationTransaction,
  type FixedWalletInput,
  type MutationSender,
  type WalletMutationFeeSummary,
  type WalletMutationRpcClient,
} from "./common.js";
import { confirmTypedAcknowledgement, confirmYesNo } from "./confirm.js";
import {
  executeWalletMutationOperation,
  publishWalletMutation,
  resolveExistingWalletMutation,
} from "./executor.js";
import {
  getCanonicalIdentitySelector,
  resolveIdentityBySelector,
} from "./identity-selector.js";
import { upsertPendingMutation } from "./journal.js";
import { normalizeBtcTarget } from "./targets.js";

const MAX_LOCK_DURATION_BLOCKS = 262_800;
const ZERO_PREIMAGE_HEX = "00".repeat(32);

type CogMutationKind = "send" | "lock" | "claim";

interface WalletCogRpcClient extends WalletMutationRpcClient {
  getBlockchainInfo(): Promise<{ blocks: number }>;
  sendRawTransaction(hex: string): Promise<string>;
  getRawTransaction(txid: string, verbose?: boolean): Promise<RpcTransaction>;
}

interface CogMutationPlan {
  sender: MutationSender;
  changeAddress: string;
  fixedInputs: FixedWalletInput[];
  outputs: unknown[];
  changePosition: number;
  expectedOpReturnScriptHex: string;
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
  errorPrefix: string;
}

type BuiltCogMutationTransaction = BuiltWalletMutationTransaction;

interface SendCogOperation {
  state: WalletStateV1;
  sender: MutationSender;
  resolved: CogResolvedSummary;
  amountCogtoshi: bigint;
  recipient: ReturnType<typeof normalizeBtcTarget>;
}

interface LockCogMutationOperation {
  state: WalletStateV1;
  sender: MutationSender;
  resolved: CogResolvedSummary;
  amountCogtoshi: bigint;
  normalizedRecipientDomainName: string;
  recipientDomain: NonNullable<ReturnType<typeof lookupDomain>>;
  timeoutHeight: number;
  conditionHex: string;
}

interface ClaimCogMutationOperation {
  state: WalletStateV1;
  sender: MutationSender;
  resolved: CogResolvedSummary;
  amountCogtoshi: bigint;
  recipientDomainName: string | null;
  lockId: number;
  preimageHex: string;
  errorPrefix: string;
}

export type CogResolvedClaimPath = "recipient-claim" | "timeout-reclaim";

export interface CogResolvedSenderSummary {
  selector: string;
  localIndex: number;
  scriptPubKeyHex: string;
  address: string;
}

export interface CogResolvedSummary {
  sender: CogResolvedSenderSummary;
  claimPath: CogResolvedClaimPath | null;
}

export interface CogMutationResult {
  kind: CogMutationKind;
  txid: string;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  amountCogtoshi?: bigint;
  recipientScriptPubKeyHex?: string | null;
  recipientDomainName?: string | null;
  lockId?: number | null;
  resolved: CogResolvedSummary;
  fees: WalletMutationFeeSummary;
}

export interface SendCogOptions {
  amountCogtoshi: bigint;
  target: string;
  fromIdentity?: string | null;
  feeRateSatVb?: number | null;
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  assumeYes?: boolean;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletCogRpcClient;
}

export interface LockCogToDomainOptions {
  amountCogtoshi: bigint;
  recipientDomainName: string;
  fromIdentity?: string | null;
  feeRateSatVb?: number | null;
  timeoutHeight?: number | null;
  timeoutBlocksOrDuration?: string | null;
  conditionHex: string;
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  assumeYes?: boolean;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletCogRpcClient;
}

export interface ClaimCogLockOptions {
  lockId: number;
  preimageHex: string;
  feeRateSatVb?: number | null;
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  assumeYes?: boolean;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletCogRpcClient;
}

export interface ReclaimCogLockOptions extends Omit<ClaimCogLockOptions, "preimageHex"> {}

function normalizeDomainName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("wallet_cog_missing_domain");
  }
  return normalized;
}

function normalizePositiveAmount(amountCogtoshi: bigint, errorCode: string): bigint {
  if (amountCogtoshi <= 0n) {
    throw new Error(errorCode);
  }
  return amountCogtoshi;
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
    throw new Error(`wallet_cog_invalid_amount_${text}`);
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

function parseHex32(value: string, errorCode: string): Buffer {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(errorCode);
  }
  return Buffer.from(normalized, "hex");
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function ensureUsableSender(
  sender: ReturnType<typeof resolveIdentityBySelector>,
  errorPrefix: string,
  amountCogtoshi: bigint,
): void {
  if (sender.address === null) {
    throw new Error(`${errorPrefix}_sender_address_unavailable`);
  }

  if (sender.readOnly) {
    throw new Error(`${errorPrefix}_sender_read_only`);
  }

  if (sender.observedCogBalance === null || sender.observedCogBalance < amountCogtoshi) {
    throw new Error(`${errorPrefix}_insufficient_cog_balance`);
  }
}

function createResolvedSenderSummary(
  identity: ReturnType<typeof resolveIdentityBySelector>,
): CogResolvedSenderSummary {
  return {
    selector: getCanonicalIdentitySelector(identity),
    localIndex: identity.index,
    scriptPubKeyHex: identity.scriptPubKeyHex,
    address: identity.address!,
  };
}

function resolveIdentitySender(
  context: WalletReadContext,
  errorPrefix: string,
  amountCogtoshi: bigint,
  selector: string | null | undefined,
): {
  state: WalletStateV1;
  sender: MutationSender;
  resolved: CogResolvedSummary;
} {
  assertWalletMutationContextReady(context, errorPrefix);
  const identity = resolveIdentityBySelector(
    context,
    selector ?? context.model.walletAddress ?? "",
    errorPrefix,
  );
  ensureUsableSender(identity, errorPrefix, amountCogtoshi);

  return {
    state: context.localState.state,
    sender: createFundingMutationSender(context.localState.state),
    resolved: {
      sender: createResolvedSenderSummary(identity),
      claimPath: null,
    },
  };
}

function resolveClaimSender(
  context: WalletReadContext,
  lockId: number,
  preimageHex: string,
  reclaim: boolean,
): {
  state: WalletStateV1;
  sender: MutationSender;
  recipientDomainName: string | null;
  amountCogtoshi: bigint;
  lockId: number;
  resolved: CogResolvedSummary;
} {
  const errorPrefix = reclaim ? "wallet_reclaim" : "wallet_claim";
  assertWalletMutationContextReady(context, errorPrefix);
  const currentHeight = context.snapshot.state.history.currentHeight;
  if (currentHeight === null) {
    throw new Error(`${errorPrefix}_current_height_unavailable`);
  }

  const lock = getLock(context.snapshot.state, lockId);
  if (lock === null || lock.status !== "active") {
    throw new Error(`${errorPrefix}_lock_not_found`);
  }

  const recipientDomain = lookupDomain(context.snapshot.state, context.model.domains.find((domain) => domain.domainId === lock.recipientDomainId)?.name ?? "")
    ?? [...context.snapshot.state.consensus.domainsById.values()].find((entry) => entry.domainId === lock.recipientDomainId)
    ?? null;
  const recipientDomainName = recipientDomain?.name ?? null;

  if (reclaim) {
    if (currentHeight < lock.timeoutHeight) {
      throw new Error("wallet_reclaim_before_timeout");
    }

    const lockerHex = Buffer.from(lock.lockerScriptPubKey).toString("hex");
    if (lockerHex !== context.localState.state.funding.scriptPubKeyHex || context.model.walletAddress == null) {
      throw new Error("wallet_reclaim_sender_not_local");
    }
    const senderIdentity = resolveIdentityBySelector(context, context.model.walletAddress, errorPrefix);
    ensureUsableSender(senderIdentity, errorPrefix, 0n);

    return {
      state: context.localState.state,
      sender: createFundingMutationSender(context.localState.state),
      recipientDomainName,
      amountCogtoshi: lock.amount,
      lockId: lock.lockId,
      resolved: {
        sender: createResolvedSenderSummary(senderIdentity),
        claimPath: "timeout-reclaim",
      },
    };
  }

  if (currentHeight >= lock.timeoutHeight) {
    throw new Error("wallet_claim_lock_expired");
  }

  const preimage = parseHex32(preimageHex, "wallet_claim_invalid_preimage");
  if (sha256Hex(preimage) !== Buffer.from(lock.condition).toString("hex")) {
    throw new Error("wallet_claim_preimage_mismatch");
  }

  if (recipientDomain === null) {
    throw new Error("wallet_claim_recipient_domain_missing");
  }

  const recipientOwnerHex = Buffer.from(recipientDomain.ownerScriptPubKey).toString("hex");
  if (recipientOwnerHex !== context.localState.state.funding.scriptPubKeyHex || context.model.walletAddress == null) {
    throw new Error("wallet_claim_sender_not_local");
  }
  const senderIdentity = resolveIdentityBySelector(context, context.model.walletAddress, errorPrefix);
  ensureUsableSender(senderIdentity, errorPrefix, 0n);

  return {
    state: context.localState.state,
    sender: createFundingMutationSender(context.localState.state),
    recipientDomainName,
    amountCogtoshi: lock.amount,
    lockId: lock.lockId,
    resolved: {
      sender: createResolvedSenderSummary(senderIdentity),
      claimPath: "recipient-claim",
    },
  };
}

function parseTimeoutHeight(
  currentHeight: number,
  rawRelative: string | null | undefined,
  rawAbsolute: number | null | undefined,
): number {
  if ((rawRelative == null) === (rawAbsolute == null)) {
    throw new Error("wallet_lock_timeout_requires_exactly_one_mode");
  }

  if (rawAbsolute != null) {
    if (!Number.isInteger(rawAbsolute)) {
      throw new Error("wallet_lock_invalid_timeout_height");
    }
    return rawAbsolute;
  }

  const trimmed = rawRelative!.trim().toLowerCase();
  let blocks: number;

  if (/^[1-9]\d*$/.test(trimmed)) {
    blocks = Number.parseInt(trimmed, 10);
  } else {
    const match = /^(\d+)(m|h|d|w)$/.exec(trimmed);
    if (match == null) {
      throw new Error("wallet_lock_invalid_timeout_duration");
    }

    const value = Number.parseInt(match[1]!, 10);
    const minutesPerUnit = match[2] === "m" ? 1
      : match[2] === "h" ? 60
      : match[2] === "d" ? 24 * 60
      : 7 * 24 * 60;
    blocks = Math.ceil((value * minutesPerUnit) / 10);
  }

  return currentHeight + blocks;
}

function buildPlanForCogOperation(options: {
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  sender: MutationSender;
  opReturnData: Uint8Array;
  errorPrefix: string;
}): CogMutationPlan {
  const fundingUtxos = options.allUtxos.filter((entry) =>
    entry.scriptPubKey === options.state.funding.scriptPubKeyHex
    && entry.confirmations >= 1
    && entry.spendable !== false
    && entry.safe !== false
  );
  return {
    sender: options.sender,
    changeAddress: options.state.funding.address,
    fixedInputs: [],
    outputs: [{ data: Buffer.from(options.opReturnData).toString("hex") }],
    changePosition: 1,
    expectedOpReturnScriptHex: encodeOpReturnScript(options.opReturnData),
    allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    eligibleFundingOutpointKeys: new Set(fundingUtxos.map((entry) => outpointKey({ txid: entry.txid, vout: entry.vout }))),
    errorPrefix: options.errorPrefix,
  };
}

function validateFundedDraft(
  decoded: RpcDecodedPsbt,
  funded: BuiltCogMutationTransaction["funded"],
  plan: CogMutationPlan,
): void {
  const inputs = decoded.tx.vin;
  const outputs = decoded.tx.vout;

  if (inputs.length === 0) {
    throw new Error(`${plan.errorPrefix}_missing_sender_input`);
  }

  if (outputs[0]?.scriptPubKey?.hex !== plan.expectedOpReturnScriptHex) {
    throw new Error(`${plan.errorPrefix}_opreturn_mismatch`);
  }

  const expectedWithoutChange = 1;
  if (funded.changepos === -1) {
    if (outputs.length !== expectedWithoutChange) {
      throw new Error(`${plan.errorPrefix}_unexpected_output_count`);
    }
    return;
  }

  if (funded.changepos !== plan.changePosition || outputs.length !== expectedWithoutChange + 1) {
    throw new Error(`${plan.errorPrefix}_change_position_mismatch`);
  }

  if (outputs[funded.changepos]?.scriptPubKey?.hex !== plan.allowedFundingScriptPubKeyHex) {
    throw new Error(`${plan.errorPrefix}_change_output_mismatch`);
  }
}

async function buildTransaction(options: {
  rpc: WalletCogRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: CogMutationPlan;
  feeRateSatVb: number;
}): Promise<BuiltCogMutationTransaction> {
  return buildWalletMutationTransactionWithReserveFallback({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
    plan: options.plan,
    validateFundedDraft,
    finalizeErrorCode: `${options.plan.errorPrefix}_finalize_failed`,
    mempoolRejectPrefix: `${options.plan.errorPrefix}_mempool_rejected`,
    feeRate: options.feeRateSatVb,
  });
}

function createDraftMutation(options: {
  kind: CogMutationKind;
  sender: MutationSender;
  intentFingerprintHex: string;
  nowUnixMs: number;
  feeSelection: {
    feeRateSatVb: number;
    source: "custom-satvb" | "estimated-next-block-plus-one" | "fallback-default";
  };
  domainName?: string | null;
  recipientScriptPubKeyHex?: string | null;
  recipientDomainName?: string | null;
  amountCogtoshi?: bigint | null;
  timeoutHeight?: number | null;
  conditionHex?: string | null;
  lockId?: number | null;
  preimageHex?: string | null;
  existing?: PendingMutationRecord | null;
}): PendingMutationRecord {
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

async function reconcilePendingCogMutation(options: {
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

async function confirmSend(
  prompter: WalletPrompter,
  resolved: CogResolvedSummary,
  target: string,
  normalizedRecipient: { scriptPubKeyHex: string; address: string | null; opaque: boolean },
  amountCogtoshi: bigint,
  assumeYes = false,
): Promise<void> {
  prompter.writeLine(`You are sending ${formatCogAmount(amountCogtoshi)}.`);
  prompter.writeLine(`Resolved sender: ${resolved.sender.selector} (${resolved.sender.address})`);
  prompter.writeLine(`Recipient: ${normalizedRecipient.address ?? `spk:${normalizedRecipient.scriptPubKeyHex}`}`);
  if (normalizedRecipient.opaque) {
    await confirmTypedAcknowledgement(prompter, {
      assumeYes,
      expected: target.trim(),
      prompt: "Type the exact target to continue: ",
      errorCode: "wallet_send_confirmation_rejected",
      requiresTtyErrorCode: "wallet_send_requires_tty",
      typedAckRequiredErrorCode: "wallet_send_typed_ack_required",
    });
    return;
  }
  await confirmYesNo(prompter, "This will publish an on-chain COG transfer.", {
    assumeYes,
    errorCode: "wallet_send_confirmation_rejected",
    requiresTtyErrorCode: "wallet_send_requires_tty",
  });
}

async function confirmLock(
  prompter: WalletPrompter,
  resolved: CogResolvedSummary,
  amountCogtoshi: bigint,
  recipientDomainName: string,
  timeoutHeight: number,
  assumeYes = false,
): Promise<void> {
  prompter.writeLine(`You are locking ${formatCogAmount(amountCogtoshi)}.`);
  prompter.writeLine(`Resolved sender: ${resolved.sender.selector} (${resolved.sender.address})`);
  prompter.writeLine(`Recipient domain: ${recipientDomainName}`);
  prompter.writeLine(`Resolved timeout height: ${timeoutHeight}`);
  await confirmYesNo(prompter, "This creates an escrowed COG lock and the funds cannot be spent until claimed or reclaimed.", {
    assumeYes,
    errorCode: "wallet_mutation_confirmation_rejected",
    requiresTtyErrorCode: "wallet_lock_requires_tty",
  });
}

async function confirmClaim(
  prompter: WalletPrompter,
  options: {
    kind: "claim" | "reclaim";
    lockId: number;
    recipientDomainName: string | null;
    amountCogtoshi: bigint;
    resolved: CogResolvedSummary;
  } & { assumeYes?: boolean },
): Promise<void> {
  prompter.writeLine(`${options.kind === "claim" ? "Claiming" : "Reclaiming"} lock:${options.lockId} for ${formatCogAmount(options.amountCogtoshi)}.`);
  prompter.writeLine(`Resolved sender: ${options.resolved.sender.selector} (${options.resolved.sender.address})`);
  if (options.resolved.claimPath !== null) {
    prompter.writeLine(`Resolved path: ${options.resolved.claimPath}.`);
  }
  if (options.recipientDomainName !== null) {
    prompter.writeLine(`Recipient domain: ${options.recipientDomainName}`);
  }
  if (options.kind === "claim") {
    prompter.writeLine("Warning: the claim preimage becomes public in the mempool and on-chain.");
  }
  await confirmYesNo(prompter, options.kind === "claim"
    ? "This spends the lock via the recipient claim path."
    : "This spends the lock via the timeout reclaim path.", {
    assumeYes: options.assumeYes,
    errorCode: options.kind === "claim"
      ? "wallet_claim_confirmation_rejected"
      : "wallet_reclaim_confirmation_rejected",
    requiresTtyErrorCode: options.kind === "claim"
      ? "wallet_claim_requires_tty"
      : "wallet_reclaim_requires_tty",
  });
}

export async function sendCog(options: SendCogOptions): Promise<CogMutationResult> {
  const amountCogtoshi = normalizePositiveAmount(options.amountCogtoshi, "wallet_send_invalid_amount");
  const recipient = normalizeBtcTarget(options.target);
  const execution = await executeWalletMutationOperation<
    SendCogOperation,
    WalletCogRpcClient,
    null,
    BuiltCogMutationTransaction,
    CogMutationResult
  >({
    ...options,
    controlLockPurpose: "wallet-send",
    preemptionReason: "wallet-send",
    resolveOperation(readContext) {
      const operation = resolveIdentitySender(readContext, "wallet_send", amountCogtoshi, options.fromIdentity);
      if (operation.sender.scriptPubKeyHex === recipient.scriptPubKeyHex) {
        throw new Error("wallet_send_self_transfer");
      }
      return {
        ...operation,
        amountCogtoshi,
        recipient,
      };
    },
    createIntentFingerprint(operation) {
      return createIntentFingerprint([
        "send",
        operation.state.walletRootId,
        operation.sender.scriptPubKeyHex,
        operation.recipient.scriptPubKeyHex,
        operation.amountCogtoshi,
      ]);
    },
    async resolveExistingMutation({ operation, existingMutation, execution }) {
      if (existingMutation === null) {
        return { state: operation.state, replacementFixedInputs: null, result: null };
      }
      return resolveExistingWalletMutation({
        existingMutation,
        execution,
        repairRequiredErrorCode: "wallet_send_repair_required",
        reconcileExistingMutation: (mutation) => reconcilePendingCogMutation({
          state: operation.state,
          mutation,
          provider: execution.provider,
          nowUnixMs: execution.nowUnixMs,
          paths: execution.paths,
          rpc: execution.rpc,
          walletName: execution.walletName,
          context: execution.readContext,
        }),
        createReuseResult: ({ mutation, resolution, fees }) => ({
          kind: "send",
          txid: mutation.attemptedTxid ?? "unknown",
          status: resolution,
          reusedExisting: true,
          amountCogtoshi: operation.amountCogtoshi,
          recipientScriptPubKeyHex: operation.recipient.scriptPubKeyHex,
          resolved: operation.resolved,
          fees,
        }),
      });
    },
    confirm({ operation }) {
      return confirmSend(
        options.prompter,
        operation.resolved,
        options.target,
        operation.recipient,
        operation.amountCogtoshi,
        options.assumeYes,
      );
    },
    createDraftMutation({ operation, existingMutation, execution, intentFingerprintHex }) {
      return {
        mutation: createDraftMutation({
          kind: "send",
          sender: operation.sender,
          recipientScriptPubKeyHex: operation.recipient.scriptPubKeyHex,
          amountCogtoshi: operation.amountCogtoshi,
          intentFingerprintHex,
          nowUnixMs: execution.nowUnixMs,
          feeSelection: execution.feeSelection,
          existing: existingMutation,
        }),
        prepared: null,
      };
    },
    async build({ operation, state, execution, replacementFixedInputs }) {
      const sendPlan = buildPlanForCogOperation({
        state,
        allUtxos: await execution.rpc.listUnspent(execution.walletName, 1),
        sender: operation.sender,
        opReturnData: serializeCogTransfer(
          operation.amountCogtoshi,
          Buffer.from(operation.recipient.scriptPubKeyHex, "hex"),
        ).opReturnData,
        errorPrefix: "wallet_send",
      });
      return buildTransaction({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        plan: {
          ...sendPlan,
          fixedInputs: mergeFixedWalletInputs(sendPlan.fixedInputs, replacementFixedInputs),
        },
        feeRateSatVb: execution.feeSelection.feeRateSatVb,
      });
    },
    publish({ state, execution, built, mutation }) {
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
        errorPrefix: "wallet_send",
      });
    },
    createResult({ operation, mutation, built, status, reusedExisting, fees }) {
      return {
        kind: "send",
        txid: mutation.attemptedTxid ?? built?.txid ?? "unknown",
        status: status as CogMutationResult["status"],
        reusedExisting,
        amountCogtoshi: operation.amountCogtoshi,
        recipientScriptPubKeyHex: operation.recipient.scriptPubKeyHex,
        resolved: operation.resolved,
        fees,
      };
    },
  });

  return execution.result;
}

export async function lockCogToDomain(options: LockCogToDomainOptions): Promise<CogMutationResult> {
  const amountCogtoshi = normalizePositiveAmount(options.amountCogtoshi, "wallet_lock_invalid_amount");
  const normalizedRecipientDomainName = normalizeDomainName(options.recipientDomainName);
  const condition = parseHex32(options.conditionHex, "wallet_lock_invalid_condition");
  if (condition.equals(Buffer.alloc(32))) {
    throw new Error("wallet_lock_invalid_condition");
  }
  const execution = await executeWalletMutationOperation<
    LockCogMutationOperation,
    WalletCogRpcClient,
    null,
    BuiltCogMutationTransaction,
    CogMutationResult
  >({
    ...options,
    controlLockPurpose: "wallet-lock-cog",
    preemptionReason: "wallet-cog-lock",
    resolveOperation(readContext) {
      assertWalletMutationContextReady(readContext, "wallet_lock");
      const currentHeight = readContext.snapshot.state.history.currentHeight;
      if (currentHeight === null) {
        throw new Error("wallet_lock_current_height_unavailable");
      }

      const timeoutHeight = parseTimeoutHeight(currentHeight, options.timeoutBlocksOrDuration, options.timeoutHeight ?? null);
      if (timeoutHeight <= currentHeight || timeoutHeight > currentHeight + MAX_LOCK_DURATION_BLOCKS) {
        throw new Error("wallet_lock_invalid_timeout_height");
      }

      const recipientDomain = lookupDomain(readContext.snapshot.state, normalizedRecipientDomainName);
      if (recipientDomain === null) {
        throw new Error("wallet_lock_domain_not_found");
      }
      if (!recipientDomain.anchored) {
        throw new Error("wallet_lock_domain_not_anchored");
      }
      if (readContext.snapshot.state.consensus.nextLockId === 0xffff_ffff) {
        throw new Error("wallet_lock_id_space_exhausted");
      }

      return {
        ...resolveIdentitySender(readContext, "wallet_lock", amountCogtoshi, options.fromIdentity),
        amountCogtoshi,
        normalizedRecipientDomainName,
        recipientDomain,
        timeoutHeight,
        conditionHex: Buffer.from(condition).toString("hex"),
      };
    },
    createIntentFingerprint(operation) {
      return createIntentFingerprint([
        "lock",
        operation.state.walletRootId,
        operation.sender.scriptPubKeyHex,
        operation.normalizedRecipientDomainName,
        operation.amountCogtoshi,
        operation.timeoutHeight,
        operation.conditionHex,
      ]);
    },
    async resolveExistingMutation({ operation, existingMutation, execution }) {
      if (existingMutation === null) {
        return { state: operation.state, replacementFixedInputs: null, result: null };
      }
      return resolveExistingWalletMutation({
        existingMutation,
        execution,
        repairRequiredErrorCode: "wallet_lock_repair_required",
        reconcileExistingMutation: (mutation) => reconcilePendingCogMutation({
          state: operation.state,
          mutation,
          provider: execution.provider,
          nowUnixMs: execution.nowUnixMs,
          paths: execution.paths,
          rpc: execution.rpc,
          walletName: execution.walletName,
          context: execution.readContext,
        }),
        createReuseResult: ({ mutation, resolution, fees }) => ({
          kind: "lock",
          txid: mutation.attemptedTxid ?? "unknown",
          status: resolution,
          reusedExisting: true,
          amountCogtoshi: operation.amountCogtoshi,
          recipientDomainName: operation.normalizedRecipientDomainName,
          resolved: operation.resolved,
          fees,
        }),
      });
    },
    confirm({ operation }) {
      return confirmLock(
        options.prompter,
        operation.resolved,
        operation.amountCogtoshi,
        operation.normalizedRecipientDomainName,
        operation.timeoutHeight,
        options.assumeYes,
      );
    },
    createDraftMutation({ operation, existingMutation, execution, intentFingerprintHex }) {
      return {
        mutation: createDraftMutation({
          kind: "lock",
          sender: operation.sender,
          amountCogtoshi: operation.amountCogtoshi,
          recipientDomainName: operation.normalizedRecipientDomainName,
          timeoutHeight: operation.timeoutHeight,
          conditionHex: operation.conditionHex,
          intentFingerprintHex,
          nowUnixMs: execution.nowUnixMs,
          feeSelection: execution.feeSelection,
          existing: existingMutation,
        }),
        prepared: null,
      };
    },
    async build({ operation, state, execution, replacementFixedInputs }) {
      const lockPlan = buildPlanForCogOperation({
        state,
        allUtxos: await execution.rpc.listUnspent(execution.walletName, 1),
        sender: operation.sender,
        opReturnData: serializeCogLock(
          operation.amountCogtoshi,
          operation.timeoutHeight,
          operation.recipientDomain.domainId,
          Buffer.from(operation.conditionHex, "hex"),
        ).opReturnData,
        errorPrefix: "wallet_lock",
      });
      return buildTransaction({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        plan: {
          ...lockPlan,
          fixedInputs: mergeFixedWalletInputs(lockPlan.fixedInputs, replacementFixedInputs),
        },
        feeRateSatVb: execution.feeSelection.feeRateSatVb,
      });
    },
    publish({ state, execution, built, mutation }) {
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
        errorPrefix: "wallet_lock",
      });
    },
    createResult({ operation, mutation, built, status, reusedExisting, fees }) {
      return {
        kind: "lock",
        txid: mutation.attemptedTxid ?? built?.txid ?? "unknown",
        status: status as CogMutationResult["status"],
        reusedExisting,
        amountCogtoshi: operation.amountCogtoshi,
        recipientDomainName: operation.normalizedRecipientDomainName,
        resolved: operation.resolved,
        fees,
      };
    },
  });

  return execution.result;
}

async function runClaimLikeMutation(
  options: ClaimCogLockOptions,
  reclaim: boolean,
): Promise<CogMutationResult> {
  const preimageHex = reclaim ? ZERO_PREIMAGE_HEX : options.preimageHex;
  const errorPrefix = reclaim ? "wallet_reclaim" : "wallet_claim";
  const execution = await executeWalletMutationOperation<
    ClaimCogMutationOperation,
    WalletCogRpcClient,
    null,
    BuiltCogMutationTransaction,
    CogMutationResult
  >({
    ...options,
    controlLockPurpose: reclaim ? "wallet-reclaim" : "wallet-claim",
    preemptionReason: reclaim ? "wallet-reclaim" : "wallet-claim",
    resolveOperation(readContext) {
      return {
        ...resolveClaimSender(readContext, options.lockId, preimageHex, reclaim),
        preimageHex,
        errorPrefix,
      };
    },
    createIntentFingerprint(operation) {
      return createIntentFingerprint([
        reclaim ? "reclaim" : "claim",
        operation.state.walletRootId,
        operation.sender.scriptPubKeyHex,
        operation.lockId,
        operation.preimageHex,
      ]);
    },
    async resolveExistingMutation({ operation, existingMutation, execution }) {
      if (existingMutation === null) {
        return { state: operation.state, replacementFixedInputs: null, result: null };
      }
      return resolveExistingWalletMutation({
        existingMutation,
        execution,
        repairRequiredErrorCode: `${errorPrefix}_repair_required`,
        reconcileExistingMutation: (mutation) => reconcilePendingCogMutation({
          state: operation.state,
          mutation,
          provider: execution.provider,
          nowUnixMs: execution.nowUnixMs,
          paths: execution.paths,
          rpc: execution.rpc,
          walletName: execution.walletName,
          context: execution.readContext,
        }),
        createReuseResult: ({ mutation, resolution, fees }) => ({
          kind: "claim",
          txid: mutation.attemptedTxid ?? "unknown",
          status: resolution,
          reusedExisting: true,
          amountCogtoshi: operation.amountCogtoshi,
          recipientDomainName: operation.recipientDomainName,
          lockId: operation.lockId,
          resolved: operation.resolved,
          fees,
        }),
      });
    },
    confirm({ operation }) {
      return confirmClaim(options.prompter, {
        kind: reclaim ? "reclaim" : "claim",
        lockId: operation.lockId,
        recipientDomainName: operation.recipientDomainName,
        amountCogtoshi: operation.amountCogtoshi,
        resolved: operation.resolved,
        assumeYes: options.assumeYes,
      });
    },
    createDraftMutation({ operation, existingMutation, execution, intentFingerprintHex }) {
      return {
        mutation: createDraftMutation({
          kind: "claim",
          sender: operation.sender,
          amountCogtoshi: operation.amountCogtoshi,
          recipientDomainName: operation.recipientDomainName,
          lockId: operation.lockId,
          preimageHex: operation.preimageHex,
          intentFingerprintHex,
          nowUnixMs: execution.nowUnixMs,
          feeSelection: execution.feeSelection,
          existing: existingMutation,
        }),
        prepared: null,
      };
    },
    async build({ operation, state, execution, replacementFixedInputs }) {
      const claimPlan = buildPlanForCogOperation({
        state,
        allUtxos: await execution.rpc.listUnspent(execution.walletName, 1),
        sender: operation.sender,
        opReturnData: serializeCogClaim(
          operation.lockId,
          Buffer.from(operation.preimageHex, "hex"),
        ).opReturnData,
        errorPrefix,
      });
      return buildTransaction({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        plan: {
          ...claimPlan,
          fixedInputs: mergeFixedWalletInputs(claimPlan.fixedInputs, replacementFixedInputs),
        },
        feeRateSatVb: execution.feeSelection.feeRateSatVb,
      });
    },
    publish({ state, execution, built, mutation }) {
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
        errorPrefix,
      });
    },
    createResult({ operation, mutation, built, status, reusedExisting, fees }) {
      return {
        kind: "claim",
        txid: mutation.attemptedTxid ?? built?.txid ?? "unknown",
        status: status as CogMutationResult["status"],
        reusedExisting,
        amountCogtoshi: operation.amountCogtoshi,
        recipientDomainName: operation.recipientDomainName,
        lockId: operation.lockId,
        resolved: operation.resolved,
        fees,
      };
    },
  });

  return execution.result;
}

export async function claimCogLock(options: ClaimCogLockOptions): Promise<CogMutationResult> {
  return runClaimLikeMutation(options, false);
}

export async function reclaimCogLock(options: ReclaimCogLockOptions): Promise<CogMutationResult> {
  return runClaimLikeMutation({
    ...options,
    preimageHex: ZERO_PREIMAGE_HEX,
  }, true);
}
