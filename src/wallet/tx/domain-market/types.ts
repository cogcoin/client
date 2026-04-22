import type {
  getListing,
  lookupDomain,
} from "@cogcoin/indexer/queries";

import type {
  RpcListUnspentEntry,
  RpcTransaction,
} from "../../../bitcoind/types.js";
import type { WalletPrompter } from "../../lifecycle.js";
import type { WalletReadContext } from "../../read/index.js";
import type { WalletRuntimePaths } from "../../runtime.js";
import type { WalletSecretProvider } from "../../state/provider.js";
import type {
  DomainRecord,
  PendingMutationRecord,
  WalletStateV1,
} from "../../types.js";
import type {
  BuiltWalletMutationTransaction,
  FixedWalletInput,
  MutationSender,
  WalletMutationFeeSummary,
  WalletMutationRpcClient,
} from "../common.js";

export type DomainMarketKind = "transfer" | "sell" | "buy";

export interface DomainMarketRpcClient extends WalletMutationRpcClient {
  getBlockchainInfo(): Promise<{
    blocks: number;
  }>;
  sendRawTransaction(hex: string): Promise<string>;
  getRawMempool(): Promise<string[]>;
  getRawTransaction(txid: string, verbose?: boolean): Promise<RpcTransaction>;
}

export interface DomainMarketPlan {
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

export interface BuiltDomainMarketTransaction extends BuiltWalletMutationTransaction {}

export interface DomainOperationContext {
  readContext: WalletReadContext;
  state: WalletStateV1;
  sender: MutationSender;
  senderSelector: string;
  chainDomain: NonNullable<ReturnType<typeof lookupDomain>>;
}

export interface BuyOperationContext extends DomainOperationContext {
  listingPriceCogtoshi: bigint;
  buyerSelector: string;
}

export interface TransferDomainMutationOperation extends DomainOperationContext {
  normalizedDomainName: string;
  recipient: ReturnType<typeof import("../targets.js").normalizeBtcTarget>;
  resolvedSender: DomainMarketResolvedSenderSummary;
  resolvedRecipient: DomainMarketResolvedRecipientSummary;
  resolvedEconomicEffect: DomainMarketResolvedEconomicEffect;
}

export interface SellDomainMutationOperation extends DomainOperationContext {
  normalizedDomainName: string;
  listedPriceCogtoshi: bigint;
  resolvedSender: DomainMarketResolvedSenderSummary;
  resolvedEconomicEffect: DomainMarketResolvedEconomicEffect;
}

export interface BuyDomainMutationOperation extends BuyOperationContext {
  normalizedDomainName: string;
  sellerScriptPubKeyHex: string;
  resolvedBuyer: DomainMarketResolvedBuyerSummary;
  resolvedSeller: DomainMarketResolvedSellerSummary;
}

export type DomainMarketOperation =
  | TransferDomainMutationOperation
  | SellDomainMutationOperation
  | BuyDomainMutationOperation;

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
  openReadContext?: typeof import("../../read/index.js").openWalletReadContext;
  attachService?: typeof import("../../../bitcoind/service.js").attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof import("../../../bitcoind/node.js").createRpcClient>[0]) => DomainMarketRpcClient;
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
  openReadContext?: typeof import("../../read/index.js").openWalletReadContext;
  attachService?: typeof import("../../../bitcoind/service.js").attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof import("../../../bitcoind/node.js").createRpcClient>[0]) => DomainMarketRpcClient;
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
  openReadContext?: typeof import("../../read/index.js").openWalletReadContext;
  attachService?: typeof import("../../../bitcoind/service.js").attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof import("../../../bitcoind/node.js").createRpcClient>[0]) => DomainMarketRpcClient;
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

export interface DomainMarketDraftMutationOptions {
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
}

export interface DomainMarketBuildState {
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
}

export interface DomainMarketMutationVariant<TOperation extends DomainMarketOperation> {
  controlLockPurpose: string;
  preemptionReason: string;
  errorPrefix: string;
  repairRequiredErrorCode: string;
  resolveOperation(readContext: WalletReadContext): TOperation;
  createIntentFingerprint(operation: TOperation): string;
  confirm(operation: TOperation): Promise<void>;
  createDraftMutation(options: {
    operation: TOperation;
    existingMutation: PendingMutationRecord | null;
    feeSelection: {
      feeRateSatVb: number;
      source: "custom-satvb" | "estimated-next-block-plus-one" | "fallback-default";
    };
    intentFingerprintHex: string;
    nowUnixMs: number;
  }): PendingMutationRecord;
  createOpReturnData(operation: TOperation): Uint8Array;
  beforePublish?(operation: TOperation): Promise<void>;
  afterAccepted(options: {
    operation: TOperation;
    acceptedState: WalletStateV1;
    broadcastingMutation: PendingMutationRecord;
    built: BuiltDomainMarketTransaction;
    nowUnixMs: number;
    snapshot: WalletReadContext["snapshot"];
  }): Promise<{
    state: WalletStateV1;
    mutation: PendingMutationRecord;
    status: "live" | "confirmed";
  }>;
  createReuseResult(options: {
    operation: TOperation;
    mutation: PendingMutationRecord;
    resolution: "confirmed" | "live";
    fees: WalletMutationFeeSummary;
  }): DomainMarketMutationResult;
  createResult(options: {
    operation: TOperation;
    mutation: PendingMutationRecord;
    builtTxid: string | null;
    status: "live" | "confirmed";
    reusedExisting: boolean;
    fees: WalletMutationFeeSummary;
  }): DomainMarketMutationResult;
}
