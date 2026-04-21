import type { TestContext } from "node:test";
import { join } from "node:path";

import { deriveWalletMaterialFromMnemonic } from "../src/wallet/material.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createMemoryWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { saveWalletState } from "../src/wallet/state/storage.js";
import type { WalletStateV1 } from "../src/wallet/types.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { createWalletState } from "./current-model-helpers.js";

export const DEFAULT_TEST_MNEMONIC = `${"abandon ".repeat(23)}art`;

export function createDerivedWalletState(options: {
  mnemonic?: string;
  walletRootId?: string;
  proofStatus?: WalletStateV1["managedCoreWallet"]["proofStatus"];
  descriptorChecksum?: string | null;
} = {}): WalletStateV1 {
  const material = deriveWalletMaterialFromMnemonic(options.mnemonic ?? DEFAULT_TEST_MNEMONIC);
  const walletRootId = options.walletRootId ?? "wallet-root";

  return {
    schemaVersion: 5,
    stateRevision: 1,
    lastWrittenAtUnixMs: 1,
    walletRootId,
    network: "mainnet",
    localScriptPubKeyHexes: [material.funding.scriptPubKeyHex],
    mnemonic: {
      phrase: material.mnemonic.phrase,
      language: material.mnemonic.language,
    },
    keys: {
      ...material.keys,
    },
    descriptor: {
      ...material.descriptor,
      checksum: options.descriptorChecksum ?? material.descriptor.checksum,
    },
    funding: {
      ...material.funding,
    },
    walletBirthTime: 123,
    managedCoreWallet: {
      walletName: `cogcoin-${walletRootId}`,
      internalPassphrase: "test-managed-passphrase",
      descriptorChecksum: options.descriptorChecksum ?? material.descriptor.checksum,
      walletAddress: material.funding.address,
      walletScriptPubKeyHex: material.funding.scriptPubKeyHex,
      proofStatus: options.proofStatus ?? "ready",
      lastImportedAtUnixMs: null,
      lastVerifiedAtUnixMs: null,
    },
    domains: [],
    miningState: createWalletState().miningState,
    pendingMutations: [],
  };
}

export async function createWalletLifecycleFixture(
  t: TestContext,
  options: {
    state?: WalletStateV1 | null;
  } = {},
) {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-wallet-lifecycle");
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = options.state === undefined ? createWalletState() : options.state;

  if (state !== null) {
    const secretReference = createWalletSecretReference(state.walletRootId);
    await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 47));
    await saveWalletState(
      {
        primaryPath: paths.walletStatePath,
        backupPath: paths.walletStateBackupPath,
      },
      state,
      {
        provider,
        secretReference,
      },
    );
  }

  return {
    homeDirectory,
    dataDir: homeDirectory,
    databasePath: join(homeDirectory, "client.sqlite"),
    paths,
    provider,
    state,
  };
}

export function createManagedCoreRpcHarness(options: {
  mnemonic?: string;
  checksum?: string;
  derivedAddress?: string | null;
  listedDescriptors?: string[] | null;
  walletInfo?: {
    private_keys_enabled: boolean;
    descriptors: boolean;
  };
  loadedWallets?: string[];
} = {}) {
  let material = deriveWalletMaterialFromMnemonic(options.mnemonic ?? DEFAULT_TEST_MNEMONIC);
  const checksum = options.checksum ?? "abcd1234";
  let derivedAddress = options.derivedAddress ?? null;
  let listedDescriptors = options.listedDescriptors ?? null;
  let loadedWallets = [...(options.loadedWallets ?? [])];
  const createdWallets: string[] = [];
  const unloadedWallets: string[] = [];
  const importedDescriptors: Array<{
    walletName: string;
    requests: Array<{
      desc: string;
      timestamp: string | number;
      active?: boolean;
      internal?: boolean;
      range?: number | [number, number];
    }>;
  }> = [];

  const normalizedPublicDescriptor = (): string => {
    return `${material.descriptor.publicExternal.replace(/#[A-Za-z0-9]+$/, "")}#${checksum}`;
  };

  const rpc = {
    async getDescriptorInfo(descriptor: string) {
      return {
        descriptor,
        checksum,
      };
    },
    async createWallet(walletName: string) {
      if (!loadedWallets.includes(walletName)) {
        loadedWallets.push(walletName);
      }
      createdWallets.push(walletName);
      return {};
    },
    async walletPassphrase() {
      return null;
    },
    async importDescriptors(walletName: string, requests: Array<{
      desc: string;
      timestamp: string | number;
      active?: boolean;
      internal?: boolean;
      range?: number | [number, number];
    }>) {
      importedDescriptors.push({
        walletName,
        requests,
      });
      return requests.map(() => ({ success: true }));
    },
    async walletLock() {
      return null;
    },
    async deriveAddresses() {
      return [derivedAddress ?? material.funding.address];
    },
    async listDescriptors() {
      return {
        descriptors: (listedDescriptors ?? [normalizedPublicDescriptor()]).map((desc) => ({ desc })),
      };
    },
    async getWalletInfo(walletName: string) {
      return {
        walletname: walletName,
        private_keys_enabled: options.walletInfo?.private_keys_enabled ?? true,
        descriptors: options.walletInfo?.descriptors ?? true,
      };
    },
    async loadWallet(walletName: string) {
      if (!loadedWallets.includes(walletName)) {
        throw new Error("not found");
      }

      return {
        name: walletName,
        warning: "",
      };
    },
    async unloadWallet(walletName: string) {
      unloadedWallets.push(walletName);
      loadedWallets = loadedWallets.filter((entry) => entry !== walletName);
      return null;
    },
    async listWallets() {
      return [...loadedWallets];
    },
    async listUnspent() {
      return [];
    },
    async getBlockchainInfo() {
      return {
        blocks: 10,
        headers: 10,
      };
    },
  };

  return {
    dependencies: {
      async attachService() {
        return {
          rpc: {} as any,
          stop: async () => undefined,
        } as any;
      },
      rpcFactory() {
        return rpc as any;
      },
    },
    rpc,
    createdWallets,
    unloadedWallets,
    importedDescriptors,
    setExpectedMnemonic(mnemonic: string) {
      material = deriveWalletMaterialFromMnemonic(mnemonic);
    },
    setDerivedAddress(nextAddress: string | null) {
      derivedAddress = nextAddress;
    },
    setListedDescriptors(nextDescriptors: string[] | null) {
      listedDescriptors = nextDescriptors;
    },
  };
}
