import type { lookupDomain } from "@cogcoin/indexer/queries";

import type {
  RpcListUnspentEntry,
  RpcWalletTransaction,
} from "../../../bitcoind/types.js";
import type { WalletPrompter } from "../../lifecycle.js";
import type { WalletReadContext } from "../../read/index.js";
import type { WalletRuntimePaths } from "../../runtime.js";
import type { WalletSecretProvider } from "../../state/provider.js";
import type {
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

export type ReputationMutationKind = "rep-give" | "rep-revoke";

export interface ReputationRpcClient extends WalletMutationRpcClient {
  getBlockchainInfo(): Promise<{ blocks: number }>;
  sendRawTransaction(hex: string): Promise<string>;
  getTransaction(walletName: string, txid: string): Promise<RpcWalletTransaction>;
}

export interface ReputationPlan {
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

export type ReadyWalletReadContext = WalletReadContext & {
  localState: {
    availability: "ready";
    state: WalletStateV1;
  };
  snapshot: NonNullable<WalletReadContext["snapshot"]>;
  model: NonNullable<WalletReadContext["model"]>;
};

export interface ReputationOperation {
  readContext: ReadyWalletReadContext;
  state: WalletStateV1;
  sender: MutationSender;
  senderSelector: string;
  sourceDomain: NonNullable<ReturnType<typeof lookupDomain>>;
  targetDomain: NonNullable<ReturnType<typeof lookupDomain>>;
  availableBalanceCogtoshi: bigint;
  currentNetSupportCogtoshi: bigint;
}

export interface ReputationReview {
  text: string | null;
  payload: Uint8Array | undefined;
  payloadHex: string | null;
}

export interface StandaloneReputationOperation extends ReputationOperation {
  normalizedSourceDomainName: string;
  normalizedTargetDomainName: string;
  review: ReputationReview;
  resolved: ReputationResolvedSummary;
}

export interface BuiltReputationTransaction extends BuiltWalletMutationTransaction {}

export interface ReputationMutationResult {
  kind: "give" | "revoke";
  sourceDomainName: string;
  targetDomainName: string;
  amountCogtoshi: bigint;
  txid: string;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  reviewIncluded: boolean;
  resolved?: ReputationResolvedSummary | null;
  fees: WalletMutationFeeSummary;
}

export interface ReputationResolvedSenderSummary {
  selector: string;
  localIndex: number;
  scriptPubKeyHex: string;
  address: string;
}

export type ReputationResolvedEffect =
  | { kind: "give-support"; burnCogtoshi: string }
  | { kind: "revoke-support"; burnCogtoshi: string };

export interface ReputationResolvedReviewSummary {
  included: boolean;
  byteLength: number | null;
}

export interface ReputationResolvedSummary {
  sender: ReputationResolvedSenderSummary;
  effect: ReputationResolvedEffect;
  review: ReputationResolvedReviewSummary;
  selfStake: boolean;
}

interface ReputationBaseOptions {
  sourceDomainName: string;
  targetDomainName: string;
  amountCogtoshi: bigint;
  reviewText?: string | null;
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
  rpcFactory?: (config: Parameters<typeof import("../../../bitcoind/node.js").createRpcClient>[0]) => ReputationRpcClient;
}

export interface GiveReputationOptions extends ReputationBaseOptions {}

export interface RevokeReputationOptions extends ReputationBaseOptions {}

export interface ReputationDraftMutationOptions {
  kind: ReputationMutationKind;
  sourceDomainName: string;
  targetDomainName: string;
  amountCogtoshi: bigint;
  sender: MutationSender;
  intentFingerprintHex: string;
  nowUnixMs: number;
  reviewPayloadHex: string | null;
  feeSelection: {
    feeRateSatVb: number;
    source: "custom-satvb" | "estimated-next-block-plus-one" | "fallback-default";
  };
  existing?: PendingMutationRecord | null;
}
