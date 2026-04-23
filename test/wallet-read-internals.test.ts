import assert from "node:assert/strict";
import test from "node:test";

import { deserializeIndexerState } from "@cogcoin/indexer";

import { stripDescriptorChecksum } from "../src/wallet/descriptor-normalization.js";
import { deriveWalletMaterialFromMnemonic } from "../src/wallet/material.js";
import {
  inspectWalletLocalStateWithDependencies,
} from "../src/wallet/read/local-state.js";
import { openManagedWalletBitcoindReadState } from "../src/wallet/read/managed-bitcoind.js";
import { openManagedWalletIndexerReadState } from "../src/wallet/read/managed-indexer.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createMemoryWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import {
  loadWalletState,
  saveWalletState,
} from "../src/wallet/state/storage.js";
import type {
  ManagedBitcoindObservedStatus,
  ManagedCoreWalletReplicaStatus,
  ManagedIndexerDaemonObservedStatus,
} from "../src/bitcoind/types.js";
import { INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED } from "../src/bitcoind/indexer-daemon.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { createDerivedWalletState } from "./wallet-lifecycle-test-helpers.js";

function createManagedBitcoindObservedStatus(
  overrides: Partial<ManagedBitcoindObservedStatus> = {},
): ManagedBitcoindObservedStatus {
  return {
    serviceApiVersion: "cogcoin/bitcoind-service/v1",
    binaryVersion: "30.2.0",
    buildId: null,
    serviceInstanceId: "service-instance",
    state: "ready",
    processId: 1234,
    walletRootId: "wallet-root",
    chain: "main",
    dataDir: "/tmp/cogcoin-data",
    runtimeRoot: "/tmp/cogcoin-runtime/managed",
    startHeight: 0,
    rpc: {
      url: "http://127.0.0.1:18443",
      cookieFile: "/tmp/cogcoin-data/.cookie",
      port: 18443,
    },
    zmq: {
      endpoint: "tcp://127.0.0.1:28332",
      topic: "hashblock",
      port: 28332,
      pollIntervalMs: 2_000,
    },
    p2pPort: 18444,
    getblockArchiveEndHeight: null,
    getblockArchiveSha256: null,
    walletReplica: null,
    startedAtUnixMs: 1_700_000_000_000,
    heartbeatAtUnixMs: 1_700_000_000_100,
    updatedAtUnixMs: 1_700_000_000_100,
    lastError: null,
    ...overrides,
  };
}

function createManagedIndexerDaemonObservedStatus(
  overrides: Partial<ManagedIndexerDaemonObservedStatus> = {},
): ManagedIndexerDaemonObservedStatus {
  return {
    serviceApiVersion: "cogcoin/indexer-ipc/v1",
    binaryVersion: "1.1.10",
    buildId: null,
    updatedAtUnixMs: 1_700_000_000_100,
    walletRootId: "wallet-root",
    daemonInstanceId: "daemon-instance",
    schemaVersion: "cogcoin/indexer-db/v1",
    state: "synced",
    processId: 4321,
    startedAtUnixMs: 1_700_000_000_000,
    heartbeatAtUnixMs: 1_700_000_000_100,
    ipcReady: true,
    rpcReachable: true,
    coreBestHeight: 100,
    coreBestHash: "11".repeat(32),
    appliedTipHeight: 100,
    appliedTipHash: "11".repeat(32),
    snapshotSeq: "snapshot-seq",
    backlogBlocks: 0,
    reorgDepth: 0,
    lastAppliedAtUnixMs: 1_700_000_000_090,
    activeSnapshotCount: 1,
    lastError: null,
    backgroundFollowActive: true,
    bootstrapPhase: "follow_tip",
    bootstrapProgress: null,
    cogcoinSyncHeight: 100,
    cogcoinSyncTargetHeight: 100,
    ...overrides,
  };
}

function createUninitializedLocalState() {
  return {
    availability: "uninitialized" as const,
    clientPasswordReadiness: "ready" as const,
    unlockRequired: false,
    walletRootId: null,
    state: null,
    source: null,
    hasPrimaryStateFile: false,
    hasBackupStateFile: false,
    message: null,
  };
}

test("inspectWalletLocalStateWithDependencies normalizes descriptor state through managed bitcoind access", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-wallet-read-local-state");
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const provider = createMemoryWalletSecretProviderForTesting();
  const baseState = createDerivedWalletState();
  const material = deriveWalletMaterialFromMnemonic(baseState.mnemonic.phrase);
  const secretReference = createWalletSecretReference(baseState.walletRootId);
  let stopped = 0;

  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 17));
  await saveWalletState(
    {
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    },
    {
      ...baseState,
      descriptor: {
        ...baseState.descriptor,
        privateExternal: stripDescriptorChecksum(material.descriptor.privateExternal),
        publicExternal: stripDescriptorChecksum(material.descriptor.publicExternal),
        checksum: null,
      },
      managedCoreWallet: {
        ...baseState.managedCoreWallet,
        descriptorChecksum: null,
      },
    },
    {
      provider,
      secretReference,
    },
  );

  const status = await inspectWalletLocalStateWithDependencies({
    dataDir: homeDirectory,
    paths,
    secretProvider: provider,
    now: 123,
  }, {
    attachOrStartManagedBitcoindService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/.cookie",
        port: 18443,
      },
      stop: async () => {
        stopped += 1;
      },
    } as any),
    createRpcClient: () => ({
      getDescriptorInfo: async (descriptor: string) => ({
        descriptor,
        checksum: material.descriptor.checksum,
      }),
      listUnspent: async () => [],
    } as any),
  });

  assert.equal(status.availability, "ready");
  assert.equal(stopped, 1);
  assert.equal(status.state?.descriptor.checksum, material.descriptor.checksum);
  assert.equal(status.state?.managedCoreWallet.descriptorChecksum, material.descriptor.checksum);

  const loaded = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });
  assert.equal(loaded.state.descriptor.checksum, material.descriptor.checksum);
  assert.equal(loaded.state.managedCoreWallet.descriptorChecksum, material.descriptor.checksum);
});

test("openManagedWalletBitcoindReadState keeps reject-path policy in the extracted owner", async () => {
  const state = await openManagedWalletBitcoindReadState({
    dataDir: "/tmp/cogcoin-data",
    walletRootId: "wallet-root",
    localState: createUninitializedLocalState(),
    startupTimeoutMs: 5_000,
  }, {
    loadBundledGenesisParameters: async () => {
      throw new Error("should_not_load_genesis");
    },
    probeManagedBitcoindService: async () => ({
      compatibility: "runtime-mismatch",
      status: createManagedBitcoindObservedStatus(),
      error: "managed_bitcoind_runtime_mismatch",
    }),
    attachOrStartManagedBitcoindService: async () => {
      throw new Error("should_not_attach_bitcoind");
    },
    createRpcClient: () => {
      throw new Error("should_not_create_rpc");
    },
    verifyManagedCoreWalletReplica: async () => {
      throw new Error("should_not_verify_replica");
    },
  });

  assert.equal(state.node.handle, null);
  assert.equal(state.node.status, null);
  assert.equal(state.bitcoind.health, "runtime-mismatch");
  assert.equal(state.nodeHealth, "catching-up");
  assert.match(state.nodeMessage ?? "", /still catching up/i);
});

test("openManagedWalletBitcoindReadState merges replica verification into node status", async () => {
  const localState = {
    availability: "ready" as const,
    clientPasswordReadiness: "ready" as const,
    unlockRequired: false,
    walletRootId: "wallet-root",
    state: createDerivedWalletState(),
    source: "primary" as const,
    hasPrimaryStateFile: true,
    hasBackupStateFile: false,
    message: null,
  };
  const verifiedReplica: ManagedCoreWalletReplicaStatus = {
    walletRootId: "wallet-root",
    walletName: "cogcoin-wallet-root",
    loaded: true,
    descriptors: true,
    privateKeysEnabled: true,
    created: false,
    proofStatus: "mismatch",
    descriptorChecksum: "abcd1234",
    fundingAddress0: "bc1qfunding",
    fundingScriptPubKeyHex0: "0014" + "11".repeat(20),
    message: "Managed Core wallet replica does not match trusted wallet state.",
  };

  const state = await openManagedWalletBitcoindReadState({
    dataDir: "/tmp/cogcoin-data",
    walletRootId: "wallet-root",
    localState,
    startupTimeoutMs: 5_000,
  }, {
    loadBundledGenesisParameters: async () => ({ genesisBlock: 100 } as any),
    probeManagedBitcoindService: async () => ({
      compatibility: "compatible",
      status: createManagedBitcoindObservedStatus(),
      error: null,
    }),
    attachOrStartManagedBitcoindService: async () => ({
      pid: 1234,
      walletRootId: "wallet-root",
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/.cookie",
        port: 18443,
      },
      refreshServiceStatus: async () => createManagedBitcoindObservedStatus({
        walletRootId: "wallet-root",
      }),
    } as any),
    createRpcClient: () => ({
      getBlockchainInfo: async () => ({
        chain: "main",
        blocks: 100,
        bestblockhash: "11".repeat(32),
        headers: 100,
      }),
    } as any),
    verifyManagedCoreWalletReplica: async () => verifiedReplica,
  });

  assert.equal(state.node.status?.walletReplica?.proofStatus, "mismatch");
  assert.equal(state.node.status?.walletReplicaMessage, verifiedReplica.message);
  assert.equal(state.bitcoind.health, "replica-mismatch");
});

test("openManagedWalletIndexerReadState falls back to status-file truth when attach fails after probe approval", async () => {
  let closedProbeClient = false;
  const probeClient = {
    async getStatus() {
      throw new Error("should_not_get_status");
    },
    async openSnapshot() {
      throw new Error("should_not_open_snapshot");
    },
    async readSnapshot() {
      throw new Error("should_not_read_snapshot");
    },
    async closeSnapshot() {
      throw new Error("should_not_close_snapshot");
    },
    async resumeBackgroundFollow() {
      throw new Error("should_not_resume_background_follow");
    },
    async close() {
      closedProbeClient = true;
    },
  };

  const state = await openManagedWalletIndexerReadState({
    dataDir: "/tmp/cogcoin-data",
    databasePath: "/tmp/client.sqlite",
    walletRootId: "wallet-root",
    startupTimeoutMs: 5_000,
    expectedIndexerBinaryVersion: "1.1.10",
    now: 1_700_000_001_000,
    nodeHandle: null,
  }, {
    probeIndexerDaemon: async () => ({
      compatibility: "compatible",
      status: createManagedIndexerDaemonObservedStatus({
        state: "starting",
      }),
      client: probeClient as any,
      error: null,
    }),
    attachOrStartIndexerDaemon: async () => {
      throw new Error("indexer_boom");
    },
    readSnapshotWithRetry: async () => {
      throw new Error("should_not_read_snapshot");
    },
    readObservedIndexerDaemonStatus: async () => createManagedIndexerDaemonObservedStatus({
      state: "starting",
    }),
  });

  assert.equal(closedProbeClient, true);
  assert.equal(state.snapshot, null);
  assert.equal(state.indexer.source, "status-file");
  assert.equal(state.indexer.health, "unavailable");
  assert.equal(state.indexer.message, "indexer_boom");
});

test("openManagedWalletIndexerReadState preserves background-follow recovery failure behavior", async () => {
  let stoppedNode = 0;

  await assert.rejects(
    openManagedWalletIndexerReadState({
      dataDir: "/tmp/cogcoin-data",
      databasePath: "/tmp/client.sqlite",
      walletRootId: "wallet-root",
      startupTimeoutMs: 5_000,
      expectedIndexerBinaryVersion: "1.1.10",
      now: 1_700_000_001_000,
      nodeHandle: {
        stop: async () => {
          stoppedNode += 1;
        },
      } as any,
    }, {
      probeIndexerDaemon: async () => ({
        compatibility: "compatible",
        status: createManagedIndexerDaemonObservedStatus(),
        client: null,
        error: null,
      }),
      attachOrStartIndexerDaemon: async () => {
        throw new Error(INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED);
      },
      readSnapshotWithRetry: async () => {
        throw new Error("should_not_read_snapshot");
      },
      readObservedIndexerDaemonStatus: async () => null,
    }),
    (error: unknown) => error instanceof Error && error.message === INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED,
  );

  assert.equal(stoppedNode, 1);
});
