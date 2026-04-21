import { type FileLockHandle } from "../fs/lock.js";
import type { attachOrStartManagedBitcoindService } from "../../bitcoind/service.js";
import type { createRpcClient } from "../../bitcoind/node.js";
import type { WalletRuntimePaths } from "../runtime.js";
import type { WalletSecretProvider } from "../state/provider.js";
import type { RawWalletStateEnvelope } from "../state/storage.js";
import type { WalletStateV1 } from "../types.js";
import type { WalletPrompter } from "../lifecycle.js";

export type WalletResetAction =
  | "not-present"
  | "kept-unchanged"
  | "retain-mnemonic"
  | "deleted";

export type WalletResetSecretCleanupStatus =
  | "deleted"
  | "not-found"
  | "failed"
  | "unknown";

export type WalletResetSnapshotResultStatus =
  | "not-present"
  | "invalid-removed"
  | "deleted"
  | "preserved";

export type WalletResetBitcoinDataDirResultStatus =
  | "not-present"
  | "preserved"
  | "deleted"
  | "outside-reset-scope";

export interface WalletResetResult {
  dataRoot: string;
  factoryResetReady: true;
  stoppedProcesses: {
    managedBitcoind: number;
    indexerDaemon: number;
    backgroundMining: number;
    survivors: number;
  };
  secretCleanupStatus: WalletResetSecretCleanupStatus;
  deletedSecretRefs: string[];
  failedSecretRefs: string[];
  preservedSecretRefs: string[];
  walletAction: WalletResetAction;
  walletOldRootId: string | null;
  walletNewRootId: string | null;
  bootstrapSnapshot: {
    status: WalletResetSnapshotResultStatus;
    path: string;
  };
  bitcoinDataDir: {
    status: WalletResetBitcoinDataDirResultStatus;
    path: string;
  };
  removedPaths: string[];
}

export interface WalletResetPreview {
  dataRoot: string;
  confirmationPhrase: "permanently reset";
  walletPrompt: null | {
    defaultAction: "retain-mnemonic";
    acceptedInputs: ["", "skip", "clear wallet entropy"];
    entropyRetainingResetAvailable: boolean;
    envelopeSource: "primary" | "backup" | null;
  };
  bootstrapSnapshot: {
    status: "not-present" | "invalid" | "valid";
    path: string;
    defaultAction: "preserve" | "delete";
  };
  bitcoinDataDir: {
    status: "not-present" | "within-reset-scope" | "outside-reset-scope";
    path: string;
    conditionalPrompt: null | {
      prompt: "Delete managed Bitcoin datadir too? [y/N]: ";
      defaultAction: "preserve";
      acceptedInputs: ["", "n", "no", "y", "yes"];
    };
  };
  trackedProcessKinds: Array<"managed-bitcoind" | "indexer-daemon" | "background-mining">;
  willDeleteOsSecrets: boolean;
  removedPaths: string[];
}

export type WalletEnvelopeMode = "provider-backed" | "unsupported-legacy" | "unknown";

export interface WalletResetPreflight {
  dataRoot: string;
  removedRoots: string[];
  wallet: {
    present: boolean;
    mode: WalletEnvelopeMode;
    envelopeSource: "primary" | "backup" | null;
    secretProviderKeyId: string | null;
    importedSeedSecretProviderKeyIds: string[];
    rawEnvelope: RawWalletStateEnvelope | null;
  };
  snapshot: {
    status: "not-present" | "invalid" | "valid";
    path: string;
    shouldPrompt: boolean;
    withinResetScope: boolean;
  };
  bitcoinDataDir: {
    status: "not-present" | "within-reset-scope" | "outside-reset-scope";
    path: string;
    shouldPrompt: boolean;
  };
  trackedProcesses: TrackedManagedProcess[];
  trackedProcessKinds: Array<TrackedManagedProcess["kind"]>;
  serviceLockPaths: string[];
}

export interface TrackedManagedProcess {
  kind: "managed-bitcoind" | "indexer-daemon" | "background-mining";
  pid: number;
}

export interface StagedArtifact {
  originalPath: string;
  stagedPath: string;
  restorePath: string;
}

export interface WalletAccessForReset {
  loaded: {
    source: "primary" | "backup";
    state: WalletStateV1;
  };
  access: {
    kind: "provider";
    provider: WalletSecretProvider;
  };
}

export interface ResetWalletRpcClient {
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
  listWallets(): Promise<string[]>;
}

export interface ResetExecutionDecision {
  walletChoice: "" | "skip" | "clear wallet entropy";
  deleteSnapshot: boolean;
  deleteBitcoinDataDir: boolean;
  loadedWalletForEntropyReset: WalletAccessForReset | null;
}

export interface WalletResetArtifactDependencies {
  access?: typeof import("node:fs/promises").access;
  copyFile?: typeof import("node:fs/promises").copyFile;
  mkdir?: typeof import("node:fs/promises").mkdir;
  readFile?: typeof import("node:fs/promises").readFile;
  rename?: typeof import("node:fs/promises").rename;
  remove?: typeof import("node:fs/promises").rm;
}

export interface WalletResetProcessCleanupDependencies {
  acquireLock?: (
    path: string,
    metadata: { purpose: string; walletRootId: null },
  ) => Promise<FileLockHandle>;
  processKill?: typeof process.kill;
  sleep?: (ms: number) => Promise<void>;
}

export interface WalletResetBaseOptions {
  dataDir: string;
  provider?: WalletSecretProvider;
  paths?: WalletRuntimePaths;
}

export interface WalletResetPreflightOptions extends WalletResetBaseOptions {
  validateSnapshotFile?: (path: string) => Promise<void>;
  artifactDeps?: WalletResetArtifactDependencies;
  processCleanupDeps?: WalletResetProcessCleanupDependencies;
}

export interface WalletResetExecutionOptions extends WalletResetPreflightOptions {
  prompter: WalletPrompter;
  nowUnixMs?: number;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => ResetWalletRpcClient;
}
