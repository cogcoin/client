import type { inspectPassiveClientStatus } from "../passive-status.js";
import { openManagedBitcoindClient } from "../bitcoind/index.js";
import type { ManagedIndexerMonitor, openManagedIndexerMonitor } from "../bitcoind/indexer-monitor.js";
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
  previewResetWallet,
  repairWallet,
  resetWallet,
  showWalletMnemonic,
} from "../wallet/lifecycle.js";
import type { openWalletReadContext } from "../wallet/read/index.js";
import { loadRawWalletStateEnvelope, loadWalletState } from "../wallet/state/storage.js";
import type { WalletSecretProvider } from "../wallet/state/provider.js";
import type {
  ensureBuiltInMiningSetupIfNeeded,
  followMiningLog,
  inspectMiningControlPlane,
  inspectMiningDomainPromptState,
  readMiningLog,
  runForegroundMining,
  setupBuiltInMining,
  startBackgroundMining,
  stopBackgroundMining,
  updateMiningDomainPrompt,
} from "../wallet/mining/index.js";
import type {
  anchorDomain,
  transferBitcoin,
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
import type { CommandHandlerFamily, CommandName } from "./command-registry.js";

export type { CommandHandlerFamily, CommandName } from "./command-registry.js";

export type ProgressOutput = "auto" | "tty" | "none";

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
  commandFamily: CommandHandlerFamily | null;
  invokedCommandTokens: readonly string[] | null;
  invokedCommandPath: string | null;
  args: string[];
  help: boolean;
  version: boolean;
  dbPath: string | null;
  dataDir: string | null;
  progressOutput: ProgressOutput;
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
  satvb: number | null;
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

export interface ManagedIndexerMonitorLike extends ManagedIndexerMonitor {}

export interface CliRunnerContext {
  stdout?: WritableLike;
  stderr?: WritableLike;
  stdin?: ReadableLike;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  signalSource?: SignalSource;
  forceExit?: (code: number) => never | void;
  fetchImpl?: typeof fetch;
  runGlobalClientUpdateInstall?: (options: {
    stdout: WritableLike;
    stderr: WritableLike;
    env: NodeJS.ProcessEnv;
  }) => Promise<void>;
  openSqliteStore?: typeof openSqliteStore;
  openManagedBitcoindClient?: (options: {
    store: ClientStoreAdapter;
    dataDir?: string;
    walletRootId?: string;
    progressOutput?: ProgressOutput;
    onProgress?: (event: ManagedBitcoindProgressEvent) => void;
    confirmGetblockArchiveRestart?: (options: {
      currentArchiveEndHeight: number | null;
      nextArchiveEndHeight: number;
    }) => Promise<boolean>;
  }) => Promise<ManagedClientLike>;
  openManagedIndexerMonitor?: typeof openManagedIndexerMonitor;
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
  previewResetWallet?: typeof previewResetWallet;
  showWalletMnemonic?: typeof showWalletMnemonic;
  registerDomain?: typeof registerDomain;
  anchorDomain?: typeof anchorDomain;
  transferBitcoin?: typeof transferBitcoin;
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
  inspectMiningDomainPromptState?: typeof inspectMiningDomainPromptState;
  ensureBuiltInMiningSetupIfNeeded?: typeof ensureBuiltInMiningSetupIfNeeded;
  runForegroundMining?: typeof runForegroundMining;
  startBackgroundMining?: typeof startBackgroundMining;
  stopBackgroundMining?: typeof stopBackgroundMining;
  setupBuiltInMining?: typeof setupBuiltInMining;
  updateMiningDomainPrompt?: typeof updateMiningDomainPrompt;
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
  resolveWalletRuntimePaths?: () => WalletRuntimePaths;
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
