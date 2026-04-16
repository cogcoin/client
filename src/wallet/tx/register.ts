import { createHash, randomBytes } from "node:crypto";

import { loadBundledGenesisParameters } from "@cogcoin/indexer";
import { getBalance, getParent, lookupDomain } from "@cogcoin/indexer/queries";

import { attachOrStartManagedBitcoindService } from "../../bitcoind/service.js";
import { createRpcClient } from "../../bitcoind/node.js";
import type {
  RpcDecodedPsbt,
  RpcListUnspentEntry,
  RpcLockedUnspent,
  RpcTestMempoolAcceptResult,
  RpcTransaction,
  RpcWalletCreateFundedPsbtResult,
  RpcWalletProcessPsbtResult,
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
  DomainRecord,
  PendingMutationRecord,
  PendingMutationStatus,
  ScriptPubKeyHex,
  WalletStateV1,
} from "../types.js";
import { computeRootRegistrationPriceSats, serializeDomainReg } from "../cogop/index.js";
import { openWalletReadContext, type WalletReadContext } from "../read/index.js";
import {
  assertFixedInputPrefixMatches,
  assertFundingInputsAfterFixedPrefix,
  assertWalletMutationContextReady,
  buildWalletMutationTransaction,
  formatCogAmount,
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
import { confirmTypedAcknowledgement, confirmYesNo } from "./confirm.js";
import {
  getCanonicalIdentitySelector,
  resolveIdentityBySelector,
} from "./identity-selector.js";
import { findPendingMutationByIntent, upsertPendingMutation } from "./journal.js";
const SUBDOMAIN_REGISTRATION_FEE_COGTOSHI = 100n;

interface WalletRegisterRpcClient extends WalletMutationRpcClient {
  getBlockchainInfo(): Promise<{
    blocks: number;
  }>;
  sendRawTransaction(hex: string): Promise<string>;
  getRawMempool(): Promise<string[]>;
  getRawTransaction(txid: string, verbose?: boolean): Promise<RpcTransaction>;
}

interface RegisterTransactionPlan {
  registerKind: "root" | "subdomain";
  sender: MutationSender;
  changeAddress: string;
  fixedInputs: FixedWalletInput[];
  outputs: unknown[];
  changePosition: number;
  expectedOpReturnScriptHex: string;
  expectedTreasuryOutputIndex: number | null;
  expectedTreasuryScriptHex: string | null;
  expectedTreasuryValueSats: bigint | null;
  expectedAnchorOutputIndex: number | null;
  expectedAnchorScriptHex: string | null;
  expectedAnchorValueSats: bigint | null;
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
}

type BuiltRegisterTransaction = BuiltWalletMutationTransaction;

type RegisterEconomicEffectKind = "treasury-payment" | "cog-burn";

export interface RegisterResolvedSenderSummary {
  selector: string;
  localIndex: number;
  scriptPubKeyHex: string;
  address: string;
}

export interface RegisterResolvedEconomicEffectSummary {
  kind: RegisterEconomicEffectKind;
  amount: bigint;
}

export interface RegisterResolvedSummary {
  path: "root" | "subdomain";
  parentDomainName: string | null;
  sender: RegisterResolvedSenderSummary;
  economicEffect: RegisterResolvedEconomicEffectSummary;
}

interface ResolvedRegisterSender {
  registerKind: "root" | "subdomain";
  parentDomainName: string | null;
  sender: MutationSender;
  senderSelector: string;
  anchorOutpoint: OutpointRecord | null;
}

export interface RegisterDomainResult {
  domainName: string;
  registerKind: "root" | "subdomain";
  parentDomainName: string | null;
  senderSelector: string;
  senderLocalIndex: number;
  senderScriptPubKeyHex: string;
  senderAddress: string;
  economicEffectKind: RegisterEconomicEffectKind;
  economicEffectAmount: bigint;
  resolved: RegisterResolvedSummary;
  txid: string;
  status: "live" | "confirmed";
  reusedExisting: boolean;
}

export interface RegisterDomainOptions {
  domainName: string;
  fromIdentity?: string | null;
  dataDir: string;
  databasePath: string;
  forceRace?: boolean;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  assumeYes?: boolean;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletRegisterRpcClient;
  loadGenesisParameters?: typeof loadBundledGenesisParameters;
}

function normalizeDomainName(domainName: string): string {
  const normalized = domainName.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("wallet_register_missing_domain");
  }
  serializeDomainReg(normalized);
  return normalized;
}

function satsToBtcNumber(value: bigint): number {
  return Number(value) / 100_000_000;
}

function valueToSats(value: number | string): bigint {
  const text = typeof value === "number" ? value.toFixed(8) : value;
  const match = /^(-?)(\d+)(?:\.(\d{0,8}))?$/.exec(text.trim());

  if (match == null) {
    throw new Error(`wallet_register_invalid_amount_${text}`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  const fraction = BigInt((match[3] ?? "").padEnd(8, "0"));
  return sign * ((whole * 100_000_000n) + fraction);
}

function createRegisterIntentFingerprint(options: {
  walletRootId: string;
  domainName: string;
  registerKind: "root" | "subdomain";
  senderScriptPubKeyHex: string;
}): string {
  return createHash("sha256")
    .update([
      "register",
      options.walletRootId,
      options.domainName,
      options.registerKind,
      options.senderScriptPubKeyHex,
    ].join("\n"))
    .digest("hex");
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

export function extractOpReturnPayloadFromScriptHex(scriptHex: string): Uint8Array | null {
  const bytes = Buffer.from(scriptHex, "hex");

  if (bytes.length < 2 || bytes[0] !== 0x6a) {
    return null;
  }

  const opcode = bytes[1];

  if (opcode <= 75) {
    const end = 2 + opcode;
    return end === bytes.length ? bytes.subarray(2, end) : null;
  }

  if (opcode === 0x4c && bytes.length >= 3) {
    const length = bytes[2];
    const end = 3 + length;
    return end === bytes.length ? bytes.subarray(3, end) : null;
  }

  return null;
}

function isSpendableConfirmedUtxo(entry: RpcListUnspentEntry): boolean {
  return entry.confirmations >= 1
    && entry.spendable !== false
    && entry.safe !== false;
}

function sortUtxos(entries: RpcListUnspentEntry[]): RpcListUnspentEntry[] {
  return entries
    .slice()
    .sort((left, right) =>
      right.amount - left.amount
      || left.txid.localeCompare(right.txid)
      || left.vout - right.vout);
}

function listFundingUtxos(
  entries: RpcListUnspentEntry[],
  fundingScriptPubKeyHex: string,
): RpcListUnspentEntry[] {
  return sortUtxos(entries.filter((entry) =>
    isSpendableConfirmedUtxo(entry) && entry.scriptPubKey === fundingScriptPubKeyHex
  ));
}

function buildRootRegisterOutputs(options: {
  domainName: string;
  treasuryAddress: string;
  treasuryScriptPubKeyHex: string;
  priceSats: bigint;
  senderAddress: string | null;
  anchorValueSats: bigint | null;
}): {
  outputs: unknown[];
  changePosition: number;
  expectedOpReturnScriptHex: string;
} {
  const payload = serializeDomainReg(options.domainName).opReturnData;
  const outputs: unknown[] = [
    { data: Buffer.from(payload).toString("hex") },
    { [options.treasuryAddress]: satsToBtcNumber(options.priceSats) },
  ];

  if (options.senderAddress !== null && options.anchorValueSats !== null) {
    outputs.push({ [options.senderAddress]: satsToBtcNumber(options.anchorValueSats) });
  }

  return {
    outputs,
    changePosition: outputs.length,
    expectedOpReturnScriptHex: encodeOpReturnScript(payload),
  };
}

function buildSubdomainRegisterOutputs(options: {
  domainName: string;
  senderAddress: string;
  anchorValueSats: bigint;
}): {
  outputs: unknown[];
  changePosition: number;
  expectedOpReturnScriptHex: string;
} {
  const payload = serializeDomainReg(options.domainName).opReturnData;
  return {
    outputs: [
      { data: Buffer.from(payload).toString("hex") },
      { [options.senderAddress]: satsToBtcNumber(options.anchorValueSats) },
    ],
    changePosition: 2,
    expectedOpReturnScriptHex: encodeOpReturnScript(payload),
  };
}

async function findCompetingRootRegistrationTxids(
  rpc: WalletRegisterRpcClient,
  domainName: string,
): Promise<string[]> {
  const targetPayloadHex = Buffer.from(serializeDomainReg(domainName).opReturnData).toString("hex");
  const txids = await rpc.getRawMempool();
  const competitors: string[] = [];

  for (const txid of txids) {
    const transaction = await rpc.getRawTransaction(txid, true).catch(() => null);

    if (transaction === null) {
      continue;
    }

    const matches = transaction.vout.some((output) => {
      const scriptHex = output.scriptPubKey?.hex;
      if (scriptHex == null) {
        return false;
      }

      const payload = extractOpReturnPayloadFromScriptHex(scriptHex);
      return payload !== null && Buffer.from(payload).toString("hex") === targetPayloadHex;
    });

    if (matches) {
      competitors.push(txid);
    }
  }

  return competitors;
}

async function confirmRootRegistration(
  prompter: WalletPrompter,
  domainName: string,
  resolved: RegisterResolvedSummary,
  competitorVisible: boolean,
  assumeYes = false,
): Promise<void> {
  writeRegisterResolvedSummary(prompter, resolved);
  prompter.writeLine(
    competitorVisible
      ? `This is a root-domain race for "${domainName}".`
      : `You are registering the root domain "${domainName}".`,
  );
  prompter.writeLine("Root domains contain no hyphen. Hyphenated names are subdomains and must not use this flow.");
  prompter.writeLine("If another valid registration confirms first, you may still pay BTC and receive no domain.");
  await confirmTypedAcknowledgement(prompter, {
    assumeYes,
    expected: domainName,
    prompt: "Type the domain name to continue: ",
    errorCode: "wallet_register_confirmation_rejected",
    requiresTtyErrorCode: "wallet_register_requires_tty",
    typedAckRequiredErrorCode: "wallet_register_typed_ack_required",
  });
}

async function confirmSubdomainRegistration(
  prompter: WalletPrompter,
  domainName: string,
  resolved: RegisterResolvedSummary,
  assumeYes = false,
): Promise<void> {
  writeRegisterResolvedSummary(prompter, resolved);
  prompter.writeLine(`You are registering the subdomain "${domainName}".`);
  await confirmYesNo(prompter, "This publishes a subdomain registration burn.", {
    assumeYes,
    errorCode: "wallet_register_confirmation_rejected",
    requiresTtyErrorCode: "wallet_register_requires_tty",
  });
}

function createRegisterResolvedSummary(options: {
  registerKind: "root" | "subdomain";
  parentDomainName: string | null;
  senderSelector: string;
  sender: MutationSender;
  economicEffectKind: RegisterEconomicEffectKind;
  economicEffectAmount: bigint;
}): RegisterResolvedSummary {
  return {
    path: options.registerKind,
    parentDomainName: options.parentDomainName,
    sender: {
      selector: options.senderSelector,
      localIndex: options.sender.localIndex,
      scriptPubKeyHex: options.sender.scriptPubKeyHex,
      address: options.sender.address,
    },
    economicEffect: {
      kind: options.economicEffectKind,
      amount: options.economicEffectAmount,
    },
  };
}

function describeRegisterEconomicEffect(summary: RegisterResolvedSummary): string {
  if (summary.economicEffect.kind === "treasury-payment") {
    return `send ${summary.economicEffect.amount.toString()} sats to the Cogcoin treasury.`;
  }

  return `burn ${formatCogAmount(summary.economicEffect.amount)} from the parent-owner identity.`;
}

function writeRegisterResolvedSummary(
  prompter: WalletPrompter,
  summary: RegisterResolvedSummary,
): void {
  prompter.writeLine(`Resolved path: ${summary.path} registration.`);

  if (summary.parentDomainName !== null) {
    prompter.writeLine(`Resolved parent: ${summary.parentDomainName}.`);
  }

  prompter.writeLine(`Resolved sender: ${summary.sender.selector} (${summary.sender.address})`);
  prompter.writeLine(`Economic effect: ${describeRegisterEconomicEffect(summary)}`);
}

function replaceAssignedDomainNames(
  identity: WalletStateV1["identities"][number],
  domainName: string,
): WalletStateV1["identities"][number] {
  if (identity.assignedDomainNames.includes(domainName)) {
    return identity;
  }

  return {
    ...identity,
    assignedDomainNames: [...identity.assignedDomainNames, domainName].sort((left, right) => left.localeCompare(right)),
  };
}

function reserveLocalDomainRecord(options: {
  state: WalletStateV1;
  domainName: string;
  sender: MutationSender;
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
        currentOwnerScriptPubKeyHex: options.sender.scriptPubKeyHex,
        currentOwnerLocalIndex: options.sender.localIndex,
        birthTime: domain.birthTime ?? Math.floor(options.nowUnixMs / 1000),
      };
    })
    : [
      ...options.state.domains,
      {
        name: options.domainName,
        domainId: null,
        dedicatedIndex: null,
        currentOwnerScriptPubKeyHex: options.sender.scriptPubKeyHex,
        currentOwnerLocalIndex: options.sender.localIndex,
        canonicalChainStatus: "unknown",
        localAnchorIntent: "none",
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: existing?.foundingMessageText ?? null,
        birthTime: Math.floor(options.nowUnixMs / 1000),
      },
    ];
  const identities = options.state.identities.map((identity) =>
    identity.index === options.sender.localIndex
      ? replaceAssignedDomainNames(identity, options.domainName)
      : identity
  );

  return {
    ...options.state,
    domains,
    identities,
  };
}

function getMutationStatusAfterAcceptance(options: {
  snapshot: WalletReadContext["snapshot"];
  domainName: string;
  senderScriptPubKeyHex: string;
}): "live" | "confirmed" {
  const chainRecord = options.snapshot === null ? null : lookupDomain(options.snapshot.state, options.domainName);
  if (chainRecord === null) {
    return "live";
  }

  return Buffer.from(chainRecord.ownerScriptPubKey).toString("hex") === options.senderScriptPubKeyHex
    ? "confirmed"
    : "live";
}

function resolveRootRegisterAnchorOutpoint(
  state: WalletStateV1,
  senderIndex: number,
): OutpointRecord | null {
  const anchoredDomain = state.domains.find((domain) =>
    domain.currentOwnerLocalIndex === senderIndex
    && domain.canonicalChainStatus === "anchored"
    && domain.currentCanonicalAnchorOutpoint !== null
  ) ?? null;

  if (
    anchoredDomain?.currentCanonicalAnchorOutpoint === undefined
    || anchoredDomain?.currentCanonicalAnchorOutpoint === null
  ) {
    return null;
  }

  return {
    txid: anchoredDomain.currentCanonicalAnchorOutpoint.txid,
    vout: anchoredDomain.currentCanonicalAnchorOutpoint.vout,
  };
}

function resolveRegisterSender(
  context: WalletReadContext & {
    localState: {
      availability: "ready";
      state: WalletStateV1;
      unlockUntilUnixMs: number;
    };
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
    model: NonNullable<WalletReadContext["model"]>;
  },
  domainName: string,
  fromIdentity: string | null | undefined,
): ResolvedRegisterSender {
  const state = context.localState.state;
  const fundingIdentity = context.model.fundingIdentity;

  if (fundingIdentity == null || fundingIdentity.address === null) {
    throw new Error("wallet_register_funding_identity_unavailable");
  }

  if (!domainName.includes("-")) {
    if (fromIdentity !== null && fromIdentity !== undefined) {
      const selectedIdentity = resolveIdentityBySelector(context, fromIdentity, "wallet_register");

      if (selectedIdentity.address === null) {
        throw new Error("wallet_register_sender_address_unavailable");
      }

      if (selectedIdentity.readOnly) {
        throw new Error("wallet_register_sender_read_only");
      }

      if (selectedIdentity.index === fundingIdentity.index) {
        return {
          registerKind: "root",
          parentDomainName: null,
          senderSelector: getCanonicalIdentitySelector(selectedIdentity),
          sender: {
            localIndex: selectedIdentity.index,
            scriptPubKeyHex: selectedIdentity.scriptPubKeyHex,
            address: selectedIdentity.address,
          },
          anchorOutpoint: null,
        };
      }

      const anchorOutpoint = resolveRootRegisterAnchorOutpoint(state, selectedIdentity.index);

      if (anchorOutpoint === null) {
        throw new Error("wallet_register_sender_not_root_eligible");
      }

      return {
        registerKind: "root",
        parentDomainName: null,
        senderSelector: getCanonicalIdentitySelector(selectedIdentity),
        sender: {
          localIndex: selectedIdentity.index,
          scriptPubKeyHex: selectedIdentity.scriptPubKeyHex,
          address: selectedIdentity.address,
        },
        anchorOutpoint,
      };
    }

    return {
      registerKind: "root",
      parentDomainName: null,
      senderSelector: getCanonicalIdentitySelector(fundingIdentity),
      sender: {
        localIndex: fundingIdentity.index,
        scriptPubKeyHex: fundingIdentity.scriptPubKeyHex,
        address: fundingIdentity.address,
      },
      anchorOutpoint: null,
    };
  }

  if (fromIdentity !== null && fromIdentity !== undefined) {
    throw new Error("wallet_register_from_not_supported_for_subdomain");
  }

  const parent = getParent(context.snapshot.state, domainName);
  if (parent === null) {
    throw new Error("wallet_register_parent_not_found");
  }

  if (!parent.domain.anchored) {
    throw new Error("wallet_register_parent_not_anchored");
  }

  const parentDomain = context.model.domains.find((domain) => domain.name === parent.parentName) ?? null;
  if (parentDomain?.ownerLocalIndex === null || parentDomain?.ownerLocalIndex === undefined) {
    throw new Error("wallet_register_parent_not_locally_controlled");
  }

  if (parentDomain.readOnly) {
    throw new Error("wallet_register_parent_read_only");
  }

  const senderIdentity = context.model.identities.find((identity) => identity.index === parentDomain.ownerLocalIndex) ?? null;
  if (senderIdentity === null || senderIdentity.address === null) {
    throw new Error("wallet_register_sender_identity_unavailable");
  }

  if (getBalance(context.snapshot.state, senderIdentity.scriptPubKeyHex) < SUBDOMAIN_REGISTRATION_FEE_COGTOSHI) {
    throw new Error("wallet_register_insufficient_cog_balance");
  }

  const localParentRecord = state.domains.find((domain) => domain.name === parent.parentName) ?? null;
  const anchorOutpoint = localParentRecord?.currentCanonicalAnchorOutpoint ?? null;
  if (anchorOutpoint === null) {
    throw new Error("wallet_register_anchor_outpoint_unavailable");
  }

  return {
    registerKind: "subdomain",
    parentDomainName: parent.parentName,
    senderSelector: getCanonicalIdentitySelector(senderIdentity),
    sender: {
      localIndex: senderIdentity.index,
      scriptPubKeyHex: senderIdentity.scriptPubKeyHex,
      address: senderIdentity.address,
    },
    anchorOutpoint: {
      txid: anchorOutpoint.txid,
      vout: anchorOutpoint.vout,
    },
  };
}

function createDraftMutation(options: {
  domainName: string;
  parentDomainName: string | null;
  sender: MutationSender;
  registerKind: "root" | "subdomain";
  intentFingerprintHex: string;
  nowUnixMs: number;
  existing?: PendingMutationRecord | null;
}): PendingMutationRecord {
  if (options.existing !== null && options.existing !== undefined) {
    return {
      ...options.existing,
      registerKind: options.registerKind,
      parentDomainName: options.parentDomainName,
      senderScriptPubKeyHex: options.sender.scriptPubKeyHex,
      senderLocalIndex: options.sender.localIndex,
      status: "draft",
      lastUpdatedAtUnixMs: options.nowUnixMs,
      attemptedTxid: null,
      attemptedWtxid: null,
      temporaryBuilderLockedOutpoints: [],
    };
  }

  return {
    mutationId: randomBytes(12).toString("hex"),
    kind: "register",
    registerKind: options.registerKind,
    domainName: options.domainName,
    parentDomainName: options.parentDomainName,
    senderScriptPubKeyHex: options.sender.scriptPubKeyHex,
    senderLocalIndex: options.sender.localIndex,
    intentFingerprintHex: options.intentFingerprintHex,
    status: "draft",
    createdAtUnixMs: options.nowUnixMs,
    lastUpdatedAtUnixMs: options.nowUnixMs,
    attemptedTxid: null,
    attemptedWtxid: null,
    temporaryBuilderLockedOutpoints: [],
  };
}

function validateFundedDraft(
  decoded: RpcDecodedPsbt,
  funded: RpcWalletCreateFundedPsbtResult,
  plan: RegisterTransactionPlan,
): void {
  const inputs = decoded.tx.vin;
  const outputs = decoded.tx.vout;

  if (inputs.length === 0) {
    throw new Error("wallet_register_missing_sender_input");
  }

  assertFixedInputPrefixMatches(inputs, plan.fixedInputs, "wallet_register_sender_input_mismatch");

  if (inputs[0]?.prevout?.scriptPubKey?.hex !== plan.sender.scriptPubKeyHex) {
    throw new Error("wallet_register_sender_input_mismatch");
  }

  assertFundingInputsAfterFixedPrefix({
    inputs,
    fixedInputs: plan.fixedInputs,
    allowedFundingScriptPubKeyHex: plan.allowedFundingScriptPubKeyHex,
    eligibleFundingOutpointKeys: plan.eligibleFundingOutpointKeys,
    errorCode: "wallet_register_unexpected_funding_input",
  });

  if (outputs[0]?.scriptPubKey?.hex !== plan.expectedOpReturnScriptHex) {
    throw new Error("wallet_register_opreturn_mismatch");
  }

  if (plan.expectedTreasuryScriptHex !== null && plan.expectedTreasuryOutputIndex !== null) {
    if (outputs[plan.expectedTreasuryOutputIndex]?.scriptPubKey?.hex !== plan.expectedTreasuryScriptHex) {
      throw new Error("wallet_register_treasury_output_mismatch");
    }

    if (valueToSats(outputs[plan.expectedTreasuryOutputIndex]?.value ?? 0) < (plan.expectedTreasuryValueSats ?? 0n)) {
      throw new Error("wallet_register_treasury_value_too_small");
    }
  }

  if (plan.expectedAnchorScriptHex !== null && plan.expectedAnchorOutputIndex !== null) {
    if (outputs[plan.expectedAnchorOutputIndex]?.scriptPubKey?.hex !== plan.expectedAnchorScriptHex) {
      throw new Error("wallet_register_anchor_output_mismatch");
    }

    if (valueToSats(outputs[plan.expectedAnchorOutputIndex]?.value ?? 0) !== (plan.expectedAnchorValueSats ?? 0n)) {
      throw new Error("wallet_register_anchor_value_mismatch");
    }
  }

  const expectedWithoutChange = 1
    + Number(plan.expectedTreasuryOutputIndex !== null)
    + Number(plan.expectedAnchorOutputIndex !== null);
  if (funded.changepos === -1) {
    if (outputs.length !== expectedWithoutChange) {
      throw new Error("wallet_register_unexpected_output_count");
    }
    return;
  }

  if (funded.changepos !== plan.changePosition || outputs.length !== expectedWithoutChange + 1) {
    throw new Error("wallet_register_change_position_mismatch");
  }

  if (outputs[funded.changepos]?.scriptPubKey?.hex !== plan.allowedFundingScriptPubKeyHex) {
    throw new Error("wallet_register_change_output_mismatch");
  }
}

function buildRegisterPlan(options: {
  context: WalletReadContext;
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  sender: MutationSender;
  anchorOutpoint: OutpointRecord | null;
  registerKind: "root" | "subdomain";
  domainName: string;
  parentDomainName: string | null;
  treasuryAddress: string;
  treasuryScriptPubKeyHex: string;
  anchorValueSats: bigint;
  rootPriceSats: bigint;
}): RegisterTransactionPlan {
  const fundingUtxos = listFundingUtxos(options.allUtxos, options.state.funding.scriptPubKeyHex);

  if (options.registerKind === "root") {
    const rootOutputs = buildRootRegisterOutputs({
      domainName: options.domainName,
      treasuryAddress: options.treasuryAddress,
      treasuryScriptPubKeyHex: options.treasuryScriptPubKeyHex,
      priceSats: options.rootPriceSats,
      senderAddress: options.anchorOutpoint === null ? null : options.sender.address,
      anchorValueSats: options.anchorOutpoint === null ? null : options.anchorValueSats,
    });

    if (options.anchorOutpoint === null) {
      if (fundingUtxos.length === 0) {
        throw new Error("wallet_register_sender_utxo_unavailable");
      }

      const senderInput = fundingUtxos[0]!;
      const additionalFunding = fundingUtxos
        .slice(1)
        .map((entry) => ({ txid: entry.txid, vout: entry.vout }));

      return {
        registerKind: "root",
        sender: options.sender,
        changeAddress: options.state.funding.address,
        fixedInputs: [
          { txid: senderInput.txid, vout: senderInput.vout },
        ],
        outputs: rootOutputs.outputs,
        changePosition: rootOutputs.changePosition,
        expectedOpReturnScriptHex: rootOutputs.expectedOpReturnScriptHex,
        expectedTreasuryOutputIndex: 1,
        expectedTreasuryScriptHex: options.treasuryScriptPubKeyHex,
        expectedTreasuryValueSats: options.rootPriceSats,
        expectedAnchorOutputIndex: null,
        expectedAnchorScriptHex: null,
        expectedAnchorValueSats: null,
        allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
        eligibleFundingOutpointKeys: new Set(additionalFunding.map((entry) => outpointKey(entry))),
      };
    }

    const anchorUtxo = options.allUtxos.find((entry) =>
      entry.txid === options.anchorOutpoint?.txid
      && entry.vout === options.anchorOutpoint.vout
      && entry.scriptPubKey === options.sender.scriptPubKeyHex
      && isSpendableConfirmedUtxo(entry)
    );

    if (anchorUtxo === undefined) {
      throw new Error("wallet_register_anchor_utxo_missing");
    }

    return {
      registerKind: "root",
      sender: options.sender,
      changeAddress: options.state.funding.address,
      fixedInputs: [
        { txid: anchorUtxo.txid, vout: anchorUtxo.vout },
      ],
      outputs: rootOutputs.outputs,
      changePosition: rootOutputs.changePosition,
      expectedOpReturnScriptHex: rootOutputs.expectedOpReturnScriptHex,
      expectedTreasuryOutputIndex: 1,
      expectedTreasuryScriptHex: options.treasuryScriptPubKeyHex,
      expectedTreasuryValueSats: options.rootPriceSats,
      expectedAnchorOutputIndex: 2,
      expectedAnchorScriptHex: options.sender.scriptPubKeyHex,
      expectedAnchorValueSats: options.anchorValueSats,
      allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
      eligibleFundingOutpointKeys: new Set(fundingUtxos.map((entry) => outpointKey(entry))),
    };
  }

  const anchor = options.anchorOutpoint;
  if (anchor === null) {
    throw new Error("wallet_register_anchor_outpoint_unavailable");
  }

  const anchorUtxo = options.allUtxos.find((entry) =>
    entry.txid === anchor.txid
    && entry.vout === anchor.vout
    && entry.scriptPubKey === options.sender.scriptPubKeyHex
    && isSpendableConfirmedUtxo(entry)
  );

  if (anchorUtxo === undefined) {
    throw new Error("wallet_register_anchor_utxo_missing");
  }

  const subdomainOutputs = buildSubdomainRegisterOutputs({
    domainName: options.domainName,
    senderAddress: options.sender.address,
    anchorValueSats: options.anchorValueSats,
  });

  return {
    registerKind: "subdomain",
    sender: options.sender,
    changeAddress: options.state.funding.address,
    fixedInputs: [
      { txid: anchorUtxo.txid, vout: anchorUtxo.vout },
    ],
    outputs: subdomainOutputs.outputs,
    changePosition: subdomainOutputs.changePosition,
    expectedOpReturnScriptHex: subdomainOutputs.expectedOpReturnScriptHex,
    expectedTreasuryOutputIndex: null,
    expectedTreasuryScriptHex: null,
    expectedTreasuryValueSats: null,
    expectedAnchorOutputIndex: 1,
    expectedAnchorScriptHex: options.sender.scriptPubKeyHex,
    expectedAnchorValueSats: options.anchorValueSats,
    allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    eligibleFundingOutpointKeys: new Set(fundingUtxos.map((entry) => outpointKey(entry))),
  };
}

async function buildRegisterTransaction(options: {
  rpc: WalletRegisterRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: RegisterTransactionPlan;
}): Promise<BuiltRegisterTransaction> {
  return buildWalletMutationTransaction({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
    plan: options.plan,
    validateFundedDraft,
    finalizeErrorCode: "wallet_register_finalize_failed",
    mempoolRejectPrefix: "wallet_register_mempool_rejected",
  });
}

async function reconcilePendingRegisterMutation(options: {
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  provider: WalletSecretProvider;
  unlockUntilUnixMs: number;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
  rpc: WalletRegisterRpcClient;
  walletName: string;
  context: WalletReadContext;
  sender: MutationSender;
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
    const chainOwnerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");

    if (chainOwnerHex !== options.sender.scriptPubKeyHex) {
      const repairMutation = updateMutationRecord(options.mutation, "repair-required", options.nowUnixMs, {
        temporaryBuilderLockedOutpoints: [],
      });
      const nextState = upsertPendingMutation(options.state, repairMutation);
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider: options.provider,
        unlockUntilUnixMs: options.unlockUntilUnixMs,
        nowUnixMs: options.nowUnixMs,
        paths: options.paths,
      });

      return {
        state: nextState,
        mutation: repairMutation,
        resolution: "repair-required",
      };
    }

    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, options.mutation.temporaryBuilderLockedOutpoints);
    const confirmedMutation = updateMutationRecord(options.mutation, "confirmed", options.nowUnixMs, {
      temporaryBuilderLockedOutpoints: [],
    });
    const nextState = reserveLocalDomainRecord({
      state: upsertPendingMutation(options.state, confirmedMutation),
      domainName: options.mutation.domainName,
      sender: options.sender,
      nowUnixMs: options.nowUnixMs,
    });
    await saveWalletStatePreservingUnlock({
      state: nextState,
      provider: options.provider,
      unlockUntilUnixMs: options.unlockUntilUnixMs,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });

    return {
      state: nextState,
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
      const nextState = reserveLocalDomainRecord({
        state: upsertPendingMutation(options.state, liveMutation),
        domainName: options.mutation.domainName,
        sender: options.sender,
        nowUnixMs: options.nowUnixMs,
      });
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider: options.provider,
        unlockUntilUnixMs: options.unlockUntilUnixMs,
        nowUnixMs: options.nowUnixMs,
        paths: options.paths,
      });

      return {
        state: nextState,
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
    await saveWalletStatePreservingUnlock({
      state: nextState,
      provider: options.provider,
      unlockUntilUnixMs: options.unlockUntilUnixMs,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });

    return {
      state: nextState,
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

export async function registerDomain(options: RegisterDomainOptions): Promise<RegisterDomainResult> {
  if (!options.prompter.isInteractive && options.assumeYes !== true) {
    throw new Error("wallet_register_requires_tty");
  }

  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const controlLock = await acquireFileLock(paths.walletControlLockPath, {
    purpose: "wallet-register",
    walletRootId: null,
  });
  const normalizedDomainName = normalizeDomainName(options.domainName);

  try {
    const miningPreemption = await pauseMiningForWalletMutation({
      paths,
      reason: "wallet-register",
    });
    const readContext = await (options.openReadContext ?? openWalletReadContext)({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      secretProvider: provider,
      walletControlLockHeld: true,
      paths,
    });

    try {
      assertWalletMutationContextReady(readContext, "wallet_register");
      const state = readContext.localState.state!;
      const unlockUntilUnixMs = readContext.localState.unlockUntilUnixMs!;
      const senderResolution = resolveRegisterSender(readContext, normalizedDomainName, options.fromIdentity);
      const intentFingerprintHex = createRegisterIntentFingerprint({
        walletRootId: state.walletRootId,
        domainName: normalizedDomainName,
        registerKind: senderResolution.registerKind,
        senderScriptPubKeyHex: senderResolution.sender.scriptPubKeyHex,
      });
      const rootPriceSats = computeRootRegistrationPriceSats(normalizedDomainName);
      const resolvedSummary = createRegisterResolvedSummary({
        registerKind: senderResolution.registerKind,
        parentDomainName: senderResolution.parentDomainName,
        senderSelector: senderResolution.senderSelector,
        sender: senderResolution.sender,
        economicEffectKind: senderResolution.registerKind === "root" ? "treasury-payment" : "cog-burn",
        economicEffectAmount: senderResolution.registerKind === "root" ? rootPriceSats : SUBDOMAIN_REGISTRATION_FEE_COGTOSHI,
      });
      const node = await (options.attachService ?? attachOrStartManagedBitcoindService)({
        dataDir: options.dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: state.walletRootId,
      });
      const rpc = (options.rpcFactory ?? createRpcClient)(node.rpc);
      const walletName = state.managedCoreWallet.walletName;
      const existingMutation = findPendingMutationByIntent(state, intentFingerprintHex);

      if (existingMutation !== null) {
        const reconciled = await reconcilePendingRegisterMutation({
          state,
          mutation: existingMutation,
          provider,
          unlockUntilUnixMs,
          nowUnixMs,
          paths,
          rpc,
          walletName,
          context: readContext,
          sender: senderResolution.sender,
        });

        if (reconciled.resolution === "confirmed" || reconciled.resolution === "live") {
          return {
            domainName: normalizedDomainName,
            registerKind: senderResolution.registerKind,
            parentDomainName: senderResolution.parentDomainName,
            senderSelector: senderResolution.senderSelector,
            senderLocalIndex: senderResolution.sender.localIndex,
            senderScriptPubKeyHex: senderResolution.sender.scriptPubKeyHex,
            senderAddress: senderResolution.sender.address,
            economicEffectKind: senderResolution.registerKind === "root" ? "treasury-payment" : "cog-burn",
            economicEffectAmount: senderResolution.registerKind === "root" ? rootPriceSats : SUBDOMAIN_REGISTRATION_FEE_COGTOSHI,
            resolved: resolvedSummary,
            txid: reconciled.mutation.attemptedTxid ?? "unknown",
            status: reconciled.resolution,
            reusedExisting: true,
          };
        }

        if (reconciled.resolution === "repair-required") {
          throw new Error("wallet_register_repair_required");
        }
      }

      if (lookupDomain(readContext.snapshot!.state, normalizedDomainName) !== null) {
        throw new Error("wallet_register_domain_already_registered");
      }

      if (readContext.snapshot!.state.consensus.nextDomainId === 0xffff_ffff) {
        throw new Error("wallet_register_next_domain_id_exhausted");
      }

      const genesis = await (options.loadGenesisParameters ?? loadBundledGenesisParameters)();
      const competingRootTxids = senderResolution.registerKind === "root"
        ? await findCompetingRootRegistrationTxids(rpc, normalizedDomainName)
        : [];

      if (senderResolution.registerKind === "root") {
        if (competingRootTxids.length > 0 && !options.forceRace) {
          throw new Error("wallet_register_root_race_detected");
        }

        await confirmRootRegistration(
          options.prompter,
          normalizedDomainName,
          resolvedSummary,
          competingRootTxids.length > 0,
          options.assumeYes,
        );
      } else {
        await confirmSubdomainRegistration(
          options.prompter,
          normalizedDomainName,
          resolvedSummary,
          options.assumeYes,
        );
      }

      let nextState = upsertPendingMutation(
        state,
        createDraftMutation({
          domainName: normalizedDomainName,
          parentDomainName: senderResolution.parentDomainName,
          sender: senderResolution.sender,
          registerKind: senderResolution.registerKind,
          intentFingerprintHex,
          nowUnixMs,
          existing: existingMutation,
        }),
      );
      nextState = {
        ...nextState,
        stateRevision: nextState.stateRevision + 1,
        lastWrittenAtUnixMs: nowUnixMs,
      };
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider,
        unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      const allUtxos = await rpc.listUnspent(walletName, 1);
      const plan = buildRegisterPlan({
        context: readContext,
        state: nextState,
        allUtxos,
        sender: senderResolution.sender,
        anchorOutpoint: senderResolution.anchorOutpoint,
        registerKind: senderResolution.registerKind,
        domainName: normalizedDomainName,
        parentDomainName: senderResolution.parentDomainName,
        treasuryAddress: genesis.treasuryAddress,
        treasuryScriptPubKeyHex: Buffer.from(genesis.treasuryScriptPubKey).toString("hex"),
        anchorValueSats: BigInt(nextState.anchorValueSats),
        rootPriceSats,
      });
      const built = await buildRegisterTransaction({
        rpc,
        walletName,
        state: nextState,
        plan,
      });

      const currentMutation = nextState.pendingMutations?.find((mutation) => mutation.intentFingerprintHex === intentFingerprintHex)
        ?? createDraftMutation({
          domainName: normalizedDomainName,
          parentDomainName: senderResolution.parentDomainName,
          sender: senderResolution.sender,
          registerKind: senderResolution.registerKind,
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
      nextState = {
        ...upsertPendingMutation(nextState, broadcastingMutation),
        stateRevision: nextState.stateRevision + 1,
        lastWrittenAtUnixMs: nowUnixMs,
      };
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider,
        unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      const bestHeight = (await rpc.getBlockchainInfo()).blocks;
      if (readContext.snapshot?.tip?.height !== bestHeight) {
        await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
        throw new Error("wallet_register_tip_mismatch");
      }

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
          nextState = {
            ...upsertPendingMutation(nextState, unknownMutation),
            stateRevision: nextState.stateRevision + 1,
            lastWrittenAtUnixMs: nowUnixMs,
          };
          await saveWalletStatePreservingUnlock({
            state: nextState,
            provider,
            unlockUntilUnixMs,
            nowUnixMs,
            paths,
          });
          throw new Error("wallet_register_broadcast_unknown");
        } else {
          await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
          const canceledMutation = updateMutationRecord(broadcastingMutation, "canceled", nowUnixMs, {
            attemptedTxid: built.txid,
            attemptedWtxid: built.wtxid,
            temporaryBuilderLockedOutpoints: [],
          });
          nextState = {
            ...upsertPendingMutation(nextState, canceledMutation),
            stateRevision: nextState.stateRevision + 1,
            lastWrittenAtUnixMs: nowUnixMs,
          };
          await saveWalletStatePreservingUnlock({
            state: nextState,
            provider,
            unlockUntilUnixMs,
            nowUnixMs,
            paths,
          });
          throw error;
        }
      }

      if (!accepted) {
        throw new Error("wallet_register_broadcast_failed");
      }

      await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
      const finalStatus = getMutationStatusAfterAcceptance({
        snapshot: readContext.snapshot,
        domainName: normalizedDomainName,
        senderScriptPubKeyHex: senderResolution.sender.scriptPubKeyHex,
      });
      const finalMutation = updateMutationRecord(broadcastingMutation, finalStatus, nowUnixMs, {
        attemptedTxid: built.txid,
        attemptedWtxid: built.wtxid,
        temporaryBuilderLockedOutpoints: [],
      });
      nextState = reserveLocalDomainRecord({
        state: upsertPendingMutation(nextState, finalMutation),
        domainName: normalizedDomainName,
        sender: senderResolution.sender,
        nowUnixMs,
      });
      nextState = {
        ...nextState,
        stateRevision: nextState.stateRevision + 1,
        lastWrittenAtUnixMs: nowUnixMs,
      };
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider,
        unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      return {
        domainName: normalizedDomainName,
        registerKind: senderResolution.registerKind,
        parentDomainName: senderResolution.parentDomainName,
        senderSelector: senderResolution.senderSelector,
        senderLocalIndex: senderResolution.sender.localIndex,
        senderScriptPubKeyHex: senderResolution.sender.scriptPubKeyHex,
        senderAddress: senderResolution.sender.address,
        economicEffectKind: senderResolution.registerKind === "root" ? "treasury-payment" : "cog-burn",
        economicEffectAmount: senderResolution.registerKind === "root" ? rootPriceSats : SUBDOMAIN_REGISTRATION_FEE_COGTOSHI,
        resolved: resolvedSummary,
        txid: built.txid,
        status: finalStatus,
        reusedExisting: false,
      };
    } finally {
      await readContext.close();
      await miningPreemption.release();
    }
  } finally {
    await controlLock.release();
  }
}
