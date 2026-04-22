import type { PendingMutationRecord } from "../../types.js";
import type { WalletMutationFeeSummary } from "../common.js";

export const SUBDOMAIN_REGISTRATION_FEE_COGTOSHI = 100n;

export type RegisterEconomicEffectKind = "treasury-payment" | "cog-burn";

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

export function createRegisterReuseResult(options: {
  operation: {
    normalizedDomainName: string;
    senderResolution: {
      registerKind: "root" | "subdomain";
      parentDomainName: string | null;
      senderSelector: string;
      sender: {
        localIndex: number;
        scriptPubKeyHex: string;
        address: string;
      };
    };
    rootPriceSats: bigint;
    resolvedSummary: RegisterResolvedSummary;
  };
  mutation: PendingMutationRecord;
  resolution: "confirmed" | "live";
  fees: WalletMutationFeeSummary;
}): RegisterDomainResult {
  return {
    domainName: options.operation.normalizedDomainName,
    registerKind: options.operation.senderResolution.registerKind,
    parentDomainName: options.operation.senderResolution.parentDomainName,
    senderSelector: options.operation.senderResolution.senderSelector,
    senderLocalIndex: options.operation.senderResolution.sender.localIndex,
    senderScriptPubKeyHex: options.operation.senderResolution.sender.scriptPubKeyHex,
    senderAddress: options.operation.senderResolution.sender.address,
    economicEffectKind: options.operation.senderResolution.registerKind === "root" ? "treasury-payment" : "cog-burn",
    economicEffectAmount: options.operation.senderResolution.registerKind === "root"
      ? options.operation.rootPriceSats
      : SUBDOMAIN_REGISTRATION_FEE_COGTOSHI,
    resolved: options.operation.resolvedSummary,
    txid: options.mutation.attemptedTxid ?? "unknown",
    status: options.resolution,
    reusedExisting: true,
    fees: options.fees,
  };
}

export function createRegisterResult(options: {
  operation: {
    normalizedDomainName: string;
    senderResolution: {
      registerKind: "root" | "subdomain";
      parentDomainName: string | null;
      senderSelector: string;
      sender: {
        localIndex: number;
        scriptPubKeyHex: string;
        address: string;
      };
    };
    rootPriceSats: bigint;
    resolvedSummary: RegisterResolvedSummary;
  };
  mutation: PendingMutationRecord;
  builtTxid: string | null;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  fees: WalletMutationFeeSummary;
}): RegisterDomainResult {
  return {
    domainName: options.operation.normalizedDomainName,
    registerKind: options.operation.senderResolution.registerKind,
    parentDomainName: options.operation.senderResolution.parentDomainName,
    senderSelector: options.operation.senderResolution.senderSelector,
    senderLocalIndex: options.operation.senderResolution.sender.localIndex,
    senderScriptPubKeyHex: options.operation.senderResolution.sender.scriptPubKeyHex,
    senderAddress: options.operation.senderResolution.sender.address,
    economicEffectKind: options.operation.senderResolution.registerKind === "root" ? "treasury-payment" : "cog-burn",
    economicEffectAmount: options.operation.senderResolution.registerKind === "root"
      ? options.operation.rootPriceSats
      : SUBDOMAIN_REGISTRATION_FEE_COGTOSHI,
    resolved: options.operation.resolvedSummary,
    txid: options.mutation.attemptedTxid ?? options.builtTxid ?? "unknown",
    status: options.status,
    reusedExisting: options.reusedExisting,
    fees: options.fees,
  };
}
