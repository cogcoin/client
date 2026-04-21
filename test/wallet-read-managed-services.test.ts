import test from "node:test";
import assert from "node:assert/strict";

import { openManagedWalletReadServiceBundle } from "../src/wallet/read/managed-services.js";
import type {
  ManagedBitcoindObservedStatus,
  ManagedIndexerDaemonObservedStatus,
} from "../src/bitcoind/types.js";

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
    walletRootId: "wallet-root-default",
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
    binaryVersion: "1.1.7",
    buildId: null,
    updatedAtUnixMs: 1_700_000_000_100,
    walletRootId: "wallet-root-default",
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

test("openManagedWalletReadServiceBundle keeps managed-service fallback decisions in the extracted owner", async () => {
  const bundle = await openManagedWalletReadServiceBundle({
    dataDir: "/tmp/cogcoin-data",
    databasePath: "/tmp/client.sqlite",
    walletRootId: "wallet-root-target",
    localState: createUninitializedLocalState(),
    startupTimeoutMs: 5_000,
    expectedIndexerBinaryVersion: "1.1.7",
    now: 1_700_000_001_000,
  }, {
    loadBundledGenesisParameters: async () => {
      throw new Error("should_not_load_genesis");
    },
    probeManagedBitcoindService: async () => ({
      compatibility: "runtime-mismatch",
      status: createManagedBitcoindObservedStatus({
        walletRootId: "wallet-root-target",
      }),
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
    probeIndexerDaemon: async () => ({
      compatibility: "schema-mismatch",
      status: createManagedIndexerDaemonObservedStatus({
        walletRootId: "wallet-root-target",
        schemaVersion: "cogcoin/indexer-db/v999",
        state: "schema-mismatch",
      }),
      client: null,
      error: "indexer_daemon_schema_mismatch",
    }),
    attachOrStartIndexerDaemon: async () => {
      throw new Error("should_not_attach_indexer");
    },
    readSnapshotWithRetry: async () => {
      throw new Error("should_not_read_snapshot");
    },
    readObservedIndexerDaemonStatus: async () => null,
  });

  assert.equal(bundle.node.status, null);
  assert.equal(bundle.bitcoind.health, "runtime-mismatch");
  assert.equal(bundle.indexer.health, "schema-mismatch");
  assert.equal(bundle.snapshot, null);

  await bundle.close();
});

test("openManagedWalletReadServiceBundle falls back to status-file truth when indexer attach fails after probe approval", async () => {
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

  const bundle = await openManagedWalletReadServiceBundle({
    dataDir: "/tmp/cogcoin-data",
    databasePath: "/tmp/client.sqlite",
    walletRootId: "wallet-root-target",
    localState: createUninitializedLocalState(),
    startupTimeoutMs: 5_000,
    expectedIndexerBinaryVersion: "1.1.7",
    now: 1_700_000_001_000,
  }, {
    loadBundledGenesisParameters: async () => {
      throw new Error("should_not_load_genesis");
    },
    probeManagedBitcoindService: async () => ({
      compatibility: "runtime-mismatch",
      status: createManagedBitcoindObservedStatus({
        walletRootId: "wallet-root-target",
      }),
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
    probeIndexerDaemon: async () => ({
      compatibility: "compatible",
      status: createManagedIndexerDaemonObservedStatus({
        walletRootId: "wallet-root-target",
        state: "starting",
      }),
      client: probeClient,
      error: null,
    }),
    attachOrStartIndexerDaemon: async () => {
      throw new Error("indexer_boom");
    },
    readSnapshotWithRetry: async () => {
      throw new Error("should_not_read_snapshot");
    },
    readObservedIndexerDaemonStatus: async () => createManagedIndexerDaemonObservedStatus({
      walletRootId: "wallet-root-target",
      state: "starting",
    }),
  });

  assert.equal(closedProbeClient, true);
  assert.equal(bundle.indexer.source, "status-file");
  assert.equal(bundle.indexer.health, "unavailable");
  assert.equal(bundle.indexer.message, "indexer_boom");

  await bundle.close();
});
