import type {
  InternalManagedBitcoindOptions,
} from "./types.js";

export interface ManagedWalletReplicaRpc {
  listWallets(): Promise<string[]>;
  loadWallet(walletName: string, loadOnStartup?: boolean): Promise<{ name: string; warning: string }>;
  createWallet(walletName: string, options: {
    blank: boolean;
    descriptors: boolean;
    disablePrivateKeys: boolean;
    loadOnStartup: boolean;
    passphrase: string;
  }): Promise<unknown>;
  getWalletInfo(walletName: string): Promise<{
    descriptors: boolean;
    private_keys_enabled: boolean;
  }>;
  walletLock(walletName: string): Promise<null>;
}

export type ManagedBitcoindServiceOptions = Pick<
  InternalManagedBitcoindOptions,
  | "dataDir"
  | "chain"
  | "startHeight"
  | "walletRootId"
  | "rpcPort"
  | "zmqPort"
  | "p2pPort"
  | "pollIntervalMs"
  | "startupTimeoutMs"
  | "shutdownTimeoutMs"
  | "managedWalletPassphrase"
> & {
  getblockArchivePath?: string | null;
  getblockArchiveEndHeight?: number | null;
  getblockArchiveSha256?: string | null;
  serviceLifetime?: "persistent" | "ephemeral";
};

export type ResolvedManagedBitcoindServiceOptions = ManagedBitcoindServiceOptions & {
  dataDir: string;
  walletRootId: string;
  startupTimeoutMs: number;
};

export type ManagedBitcoindServiceOwnership = "attached" | "started";

export interface ManagedBitcoindServiceStopResult {
  status: "stopped" | "not-running";
  walletRootId: string;
}
