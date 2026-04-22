import { createHash, randomBytes } from "node:crypto";

import { getBalance, getListing, lookupDomain } from "@cogcoin/indexer/queries";

import { attachOrStartManagedBitcoindService } from "../../../bitcoind/service.js";
import { createRpcClient } from "../../../bitcoind/node.js";
import type {
  RpcDecodedPsbt,
  RpcListUnspentEntry,
  RpcTransaction,
} from "../../../bitcoind/types.js";
import type { WalletPrompter } from "../../lifecycle.js";
import { type WalletRuntimePaths } from "../../runtime.js";
import { reconcilePersistentPolicyLocks as reconcileWalletCoinControlLocks } from "../../coin-control.js";
import {
  type WalletSecretProvider,
} from "../../state/provider.js";
import type {
  DomainRecord,
  OutpointRecord,
  PendingMutationRecord,
  WalletStateV1,
} from "../../types.js";
import {
  serializeDomainBuy,
  serializeDomainSell,
  serializeDomainTransfer,
  validateDomainName,
} from "../../cogop/index.js";
import { openWalletReadContext, type WalletReadContext } from "../../read/index.js";
import {
  assertFixedInputPrefixMatches,
  assertFundingInputsAfterFixedPrefix,
  assertWalletMutationContextReady,
  buildWalletMutationTransactionWithReserveFallback,
  createFundingMutationSender,
  createWalletMutationFeeMetadata,
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
} from "../common.js";
import { confirmTypedAcknowledgement, confirmYesNo } from "../confirm.js";
import {
  executeWalletMutationOperation,
  publishWalletMutation,
  resolveExistingWalletMutation,
} from "../executor.js";
import {
  getCanonicalIdentitySelector,
  resolveIdentityBySelector,
} from "../identity-selector.js";
import { upsertPendingMutation } from "../journal.js";
import { normalizeBtcTarget } from "../targets.js";

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
  fixedInputs: FixedWalletInput[];
  outputs: unknown[];
  changePosition: number;
  expectedOpReturnScriptHex: string;
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
  errorPrefix: string;
}

interface BuiltDomainMarketTransaction extends BuiltWalletMutationTransaction {}

interface DomainOperationContext {
  readContext: WalletReadContext;
  state: WalletStateV1;
  sender: MutationSender;
  senderSelector: string;
  chainDomain: NonNullable<ReturnType<typeof lookupDomain>>;
}

interface BuyOperationContext extends DomainOperationContext {
  listingPriceCogtoshi: bigint;
  buyerSelector: string;
}

interface TransferDomainMutationOperation extends DomainOperationContext {
  normalizedDomainName: string;
  recipient: ReturnType<typeof normalizeBtcTarget>;
  resolvedSender: DomainMarketResolvedSenderSummary;
  resolvedRecipient: DomainMarketResolvedRecipientSummary;
  resolvedEconomicEffect: DomainMarketResolvedEconomicEffect;
}

interface SellDomainMutationOperation extends DomainOperationContext {
  normalizedDomainName: string;
  listedPriceCogtoshi: bigint;
  resolvedSender: DomainMarketResolvedSenderSummary;
  resolvedEconomicEffect: DomainMarketResolvedEconomicEffect;
}

interface BuyDomainMutationOperation extends BuyOperationContext {
  normalizedDomainName: string;
  sellerScriptPubKeyHex: string;
  resolvedBuyer: DomainMarketResolvedBuyerSummary;
  resolvedSeller: DomainMarketResolvedSellerSummary;
}

async function prepareDomainMarketBuildState(options: {
  rpc: DomainMarketRpcClient;
  walletName: string;
  state: WalletStateV1;
  provider: WalletSecretProvider;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
  preflightCoinControl: boolean;
}): Promise<{
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
}> {
  if (!options.preflightCoinControl) {
    return {
      state: options.state,
      allUtxos: (await options.rpc.listUnspent(options.walletName, 1)).slice(),
    };
  }

  const reconciled = await reconcileWalletCoinControlLocks({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
  });
  const nextState = reconciled.changed
    ? {
      ...reconciled.state,
      stateRevision: reconciled.state.stateRevision + 1,
      lastWrittenAtUnixMs: options.nowUnixMs,
    }
    : reconciled.state;

  if (reconciled.changed) {
    await saveWalletStatePreservingUnlock({
      state: nextState,
      provider: options.provider,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
    });
  }

  return {
    state: nextState,
    allUtxos: (await options.rpc.listUnspent(options.walletName, 1)).slice(),
  };
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
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => DomainMarketRpcClient;
}

export interface SellDomainOptions {
  domainName: string;
  listedPriceCogtoshi: bigint;
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
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => DomainMarketRpcClient;
}

export interface BuyDomainOptions {
  domainName: string;
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
  fees: WalletMutationFeeSummary;
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

function reserveTransferredDomainRecord(options: {
  state: WalletStateV1;
  domainName: string;
  domainId: number | null;
  currentOwnerScriptPubKeyHex: string;
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
        canonicalChainStatus: "registered-unanchored",
        birthTime: domain.birthTime ?? Math.floor(options.nowUnixMs / 1000),
      };
    })
    : [
      ...options.state.domains,
      {
        name: options.domainName,
        domainId: options.domainId,
        currentOwnerScriptPubKeyHex: options.currentOwnerScriptPubKeyHex,
        canonicalChainStatus: "registered-unanchored",
        foundingMessageText: existing?.foundingMessageText ?? null,
        birthTime: Math.floor(options.nowUnixMs / 1000),
      },
    ];

  return {
    ...options.state,
    domains,
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
  if (ownerHex !== context.localState.state.funding.scriptPubKeyHex || context.model.walletAddress == null) {
    throw new Error(`${errorPrefix}_owner_not_locally_controlled`);
  }

  return {
    readContext: context,
    state: context.localState.state,
    sender: createFundingMutationSender(context.localState.state),
    senderSelector: context.model.walletAddress,
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

  if (context.model.walletAddress === null) {
    throw new Error("wallet_buy_funding_identity_unavailable");
  }

  const ownerHex = Buffer.from(chainDomain.ownerScriptPubKey).toString("hex");
  if (ownerHex === context.localState.state.funding.scriptPubKeyHex) {
    throw new Error("wallet_buy_already_owner");
  }

  if (getBalance(context.snapshot.state, context.localState.state.funding.scriptPubKeyHex) < listing.priceCogtoshi) {
    throw new Error("wallet_buy_insufficient_cog_balance");
  }

  return {
    readContext: context,
    state: context.localState.state,
    sender: createFundingMutationSender(context.localState.state),
    senderSelector: context.model.walletAddress,
    chainDomain,
    listingPriceCogtoshi: listing.priceCogtoshi,
    buyerSelector: context.model.walletAddress,
  };
}

function buildPlanForDomainOperation(options: {
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  sender: MutationSender;
  opReturnData: Uint8Array;
  errorPrefix: string;
}): DomainMarketPlan {
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
  funded: BuiltDomainMarketTransaction["funded"],
  plan: DomainMarketPlan,
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
  rpc: DomainMarketRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: DomainMarketPlan;
  feeRateSatVb: number;
}): Promise<BuiltDomainMarketTransaction> {
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
  kind: DomainMarketKind;
  domainName: string;
  sender: MutationSender;
  intentFingerprintHex: string;
  nowUnixMs: number;
  feeSelection: {
    feeRateSatVb: number;
    source: "custom-satvb" | "estimated-next-block-plus-one" | "fallback-default";
  };
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
      ...createWalletMutationFeeMetadata(options.feeSelection),
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
    ...createWalletMutationFeeMetadata(options.feeSelection),
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
          nowUnixMs: options.nowUnixMs,
        });
        await saveWalletStatePreservingUnlock({
          state: nextState,
          provider: options.provider,
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
          nowUnixMs: options.nowUnixMs,
        });
        await saveWalletStatePreservingUnlock({
          state: nextState,
          provider: options.provider,
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
          nowUnixMs: options.nowUnixMs,
        });
      }
      await saveWalletStatePreservingUnlock({
        state: nextState,
        provider: options.provider,
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
  const normalizedDomainName = normalizeDomainName(options.domainName);
  const recipient = normalizeBtcTarget(options.target);
  const execution = await executeWalletMutationOperation<
    TransferDomainMutationOperation,
    DomainMarketRpcClient,
    null,
    BuiltDomainMarketTransaction,
    DomainMarketMutationResult
  >({
    ...options,
    controlLockPurpose: "wallet-transfer",
    preemptionReason: "wallet-transfer",
    resolveOperation(readContext) {
      const operation = resolveOwnedDomainOperation(readContext, normalizedDomainName, "wallet_transfer");
      const resolvedSender = createResolvedDomainMarketSenderSummary(operation.sender, operation.senderSelector);
      const resolvedRecipient = createResolvedDomainMarketRecipientSummary(recipient);
      const resolvedEconomicEffect = createTransferEconomicEffectSummary(
        getListing(readContext.snapshot!.state, operation.chainDomain.domainId) !== null,
      );
      if (operation.sender.scriptPubKeyHex === recipient.scriptPubKeyHex) {
        throw new Error("wallet_transfer_self_transfer");
      }

      return {
        ...operation,
        normalizedDomainName,
        recipient,
        resolvedSender,
        resolvedRecipient,
        resolvedEconomicEffect,
      };
    },
    createIntentFingerprint(operation) {
      return createIntentFingerprint([
        "transfer",
        operation.state.walletRootId,
        operation.normalizedDomainName,
        operation.sender.scriptPubKeyHex,
        operation.recipient.scriptPubKeyHex,
      ]);
    },
    async resolveExistingMutation({ operation, existingMutation, execution }) {
      if (existingMutation === null) {
        return { state: operation.state, replacementFixedInputs: null, result: null };
      }
      return resolveExistingWalletMutation({
        existingMutation,
        execution,
        repairRequiredErrorCode: "wallet_transfer_repair_required",
        reconcileExistingMutation: (mutation) => reconcilePendingMutation({
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
          kind: "transfer",
          domainName: operation.normalizedDomainName,
          txid: mutation.attemptedTxid ?? "unknown",
          status: resolution,
          reusedExisting: true,
          recipientScriptPubKeyHex: operation.recipient.scriptPubKeyHex,
          resolved: {
            sender: operation.resolvedSender,
            recipient: operation.resolvedRecipient,
            economicEffect: operation.resolvedEconomicEffect,
          },
          fees,
        }),
      });
    },
    confirm({ operation }) {
      return confirmTransfer(
        options.prompter,
        operation.normalizedDomainName,
        operation.resolvedSender,
        operation.resolvedRecipient,
        operation.resolvedEconomicEffect,
        options.assumeYes,
      );
    },
    createDraftMutation({ operation, existingMutation, execution, intentFingerprintHex }) {
      return {
        mutation: createDraftMutation({
          kind: "transfer",
          domainName: operation.normalizedDomainName,
          sender: operation.sender,
          recipientScriptPubKeyHex: operation.recipient.scriptPubKeyHex,
          intentFingerprintHex,
          nowUnixMs: execution.nowUnixMs,
          feeSelection: execution.feeSelection,
          existing: existingMutation,
        }),
        prepared: null,
      };
    },
    async prepareBuildState({ state, execution }) {
      return (await prepareDomainMarketBuildState({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        provider: execution.provider,
        nowUnixMs: execution.nowUnixMs,
        paths: execution.paths,
        preflightCoinControl: false,
      })).state;
    },
    async build({ operation, state, execution, replacementFixedInputs }) {
      const transferPlan = buildPlanForDomainOperation({
        state,
        allUtxos: await execution.rpc.listUnspent(execution.walletName, 1),
        sender: operation.sender,
        opReturnData: serializeDomainTransfer(
          operation.chainDomain.domainId,
          Buffer.from(operation.recipient.scriptPubKeyHex, "hex"),
        ).opReturnData,
        errorPrefix: "wallet_transfer",
      });
      return buildTransaction({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        plan: {
          ...transferPlan,
          fixedInputs: mergeFixedWalletInputs(transferPlan.fixedInputs, replacementFixedInputs),
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
        errorPrefix: "wallet_transfer",
        async afterAccepted({ state: acceptedState, broadcastingMutation, built, nowUnixMs }) {
          const finalStatus = getTransferStatusAfterAcceptance({
            snapshot: execution.readContext.snapshot,
            domainName: operation.normalizedDomainName,
            recipientScriptPubKeyHex: operation.recipient.scriptPubKeyHex,
          });
          const finalMutation = updateMutationRecord(broadcastingMutation, finalStatus, nowUnixMs, {
            attemptedTxid: built.txid,
            attemptedWtxid: built.wtxid,
            temporaryBuilderLockedOutpoints: [],
          });
          return {
            state: reserveTransferredDomainRecord({
              state: upsertPendingMutation(acceptedState, finalMutation),
              domainName: operation.normalizedDomainName,
              domainId: operation.chainDomain.domainId,
              currentOwnerScriptPubKeyHex: operation.recipient.scriptPubKeyHex,
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
        kind: "transfer",
        domainName: operation.normalizedDomainName,
        txid: mutation.attemptedTxid ?? built?.txid ?? "unknown",
        status: status as DomainMarketMutationResult["status"],
        reusedExisting,
        recipientScriptPubKeyHex: operation.recipient.scriptPubKeyHex,
        resolved: {
          sender: operation.resolvedSender,
          recipient: operation.resolvedRecipient,
          economicEffect: operation.resolvedEconomicEffect,
        },
        fees,
      };
    },
  });

  return execution.result;
}

async function runSellMutation(options: SellDomainOptions): Promise<DomainMarketMutationResult> {
  const normalizedDomainName = normalizeDomainName(options.domainName);
  const execution = await executeWalletMutationOperation<
    SellDomainMutationOperation,
    DomainMarketRpcClient,
    null,
    BuiltDomainMarketTransaction,
    DomainMarketMutationResult
  >({
    ...options,
    controlLockPurpose: "wallet-sell",
    preemptionReason: "wallet-sell",
    resolveOperation(readContext) {
      const operation = resolveOwnedDomainOperation(readContext, normalizedDomainName, "wallet_sell");
      return {
        ...operation,
        normalizedDomainName,
        listedPriceCogtoshi: options.listedPriceCogtoshi,
        resolvedSender: createResolvedDomainMarketSenderSummary(operation.sender, operation.senderSelector),
        resolvedEconomicEffect: createSellEconomicEffectSummary(options.listedPriceCogtoshi),
      };
    },
    createIntentFingerprint(operation) {
      return createIntentFingerprint([
        "sell",
        operation.state.walletRootId,
        operation.normalizedDomainName,
        operation.sender.scriptPubKeyHex,
        operation.listedPriceCogtoshi.toString(),
      ]);
    },
    async resolveExistingMutation({ operation, existingMutation, execution }) {
      if (existingMutation === null) {
        return { state: operation.state, replacementFixedInputs: null, result: null };
      }
      return resolveExistingWalletMutation({
        existingMutation,
        execution,
        repairRequiredErrorCode: "wallet_sell_repair_required",
        reconcileExistingMutation: (mutation) => reconcilePendingMutation({
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
          kind: "sell",
          domainName: operation.normalizedDomainName,
          txid: mutation.attemptedTxid ?? "unknown",
          status: resolution,
          reusedExisting: true,
          listedPriceCogtoshi: operation.listedPriceCogtoshi,
          resolved: {
            sender: operation.resolvedSender,
            economicEffect: operation.resolvedEconomicEffect,
          },
          fees,
        }),
      });
    },
    async confirm({ operation }) {
      if (operation.listedPriceCogtoshi > 0n) {
        await confirmSell(
          options.prompter,
          operation.normalizedDomainName,
          operation.resolvedSender,
          operation.listedPriceCogtoshi,
          options.assumeYes,
        );
      }
    },
    createDraftMutation({ operation, existingMutation, execution, intentFingerprintHex }) {
      return {
        mutation: createDraftMutation({
          kind: "sell",
          domainName: operation.normalizedDomainName,
          sender: operation.sender,
          priceCogtoshi: operation.listedPriceCogtoshi,
          intentFingerprintHex,
          nowUnixMs: execution.nowUnixMs,
          feeSelection: execution.feeSelection,
          existing: existingMutation,
        }),
        prepared: null,
      };
    },
    async prepareBuildState({ state, execution }) {
      return (await prepareDomainMarketBuildState({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        provider: execution.provider,
        nowUnixMs: execution.nowUnixMs,
        paths: execution.paths,
        preflightCoinControl: false,
      })).state;
    },
    async build({ operation, state, execution, replacementFixedInputs }) {
      const sellPlan = buildPlanForDomainOperation({
        state,
        allUtxos: await execution.rpc.listUnspent(execution.walletName, 1),
        sender: operation.sender,
        opReturnData: serializeDomainSell(
          operation.chainDomain.domainId,
          operation.listedPriceCogtoshi,
        ).opReturnData,
        errorPrefix: "wallet_sell",
      });
      return buildTransaction({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        plan: {
          ...sellPlan,
          fixedInputs: mergeFixedWalletInputs(sellPlan.fixedInputs, replacementFixedInputs),
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
        errorPrefix: "wallet_sell",
        async afterAccepted({ state: acceptedState, broadcastingMutation, built, nowUnixMs }) {
          const finalStatus = getSellStatusAfterAcceptance({
            snapshot: execution.readContext.snapshot,
            domainName: operation.normalizedDomainName,
            senderScriptPubKeyHex: operation.sender.scriptPubKeyHex,
            listedPriceCogtoshi: operation.listedPriceCogtoshi,
          });
          const finalMutation = updateMutationRecord(broadcastingMutation, finalStatus, nowUnixMs, {
            attemptedTxid: built.txid,
            attemptedWtxid: built.wtxid,
            temporaryBuilderLockedOutpoints: [],
          });
          return {
            state: upsertPendingMutation(acceptedState, finalMutation),
            mutation: finalMutation,
            status: finalStatus,
          };
        },
      });
    },
    createResult({ operation, mutation, built, status, reusedExisting, fees }) {
      return {
        kind: "sell",
        domainName: operation.normalizedDomainName,
        txid: mutation.attemptedTxid ?? built?.txid ?? "unknown",
        status: status as DomainMarketMutationResult["status"],
        reusedExisting,
        listedPriceCogtoshi: operation.listedPriceCogtoshi,
        resolved: {
          sender: operation.resolvedSender,
          economicEffect: operation.resolvedEconomicEffect,
        },
        fees,
      };
    },
  });

  return execution.result;
}

export async function sellDomain(options: SellDomainOptions): Promise<DomainMarketMutationResult> {
  if (options.listedPriceCogtoshi < 0n) {
    throw new Error("wallet_sell_invalid_amount");
  }

  return runSellMutation(options);
}

export async function buyDomain(options: BuyDomainOptions): Promise<DomainMarketMutationResult> {
  const normalizedDomainName = normalizeDomainName(options.domainName);
  const execution = await executeWalletMutationOperation<
    BuyDomainMutationOperation,
    DomainMarketRpcClient,
    null,
    BuiltDomainMarketTransaction,
    DomainMarketMutationResult
  >({
    ...options,
    controlLockPurpose: "wallet-buy",
    preemptionReason: "wallet-buy",
    resolveOperation(readContext) {
      const operation = resolveBuyOperation(readContext, normalizedDomainName, options.fromIdentity ?? null);
      const model = readContext.model!;
      const sellerScriptPubKeyHex = Buffer.from(operation.chainDomain.ownerScriptPubKey).toString("hex");
      const sellerAddress = sellerScriptPubKeyHex === model.walletScriptPubKeyHex ? model.walletAddress : null;
      return {
        ...operation,
        normalizedDomainName,
        sellerScriptPubKeyHex,
        resolvedBuyer: {
          selector: operation.buyerSelector,
          localIndex: operation.sender.localIndex,
          scriptPubKeyHex: operation.sender.scriptPubKeyHex,
          address: operation.sender.address,
        },
        resolvedSeller: {
          scriptPubKeyHex: sellerScriptPubKeyHex,
          address: sellerAddress,
        },
      };
    },
    createIntentFingerprint(operation) {
      return createIntentFingerprint([
        "buy",
        operation.state.walletRootId,
        operation.normalizedDomainName,
        operation.sender.scriptPubKeyHex,
        operation.listingPriceCogtoshi.toString(),
      ]);
    },
    async resolveExistingMutation({ operation, existingMutation, execution }) {
      if (existingMutation === null) {
        return { state: operation.state, replacementFixedInputs: null, result: null };
      }
      return resolveExistingWalletMutation({
        existingMutation,
        execution,
        repairRequiredErrorCode: "wallet_buy_repair_required",
        reconcileExistingMutation: (mutation) => reconcilePendingMutation({
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
          kind: "buy",
          domainName: operation.normalizedDomainName,
          txid: mutation.attemptedTxid ?? "unknown",
          status: resolution,
          reusedExisting: true,
          listedPriceCogtoshi: operation.listingPriceCogtoshi,
          resolvedBuyer: operation.resolvedBuyer,
          resolvedSeller: operation.resolvedSeller,
          fees,
        }),
      });
    },
    confirm({ operation }) {
      return confirmBuy(
        options.prompter,
        operation.normalizedDomainName,
        operation.buyerSelector,
        operation.sender,
        operation.sellerScriptPubKeyHex,
        operation.resolvedSeller.address,
        operation.listingPriceCogtoshi,
        options.assumeYes,
      );
    },
    createDraftMutation({ operation, existingMutation, execution, intentFingerprintHex }) {
      return {
        mutation: createDraftMutation({
          kind: "buy",
          domainName: operation.normalizedDomainName,
          sender: operation.sender,
          priceCogtoshi: operation.listingPriceCogtoshi,
          intentFingerprintHex,
          nowUnixMs: execution.nowUnixMs,
          feeSelection: execution.feeSelection,
          existing: existingMutation,
        }),
        prepared: null,
      };
    },
    async prepareBuildState({ state, execution }) {
      return (await prepareDomainMarketBuildState({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        provider: execution.provider,
        nowUnixMs: execution.nowUnixMs,
        paths: execution.paths,
        preflightCoinControl: false,
      })).state;
    },
    async build({ operation, state, execution, replacementFixedInputs }) {
      const buyPlan = buildPlanForDomainOperation({
        state,
        allUtxos: await execution.rpc.listUnspent(execution.walletName, 1),
        sender: operation.sender,
        opReturnData: serializeDomainBuy(
          operation.chainDomain.domainId,
          operation.listingPriceCogtoshi,
        ).opReturnData,
        errorPrefix: "wallet_buy",
      });
      return buildTransaction({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        plan: {
          ...buyPlan,
          fixedInputs: mergeFixedWalletInputs(buyPlan.fixedInputs, replacementFixedInputs),
        },
        feeRateSatVb: execution.feeSelection.feeRateSatVb,
      });
    },
    beforePublish({ operation }) {
      const currentSellerHex = Buffer.from(operation.chainDomain.ownerScriptPubKey).toString("hex");
      if (currentSellerHex !== operation.sellerScriptPubKeyHex) {
        throw new Error("wallet_buy_stale_listing_owner");
      }
      return Promise.resolve();
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
        errorPrefix: "wallet_buy",
        async afterAccepted({ state: acceptedState, broadcastingMutation, built, nowUnixMs }) {
          const finalStatus = getBuyStatusAfterAcceptance({
            snapshot: execution.readContext.snapshot,
            domainName: operation.normalizedDomainName,
            buyerScriptPubKeyHex: operation.sender.scriptPubKeyHex,
          });
          const finalMutation = updateMutationRecord(broadcastingMutation, finalStatus, nowUnixMs, {
            attemptedTxid: built.txid,
            attemptedWtxid: built.wtxid,
            temporaryBuilderLockedOutpoints: [],
          });
          return {
            state: reserveTransferredDomainRecord({
              state: upsertPendingMutation(acceptedState, finalMutation),
              domainName: operation.normalizedDomainName,
              domainId: operation.chainDomain.domainId,
              currentOwnerScriptPubKeyHex: operation.sender.scriptPubKeyHex,
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
        kind: "buy",
        domainName: operation.normalizedDomainName,
        txid: mutation.attemptedTxid ?? built?.txid ?? "unknown",
        status: status as DomainMarketMutationResult["status"],
        reusedExisting,
        listedPriceCogtoshi: operation.listingPriceCogtoshi,
        resolvedBuyer: operation.resolvedBuyer,
        resolvedSeller: operation.resolvedSeller,
        fees,
      };
    },
  });

  return execution.result;
}
