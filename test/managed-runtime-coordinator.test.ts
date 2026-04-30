import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { attachOrStartManagedBitcoindRuntime, probeManagedBitcoindRuntime } from "../src/bitcoind/managed-runtime/bitcoind-runtime.js";
import { listManagedBitcoindStatusCandidates } from "../src/bitcoind/managed-runtime/bitcoind-status.js";
import { attachOrStartManagedIndexerRuntime } from "../src/bitcoind/managed-runtime/indexer-runtime.js";
import { resolveManagedServicePaths } from "../src/bitcoind/service-paths.js";
import type {
  ManagedBitcoindObservedStatus,
  ManagedIndexerDaemonObservedStatus,
} from "../src/bitcoind/types.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";

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
    binaryVersion: "1.1.12",
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

function createManagedPaths(dataDir: string, walletRootId: string) {
  return resolveManagedServicePaths(dataDir, walletRootId);
}

test("listManagedBitcoindStatusCandidates keeps the expected path but filters mismatched sibling data dirs", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-managed-runtime-candidates");
  const dataDir = join(homeDirectory, "bitcoin");
  const walletRootId = "wallet-root-target";
  const paths = createManagedPaths(dataDir, walletRootId);
  const siblingRuntimeRoot = join(paths.runtimeRoot, "managed-sibling");
  const foreignRuntimeRoot = join(paths.runtimeRoot, "managed-foreign");

  await mkdir(paths.walletRuntimeRoot, { recursive: true });
  await mkdir(siblingRuntimeRoot, { recursive: true });
  await mkdir(foreignRuntimeRoot, { recursive: true });

  await writeFile(paths.bitcoindStatusPath, `${JSON.stringify(createManagedBitcoindObservedStatus({
    dataDir: join(homeDirectory, "other-bitcoin"),
    walletRootId,
    runtimeRoot: paths.walletRuntimeRoot,
  }))}\n`);
  await writeFile(join(siblingRuntimeRoot, "bitcoind-status.json"), `${JSON.stringify(createManagedBitcoindObservedStatus({
    dataDir,
    walletRootId: "wallet-root-live",
    runtimeRoot: siblingRuntimeRoot,
  }))}\n`);
  await writeFile(join(foreignRuntimeRoot, "bitcoind-status.json"), `${JSON.stringify(createManagedBitcoindObservedStatus({
    dataDir: join(homeDirectory, "foreign-bitcoin"),
    walletRootId: "wallet-root-foreign",
    runtimeRoot: foreignRuntimeRoot,
  }))}\n`);

  const candidates = await listManagedBitcoindStatusCandidates({
    dataDir,
    runtimeRoot: paths.runtimeRoot,
    expectedStatusPath: paths.bitcoindStatusPath,
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.statusPath).sort(),
    [
      join(siblingRuntimeRoot, "bitcoind-status.json"),
      paths.bitcoindStatusPath,
    ].sort(),
  );
});

test("probeManagedBitcoindRuntime prefers the first live candidate and skips dead processes", async () => {
  const dataDir = "/tmp/cogcoin-data";
  const walletRootId = "wallet-root-target";
  const paths = createManagedPaths(dataDir, walletRootId);
  const deadStatus = createManagedBitcoindObservedStatus({
    processId: 11,
    walletRootId,
    dataDir,
    runtimeRoot: paths.walletRuntimeRoot,
  });
  const liveStatus = createManagedBitcoindObservedStatus({
    processId: 22,
    walletRootId: "wallet-root-live",
    dataDir,
    runtimeRoot: join(paths.runtimeRoot, "managed-live"),
  });

  const result = await probeManagedBitcoindRuntime({
    dataDir,
    walletRootId,
    startupTimeoutMs: 5_000,
  }, {
    getPaths: () => paths,
    listStatusCandidates: async () => [
      { status: deadStatus, statusPath: paths.bitcoindStatusPath },
      { status: liveStatus, statusPath: join(paths.runtimeRoot, "managed-live", "bitcoind-status.json") },
    ],
    isProcessAlive: async (processId) => processId === 22,
    probeStatusCandidate: async (status, _options, runtimeRoot) => {
      assert.equal(status.processId, 22);
      assert.equal(runtimeRoot, paths.walletRuntimeRoot);
      return {
        compatibility: "compatible",
        status,
        error: null,
      };
    },
  });

  assert.equal(result.compatibility, "compatible");
  assert.equal(result.status?.processId, 22);
});

test("attachOrStartManagedBitcoindRuntime reuses a compatible attached runtime", async () => {
  const dataDir = "/tmp/cogcoin-data";
  const walletRootId = "wallet-root-target";
  const paths = createManagedPaths(dataDir, walletRootId);
  const handle = { id: "attached-handle" };
  let acquired = false;
  let started = false;

  const result = await attachOrStartManagedBitcoindRuntime({
    dataDir,
    walletRootId,
    startupTimeoutMs: 5_000,
    chain: "main" as const,
    startHeight: 0,
  }, {
    getPaths: () => paths,
    listStatusCandidates: async () => [
      {
        status: createManagedBitcoindObservedStatus({
          dataDir,
          walletRootId,
          runtimeRoot: paths.walletRuntimeRoot,
        }),
        statusPath: paths.bitcoindStatusPath,
      },
    ],
    isProcessAlive: async () => true,
    probeStatusCandidate: async (status) => ({
      compatibility: "compatible",
      status,
      error: null,
    }),
    attachExisting: async () => handle,
    acquireStartLock: async () => {
      acquired = true;
      return {
        async release() {},
      };
    },
    startService: async () => {
      started = true;
      return handle;
    },
    isLockBusyError: () => false,
    sleep: async () => undefined,
  });

  assert.equal(result, handle);
  assert.equal(acquired, false);
  assert.equal(started, false);
});

test("attachOrStartManagedBitcoindRuntime rejects incompatible runtimes without starting", async () => {
  const dataDir = "/tmp/cogcoin-data";
  const walletRootId = "wallet-root-target";
  const paths = createManagedPaths(dataDir, walletRootId);

  await assert.rejects(
    () => attachOrStartManagedBitcoindRuntime({
      dataDir,
      walletRootId,
      startupTimeoutMs: 5_000,
      chain: "main" as const,
      startHeight: 0,
    }, {
      getPaths: () => paths,
      listStatusCandidates: async () => [
        {
          status: createManagedBitcoindObservedStatus({
            dataDir,
            walletRootId,
            runtimeRoot: paths.walletRuntimeRoot,
          }),
          statusPath: paths.bitcoindStatusPath,
        },
      ],
      isProcessAlive: async () => true,
      probeStatusCandidate: async (status) => ({
        compatibility: "runtime-mismatch",
        status,
        error: "managed_bitcoind_runtime_mismatch",
      }),
      attachExisting: async () => null,
      acquireStartLock: async () => {
        throw new Error("should_not_lock");
      },
      startService: async () => {
        throw new Error("should_not_start");
      },
      isLockBusyError: () => false,
      sleep: async () => undefined,
    }),
    /managed_bitcoind_runtime_mismatch/,
  );
});

test("attachOrStartManagedBitcoindRuntime starts when no live runtime is reachable", async () => {
  const dataDir = "/tmp/cogcoin-data";
  const walletRootId = "wallet-root-target";
  const paths = createManagedPaths(dataDir, walletRootId);
  const handle = { id: "started-handle" };
  let released = false;

  const result = await attachOrStartManagedBitcoindRuntime({
    dataDir,
    walletRootId,
    startupTimeoutMs: 5_000,
    chain: "main" as const,
    startHeight: 0,
  }, {
    getPaths: () => paths,
    listStatusCandidates: async () => [],
    isProcessAlive: async () => false,
    probeStatusCandidate: async () => {
      throw new Error("should_not_probe");
    },
    attachExisting: async () => null,
    acquireStartLock: async () => ({
      async release() {
        released = true;
      },
    }),
    startService: async () => handle,
    isLockBusyError: () => false,
    sleep: async () => undefined,
  });

  assert.equal(result, handle);
  assert.equal(released, true);
});

test("attachOrStartManagedBitcoindRuntime waits for reattach when the start lock is busy", async () => {
  const dataDir = "/tmp/cogcoin-data";
  const walletRootId = "wallet-root-target";
  const paths = createManagedPaths(dataDir, walletRootId);
  const handle = { id: "reattached-handle" };
  let attachAttempts = 0;

  class TestLockBusyError extends Error {}

  const result = await attachOrStartManagedBitcoindRuntime({
    dataDir,
    walletRootId,
    startupTimeoutMs: 5_000,
    chain: "main" as const,
    startHeight: 0,
  }, {
    getPaths: () => paths,
    listStatusCandidates: async () => [],
    isProcessAlive: async () => false,
    probeStatusCandidate: async () => {
      throw new Error("should_not_probe");
    },
    attachExisting: async () => {
      attachAttempts += 1;
      return handle;
    },
    acquireStartLock: async () => {
      throw new TestLockBusyError("busy");
    },
    startService: async () => {
      throw new Error("should_not_start");
    },
    isLockBusyError: (error) => error instanceof TestLockBusyError,
    sleep: async () => undefined,
  });

  assert.equal(result, handle);
  assert.equal(attachAttempts, 1);
});

test("attachOrStartManagedIndexerRuntime reuses a compatible daemon without locking", async () => {
  const dataDir = "/tmp/cogcoin-data";
  const walletRootId = "wallet-root-target";
  const paths = createManagedPaths(dataDir, walletRootId);
  const existingClient = { id: "attached-client" };
  let acquired = false;

  const result = await attachOrStartManagedIndexerRuntime({
    dataDir,
    walletRootId,
    databasePath: "/tmp/client.sqlite",
    startupTimeoutMs: 5_000,
    expectedBinaryVersion: "1.1.12",
  }, {
    getPaths: () => paths,
    probeDaemon: async () => ({
      compatibility: "compatible",
      status: createManagedIndexerDaemonObservedStatus({
        walletRootId,
        binaryVersion: "1.1.12",
      }),
      client: existingClient,
      error: null,
    }),
    requestBackgroundFollow: async (client) => client,
    closeClient: async () => undefined,
    acquireStartLock: async () => {
      acquired = true;
      return {
        async release() {},
      };
    },
    startDaemon: async () => {
      throw new Error("should_not_start");
    },
    stopWithLockHeld: async () => undefined,
    isLockBusyError: () => false,
    sleep: async () => undefined,
  });

  assert.equal(result, existingClient);
  assert.equal(acquired, false);
});

test("attachOrStartManagedIndexerRuntime replaces stale compatible daemons before starting a new one", async () => {
  const dataDir = "/tmp/cogcoin-data";
  const walletRootId = "wallet-root-target";
  const paths = createManagedPaths(dataDir, walletRootId);
  const staleClient = { id: "stale-client" };
  const newClient = { id: "new-client" };
  const closedClients: string[] = [];
  let probeCalls = 0;

  const result = await attachOrStartManagedIndexerRuntime({
    dataDir,
    walletRootId,
    databasePath: "/tmp/client.sqlite",
    startupTimeoutMs: 5_000,
    expectedBinaryVersion: "1.1.12",
  }, {
    getPaths: () => paths,
    probeDaemon: async () => {
      probeCalls += 1;

      if (probeCalls === 1) {
        return {
          compatibility: "compatible",
          status: createManagedIndexerDaemonObservedStatus({
            walletRootId,
            binaryVersion: "1.1.4",
          }),
          client: staleClient,
          error: null,
        };
      }

      return {
        compatibility: "unreachable",
        status: null,
        client: null,
        error: null,
      };
    },
    requestBackgroundFollow: async (client) => client,
    closeClient: async (client) => {
      closedClients.push(client.id);
    },
    acquireStartLock: async () => ({
      async release() {},
    }),
    startDaemon: async () => newClient,
    stopWithLockHeld: async () => undefined,
    isLockBusyError: () => false,
    sleep: async () => undefined,
  });

  assert.equal(result, newClient);
  assert.deepEqual(closedClients, ["stale-client"]);
});

test("attachOrStartManagedIndexerRuntime rejects incompatible daemon metadata", async () => {
  const dataDir = "/tmp/cogcoin-data";
  const walletRootId = "wallet-root-target";
  const paths = createManagedPaths(dataDir, walletRootId);

  await assert.rejects(
    () => attachOrStartManagedIndexerRuntime({
      dataDir,
      walletRootId,
      databasePath: "/tmp/client.sqlite",
      startupTimeoutMs: 5_000,
      expectedBinaryVersion: "1.1.12",
    }, {
      getPaths: () => paths,
      probeDaemon: async () => ({
        compatibility: "schema-mismatch",
        status: createManagedIndexerDaemonObservedStatus({
          walletRootId,
          schemaVersion: "cogcoin/indexer-db/v999",
        }),
        client: null,
        error: "indexer_daemon_schema_mismatch",
      }),
      requestBackgroundFollow: async (client) => client,
      closeClient: async () => undefined,
      acquireStartLock: async () => {
        throw new Error("should_not_lock");
      },
      startDaemon: async () => {
        throw new Error("should_not_start");
      },
      stopWithLockHeld: async () => undefined,
      isLockBusyError: () => false,
      sleep: async () => undefined,
    }),
    /indexer_daemon_schema_mismatch/,
  );
});

test("attachOrStartManagedIndexerRuntime recycles a live daemon when background follow recovery fails under the start lock", async () => {
  const dataDir = "/tmp/cogcoin-data";
  const walletRootId = "wallet-root-target";
  const paths = createManagedPaths(dataDir, walletRootId);
  const liveClient = { id: "live-client" };
  const newClient = { id: "new-client" };
  const stoppedProcessIds: Array<number | null> = [];
  const closedClients: string[] = [];
  let probeCalls = 0;

  const result = await attachOrStartManagedIndexerRuntime({
    dataDir,
    walletRootId,
    databasePath: "/tmp/client.sqlite",
    startupTimeoutMs: 5_000,
    shutdownTimeoutMs: 2_000,
    expectedBinaryVersion: "1.1.12",
  }, {
    getPaths: () => paths,
    probeDaemon: async () => {
      probeCalls += 1;

      if (probeCalls === 1) {
        return {
          compatibility: "unreachable",
          status: null,
          client: null,
          error: null,
        };
      }

      return {
        compatibility: "compatible",
        status: createManagedIndexerDaemonObservedStatus({
          walletRootId,
          processId: 4455,
          backgroundFollowActive: false,
        }),
        client: liveClient,
        error: null,
      };
    },
    requestBackgroundFollow: async (client) => {
      if (client === liveClient) {
        throw new Error("resume_failed");
      }

      return client;
    },
    closeClient: async (client) => {
      closedClients.push(client.id);
    },
    acquireStartLock: async () => ({
      async release() {},
    }),
    startDaemon: async () => newClient,
    stopWithLockHeld: async (_options, _runtimePaths, processId) => {
      stoppedProcessIds.push(processId);
    },
    isLockBusyError: () => false,
    sleep: async () => undefined,
  });

  assert.equal(result, newClient);
  assert.deepEqual(closedClients, ["live-client"]);
  assert.deepEqual(stoppedProcessIds, [4455]);
});

test("attachOrStartManagedIndexerRuntime throws recovery_failed when a freshly started daemon still cannot resume background follow", async () => {
  const dataDir = "/tmp/cogcoin-data";
  const walletRootId = "wallet-root-target";
  const paths = createManagedPaths(dataDir, walletRootId);
  const newClient = { id: "new-client" };
  const closedClients: string[] = [];

  await assert.rejects(
    () => attachOrStartManagedIndexerRuntime({
      dataDir,
      walletRootId,
      databasePath: "/tmp/client.sqlite",
      startupTimeoutMs: 5_000,
      expectedBinaryVersion: "1.1.12",
    }, {
      getPaths: () => paths,
      probeDaemon: async () => ({
        compatibility: "unreachable",
        status: null,
        client: null,
        error: null,
      }),
      requestBackgroundFollow: async () => {
        throw new Error("resume_failed");
      },
      closeClient: async (client) => {
        closedClients.push(client.id);
      },
      acquireStartLock: async () => ({
        async release() {},
      }),
      startDaemon: async () => newClient,
      stopWithLockHeld: async () => undefined,
      isLockBusyError: () => false,
      sleep: async () => undefined,
    }),
    /indexer_daemon_background_follow_recovery_failed/,
  );

  assert.deepEqual(closedClients, ["new-client"]);
});
