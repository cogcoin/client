import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  deriveManagedBitcoindWalletStatus,
  resolveManagedBitcoindProbeDecision,
  validateManagedBitcoindObservedStatus,
} from "../src/bitcoind/managed-runtime/bitcoind-policy.js";
import {
  deriveManagedIndexerWalletStatus,
  resolveIndexerDaemonProbeDecision,
  validateIndexerRuntimeIdentity,
} from "../src/bitcoind/managed-runtime/indexer-policy.js";
import { resolveManagedIndexerStatusProjection } from "../src/bitcoind/managed-runtime/status.js";
import { resolveManagedServicePaths } from "../src/bitcoind/service-paths.js";
import type {
  ManagedBitcoindObservedStatus,
  ManagedIndexerDaemonObservedStatus,
  ManagedIndexerDaemonStatus,
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
    binaryVersion: "1.1.6",
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

function createManagedIndexerDaemonStatus(
  overrides: Partial<ManagedIndexerDaemonStatus> = {},
): ManagedIndexerDaemonStatus {
  const observed = createManagedIndexerDaemonObservedStatus(overrides);
  return {
    ...observed,
    serviceApiVersion: "cogcoin/indexer-ipc/v1",
    schemaVersion: "cogcoin/indexer-db/v1",
  };
}

test("managed bitcoind policy adopts legacy wallet-scoped runtime roots across wallet roots", () => {
  const dataDir = "/tmp/cogcoin-data";
  const expectedPaths = resolveManagedServicePaths(dataDir, "wallet-root-target");
  const legacyWalletRootId = "wallet-root-legacy";
  const status = createManagedBitcoindObservedStatus({
    dataDir,
    walletRootId: legacyWalletRootId,
    runtimeRoot: join(expectedPaths.runtimeRoot, legacyWalletRootId),
  });

  assert.doesNotThrow(() => validateManagedBitcoindObservedStatus(status, {
    chain: "main",
    dataDir,
    runtimeRoot: expectedPaths.walletRuntimeRoot,
  }));
});

test("managed bitcoind probe decisions and health mapping come from the shared policy owner", () => {
  assert.deepEqual(
    resolveManagedBitcoindProbeDecision({
      compatibility: "compatible",
      status: createManagedBitcoindObservedStatus(),
      error: null,
    }),
    {
      action: "attach",
      error: null,
    },
  );

  assert.deepEqual(
    resolveManagedBitcoindProbeDecision({
      compatibility: "runtime-mismatch",
      status: createManagedBitcoindObservedStatus(),
      error: "managed_bitcoind_runtime_mismatch",
    }),
    {
      action: "reject",
      error: "managed_bitcoind_runtime_mismatch",
    },
  );

  const health = deriveManagedBitcoindWalletStatus({
    status: createManagedBitcoindObservedStatus(),
    nodeStatus: {
      ready: true,
      chain: "main",
      pid: 1234,
      walletRootId: "wallet-root-default",
      nodeBestHeight: 100,
      nodeBestHashHex: "11".repeat(32),
      nodeHeaderHeight: 100,
      serviceUpdatedAtUnixMs: 1_700_000_000_100,
      serviceStatus: null,
      walletReplica: {
        walletRootId: "wallet-root-default",
        walletName: "cogcoin-wallet-root-default",
        loaded: false,
        descriptors: true,
        privateKeysEnabled: false,
        created: false,
        proofStatus: "missing",
        message: "Managed Core wallet replica is missing.",
      },
      walletReplicaMessage: "Managed Core wallet replica is missing.",
    },
    startupError: null,
  });

  assert.equal(health.health, "replica-missing");
  assert.match(health.message ?? "", /replica is missing/i);
});

test("managed indexer policy keeps wallet-root adoption permissive but rejects incompatible runtime identity", () => {
  assert.doesNotThrow(() => validateIndexerRuntimeIdentity(
    createManagedIndexerDaemonObservedStatus({
      walletRootId: "wallet-root-other",
    }),
    "wallet-root-target",
  ));

  assert.throws(
    () => validateIndexerRuntimeIdentity(
      createManagedIndexerDaemonObservedStatus({
        schemaVersion: "cogcoin/indexer-db/v999",
      }),
      "wallet-root-target",
    ),
    /indexer_daemon_schema_mismatch/,
  );
});

test("managed indexer probe decisions centralize stale and unparseable replacement", () => {
  assert.equal(
    resolveIndexerDaemonProbeDecision({
      probe: {
        compatibility: "compatible",
        status: createManagedIndexerDaemonObservedStatus({
          binaryVersion: "1.1.4",
        }),
        client: {} as any,
        error: null,
      },
      expectedBinaryVersion: "1.1.6",
    }).action,
    "replace",
  );

  assert.equal(
    resolveIndexerDaemonProbeDecision({
      probe: {
        compatibility: "compatible",
        status: createManagedIndexerDaemonObservedStatus({
          binaryVersion: "dev-build",
        }),
        client: {} as any,
        error: null,
      },
      expectedBinaryVersion: "1.1.6",
    }).action,
    "replace",
  );

  assert.deepEqual(
    resolveIndexerDaemonProbeDecision({
      probe: {
        compatibility: "schema-mismatch",
        status: createManagedIndexerDaemonObservedStatus({
          schemaVersion: "cogcoin/indexer-db/v999",
        }),
        client: null,
        error: "indexer_daemon_schema_mismatch",
      },
      expectedBinaryVersion: "1.1.6",
    }),
    {
      action: "reject",
      error: "indexer_daemon_schema_mismatch",
    },
  );
});

test("managed runtime status projection prefers lease truth and preserves snapshot metadata", () => {
  const projection = resolveManagedIndexerStatusProjection({
    daemonStatus: createManagedIndexerDaemonStatus({
      daemonInstanceId: "lease-daemon",
      snapshotSeq: "lease-seq",
      state: "synced",
    }),
    observedStatus: createManagedIndexerDaemonObservedStatus({
      daemonInstanceId: "probe-daemon",
      snapshotSeq: "probe-seq",
      state: "starting",
    }),
    snapshot: {
      tip: {
        height: 100,
        blockHashHex: "22".repeat(32),
        previousHashHex: "11".repeat(32),
        stateHashHex: null,
      },
      daemonInstanceId: "lease-daemon",
      snapshotSeq: "lease-seq",
      openedAtUnixMs: 1_700_000_000_200,
    },
    source: "lease",
  });

  assert.equal(projection.status?.daemonInstanceId, "lease-daemon");
  assert.equal(projection.source, "lease");
  assert.equal(projection.snapshotSeq, "lease-seq");
  assert.equal(projection.openedAtUnixMs, 1_700_000_000_200);
  assert.equal(projection.snapshotTip?.height, 100);
});

test("managed indexer wallet health is derived from the shared projection and health policy", () => {
  const result = deriveManagedIndexerWalletStatus({
    daemonStatus: createManagedIndexerDaemonStatus({
      daemonInstanceId: "lease-daemon",
      state: "synced",
      heartbeatAtUnixMs: 1_700_000_000_100,
    }),
    observedStatus: createManagedIndexerDaemonObservedStatus({
      daemonInstanceId: "probe-daemon",
      state: "starting",
    }),
    snapshot: {
      tip: {
        height: 100,
        blockHashHex: "22".repeat(32),
        previousHashHex: "11".repeat(32),
        stateHashHex: null,
      },
      daemonInstanceId: "lease-daemon",
      snapshotSeq: "lease-seq",
      openedAtUnixMs: 1_700_000_000_200,
    },
    source: "lease",
    now: 1_700_000_000_500,
    startupError: null,
  });

  assert.equal(result.health, "synced");
  assert.equal(result.status?.daemonInstanceId, "lease-daemon");
  assert.equal(result.source, "lease");
  assert.equal(result.snapshotSeq, "lease-seq");
  assert.equal(result.snapshotTip?.height, 100);
});
