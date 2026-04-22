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

export type DomainAdminKind = "endpoint" | "delegate" | "miner" | "canonical";

export interface DomainAdminRpcClient extends WalletMutationRpcClient {
  getBlockchainInfo(): Promise<{ blocks: number }>;
  sendRawTransaction(hex: string): Promise<string>;
  getRawTransaction(txid: string, verbose?: boolean): Promise<RpcTransaction>;
}

export interface DomainAdminPlan {
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

export interface DomainAdminOperation {
  readContext: ReadyWalletReadContext;
  state: WalletStateV1;
  sender: MutationSender;
  senderSelector: string;
  chainDomain: NonNullable<ReturnType<typeof lookupDomain>>;
}

export interface StandaloneDomainAdminOperation extends DomainAdminOperation {
  normalizedDomainName: string;
  resolvedSender: DomainAdminResolvedSenderSummary;
  payload: PreparedDomainAdminPayload;
}

export interface BuiltDomainAdminTransaction extends BuiltWalletMutationTransaction {}

export interface DomainAdminResolvedSenderSummary {
  selector: string;
  localIndex: number;
  scriptPubKeyHex: string;
  address: string;
}

export interface DomainAdminResolvedTargetSummary {
  scriptPubKeyHex: string;
  address: string | null;
  opaque: boolean;
}

export type DomainAdminResolvedEffect =
  | { kind: "endpoint-set"; byteLength: number }
  | { kind: "endpoint-clear" }
  | { kind: "delegate-set" }
  | { kind: "delegate-clear" }
  | { kind: "miner-set" }
  | { kind: "miner-clear" }
  | { kind: "canonicalize-owner" };

export interface DomainAdminResolvedSummary {
  sender: DomainAdminResolvedSenderSummary;
  target: DomainAdminResolvedTargetSummary | null;
  effect: DomainAdminResolvedEffect;
}

export interface DomainAdminMutationResult {
  kind: DomainAdminKind;
  domainName: string;
  txid: string;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  recipientScriptPubKeyHex?: string | null;
  endpointValueHex?: string | null;
  resolved?: DomainAdminResolvedSummary | null;
  fees: WalletMutationFeeSummary;
}

export interface PreparedDomainAdminPayload {
  opReturnData: Uint8Array;
  recipientScriptPubKeyHex?: string | null;
  endpointValueHex?: string | null;
  resolvedTarget: DomainAdminResolvedTargetSummary | null;
  resolvedEffect: DomainAdminResolvedEffect;
}

interface DomainAdminBaseOptions {
  domainName: string;
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
  rpcFactory?: (config: Parameters<typeof import("../../../bitcoind/node.js").createRpcClient>[0]) => DomainAdminRpcClient;
}

export interface SetDomainEndpointOptions extends DomainAdminBaseOptions {
  source:
    | { kind: "text"; value: string }
    | { kind: "json"; value: string }
    | { kind: "bytes"; value: string };
}

export interface ClearDomainEndpointOptions extends DomainAdminBaseOptions {}

export interface SetDomainDelegateOptions extends DomainAdminBaseOptions {
  target: string;
}

export interface ClearDomainDelegateOptions extends DomainAdminBaseOptions {}

export interface SetDomainMinerOptions extends DomainAdminBaseOptions {
  target: string;
}

export interface ClearDomainMinerOptions extends DomainAdminBaseOptions {}

export interface SetDomainCanonicalOptions extends DomainAdminBaseOptions {}

export interface DomainAdminDraftMutationOptions {
  kind: DomainAdminKind;
  domainName: string;
  sender: MutationSender;
  intentFingerprintHex: string;
  nowUnixMs: number;
  feeSelection: {
    feeRateSatVb: number;
    source: "custom-satvb" | "estimated-next-block-plus-one" | "fallback-default";
  };
  recipientScriptPubKeyHex?: string | null;
  endpointValueHex?: string | null;
  existing?: PendingMutationRecord | null;
}

export interface DomainAdminVariant {
  kind: DomainAdminKind;
  errorPrefix: string;
  requireRoot?: boolean;
  intentParts(operation: DomainAdminOperation): Array<string | number | bigint>;
  createPayload(operation: DomainAdminOperation): Promise<PreparedDomainAdminPayload>;
  confirm(operation: DomainAdminOperation): Promise<void>;
}
