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
import type { WalletPrompter } from "../lifecycle.js";
import { type WalletRuntimePaths } from "../runtime.js";
import {
  type WalletSecretProvider,
} from "../state/provider.js";
import type {
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
}

interface RegisterMutationOperation {
  state: WalletStateV1;
  normalizedDomainName: string;
  senderResolution: ResolvedRegisterSender;
  rootPriceSats: bigint;
  resolvedSummary: RegisterResolvedSummary;
  genesis: Awaited<ReturnType<typeof loadBundledGenesisParameters>>;
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
  fees: WalletMutationFeeSummary;
}

export interface RegisterDomainOptions {
  domainName: string;
  fromIdentity?: string | null;
  feeRateSatVb?: number | null;
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

  return {
    outputs,
    changePosition: outputs.length,
    expectedOpReturnScriptHex: encodeOpReturnScript(payload),
  };
}

function buildSubdomainRegisterOutputs(options: {
  domainName: string;
}): {
  outputs: unknown[];
  changePosition: number;
  expectedOpReturnScriptHex: string;
} {
  const payload = serializeDomainReg(options.domainName).opReturnData;
  return {
    outputs: [{ data: Buffer.from(payload).toString("hex") }],
    changePosition: 1,
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

  return `burn ${formatCogAmount(summary.economicEffect.amount)} from the parent owner.`;
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
        birthTime: domain.birthTime ?? Math.floor(options.nowUnixMs / 1000),
      };
    })
    : [
      ...options.state.domains,
      {
        name: options.domainName,
        domainId: null,
        currentOwnerScriptPubKeyHex: options.sender.scriptPubKeyHex,
        canonicalChainStatus: "unknown",
        foundingMessageText: existing?.foundingMessageText ?? null,
        birthTime: Math.floor(options.nowUnixMs / 1000),
      },
    ];

  return {
    ...options.state,
    domains,
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

function resolveRegisterSender(
  context: WalletReadContext & {
    localState: {
      availability: "ready";
      state: WalletStateV1;
    };
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
    model: NonNullable<WalletReadContext["model"]>;
  },
  domainName: string,
  fromIdentity: string | null | undefined,
): ResolvedRegisterSender {
  const state = context.localState.state;
  if (context.model.walletAddress === null) {
    throw new Error("wallet_register_funding_identity_unavailable");
  }
  void fromIdentity;

  if (!domainName.includes("-")) {
    return {
      registerKind: "root",
      parentDomainName: null,
      senderSelector: context.model.walletAddress,
      sender: createFundingMutationSender(state),
    };
  }

  const parent = getParent(context.snapshot.state, domainName);
  if (parent === null) {
    throw new Error("wallet_register_parent_not_found");
  }

  if (!parent.domain.anchored) {
    throw new Error("wallet_register_parent_not_anchored");
  }

  const parentDomain = context.model.domains.find((domain) => domain.name === parent.parentName) ?? null;
  if (!isLocalWalletScript(state, parentDomain?.ownerScriptPubKeyHex)) {
    throw new Error("wallet_register_parent_not_locally_controlled");
  }

  if (getBalance(context.snapshot.state, state.funding.scriptPubKeyHex) < SUBDOMAIN_REGISTRATION_FEE_COGTOSHI) {
    throw new Error("wallet_register_insufficient_cog_balance");
  }

  return {
    registerKind: "subdomain",
    parentDomainName: parent.parentName,
    senderSelector: context.model.walletAddress,
    sender: createFundingMutationSender(state),
  };
}

function createDraftMutation(options: {
  domainName: string;
  parentDomainName: string | null;
  sender: MutationSender;
  registerKind: "root" | "subdomain";
  intentFingerprintHex: string;
  nowUnixMs: number;
  feeSelection: {
    feeRateSatVb: number;
    source: "custom-satvb" | "estimated-next-block-plus-one" | "fallback-default";
  };
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
      ...createWalletMutationFeeMetadata(options.feeSelection),
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
    ...createWalletMutationFeeMetadata(options.feeSelection),
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

  const expectedWithoutChange = 1 + Number(plan.expectedTreasuryOutputIndex !== null);
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
  registerKind: "root" | "subdomain";
  domainName: string;
  parentDomainName: string | null;
  treasuryAddress: string;
  treasuryScriptPubKeyHex: string;
  rootPriceSats: bigint;
}): RegisterTransactionPlan {
  const fundingUtxos = listFundingUtxos(options.allUtxos, options.state.funding.scriptPubKeyHex);

  if (options.registerKind === "root") {
    const rootOutputs = buildRootRegisterOutputs({
      domainName: options.domainName,
      treasuryAddress: options.treasuryAddress,
      treasuryScriptPubKeyHex: options.treasuryScriptPubKeyHex,
      priceSats: options.rootPriceSats,
    });

    return {
      registerKind: "root",
      sender: options.sender,
      changeAddress: options.state.funding.address,
      fixedInputs: [],
      outputs: rootOutputs.outputs,
      changePosition: rootOutputs.changePosition,
      expectedOpReturnScriptHex: rootOutputs.expectedOpReturnScriptHex,
      expectedTreasuryOutputIndex: 1,
      expectedTreasuryScriptHex: options.treasuryScriptPubKeyHex,
      expectedTreasuryValueSats: options.rootPriceSats,
      allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
      eligibleFundingOutpointKeys: new Set(fundingUtxos.map((entry) => outpointKey(entry))),
    };
  }

  const subdomainOutputs = buildSubdomainRegisterOutputs({
    domainName: options.domainName,
  });

  return {
    registerKind: "subdomain",
    sender: options.sender,
    changeAddress: options.state.funding.address,
    fixedInputs: [],
    outputs: subdomainOutputs.outputs,
    changePosition: subdomainOutputs.changePosition,
    expectedOpReturnScriptHex: subdomainOutputs.expectedOpReturnScriptHex,
    expectedTreasuryOutputIndex: null,
    expectedTreasuryScriptHex: null,
    expectedTreasuryValueSats: null,
    allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    eligibleFundingOutpointKeys: new Set(fundingUtxos.map((entry) => outpointKey(entry))),
  };
}

async function buildRegisterTransaction(options: {
  rpc: WalletRegisterRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: RegisterTransactionPlan;
  feeRateSatVb: number;
}): Promise<BuiltRegisterTransaction> {
  return buildWalletMutationTransactionWithReserveFallback({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
    plan: options.plan,
    validateFundedDraft,
    finalizeErrorCode: "wallet_register_finalize_failed",
    mempoolRejectPrefix: "wallet_register_mempool_rejected",
    feeRate: options.feeRateSatVb,
  });
}

async function reconcilePendingRegisterMutation(options: {
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  provider: WalletSecretProvider;
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

  const normalizedDomainName = normalizeDomainName(options.domainName);
  const execution = await executeWalletMutationOperation<
    RegisterMutationOperation,
    WalletRegisterRpcClient,
    null,
    BuiltRegisterTransaction,
    RegisterDomainResult
  >({
    ...options,
    controlLockPurpose: "wallet-register",
    preemptionReason: "wallet-register",
    async resolveOperation(readContext) {
      assertWalletMutationContextReady(readContext, "wallet_register");
      const state = readContext.localState.state!;
      const senderResolution = resolveRegisterSender(readContext, normalizedDomainName, options.fromIdentity);

      if (lookupDomain(readContext.snapshot!.state, normalizedDomainName) !== null) {
        throw new Error("wallet_register_domain_already_registered");
      }

      if (readContext.snapshot!.state.consensus.nextDomainId === 0xffff_ffff) {
        throw new Error("wallet_register_next_domain_id_exhausted");
      }

      const rootPriceSats = computeRootRegistrationPriceSats(normalizedDomainName);
      const resolvedSummary = createRegisterResolvedSummary({
        registerKind: senderResolution.registerKind,
        parentDomainName: senderResolution.parentDomainName,
        senderSelector: senderResolution.senderSelector,
        sender: senderResolution.sender,
        economicEffectKind: senderResolution.registerKind === "root" ? "treasury-payment" : "cog-burn",
        economicEffectAmount: senderResolution.registerKind === "root" ? rootPriceSats : SUBDOMAIN_REGISTRATION_FEE_COGTOSHI,
      });
      const genesis = await (options.loadGenesisParameters ?? loadBundledGenesisParameters)();

      return {
        state,
        normalizedDomainName,
        senderResolution,
        rootPriceSats,
        resolvedSummary,
        genesis,
      };
    },
    createIntentFingerprint(operation) {
      return createRegisterIntentFingerprint({
        walletRootId: operation.state.walletRootId,
        domainName: operation.normalizedDomainName,
        registerKind: operation.senderResolution.registerKind,
        senderScriptPubKeyHex: operation.senderResolution.sender.scriptPubKeyHex,
      });
    },
    async resolveExistingMutation({ operation, existingMutation, execution }) {
      if (existingMutation === null) {
        return { state: operation.state, replacementFixedInputs: null, result: null };
      }

      return resolveExistingWalletMutation({
        existingMutation,
        execution,
        repairRequiredErrorCode: "wallet_register_repair_required",
        reconcileExistingMutation: (mutation) => reconcilePendingRegisterMutation({
          state: operation.state,
          mutation,
          provider: execution.provider,
          nowUnixMs: execution.nowUnixMs,
          paths: execution.paths,
          rpc: execution.rpc,
          walletName: execution.walletName,
          context: execution.readContext,
          sender: operation.senderResolution.sender,
        }),
        createReuseResult: ({ mutation, resolution, fees }) => ({
          domainName: operation.normalizedDomainName,
          registerKind: operation.senderResolution.registerKind,
          parentDomainName: operation.senderResolution.parentDomainName,
          senderSelector: operation.senderResolution.senderSelector,
          senderLocalIndex: operation.senderResolution.sender.localIndex,
          senderScriptPubKeyHex: operation.senderResolution.sender.scriptPubKeyHex,
          senderAddress: operation.senderResolution.sender.address,
          economicEffectKind: operation.senderResolution.registerKind === "root" ? "treasury-payment" : "cog-burn",
          economicEffectAmount: operation.senderResolution.registerKind === "root"
            ? operation.rootPriceSats
            : SUBDOMAIN_REGISTRATION_FEE_COGTOSHI,
          resolved: operation.resolvedSummary,
          txid: mutation.attemptedTxid ?? "unknown",
          status: resolution,
          reusedExisting: true,
          fees,
        }),
      });
    },
    async confirm({ operation, execution }) {
      if (operation.senderResolution.registerKind === "root") {
        const competingRootTxids = await findCompetingRootRegistrationTxids(
          execution.rpc,
          operation.normalizedDomainName,
        );
        if (competingRootTxids.length > 0 && !options.forceRace) {
          throw new Error("wallet_register_root_race_detected");
        }

        await confirmRootRegistration(
          options.prompter,
          operation.normalizedDomainName,
          operation.resolvedSummary,
          competingRootTxids.length > 0,
          options.assumeYes,
        );
        return;
      }

      await confirmSubdomainRegistration(
        options.prompter,
        operation.normalizedDomainName,
        operation.resolvedSummary,
        options.assumeYes,
      );
    },
    createDraftMutation({ operation, existingMutation, execution, intentFingerprintHex }) {
      return {
        mutation: createDraftMutation({
          domainName: operation.normalizedDomainName,
          parentDomainName: operation.senderResolution.parentDomainName,
          sender: operation.senderResolution.sender,
          registerKind: operation.senderResolution.registerKind,
          intentFingerprintHex,
          nowUnixMs: execution.nowUnixMs,
          feeSelection: execution.feeSelection,
          existing: existingMutation,
        }),
        prepared: null,
      };
    },
    async build({ operation, state, execution, replacementFixedInputs }) {
      const plan = buildRegisterPlan({
        context: execution.readContext,
        state,
        allUtxos: await execution.rpc.listUnspent(execution.walletName, 1),
        sender: operation.senderResolution.sender,
        registerKind: operation.senderResolution.registerKind,
        domainName: operation.normalizedDomainName,
        parentDomainName: operation.senderResolution.parentDomainName,
        treasuryAddress: operation.genesis.treasuryAddress,
        treasuryScriptPubKeyHex: Buffer.from(operation.genesis.treasuryScriptPubKey).toString("hex"),
        rootPriceSats: operation.rootPriceSats,
      });
      return buildRegisterTransaction({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        plan: {
          ...plan,
          fixedInputs: mergeFixedWalletInputs(plan.fixedInputs, replacementFixedInputs),
        },
        feeRateSatVb: execution.feeSelection.feeRateSatVb,
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
        errorPrefix: "wallet_register",
        async afterAccepted({ state: acceptedState, broadcastingMutation, built, nowUnixMs }) {
          const finalStatus = getMutationStatusAfterAcceptance({
            snapshot: execution.readContext.snapshot,
            domainName: operation.normalizedDomainName,
            senderScriptPubKeyHex: operation.senderResolution.sender.scriptPubKeyHex,
          });
          const finalMutation = updateMutationRecord(broadcastingMutation, finalStatus, nowUnixMs, {
            attemptedTxid: built.txid,
            attemptedWtxid: built.wtxid,
            temporaryBuilderLockedOutpoints: [],
          });
          return {
            state: reserveLocalDomainRecord({
              state: upsertPendingMutation(acceptedState, finalMutation),
              domainName: operation.normalizedDomainName,
              sender: operation.senderResolution.sender,
              nowUnixMs,
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
        registerKind: operation.senderResolution.registerKind,
        parentDomainName: operation.senderResolution.parentDomainName,
        senderSelector: operation.senderResolution.senderSelector,
        senderLocalIndex: operation.senderResolution.sender.localIndex,
        senderScriptPubKeyHex: operation.senderResolution.sender.scriptPubKeyHex,
        senderAddress: operation.senderResolution.sender.address,
        economicEffectKind: operation.senderResolution.registerKind === "root" ? "treasury-payment" : "cog-burn",
        economicEffectAmount: operation.senderResolution.registerKind === "root"
          ? operation.rootPriceSats
          : SUBDOMAIN_REGISTRATION_FEE_COGTOSHI,
        resolved: operation.resolvedSummary,
        txid: mutation.attemptedTxid ?? built?.txid ?? "unknown",
        status: status as RegisterDomainResult["status"],
        reusedExisting,
        fees,
      };
    },
  });

  return execution.result;
}
