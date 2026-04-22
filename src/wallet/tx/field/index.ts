import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import {
  getBalance,
  lookupDomain,
} from "@cogcoin/indexer/queries";

import { attachOrStartManagedBitcoindService } from "../../../bitcoind/service.js";
import { createRpcClient } from "../../../bitcoind/node.js";
import type {
  RpcDecodedPsbt,
  RpcListUnspentEntry,
  RpcTransaction,
} from "../../../bitcoind/types.js";
import type { WalletPrompter } from "../../lifecycle.js";
import {
  type WalletRuntimePaths,
} from "../../runtime.js";
import {
  type WalletSecretProvider,
} from "../../state/provider.js";
import type {
  PendingMutationRecord,
  WalletStateV1,
} from "../../types.js";
import {
  FIELD_FORMAT_BYTES,
  serializeDataUpdate,
  serializeFieldReg,
} from "../../cogop/index.js";
import { validateFieldName } from "../../cogop/validate-name.js";
import {
  findDomainField,
  openWalletReadContext,
  type WalletReadContext,
} from "../../read/index.js";
import {
  assertWalletMutationContextReady,
  buildWalletMutationTransactionWithReserveFallback,
  createWalletMutationFeeMetadata,
  mergeFixedWalletInputs,
  outpointKey,
  unlockTemporaryBuilderLocks,
  updateMutationRecord,
  type BuiltWalletMutationTransaction,
  type FixedWalletInput,
  type MutationSender,
  type WalletMutationFeeSummary,
  type WalletMutationRpcClient,
} from "../common.js";
import {
  confirmTypedAcknowledgement as confirmSharedTypedAcknowledgement,
  confirmYesNo as confirmSharedYesNo,
} from "../confirm.js";
import {
  executeWalletMutationOperation,
  persistWalletMutationState,
  publishWalletMutation,
  resolveExistingWalletMutation,
} from "../executor.js";
import { upsertPendingMutation } from "../journal.js";

type FieldMutationKind = "field-create" | "field-set" | "field-clear";

export type FieldValueInputSource =
  | { kind: "text"; value: string }
  | { kind: "json"; value: string }
  | { kind: "bytes"; value: string }
  | { kind: "raw"; format: string; value: string };

interface FieldRpcClient extends WalletMutationRpcClient {
  getBlockchainInfo(): Promise<{ blocks: number }>;
  sendRawTransaction(hex: string): Promise<string>;
  getRawTransaction(txid: string, verbose?: boolean): Promise<RpcTransaction>;
}

interface FieldPlan {
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

interface FieldOperation {
  readContext: WalletReadContext & {
    localState: {
      availability: "ready";
      state: WalletStateV1;
    };
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
    model: NonNullable<WalletReadContext["model"]>;
  };
  state: WalletStateV1;
  sender: MutationSender;
  senderSelector: string;
  chainDomain: NonNullable<ReturnType<typeof lookupDomain>>;
}

interface StandaloneFieldMutationOperation extends FieldOperation {
  normalizedDomainName: string;
  normalizedFieldName: string;
  existingObservedField: ReturnType<typeof getObservedFieldState>;
}

interface NormalizedFieldValue {
  format: number;
  formatLabel: string;
  value: Uint8Array;
  valueHex: string;
}

export interface CreateFieldOptions {
  domainName: string;
  fieldName: string;
  permanent?: boolean;
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
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => FieldRpcClient;
}

export interface SetFieldOptions extends Omit<CreateFieldOptions, "permanent"> {
  source: FieldValueInputSource;
}

export interface ClearFieldOptions extends Omit<CreateFieldOptions, "permanent" | "source"> {}

export interface FieldMutationResult {
  kind: FieldMutationKind;
  domainName: string;
  fieldName: string;
  fieldId: number | null;
  txid: string;
  permanent: boolean | null;
  format: number | null;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  resolved?: FieldResolvedSummary | null;
  fees: WalletMutationFeeSummary;
}

export interface FieldResolvedSenderSummary {
  selector: string;
  localIndex: number;
  scriptPubKeyHex: string;
  address: string;
}

export type FieldResolvedPath =
  | "standalone-field-reg"
  | "standalone-data-update"
  | "standalone-data-clear";

export interface FieldResolvedValueSummary {
  format: number;
  byteLength: number;
}

export type FieldResolvedEffect =
  | { kind: "create-empty-field"; burnCogtoshi: "100" }
  | { kind: "write-field-value"; burnCogtoshi: "1" }
  | { kind: "clear-field-value"; burnCogtoshi: "0" };

export interface FieldResolvedSummary {
  sender: FieldResolvedSenderSummary;
  path: FieldResolvedPath;
  value: FieldResolvedValueSummary | null;
  effect: FieldResolvedEffect;
}

function createResolvedFieldSenderSummary(
  sender: MutationSender,
  selector: string,
): FieldResolvedSenderSummary {
  return {
    selector,
    localIndex: sender.localIndex,
    scriptPubKeyHex: sender.scriptPubKeyHex,
    address: sender.address,
  };
}

function createResolvedFieldValueSummary(
  format: number,
  value: Uint8Array | string,
): FieldResolvedValueSummary {
  return {
    format,
    byteLength: typeof value === "string" ? value.length / 2 : value.length,
  };
}

function createResolvedFieldSummary(options: {
  sender: MutationSender;
  senderSelector: string;
  kind: FieldMutationKind;
  value: FieldResolvedValueSummary | null;
}): FieldResolvedSummary {
  if (options.kind === "field-create") {
    return {
      sender: createResolvedFieldSenderSummary(options.sender, options.senderSelector),
      path: "standalone-field-reg",
      value: null,
      effect: {
        kind: "create-empty-field",
        burnCogtoshi: "100",
      },
    };
  }

  if (options.kind === "field-set") {
    return {
      sender: createResolvedFieldSenderSummary(options.sender, options.senderSelector),
      path: "standalone-data-update",
      value: options.value,
      effect: {
        kind: "write-field-value",
        burnCogtoshi: "1",
      },
    };
  }

  return {
    sender: createResolvedFieldSenderSummary(options.sender, options.senderSelector),
    path: "standalone-data-clear",
    value: null,
    effect: {
      kind: "clear-field-value",
      burnCogtoshi: "0",
    },
  };
}

function createResolvedFieldValueFromStoredData(
  kind: FieldMutationKind,
  format: number | null | undefined,
  valueHex: string | null | undefined,
): FieldResolvedValueSummary | null {
  if (kind === "field-clear" || format === null || format === undefined || valueHex === null || valueHex === undefined) {
    return null;
  }

  return createResolvedFieldValueSummary(format, valueHex);
}

function describeFieldEffect(effect: FieldResolvedEffect): string {
  switch (effect.kind) {
    case "create-empty-field":
      return `burn ${effect.burnCogtoshi} cogtoshi to create an empty field`;
    case "write-field-value":
      return `burn ${effect.burnCogtoshi} cogtoshi to write the field value`;
    case "clear-field-value":
      return "clear the field value with no additional COG burn";
  }
}

function normalizeDomainName(domainName: string): string {
  const normalized = domainName.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("wallet_field_missing_domain");
  }
  return normalized;
}

function normalizeFieldName(fieldName: string): string {
  const normalized = fieldName.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("wallet_field_missing_field_name");
  }
  validateFieldName(normalized);
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
    throw new Error(`wallet_field_invalid_amount_${text}`);
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

function hex(value: Uint8Array | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return Buffer.from(value).toString("hex");
}

function isActiveMutationStatus(status: PendingMutationRecord["status"]): boolean {
  return status === "draft"
    || status === "broadcasting"
    || status === "broadcast-unknown"
    || status === "live"
    || status === "repair-required";
}

function findActiveFieldCreateMutationByDomain(
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

function resolveAnchoredFieldOperation(
  context: WalletReadContext,
  domainName: string,
  errorPrefix: string,
): FieldOperation {
  assertWalletMutationContextReady(context, errorPrefix);
  const chainDomain = lookupDomain(context.snapshot.state, domainName);

  if (chainDomain === null) {
    throw new Error(`${errorPrefix}_domain_not_found`);
  }

  if (!chainDomain.anchored) {
    throw new Error(`${errorPrefix}_domain_not_anchored`);
  }

  const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  const state = context.localState.state;

  if (ownerHex !== state.funding.scriptPubKeyHex || state.funding.address.trim() === "") {
    throw new Error(`${errorPrefix}_owner_not_locally_controlled`);
  }

  return {
    readContext: context,
    state,
    sender: {
      localIndex: 0,
      scriptPubKeyHex: state.funding.scriptPubKeyHex,
      address: state.funding.address,
    },
    senderSelector: state.funding.address,
    chainDomain,
  };
}

function buildAnchoredFieldPlan(options: {
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  sender: MutationSender;
  opReturnData: Uint8Array;
  errorPrefix: string;
}): FieldPlan {
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

function validateFieldDraft(
  decoded: RpcDecodedPsbt,
  funded: BuiltWalletMutationTransaction["funded"],
  plan: FieldPlan,
): void {
  const inputs = decoded.tx.vin;
  const outputs = decoded.tx.vout;

  if (inputs.length === 0) {
    throw new Error(`${plan.errorPrefix}_missing_sender_input`);
  }

  if (outputs[0]?.scriptPubKey?.hex !== plan.expectedOpReturnScriptHex) {
    throw new Error(`${plan.errorPrefix}_opreturn_mismatch`);
  }

  if (funded.changepos === -1) {
    if (outputs.length !== 1) {
      throw new Error(`${plan.errorPrefix}_unexpected_output_count`);
    }
    return;
  }

  if (funded.changepos !== plan.changePosition || outputs.length !== 2) {
    throw new Error(`${plan.errorPrefix}_change_position_mismatch`);
  }

  if (outputs[funded.changepos]?.scriptPubKey?.hex !== plan.allowedFundingScriptPubKeyHex) {
    throw new Error(`${plan.errorPrefix}_change_output_mismatch`);
  }
}

async function buildFieldTransaction(options: {
  rpc: FieldRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: FieldPlan;
  feeRateSatVb: number;
  availableFundingMinConf?: number;
}): Promise<BuiltWalletMutationTransaction> {
  return buildWalletMutationTransactionWithReserveFallback({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
    plan: options.plan,
    validateFundedDraft: validateFieldDraft,
    finalizeErrorCode: `${options.plan.errorPrefix}_finalize_failed`,
    mempoolRejectPrefix: `${options.plan.errorPrefix}_mempool_rejected`,
    feeRate: options.feeRateSatVb,
    availableFundingMinConf: options.availableFundingMinConf,
  });
}

async function saveUpdatedState(options: {
  state: WalletStateV1;
  provider: WalletSecretProvider;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
}): Promise<WalletStateV1> {
  return persistWalletMutationState(options);
}

function createStandaloneFieldMutation(options: {
  kind: FieldMutationKind;
  domainName: string;
  fieldName: string;
  sender: MutationSender;
  intentFingerprintHex: string;
  nowUnixMs: number;
  feeSelection: {
    feeRateSatVb: number;
    source: "custom-satvb" | "estimated-next-block-plus-one" | "fallback-default";
  };
  existing?: PendingMutationRecord | null;
  fieldId?: number | null;
  fieldPermanent?: boolean | null;
  fieldFormat?: number | null;
  fieldValueHex?: string | null;
}): PendingMutationRecord {
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

function getObservedFieldState(
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

async function reconcilePendingFieldMutation(options: {
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
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
    const confirmed = updateMutationRecord(options.mutation, "confirmed", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    let nextState = upsertPendingMutation(options.state, confirmed);
    nextState = await saveUpdatedState({
      state: nextState,
      provider: options.provider,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });
    return { state: nextState, mutation: confirmed, resolution: "confirmed" };
  }

  if (standaloneMutationNeedsRepair(options.mutation, options.context)) {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
    const repair = updateMutationRecord(options.mutation, "repair-required", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    let nextState = upsertPendingMutation(options.state, repair);
    nextState = await saveUpdatedState({
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
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
    const live = updateMutationRecord(options.mutation, "live", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    let nextState = upsertPendingMutation(options.state, live);
    nextState = await saveUpdatedState({
      state: nextState,
      provider: options.provider,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });
    return { state: nextState, mutation: live, resolution: "live" };
  }

  if (options.mutation.status === "broadcast-unknown"
    || options.mutation.status === "draft"
    || options.mutation.status === "broadcasting") {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
    const canceled = updateMutationRecord(options.mutation, "canceled", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    let nextState = upsertPendingMutation(options.state, canceled);
    nextState = await saveUpdatedState({
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

async function confirmFieldCreate(
  prompter: WalletPrompter,
  options: {
    domainName: string;
    fieldName: string;
    permanent: boolean;
    sender: FieldResolvedSenderSummary;
    assumeYes?: boolean;
  },
): Promise<void> {
  const fieldRef = `${options.domainName}:${options.fieldName}`;
  prompter.writeLine(`Creating field "${fieldRef}" as ${options.permanent ? "permanent" : "mutable"}.`);
  prompter.writeLine(`Resolved sender: ${options.sender.selector} (${options.sender.address})`);
  prompter.writeLine("Path: standalone-field-reg");
  prompter.writeLine(`Effect: ${describeFieldEffect({ kind: "create-empty-field", burnCogtoshi: "100" })}.`);
  prompter.writeLine("This publishes a standalone FIELD_REG and burns 0.00000100 COG.");

  await confirmYesNo(
    prompter,
    "The field will be created empty and the burn is not reversible.",
    "wallet_field_create_confirmation_rejected",
    {
      assumeYes: options.assumeYes,
      requiresTtyErrorCode: "wallet_field_create_requires_tty",
    },
  );
}

async function confirmFieldSet(
  prompter: WalletPrompter,
  options: {
    domainName: string;
    fieldName: string;
    fieldPermanent: boolean;
    isFirstPermanentWrite: boolean;
    value: NormalizedFieldValue;
    sender: FieldResolvedSenderSummary;
    assumeYes?: boolean;
  },
): Promise<void> {
  const fieldRef = `${options.domainName}:${options.fieldName}`;
  prompter.writeLine(`Updating field "${fieldRef}".`);
  prompter.writeLine(`Resolved sender: ${options.sender.selector} (${options.sender.address})`);
  prompter.writeLine("Path: standalone-data-update");
  prompter.writeLine(`Effect: ${describeFieldEffect({ kind: "write-field-value", burnCogtoshi: "1" })}.`);
  prompter.writeLine(`Format: ${options.value.formatLabel}`);
  prompter.writeLine(`Value bytes: ${options.value.value.length}`);
  prompter.writeLine("Warning: the field value is public in the mempool and on-chain.");

  if (options.isFirstPermanentWrite && options.fieldPermanent) {
    prompter.writeLine("This is the first non-clear value write to a permanent field.");
    await confirmTyped(
      prompter,
      fieldRef,
      `Type ${fieldRef} to continue: `,
      "wallet_field_set_confirmation_rejected",
      {
        assumeYes: options.assumeYes,
        requiresTtyErrorCode: "wallet_field_set_requires_tty",
        typedAckRequiredErrorCode: "wallet_field_set_typed_ack_required",
      },
    );
    return;
  }

  await confirmYesNo(
    prompter,
    "This publishes a standalone DATA_UPDATE.",
    "wallet_field_set_confirmation_rejected",
    {
      assumeYes: options.assumeYes,
      requiresTtyErrorCode: "wallet_field_set_requires_tty",
    },
  );
}

function describeRawFormat(format: number): string {
  if (format === FIELD_FORMAT_BYTES.bytes) {
    return "bytes (0x01)";
  }
  if (format === FIELD_FORMAT_BYTES.text) {
    return "text (0x02)";
  }
  if (format === FIELD_FORMAT_BYTES.json) {
    return "json (0x09)";
  }
  return `raw (0x${format.toString(16).padStart(2, "0")})`;
}

async function loadFieldValue(
  source: FieldValueInputSource,
): Promise<NormalizedFieldValue> {
  if (source.kind === "text") {
    if (source.value.length === 0) {
      throw new Error("wallet_field_value_missing");
    }
    const value = new TextEncoder().encode(source.value);
    return {
      format: FIELD_FORMAT_BYTES.text,
      formatLabel: "text (0x02)",
      value,
      valueHex: Buffer.from(value).toString("hex"),
    };
  }

  if (source.kind === "json") {
    if (source.value.length === 0) {
      throw new Error("wallet_field_value_missing");
    }
    try {
      JSON.parse(source.value);
    } catch {
      throw new Error("wallet_field_invalid_json");
    }
    const value = new TextEncoder().encode(source.value);
    return {
      format: FIELD_FORMAT_BYTES.json,
      formatLabel: "json (0x09)",
      value,
      valueHex: Buffer.from(value).toString("hex"),
    };
  }

  if (source.kind === "bytes") {
    let value: Buffer;

    if (source.value.startsWith("hex:")) {
      const payload = source.value.slice(4);
      if (!/^[0-9a-f]+$/.test(payload) || payload.length % 2 !== 0) {
        throw new Error("wallet_field_invalid_bytes");
      }
      value = Buffer.from(payload, "hex");
    } else if (source.value.startsWith("@")) {
      const filePath = source.value.slice(1);
      if (filePath.trim() === "") {
        throw new Error("wallet_field_invalid_bytes");
      }
      value = await readFile(resolvePath(process.cwd(), filePath));
    } else {
      throw new Error("wallet_field_invalid_bytes");
    }

    if (value.length === 0) {
      throw new Error("wallet_field_value_missing");
    }

    return {
      format: FIELD_FORMAT_BYTES.bytes,
      formatLabel: "bytes (0x01)",
      value,
      valueHex: value.toString("hex"),
    };
  }

  const match = /^raw:(\d{1,3})$/.exec(source.format);
  if (match == null) {
    throw new Error("wallet_field_invalid_raw_format");
  }

  const format = Number.parseInt(match[1]!, 10);
  if (!Number.isInteger(format) || format < 0 || format > 0xff || format === FIELD_FORMAT_BYTES.clear) {
    throw new Error("wallet_field_invalid_raw_format");
  }

  let value: Uint8Array;

  if (source.value.startsWith("hex:")) {
    const payload = source.value.slice(4);
    if (!/^[0-9a-f]+$/.test(payload) || payload.length % 2 !== 0) {
      throw new Error("wallet_field_invalid_value");
    }
    value = Buffer.from(payload, "hex");
  } else if (source.value.startsWith("@")) {
    const filePath = source.value.slice(1);
    if (filePath.trim() === "") {
      throw new Error("wallet_field_invalid_value");
    }
    value = await readFile(resolvePath(process.cwd(), filePath));
  } else if (source.value.startsWith("utf8:")) {
    value = new TextEncoder().encode(source.value.slice(5));
  } else {
    throw new Error("wallet_field_invalid_value");
  }

  if (value.length === 0) {
    throw new Error("wallet_field_value_missing");
  }

  return {
    format,
    formatLabel: describeRawFormat(format),
    value,
    valueHex: Buffer.from(value).toString("hex"),
  };
}

async function submitStandaloneFieldMutation(options: {
  kind: FieldMutationKind;
  errorPrefix: string;
  domainName: string;
  fieldName: string;
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
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => FieldRpcClient;
  createMutation(
    operation: FieldOperation,
    existing: PendingMutationRecord | null,
    feeSelection: {
      feeRateSatVb: number;
      source: "custom-satvb" | "estimated-next-block-plus-one" | "fallback-default";
    },
  ): Promise<{
    opReturnData: Uint8Array;
    mutation: PendingMutationRecord;
  }>;
  confirm(operation: FieldOperation): Promise<void>;
}): Promise<FieldMutationResult> {
  if (!options.prompter.isInteractive && options.assumeYes !== true) {
    throw new Error(`${options.errorPrefix}_requires_tty`);
  }

  const execution = await executeWalletMutationOperation<
    StandaloneFieldMutationOperation,
    FieldRpcClient,
    { opReturnData: Uint8Array },
    BuiltWalletMutationTransaction,
    FieldMutationResult
  >({
    ...options,
    controlLockPurpose: options.errorPrefix,
    preemptionReason: options.errorPrefix,
    resolveOperation(readContext) {
      const normalizedDomainName = normalizeDomainName(options.domainName);
      const normalizedFieldName = normalizeFieldName(options.fieldName);
      const operation = resolveAnchoredFieldOperation(readContext, normalizedDomainName, options.errorPrefix);
      return {
        ...operation,
        normalizedDomainName,
        normalizedFieldName,
        existingObservedField: getObservedFieldState(readContext, normalizedDomainName, normalizedFieldName),
      };
    },
    createIntentFingerprint(operation) {
      return createIntentFingerprint([
        options.kind,
        operation.state.walletRootId,
        operation.normalizedDomainName,
        operation.normalizedFieldName,
      ]);
    },
    async resolveExistingMutation({ operation, existingMutation, execution }) {
      if (existingMutation === null) {
        return {
          state: operation.state,
          replacementFixedInputs: null,
          result: null,
        };
      }

      return resolveExistingWalletMutation({
        existingMutation,
        execution,
        repairRequiredErrorCode: `${options.errorPrefix}_repair_required`,
        reconcileExistingMutation: (mutation) => reconcilePendingFieldMutation({
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
          kind: options.kind,
          domainName: operation.normalizedDomainName,
          fieldName: operation.normalizedFieldName,
          fieldId: mutation.fieldId ?? operation.existingObservedField?.fieldId ?? null,
          txid: mutation.attemptedTxid ?? "unknown",
          permanent: mutation.fieldPermanent ?? operation.existingObservedField?.permanent ?? null,
          format: mutation.fieldFormat ?? operation.existingObservedField?.format ?? null,
          status: resolution,
          reusedExisting: true,
          resolved: createResolvedFieldSummary({
            sender: operation.sender,
            senderSelector: operation.senderSelector,
            kind: options.kind,
            value: createResolvedFieldValueFromStoredData(
              options.kind,
              mutation.fieldFormat ?? operation.existingObservedField?.format ?? null,
              mutation.fieldValueHex,
            ),
          }),
          fees,
        }),
      });
    },
    confirm({ operation }) {
      return options.confirm(operation);
    },
    async createDraftMutation({ operation, existingMutation, execution }) {
      const prepared = await options.createMutation(operation, existingMutation, execution.feeSelection);
      return {
        mutation: prepared.mutation,
        prepared: {
          opReturnData: prepared.opReturnData,
        },
      };
    },
    async build({ operation, state, execution, replacementFixedInputs, prepared }) {
      const fieldPlan = buildAnchoredFieldPlan({
        state,
        allUtxos: await execution.rpc.listUnspent(execution.walletName, 1),
        sender: operation.sender,
        opReturnData: prepared.opReturnData,
        errorPrefix: options.errorPrefix,
      });
      return buildFieldTransaction({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        plan: {
          ...fieldPlan,
          fixedInputs: mergeFixedWalletInputs(fieldPlan.fixedInputs, replacementFixedInputs),
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
        errorPrefix: options.errorPrefix,
      });
    },
    createResult({ operation, mutation, built, status, reusedExisting, fees }) {
      return {
        kind: options.kind,
        domainName: operation.normalizedDomainName,
        fieldName: operation.normalizedFieldName,
        fieldId: mutation.fieldId ?? operation.existingObservedField?.fieldId ?? null,
        txid: mutation.attemptedTxid ?? built?.txid ?? "unknown",
        permanent: mutation.fieldPermanent ?? operation.existingObservedField?.permanent ?? null,
        format: mutation.fieldFormat ?? operation.existingObservedField?.format ?? null,
        status: status as FieldMutationResult["status"],
        reusedExisting,
        resolved: createResolvedFieldSummary({
          sender: operation.sender,
          senderSelector: operation.senderSelector,
          kind: options.kind,
          value: createResolvedFieldValueFromStoredData(
            options.kind,
            mutation.fieldFormat ?? operation.existingObservedField?.format ?? null,
            mutation.fieldValueHex,
          ),
        }),
        fees,
      };
    },
  });

  return execution.result;
}

export async function createField(
  options: CreateFieldOptions,
): Promise<FieldMutationResult> {
  const permanent = options.permanent ?? false;

  return submitStandaloneFieldMutation({
    kind: "field-create",
    errorPrefix: "wallet_field_create",
    domainName: options.domainName,
    fieldName: options.fieldName,
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    provider: options.provider,
    prompter: options.prompter,
    assumeYes: options.assumeYes,
    nowUnixMs: options.nowUnixMs,
    paths: options.paths,
    openReadContext: options.openReadContext,
    attachService: options.attachService,
    rpcFactory: options.rpcFactory,
    async createMutation(operation, existing, feeSelection) {
      const existingField = getObservedFieldState(operation.readContext, normalizeDomainName(options.domainName), normalizeFieldName(options.fieldName));
      if (existingField !== null) {
        throw new Error("wallet_field_create_field_exists");
      }

      if (operation.chainDomain.nextFieldId === 0xffff_ffff) {
        throw new Error("wallet_field_create_field_id_exhausted");
      }

      const senderBalance = getBalance(operation.readContext.snapshot.state, Buffer.from(operation.sender.scriptPubKeyHex, "hex"));
      if (senderBalance < 100n) {
        throw new Error("wallet_field_create_insufficient_cog");
      }

      const normalizedDomainName = normalizeDomainName(options.domainName);
      const normalizedFieldName = normalizeFieldName(options.fieldName);
      const intentFingerprintHex = createIntentFingerprint([
        "field-create",
        operation.state.walletRootId,
        normalizedDomainName,
        normalizedFieldName,
        permanent ? 1 : 0,
      ]);
      const conflictCreate = findActiveFieldCreateMutationByDomain(operation.state, normalizedDomainName, intentFingerprintHex);
      if (conflictCreate !== null) {
        throw new Error("wallet_field_create_registration_already_pending");
      }

      return {
        opReturnData: serializeFieldReg(operation.chainDomain.domainId, permanent, normalizedFieldName).opReturnData,
        mutation: createStandaloneFieldMutation({
          kind: "field-create",
          domainName: normalizedDomainName,
          fieldName: normalizedFieldName,
          sender: operation.sender,
          intentFingerprintHex,
          nowUnixMs: options.nowUnixMs ?? Date.now(),
          feeSelection,
          existing,
          fieldId: operation.chainDomain.nextFieldId,
          fieldPermanent: permanent,
        }),
      };
    },
    async confirm(operation) {
      await confirmFieldCreate(options.prompter, {
        domainName: normalizeDomainName(options.domainName),
        fieldName: normalizeFieldName(options.fieldName),
        permanent,
        sender: createResolvedFieldSenderSummary(operation.sender, operation.senderSelector),
        assumeYes: options.assumeYes,
      });
    },
  });
}

export async function setField(
  options: SetFieldOptions,
): Promise<FieldMutationResult> {
  const value = await loadFieldValue(options.source);

  return submitStandaloneFieldMutation({
    kind: "field-set",
    errorPrefix: "wallet_field_set",
    domainName: options.domainName,
    fieldName: options.fieldName,
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    provider: options.provider,
    prompter: options.prompter,
    assumeYes: options.assumeYes,
    nowUnixMs: options.nowUnixMs,
    paths: options.paths,
    openReadContext: options.openReadContext,
    attachService: options.attachService,
    rpcFactory: options.rpcFactory,
    async createMutation(operation, existing, feeSelection) {
      const normalizedDomainName = normalizeDomainName(options.domainName);
      const normalizedFieldName = normalizeFieldName(options.fieldName);
      const observedField = getObservedFieldState(operation.readContext, normalizedDomainName, normalizedFieldName);
      if (observedField === null) {
        throw new Error("wallet_field_set_field_not_found");
      }
      if (observedField.permanent && observedField.hasValue) {
        throw new Error("wallet_field_set_permanent_field_frozen");
      }

      const senderBalance = getBalance(operation.readContext.snapshot.state, Buffer.from(operation.sender.scriptPubKeyHex, "hex"));
      if (senderBalance < 1n) {
        throw new Error("wallet_field_set_insufficient_cog");
      }

      const intentFingerprintHex = createIntentFingerprint([
        "field-set",
        operation.state.walletRootId,
        normalizedDomainName,
        observedField.fieldId,
        value.format,
        value.valueHex,
      ]);
      return {
        opReturnData: serializeDataUpdate(operation.chainDomain.domainId, observedField.fieldId, value.format, value.value).opReturnData,
        mutation: createStandaloneFieldMutation({
          kind: "field-set",
          domainName: normalizedDomainName,
          fieldName: normalizedFieldName,
          sender: operation.sender,
          intentFingerprintHex,
          nowUnixMs: options.nowUnixMs ?? Date.now(),
          feeSelection,
          existing,
          fieldId: observedField.fieldId,
          fieldPermanent: observedField.permanent,
          fieldFormat: value.format,
          fieldValueHex: value.valueHex,
        }),
      };
    },
    async confirm(operation) {
      const normalizedDomainName = normalizeDomainName(options.domainName);
      const normalizedFieldName = normalizeFieldName(options.fieldName);
      const observedField = getObservedFieldState(operation.readContext, normalizedDomainName, normalizedFieldName);
      if (observedField === null) {
        throw new Error("wallet_field_set_field_not_found");
      }
      await confirmFieldSet(options.prompter, {
        domainName: normalizedDomainName,
        fieldName: normalizedFieldName,
        fieldPermanent: observedField.permanent,
        isFirstPermanentWrite: observedField.permanent && !observedField.hasValue,
        value,
        sender: createResolvedFieldSenderSummary(operation.sender, operation.senderSelector),
        assumeYes: options.assumeYes,
      });
    },
  });
}

export async function clearField(
  options: ClearFieldOptions,
): Promise<FieldMutationResult> {
  return submitStandaloneFieldMutation({
    kind: "field-clear",
    errorPrefix: "wallet_field_clear",
    domainName: options.domainName,
    fieldName: options.fieldName,
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    provider: options.provider,
    prompter: options.prompter,
    assumeYes: options.assumeYes,
    nowUnixMs: options.nowUnixMs,
    paths: options.paths,
    openReadContext: options.openReadContext,
    attachService: options.attachService,
    rpcFactory: options.rpcFactory,
    async createMutation(operation, existing, feeSelection) {
      const normalizedDomainName = normalizeDomainName(options.domainName);
      const normalizedFieldName = normalizeFieldName(options.fieldName);
      const observedField = getObservedFieldState(operation.readContext, normalizedDomainName, normalizedFieldName);
      if (observedField === null) {
        throw new Error("wallet_field_clear_field_not_found");
      }
      if (observedField.permanent && !observedField.hasValue) {
        throw new Error("wallet_field_clear_noop_permanent_clear");
      }

      const intentFingerprintHex = createIntentFingerprint([
        "field-clear",
        operation.state.walletRootId,
        normalizedDomainName,
        observedField.fieldId,
      ]);
      return {
        opReturnData: serializeDataUpdate(operation.chainDomain.domainId, observedField.fieldId, FIELD_FORMAT_BYTES.clear).opReturnData,
        mutation: createStandaloneFieldMutation({
          kind: "field-clear",
          domainName: normalizedDomainName,
          fieldName: normalizedFieldName,
          sender: operation.sender,
          intentFingerprintHex,
          nowUnixMs: options.nowUnixMs ?? Date.now(),
          feeSelection,
          existing,
          fieldId: observedField.fieldId,
          fieldPermanent: observedField.permanent,
          fieldFormat: FIELD_FORMAT_BYTES.clear,
          fieldValueHex: "",
        }),
      };
    },
    async confirm(operation) {
      const normalizedDomainName = normalizeDomainName(options.domainName);
      const normalizedFieldName = normalizeFieldName(options.fieldName);
      const observedField = getObservedFieldState(operation.readContext, normalizedDomainName, normalizedFieldName);
      if (observedField === null) {
        throw new Error("wallet_field_clear_field_not_found");
      }
      if (observedField.permanent && !observedField.hasValue) {
        throw new Error("wallet_field_clear_noop_permanent_clear");
      }
      options.prompter.writeLine(`Clearing field "${normalizedDomainName}:${normalizedFieldName}".`);
      options.prompter.writeLine(`Resolved sender: ${operation.senderSelector} (${operation.sender.address})`);
      options.prompter.writeLine("Path: standalone-data-clear");
      options.prompter.writeLine(`Effect: ${describeFieldEffect({ kind: "clear-field-value", burnCogtoshi: "0" })}.`);
      options.prompter.writeLine("This publishes a standalone DATA_UPDATE clear.");
    },
  });
}
