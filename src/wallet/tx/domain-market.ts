import { createHash, randomBytes } from "node:crypto";

import { getBalance, getListing, lookupDomain } from "@cogcoin/indexer/queries";

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
  DomainRecord,
  OutpointRecord,
  PendingMutationRecord,
  WalletStateV1,
} from "../types.js";
import {
  serializeDomainBuy,
  serializeDomainSell,
  serializeDomainTransfer,
  validateDomainName,
} from "../cogop/index.js";
import { openWalletReadContext, type WalletReadContext } from "../read/index.js";
import {
  assertWalletMutationContextReady,
  buildWalletMutationTransaction,
  isAlreadyAcceptedError,
  isBroadcastUnknownError,
  pauseMiningForWalletMutation,
  saveWalletStatePreservingUnlock,
  unlockTemporaryBuilderLocks,
  updateMutationRecord,
  type BuiltWalletMutationTransaction,
  type MutationSender,
  type WalletMutationRpcClient,
} from "./common.js";
import { confirmTypedAcknowledgement, confirmYesNo } from "./confirm.js";
import {
  getCanonicalIdentitySelector,
  resolveIdentityBySelector,
} from "./identity-selector.js";
import { findPendingMutationByIntent, upsertPendingMutation } from "./journal.js";
import { normalizeBtcTarget } from "./targets.js";

type DomainMarketKind = "transfer" | "sell" | "buy";

interface DomainMarketRpcClient extends WalletMutationRpcClient {
  getBlockchainInfo(): Promise<{
    blocks: number;
  }>;
  sendRawTransaction(hex: string): Promise<string>;
  getRawMempool(): Promise<string[]>;
  getRawTransaction(txid: string, verbose?: boolean): Promise<RpcTransaction>;
}

interface DomainMarketPlan {
  sender: MutationSender;
  changeAddress: string;
  inputs: Array<{ txid: string; vout: number }>;
  outputs: unknown[];
  changePosition: number;
  expectedOpReturnScriptHex: string;
  expectedAnchorScriptHex: string | null;
  expectedAnchorValueSats: bigint | null;
  allowedFundingScriptPubKeyHex: string;
  errorPrefix: string;
}

interface BuiltDomainMarketTransaction extends BuiltWalletMutationTransaction {}

interface DomainOperationContext {
  readContext: WalletReadContext;
  state: WalletStateV1;
  unlockUntilUnixMs: number;
  sender: MutationSender;
  senderSelector: string;
  anchorOutpoint: OutpointRecord | null;
  chainDomain: NonNullable<ReturnType<typeof lookupDomain>>;
}

interface BuyOperationContext extends DomainOperationContext {
  listingPriceCogtoshi: bigint;
  buyerSelector: string;
}

export interface DomainMarketResolvedSenderSummary {
  selector: string;
  localIndex: number;
  scriptPubKeyHex: string;
  address: string;
}

export interface DomainMarketResolvedRecipientSummary {
  scriptPubKeyHex: string;
  address: string | null;
  opaque: boolean;
}

export interface DomainMarketResolvedBuyerSummary {
  selector: string;
  localIndex: number;
  scriptPubKeyHex: string;
  address: string;
}

export interface DomainMarketResolvedSellerSummary {
  scriptPubKeyHex: string;
  address: string | null;
}

export type DomainMarketResolvedEconomicEffect =
  | {
    kind: "ownership-transfer";
    clearsListing: boolean;
  }
  | {
    kind: "listing-set";
    listedPriceCogtoshi: string;
  }
  | {
    kind: "listing-clear";
    listedPriceCogtoshi: "0";
  };

export interface DomainMarketResolvedSummary {
  sender: DomainMarketResolvedSenderSummary;
  recipient?: DomainMarketResolvedRecipientSummary | null;
  economicEffect: DomainMarketResolvedEconomicEffect;
}

export interface TransferDomainOptions {
  domainName: string;
  target: string;
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  assumeYes?: boolean;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => DomainMarketRpcClient;
}

export interface SellDomainOptions {
  domainName: string;
  listedPriceCogtoshi: bigint;
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  assumeYes?: boolean;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => DomainMarketRpcClient;
}

export interface BuyDomainOptions {
  domainName: string;
  fromIdentity?: string | null;
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  assumeYes?: boolean;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  openReadContext?: typeof openWalletReadContext;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => DomainMarketRpcClient;
}

export interface DomainMarketMutationResult {
  kind: DomainMarketKind;
  domainName: string;
  txid: string;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  listedPriceCogtoshi?: bigint;
  recipientScriptPubKeyHex?: string | null;
  resolved?: DomainMarketResolvedSummary | null;
  resolvedBuyer?: DomainMarketResolvedBuyerSummary | null;
  resolvedSeller?: DomainMarketResolvedSellerSummary | null;
}

function normalizeDomainName(domainName: string): string {
  const normalized = domainName.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("wallet_domain_missing_domain");
  }
  validateDomainName(normalized);
  return normalized;
}

export function parseCogAmountToCogtoshi(raw: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{0,8}))?$/.exec(raw.trim());

  if (match == null) {
    throw new Error(`wallet_sell_invalid_amount_${raw}`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  const fraction = BigInt((match[3] ?? "").padEnd(8, "0"));
  return sign * ((whole * 100_000_000n) + fraction);
}

function satsToBtcNumber(value: bigint): number {
  return Number(value) / 100_000_000;
}

function valueToSats(value: number | string): bigint {
  const text = typeof value === "number" ? value.toFixed(8) : value;
  const match = /^(-?)(\d+)(?:\.(\d{0,8}))?$/.exec(text.trim());

  if (match == null) {
    throw new Error(`wallet_domain_invalid_amount_${text}`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  const fraction = BigInt((match[3] ?? "").padEnd(8, "0"));
  return sign * ((whole * 100_000_000n) + fraction);
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

function createIntentFingerprint(parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\n"))
    .digest("hex");
}

function replaceAssignedDomainNames(
  identity: WalletStateV1["identities"][number],
  nextAssignedDomainNames: string[],
): WalletStateV1["identities"][number] {
  return {
    ...identity,
    assignedDomainNames: nextAssignedDomainNames.slice().sort((left, right) => left.localeCompare(right)),
  };
}

function reserveTransferredDomainRecord(options: {
  state: WalletStateV1;
  domainName: string;
  domainId: number | null;
  currentOwnerScriptPubKeyHex: string;
  currentOwnerLocalIndex: number | null;
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
        currentOwnerLocalIndex: options.currentOwnerLocalIndex,
        canonicalChainStatus: "registered-unanchored",
        currentCanonicalAnchorOutpoint: null,
        birthTime: domain.birthTime ?? Math.floor(options.nowUnixMs / 1000),
      };
    })
    : [
      ...options.state.domains,
      {
        name: options.domainName,
        domainId: options.domainId,
        dedicatedIndex: null,
        currentOwnerScriptPubKeyHex: options.currentOwnerScriptPubKeyHex,
        currentOwnerLocalIndex: options.currentOwnerLocalIndex,
        canonicalChainStatus: "registered-unanchored",
        localAnchorIntent: "none",
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: existing?.foundingMessageText ?? null,
        birthTime: Math.floor(options.nowUnixMs / 1000),
      },
    ];

  const identities = options.state.identities.map((identity) => {
    const filtered = identity.assignedDomainNames.filter((domainName) => domainName !== options.domainName);
    if (identity.index === options.currentOwnerLocalIndex) {
      return replaceAssignedDomainNames(identity, [...filtered, options.domainName]);
    }

    return replaceAssignedDomainNames(identity, filtered);
  });

  return {
    ...options.state,
    domains,
    identities,
  };
}

function createResolvedDomainMarketSenderSummary(
  sender: MutationSender,
  selector: string,
): DomainMarketResolvedSenderSummary {
  return {
    selector,
    localIndex: sender.localIndex,
    scriptPubKeyHex: sender.scriptPubKeyHex,
    address: sender.address,
  };
}

function createResolvedDomainMarketRecipientSummary(
  recipient: ReturnType<typeof normalizeBtcTarget>,
): DomainMarketResolvedRecipientSummary {
  return {
    scriptPubKeyHex: recipient.scriptPubKeyHex,
    address: recipient.address,
    opaque: recipient.opaque,
  };
}

function createTransferEconomicEffectSummary(clearsListing: boolean): DomainMarketResolvedEconomicEffect {
  return {
    kind: "ownership-transfer",
    clearsListing,
  };
}

function createSellEconomicEffectSummary(listedPriceCogtoshi: bigint): DomainMarketResolvedEconomicEffect {
  if (listedPriceCogtoshi === 0n) {
    return {
      kind: "listing-clear",
      listedPriceCogtoshi: "0",
    };
  }

  return {
    kind: "listing-set",
    listedPriceCogtoshi: listedPriceCogtoshi.toString(),
  };
}

function resolveAnchorOutpointForSender(
  state: WalletStateV1,
  sender: NonNullable<WalletReadContext["model"]>["identities"][number],
  errorPrefix: string,
): OutpointRecord | null {
  const anchoredDomains = state.domains.filter((domain) =>
    domain.currentOwnerLocalIndex === sender.index
    && domain.canonicalChainStatus === "anchored"
  );

  if (anchoredDomains.length === 0) {
    return null;
  }

  const anchoredDomain = anchoredDomains[0]!;

  if (anchoredDomain.currentCanonicalAnchorOutpoint === null) {
    throw new Error(`${errorPrefix}_anchor_outpoint_unavailable`);
  }

  return {
    txid: anchoredDomain.currentCanonicalAnchorOutpoint.txid,
    vout: anchoredDomain.currentCanonicalAnchorOutpoint.vout,
  };
}

function resolveOwnedDomainOperation(
  context: WalletReadContext,
  domainName: string,
  errorPrefix: string,
): DomainOperationContext {
  assertWalletMutationContextReady(context, errorPrefix);
  const chainDomain = lookupDomain(context.snapshot.state, domainName);

  if (chainDomain === null) {
    throw new Error(`${errorPrefix}_domain_not_found`);
  }

  if (chainDomain.anchored) {
    throw new Error(`${errorPrefix}_domain_anchored`);
  }

  const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  const senderIdentity = context.model.identities.find((identity) => identity.scriptPubKeyHex === ownerHex) ?? null;

  if (senderIdentity === null || senderIdentity.address === null) {
    throw new Error(`${errorPrefix}_owner_not_locally_controlled`);
  }

  if (senderIdentity.readOnly) {
    throw new Error(`${errorPrefix}_owner_read_only`);
  }

  return {
    readContext: context,
    state: context.localState.state,
    unlockUntilUnixMs: context.localState.unlockUntilUnixMs,
    sender: {
      localIndex: senderIdentity.index,
      scriptPubKeyHex: senderIdentity.scriptPubKeyHex,
      address: senderIdentity.address,
    },
    senderSelector: getCanonicalIdentitySelector(senderIdentity),
    anchorOutpoint: resolveAnchorOutpointForSender(context.localState.state, senderIdentity, errorPrefix),
    chainDomain,
  };
}

function resolveBuyOperation(
  context: WalletReadContext,
  domainName: string,
  fromIdentity: string | null = null,
): BuyOperationContext {
  assertWalletMutationContextReady(context, "wallet_buy");
  const chainDomain = lookupDomain(context.snapshot.state, domainName);

  if (chainDomain === null) {
    throw new Error("wallet_buy_domain_not_found");
  }

  if (chainDomain.anchored) {
    throw new Error("wallet_buy_domain_anchored");
  }

  const listing = getListing(context.snapshot.state, chainDomain.domainId);
  if (listing === null) {
    throw new Error("wallet_buy_domain_not_listed");
  }

  const selectedIdentity = fromIdentity === null
    ? context.model.fundingIdentity
    : resolveIdentityBySelector(context, fromIdentity, "wallet_buy");

  if (selectedIdentity === null) {
    throw new Error("wallet_buy_funding_identity_unavailable");
  }

  if (selectedIdentity.address === null) {
    throw new Error(fromIdentity === null
      ? "wallet_buy_funding_identity_unavailable"
      : "wallet_buy_sender_address_unavailable");
  }

  if (selectedIdentity.readOnly) {
    throw new Error("wallet_buy_sender_read_only");
  }

  const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  if (ownerHex === selectedIdentity.scriptPubKeyHex) {
    throw new Error("wallet_buy_already_owner");
  }

  if (getBalance(context.snapshot.state, selectedIdentity.scriptPubKeyHex) < listing.priceCogtoshi) {
    throw new Error("wallet_buy_insufficient_cog_balance");
  }

  return {
    readContext: context,
    state: context.localState.state,
    unlockUntilUnixMs: context.localState.unlockUntilUnixMs,
    sender: {
      localIndex: selectedIdentity.index,
      scriptPubKeyHex: selectedIdentity.scriptPubKeyHex,
      address: selectedIdentity.address,
    },
    senderSelector: getCanonicalIdentitySelector(selectedIdentity),
    anchorOutpoint: resolveAnchorOutpointForSender(context.localState.state, selectedIdentity, "wallet_buy"),
    chainDomain,
    listingPriceCogtoshi: listing.priceCogtoshi,
    buyerSelector: getCanonicalIdentitySelector(selectedIdentity),
  };
}

function buildPlanForDomainOperation(options: {
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  sender: MutationSender;
  anchorOutpoint: OutpointRecord | null;
  opReturnData: Uint8Array;
  anchorValueSats: bigint;
  errorPrefix: string;
}): DomainMarketPlan {
  const fundingUtxos = options.allUtxos.filter((entry) =>
    entry.scriptPubKey === options.state.funding.scriptPubKeyHex
    && entry.confirmations >= 1
    && entry.spendable !== false
    && entry.safe !== false
  );
  const outputs: unknown[] = [{ data: Buffer.from(options.opReturnData).toString("hex") }];

  if (options.anchorOutpoint === null) {
    const senderUtxo = options.allUtxos.find((entry) =>
      entry.scriptPubKey === options.sender.scriptPubKeyHex
      && entry.confirmations >= 1
      && entry.spendable !== false
      && entry.safe !== false
    );

    if (senderUtxo === undefined) {
      throw new Error(`${options.errorPrefix}_sender_utxo_unavailable`);
    }

    return {
      sender: options.sender,
      changeAddress: options.state.funding.address,
      inputs: [
        { txid: senderUtxo.txid, vout: senderUtxo.vout },
        ...fundingUtxos
          .filter((entry) => !(entry.txid === senderUtxo.txid && entry.vout === senderUtxo.vout))
          .map((entry) => ({ txid: entry.txid, vout: entry.vout })),
      ],
      outputs,
      changePosition: 1,
      expectedOpReturnScriptHex: encodeOpReturnScript(options.opReturnData),
      expectedAnchorScriptHex: null,
      expectedAnchorValueSats: null,
      allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
      errorPrefix: options.errorPrefix,
    };
  }

  const anchorUtxo = options.allUtxos.find((entry) =>
    entry.txid === options.anchorOutpoint?.txid
    && entry.vout === options.anchorOutpoint.vout
    && entry.scriptPubKey === options.sender.scriptPubKeyHex
    && entry.confirmations >= 1
    && entry.spendable !== false
    && entry.safe !== false
  );

  if (anchorUtxo === undefined) {
    throw new Error(`${options.errorPrefix}_anchor_utxo_missing`);
  }

  outputs.push({
    [options.sender.address]: satsToBtcNumber(options.anchorValueSats),
  });

  return {
    sender: options.sender,
    changeAddress: options.state.funding.address,
    inputs: [
      { txid: anchorUtxo.txid, vout: anchorUtxo.vout },
      ...fundingUtxos.map((entry) => ({ txid: entry.txid, vout: entry.vout })),
    ],
    outputs,
    changePosition: 2,
    expectedOpReturnScriptHex: encodeOpReturnScript(options.opReturnData),
    expectedAnchorScriptHex: options.sender.scriptPubKeyHex,
    expectedAnchorValueSats: options.anchorValueSats,
    allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    errorPrefix: options.errorPrefix,
  };
}

function validateFundedDraft(
  decoded: RpcDecodedPsbt,
  funded: BuiltDomainMarketTransaction["funded"],
  plan: DomainMarketPlan,
): void {
  const inputs = decoded.tx.vin;
  const outputs = decoded.tx.vout;

  if (inputs.length === 0) {
    throw new Error(`${plan.errorPrefix}_missing_sender_input`);
  }

  if (inputs[0]?.prevout?.scriptPubKey?.hex !== plan.sender.scriptPubKeyHex) {
    throw new Error(`${plan.errorPrefix}_sender_input_mismatch`);
  }

  for (let index = 1; index < inputs.length; index += 1) {
    if (inputs[index]?.prevout?.scriptPubKey?.hex !== plan.allowedFundingScriptPubKeyHex) {
      throw new Error(`${plan.errorPrefix}_unexpected_funding_input`);
    }
  }

  if (outputs[0]?.scriptPubKey?.hex !== plan.expectedOpReturnScriptHex) {
    throw new Error(`${plan.errorPrefix}_opreturn_mismatch`);
  }

  if (plan.expectedAnchorScriptHex !== null) {
    if (outputs[1]?.scriptPubKey?.hex !== plan.expectedAnchorScriptHex) {
      throw new Error(`${plan.errorPrefix}_anchor_output_mismatch`);
    }

    if (valueToSats(outputs[1]?.value ?? 0) !== (plan.expectedAnchorValueSats ?? 0n)) {
      throw new Error(`${plan.errorPrefix}_anchor_value_mismatch`);
    }
  }

  const expectedWithoutChange = plan.expectedAnchorScriptHex === null ? 1 : 2;
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
  rpc: DomainMarketRpcClient;
  walletName: string;
  plan: DomainMarketPlan;
}): Promise<BuiltDomainMarketTransaction> {
  return buildWalletMutationTransaction({
    rpc: options.rpc,
    walletName: options.walletName,
    plan: options.plan,
    validateFundedDraft,
    finalizeErrorCode: `${options.plan.errorPrefix}_finalize_failed`,
    mempoolRejectPrefix: `${options.plan.errorPrefix}_mempool_rejected`,
  });
}

function createDraftMutation(options: {
  kind: DomainMarketKind;
  domainName: string;
  sender: MutationSender;
  intentFingerprintHex: string;
  nowUnixMs: number;
  parentDomainName?: string | null;
  recipientScriptPubKeyHex?: string | null;
  priceCogtoshi?: bigint | null;
  existing?: PendingMutationRecord | null;
}): PendingMutationRecord {
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
    temporaryBuilderLockedOutpoints: [],
  };
}

function getTransferStatusAfterAcceptance(options: {
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

function getSellStatusAfterAcceptance(options: {
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

function getBuyStatusAfterAcceptance(options: {
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

async function reconcilePendingMutation(options: {
  state: WalletStateV1;
  mutation: PendingMutationRecord;
  provider: WalletSecretProvider;
  unlockUntilUnixMs: number;
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
          currentOwnerLocalIndex: options.context.model?.identities.find((identity) => identity.scriptPubKeyHex === ownerHex)?.index ?? null,
          nowUnixMs: options.nowUnixMs,
        });
        await saveWalletStatePreservingUnlock({
          state: nextState,
          provider: options.provider,
          unlockUntilUnixMs: options.unlockUntilUnixMs,
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
          unlockUntilUnixMs: options.unlockUntilUnixMs,
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
            unlockUntilUnixMs: options.unlockUntilUnixMs,
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
            unlockUntilUnixMs: options.unlockUntilUnixMs,
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
          unlockUntilUnixMs: options.unlockUntilUnixMs,
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
          currentOwnerLocalIndex: options.context.model?.identities.find((identity) => identity.scriptPubKeyHex === ownerHex)?.index ?? null,
          nowUnixMs: options.nowUnixMs,
        });
        await saveWalletStatePreservingUnlock({
          state: nextState,
          provider: options.provider,
          unlockUntilUnixMs: options.unlockUntilUnixMs,
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
          unlockUntilUnixMs: options.unlockUntilUnixMs,
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
          currentOwnerLocalIndex: live.kind === "transfer"
            ? options.context.model?.identities.find((identity) => identity.scriptPubKeyHex === live.recipientScriptPubKeyHex)?.index ?? null
            : live.senderLocalIndex,
          nowUnixMs: options.nowUnixMs,
        });
      }
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider: options.provider,
        unlockUntilUnixMs: options.unlockUntilUnixMs,
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

async function confirmTransfer(
  prompter: WalletPrompter,
  domainName: string,
  sender: DomainMarketResolvedSenderSummary,
  recipient: DomainMarketResolvedRecipientSummary,
  economicEffect: DomainMarketResolvedEconomicEffect,
  assumeYes = false,
): Promise<void> {
  prompter.writeLine(`You are transferring "${domainName}".`);
  prompter.writeLine(`Resolved sender: ${sender.selector} (${sender.address})`);
  prompter.writeLine(`Resolved recipient: ${recipient.address ?? `spk:${recipient.scriptPubKeyHex}`}`);
  prompter.writeLine(
    `Economic effect: ${economicEffect.kind === "ownership-transfer" && economicEffect.clearsListing
      ? "transfer domain ownership and clear any active listing."
      : "transfer domain ownership."}`,
  );

  if (recipient.opaque) {
    prompter.writeLine(`Target script length: ${recipient.scriptPubKeyHex.length / 2} bytes`);
    prompter.writeLine("Cogcoin identity is exact raw-script equality. Different script templates are different identities.");
    const acknowledgement = `RAW-SCRIPT:${recipient.scriptPubKeyHex.slice(0, 16)}`;
    await confirmTypedAcknowledgement(prompter, {
      assumeYes,
      expected: acknowledgement,
      prompt: `Type ${acknowledgement} to continue: `,
      errorCode: "wallet_transfer_confirmation_rejected",
      requiresTtyErrorCode: "wallet_transfer_requires_tty",
      typedAckRequiredErrorCode: "wallet_transfer_typed_ack_required",
    });
    return;
  }

  await confirmYesNo(prompter, "This publishes a standalone DOMAIN_TRANSFER.", {
    assumeYes,
    errorCode: "wallet_transfer_confirmation_rejected",
    requiresTtyErrorCode: "wallet_transfer_requires_tty",
  });
}

async function confirmSell(
  prompter: WalletPrompter,
  domainName: string,
  sender: DomainMarketResolvedSenderSummary,
  listedPriceCogtoshi: bigint,
  assumeYes = false,
): Promise<void> {
  prompter.writeLine(`You are listing "${domainName}".`);
  prompter.writeLine(`Resolved sender: ${sender.selector} (${sender.address})`);
  prompter.writeLine(`Exact listing price: ${listedPriceCogtoshi.toString()} cogtoshi.`);
  prompter.writeLine(`Economic effect: set the listing price to ${listedPriceCogtoshi.toString()} cogtoshi in COG state.`);
  prompter.writeLine("Settlement: entirely in COG state. No BTC payment output will be added.");
  await confirmYesNo(prompter, "This publishes a standalone DOMAIN_SELL mutation.", {
    assumeYes,
    errorCode: "wallet_sell_confirmation_rejected",
    requiresTtyErrorCode: "wallet_sell_requires_tty",
  });
}

async function confirmBuy(
  prompter: WalletPrompter,
  domainName: string,
  buyerSelector: string,
  buyer: MutationSender,
  sellerScriptPubKeyHex: string,
  sellerAddress: string | null,
  listedPriceCogtoshi: bigint,
  assumeYes = false,
): Promise<void> {
  prompter.writeLine(`You are buying "${domainName}".`);
  prompter.writeLine(`Exact listing price: ${listedPriceCogtoshi.toString()} cogtoshi.`);
  prompter.writeLine(`Resolved buyer: ${buyerSelector} (${buyer.address})`);
  prompter.writeLine(`Resolved seller: ${sellerAddress ?? `spk:${sellerScriptPubKeyHex}`}`);
  prompter.writeLine("Settlement: entirely in COG state. No BTC payment output will be added.");
  await confirmYesNo(prompter, "This publishes a standalone DOMAIN_BUY mutation.", {
    assumeYes,
    errorCode: "wallet_buy_confirmation_rejected",
    requiresTtyErrorCode: "wallet_buy_requires_tty",
  });
}

export async function transferDomain(options: TransferDomainOptions): Promise<DomainMarketMutationResult> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const controlLock = await acquireFileLock(paths.walletControlLockPath, {
    purpose: "wallet-transfer",
    walletRootId: null,
  });
  const normalizedDomainName = normalizeDomainName(options.domainName);
  const recipient = normalizeBtcTarget(options.target);

  try {
    const miningPreemption = await pauseMiningForWalletMutation({
      paths,
      reason: "wallet-transfer",
    });
    const readContext = await (options.openReadContext ?? openWalletReadContext)({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      secretProvider: provider,
      walletControlLockHeld: true,
      paths,
    });

    try {
      const operation = resolveOwnedDomainOperation(readContext, normalizedDomainName, "wallet_transfer");
      const snapshot = readContext.snapshot!;
      const model = readContext.model!;
      const resolvedSender = createResolvedDomainMarketSenderSummary(operation.sender, operation.senderSelector);
      const resolvedRecipient = createResolvedDomainMarketRecipientSummary(recipient);
      const resolvedEconomicEffect = createTransferEconomicEffectSummary(
        getListing(snapshot.state, operation.chainDomain.domainId) !== null,
      );
      if (operation.sender.scriptPubKeyHex === recipient.scriptPubKeyHex) {
        throw new Error("wallet_transfer_self_transfer");
      }

      const intentFingerprintHex = createIntentFingerprint([
        "transfer",
        operation.state.walletRootId,
        normalizedDomainName,
        operation.sender.scriptPubKeyHex,
        recipient.scriptPubKeyHex,
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
        const reconciled = await reconcilePendingMutation({
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
            kind: "transfer",
            domainName: normalizedDomainName,
            txid: reconciled.mutation.attemptedTxid ?? "unknown",
            status: reconciled.resolution,
            reusedExisting: true,
            recipientScriptPubKeyHex: recipient.scriptPubKeyHex,
            resolved: {
              sender: resolvedSender,
              recipient: resolvedRecipient,
              economicEffect: resolvedEconomicEffect,
            },
          };
        }

        if (reconciled.resolution === "repair-required") {
          throw new Error("wallet_transfer_repair_required");
        }
      }

      await confirmTransfer(
        options.prompter,
        normalizedDomainName,
        resolvedSender,
        resolvedRecipient,
        resolvedEconomicEffect,
        options.assumeYes,
      );

      let nextState = upsertPendingMutation(
        operation.state,
        createDraftMutation({
          kind: "transfer",
          domainName: normalizedDomainName,
          sender: operation.sender,
          recipientScriptPubKeyHex: recipient.scriptPubKeyHex,
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
        unlockUntilUnixMs: operation.unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      const built = await buildTransaction({
        rpc,
        walletName,
        plan: buildPlanForDomainOperation({
          state: nextState,
          allUtxos: await rpc.listUnspent(walletName, 1),
          sender: operation.sender,
          anchorOutpoint: operation.anchorOutpoint,
          opReturnData: serializeDomainTransfer(operation.chainDomain.domainId, Buffer.from(recipient.scriptPubKeyHex, "hex")).opReturnData,
          anchorValueSats: BigInt(nextState.anchorValueSats),
          errorPrefix: "wallet_transfer",
        }),
      });

      const broadcasting = updateMutationRecord(
        nextState.pendingMutations!.find((mutation) => mutation.intentFingerprintHex === intentFingerprintHex)!,
        "broadcasting",
        nowUnixMs,
        {
          attemptedTxid: built.txid,
          attemptedWtxid: built.wtxid,
          temporaryBuilderLockedOutpoints: built.temporaryBuilderLockedOutpoints,
        },
      );
      nextState = {
        ...upsertPendingMutation(nextState, broadcasting),
        stateRevision: nextState.stateRevision + 1,
        lastWrittenAtUnixMs: nowUnixMs,
      };
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider,
        unlockUntilUnixMs: operation.unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      if (snapshot.tip?.height !== (await rpc.getBlockchainInfo()).blocks) {
        await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
        throw new Error("wallet_transfer_tip_mismatch");
      }

      try {
        await rpc.sendRawTransaction(built.rawHex);
      } catch (error) {
        if (!isAlreadyAcceptedError(error)) {
          if (isBroadcastUnknownError(error)) {
            const unknown = updateMutationRecord(broadcasting, "broadcast-unknown", nowUnixMs, {
              attemptedTxid: built.txid,
              attemptedWtxid: built.wtxid,
              temporaryBuilderLockedOutpoints: built.temporaryBuilderLockedOutpoints,
            });
            nextState = {
              ...upsertPendingMutation(nextState, unknown),
              stateRevision: nextState.stateRevision + 1,
              lastWrittenAtUnixMs: nowUnixMs,
            };
            await saveWalletStatePreservingUnlock({
              state: nextState,
              provider,
              unlockUntilUnixMs: operation.unlockUntilUnixMs,
              nowUnixMs,
              paths,
            });
            throw new Error("wallet_transfer_broadcast_unknown");
          }

          await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
          const canceled = updateMutationRecord(broadcasting, "canceled", nowUnixMs, {
            attemptedTxid: built.txid,
            attemptedWtxid: built.wtxid,
            temporaryBuilderLockedOutpoints: [],
          });
          nextState = {
            ...upsertPendingMutation(nextState, canceled),
            stateRevision: nextState.stateRevision + 1,
            lastWrittenAtUnixMs: nowUnixMs,
          };
          await saveWalletStatePreservingUnlock({
            state: nextState,
            provider,
            unlockUntilUnixMs: operation.unlockUntilUnixMs,
            nowUnixMs,
            paths,
          });
          throw error;
        }
      }

      await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
      const finalStatus = getTransferStatusAfterAcceptance({
        snapshot: readContext.snapshot,
        domainName: normalizedDomainName,
        recipientScriptPubKeyHex: recipient.scriptPubKeyHex,
      });
      const finalMutation = updateMutationRecord(broadcasting, finalStatus, nowUnixMs, {
        attemptedTxid: built.txid,
        attemptedWtxid: built.wtxid,
        temporaryBuilderLockedOutpoints: [],
      });
      nextState = reserveTransferredDomainRecord({
        state: upsertPendingMutation(nextState, finalMutation),
        domainName: normalizedDomainName,
        domainId: operation.chainDomain.domainId,
        currentOwnerScriptPubKeyHex: recipient.scriptPubKeyHex,
        currentOwnerLocalIndex: model.identities.find((identity) => identity.scriptPubKeyHex === recipient.scriptPubKeyHex)?.index ?? null,
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
        unlockUntilUnixMs: operation.unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      return {
        kind: "transfer",
        domainName: normalizedDomainName,
        txid: built.txid,
        status: finalStatus,
        reusedExisting: false,
        recipientScriptPubKeyHex: recipient.scriptPubKeyHex,
        resolved: {
          sender: resolvedSender,
          recipient: resolvedRecipient,
          economicEffect: resolvedEconomicEffect,
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

async function runSellMutation(options: SellDomainOptions): Promise<DomainMarketMutationResult> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const controlLock = await acquireFileLock(paths.walletControlLockPath, {
    purpose: "wallet-sell",
    walletRootId: null,
  });
  const normalizedDomainName = normalizeDomainName(options.domainName);

  try {
    const miningPreemption = await pauseMiningForWalletMutation({
      paths,
      reason: "wallet-sell",
    });
    const readContext = await (options.openReadContext ?? openWalletReadContext)({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      secretProvider: provider,
      walletControlLockHeld: true,
      paths,
    });

    try {
      const operation = resolveOwnedDomainOperation(readContext, normalizedDomainName, "wallet_sell");
      const resolvedSender = createResolvedDomainMarketSenderSummary(operation.sender, operation.senderSelector);
      const resolvedEconomicEffect = createSellEconomicEffectSummary(options.listedPriceCogtoshi);
      const snapshot = readContext.snapshot!;
      const intentFingerprintHex = createIntentFingerprint([
        "sell",
        operation.state.walletRootId,
        normalizedDomainName,
        operation.sender.scriptPubKeyHex,
        options.listedPriceCogtoshi.toString(),
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
        const reconciled = await reconcilePendingMutation({
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
            kind: "sell",
            domainName: normalizedDomainName,
            txid: reconciled.mutation.attemptedTxid ?? "unknown",
            status: reconciled.resolution,
            reusedExisting: true,
            listedPriceCogtoshi: options.listedPriceCogtoshi,
            resolved: {
              sender: resolvedSender,
              economicEffect: resolvedEconomicEffect,
            },
          };
        }

        if (reconciled.resolution === "repair-required") {
          throw new Error("wallet_sell_repair_required");
        }
      }

      if (options.listedPriceCogtoshi > 0n) {
        await confirmSell(
          options.prompter,
          normalizedDomainName,
          resolvedSender,
          options.listedPriceCogtoshi,
          options.assumeYes,
        );
      }

      let nextState = upsertPendingMutation(
        operation.state,
        createDraftMutation({
          kind: "sell",
          domainName: normalizedDomainName,
          sender: operation.sender,
          priceCogtoshi: options.listedPriceCogtoshi,
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
        unlockUntilUnixMs: operation.unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      const built = await buildTransaction({
        rpc,
        walletName,
        plan: buildPlanForDomainOperation({
          state: nextState,
          allUtxos: await rpc.listUnspent(walletName, 1),
          sender: operation.sender,
          anchorOutpoint: operation.anchorOutpoint,
          opReturnData: serializeDomainSell(operation.chainDomain.domainId, options.listedPriceCogtoshi).opReturnData,
          anchorValueSats: BigInt(nextState.anchorValueSats),
          errorPrefix: "wallet_sell",
        }),
      });

      const broadcasting = updateMutationRecord(
        nextState.pendingMutations!.find((mutation) => mutation.intentFingerprintHex === intentFingerprintHex)!,
        "broadcasting",
        nowUnixMs,
        {
          attemptedTxid: built.txid,
          attemptedWtxid: built.wtxid,
          temporaryBuilderLockedOutpoints: built.temporaryBuilderLockedOutpoints,
        },
      );
      nextState = {
        ...upsertPendingMutation(nextState, broadcasting),
        stateRevision: nextState.stateRevision + 1,
        lastWrittenAtUnixMs: nowUnixMs,
      };
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider,
        unlockUntilUnixMs: operation.unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      if (snapshot.tip?.height !== (await rpc.getBlockchainInfo()).blocks) {
        await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
        throw new Error("wallet_sell_tip_mismatch");
      }

      try {
        await rpc.sendRawTransaction(built.rawHex);
      } catch (error) {
        if (!isAlreadyAcceptedError(error)) {
          if (isBroadcastUnknownError(error)) {
            const unknown = updateMutationRecord(broadcasting, "broadcast-unknown", nowUnixMs, {
              attemptedTxid: built.txid,
              attemptedWtxid: built.wtxid,
              temporaryBuilderLockedOutpoints: built.temporaryBuilderLockedOutpoints,
            });
            nextState = {
              ...upsertPendingMutation(nextState, unknown),
              stateRevision: nextState.stateRevision + 1,
              lastWrittenAtUnixMs: nowUnixMs,
            };
            await saveWalletStatePreservingUnlock({
              state: nextState,
              provider,
              unlockUntilUnixMs: operation.unlockUntilUnixMs,
              nowUnixMs,
              paths,
            });
            throw new Error("wallet_sell_broadcast_unknown");
          }

          await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
          const canceled = updateMutationRecord(broadcasting, "canceled", nowUnixMs, {
            attemptedTxid: built.txid,
            attemptedWtxid: built.wtxid,
            temporaryBuilderLockedOutpoints: [],
          });
          nextState = {
            ...upsertPendingMutation(nextState, canceled),
            stateRevision: nextState.stateRevision + 1,
            lastWrittenAtUnixMs: nowUnixMs,
          };
          await saveWalletStatePreservingUnlock({
            state: nextState,
            provider,
            unlockUntilUnixMs: operation.unlockUntilUnixMs,
            nowUnixMs,
            paths,
          });
          throw error;
        }
      }

      await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
      const finalStatus = getSellStatusAfterAcceptance({
        snapshot: readContext.snapshot,
        domainName: normalizedDomainName,
        senderScriptPubKeyHex: operation.sender.scriptPubKeyHex,
        listedPriceCogtoshi: options.listedPriceCogtoshi,
      });
      const finalMutation = updateMutationRecord(broadcasting, finalStatus, nowUnixMs, {
        attemptedTxid: built.txid,
        attemptedWtxid: built.wtxid,
        temporaryBuilderLockedOutpoints: [],
      });
      nextState = {
        ...upsertPendingMutation(nextState, finalMutation),
        stateRevision: nextState.stateRevision + 1,
        lastWrittenAtUnixMs: nowUnixMs,
      };
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider,
        unlockUntilUnixMs: operation.unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      return {
        kind: "sell",
        domainName: normalizedDomainName,
        txid: built.txid,
        status: finalStatus,
        reusedExisting: false,
        listedPriceCogtoshi: options.listedPriceCogtoshi,
        resolved: {
          sender: resolvedSender,
          economicEffect: resolvedEconomicEffect,
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

export async function sellDomain(options: SellDomainOptions): Promise<DomainMarketMutationResult> {
  if (options.listedPriceCogtoshi < 0n) {
    throw new Error("wallet_sell_invalid_amount");
  }

  return runSellMutation(options);
}

export async function buyDomain(options: BuyDomainOptions): Promise<DomainMarketMutationResult> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const controlLock = await acquireFileLock(paths.walletControlLockPath, {
    purpose: "wallet-buy",
    walletRootId: null,
  });
  const normalizedDomainName = normalizeDomainName(options.domainName);

  try {
    const miningPreemption = await pauseMiningForWalletMutation({
      paths,
      reason: "wallet-buy",
    });
    const readContext = await (options.openReadContext ?? openWalletReadContext)({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      secretProvider: provider,
      walletControlLockHeld: true,
      paths,
    });

    try {
      const operation = resolveBuyOperation(readContext, normalizedDomainName, options.fromIdentity ?? null);
      const snapshot = readContext.snapshot!;
      const model = readContext.model!;
      const sellerScriptPubKeyHex = Buffer.from(operation.chainDomain.ownerScriptPubKey).toString("hex");
      const sellerAddress = model.identities.find((identity) => identity.scriptPubKeyHex === sellerScriptPubKeyHex)?.address ?? null;
      const resolvedBuyer: DomainMarketResolvedBuyerSummary = {
        selector: operation.buyerSelector,
        localIndex: operation.sender.localIndex,
        scriptPubKeyHex: operation.sender.scriptPubKeyHex,
        address: operation.sender.address,
      };
      const resolvedSeller: DomainMarketResolvedSellerSummary = {
        scriptPubKeyHex: sellerScriptPubKeyHex,
        address: sellerAddress,
      };
      const intentFingerprintHex = createIntentFingerprint([
        "buy",
        operation.state.walletRootId,
        normalizedDomainName,
        operation.sender.scriptPubKeyHex,
        operation.listingPriceCogtoshi.toString(),
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
        const reconciled = await reconcilePendingMutation({
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
            kind: "buy",
            domainName: normalizedDomainName,
            txid: reconciled.mutation.attemptedTxid ?? "unknown",
            status: reconciled.resolution,
            reusedExisting: true,
            listedPriceCogtoshi: operation.listingPriceCogtoshi,
            resolvedBuyer,
            resolvedSeller,
          };
        }

        if (reconciled.resolution === "repair-required") {
          throw new Error("wallet_buy_repair_required");
        }
      }

      await confirmBuy(
        options.prompter,
        normalizedDomainName,
        operation.buyerSelector,
        operation.sender,
        sellerScriptPubKeyHex,
        sellerAddress,
        operation.listingPriceCogtoshi,
        options.assumeYes,
      );

      let nextState = upsertPendingMutation(
        operation.state,
        createDraftMutation({
          kind: "buy",
          domainName: normalizedDomainName,
          sender: operation.sender,
          priceCogtoshi: operation.listingPriceCogtoshi,
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
        unlockUntilUnixMs: operation.unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      const built = await buildTransaction({
        rpc,
        walletName,
        plan: buildPlanForDomainOperation({
          state: nextState,
          allUtxos: await rpc.listUnspent(walletName, 1),
          sender: operation.sender,
          anchorOutpoint: operation.anchorOutpoint,
          opReturnData: serializeDomainBuy(operation.chainDomain.domainId, operation.listingPriceCogtoshi).opReturnData,
          anchorValueSats: BigInt(nextState.anchorValueSats),
          errorPrefix: "wallet_buy",
        }),
      });

      const currentSellerHex = Buffer.from(operation.chainDomain.ownerScriptPubKey).toString("hex");
      if (currentSellerHex !== sellerScriptPubKeyHex) {
        await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
        throw new Error("wallet_buy_stale_listing_owner");
      }

      const broadcasting = updateMutationRecord(
        nextState.pendingMutations!.find((mutation) => mutation.intentFingerprintHex === intentFingerprintHex)!,
        "broadcasting",
        nowUnixMs,
        {
          attemptedTxid: built.txid,
          attemptedWtxid: built.wtxid,
          temporaryBuilderLockedOutpoints: built.temporaryBuilderLockedOutpoints,
        },
      );
      nextState = {
        ...upsertPendingMutation(nextState, broadcasting),
        stateRevision: nextState.stateRevision + 1,
        lastWrittenAtUnixMs: nowUnixMs,
      };
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider,
        unlockUntilUnixMs: operation.unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      if (snapshot.tip?.height !== (await rpc.getBlockchainInfo()).blocks) {
        await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
        throw new Error("wallet_buy_tip_mismatch");
      }

      try {
        await rpc.sendRawTransaction(built.rawHex);
      } catch (error) {
        if (!isAlreadyAcceptedError(error)) {
          if (isBroadcastUnknownError(error)) {
            const unknown = updateMutationRecord(broadcasting, "broadcast-unknown", nowUnixMs, {
              attemptedTxid: built.txid,
              attemptedWtxid: built.wtxid,
              temporaryBuilderLockedOutpoints: built.temporaryBuilderLockedOutpoints,
            });
            nextState = {
              ...upsertPendingMutation(nextState, unknown),
              stateRevision: nextState.stateRevision + 1,
              lastWrittenAtUnixMs: nowUnixMs,
            };
            await saveWalletStatePreservingUnlock({
              state: nextState,
              provider,
              unlockUntilUnixMs: operation.unlockUntilUnixMs,
              nowUnixMs,
              paths,
            });
            throw new Error("wallet_buy_broadcast_unknown");
          }

          await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
          const canceled = updateMutationRecord(broadcasting, "canceled", nowUnixMs, {
            attemptedTxid: built.txid,
            attemptedWtxid: built.wtxid,
            temporaryBuilderLockedOutpoints: [],
          });
          nextState = {
            ...upsertPendingMutation(nextState, canceled),
            stateRevision: nextState.stateRevision + 1,
            lastWrittenAtUnixMs: nowUnixMs,
          };
          await saveWalletStatePreservingUnlock({
            state: nextState,
            provider,
            unlockUntilUnixMs: operation.unlockUntilUnixMs,
            nowUnixMs,
            paths,
          });
          throw error;
        }
      }

      await unlockTemporaryBuilderLocks(rpc, walletName, built.temporaryBuilderLockedOutpoints);
      const finalStatus = getBuyStatusAfterAcceptance({
        snapshot: readContext.snapshot,
        domainName: normalizedDomainName,
        buyerScriptPubKeyHex: operation.sender.scriptPubKeyHex,
      });
      const finalMutation = updateMutationRecord(broadcasting, finalStatus, nowUnixMs, {
        attemptedTxid: built.txid,
        attemptedWtxid: built.wtxid,
        temporaryBuilderLockedOutpoints: [],
      });
      nextState = reserveTransferredDomainRecord({
        state: upsertPendingMutation(nextState, finalMutation),
        domainName: normalizedDomainName,
        domainId: operation.chainDomain.domainId,
        currentOwnerScriptPubKeyHex: operation.sender.scriptPubKeyHex,
        currentOwnerLocalIndex: operation.sender.localIndex,
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
        unlockUntilUnixMs: operation.unlockUntilUnixMs,
        nowUnixMs,
        paths,
      });

      return {
        kind: "buy",
        domainName: normalizedDomainName,
        txid: built.txid,
        status: finalStatus,
        reusedExisting: false,
        listedPriceCogtoshi: operation.listingPriceCogtoshi,
        resolvedBuyer,
        resolvedSeller,
      };
    } finally {
      await readContext.close();
      await miningPreemption.release();
    }
  } finally {
    await controlLock.release();
  }
}
