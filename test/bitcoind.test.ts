import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import test, { type TestContext } from "node:test";
import { join } from "node:path";

import { deserializeIndexerState } from "@cogcoin/indexer";
import { getBitcoinCliPath, getBitcoindPath } from "@cogcoin/bitcoin";

import {
  runCli,
} from "../src/cli-runner.js";
import {
  attachOrStartIndexerDaemon,
  attachOrStartManagedBitcoindService,
  BitcoinRpcClient,
  createRpcClient,
  DefaultManagedBitcoindClient,
  normalizeRpcBlock,
  openManagedBitcoindClientInternal,
  pauseIndexerDaemonForForegroundClientForTesting,
  readIndexerDaemonStatusForTesting,
  readManagedBitcoindServiceStatusForTesting,
  stopIndexerDaemonService,
  stopManagedBitcoindService,
  shutdownIndexerDaemonForTesting,
  shutdownManagedBitcoindServiceForTesting,
} from "../src/bitcoind/testing.js";
import { openWalletReadContext } from "../src/wallet/read/index.js";
import { resolveManagedServicePaths } from "../src/bitcoind/service-paths.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  INDEXER_DAEMON_SCHEMA_VERSION,
  INDEXER_DAEMON_SERVICE_API_VERSION,
  type BitcoindRpcConfig,
  type ManagedIndexerDaemonStatus,
} from "../src/bitcoind/types.js";
import { openSqliteDatabase } from "../src/sqlite/driver.js";
import { openSqliteStore } from "../src/sqlite/index.js";
import { createTempDirectory, generateBlocks, getMiningDescriptor, removeTempDirectory, replayBlocks, serializeStateHex, waitForCondition } from "./bitcoind-helpers.js";

interface RegtestFixture {
  rootDir: string;
  dataDir: string;
  databasePath: string;
}

class MemoryStream {
  readonly chunks: string[] = [];
  isTTY?: boolean;

  constructor(isTTY = false) {
    this.isTTY = isTTY;
  }

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  toString(): string {
    return this.chunks.join("");
  }
}

class FakeSignalSource extends EventEmitter {
  override on(event: "SIGINT" | "SIGTERM", listener: () => void): this {
    return super.on(event, listener);
  }

  override off(event: "SIGINT" | "SIGTERM", listener: () => void): this {
    return super.off(event, listener);
  }
}

type ManagedIndexerDaemonStatusFixture =
  Omit<ManagedIndexerDaemonStatus, "serviceApiVersion" | "schemaVersion">
  & {
    serviceApiVersion: string;
    schemaVersion: string;
  };

async function ensureBitcoinBinaries(t: TestContext): Promise<void> {
  try {
    await Promise.all([getBitcoindPath(), getBitcoinCliPath()]);
  } catch (error) {
    t.skip(`bitcoin binaries unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function collectChainBlocks(
  rpcConfig: BitcoindRpcConfig,
  tipHeight: number,
) {
  const rpc = createRpcClient(rpcConfig);
  const blocks = [];

  for (let height = 0; height <= tipHeight; height += 1) {
    const hashHex = await rpc.getBlockHash(height);
    const block = await rpc.getBlock(hashHex);
    blocks.push(normalizeRpcBlock(block));
  }

  return blocks;
}

function createFixture(prefix: string): RegtestFixture {
  const rootDir = createTempDirectory(prefix);
  return {
    rootDir,
    dataDir: join(rootDir, "bitcoind"),
    databasePath: join(rootDir, "client.sqlite"),
  };
}

function createTempWalletPaths(root: string) {
  return resolveWalletRuntimePathsForTesting({
    platform: "linux",
    homeDirectory: root,
    env: {
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
    },
  });
}

function createWalletStateEnvelopeStub(walletRootId: string) {
  return {
    source: "primary" as const,
    envelope: {
      format: "cogcoin-local-wallet-state",
      version: 1 as const,
      wrappedBy: "secret-provider",
      cipher: "aes-256-gcm" as const,
      walletRootIdHint: walletRootId,
      nonce: "nonce",
      tag: "tag",
      ciphertext: "ciphertext",
    },
  };
}

async function cleanupManagedFixture(fixture: RegtestFixture, ...extraDataDirs: string[]): Promise<void> {
  const dataDirs = [fixture.dataDir, ...extraDataDirs];

  for (const dataDir of dataDirs) {
    await shutdownIndexerDaemonForTesting({ dataDir }).catch(() => undefined);
    await shutdownManagedBitcoindServiceForTesting({
      dataDir,
      chain: "main",
    }).catch(() => undefined);
    await shutdownManagedBitcoindServiceForTesting({
      dataDir,
      chain: "regtest",
    }).catch(() => undefined);
  }

  await removeTempDirectory(fixture.rootDir);
}

function createManagedIndexerDaemonStatus(
  walletRootId: string,
  overrides: Partial<ManagedIndexerDaemonStatusFixture> = {},
): ManagedIndexerDaemonStatusFixture {
  return {
    serviceApiVersion: INDEXER_DAEMON_SERVICE_API_VERSION,
    binaryVersion: "0.0.0-test",
    buildId: null,
    updatedAtUnixMs: 1_700_000_000_000,
    walletRootId,
    daemonInstanceId: "daemon-test",
    schemaVersion: INDEXER_DAEMON_SCHEMA_VERSION,
    state: "synced",
    processId: 4321,
    startedAtUnixMs: 1_700_000_000_000,
    heartbeatAtUnixMs: 1_700_000_000_000,
    ipcReady: true,
    rpcReachable: true,
    coreBestHeight: 0,
    coreBestHash: "00".repeat(32),
    appliedTipHeight: 0,
    appliedTipHash: "00".repeat(32),
    snapshotSeq: "1",
    backlogBlocks: 0,
    reorgDepth: null,
    lastAppliedAtUnixMs: 1_700_000_000_000,
    activeSnapshotCount: 0,
    lastError: null,
    ...overrides,
  };
}

async function startFakeIndexerDaemonServer(
  socketPath: string,
  status: ManagedIndexerDaemonStatusFixture,
): Promise<net.Server> {
  await rm(socketPath, { force: true }).catch(() => undefined);

  const server = net.createServer((socket) => {
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }

        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length === 0) {
          continue;
        }

        const request = JSON.parse(line) as { id: string; method: string };
        socket.write(`${JSON.stringify({
          id: request.id,
          ok: request.method === "GetStatus",
          result: request.method === "GetStatus" ? status : undefined,
          error: request.method === "GetStatus" ? undefined : "unsupported_method",
        })}\n`);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return server;
}

test("BitcoinRpcClient keeps fetch for standard RPC methods", async () => {
  const rootDir = createTempDirectory("cogcoin-client-rpc-fetch");

  try {
    const cookieFile = join(rootDir, ".cookie");
    await writeFile(cookieFile, "user:password\n");
    let fetchCalls = 0;
    let requestCalls = 0;
    const rpc = new BitcoinRpcClient("http://127.0.0.1:8332", cookieFile, {
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({
          result: {
            chain: "main",
            blocks: 910_000,
            headers: 910_000,
            bestblockhash: "aa".repeat(32),
            pruned: false,
          },
          error: null,
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      },
      requestImpl: async () => {
        requestCalls += 1;
        return {
          statusCode: 200,
          bodyText: JSON.stringify({ result: null, error: null }),
        };
      },
    });

    const info = await rpc.getBlockchainInfo();

    assert.equal(info.chain, "main");
    assert.equal(fetchCalls, 1);
    assert.equal(requestCalls, 0);
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("BitcoinRpcClient uses the raw request transport for loadtxoutset and preserves the actual cause", async () => {
  const rootDir = createTempDirectory("cogcoin-client-rpc-loadtxoutset");

  try {
    const cookieFile = join(rootDir, ".cookie");
    await writeFile(cookieFile, "user:password\n");
    let fetchCalls = 0;
    let requestCalls = 0;
    const rpc = new BitcoinRpcClient("http://127.0.0.1:8332", cookieFile, {
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("fetch transport should not be used for loadtxoutset");
      },
      requestImpl: async () => {
        requestCalls += 1;
        throw new Error("socket hang up", {
          cause: new Error("ECONNRESET"),
        });
      },
    });

    await assert.rejects(
      async () => rpc.loadTxOutSet("/tmp/utxo-910000.dat"),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /for loadtxoutset failed/);
        assert.match(error.message, /socket hang up/);
        assert.match(error.message, /ECONNRESET/);
        return true;
      },
    );

    assert.equal(fetchCalls, 0);
    assert.equal(requestCalls, 1);
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("BitcoinRpcClient describes a missing cookie file as a managed-node shutdown condition", async () => {
  const rootDir = createTempDirectory("cogcoin-client-rpc-cookie-missing");

  try {
    const cookieFile = join(rootDir, ".cookie");
    const rpc = new BitcoinRpcClient("http://127.0.0.1:8332", cookieFile);

    await assert.rejects(
      async () => rpc.getBlockchainInfo(),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /cookie file is unavailable/);
        assert.match(error.message, /managed node is not running or is shutting down/);
        return true;
      },
    );
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("managed bitcoind client syncs regtest blocks and survives restart", async (t) => {
  await ensureBitcoinBinaries(t);
  const fixture = createFixture("cogcoin-client-bitcoind-sync");
  let client: Awaited<ReturnType<typeof openManagedBitcoindClientInternal>> | null = null;

  try {
    const store = await openSqliteStore({ filename: fixture.databasePath });
    client = await openManagedBitcoindClientInternal({
      store,
      dataDir: fixture.dataDir,
      chain: "regtest",
      startHeight: 0,
      snapshotInterval: 2,
      pollIntervalMs: 250,
      syncDebounceMs: 50,
    });

    const startupStatus = await client.getNodeStatus();
    const descriptor = await getMiningDescriptor(fixture.dataDir, startupStatus.rpc.port);
    await generateBlocks(fixture.dataDir, startupStatus.rpc.port, 3, descriptor);

    const syncResult = await client.syncToTip();
    assert.equal(syncResult.appliedBlocks, 4);
    assert.equal(syncResult.rewoundBlocks, 0);

    const firstStatus = await client.getNodeStatus();
    assert.equal(firstStatus.ready, true);
    assert.equal(firstStatus.chain, "regtest");
    assert.equal(firstStatus.indexedTip?.height, 3);
    assert.ok(firstStatus.nodeBestHeight !== null);

    const firstBlocks = await collectChainBlocks(firstStatus.rpc, firstStatus.nodeBestHeight ?? 0);
    const firstReplayState = await replayBlocks(firstBlocks);
    assert.equal(serializeStateHex(await client.getState()), serializeStateHex(firstReplayState));

    const firstTip = await client.getTip();
    await client.close();
    client = null;

    const reopenedStore = await openSqliteStore({ filename: fixture.databasePath });
    client = await openManagedBitcoindClientInternal({
      store: reopenedStore,
      dataDir: fixture.dataDir,
      chain: "regtest",
      startHeight: 0,
      snapshotInterval: 2,
      pollIntervalMs: 250,
      syncDebounceMs: 50,
    });

    const resync = await client.syncToTip();
    assert.equal(resync.appliedBlocks, 0);
    assert.deepEqual(await client.getTip(), firstTip);

    const reopenedStatus = await client.getNodeStatus();
    const reopenedBlocks = await collectChainBlocks(reopenedStatus.rpc, reopenedStatus.nodeBestHeight ?? 0);
    const reopenedReplayState = await replayBlocks(reopenedBlocks);
    assert.equal(serializeStateHex(await client.getState()), serializeStateHex(reopenedReplayState));
  } finally {
    await client?.close();
    await cleanupManagedFixture(fixture);
  }
});

test("managed bitcoind client rewinds and replays when a competing regtest chain wins", async (t) => {
  await ensureBitcoinBinaries(t);
  const fixture = createFixture("cogcoin-client-bitcoind-reorg");
  let client: Awaited<ReturnType<typeof openManagedBitcoindClientInternal>> | null = null;
  const alternateDataDir = join(fixture.rootDir, "bitcoind-alt");

  try {
    const store = await openSqliteStore({ filename: fixture.databasePath });
    client = await openManagedBitcoindClientInternal({
      store,
      dataDir: fixture.dataDir,
      chain: "regtest",
      startHeight: 0,
      snapshotInterval: 2,
      pollIntervalMs: 250,
      syncDebounceMs: 50,
    });

    const startupStatus = await client.getNodeStatus();
    const descriptor = await getMiningDescriptor(fixture.dataDir, startupStatus.rpc.port);
    const firstBranch = await generateBlocks(fixture.dataDir, startupStatus.rpc.port, 2, descriptor);
    await client.syncToTip();

    assert.equal((await client.getTip())?.height, 2);
    assert.equal(firstBranch.length, 2);
    await client.close();
    client = null;

    const alternateStore = await openSqliteStore({ filename: fixture.databasePath });
    client = await openManagedBitcoindClientInternal({
      store: alternateStore,
      dataDir: alternateDataDir,
      chain: "regtest",
      startHeight: 0,
      snapshotInterval: 2,
      pollIntervalMs: 250,
      syncDebounceMs: 50,
    });

    const alternateStatus = await client.getNodeStatus();
    const alternateDescriptor = await getMiningDescriptor(alternateDataDir, alternateStatus.rpc.port, "52");
    await generateBlocks(alternateDataDir, alternateStatus.rpc.port, 3, alternateDescriptor);

    const reorgResult = await client.syncToTip();
    assert.equal(reorgResult.rewoundBlocks, 2);
    assert.equal(reorgResult.commonAncestorHeight, 0);
    assert.equal(reorgResult.appliedBlocks, 3);

    const status = await client.getNodeStatus();
    const blocks = await collectChainBlocks(status.rpc, status.nodeBestHeight ?? 0);
    const replayState = await replayBlocks(blocks);
    assert.equal((await client.getTip())?.height, 3);
    assert.equal(serializeStateHex(await client.getState()), serializeStateHex(replayState));
  } finally {
    await client?.close();
    await cleanupManagedFixture(fixture, alternateDataDir);
  }
});

test("managed bitcoind client restores from checkpoints when a regtest reorg exceeds retained rewind history", async (t) => {
  await ensureBitcoinBinaries(t);
  const fixture = createFixture("cogcoin-client-bitcoind-deep-reorg");
  let client: Awaited<ReturnType<typeof openManagedBitcoindClientInternal>> | null = null;
  const alternateDataDir = join(fixture.rootDir, "bitcoind-alt");

  try {
    const store = await openSqliteStore({ filename: fixture.databasePath });
    client = await openManagedBitcoindClientInternal({
      store,
      dataDir: fixture.dataDir,
      chain: "regtest",
      startHeight: 0,
      snapshotInterval: 2,
      pollIntervalMs: 250,
      syncDebounceMs: 50,
    });

    const startupStatus = await client.getNodeStatus();
    const descriptor = await getMiningDescriptor(fixture.dataDir, startupStatus.rpc.port);
    await generateBlocks(fixture.dataDir, startupStatus.rpc.port, 105, descriptor);
    await client.syncToTip();

    assert.equal((await client.getTip())?.height, 105);
    assert.equal(await store.loadBlockRecord(5), null);
    assert.ok(await store.loadBlockRecord(6));

    await client.close();
    client = null;

    const alternateStore = await openSqliteStore({ filename: fixture.databasePath });
    client = await openManagedBitcoindClientInternal({
      store: alternateStore,
      dataDir: alternateDataDir,
      chain: "regtest",
      startHeight: 0,
      snapshotInterval: 2,
      pollIntervalMs: 250,
      syncDebounceMs: 50,
    });

    const alternateStatus = await client.getNodeStatus();
    const alternateDescriptor = await getMiningDescriptor(alternateDataDir, alternateStatus.rpc.port, "52");
    await generateBlocks(alternateDataDir, alternateStatus.rpc.port, 106, alternateDescriptor);

    const reorgResult = await client.syncToTip();
    assert.equal(reorgResult.rewoundBlocks, 105);
    assert.equal(reorgResult.commonAncestorHeight, 0);
    assert.equal(reorgResult.appliedBlocks, 106);

    const status = await client.getNodeStatus();
    const blocks = await collectChainBlocks(status.rpc, status.nodeBestHeight ?? 0);
    const replayState = await replayBlocks(blocks);
    assert.equal((await client.getTip())?.height, 106);
    assert.equal(serializeStateHex(await client.getState()), serializeStateHex(replayState));
  } finally {
    await client?.close();
    await cleanupManagedFixture(fixture, alternateDataDir);
  }
});

test("managed bitcoind client syncs through the live node tip before exiting", async (t) => {
  await ensureBitcoinBinaries(t);
  const fixture = createFixture("cogcoin-client-bitcoind-live-tip");
  let client: Awaited<ReturnType<typeof openManagedBitcoindClientInternal>> | null = null;

  try {
    const store = await openSqliteStore({ filename: fixture.databasePath });
    client = await openManagedBitcoindClientInternal({
      store,
      dataDir: fixture.dataDir,
      chain: "regtest",
      startHeight: 0,
      snapshotInterval: 2,
      pollIntervalMs: 250,
      syncDebounceMs: 50,
    });

    const startupStatus = await client.getNodeStatus();
    const descriptor = await getMiningDescriptor(fixture.dataDir, startupStatus.rpc.port);
    await generateBlocks(fixture.dataDir, startupStatus.rpc.port, 1_500, descriptor);

    let settled = false;
    const syncPromise = client.syncToTip().then(
      (result) => {
        settled = true;
        return result;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );

    await waitForCondition(async () => ((await client?.getTip())?.height ?? -1) >= 100, 10_000, 50);
    assert.equal(settled, false);

    await generateBlocks(fixture.dataDir, startupStatus.rpc.port, 25, descriptor);
    const syncResult = await syncPromise;

    assert.equal(syncResult.appliedBlocks, 1_526);
    assert.equal(syncResult.rewoundBlocks, 0);
    assert.equal(syncResult.commonAncestorHeight, null);
    assert.equal(syncResult.endingHeight, 1_525);
    assert.equal(syncResult.bestHeight, 1_525);

    const status = await client.getNodeStatus();
    assert.equal(status.indexedTip?.height, 1_525);
    assert.equal(status.nodeBestHeight, 1_525);
  } finally {
    await client?.close();
    await cleanupManagedFixture(fixture);
  }
});

test("managed bitcoind client follows new tips after follow mode starts", async (t) => {
  await ensureBitcoinBinaries(t);
  const fixture = createFixture("cogcoin-client-bitcoind-follow");
  let client: Awaited<ReturnType<typeof openManagedBitcoindClientInternal>> | null = null;

  try {
    const store = await openSqliteStore({ filename: fixture.databasePath });
    client = await openManagedBitcoindClientInternal({
      store,
      dataDir: fixture.dataDir,
      chain: "regtest",
      startHeight: 0,
      snapshotInterval: 2,
      pollIntervalMs: 250,
      syncDebounceMs: 50,
    });

    const startupStatus = await client.getNodeStatus();
    const descriptor = await getMiningDescriptor(fixture.dataDir, startupStatus.rpc.port);
    await generateBlocks(fixture.dataDir, startupStatus.rpc.port, 2, descriptor);
    await client.startFollowingTip();

    await waitForCondition(async () => (await client?.getTip())?.height === 2, 10_000, 100);
    await generateBlocks(fixture.dataDir, startupStatus.rpc.port, 1, descriptor);
    await waitForCondition(async () => (await client?.getTip())?.height === 3, 10_000, 100);

    const status = await client.getNodeStatus();
    assert.equal(status.following, true);
    assert.equal(status.indexedTip?.height, 3);
  } finally {
    await client?.close();
    await cleanupManagedFixture(fixture);
  }
});

test("managed bitcoind service reuses a singleton node and records runtime status", async (t) => {
  await ensureBitcoinBinaries(t);
  const fixture = createFixture("cogcoin-client-bitcoind-singleton");

  try {
    const firstHandle = await attachOrStartManagedBitcoindService({
      dataDir: fixture.dataDir,
      chain: "regtest",
      startHeight: 0,
    });
    const secondHandle = await attachOrStartManagedBitcoindService({
      dataDir: fixture.dataDir,
      chain: "regtest",
      startHeight: 0,
    });
    const status = await readManagedBitcoindServiceStatusForTesting(fixture.dataDir);
    const rpc = createRpcClient(firstHandle.rpc);
    const loadedWallets = await rpc.listWallets();

    assert.equal(secondHandle.pid, firstHandle.pid);
    assert.equal(secondHandle.rpc.port, firstHandle.rpc.port);
    assert.ok(status !== null);
    assert.equal(status?.processId, firstHandle.pid);
    assert.equal(status?.walletRootId, "wallet-root-uninitialized");
    assert.ok(status?.walletReplica !== null);
    assert.equal(status?.walletReplica?.loaded, false);
    assert.equal(status?.walletReplica?.proofStatus, "missing");
    assert.equal(loadedWallets.includes(status?.walletReplica?.walletName ?? ""), false);
  } finally {
    await cleanupManagedFixture(fixture);
  }
});

test("managed bitcoind service adopts a live legacy wallet-scoped runtime status across wallet roots", async (t) => {
  await ensureBitcoinBinaries(t);
  const fixture = createFixture("cogcoin-client-bitcoind-legacy-runtime");

  try {
    const firstHandle = await attachOrStartManagedBitcoindService({
      dataDir: fixture.dataDir,
      chain: "regtest",
      startHeight: 0,
    });
    const sharedPaths = resolveManagedServicePaths(fixture.dataDir, "wallet-root-uninitialized");
    const currentStatus = await readManagedBitcoindServiceStatusForTesting(fixture.dataDir);

    assert.ok(currentStatus !== null);

    const legacyWalletRootId = "wallet-root-legacy";
    const targetWalletRootId = "wallet-root-target";
    const legacyRuntimeRoot = join(sharedPaths.runtimeRoot, legacyWalletRootId);
    const legacyStatusPath = join(legacyRuntimeRoot, "bitcoind-status.json");
    await mkdir(legacyRuntimeRoot, { recursive: true });
    await writeFile(legacyStatusPath, JSON.stringify({
      ...currentStatus,
      walletRootId: legacyWalletRootId,
      runtimeRoot: legacyRuntimeRoot,
    }, null, 2));
    await rm(sharedPaths.bitcoindStatusPath, { force: true });

    const adoptedHandle = await attachOrStartManagedBitcoindService({
      dataDir: fixture.dataDir,
      chain: "regtest",
      startHeight: 0,
      walletRootId: targetWalletRootId,
    });
    const adoptedStatus = await readManagedBitcoindServiceStatusForTesting(fixture.dataDir);

    assert.equal(adoptedHandle.pid, firstHandle.pid);
    assert.ok(adoptedStatus !== null);
    assert.equal(adoptedStatus?.runtimeRoot, sharedPaths.walletRuntimeRoot);
    assert.equal(adoptedStatus?.walletRootId, targetWalletRootId);
    assert.equal(adoptedStatus?.processId, firstHandle.pid);
  } finally {
    await cleanupManagedFixture(fixture);
  }
});

test("managed client close detaches without stopping the managed services", async (t) => {
  await ensureBitcoinBinaries(t);
  const fixture = createFixture("cogcoin-client-managed-client-detach");
  let client: Awaited<ReturnType<typeof openManagedBitcoindClientInternal>> | null = null;

  try {
    const store = await openSqliteStore({ filename: fixture.databasePath });
    client = await openManagedBitcoindClientInternal({
      store,
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
      chain: "regtest",
      startHeight: 0,
      snapshotInterval: 2,
      pollIntervalMs: 250,
      syncDebounceMs: 50,
    });

    const statusBeforeClose = await client.getNodeStatus();
    const daemonInstanceIdBeforeClose = statusBeforeClose.indexerDaemon?.daemonInstanceId ?? null;
    const bitcoindPidBeforeClose = statusBeforeClose.pid;

    await client.close();
    client = null;

    const reattachedNode = await attachOrStartManagedBitcoindService({
      dataDir: fixture.dataDir,
      chain: "regtest",
      startHeight: 0,
    });
    const reattachedDaemon = await attachOrStartIndexerDaemon({
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
    });

    try {
      const daemonStatus = await reattachedDaemon.getStatus();
      assert.equal(reattachedNode.pid, bitcoindPidBeforeClose);
      assert.equal(daemonStatus.daemonInstanceId, daemonInstanceIdBeforeClose);
    } finally {
      await reattachedDaemon.close();
    }
  } finally {
    await client?.close().catch(() => undefined);
    await cleanupManagedFixture(fixture);
  }
});

test("managed client close reattaches the indexer daemon when background follow resume fails", async () => {
  let primaryResumeCalls = 0;
  let replacementResumeCalls = 0;
  let reattachCalls = 0;
  let nodeStopCalls = 0;
  let clientCloseCalls = 0;
  let progressCloseCalls = 0;

  const managedClient = new DefaultManagedBitcoindClient(
    {
      async getTip() {
        return null;
      },
      async getState() {
        throw new Error("unreachable");
      },
      async applyBlock() {
        throw new Error("unreachable");
      },
      async rewindToHeight() {
        throw new Error("unreachable");
      },
      async close() {
        clientCloseCalls += 1;
      },
    } as never,
    {} as never,
    {
      rpc: {} as never,
      zmq: {} as never,
      pid: null,
      expectedChain: "main",
      startHeight: 0,
      dataDir: "/tmp/cogcoin-managed-client-reattach",
      getblockArchiveEndHeight: null,
      getblockArchiveSha256: null,
      async validate() {},
      async stop() {
        nodeStopCalls += 1;
      },
    },
    {} as never,
    {
      async start() {},
      async close() {
        progressCloseCalls += 1;
      },
      getStatusSnapshot() {
        return {
          bootstrapPhase: null,
          bootstrapProgress: null,
          cogcoinSyncHeight: null,
          cogcoinSyncTargetHeight: null,
          currentQuote: null,
          snapshot: null,
        };
      },
      async playCompletionScene() {},
    } as never,
    {} as never,
    {
      async getStatus() {
        throw new Error("unreachable");
      },
      async openSnapshot() {
        throw new Error("unreachable");
      },
      async readSnapshot() {
        throw new Error("unreachable");
      },
      async closeSnapshot() {
        throw new Error("unreachable");
      },
      async pauseBackgroundFollow() {
        throw new Error("unreachable");
      },
      async resumeBackgroundFollow() {
        primaryResumeCalls += 1;
        throw new Error("indexer_daemon_protocol_error");
      },
      async close() {},
    },
    async () => {
      reattachCalls += 1;
      return {
        async getStatus() {
          throw new Error("unreachable");
        },
        async openSnapshot() {
          throw new Error("unreachable");
        },
        async readSnapshot() {
          throw new Error("unreachable");
        },
        async closeSnapshot() {
          throw new Error("unreachable");
        },
        async pauseBackgroundFollow() {
          throw new Error("unreachable");
        },
        async resumeBackgroundFollow() {
          replacementResumeCalls += 1;
        },
        async close() {},
      };
    },
    0,
    50,
    "/tmp/cogcoin-managed-client-reattach",
    "wallet-root-test",
    undefined,
    undefined,
    undefined,
  );

  await managedClient.close();

  assert.equal(primaryResumeCalls, 1);
  assert.equal(reattachCalls, 1);
  assert.equal(replacementResumeCalls, 1);
  assert.equal(nodeStopCalls, 1);
  assert.equal(clientCloseCalls, 1);
  assert.equal(progressCloseCalls, 1);
});

test("managed client close reattaches the indexer daemon when no daemon handle is attached", async () => {
  let replacementResumeCalls = 0;
  let reattachCalls = 0;
  let nodeStopCalls = 0;
  let clientCloseCalls = 0;
  let progressCloseCalls = 0;

  const managedClient = new DefaultManagedBitcoindClient(
    {
      async getTip() {
        return null;
      },
      async getState() {
        throw new Error("unreachable");
      },
      async applyBlock() {
        throw new Error("unreachable");
      },
      async rewindToHeight() {
        throw new Error("unreachable");
      },
      async close() {
        clientCloseCalls += 1;
      },
    } as never,
    {} as never,
    {
      rpc: {} as never,
      zmq: {} as never,
      pid: null,
      expectedChain: "main",
      startHeight: 0,
      dataDir: "/tmp/cogcoin-managed-client-reattach-missing",
      getblockArchiveEndHeight: null,
      getblockArchiveSha256: null,
      async validate() {},
      async stop() {
        nodeStopCalls += 1;
      },
    },
    {} as never,
    {
      async start() {},
      async close() {
        progressCloseCalls += 1;
      },
      getStatusSnapshot() {
        return {
          bootstrapPhase: null,
          bootstrapProgress: null,
          cogcoinSyncHeight: null,
          cogcoinSyncTargetHeight: null,
          currentQuote: null,
          snapshot: null,
        };
      },
      async playCompletionScene() {},
    } as never,
    {} as never,
    null,
    async () => {
      reattachCalls += 1;
      return {
        async getStatus() {
          throw new Error("unreachable");
        },
        async openSnapshot() {
          throw new Error("unreachable");
        },
        async readSnapshot() {
          throw new Error("unreachable");
        },
        async closeSnapshot() {
          throw new Error("unreachable");
        },
        async pauseBackgroundFollow() {
          throw new Error("unreachable");
        },
        async resumeBackgroundFollow() {
          replacementResumeCalls += 1;
        },
        async close() {},
      };
    },
    0,
    50,
    "/tmp/cogcoin-managed-client-reattach-missing",
    "wallet-root-test",
    undefined,
    undefined,
    undefined,
  );

  await managedClient.close();

  assert.equal(reattachCalls, 1);
  assert.equal(replacementResumeCalls, 1);
  assert.equal(nodeStopCalls, 1);
  assert.equal(clientCloseCalls, 1);
  assert.equal(progressCloseCalls, 1);
});

test("pauseIndexerDaemonForForegroundClientForTesting stops a timed-out daemon and returns null", async () => {
  let closeCalls = 0;
  let stopCalls = 0;

  const result = await pauseIndexerDaemonForForegroundClientForTesting({
    daemon: {
      async getStatus() {
        throw new Error("unreachable");
      },
      async openSnapshot() {
        throw new Error("unreachable");
      },
      async readSnapshot() {
        throw new Error("unreachable");
      },
      async closeSnapshot() {
        throw new Error("unreachable");
      },
      async pauseBackgroundFollow() {
        throw new Error("indexer_daemon_request_timeout");
      },
      async resumeBackgroundFollow() {
        throw new Error("unreachable");
      },
      async close() {
        closeCalls += 1;
      },
    },
    dataDir: "/tmp/cogcoin-indexer-daemon-recovery",
    walletRootId: "wallet-root-timeout",
    stopDaemon: async ({ dataDir, walletRootId }) => {
      stopCalls += 1;
      assert.equal(dataDir, "/tmp/cogcoin-indexer-daemon-recovery");
      assert.equal(walletRootId, "wallet-root-timeout");
      return {
        status: "stopped",
        walletRootId,
      };
    },
  });

  assert.equal(result, null);
  assert.equal(closeCalls, 1);
  assert.equal(stopCalls, 1);
});

test("indexer daemon keeps following in the background after sync client close", async (t) => {
  await ensureBitcoinBinaries(t);
  const fixture = createFixture("cogcoin-client-indexer-daemon-background-follow");
  let client: Awaited<ReturnType<typeof openManagedBitcoindClientInternal>> | null = null;

  try {
    const store = await openSqliteStore({ filename: fixture.databasePath });
    client = await openManagedBitcoindClientInternal({
      store,
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
      chain: "regtest",
      startHeight: 0,
      snapshotInterval: 2,
      pollIntervalMs: 250,
      syncDebounceMs: 50,
    });

    const startupStatus = await client.getNodeStatus();
    const descriptor = await getMiningDescriptor(fixture.dataDir, startupStatus.rpc.port);
    await generateBlocks(fixture.dataDir, startupStatus.rpc.port, 1, descriptor);
    await client.syncToTip();
    await client.close();
    client = null;

    const daemon = await attachOrStartIndexerDaemon({
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
    });

    try {
      await generateBlocks(fixture.dataDir, startupStatus.rpc.port, 1, descriptor);

      await waitForCondition(async () => {
        const status = await daemon.getStatus();
        return status.appliedTipHeight === 2 && status.coreBestHeight === 2 && status.state === "synced";
      }, 15_000, 100);

      const status = await daemon.getStatus();
      assert.equal(status.appliedTipHeight, 2);
      assert.equal(status.coreBestHeight, 2);
      assert.equal(status.state, "synced");
    } finally {
      await daemon.close();
    }
  } finally {
    await client?.close().catch(() => undefined);
    await cleanupManagedFixture(fixture);
  }
});

test("sync CLI resumes background indexer follow after a single SIGTERM detach", async (t) => {
  await ensureBitcoinBinaries(t);
  const fixture = createFixture("cogcoin-cli-sync-signal-detach");
  const runtimePaths = createTempWalletPaths(join(fixture.rootDir, "wallet-home"));
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const signals = new FakeSignalSource();
  let forcedExitCode: number | null = null;
  let releaseSyncReady!: () => void;
  const syncReady = new Promise<void>((resolve) => {
    releaseSyncReady = resolve;
  });
  let liveClient: Awaited<ReturnType<typeof openManagedBitcoindClientInternal>> | null = null;

  try {
    const node = await attachOrStartManagedBitcoindService({
      dataDir: fixture.dataDir,
      chain: "regtest",
      startHeight: 0,
    });
    const descriptor = await getMiningDescriptor(fixture.dataDir, node.rpc.port);
    await generateBlocks(fixture.dataDir, node.rpc.port, 250, descriptor);

    const syncPromise = runCli(["sync"], {
      stdout,
      stderr,
      signalSource: signals,
      forceExit: (code) => {
        forcedExitCode = code;
      },
      resolveDefaultClientDatabasePath: () => fixture.databasePath,
      resolveDefaultBitcoindDataDir: () => fixture.dataDir,
      resolveWalletRuntimePaths: () => runtimePaths,
      loadRawWalletStateEnvelope: async () => createWalletStateEnvelopeStub("wallet-root-sync-signal"),
      openManagedBitcoindClient: async ({ store, progressOutput, walletRootId }) => {
        liveClient = await openManagedBitcoindClientInternal({
          store,
          dataDir: fixture.dataDir,
          databasePath: fixture.databasePath,
          chain: "regtest",
          startHeight: 0,
          snapshotInterval: 2,
          pollIntervalMs: 250,
          syncDebounceMs: 50,
          progressOutput,
          walletRootId,
        });

        return {
          async syncToTip() {
            releaseSyncReady();
            return liveClient!.syncToTip();
          },
          async startFollowingTip() {
            await liveClient?.startFollowingTip();
          },
          async getNodeStatus() {
            return liveClient!.getNodeStatus();
          },
          async close() {
            const client = liveClient;
            liveClient = null;
            await client?.close();
          },
        };
      },
    });

    await syncReady;
    signals.emit("SIGTERM");
    const code = await syncPromise;

    assert.equal(code, 0);
    assert.equal(forcedExitCode, null);
    assert.equal(stdout.toString(), "");
    assert.match(stderr.toString(), /Detaching from managed Cogcoin client and resuming background indexer follow/);
    assert.match(stderr.toString(), /Detached cleanly; background indexer follow resumed/);

    const daemon = await attachOrStartIndexerDaemon({
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
    });

    try {
      await generateBlocks(fixture.dataDir, node.rpc.port, 1, descriptor);

      await waitForCondition(async () => {
        const status = await daemon.getStatus();
        return status.appliedTipHeight === 251 && status.coreBestHeight === 251 && status.state === "synced";
      }, 20_000, 100);

      const status = await daemon.getStatus();
      assert.equal(status.appliedTipHeight, 251);
      assert.equal(status.coreBestHeight, 251);
      assert.equal(status.state, "synced");
    } finally {
      await daemon.close();
    }
  } finally {
    const danglingClient = liveClient as { close(): Promise<void> } | null;
    if (danglingClient !== null) {
      await danglingClient.close().catch(() => undefined);
    }
    await cleanupManagedFixture(fixture);
  }
});

test("wallet read context close detaches without stopping managed services", async (t) => {
  await ensureBitcoinBinaries(t);
  const fixture = createFixture("cogcoin-client-read-context-detach");
  const runtimePaths = createTempWalletPaths(join(fixture.rootDir, "wallet-home"));
  let readContext: Awaited<ReturnType<typeof openWalletReadContext>> | null = null;

  try {
    readContext = await openWalletReadContext({
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
      paths: runtimePaths,
    });
    assert.equal(readContext.localState.availability, "uninitialized");

    const bitcoindPidBeforeClose = readContext.nodeStatus?.pid ?? null;
    const daemonInstanceIdBeforeClose = readContext.indexer.status?.daemonInstanceId ?? null;

    await readContext.close();
    readContext = null;

    const reattachedNode = await attachOrStartManagedBitcoindService({
      dataDir: fixture.dataDir,
      chain: "main",
      startHeight: 0,
    });
    const reattachedDaemon = await attachOrStartIndexerDaemon({
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
    });

    try {
      const daemonStatus = await reattachedDaemon.getStatus();
      assert.equal(reattachedNode.pid, bitcoindPidBeforeClose);
      assert.equal(daemonStatus.daemonInstanceId, daemonInstanceIdBeforeClose);
    } finally {
      await reattachedDaemon.close();
    }
  } finally {
    await readContext?.close().catch(() => undefined);
    await cleanupManagedFixture(fixture);
  }
});

test("stopManagedBitcoindService stops the managed node and clears runtime status", async (t) => {
  await ensureBitcoinBinaries(t);
  const fixture = createFixture("cogcoin-client-bitcoind-stop");

  try {
    const node = await attachOrStartManagedBitcoindService({
      dataDir: fixture.dataDir,
      chain: "regtest",
      startHeight: 0,
    });
    const pid = node.pid;
    const result = await stopManagedBitcoindService({
      dataDir: fixture.dataDir,
    });
    const status = await readManagedBitcoindServiceStatusForTesting(fixture.dataDir);

    assert.equal(result.status, "stopped");
    assert.equal(result.walletRootId, "wallet-root-uninitialized");
    assert.equal(status, null);

    if (pid !== null) {
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    }
  } finally {
    await cleanupManagedFixture(fixture);
  }
});

test("stopIndexerDaemonService stops only the managed indexer", async (t) => {
  await ensureBitcoinBinaries(t);
  const fixture = createFixture("cogcoin-client-indexer-stop");
  let client: Awaited<ReturnType<typeof openManagedBitcoindClientInternal>> | null = null;

  try {
    const store = await openSqliteStore({ filename: fixture.databasePath });
    client = await openManagedBitcoindClientInternal({
      store,
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
      chain: "regtest",
      startHeight: 0,
      snapshotInterval: 2,
      pollIntervalMs: 250,
      syncDebounceMs: 50,
    });

    const statusBeforeStop = await client.getNodeStatus();
    const nodeRpc = statusBeforeStop.rpc;
    const result = await stopIndexerDaemonService({
      dataDir: fixture.dataDir,
    });
    const daemonStatus = await readIndexerDaemonStatusForTesting({ dataDir: fixture.dataDir });
    const chainInfo = await createRpcClient(nodeRpc).getBlockchainInfo();

    assert.equal(result.status, "stopped");
    assert.equal(result.walletRootId, "wallet-root-uninitialized");
    assert.equal(daemonStatus, null);
    assert.equal(chainInfo.chain, "regtest");
  } finally {
    await client?.close().catch(() => undefined);
    await cleanupManagedFixture(fixture);
  }
});

test("indexer daemon starts, writes status, and serves coherent snapshot IPC", async (t) => {
  await ensureBitcoinBinaries(t);
  const fixture = createFixture("cogcoin-client-indexer-daemon");
  let client: Awaited<ReturnType<typeof openManagedBitcoindClientInternal>> | null = null;

  try {
    const store = await openSqliteStore({ filename: fixture.databasePath });
    client = await openManagedBitcoindClientInternal({
      store,
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
      chain: "regtest",
      startHeight: 0,
      snapshotInterval: 2,
      pollIntervalMs: 250,
      syncDebounceMs: 50,
    });

    const startupStatus = await client.getNodeStatus();
    const descriptor = await getMiningDescriptor(fixture.dataDir, startupStatus.rpc.port);
    await generateBlocks(fixture.dataDir, startupStatus.rpc.port, 2, descriptor);
    await client.syncToTip();

    const daemon = await attachOrStartIndexerDaemon({
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
    });
    await waitForCondition(async () => (await daemon.getStatus()).state === "synced", 10_000, 100);
    const daemonStatus = await daemon.getStatus();
    const snapshotHandle = await daemon.openSnapshot();
    const snapshot = await daemon.readSnapshot(snapshotHandle.token);
    const readState = deserializeIndexerState(Buffer.from(snapshot.stateBase64, "base64"));
    const fileStatus = await readIndexerDaemonStatusForTesting({ dataDir: fixture.dataDir });

    assert.equal(daemonStatus.serviceApiVersion, INDEXER_DAEMON_SERVICE_API_VERSION);
    assert.equal(daemonStatus.schemaVersion, INDEXER_DAEMON_SCHEMA_VERSION);
    assert.equal(daemonStatus.state, "synced");
    assert.equal(daemonStatus.walletRootId, "wallet-root-uninitialized");
    assert.equal(typeof daemonStatus.daemonInstanceId, "string");
    assert.equal(typeof daemonStatus.heartbeatAtUnixMs, "number");
    assert.equal(typeof daemonStatus.updatedAtUnixMs, "number");
    assert.equal(daemonStatus.activeSnapshotCount, 0);
    assert.ok(daemonStatus.snapshotSeq !== null);
    assert.ok(fileStatus !== null);
    assert.equal(fileStatus?.daemonInstanceId, daemonStatus.daemonInstanceId);
    assert.equal(snapshotHandle.serviceApiVersion, INDEXER_DAEMON_SERVICE_API_VERSION);
    assert.equal(snapshotHandle.schemaVersion, INDEXER_DAEMON_SCHEMA_VERSION);
    assert.equal(snapshotHandle.walletRootId, daemonStatus.walletRootId);
    assert.equal(snapshotHandle.daemonInstanceId, daemonStatus.daemonInstanceId);
    assert.equal(snapshotHandle.processId, daemonStatus.processId);
    assert.equal(snapshotHandle.startedAtUnixMs, daemonStatus.startedAtUnixMs);
    assert.equal(snapshotHandle.state, daemonStatus.state);
    assert.ok(snapshotHandle.heartbeatAtUnixMs >= daemonStatus.heartbeatAtUnixMs);
    assert.equal(snapshotHandle.rpcReachable, daemonStatus.rpcReachable);
    assert.equal(snapshotHandle.coreBestHeight, daemonStatus.coreBestHeight);
    assert.equal(snapshotHandle.coreBestHash, daemonStatus.coreBestHash);
    assert.equal(snapshotHandle.appliedTipHeight, daemonStatus.appliedTipHeight);
    assert.equal(snapshotHandle.appliedTipHash, daemonStatus.appliedTipHash);
    assert.equal(snapshotHandle.snapshotSeq, daemonStatus.snapshotSeq);
    assert.equal(snapshotHandle.backlogBlocks, daemonStatus.backlogBlocks);
    assert.equal(snapshotHandle.reorgDepth, daemonStatus.reorgDepth);
    assert.equal(snapshotHandle.lastAppliedAtUnixMs, daemonStatus.lastAppliedAtUnixMs);
    assert.equal(snapshotHandle.activeSnapshotCount, 1);
    assert.equal(snapshotHandle.lastError, daemonStatus.lastError);
    assert.equal(snapshotHandle.tipHeight, 2);
    assert.equal(snapshotHandle.tipHash, snapshot.tip?.blockHashHex ?? null);
    assert.equal(typeof snapshotHandle.openedAtUnixMs, "number");
    assert.equal(snapshot.tip?.height, 2);
    assert.equal(readState.history.currentHeight, 2);

    await daemon.closeSnapshot(snapshotHandle.token);
    await assert.rejects(
      async () => daemon.readSnapshot(snapshotHandle.token),
      /indexer_daemon_snapshot_invalid/,
    );
    await daemon.close();
  } finally {
    await client?.close();
    await cleanupManagedFixture(fixture);
  }
});

test("indexer daemon snapshotSeq advances when the indexed tip changes", async (t) => {
  await ensureBitcoinBinaries(t);
  const fixture = createFixture("cogcoin-client-indexer-snapshot-seq");
  let client: Awaited<ReturnType<typeof openManagedBitcoindClientInternal>> | null = null;

  try {
    const store = await openSqliteStore({ filename: fixture.databasePath });
    client = await openManagedBitcoindClientInternal({
      store,
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
      chain: "regtest",
      startHeight: 0,
      snapshotInterval: 2,
      pollIntervalMs: 250,
      syncDebounceMs: 50,
    });

    const startupStatus = await client.getNodeStatus();
    const descriptor = await getMiningDescriptor(fixture.dataDir, startupStatus.rpc.port);
    await generateBlocks(fixture.dataDir, startupStatus.rpc.port, 1, descriptor);
    await client.syncToTip();

    const daemon = await attachOrStartIndexerDaemon({
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
    });

    try {
      const firstStatus = await daemon.getStatus();
      await generateBlocks(fixture.dataDir, startupStatus.rpc.port, 1, descriptor);
      await client.syncToTip();

      await waitForCondition(async () => {
        const refreshed = await daemon.getStatus();
        return refreshed.snapshotSeq !== firstStatus.snapshotSeq && refreshed.appliedTipHeight === 2;
      }, 10_000, 100);

      const secondStatus = await daemon.getStatus();
      assert.notEqual(secondStatus.snapshotSeq, firstStatus.snapshotSeq);
      assert.equal(secondStatus.appliedTipHeight, 2);
      assert.equal(secondStatus.state, "synced");
    } finally {
      await daemon.close();
    }
  } finally {
    await client?.close();
    await cleanupManagedFixture(fixture);
  }
});

test("indexer daemon refreshes from durable runtime config even when bitcoind status is missing", async (t) => {
  await ensureBitcoinBinaries(t);
  const fixture = createFixture("cogcoin-client-indexer-runtime-config");
  let client: Awaited<ReturnType<typeof openManagedBitcoindClientInternal>> | null = null;

  try {
    const store = await openSqliteStore({ filename: fixture.databasePath });
    client = await openManagedBitcoindClientInternal({
      store,
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
      chain: "regtest",
      startHeight: 0,
      snapshotInterval: 2,
      pollIntervalMs: 250,
      syncDebounceMs: 50,
    });

    const startupStatus = await client.getNodeStatus();
    const descriptor = await getMiningDescriptor(fixture.dataDir, startupStatus.rpc.port);
    await generateBlocks(fixture.dataDir, startupStatus.rpc.port, 2, descriptor);
    await client.syncToTip();

    const daemon = await attachOrStartIndexerDaemon({
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
    });

    try {
      await waitForCondition(async () => (await daemon.getStatus()).state === "synced", 10_000, 100);
      const paths = resolveManagedServicePaths(fixture.dataDir, "wallet-root-uninitialized");
      const originalStatus = await readFile(paths.bitcoindStatusPath, "utf8");
      const runtimeConfig = JSON.parse(await readFile(paths.bitcoindRuntimeConfigPath, "utf8")) as {
        rpc: { cookieFile: string; port: number };
      };
      assert.equal(typeof runtimeConfig.rpc.cookieFile, "string");
      assert.equal(typeof runtimeConfig.rpc.port, "number");

      try {
        await rm(paths.bitcoindStatusPath, { force: true }).catch(() => undefined);
        const initialHeartbeat = (await daemon.getStatus()).heartbeatAtUnixMs;

        await waitForCondition(async () => {
          const status = await daemon.getStatus();
          return status.heartbeatAtUnixMs > initialHeartbeat && status.state === "synced";
        }, 10_000, 100);
      } finally {
        await writeFile(paths.bitcoindStatusPath, originalStatus, "utf8");
      }
    } finally {
      await daemon.close();
    }
  } finally {
    await client?.close();
    await cleanupManagedFixture(fixture);
  }
});

test("missing runtime config starts as starting and becomes failed after a successful refresh", async (t) => {
  await ensureBitcoinBinaries(t);
  const fixture = createFixture("cogcoin-client-indexer-runtime-missing");
  const walletRootId = "wallet-root-test";
  const paths = resolveManagedServicePaths(fixture.dataDir, walletRootId);
  let client: Awaited<ReturnType<typeof openManagedBitcoindClientInternal>> | null = null;

  try {
    const daemon = await attachOrStartIndexerDaemon({
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
      walletRootId,
    });

	    try {
	      await waitForCondition(async () => {
	        const status = await daemon.getStatus();
	        return status.state === "starting"
	          && status.lastError === "managed_bitcoind_runtime_config_unavailable";
	      }, 10_000, 100);
	      const startingStatus = await daemon.getStatus();
	      assert.equal(startingStatus.lastError, "managed_bitcoind_runtime_config_unavailable");
	    } finally {
      await daemon.close();
      await shutdownIndexerDaemonForTesting({ dataDir: fixture.dataDir, walletRootId }).catch(() => undefined);
    }

    const store = await openSqliteStore({ filename: fixture.databasePath });
    client = await openManagedBitcoindClientInternal({
      store,
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
      chain: "regtest",
      startHeight: 0,
      snapshotInterval: 2,
      pollIntervalMs: 250,
      syncDebounceMs: 50,
      walletRootId,
    });

    const startupStatus = await client.getNodeStatus();
    const descriptor = await getMiningDescriptor(fixture.dataDir, startupStatus.rpc.port);
    await generateBlocks(fixture.dataDir, startupStatus.rpc.port, 1, descriptor);
    await client.syncToTip();

    const syncedDaemon = await attachOrStartIndexerDaemon({
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
      walletRootId,
    });

    try {
      await waitForCondition(async () => (await syncedDaemon.getStatus()).state === "synced", 10_000, 100);
      await rm(paths.bitcoindRuntimeConfigPath, { force: true }).catch(() => undefined);
	      await waitForCondition(async () => {
	        const status = await syncedDaemon.getStatus();
	        return status.state === "failed"
	          && status.lastError === "managed_bitcoind_runtime_config_unavailable";
	      }, 10_000, 100);
	      const failedStatus = await syncedDaemon.getStatus();
	      assert.equal(failedStatus.state, "failed");
	      assert.equal(failedStatus.lastError, "managed_bitcoind_runtime_config_unavailable");
    } finally {
      await syncedDaemon.close();
      await shutdownIndexerDaemonForTesting({ dataDir: fixture.dataDir, walletRootId }).catch(() => undefined);
    }
  } finally {
    await client?.close();
    await cleanupManagedFixture(fixture);
  }
});

test("attach rejects a live daemon with incompatible service metadata without spawning a second daemon", async () => {
  const fixture = createFixture("cogcoin-client-indexer-incompatible");
  const walletRootId = "wallet-root-test";
  const paths = resolveManagedServicePaths(fixture.dataDir, walletRootId);
  await mkdir(paths.indexerServiceRoot, { recursive: true });

  const server = await startFakeIndexerDaemonServer(
    paths.indexerDaemonSocketPath,
    createManagedIndexerDaemonStatus(walletRootId, {
      serviceApiVersion: "cogcoin/indexer-ipc/v999",
    }),
  );

  try {
    await writeFile(
      paths.indexerDaemonStatusPath,
      JSON.stringify({
        instanceId: "stale-daemon",
        pid: 9999,
        ready: true,
        updatedAtUnixMs: 1_700_000_000_000,
        socketPath: "/tmp/stale-indexer.sock",
        walletRootId,
      }),
      "utf8",
    );

    await assert.rejects(
      async () => attachOrStartIndexerDaemon({
        dataDir: fixture.dataDir,
        databasePath: fixture.databasePath,
        walletRootId,
        startupTimeoutMs: 1_000,
      }),
      /indexer_daemon_service_version_mismatch/,
    );
    const advisoryStatus = await readIndexerDaemonStatusForTesting({ dataDir: fixture.dataDir, walletRootId });
    assert.ok(advisoryStatus !== null);
    assert.equal("serviceApiVersion" in advisoryStatus, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(paths.indexerDaemonSocketPath, { force: true }).catch(() => undefined);
    await cleanupManagedFixture(fixture);
  }
});

test("attach accepts a live daemon for a different wallet root when the daemon is otherwise compatible", async () => {
  const fixture = createFixture("cogcoin-client-indexer-root-mismatch");
  const walletRootId = "wallet-root-test";
  const paths = resolveManagedServicePaths(fixture.dataDir, walletRootId);
  const server = await startFakeIndexerDaemonServer(
    paths.indexerDaemonSocketPath,
    createManagedIndexerDaemonStatus("wallet-root-other"),
  );

  try {
    const daemon = await attachOrStartIndexerDaemon({
      dataDir: fixture.dataDir,
      databasePath: fixture.databasePath,
      walletRootId,
      startupTimeoutMs: 1_000,
    });
    await daemon.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(paths.indexerDaemonSocketPath, { force: true }).catch(() => undefined);
    await cleanupManagedFixture(fixture);
  }
});

test("attach rejects a live daemon with an incompatible schema version", async () => {
  const fixture = createFixture("cogcoin-client-indexer-schema-version");
  const walletRootId = "wallet-root-test";
  const paths = resolveManagedServicePaths(fixture.dataDir, walletRootId);
  const server = await startFakeIndexerDaemonServer(
    paths.indexerDaemonSocketPath,
    createManagedIndexerDaemonStatus(walletRootId, {
      schemaVersion: "cogcoin/indexer-db/v999",
    }),
  );

  try {
    await assert.rejects(
      async () => attachOrStartIndexerDaemon({
        dataDir: fixture.dataDir,
        databasePath: fixture.databasePath,
        walletRootId,
        startupTimeoutMs: 1_000,
      }),
      /indexer_daemon_schema_mismatch/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(paths.indexerDaemonSocketPath, { force: true }).catch(() => undefined);
    await cleanupManagedFixture(fixture);
  }
});

test("schema-incompatible sqlite stores surface schema-mismatch", async () => {
  const fixture = createFixture("cogcoin-client-indexer-schema-mismatch");
  const walletRootId = "wallet-root-test";
  let daemon: Awaited<ReturnType<typeof attachOrStartIndexerDaemon>> | null = null;

  try {
    const database = await openSqliteDatabase({ filename: fixture.databasePath });
    await database.exec("PRAGMA user_version = 999");
    await database.close();

    try {
      daemon = await attachOrStartIndexerDaemon({
        dataDir: fixture.dataDir,
        databasePath: fixture.databasePath,
        walletRootId,
        startupTimeoutMs: 5_000,
      });
    } catch (error) {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /indexer_daemon_schema_mismatch/,
      );
    }

    await waitForCondition(async () => {
      const status = await readIndexerDaemonStatusForTesting({ dataDir: fixture.dataDir, walletRootId });
      return status?.state === "schema-mismatch";
    }, 10_000, 100);

    const status = await readIndexerDaemonStatusForTesting({ dataDir: fixture.dataDir, walletRootId });
    assert.equal(status?.state, "schema-mismatch");
    assert.equal(status?.lastError, "sqlite_store_schema_version_unsupported");
  } finally {
    await daemon?.close().catch(() => undefined);
    await cleanupManagedFixture(fixture);
  }
});
