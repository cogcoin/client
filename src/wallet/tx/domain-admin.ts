import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import { lookupDomain, resolveCanonical } from "@cogcoin/indexer/queries";

import { attachOrStartManagedBitcoindService } from "../../bitcoind/service.js";
import { createRpcClient } from "../../bitcoind/node.js";
import type {
  RpcDecodedPsbt,
  RpcListUnspentEntry,
  RpcTransaction,
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
  serializeSetCanonical,
  serializeSetDelegate,
  serializeSetEndpoint,
  serializeSetMiner,
  validateDomainName,
} from "../cogop/index.js";
import { openWalletReadContext, type WalletReadContext } from "../read/index.js";
import {
  assertFixedInputPrefixMatches,
  assertFundingInputsAfterFixedPrefix,
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
  type MutationSender,
  type WalletMutationRpcClient,
} from "./common.js";
import { confirmYesNo } from "./confirm.js";
import { getCanonicalIdentitySelector } from "./identity-selector.js";
import { findPendingMutationByIntent, upsertPendingMutation } from "./journal.js";
import { normalizeBtcTarget } from "./targets.js";

type DomainAdminKind = "endpoint" | "delegate" | "miner" | "canonical";

interface DomainAdminRpcClient extends WalletMutationRpcClient {
  getBlockchainInfo(): Promise<{ blocks: number }>;
  sendRawTransaction(hex: string): Promise<string>;
  getRawTransaction(txid: string, verbose?: boolean): Promise<RpcTransaction>;
}

interface DomainAdminPlan {
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

interface DomainAdminOperation {
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
  chainDomain: NonNullable<ReturnType<typeof lookupDomain>>;
}

interface BuiltDomainAdminTransaction extends BuiltWalletMutationTransaction {}

export interface DomainAdminResolvedSenderSummary {
  selector: string;
  localIndex: number;
  scriptPubKeyHex: string;
  address: string;
}

export interface DomainAdminResolvedTargetSummary {
  scriptPubKeyHex: string;
  address: string | null;
  opaque: boolean;
}

export type DomainAdminResolvedEffect =
  | { kind: "endpoint-set"; byteLength: number }
  | { kind: "endpoint-clear" }
  | { kind: "delegate-set" }
  | { kind: "delegate-clear" }
  | { kind: "miner-set" }
  | { kind: "miner-clear" }
  | { kind: "canonicalize-owner" };

export interface DomainAdminResolvedSummary {
  sender: DomainAdminResolvedSenderSummary;
  target: DomainAdminResolvedTargetSummary | null;
  effect: DomainAdminResolvedEffect;
}

export interface DomainAdminMutationResult {
  kind: DomainAdminKind;
  domainName: string;
  txid: string;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  recipientScriptPubKeyHex?: string | null;
  endpointValueHex?: string | null;
  resolved?: DomainAdminResolvedSummary | null;
}

interface PreparedDomainAdminPayload {
  opReturnData: Uint8Array;
  recipientScriptPubKeyHex?: string | null;
  endpointValueHex?: string | null;
  resolvedTarget: DomainAdminResolvedTargetSummary | null;
  resolvedEffect: DomainAdminResolvedEffect;
}

interface DomainAdminBaseOptions {
  domainName: string;
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  assumeYes?: boolean;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => DomainAdminRpcClient;
}

export interface SetDomainEndpointOptions extends DomainAdminBaseOptions {
  source:
    | { kind: "text"; value: string }
    | { kind: "json"; value: string }
    | { kind: "bytes"; value: string };
}

export interface ClearDomainEndpointOptions extends DomainAdminBaseOptions {}

export interface SetDomainDelegateOptions extends DomainAdminBaseOptions {
  target: string;
}

export interface ClearDomainDelegateOptions extends DomainAdminBaseOptions {}

export interface SetDomainMinerOptions extends DomainAdminBaseOptions {
  target: string;
}

export interface ClearDomainMinerOptions extends DomainAdminBaseOptions {}

export interface SetDomainCanonicalOptions extends DomainAdminBaseOptions {}

function normalizeDomainName(domainName: string): string {
  const normalized = domainName.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("wallet_domain_admin_missing_domain");
  }
  validateDomainName(normalized);
  return normalized;
}

function bytesToHex(value: Uint8Array | null | undefined): string {
  return Buffer.from(value ?? new Uint8Array()).toString("hex");
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
    throw new Error(`wallet_domain_admin_invalid_amount_${text}`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  const fraction = BigInt((match[3] ?? "").padEnd(8, "0"));
  return sign * ((whole * 100_000_000n) + fraction);
}

function createResolvedDomainAdminSenderSummary(
  sender: MutationSender,
  selector: string,
): DomainAdminResolvedSenderSummary {
  return {
    selector,
    localIndex: sender.localIndex,
    scriptPubKeyHex: sender.scriptPubKeyHex,
    address: sender.address,
  };
}

function createResolvedDomainAdminTargetSummary(
  target: ReturnType<typeof normalizeBtcTarget>,
): DomainAdminResolvedTargetSummary {
  return {
    scriptPubKeyHex: target.scriptPubKeyHex,
    address: target.address,
    opaque: target.opaque,
  };
}

function createIntentFingerprint(parts: Array<string | number | bigint>): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part)).join("\n"))
    .digest("hex");
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

function resolveAnchoredDomainOperation(
  context: WalletReadContext,
  domainName: string,
  errorPrefix: string,
  options: {
    requireRoot?: boolean;
    rejectReadOnly?: boolean;
  } = {},
): DomainAdminOperation {
  assertWalletMutationContextReady(context, errorPrefix);
  const chainDomain = lookupDomain(context.snapshot.state, domainName);

  if (chainDomain === null) {
    throw new Error(`${errorPrefix}_domain_not_found`);
  }

  if (!chainDomain.anchored) {
    throw new Error(`${errorPrefix}_domain_not_anchored`);
  }

  if (options.requireRoot && domainName.includes("-")) {
    throw new Error(`${errorPrefix}_root_domain_required`);
  }

  const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  const ownerIdentity = context.model.identities.find((identity) => identity.scriptPubKeyHex === ownerHex) ?? null;

  if (ownerIdentity === null || ownerIdentity.address === null) {
    throw new Error(`${errorPrefix}_owner_not_locally_controlled`);
  }

  if ((options.rejectReadOnly ?? true) && ownerIdentity.readOnly) {
    throw new Error(`${errorPrefix}_owner_read_only`);
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
    chainDomain,
  };
}

function buildPlanForDomainAdminOperation(options: {
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  sender: MutationSender;
  anchorOutpoint: OutpointRecord;
  opReturnData: Uint8Array;
  errorPrefix: string;
}): DomainAdminPlan {
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
  funded: BuiltDomainAdminTransaction["funded"],
  plan: DomainAdminPlan,
): void {
  const inputs = decoded.tx.vin;
  const outputs = decoded.tx.vout;

  if (inputs.length === 0) {
    throw new Error(`${plan.errorPrefix}_missing_sender_input`);
  }

  assertFixedInputPrefixMatches(inputs, plan.fixedInputs, `${plan.errorPrefix}_sender_input_mismatch`);

  if (inputs[0]?.prevout?.scriptPubKey?.hex !== plan.sender.scriptPubKeyHex) {
    throw new Error(`${plan.errorPrefix}_sender_input_mismatch`);
  }

  assertFundingInputsAfterFixedPrefix({
    inputs,
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
  rpc: DomainAdminRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: DomainAdminPlan;
}): Promise<BuiltDomainAdminTransaction> {
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
  kind: DomainAdminKind;
  domainName: string;
  sender: MutationSender;
  intentFingerprintHex: string;
  nowUnixMs: number;
  recipientScriptPubKeyHex?: string | null;
  endpointValueHex?: string | null;
  existing?: PendingMutationRecord | null;
}): PendingMutationRecord {
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

async function reconcilePendingAdminMutation(options: {
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  provider: WalletSecretProvider;
  unlockUntilUnixMs: number;
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
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
    const confirmed = updateMutationRecord(options.mutation, "confirmed", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    let nextState = upsertPendingMutation(options.state, confirmed);
    nextState = await saveUpdatedMutationState({
      state: nextState,
      provider: options.provider,
      unlockUntilUnixMs: options.unlockUntilUnixMs,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });
    return { state: nextState, mutation: confirmed, resolution: "confirmed" };
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

  const known = options.mutation.attemptedTxid === null
    ? false
    : await options.rpc.getRawTransaction(options.mutation.attemptedTxid, true).then(() => true).catch(() => false);
  if (known) {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
    const live = updateMutationRecord(options.mutation, "live", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    let nextState = upsertPendingMutation(options.state, live);
    nextState = await saveUpdatedMutationState({
      state: nextState,
      provider: options.provider,
      unlockUntilUnixMs: options.unlockUntilUnixMs,
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

async function confirmEndpointMutation(
  prompter: WalletPrompter,
  domainName: string,
  payload: Uint8Array,
  options: {
    clear: boolean;
    sender: DomainAdminResolvedSenderSummary;
    sourceKind?: "text" | "json" | "bytes";
    assumeYes?: boolean;
  },
): Promise<void> {
  prompter.writeLine(`${options.clear ? "Clearing" : "Updating"} endpoint for "${domainName}".`);
  prompter.writeLine(`Resolved sender: ${options.sender.selector} (${options.sender.address})`);
  prompter.writeLine(
    options.clear
      ? "Effect: clear the endpoint payload."
      : `Effect: set the endpoint payload to ${payload.length} bytes.`,
  );
  if (!options.clear) {
    prompter.writeLine(`Payload bytes: ${payload.length}`);
    if (options.sourceKind !== undefined) {
      prompter.writeLine(`Payload source: ${options.sourceKind}`);
    }
    prompter.writeLine("Warning: endpoint data is public in the mempool and on-chain.");
  }
  await confirmYesNo(prompter, options.clear
    ? "This publishes a standalone anchored endpoint clear."
    : "This publishes a standalone anchored endpoint update.", {
    assumeYes: options.assumeYes,
    errorCode: "wallet_domain_endpoint_confirmation_rejected",
    requiresTtyErrorCode: "wallet_domain_endpoint_requires_tty",
  });
}

async function confirmTargetMutation(
  prompter: WalletPrompter,
  options: {
    kind: "delegate" | "miner";
    domainName: string;
    target: ReturnType<typeof normalizeBtcTarget> | null;
    sender: DomainAdminResolvedSenderSummary;
    assumeYes?: boolean;
  },
): Promise<void> {
  prompter.writeLine(`${options.target === null ? "Clearing" : "Updating"} ${options.kind} for "${options.domainName}".`);
  prompter.writeLine(`Resolved sender: ${options.sender.selector} (${options.sender.address})`);
  if (options.target === null) {
    prompter.writeLine(`Effect: clear the ${options.kind === "delegate" ? "delegate" : "designated miner"} target.`);
    await confirmYesNo(prompter, `This clears the current ${options.kind} target.`, {
      assumeYes: options.assumeYes,
      errorCode: `wallet_domain_${options.kind}_confirmation_rejected`,
      requiresTtyErrorCode: `wallet_domain_${options.kind}_requires_tty`,
    });
    return;
  }

  prompter.writeLine(`Resolved target: ${options.target.address ?? `spk:${options.target.scriptPubKeyHex}`}`);
  prompter.writeLine(`Effect: set the ${options.kind === "delegate" ? "delegate" : "designated miner"} target.`);
  if (options.kind === "miner" && options.target.scriptPubKeyHex === options.sender.scriptPubKeyHex) {
    prompter.writeLine("Warning: setting the designated miner to the current owner is usually redundant.");
  }
  await confirmYesNo(prompter, options.kind === "delegate"
    ? "This changes who may act for the domain as delegate."
    : "This changes who may mine for the domain as designated miner.", {
    assumeYes: options.assumeYes,
    errorCode: `wallet_domain_${options.kind}_confirmation_rejected`,
    requiresTtyErrorCode: `wallet_domain_${options.kind}_requires_tty`,
  });
}

async function confirmCanonical(
  prompter: WalletPrompter,
  domainName: string,
  sender: DomainAdminResolvedSenderSummary,
  assumeYes = false,
): Promise<void> {
  prompter.writeLine(`Canonicalizing "${domainName}" as the anchored owner.`);
  prompter.writeLine(`Resolved sender: ${sender.selector} (${sender.address})`);
  prompter.writeLine("Effect: canonicalize the current anchored owner.");
  await confirmYesNo(prompter, "This publishes a standalone SET_CANONICAL operation.", {
    assumeYes,
    errorCode: "wallet_domain_canonical_confirmation_rejected",
    requiresTtyErrorCode: "wallet_domain_canonical_requires_tty",
  });
}

async function loadEndpointPayload(
  source: SetDomainEndpointOptions["source"],
): Promise<Uint8Array> {
  if (source.kind === "text") {
    const value = source.value;
    if (value.length === 0) {
      throw new Error("wallet_domain_endpoint_payload_missing");
    }
    return new TextEncoder().encode(value);
  }

  if (source.kind === "json") {
    const value = source.value.trim();
    if (value.length === 0) {
      throw new Error("wallet_domain_endpoint_payload_missing");
    }
    try {
      JSON.parse(value);
    } catch {
      throw new Error("wallet_domain_endpoint_invalid_json");
    }
    return new TextEncoder().encode(value);
  }

  if (source.value.startsWith("hex:")) {
    const hex = source.value.slice(4);
    if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) {
      throw new Error("wallet_domain_endpoint_invalid_bytes");
    }
    if (hex.length === 0) {
      throw new Error("wallet_domain_endpoint_payload_missing");
    }
    return Buffer.from(hex, "hex");
  }

  if (!source.value.startsWith("@")) {
    throw new Error("wallet_domain_endpoint_invalid_bytes");
  }

  const filePath = source.value.slice(1);
  if (filePath.trim() === "") {
    throw new Error("wallet_domain_endpoint_invalid_bytes");
  }

  const payload = await readFile(resolvePath(process.cwd(), filePath));
  if (payload.length === 0) {
    throw new Error("wallet_domain_endpoint_payload_missing");
  }
  return payload;
}

async function sendBuiltTransaction(options: {
  rpc: DomainAdminRpcClient;
  walletName: string;
  snapshotHeight: number | null;
  built: BuiltDomainAdminTransaction;
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

async function submitDomainAdminMutation(options: DomainAdminBaseOptions & {
  kind: DomainAdminKind;
  errorPrefix: string;
  requireRoot?: boolean;
  intentParts(operation: DomainAdminOperation): Array<string | number | bigint>;
  createPayload(operation: DomainAdminOperation): Promise<PreparedDomainAdminPayload>;
  confirm(operation: DomainAdminOperation): Promise<void>;
}): Promise<DomainAdminMutationResult> {
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
      const normalizedDomainName = normalizeDomainName(options.domainName);
      const operation = resolveAnchoredDomainOperation(
        readContext,
        normalizedDomainName,
        options.errorPrefix,
        { requireRoot: options.requireRoot },
      );
      const resolvedSender = createResolvedDomainAdminSenderSummary(operation.sender, operation.senderSelector);
      const payload = await options.createPayload(operation);
      const intentFingerprintHex = createIntentFingerprint([
        options.kind,
        operation.state.walletRootId,
        ...options.intentParts(operation),
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
        const reconciled = await reconcilePendingAdminMutation({
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
            kind: options.kind,
            domainName: normalizedDomainName,
            txid: reconciled.mutation.attemptedTxid ?? "unknown",
            status: reconciled.resolution,
            reusedExisting: true,
            recipientScriptPubKeyHex: payload.recipientScriptPubKeyHex ?? null,
            endpointValueHex: payload.endpointValueHex ?? null,
            resolved: {
              sender: resolvedSender,
              target: payload.resolvedTarget,
              effect: payload.resolvedEffect,
            },
          };
        }

        if (reconciled.resolution === "repair-required") {
          throw new Error(`${options.errorPrefix}_repair_required`);
        }
      }

      await options.confirm(operation);

      let nextState = upsertPendingMutation(
        operation.state,
        createDraftMutation({
          kind: options.kind,
          domainName: normalizedDomainName,
          sender: operation.sender,
          intentFingerprintHex,
          nowUnixMs,
          recipientScriptPubKeyHex: payload.recipientScriptPubKeyHex ?? null,
          endpointValueHex: payload.endpointValueHex ?? null,
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

      const built = await buildTransaction({
        rpc,
        walletName,
        state: nextState,
        plan: buildPlanForDomainAdminOperation({
          state: nextState,
          allUtxos: await rpc.listUnspent(walletName, 1),
          sender: operation.sender,
          anchorOutpoint: operation.anchorOutpoint,
          opReturnData: payload.opReturnData,
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
        kind: options.kind,
        domainName: normalizedDomainName,
        txid: final.mutation.attemptedTxid ?? built.txid,
        status: "live",
        reusedExisting: false,
        recipientScriptPubKeyHex: payload.recipientScriptPubKeyHex ?? null,
        endpointValueHex: payload.endpointValueHex ?? null,
        resolved: {
          sender: resolvedSender,
          target: payload.resolvedTarget,
          effect: payload.resolvedEffect,
        },
      };
    } finally {
      await readContext.close();
      await miningPreemption.release();
    }
  } finally {
    await controlLock.release();
  }
}

export async function setDomainEndpoint(
  options: SetDomainEndpointOptions,
): Promise<DomainAdminMutationResult> {
  const payloadBytes = await loadEndpointPayload(options.source);

  return submitDomainAdminMutation({
    ...options,
    kind: "endpoint",
    errorPrefix: "wallet_domain_endpoint",
    intentParts(operation) {
      return [operation.chainDomain.name, Buffer.from(payloadBytes).toString("hex")];
    },
    async createPayload(operation) {
      return {
        opReturnData: serializeSetEndpoint(operation.chainDomain.domainId, payloadBytes).opReturnData,
        endpointValueHex: Buffer.from(payloadBytes).toString("hex"),
        resolvedTarget: null,
        resolvedEffect: {
          kind: "endpoint-set",
          byteLength: payloadBytes.length,
        },
      };
    },
    async confirm(operation) {
      await confirmEndpointMutation(options.prompter, operation.chainDomain.name, payloadBytes, {
        clear: false,
        sender: createResolvedDomainAdminSenderSummary(operation.sender, operation.senderSelector),
        sourceKind: options.source.kind,
        assumeYes: options.assumeYes,
      });
    },
  });
}

export async function clearDomainEndpoint(
  options: ClearDomainEndpointOptions,
): Promise<DomainAdminMutationResult> {
  return submitDomainAdminMutation({
    ...options,
    kind: "endpoint",
    errorPrefix: "wallet_domain_endpoint",
    intentParts(operation) {
      return [operation.chainDomain.name, "clear"];
    },
    async createPayload(operation) {
      return {
        opReturnData: serializeSetEndpoint(operation.chainDomain.domainId).opReturnData,
        endpointValueHex: "",
        resolvedTarget: null,
        resolvedEffect: { kind: "endpoint-clear" },
      };
    },
    async confirm(operation) {
      await confirmEndpointMutation(options.prompter, operation.chainDomain.name, new Uint8Array(), {
        clear: true,
        sender: createResolvedDomainAdminSenderSummary(operation.sender, operation.senderSelector),
        assumeYes: options.assumeYes,
      });
    },
  });
}

export async function setDomainDelegate(
  options: SetDomainDelegateOptions,
): Promise<DomainAdminMutationResult> {
  const target = normalizeBtcTarget(options.target);

  return submitDomainAdminMutation({
    ...options,
    kind: "delegate",
    errorPrefix: "wallet_domain_delegate",
    intentParts(operation) {
      return [operation.chainDomain.name, target.scriptPubKeyHex];
    },
    async createPayload(operation) {
      if (target.scriptPubKeyHex === operation.sender.scriptPubKeyHex) {
        throw new Error("wallet_domain_delegate_self_target");
      }
      return {
        opReturnData: serializeSetDelegate(operation.chainDomain.domainId, Buffer.from(target.scriptPubKeyHex, "hex")).opReturnData,
        recipientScriptPubKeyHex: target.scriptPubKeyHex,
        resolvedTarget: createResolvedDomainAdminTargetSummary(target),
        resolvedEffect: { kind: "delegate-set" },
      };
    },
    async confirm(operation) {
      await confirmTargetMutation(options.prompter, {
        kind: "delegate",
        domainName: operation.chainDomain.name,
        target,
        sender: createResolvedDomainAdminSenderSummary(operation.sender, operation.senderSelector),
        assumeYes: options.assumeYes,
      });
    },
  });
}

export async function clearDomainDelegate(
  options: ClearDomainDelegateOptions,
): Promise<DomainAdminMutationResult> {
  return submitDomainAdminMutation({
    ...options,
    kind: "delegate",
    errorPrefix: "wallet_domain_delegate",
    intentParts(operation) {
      return [operation.chainDomain.name, "clear"];
    },
    async createPayload(operation) {
      return {
        opReturnData: serializeSetDelegate(operation.chainDomain.domainId).opReturnData,
        recipientScriptPubKeyHex: null,
        resolvedTarget: null,
        resolvedEffect: { kind: "delegate-clear" },
      };
    },
    async confirm(operation) {
      await confirmTargetMutation(options.prompter, {
        kind: "delegate",
        domainName: operation.chainDomain.name,
        target: null,
        sender: createResolvedDomainAdminSenderSummary(operation.sender, operation.senderSelector),
        assumeYes: options.assumeYes,
      });
    },
  });
}

export async function setDomainMiner(
  options: SetDomainMinerOptions,
): Promise<DomainAdminMutationResult> {
  const target = normalizeBtcTarget(options.target);

  return submitDomainAdminMutation({
    ...options,
    kind: "miner",
    errorPrefix: "wallet_domain_miner",
    requireRoot: true,
    intentParts(operation) {
      return [operation.chainDomain.name, target.scriptPubKeyHex];
    },
    async createPayload(operation) {
      return {
        opReturnData: serializeSetMiner(operation.chainDomain.domainId, Buffer.from(target.scriptPubKeyHex, "hex")).opReturnData,
        recipientScriptPubKeyHex: target.scriptPubKeyHex,
        resolvedTarget: createResolvedDomainAdminTargetSummary(target),
        resolvedEffect: { kind: "miner-set" },
      };
    },
    async confirm(operation) {
      await confirmTargetMutation(options.prompter, {
        kind: "miner",
        domainName: operation.chainDomain.name,
        target,
        sender: createResolvedDomainAdminSenderSummary(operation.sender, operation.senderSelector),
        assumeYes: options.assumeYes,
      });
    },
  });
}

export async function clearDomainMiner(
  options: ClearDomainMinerOptions,
): Promise<DomainAdminMutationResult> {
  return submitDomainAdminMutation({
    ...options,
    kind: "miner",
    errorPrefix: "wallet_domain_miner",
    requireRoot: true,
    intentParts(operation) {
      return [operation.chainDomain.name, "clear"];
    },
    async createPayload(operation) {
      return {
        opReturnData: serializeSetMiner(operation.chainDomain.domainId).opReturnData,
        recipientScriptPubKeyHex: null,
        resolvedTarget: null,
        resolvedEffect: { kind: "miner-clear" },
      };
    },
    async confirm(operation) {
      await confirmTargetMutation(options.prompter, {
        kind: "miner",
        domainName: operation.chainDomain.name,
        target: null,
        sender: createResolvedDomainAdminSenderSummary(operation.sender, operation.senderSelector),
        assumeYes: options.assumeYes,
      });
    },
  });
}

export async function setDomainCanonical(
  options: SetDomainCanonicalOptions,
): Promise<DomainAdminMutationResult> {
  return submitDomainAdminMutation({
    ...options,
    kind: "canonical",
    errorPrefix: "wallet_domain_canonical",
    intentParts(operation) {
      return [operation.chainDomain.name, operation.sender.scriptPubKeyHex];
    },
    async createPayload(operation) {
      return {
        opReturnData: serializeSetCanonical(operation.chainDomain.domainId).opReturnData,
        resolvedTarget: null,
        resolvedEffect: { kind: "canonicalize-owner" },
      };
    },
    async confirm(operation) {
      await confirmCanonical(
        options.prompter,
        operation.chainDomain.name,
        createResolvedDomainAdminSenderSummary(operation.sender, operation.senderSelector),
        options.assumeYes,
      );
    },
  });
}
