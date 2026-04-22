import type { lookupDomain } from "@cogcoin/indexer/queries";

import type {
  RpcListUnspentEntry,
  RpcTransaction,
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

export const MAX_LOCK_DURATION_BLOCKS = 262_800;
export const ZERO_PREIMAGE_HEX = "00".repeat(32);

export type CogMutationKind = "send" | "lock" | "claim";

export interface WalletCogRpcClient extends WalletMutationRpcClient {
  getBlockchainInfo(): Promise<{ blocks: number }>;
  sendRawTransaction(hex: string): Promise<string>;
  getRawTransaction(txid: string, verbose?: boolean): Promise<RpcTransaction>;
}

export interface CogMutationPlan {
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

export type BuiltCogMutationTransaction = BuiltWalletMutationTransaction;

export interface SendCogOperation {
  state: WalletStateV1;
  sender: MutationSender;
  resolved: CogResolvedSummary;
  amountCogtoshi: bigint;
  recipient: ReturnType<typeof import("../targets.js").normalizeBtcTarget>;
}

export interface LockCogMutationOperation {
  state: WalletStateV1;
  sender: MutationSender;
  resolved: CogResolvedSummary;
  amountCogtoshi: bigint;
  normalizedRecipientDomainName: string;
  recipientDomain: NonNullable<ReturnType<typeof lookupDomain>>;
  timeoutHeight: number;
  conditionHex: string;
}

export interface ClaimCogMutationOperation {
  state: WalletStateV1;
  sender: MutationSender;
  resolved: CogResolvedSummary;
  amountCogtoshi: bigint;
  recipientDomainName: string | null;
  lockId: number;
  preimageHex: string;
  errorPrefix: string;
}

export type CogMutationOperation =
  | SendCogOperation
  | LockCogMutationOperation
  | ClaimCogMutationOperation;

export type CogResolvedClaimPath = "recipient-claim" | "timeout-reclaim";

export interface CogResolvedSenderSummary {
  selector: string;
  localIndex: number;
  scriptPubKeyHex: string;
  address: string;
}

export interface CogResolvedSummary {
  sender: CogResolvedSenderSummary;
  claimPath: CogResolvedClaimPath | null;
}

export interface CogMutationResult {
  kind: CogMutationKind;
  txid: string;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  amountCogtoshi?: bigint;
  recipientScriptPubKeyHex?: string | null;
  recipientDomainName?: string | null;
  lockId?: number | null;
  resolved: CogResolvedSummary;
  fees: WalletMutationFeeSummary;
}

export interface SendCogOptions {
  amountCogtoshi: bigint;
  target: string;
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
  rpcFactory?: (config: Parameters<typeof import("../../../bitcoind/node.js").createRpcClient>[0]) => WalletCogRpcClient;
}

export interface LockCogToDomainOptions {
  amountCogtoshi: bigint;
  recipientDomainName: string;
  fromIdentity?: string | null;
  feeRateSatVb?: number | null;
  timeoutHeight?: number | null;
  timeoutBlocksOrDuration?: string | null;
  conditionHex: string;
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  assumeYes?: boolean;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  openReadContext?: typeof import("../../read/index.js").openWalletReadContext;
  attachService?: typeof import("../../../bitcoind/service.js").attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof import("../../../bitcoind/node.js").createRpcClient>[0]) => WalletCogRpcClient;
}

export interface ClaimCogLockOptions {
  lockId: number;
  preimageHex: string;
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
  rpcFactory?: (config: Parameters<typeof import("../../../bitcoind/node.js").createRpcClient>[0]) => WalletCogRpcClient;
}

export interface ReclaimCogLockOptions extends Omit<ClaimCogLockOptions, "preimageHex"> {}

export interface CogDraftMutationOptions {
  kind: CogMutationKind;
  sender: MutationSender;
  intentFingerprintHex: string;
  nowUnixMs: number;
  feeSelection: {
    feeRateSatVb: number;
    source: "custom-satvb" | "estimated-next-block-plus-one" | "fallback-default";
  };
  domainName?: string | null;
  recipientScriptPubKeyHex?: string | null;
  recipientDomainName?: string | null;
  amountCogtoshi?: bigint | null;
  timeoutHeight?: number | null;
  conditionHex?: string | null;
  lockId?: number | null;
  preimageHex?: string | null;
  existing?: PendingMutationRecord | null;
}

export interface CogMutationVariant<TOperation extends CogMutationOperation> {
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
  createReuseResult(options: {
    operation: TOperation;
    mutation: PendingMutationRecord;
    resolution: "confirmed" | "live";
    fees: WalletMutationFeeSummary;
  }): CogMutationResult;
  createResult(options: {
    operation: TOperation;
    mutation: PendingMutationRecord;
    builtTxid: string | null;
    status: "live" | "confirmed";
    reusedExisting: boolean;
    fees: WalletMutationFeeSummary;
  }): CogMutationResult;
}
