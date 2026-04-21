import type { attachOrStartIndexerDaemon, probeIndexerDaemon } from "../../bitcoind/indexer-daemon.js";
import type { createRpcClient } from "../../bitcoind/node.js";
import type { attachOrStartManagedBitcoindService, probeManagedBitcoindService } from "../../bitcoind/service.js";
import type { RpcListUnspentEntry } from "../../bitcoind/types.js";
import type { requestMiningGenerationPreemption } from "../mining/coordination.js";
import type { startBackgroundMining } from "../mining/runner.js";
import type { WalletRuntimePaths } from "../runtime.js";
import type { WalletSecretProvider } from "../state/provider.js";
import type { WalletStateV1 } from "../types.js";

export interface WalletPrompter {
  readonly isInteractive: boolean;
  writeLine(message: string): void;
  prompt(message: string): Promise<string>;
  promptHidden?(message: string): Promise<string>;
  selectOption?(options: {
    message: string;
    options: Array<{
      label: string;
      description?: string | null;
      value: string;
    }>;
    initialValue?: string | null;
    footer?: string | null;
  }): Promise<string>;
  clearSensitiveDisplay?(scope: "mnemonic-reveal" | "restore-mnemonic-entry"): void | Promise<void>;
}

export interface WalletInitializationResult {
  setupMode: "generated" | "restored" | "existing";
  passwordAction: "created" | "migrated" | "already-configured";
  walletAction: "initialized" | "already-initialized";
  walletRootId: string;
  fundingAddress: string;
  state: WalletStateV1;
}

export interface WalletRepairResult {
  walletRootId: string;
  recoveredFromBackup: boolean;
  recreatedManagedCoreWallet: boolean;
  resetIndexerDatabase: boolean;
  bitcoindServiceAction: "none" | "cleared-stale-artifacts" | "stopped-incompatible-service" | "restarted-compatible-service";
  bitcoindCompatibilityIssue: "none" | "service-version-mismatch" | "wallet-root-mismatch" | "runtime-mismatch";
  managedCoreReplicaAction: "none" | "recreated";
  bitcoindPostRepairHealth: "ready" | "catching-up" | "starting" | "failed" | "unavailable";
  indexerDaemonAction: "none" | "cleared-stale-artifacts" | "stopped-incompatible-daemon" | "restarted-compatible-daemon";
  indexerCompatibilityIssue: "none" | "service-version-mismatch" | "wallet-root-mismatch" | "schema-mismatch";
  indexerPostRepairHealth: "starting" | "catching-up" | "synced" | "failed";
  miningPreRepairRunMode: "stopped" | "foreground" | "background";
  miningResumeAction: "none" | "skipped-not-resumable" | "skipped-post-repair-blocked" | "resumed-background" | "resume-failed";
  miningPostRepairRunMode: "stopped" | "background";
  miningResumeError: string | null;
  note: string | null;
}

export interface WalletLifecycleRpcClient {
  getDescriptorInfo(descriptor: string): Promise<{
    descriptor: string;
    checksum: string;
  }>;
  createWallet(walletName: string, options: {
    blank: boolean;
    descriptors: boolean;
    disablePrivateKeys: boolean;
    loadOnStartup: boolean;
    passphrase: string;
  }): Promise<unknown>;
  walletPassphrase(walletName: string, passphrase: string, timeoutSeconds: number): Promise<null>;
  importDescriptors(walletName: string, requests: Array<{
    desc: string;
    timestamp: string | number;
    active?: boolean;
    internal?: boolean;
    range?: number | [number, number];
  }>): Promise<Array<{ success: boolean }>>;
  walletLock(walletName: string): Promise<null>;
  deriveAddresses(descriptor: string, range?: number | [number, number]): Promise<string[]>;
  listDescriptors(walletName: string, privateOnly?: boolean): Promise<{
    descriptors: Array<{ desc: string }>;
  }>;
  getWalletInfo(walletName: string): Promise<{
    walletname: string;
    private_keys_enabled: boolean;
    descriptors: boolean;
  }>;
  loadWallet(walletName: string, loadOnStartup?: boolean): Promise<{ name: string; warning: string }>;
  unloadWallet?(walletName: string, loadOnStartup?: boolean): Promise<null>;
  listWallets(): Promise<string[]>;
  listUnspent(walletName: string, minConf?: number): Promise<RpcListUnspentEntry[]>;
  getBlockchainInfo(): Promise<{
    blocks: number;
    headers: number;
  }>;
}

export interface WalletManagedCoreDependencies {
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletLifecycleRpcClient;
}

export interface WalletSetupDependencies extends WalletManagedCoreDependencies {}

export interface WalletLifecycleResolvedContext {
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  nowUnixMs: number;
}

export interface WalletManagedCoreContext extends WalletLifecycleResolvedContext {
  attachService: NonNullable<WalletManagedCoreDependencies["attachService"]>;
  rpcFactory: NonNullable<WalletManagedCoreDependencies["rpcFactory"]>;
}

export interface WalletAccessContext extends WalletManagedCoreContext {
  dataDir?: string;
}

export interface WalletLoadedState {
  state: WalletStateV1;
  source: "primary" | "backup";
}

export interface WalletSetupContext extends WalletManagedCoreContext {
  dataDir: string;
  prompter: WalletPrompter;
}

export interface WalletRepairDependencies extends WalletManagedCoreDependencies {
  probeBitcoindService?: typeof probeManagedBitcoindService;
  attachIndexerDaemon?: typeof attachOrStartIndexerDaemon;
  probeIndexerDaemon?: typeof probeIndexerDaemon;
  requestMiningPreemption?: typeof requestMiningGenerationPreemption;
  startBackgroundMining?: typeof startBackgroundMining;
}

export interface WalletRepairContext extends WalletManagedCoreContext {
  dataDir: string;
  databasePath: string;
  assumeYes: boolean;
  probeBitcoindService: NonNullable<WalletRepairDependencies["probeBitcoindService"]>;
  attachIndexerDaemon: NonNullable<WalletRepairDependencies["attachIndexerDaemon"]>;
  probeIndexerDaemon: NonNullable<WalletRepairDependencies["probeIndexerDaemon"]>;
  requestMiningPreemption?: WalletRepairDependencies["requestMiningPreemption"];
  startBackgroundMining?: WalletRepairDependencies["startBackgroundMining"];
}

export interface WalletBitcoindRepairStageResult {
  state: WalletStateV1;
  repairStateNeedsPersist: boolean;
  recreatedManagedCoreWallet: boolean;
  bitcoindServiceAction: WalletRepairResult["bitcoindServiceAction"];
  bitcoindCompatibilityIssue: WalletRepairResult["bitcoindCompatibilityIssue"];
  managedCoreReplicaAction: WalletRepairResult["managedCoreReplicaAction"];
  bitcoindPostRepairHealth: WalletRepairResult["bitcoindPostRepairHealth"];
}

export interface WalletIndexerRepairStageResult {
  resetIndexerDatabase: boolean;
  indexerDaemonAction: WalletRepairResult["indexerDaemonAction"];
  indexerCompatibilityIssue: WalletRepairResult["indexerCompatibilityIssue"];
  indexerPostRepairHealth: WalletRepairResult["indexerPostRepairHealth"];
}
