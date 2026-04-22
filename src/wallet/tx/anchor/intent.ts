import { createHash } from "node:crypto";

import { lookupDomain } from "@cogcoin/indexer/queries";

import { attachOrStartManagedBitcoindService } from "../../../bitcoind/service.js";
import { createRpcClient } from "../../../bitcoind/node.js";
import type { RpcListUnspentEntry } from "../../../bitcoind/types.js";
import type { WalletPrompter } from "../../lifecycle.js";
import { openWalletReadContext, type WalletReadContext } from "../../read/index.js";
import type { WalletRuntimePaths } from "../../runtime.js";
import type { WalletSecretProvider } from "../../state/provider.js";
import type { WalletStateV1 } from "../../types.js";
import {
  serializeDomainAnchor,
  validateDomainName,
} from "../../cogop/index.js";
import {
  assertWalletMutationContextReady,
  outpointKey,
  type FixedWalletInput,
  type WalletMutationRpcClient,
} from "../common.js";
import type { AnchorFoundingMessage } from "./confirm.js";

export interface WalletAnchorRpcClient extends WalletMutationRpcClient {
  getBlockchainInfo(): Promise<{ blocks: number }>;
  sendRawTransaction(hex: string): Promise<string>;
  getRawMempool(): Promise<string[]>;
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

export interface AnchorMutationOperation {
  state: WalletStateV1;
  normalizedDomainName: string;
  chainDomain: NonNullable<ReturnType<typeof lookupDomain>>;
  message: AnchorFoundingMessage;
}

export interface DirectAnchorPlan {
  fixedInputs: FixedWalletInput[];
  outputs: unknown[];
  changeAddress: string;
  changePosition: number;
  expectedOpReturnScriptHex: string;
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
}

function normalizeDomainName(domainName: string): string {
  const normalized = domainName.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("wallet_anchor_missing_domain");
  }
  validateDomainName(normalized);
  return normalized;
}

function createIntentFingerprint(parts: Array<string | number | bigint>): string {
  return createHash("sha256")
    .update(parts.map((part) => String(part)).join("\n"))
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

export function normalizeAnchorDomainName(domainName: string): string {
  return normalizeDomainName(domainName);
}

export function resolveAnchorOperation(options: {
  readContext: WalletReadContext;
  normalizedDomainName: string;
  message: AnchorFoundingMessage;
}): AnchorMutationOperation {
  assertWalletMutationContextReady(options.readContext, "wallet_anchor");
  const state = options.readContext.localState.state;
  const chainDomain = lookupDomain(options.readContext.snapshot.state, options.normalizedDomainName);

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
    normalizedDomainName: options.normalizedDomainName,
    chainDomain,
    message: options.message,
  };
}

export function createAnchorOperationFingerprint(operation: AnchorMutationOperation): string {
  return createIntentFingerprint([
    "anchor",
    operation.state.walletRootId,
    operation.normalizedDomainName,
    operation.state.funding.scriptPubKeyHex,
    operation.message.payloadHex ?? "",
  ]);
}

export function buildDirectAnchorPlan(options: {
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
