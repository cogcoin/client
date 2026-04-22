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

export type FieldMutationKind = "field-create" | "field-set" | "field-clear";

export type FieldValueInputSource =
  | { kind: "text"; value: string }
  | { kind: "json"; value: string }
  | { kind: "bytes"; value: string }
  | { kind: "raw"; format: string; value: string };

export interface FieldRpcClient extends WalletMutationRpcClient {
  getBlockchainInfo(): Promise<{ blocks: number }>;
  sendRawTransaction(hex: string): Promise<string>;
  getRawTransaction(txid: string, verbose?: boolean): Promise<RpcTransaction>;
}

export interface FieldPlan {
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

export interface FieldOperation {
  readContext: ReadyWalletReadContext;
  state: WalletStateV1;
  sender: MutationSender;
  senderSelector: string;
  chainDomain: NonNullable<ReturnType<typeof lookupDomain>>;
}

export interface StandaloneFieldMutationOperation extends FieldOperation {
  normalizedDomainName: string;
  normalizedFieldName: string;
  existingObservedField: ReturnType<typeof import("../../read/index.js").findDomainField>;
}

export interface NormalizedFieldValue {
  format: number;
  formatLabel: string;
  value: Uint8Array;
  valueHex: string;
}

export interface CreateFieldOptions {
  domainName: string;
  fieldName: string;
  permanent?: boolean;
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
  rpcFactory?: (config: Parameters<typeof import("../../../bitcoind/node.js").createRpcClient>[0]) => FieldRpcClient;
}

export interface SetFieldOptions extends Omit<CreateFieldOptions, "permanent"> {
  source: FieldValueInputSource;
}

export interface ClearFieldOptions extends Omit<CreateFieldOptions, "permanent" | "source"> {}

export interface FieldMutationResult {
  kind: FieldMutationKind;
  domainName: string;
  fieldName: string;
  fieldId: number | null;
  txid: string;
  permanent: boolean | null;
  format: number | null;
  status: "live" | "confirmed";
  reusedExisting: boolean;
  resolved?: FieldResolvedSummary | null;
  fees: WalletMutationFeeSummary;
}

export interface FieldResolvedSenderSummary {
  selector: string;
  localIndex: number;
  scriptPubKeyHex: string;
  address: string;
}

export type FieldResolvedPath =
  | "standalone-field-reg"
  | "standalone-data-update"
  | "standalone-data-clear";

export interface FieldResolvedValueSummary {
  format: number;
  byteLength: number;
}

export type FieldResolvedEffect =
  | { kind: "create-empty-field"; burnCogtoshi: "100" }
  | { kind: "write-field-value"; burnCogtoshi: "1" }
  | { kind: "clear-field-value"; burnCogtoshi: "0" };

export interface FieldResolvedSummary {
  sender: FieldResolvedSenderSummary;
  path: FieldResolvedPath;
  value: FieldResolvedValueSummary | null;
  effect: FieldResolvedEffect;
}

export interface FieldDraftMutationOptions {
  kind: FieldMutationKind;
  domainName: string;
  fieldName: string;
  sender: MutationSender;
  intentFingerprintHex: string;
  nowUnixMs: number;
  feeSelection: {
    feeRateSatVb: number;
    source: "custom-satvb" | "estimated-next-block-plus-one" | "fallback-default";
  };
  existing?: PendingMutationRecord | null;
  fieldId?: number | null;
  fieldPermanent?: boolean | null;
  fieldFormat?: number | null;
  fieldValueHex?: string | null;
}

export interface PreparedFieldMutation {
  opReturnData: Uint8Array;
  mutation: PendingMutationRecord;
}

export interface FieldMutationVariant {
  kind: FieldMutationKind;
  errorPrefix: string;
  createMutation(options: {
    operation: FieldOperation;
    existing: PendingMutationRecord | null;
    feeSelection: {
      feeRateSatVb: number;
      source: "custom-satvb" | "estimated-next-block-plus-one" | "fallback-default";
    };
    nowUnixMs: number;
  }): Promise<PreparedFieldMutation>;
  confirm(operation: FieldOperation): Promise<void>;
}
