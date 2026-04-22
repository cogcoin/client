import { createHash } from "node:crypto";

import { loadBundledGenesisParameters } from "@cogcoin/indexer";
import { getBalance, getParent, lookupDomain } from "@cogcoin/indexer/queries";

import { attachOrStartManagedBitcoindService } from "../../../bitcoind/service.js";
import { createRpcClient } from "../../../bitcoind/node.js";
import type { WalletPrompter } from "../../lifecycle.js";
import { openWalletReadContext, type WalletReadContext } from "../../read/index.js";
import type { WalletRuntimePaths } from "../../runtime.js";
import type { WalletSecretProvider } from "../../state/provider.js";
import type {
  ScriptPubKeyHex,
  WalletStateV1,
} from "../../types.js";
import { computeRootRegistrationPriceSats, serializeDomainReg } from "../../cogop/index.js";
import {
  assertWalletMutationContextReady,
  createFundingMutationSender,
  isLocalWalletScript,
  type BuiltWalletMutationTransaction,
  type MutationSender,
  type WalletMutationRpcClient,
} from "../common.js";
import {
  SUBDOMAIN_REGISTRATION_FEE_COGTOSHI,
  type RegisterResolvedSummary,
} from "./result.js";

export interface WalletRegisterRpcClient extends WalletMutationRpcClient {
  getBlockchainInfo(): Promise<{
    blocks: number;
  }>;
  sendRawTransaction(hex: string): Promise<string>;
  getRawMempool(): Promise<string[]>;
  getRawTransaction(txid: string, verbose?: boolean): Promise<import("../../../bitcoind/types.js").RpcTransaction>;
}

export type BuiltRegisterTransaction = BuiltWalletMutationTransaction;

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

export interface ResolvedRegisterSender {
  registerKind: "root" | "subdomain";
  parentDomainName: string | null;
  sender: MutationSender;
  senderSelector: string;
}

export interface RegisterMutationOperation {
  state: WalletStateV1;
  normalizedDomainName: string;
  senderResolution: ResolvedRegisterSender;
  rootPriceSats: bigint;
  resolvedSummary: RegisterResolvedSummary;
  genesis: Awaited<ReturnType<typeof loadBundledGenesisParameters>>;
}

function normalizeDomainName(domainName: string): string {
  const normalized = domainName.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new Error("wallet_register_missing_domain");
  }
  serializeDomainReg(normalized);
  return normalized;
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

export function normalizeRegisterDomainName(domainName: string): string {
  return normalizeDomainName(domainName);
}

export function resolveRegisterSender(
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
  if (!isLocalWalletScript(state, parentDomain?.ownerScriptPubKeyHex as ScriptPubKeyHex | null | undefined)) {
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

export function createRegisterResolvedSummary(options: {
  registerKind: "root" | "subdomain";
  parentDomainName: string | null;
  senderSelector: string;
  sender: MutationSender;
  economicEffectKind: "treasury-payment" | "cog-burn";
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

export async function resolveRegisterOperation(options: {
  readContext: WalletReadContext;
  normalizedDomainName: string;
  fromIdentity?: string | null;
  loadGenesisParameters?: typeof loadBundledGenesisParameters;
}): Promise<RegisterMutationOperation> {
  assertWalletMutationContextReady(options.readContext, "wallet_register");
  const state = options.readContext.localState.state!;
  const senderResolution = resolveRegisterSender(options.readContext, options.normalizedDomainName, options.fromIdentity);

  if (lookupDomain(options.readContext.snapshot!.state, options.normalizedDomainName) !== null) {
    throw new Error("wallet_register_domain_already_registered");
  }

  if (options.readContext.snapshot!.state.consensus.nextDomainId === 0xffff_ffff) {
    throw new Error("wallet_register_next_domain_id_exhausted");
  }

  const rootPriceSats = computeRootRegistrationPriceSats(options.normalizedDomainName);
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
    normalizedDomainName: options.normalizedDomainName,
    senderResolution,
    rootPriceSats,
    resolvedSummary,
    genesis,
  };
}

export function createRegisterOperationFingerprint(operation: RegisterMutationOperation): string {
  return createRegisterIntentFingerprint({
    walletRootId: operation.state.walletRootId,
    domainName: operation.normalizedDomainName,
    registerKind: operation.senderResolution.registerKind,
    senderScriptPubKeyHex: operation.senderResolution.sender.scriptPubKeyHex,
  });
}
