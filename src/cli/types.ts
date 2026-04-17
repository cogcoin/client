import type { inspectPassiveClientStatus } from "../passive-status.js";
import { openManagedBitcoindClient } from "../bitcoind/index.js";
import { createRpcClient } from "../bitcoind/node.js";
import type { ManagedBitcoindProgressEvent } from "../bitcoind/types.js";
import {
  attachOrStartIndexerDaemon,
  probeIndexerDaemon,
  readObservedIndexerDaemonStatus,
  stopIndexerDaemonService,
} from "../bitcoind/indexer-daemon.js";
import {
  attachOrStartManagedBitcoindService,
  probeManagedBitcoindService,
  stopManagedBitcoindService,
} from "../bitcoind/service.js";
import { openSqliteStore } from "../sqlite/index.js";
import type { ClientStoreAdapter } from "../types.js";
import type { WalletRuntimePaths } from "../wallet/runtime.js";
import type {
  WalletPrompter,
  initializeWallet,
  deleteImportedWalletSeed,
  previewResetWallet,
  repairWallet,
  resetWallet,
  restoreWalletFromMnemonic,
  showWalletMnemonic,
} from "../wallet/lifecycle.js";
import type { openWalletReadContext } from "../wallet/read/index.js";
import { loadRawWalletStateEnvelope, loadWalletState } from "../wallet/state/storage.js";
import type { WalletSecretProvider } from "../wallet/state/provider.js";
import type {
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
  | "bitcoin-start"
  | "bitcoin-stop"
  | "bitcoin-status"
  | "indexer-start"
  | "indexer-stop"
  | "indexer-status"
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
  | "mine"
  | "mine-start"
  | "mine-stop"
  | "mine-setup"
  | "mine-status"
  | "mine-log"
  | "wallet-init"
  | "wallet-delete"
  | "wallet-restore"
  | "wallet-show-mnemonic"
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
  seedName: string | null;
  unlockFor: string | null;
  assumeYes: boolean;
  force: boolean;
  forceRace: boolean;
  anchorMessage: string | null;
  transferTarget: string | null;
  endpointText: string | null;
  endpointJson: string | null;
  endpointBytes: string | null;
  fieldPermanent: boolean;
  fieldFormat: string | null;
  fieldValue: string | null;
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
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  signalSource?: SignalSource;
  forceExit?: (code: number) => never | void;
  fetchImpl?: typeof fetch;
  openSqliteStore?: typeof openSqliteStore;
  openManagedBitcoindClient?: (options: {
    store: ClientStoreAdapter;
    databasePath?: string;
    dataDir?: string;
    walletRootId?: string;
    progressOutput?: ProgressOutput;
    onProgress?: (event: ManagedBitcoindProgressEvent) => void;
    confirmGetblockArchiveRestart?: (options: {
      currentArchiveEndHeight: number | null;
      nextArchiveEndHeight: number;
    }) => Promise<boolean>;
  }) => Promise<ManagedClientLike>;
  attachManagedBitcoindService?: typeof attachOrStartManagedBitcoindService;
  probeManagedBitcoindService?: typeof probeManagedBitcoindService;
  stopManagedBitcoindService?: typeof stopManagedBitcoindService;
  createBitcoinRpcClient?: typeof createRpcClient;
  attachIndexerDaemon?: typeof attachOrStartIndexerDaemon;
  probeIndexerDaemon?: typeof probeIndexerDaemon;
  readObservedIndexerDaemonStatus?: typeof readObservedIndexerDaemonStatus;
  stopIndexerDaemonService?: typeof stopIndexerDaemonService;
  inspectPassiveClientStatus?: typeof inspectPassiveClientStatus;
  openWalletReadContext?: typeof openWalletReadContext;
  loadWalletState?: typeof loadWalletState;
  loadRawWalletStateEnvelope?: typeof loadRawWalletStateEnvelope;
  initializeWallet?: typeof initializeWallet;
  restoreWalletFromMnemonic?: typeof restoreWalletFromMnemonic;
  previewResetWallet?: typeof previewResetWallet;
  deleteImportedWalletSeed?: typeof deleteImportedWalletSeed;
  showWalletMnemonic?: typeof showWalletMnemonic;
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
  resolveUpdateCheckStatePath?: () => string;
  resolveWalletRuntimePaths?: (seedName?: string | null) => WalletRuntimePaths;
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
