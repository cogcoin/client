import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import {
  getBalance,
  lookupDomain,
} from "@cogcoin/indexer/queries";

import { attachOrStartManagedBitcoindService } from "../../bitcoind/service.js";
import { createRpcClient } from "../../bitcoind/node.js";
import type {
  RpcDecodedPsbt,
  RpcListUnspentEntry,
  RpcTransaction,
} from "../../bitcoind/types.js";
import { acquireFileLock } from "../fs/lock.js";
import type { WalletPrompter } from "../lifecycle.js";
import {
  resolveWalletRuntimePathsForTesting,
  type WalletRuntimePaths,
} from "../runtime.js";
import {
  createDefaultWalletSecretProvider,
  type WalletSecretProvider,
} from "../state/provider.js";
import type {
  OutpointRecord,
  PendingMutationRecord,
  ProactiveFamilyStateRecord,
  ProactiveFamilyTransactionRecord,
  WalletStateV1,
} from "../types.js";
import {
  FIELD_FORMAT_BYTES,
  serializeDataUpdate,
  serializeFieldReg,
} from "../cogop/index.js";
import { validateFieldName } from "../cogop/validate-name.js";
import {
  findDomainField,
  openWalletReadContext,
  type WalletReadContext,
} from "../read/index.js";
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
import {
  confirmTypedAcknowledgement as confirmSharedTypedAcknowledgement,
  confirmYesNo as confirmSharedYesNo,
} from "./confirm.js";
import { getCanonicalIdentitySelector } from "./identity-selector.js";
import { findPendingMutationByIntent, upsertPendingMutation } from "./journal.js";

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
  expectedAnchorScriptHex: string;
  expectedAnchorValueSats: bigint;
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
  errorPrefix: string;
}

interface FieldOperation {
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
  source?: FieldValueInputSource | null;
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
  tx1Txid?: string | null;
  tx2Txid?: string | null;
  family: boolean;
  permanent: boolean | null;
  format: number | null;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  resolved?: FieldResolvedSummary | null;
}

export interface FieldResolvedSenderSummary {
  selector: string;
  localIndex: number;
  scriptPubKeyHex: string;
  address: string;
}

export type FieldResolvedPath =
  | "standalone-field-reg"
  | "field-reg-plus-data-update-family"
  | "standalone-data-update"
  | "standalone-data-clear";

export interface FieldResolvedValueSummary {
  format: number;
  byteLength: number;
}

export type FieldResolvedEffect =
  | { kind: "create-empty-field"; burnCogtoshi: "100" }
  | { kind: "create-and-initialize-field"; tx1BurnCogtoshi: "100"; tx2AdditionalBurnCogtoshi: "1" }
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
  family: boolean;
  value: FieldResolvedValueSummary | null;
}): FieldResolvedSummary {
  if (options.kind === "field-create") {
    if (options.family) {
      return {
        sender: createResolvedFieldSenderSummary(options.sender, options.senderSelector),
        path: "field-reg-plus-data-update-family",
        value: options.value,
        effect: {
          kind: "create-and-initialize-field",
          tx1BurnCogtoshi: "100",
          tx2AdditionalBurnCogtoshi: "1",
        },
      };
    }

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
    case "create-and-initialize-field":
      return `burn ${effect.tx1BurnCogtoshi} cogtoshi in Tx1 and ${effect.tx2AdditionalBurnCogtoshi} additional cogtoshi in Tx2`;
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

function isActiveFamilyStatus(status: ProactiveFamilyStateRecord["status"]): boolean {
  return status === "draft"
    || status === "broadcasting"
    || status === "broadcast-unknown"
    || status === "live"
    || status === "repair-required";
}

function createFamilyTransactionRecord(): ProactiveFamilyTransactionRecord {
  return {
    status: "draft",
    attemptedTxid: null,
    attemptedWtxid: null,
    temporaryBuilderLockedOutpoints: [],
    rawHex: null,
  };
}

function upsertProactiveFamily(
  state: WalletStateV1,
  family: ProactiveFamilyStateRecord,
): WalletStateV1 {
  const families = state.proactiveFamilies.slice();
  const existingIndex = families.findIndex((entry) => entry.familyId === family.familyId);

  if (existingIndex >= 0) {
    families[existingIndex] = family;
  } else {
    families.push(family);
  }

  return {
    ...state,
    proactiveFamilies: families,
  };
}

function findFieldFamilyByIntent(
  state: WalletStateV1,
  intentFingerprintHex: string,
): ProactiveFamilyStateRecord | null {
  return state.proactiveFamilies.find((family) =>
    family.type === "field" && family.intentFingerprintHex === intentFingerprintHex
  ) ?? null;
}

function findActiveFieldFamilyByDomain(
  state: WalletStateV1,
  domainName: string,
): ProactiveFamilyStateRecord | null {
  return state.proactiveFamilies.find((family) =>
    family.type === "field"
    && family.domainName === domainName
    && isActiveFamilyStatus(family.status)
  ) ?? null;
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
  const ownerIdentity = context.model.identities.find((identity) => identity.scriptPubKeyHex === ownerHex) ?? null;

  if (ownerIdentity === null || ownerIdentity.address === null) {
    throw new Error(`${errorPrefix}_owner_not_locally_controlled`);
  }

  if (ownerIdentity.readOnly) {
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

function buildAnchoredFieldPlan(options: {
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  sender: MutationSender;
  anchorOutpoint: OutpointRecord;
  opReturnData: Uint8Array;
  errorPrefix: string;
}): FieldPlan {
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

function buildFieldFamilyTx2Plan(options: {
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  sender: MutationSender;
  tx1Txid: string;
  opReturnData: Uint8Array;
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
    fixedInputs: [{ txid: options.tx1Txid, vout: 1 }],
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
    errorPrefix: "wallet_field_create_tx2",
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

async function buildFieldTransaction(options: {
  rpc: FieldRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: FieldPlan;
}): Promise<BuiltWalletMutationTransaction> {
  return buildWalletMutationTransactionWithReserveFallback({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
    plan: options.plan,
    validateFundedDraft: validateFieldDraft,
    finalizeErrorCode: `${options.plan.errorPrefix}_finalize_failed`,
    mempoolRejectPrefix: `${options.plan.errorPrefix}_mempool_rejected`,
    reserveCandidates: options.state.proactiveReserveOutpoints,
  });
}

async function saveUpdatedState(options: {
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

function createStandaloneFieldMutation(options: {
  kind: FieldMutationKind;
  domainName: string;
  fieldName: string;
  sender: MutationSender;
  intentFingerprintHex: string;
  nowUnixMs: number;
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
    temporaryBuilderLockedOutpoints: [],
  };
}

function createFieldFamilyRecord(options: {
  domainName: string;
  domainId: number;
  fieldName: string;
  expectedFieldId: number;
  sender: MutationSender;
  permanence: boolean;
  format: number;
  valueHex: string;
  intentFingerprintHex: string;
  nowUnixMs: number;
  existing?: ProactiveFamilyStateRecord | null;
}): ProactiveFamilyStateRecord {
  if (options.existing !== null && options.existing !== undefined) {
    return {
      ...options.existing,
      type: "field",
      status: "draft",
      domainName: options.domainName,
      domainId: options.domainId,
      sourceSenderLocalIndex: options.sender.localIndex,
      sourceSenderScriptPubKeyHex: options.sender.scriptPubKeyHex,
      fieldName: options.fieldName,
      expectedFieldId: options.expectedFieldId,
      fieldPermanent: options.permanence,
      fieldFormat: options.format,
      fieldValueHex: options.valueHex,
      currentStep: "tx1",
      lastUpdatedAtUnixMs: options.nowUnixMs,
      tx1: createFamilyTransactionRecord(),
      tx2: createFamilyTransactionRecord(),
    };
  }

  return {
    familyId: randomBytes(12).toString("hex"),
    type: "field",
    status: "draft",
    intentFingerprintHex: options.intentFingerprintHex,
    createdAtUnixMs: options.nowUnixMs,
    lastUpdatedAtUnixMs: options.nowUnixMs,
    domainName: options.domainName,
    domainId: options.domainId,
    sourceSenderLocalIndex: options.sender.localIndex,
    sourceSenderScriptPubKeyHex: options.sender.scriptPubKeyHex,
    fieldName: options.fieldName,
    expectedFieldId: options.expectedFieldId,
    fieldPermanent: options.permanence,
    fieldFormat: options.format,
    fieldValueHex: options.valueHex,
    currentStep: "tx1",
    tx1: createFamilyTransactionRecord(),
    tx2: createFamilyTransactionRecord(),
  };
}

function updateFieldFamilyState(options: {
  state: WalletStateV1;
  family: ProactiveFamilyStateRecord;
  status: ProactiveFamilyStateRecord["status"];
  currentStep: ProactiveFamilyStateRecord["currentStep"];
  nowUnixMs: number;
  tx1?: ProactiveFamilyTransactionRecord | null;
  tx2?: ProactiveFamilyTransactionRecord | null;
}): WalletStateV1 {
  return upsertProactiveFamily(options.state, {
    ...options.family,
    status: options.status,
    currentStep: options.currentStep,
    lastUpdatedAtUnixMs: options.nowUnixMs,
    tx1: options.tx1 ?? options.family.tx1 ?? createFamilyTransactionRecord(),
    tx2: options.tx2 ?? options.family.tx2 ?? createFamilyTransactionRecord(),
  });
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
  unlockUntilUnixMs: number;
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
      unlockUntilUnixMs: options.unlockUntilUnixMs,
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
    nextState = await saveUpdatedState({
      state: nextState,
      provider: options.provider,
      unlockUntilUnixMs: options.unlockUntilUnixMs,
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

async function reconcileFieldFamily(options: {
  state: WalletStateV1;
  family: ProactiveFamilyStateRecord;
  provider: WalletSecretProvider;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
  unlockUntilUnixMs: number;
  rpc: FieldRpcClient;
  walletName: string;
  context: WalletReadContext;
}): Promise<{
  state: WalletStateV1;
  family: ProactiveFamilyStateRecord;
  resolution: "confirmed" | "live" | "repair-required" | "not-seen" | "continue" | "ready-for-tx2";
}> {
  const domainName = options.family.domainName ?? "";
  const fieldName = options.family.fieldName ?? "";
  const observed = getObservedFieldState(options.context, domainName, fieldName);

  if (observed !== null) {
    if (
      observed.fieldId === options.family.expectedFieldId
      && observed.permanent === options.family.fieldPermanent
      && observed.hasValue
      && observed.format === options.family.fieldFormat
      && observed.rawValueHex === options.family.fieldValueHex
    ) {
      await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.family.tx1?.temporaryBuilderLockedOutpoints ?? []);
      await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.family.tx2?.temporaryBuilderLockedOutpoints ?? []);
      let nextState = updateFieldFamilyState({
        state: options.state,
        family: options.family,
        status: "confirmed",
        currentStep: "tx2",
        nowUnixMs: options.nowUnixMs,
        tx1: options.family.tx1 == null
          ? undefined
          : { ...options.family.tx1, status: "confirmed", temporaryBuilderLockedOutpoints: [] },
        tx2: options.family.tx2 == null
          ? undefined
          : { ...options.family.tx2, status: "confirmed", temporaryBuilderLockedOutpoints: [] },
      });
      nextState = await saveUpdatedState({
        state: nextState,
        provider: options.provider,
        unlockUntilUnixMs: options.unlockUntilUnixMs,
        nowUnixMs: options.nowUnixMs,
        paths: options.paths,
      });
      return {
        state: nextState,
        family: findFieldFamilyByIntent(nextState, options.family.intentFingerprintHex) ?? {
          ...options.family,
          status: "confirmed",
        },
        resolution: "confirmed",
      };
    }

    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.family.tx1?.temporaryBuilderLockedOutpoints ?? []);
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.family.tx2?.temporaryBuilderLockedOutpoints ?? []);
    let nextState = updateFieldFamilyState({
      state: options.state,
      family: options.family,
      status: "repair-required",
      currentStep: "tx2",
      nowUnixMs: options.nowUnixMs,
      tx1: options.family.tx1 == null
        ? undefined
        : { ...options.family.tx1, temporaryBuilderLockedOutpoints: [] },
      tx2: options.family.tx2 == null
        ? undefined
        : { ...options.family.tx2, temporaryBuilderLockedOutpoints: [] },
    });
    nextState = await saveUpdatedState({
      state: nextState,
      provider: options.provider,
      unlockUntilUnixMs: options.unlockUntilUnixMs,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });
    return {
      state: nextState,
      family: findFieldFamilyByIntent(nextState, options.family.intentFingerprintHex) ?? {
        ...options.family,
        status: "repair-required",
      },
      resolution: "repair-required",
    };
  }

  const tx2Known = options.family.tx2?.attemptedTxid == null
    ? false
    : await options.rpc.getRawTransaction(options.family.tx2.attemptedTxid, true).then(() => true).catch(() => false);

  if (tx2Known) {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.family.tx2?.temporaryBuilderLockedOutpoints ?? []);
    let nextState = updateFieldFamilyState({
      state: options.state,
      family: options.family,
      status: "live",
      currentStep: "tx2",
      nowUnixMs: options.nowUnixMs,
      tx2: options.family.tx2 == null
        ? undefined
        : { ...options.family.tx2, status: "live", temporaryBuilderLockedOutpoints: [] },
    });
    nextState = await saveUpdatedState({
      state: nextState,
      provider: options.provider,
      unlockUntilUnixMs: options.unlockUntilUnixMs,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });
    return {
      state: nextState,
      family: findFieldFamilyByIntent(nextState, options.family.intentFingerprintHex) ?? {
        ...options.family,
        status: "live",
      },
      resolution: "live",
    };
  }

  const tx1Known = options.family.tx1?.attemptedTxid == null
    ? false
    : await options.rpc.getRawTransaction(options.family.tx1.attemptedTxid, true).then(() => true).catch(() => false);

  if (tx1Known) {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.family.tx1?.temporaryBuilderLockedOutpoints ?? []);
    let nextState = updateFieldFamilyState({
      state: options.state,
      family: options.family,
      status: "live",
      currentStep: "tx1",
      nowUnixMs: options.nowUnixMs,
      tx1: options.family.tx1 == null
        ? undefined
        : { ...options.family.tx1, status: "live", temporaryBuilderLockedOutpoints: [] },
    });
    nextState = await saveUpdatedState({
      state: nextState,
      provider: options.provider,
      unlockUntilUnixMs: options.unlockUntilUnixMs,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });
    return {
      state: nextState,
      family: findFieldFamilyByIntent(nextState, options.family.intentFingerprintHex) ?? {
        ...options.family,
        status: "live",
      },
      resolution: "ready-for-tx2",
    };
  }

  if (options.family.status === "broadcast-unknown"
    || options.family.status === "draft"
    || options.family.status === "broadcasting") {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.family.tx1?.temporaryBuilderLockedOutpoints ?? []);
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.family.tx2?.temporaryBuilderLockedOutpoints ?? []);
    let nextState = updateFieldFamilyState({
      state: options.state,
      family: options.family,
      status: "canceled",
      currentStep: options.family.currentStep,
      nowUnixMs: options.nowUnixMs,
      tx1: options.family.tx1 == null
        ? undefined
        : { ...options.family.tx1, status: options.family.tx1.attemptedTxid === null ? "canceled" : options.family.tx1.status, temporaryBuilderLockedOutpoints: [] },
      tx2: options.family.tx2 == null
        ? undefined
        : { ...options.family.tx2, status: options.family.tx2.attemptedTxid === null ? "canceled" : options.family.tx2.status, temporaryBuilderLockedOutpoints: [] },
    });
    nextState = await saveUpdatedState({
      state: nextState,
      provider: options.provider,
      unlockUntilUnixMs: options.unlockUntilUnixMs,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });
    return {
      state: nextState,
      family: findFieldFamilyByIntent(nextState, options.family.intentFingerprintHex) ?? {
        ...options.family,
        status: "canceled",
      },
      resolution: "not-seen",
    };
  }

  return {
    state: options.state,
    family: options.family,
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
    value: NormalizedFieldValue | null;
    sender: FieldResolvedSenderSummary;
    assumeYes?: boolean;
  },
): Promise<void> {
  const fieldRef = `${options.domainName}:${options.fieldName}`;
  prompter.writeLine(`Creating field "${fieldRef}" as ${options.permanent ? "permanent" : "mutable"}.`);
  prompter.writeLine(`Resolved sender: ${options.sender.selector} (${options.sender.address})`);

  if (options.value === null) {
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
    return;
  }

  prompter.writeLine("Path: field-reg-plus-data-update-family");
  prompter.writeLine(`Effect: ${describeFieldEffect({
    kind: "create-and-initialize-field",
    tx1BurnCogtoshi: "100",
    tx2AdditionalBurnCogtoshi: "1",
  })}.`);
  prompter.writeLine(`Value: format ${options.value.format}, ${options.value.value.length} bytes`);
  prompter.writeLine(`Initial value format: ${options.value.formatLabel}`);
  prompter.writeLine(`Initial value bytes: ${options.value.value.length}`);
  prompter.writeLine("Warning: non-clear field values are public in the mempool and on-chain.");
  prompter.writeLine("This uses the same-block FIELD_REG -> DATA_UPDATE family.");
  prompter.writeLine("Tx1 burns 0.00000100 COG. Tx2 may burn an additional 0.00000001 COG.");
  prompter.writeLine("Tx1 may confirm even if Tx2 later fails, is canceled, or needs repair.");

  if (options.permanent) {
    prompter.writeLine("This is the first non-clear value write to a permanent field.");
    await confirmTyped(
      prompter,
      fieldRef,
      `Type ${fieldRef} to continue: `,
      "wallet_field_create_confirmation_rejected",
      {
        assumeYes: options.assumeYes,
        requiresTtyErrorCode: "wallet_field_create_requires_tty",
        typedAckRequiredErrorCode: "wallet_field_create_typed_ack_required",
      },
    );
    return;
  }

  await confirmYesNo(
    prompter,
    "This creates and initializes the field in the same block family.",
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

async function sendStandaloneMutation(options: {
  rpc: FieldRpcClient;
  walletName: string;
  snapshotHeight: number | null;
  built: BuiltWalletMutationTransaction;
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
  nextState = await saveUpdatedState({
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
        nextState = await saveUpdatedState({
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
      nextState = await saveUpdatedState({
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
  nextState = await saveUpdatedState({
    state: nextState,
    provider: options.provider,
    unlockUntilUnixMs: options.unlockUntilUnixMs,
    nowUnixMs: options.nowUnixMs,
    paths: options.paths,
  });
  return { state: nextState, mutation: live };
}

async function sendFamilyTx1(options: {
  rpc: FieldRpcClient;
  walletName: string;
  snapshotHeight: number | null;
  built: BuiltWalletMutationTransaction;
  family: ProactiveFamilyStateRecord;
  state: WalletStateV1;
  provider: WalletSecretProvider;
  unlockUntilUnixMs: number;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
}): Promise<{
  state: WalletStateV1;
  family: ProactiveFamilyStateRecord;
}> {
  let nextState = updateFieldFamilyState({
    state: options.state,
    family: options.family,
    status: "broadcasting",
    currentStep: "tx1",
    nowUnixMs: options.nowUnixMs,
    tx1: {
      status: "broadcasting",
      attemptedTxid: options.built.txid,
      attemptedWtxid: options.built.wtxid,
      temporaryBuilderLockedOutpoints: options.built.temporaryBuilderLockedOutpoints,
      rawHex: options.built.rawHex,
    },
  });
  nextState = await saveUpdatedState({
    state: nextState,
    provider: options.provider,
    unlockUntilUnixMs: options.unlockUntilUnixMs,
    nowUnixMs: options.nowUnixMs,
    paths: options.paths,
  });

  if (options.snapshotHeight !== null && options.snapshotHeight !== (await options.rpc.getBlockchainInfo()).blocks) {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.built.temporaryBuilderLockedOutpoints);
    throw new Error("wallet_field_create_tx1_tip_mismatch");
  }

  try {
    await options.rpc.sendRawTransaction(options.built.rawHex);
  } catch (error) {
    if (!isAlreadyAcceptedError(error)) {
      if (isBroadcastUnknownError(error)) {
        nextState = updateFieldFamilyState({
          state: nextState,
          family: findFieldFamilyByIntent(nextState, options.family.intentFingerprintHex) ?? options.family,
          status: "broadcast-unknown",
          currentStep: "tx1",
          nowUnixMs: options.nowUnixMs,
          tx1: {
            status: "broadcast-unknown",
            attemptedTxid: options.built.txid,
            attemptedWtxid: options.built.wtxid,
            temporaryBuilderLockedOutpoints: options.built.temporaryBuilderLockedOutpoints,
            rawHex: options.built.rawHex,
          },
        });
        nextState = await saveUpdatedState({
          state: nextState,
          provider: options.provider,
          unlockUntilUnixMs: options.unlockUntilUnixMs,
          nowUnixMs: options.nowUnixMs,
          paths: options.paths,
        });
        throw new Error("wallet_field_create_tx1_broadcast_unknown");
      }

      await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.built.temporaryBuilderLockedOutpoints);
      nextState = updateFieldFamilyState({
        state: nextState,
        family: findFieldFamilyByIntent(nextState, options.family.intentFingerprintHex) ?? options.family,
        status: "canceled",
        currentStep: "tx1",
        nowUnixMs: options.nowUnixMs,
        tx1: {
          status: "canceled",
          attemptedTxid: options.built.txid,
          attemptedWtxid: options.built.wtxid,
          temporaryBuilderLockedOutpoints: [],
          rawHex: options.built.rawHex,
        },
      });
      nextState = await saveUpdatedState({
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
  nextState = updateFieldFamilyState({
    state: nextState,
    family: findFieldFamilyByIntent(nextState, options.family.intentFingerprintHex) ?? options.family,
    status: "live",
    currentStep: "tx1",
    nowUnixMs: options.nowUnixMs,
    tx1: {
      status: "live",
      attemptedTxid: options.built.txid,
      attemptedWtxid: options.built.wtxid,
      temporaryBuilderLockedOutpoints: [],
      rawHex: options.built.rawHex,
    },
  });
  nextState = await saveUpdatedState({
    state: nextState,
    provider: options.provider,
    unlockUntilUnixMs: options.unlockUntilUnixMs,
    nowUnixMs: options.nowUnixMs,
    paths: options.paths,
  });

  return {
    state: nextState,
    family: findFieldFamilyByIntent(nextState, options.family.intentFingerprintHex) ?? {
      ...options.family,
      status: "live",
    },
  };
}

async function sendFamilyTx2(options: {
  rpc: FieldRpcClient;
  walletName: string;
  built: BuiltWalletMutationTransaction;
  family: ProactiveFamilyStateRecord;
  state: WalletStateV1;
  provider: WalletSecretProvider;
  unlockUntilUnixMs: number;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
}): Promise<{
  state: WalletStateV1;
  family: ProactiveFamilyStateRecord;
}> {
  let nextState = updateFieldFamilyState({
    state: options.state,
    family: options.family,
    status: "broadcasting",
    currentStep: "tx2",
    nowUnixMs: options.nowUnixMs,
    tx2: {
      status: "broadcasting",
      attemptedTxid: options.built.txid,
      attemptedWtxid: options.built.wtxid,
      temporaryBuilderLockedOutpoints: options.built.temporaryBuilderLockedOutpoints,
      rawHex: options.built.rawHex,
    },
  });
  nextState = await saveUpdatedState({
    state: nextState,
    provider: options.provider,
    unlockUntilUnixMs: options.unlockUntilUnixMs,
    nowUnixMs: options.nowUnixMs,
    paths: options.paths,
  });

  try {
    await options.rpc.sendRawTransaction(options.built.rawHex);
  } catch (error) {
    if (!isAlreadyAcceptedError(error)) {
      if (isBroadcastUnknownError(error)) {
        nextState = updateFieldFamilyState({
          state: nextState,
          family: findFieldFamilyByIntent(nextState, options.family.intentFingerprintHex) ?? options.family,
          status: "broadcast-unknown",
          currentStep: "tx2",
          nowUnixMs: options.nowUnixMs,
          tx2: {
            status: "broadcast-unknown",
            attemptedTxid: options.built.txid,
            attemptedWtxid: options.built.wtxid,
            temporaryBuilderLockedOutpoints: options.built.temporaryBuilderLockedOutpoints,
            rawHex: options.built.rawHex,
          },
        });
        nextState = await saveUpdatedState({
          state: nextState,
          provider: options.provider,
          unlockUntilUnixMs: options.unlockUntilUnixMs,
          nowUnixMs: options.nowUnixMs,
          paths: options.paths,
        });
        throw new Error("wallet_field_create_tx2_broadcast_unknown");
      }

      await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.built.temporaryBuilderLockedOutpoints);
      nextState = updateFieldFamilyState({
        state: nextState,
        family: findFieldFamilyByIntent(nextState, options.family.intentFingerprintHex) ?? options.family,
        status: "live",
        currentStep: "tx1",
        nowUnixMs: options.nowUnixMs,
        tx2: {
          status: "canceled",
          attemptedTxid: options.built.txid,
          attemptedWtxid: options.built.wtxid,
          temporaryBuilderLockedOutpoints: [],
          rawHex: options.built.rawHex,
        },
      });
      nextState = await saveUpdatedState({
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
  nextState = updateFieldFamilyState({
    state: nextState,
    family: findFieldFamilyByIntent(nextState, options.family.intentFingerprintHex) ?? options.family,
    status: "live",
    currentStep: "tx2",
    nowUnixMs: options.nowUnixMs,
    tx2: {
      status: "live",
      attemptedTxid: options.built.txid,
      attemptedWtxid: options.built.wtxid,
      temporaryBuilderLockedOutpoints: [],
      rawHex: options.built.rawHex,
    },
  });
  nextState = await saveUpdatedState({
    state: nextState,
    provider: options.provider,
    unlockUntilUnixMs: options.unlockUntilUnixMs,
    nowUnixMs: options.nowUnixMs,
    paths: options.paths,
  });

  return {
    state: nextState,
    family: findFieldFamilyByIntent(nextState, options.family.intentFingerprintHex) ?? {
      ...options.family,
      status: "live",
    },
  };
}

async function submitStandaloneFieldMutation(options: {
  kind: FieldMutationKind;
  errorPrefix: string;
  domainName: string;
  fieldName: string;
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
  createMutation(operation: FieldOperation, existing: PendingMutationRecord | null): Promise<{
    opReturnData: Uint8Array;
    mutation: PendingMutationRecord;
  }>;
  confirm(operation: FieldOperation): Promise<void>;
}): Promise<FieldMutationResult> {
  if (!options.prompter.isInteractive && options.assumeYes !== true) {
    throw new Error(`${options.errorPrefix}_requires_tty`);
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
      const normalizedDomainName = normalizeDomainName(options.domainName);
      const normalizedFieldName = normalizeFieldName(options.fieldName);
      const operation = resolveAnchoredFieldOperation(readContext, normalizedDomainName, options.errorPrefix);
      const existingObservedField = getObservedFieldState(readContext, normalizedDomainName, normalizedFieldName);
      const intentFingerprintHex = createIntentFingerprint([
        options.kind,
        operation.state.walletRootId,
        normalizedDomainName,
        normalizedFieldName,
      ]);
      const existingMutation = findPendingMutationByIntent(operation.state, intentFingerprintHex);

      if (existingMutation !== null) {
        const node = await (options.attachService ?? attachOrStartManagedBitcoindService)({
          dataDir: options.dataDir,
          chain: "main",
          startHeight: 0,
          walletRootId: operation.state.walletRootId,
        });
        const rpc = (options.rpcFactory ?? createRpcClient)(node.rpc);
        const walletName = operation.state.managedCoreWallet.walletName;
        const reconciled = await reconcilePendingFieldMutation({
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
            fieldName: normalizedFieldName,
            fieldId: reconciled.mutation.fieldId ?? existingObservedField?.fieldId ?? null,
            txid: reconciled.mutation.attemptedTxid ?? "unknown",
            family: false,
            permanent: reconciled.mutation.fieldPermanent ?? existingObservedField?.permanent ?? null,
            format: reconciled.mutation.fieldFormat ?? existingObservedField?.format ?? null,
            status: reconciled.resolution,
            reusedExisting: true,
            resolved: createResolvedFieldSummary({
              sender: operation.sender,
              senderSelector: operation.senderSelector,
              kind: options.kind,
              family: false,
              value: createResolvedFieldValueFromStoredData(
                options.kind,
                reconciled.mutation.fieldFormat ?? existingObservedField?.format ?? null,
                reconciled.mutation.fieldValueHex,
              ),
            }),
          };
        }

        if (reconciled.resolution === "repair-required") {
          throw new Error(`${options.errorPrefix}_repair_required`);
        }
      }

      await options.confirm(operation);

      const planned = await options.createMutation(operation, existingMutation);
      let nextState = upsertPendingMutation(operation.state, planned.mutation);
      nextState = await saveUpdatedState({
        state: nextState,
        provider,
        unlockUntilUnixMs: operation.unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      const node = await (options.attachService ?? attachOrStartManagedBitcoindService)({
        dataDir: options.dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: operation.state.walletRootId,
      });
      const rpc = (options.rpcFactory ?? createRpcClient)(node.rpc);
      const walletName = operation.state.managedCoreWallet.walletName;
      const built = await buildFieldTransaction({
        rpc,
        walletName,
        state: nextState,
        plan: buildAnchoredFieldPlan({
          state: nextState,
          allUtxos: await rpc.listUnspent(walletName, 1),
          sender: operation.sender,
          anchorOutpoint: operation.anchorOutpoint,
          opReturnData: planned.opReturnData,
          errorPrefix: options.errorPrefix,
        }),
      });

      const final = await sendStandaloneMutation({
        rpc,
        walletName,
        snapshotHeight: readContext.snapshot?.tip?.height ?? null,
        built,
        mutation: nextState.pendingMutations!.find((mutation) => mutation.intentFingerprintHex === planned.mutation.intentFingerprintHex)!,
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
        fieldName: normalizedFieldName,
        fieldId: final.mutation.fieldId ?? existingObservedField?.fieldId ?? null,
        txid: final.mutation.attemptedTxid ?? built.txid,
        family: false,
        permanent: final.mutation.fieldPermanent ?? existingObservedField?.permanent ?? null,
        format: final.mutation.fieldFormat ?? existingObservedField?.format ?? null,
        status: "live",
        reusedExisting: false,
        resolved: createResolvedFieldSummary({
          sender: operation.sender,
          senderSelector: operation.senderSelector,
          kind: options.kind,
          family: false,
          value: createResolvedFieldValueFromStoredData(
            options.kind,
            planned.mutation.fieldFormat ?? existingObservedField?.format ?? null,
            planned.mutation.fieldValueHex,
          ),
        }),
      };
    } finally {
      await readContext.close();
      await miningPreemption.release();
    }
  } finally {
    await controlLock.release();
  }
}

async function submitFieldCreateFamily(options: {
  domainName: string;
  fieldName: string;
  permanent: boolean;
  value: NormalizedFieldValue;
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
}): Promise<FieldMutationResult> {
  if (!options.prompter.isInteractive && options.assumeYes !== true) {
    throw new Error("wallet_field_create_requires_tty");
  }

  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const controlLock = await acquireFileLock(paths.walletControlLockPath, {
    purpose: "wallet_field_create",
    walletRootId: null,
  });

  try {
    const miningPreemption = await pauseMiningForWalletMutation({
      paths,
      reason: "wallet_field_create",
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
      const normalizedFieldName = normalizeFieldName(options.fieldName);
      const operation = resolveAnchoredFieldOperation(readContext, normalizedDomainName, "wallet_field_create");
      const existingField = getObservedFieldState(readContext, normalizedDomainName, normalizedFieldName);

      if (existingField !== null) {
        throw new Error("wallet_field_create_field_exists");
      }

      if (operation.chainDomain.nextFieldId === 0xffff_ffff) {
        throw new Error("wallet_field_create_field_id_exhausted");
      }

      if (hex(operation.chainDomain.delegate) !== null) {
        throw new Error("wallet_field_create_delegate_blocks_same_block_family");
      }

      const senderBalance = getBalance(operation.readContext.snapshot.state, Buffer.from(operation.sender.scriptPubKeyHex, "hex"));
      if (senderBalance < 101n) {
        throw new Error("wallet_field_create_insufficient_cog");
      }

      const intentFingerprintHex = createIntentFingerprint([
        "field-create",
        operation.state.walletRootId,
        normalizedDomainName,
        normalizedFieldName,
        options.permanent ? 1 : 0,
        options.value.format,
        options.value.valueHex,
      ]);

      const existingFamily = findFieldFamilyByIntent(operation.state, intentFingerprintHex);
      const conflictingFamily = findActiveFieldFamilyByDomain(operation.state, normalizedDomainName);
      if (conflictingFamily !== null && conflictingFamily.intentFingerprintHex !== intentFingerprintHex) {
        throw new Error("wallet_field_create_family_already_active");
      }

      const conflictingCreate = findActiveFieldCreateMutationByDomain(operation.state, normalizedDomainName, intentFingerprintHex);
      if (conflictingCreate !== null) {
        throw new Error("wallet_field_create_registration_already_pending");
      }

      const node = await (options.attachService ?? attachOrStartManagedBitcoindService)({
        dataDir: options.dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: operation.state.walletRootId,
      });
      const rpc = (options.rpcFactory ?? createRpcClient)(node.rpc);
      const walletName = operation.state.managedCoreWallet.walletName;

      let workingState = operation.state;
      let resumedFamily: ProactiveFamilyStateRecord | null = null;

      if (existingFamily !== null) {
        const reconciled = await reconcileFieldFamily({
          state: workingState,
          family: existingFamily,
          provider,
          nowUnixMs,
          paths,
          unlockUntilUnixMs: operation.unlockUntilUnixMs,
          rpc,
          walletName,
          context: readContext,
        });
        workingState = reconciled.state;

        if (reconciled.resolution === "confirmed" || reconciled.resolution === "live") {
          return {
            kind: "field-create",
            domainName: normalizedDomainName,
            fieldName: normalizedFieldName,
            fieldId: reconciled.family.expectedFieldId ?? null,
            txid: reconciled.family.tx2?.attemptedTxid ?? reconciled.family.tx1?.attemptedTxid ?? "unknown",
            tx1Txid: reconciled.family.tx1?.attemptedTxid ?? null,
            tx2Txid: reconciled.family.tx2?.attemptedTxid ?? null,
            family: true,
            permanent: reconciled.family.fieldPermanent ?? null,
            format: reconciled.family.fieldFormat ?? null,
            status: reconciled.resolution,
            reusedExisting: true,
            resolved: createResolvedFieldSummary({
              sender: operation.sender,
              senderSelector: operation.senderSelector,
              kind: "field-create",
              family: true,
              value: createResolvedFieldValueFromStoredData(
                "field-create",
                reconciled.family.fieldFormat ?? null,
                reconciled.family.fieldValueHex,
              ),
            }),
          };
        }

        if (reconciled.resolution === "repair-required") {
          throw new Error("wallet_field_create_repair_required");
        }

        if (reconciled.resolution === "ready-for-tx2") {
          resumedFamily = reconciled.family;
        }
      }

      if (resumedFamily === null) {
        await confirmFieldCreate(options.prompter, {
          domainName: normalizedDomainName,
          fieldName: normalizedFieldName,
          permanent: options.permanent,
          value: options.value,
          sender: createResolvedFieldSenderSummary(operation.sender, operation.senderSelector),
          assumeYes: options.assumeYes,
        });

        let nextState = upsertProactiveFamily(
          workingState,
          createFieldFamilyRecord({
            domainName: normalizedDomainName,
            domainId: operation.chainDomain.domainId,
            fieldName: normalizedFieldName,
            expectedFieldId: operation.chainDomain.nextFieldId,
            sender: operation.sender,
            permanence: options.permanent,
            format: options.value.format,
            valueHex: options.value.valueHex,
            intentFingerprintHex,
            nowUnixMs,
            existing: existingFamily,
          }),
        );
        nextState = await saveUpdatedState({
          state: nextState,
          provider,
          unlockUntilUnixMs: operation.unlockUntilUnixMs,
          nowUnixMs,
          paths,
        });

        const family = findFieldFamilyByIntent(nextState, intentFingerprintHex)!;
        const tx1 = await buildFieldTransaction({
          rpc,
          walletName,
          state: nextState,
          plan: buildAnchoredFieldPlan({
            state: nextState,
            allUtxos: await rpc.listUnspent(walletName, 1),
            sender: operation.sender,
            anchorOutpoint: operation.anchorOutpoint,
            opReturnData: serializeFieldReg(operation.chainDomain.domainId, options.permanent, normalizedFieldName).opReturnData,
            errorPrefix: "wallet_field_create_tx1",
          }),
        });

        const afterTx1 = await sendFamilyTx1({
          rpc,
          walletName,
          snapshotHeight: readContext.snapshot?.tip?.height ?? null,
          built: tx1,
          family,
          state: nextState,
          provider,
          unlockUntilUnixMs: operation.unlockUntilUnixMs,
          nowUnixMs,
          paths,
        });
        workingState = afterTx1.state;
        resumedFamily = afterTx1.family;
      }

      const tx1Txid = resumedFamily.tx1?.attemptedTxid;
      if (tx1Txid == null) {
        throw new Error("wallet_field_create_tx1_missing");
      }

      await rpc.getRawTransaction(tx1Txid, true);

      const tx2 = await buildFieldTransaction({
        rpc,
        walletName,
        state: workingState,
        plan: buildFieldFamilyTx2Plan({
          state: workingState,
          allUtxos: await rpc.listUnspent(walletName, 1),
          sender: operation.sender,
          tx1Txid,
          opReturnData: serializeDataUpdate(
            operation.chainDomain.domainId,
            resumedFamily.expectedFieldId ?? operation.chainDomain.nextFieldId,
            options.value.format,
            options.value.value,
          ).opReturnData,
        }),
      });

      const final = await sendFamilyTx2({
        rpc,
        walletName,
        built: tx2,
        family: resumedFamily,
        state: workingState,
        provider,
        unlockUntilUnixMs: operation.unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      return {
        kind: "field-create",
        domainName: normalizedDomainName,
        fieldName: normalizedFieldName,
        fieldId: final.family.expectedFieldId ?? null,
        txid: final.family.tx2?.attemptedTxid ?? tx2.txid,
        tx1Txid,
        tx2Txid: final.family.tx2?.attemptedTxid ?? tx2.txid,
        family: true,
        permanent: final.family.fieldPermanent ?? null,
        format: final.family.fieldFormat ?? null,
        status: "live",
        reusedExisting: existingFamily !== null,
        resolved: createResolvedFieldSummary({
          sender: operation.sender,
          senderSelector: operation.senderSelector,
          kind: "field-create",
          family: true,
          value: createResolvedFieldValueSummary(options.value.format, options.value.value),
        }),
      };
    } finally {
      await readContext.close();
      await miningPreemption.release();
    }
  } finally {
    await controlLock.release();
  }
}

export async function createField(
  options: CreateFieldOptions,
): Promise<FieldMutationResult> {
  const normalizedSource = options.source == null ? null : await loadFieldValue(options.source);
  const permanent = options.permanent ?? false;

  if (normalizedSource !== null) {
    return submitFieldCreateFamily({
      ...options,
      permanent,
      value: normalizedSource,
    });
  }

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
    async createMutation(operation, existing) {
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
      const conflictFamily = findActiveFieldFamilyByDomain(operation.state, normalizedDomainName);
      if (conflictFamily !== null && conflictFamily.intentFingerprintHex !== intentFingerprintHex) {
        throw new Error("wallet_field_create_family_already_active");
      }
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
        value: null,
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
    async createMutation(operation, existing) {
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
    async createMutation(operation, existing) {
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
