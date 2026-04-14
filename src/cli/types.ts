import type { inspectPassiveClientStatus } from "../passive-status.js";
import { openManagedBitcoindClient } from "../bitcoind/index.js";
import { openSqliteStore } from "../sqlite/index.js";
import type { ClientStoreAdapter } from "../types.js";
import type {
  exportWallet,
  WalletPrompter,
  importWallet,
  initializeWallet,
  lockWallet,
  previewResetWallet,
  repairWallet,
  resetWallet,
  restoreWalletFromMnemonic,
  unlockWallet,
} from "../wallet/lifecycle.js";
import type { openWalletReadContext } from "../wallet/read/index.js";
import type { WalletSecretProvider } from "../wallet/state/provider.js";
import type {
  disableMiningHooks,
  enableMiningHooks,
  followMiningLog,
  inspectMiningControlPlane,
  readMiningLog,
  runForegroundMining,
  setupBuiltInMining,
  startBackgroundMining,
  stopBackgroundMining,
} from "../wallet/mining/index.js";
import type {
  anchorDomain,
  buyDomain,
  claimCogLock,
  clearDomainDelegate,
  clearDomainEndpoint,
  clearDomainMiner,
  clearField,
  createField,
  giveReputation,
  lockCogToDomain,
  registerDomain,
  reclaimCogLock,
  revokeReputation,
  sendCog,
  setField,
  setDomainCanonical,
  setDomainDelegate,
  setDomainEndpoint,
  setDomainMiner,
  sellDomain,
  transferDomain,
} from "../wallet/tx/index.js";

export type ProgressOutput = "auto" | "tty" | "none";
export type OutputMode = "text" | "json" | "preview-json";
export type CommandName =
  | "init"
  | "restore"
  | "reset"
  | "repair"
  | "sync"
  | "status"
  | "follow"
  | "unlock"
  | "anchor"
  | "domain-anchor"
  | "register"
  | "domain-register"
  | "transfer"
  | "domain-transfer"
  | "sell"
  | "domain-sell"
  | "unsell"
  | "domain-unsell"
  | "buy"
  | "domain-buy"
  | "domain-endpoint-set"
  | "domain-endpoint-clear"
  | "domain-delegate-set"
  | "domain-delegate-clear"
  | "domain-miner-set"
  | "domain-miner-clear"
  | "domain-canonical"
  | "field-list"
  | "field-show"
  | "field-create"
  | "field-set"
  | "field-clear"
  | "send"
  | "claim"
  | "reclaim"
  | "cog-send"
  | "cog-claim"
  | "cog-reclaim"
  | "cog-lock"
  | "rep-give"
  | "rep-revoke"
  | "cog-balance"
  | "cog-locks"
  | "hooks-mining-enable"
  | "hooks-mining-disable"
  | "hooks-mining-status"
  | "mine"
  | "mine-start"
  | "mine-stop"
  | "mine-setup"
  | "mine-status"
  | "mine-log"
  | "wallet-export"
  | "wallet-import"
  | "wallet-init"
  | "wallet-restore"
  | "wallet-lock"
  | "wallet-unlock"
  | "wallet-status"
  | "wallet-address"
  | "wallet-ids"
  | "address"
  | "ids"
  | "balance"
  | "locks"
  | "domain-list"
  | "domains"
  | "domain-show"
  | "show"
  | "fields"
  | "field";

export interface WritableLike {
  isTTY?: boolean;
  write(chunk: string): void;
}

export interface ReadableLike {
  isTTY?: boolean;
}

export interface SignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): void;
}

export interface ParsedCliArgs {
  command: CommandName | null;
  args: string[];
  help: boolean;
  version: boolean;
  outputMode: OutputMode;
  dbPath: string | null;
  dataDir: string | null;
  progressOutput: ProgressOutput;
  unlockFor: string | null;
  assumeYes: boolean;
  forceRace: boolean;
  anchorMessage: string | null;
  transferTarget: string | null;
  endpointText: string | null;
  endpointJson: string | null;
  endpointBytes: string | null;
  fieldPermanent: boolean;
  fieldFormat: string | null;
  fieldValue: string | null;
  fromIdentity: string | null;
  lockRecipientDomain: string | null;
  conditionHex: string | null;
  untilHeight: string | null;
  preimageHex: string | null;
  reviewText: string | null;
  locksClaimableOnly: boolean;
  locksReclaimableOnly: boolean;
  domainsAnchoredOnly: boolean;
  domainsListedOnly: boolean;
  domainsMineableOnly: boolean;
  listLimit: number | null;
  listAll: boolean;
  verify: boolean;
  follow: boolean;
}

export interface ManagedClientLike {
  syncToTip(): Promise<{
    appliedBlocks: number;
    rewoundBlocks: number;
    endingHeight: number | null;
    bestHeight: number;
  }>;
  playSyncCompletionScene?(): Promise<void>;
  startFollowingTip(): Promise<void>;
  getNodeStatus(): Promise<{
    indexedTip: {
      height: number;
      blockHashHex: string;
      stateHashHex: string | null;
    } | null;
    nodeBestHeight: number | null;
  }>;
  close(): Promise<void>;
}

export interface CliRunnerContext {
  stdout?: WritableLike;
  stderr?: WritableLike;
  stdin?: ReadableLike;
  signalSource?: SignalSource;
  forceExit?: (code: number) => never | void;
  openSqliteStore?: typeof openSqliteStore;
  openManagedBitcoindClient?: (options: {
    store: ClientStoreAdapter;
    databasePath?: string;
    dataDir?: string;
    progressOutput?: ProgressOutput;
  }) => Promise<ManagedClientLike>;
  inspectPassiveClientStatus?: typeof inspectPassiveClientStatus;
  openWalletReadContext?: typeof openWalletReadContext;
  initializeWallet?: typeof initializeWallet;
  restoreWalletFromMnemonic?: typeof restoreWalletFromMnemonic;
  previewResetWallet?: typeof previewResetWallet;
  exportWallet?: typeof exportWallet;
  importWallet?: typeof importWallet;
  unlockWallet?: typeof unlockWallet;
  lockWallet?: typeof lockWallet;
  registerDomain?: typeof registerDomain;
  anchorDomain?: typeof anchorDomain;
  transferDomain?: typeof transferDomain;
  sellDomain?: typeof sellDomain;
  buyDomain?: typeof buyDomain;
  sendCog?: typeof sendCog;
  claimCogLock?: typeof claimCogLock;
  reclaimCogLock?: typeof reclaimCogLock;
  lockCogToDomain?: typeof lockCogToDomain;
  setDomainEndpoint?: typeof setDomainEndpoint;
  clearDomainEndpoint?: typeof clearDomainEndpoint;
  setDomainDelegate?: typeof setDomainDelegate;
  clearDomainDelegate?: typeof clearDomainDelegate;
  setDomainMiner?: typeof setDomainMiner;
  clearDomainMiner?: typeof clearDomainMiner;
  setDomainCanonical?: typeof setDomainCanonical;
  createField?: typeof createField;
  setField?: typeof setField;
  clearField?: typeof clearField;
  giveReputation?: typeof giveReputation;
  revokeReputation?: typeof revokeReputation;
  enableMiningHooks?: typeof enableMiningHooks;
  disableMiningHooks?: typeof disableMiningHooks;
  inspectMiningControlPlane?: typeof inspectMiningControlPlane;
  runForegroundMining?: typeof runForegroundMining;
  startBackgroundMining?: typeof startBackgroundMining;
  stopBackgroundMining?: typeof stopBackgroundMining;
  setupBuiltInMining?: typeof setupBuiltInMining;
  readMiningLog?: typeof readMiningLog;
  followMiningLog?: typeof followMiningLog;
  repairWallet?: typeof repairWallet;
  resetWallet?: typeof resetWallet;
  walletSecretProvider?: WalletSecretProvider;
  createPrompter?: () => WalletPrompter;
  ensureDirectory?: (path: string) => Promise<void>;
  readPackageVersion?: () => Promise<string>;
  resolveDefaultBitcoindDataDir?: () => string;
  resolveDefaultClientDatabasePath?: () => string;
}

export interface StopSignalWatcher {
  cleanup(): void;
  isStopping(): boolean;
  promise: Promise<number>;
}

export type InterruptibleOutcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "stopped"; code: number };

export type RequiredCliRunnerContext = Required<CliRunnerContext>;
