import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { resolveManagedServicePaths } from "../src/bitcoind/service-paths.js";
import { openClient } from "../src/client.js";
import { encodeInteger, encodeNullableText, hexToBytes } from "../src/bytes.js";
import { inspectPassiveClientStatus } from "../src/passive-status.js";
import { decodeTipMeta, requireTipStateBytes, TIP_META_KEYS } from "../src/sqlite/tip-meta.js";
import { openSqliteStore } from "../src/sqlite/index.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import { saveMiningRuntimeStatus } from "../src/wallet/mining/runtime-artifacts.js";
import { loadHistoryVector, materializeBlock } from "./helpers.js";
import { createTempDirectory, removeTempDirectory } from "./bitcoind-helpers.js";
import { createMiningRuntimeStatus } from "./current-model-helpers.js";

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("shared tip-meta decoder returns null when tip metadata is absent", () => {
  assert.equal(decodeTipMeta(new Map()), null);
});

test("shared tip-meta decoder rejects incomplete tip metadata", () => {
  const meta = new Map<string, Uint8Array>();
  meta.set(TIP_META_KEYS.tipHeight, encodeInteger(1));
  meta.set(TIP_META_KEYS.tipBlockHash, hexToBytes("11".repeat(32)));

  assert.throws(() => decodeTipMeta(meta), /sqlite_store_tip_meta_incomplete/);
});

test("store-facing tip snapshot reader still requires state bytes", () => {
  const meta = new Map<string, Uint8Array>();
  meta.set(TIP_META_KEYS.tipHeight, encodeInteger(1));
  meta.set(TIP_META_KEYS.tipBlockHash, hexToBytes("11".repeat(32)));
  meta.set(TIP_META_KEYS.tipPreviousHash, new Uint8Array());
  meta.set(TIP_META_KEYS.tipStateHashHex, encodeNullableText("22".repeat(32)));
  meta.set(TIP_META_KEYS.tipUpdatedAt, encodeInteger(123));

  assert.throws(() => requireTipStateBytes(decodeTipMeta(meta)), /sqlite_store_tip_meta_incomplete/);
});

test("passive status reads indexed tip and checkpoint from a real store", async () => {
  const rootDir = createTempDirectory("cogcoin-client-passive-status");
  const dbPath = join(rootDir, "client.sqlite");
  const dataDir = join(rootDir, "bitcoin");

  try {
    const store = await openSqliteStore({ filename: dbPath });
    const client = await openClient({
      store,
      snapshotInterval: 1,
    });
    const vector = loadHistoryVector();
    const firstBlock = materializeBlock(vector.setupBlocks[0]!);
    await client.applyBlock(firstBlock);
    await client.close();

    const status = await inspectPassiveClientStatus(dbPath, dataDir);

    assert.equal(status.storeExists, true);
    assert.equal(status.storeInitialized, true);
    assert.equal(status.indexedTip?.height, firstBlock.height);
    assert.equal(status.latestCheckpoint?.height, firstBlock.height);
    assert.equal(status.storeError, null);
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("passive status inspection does not create a missing database", async () => {
  const rootDir = createTempDirectory("cogcoin-client-passive-missing");
  const dbPath = join(rootDir, "client", "client.sqlite");
  const dataDir = join(rootDir, "bitcoin");

  try {
    const status = await inspectPassiveClientStatus(dbPath, dataDir);

    assert.equal(status.storeExists, false);
    await assert.rejects(() => stat(dbPath));
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("passive status reads wallet root and managed runtime status files without decrypting wallet state", async () => {
  const rootDir = createTempDirectory("cogcoin-client-passive-runtime-status");
  const dbPath = join(rootDir, "client", "client.sqlite");
  const dataDir = join(rootDir, "bitcoin");
  const runtimePaths = resolveWalletRuntimePathsForTesting({
    platform: "linux",
    homeDirectory: rootDir,
    env: {
      ...process.env,
      XDG_DATA_HOME: join(rootDir, "data-home"),
      XDG_CONFIG_HOME: join(rootDir, "config-home"),
      XDG_STATE_HOME: join(rootDir, "state-home"),
      XDG_RUNTIME_DIR: join(rootDir, "runtime-home"),
    },
  });
  const servicePaths = resolveManagedServicePaths(dataDir, "wallet-root-passive");

  try {
    await writeJsonFile(runtimePaths.walletStatePath, {
      format: "cogcoin-local-wallet-state",
      walletRootIdHint: "wallet-root-passive",
    });
    await writeJsonFile(servicePaths.bitcoindStatusPath, {
      state: "starting",
      processId: 123,
      walletRootId: "wallet-root-passive",
      heartbeatAtUnixMs: 1_000,
      updatedAtUnixMs: 1_100,
      lastError: "Loading block index",
    });
    await writeJsonFile(servicePaths.indexerDaemonStatusPath, {
      state: "catching-up",
      processId: 456,
      walletRootId: "wallet-root-passive",
      coreBestHeight: 10,
      appliedTipHeight: 8,
      appliedTipHash: "aa".repeat(32),
      heartbeatAtUnixMs: 1_200,
      updatedAtUnixMs: 1_300,
      lastError: null,
    });
    await saveMiningRuntimeStatus(runtimePaths.miningStatusPath, createMiningRuntimeStatus({
      walletRootId: "wallet-root-passive",
      runMode: "foreground",
      miningState: "live",
      currentPhase: "waiting-indexer",
      backgroundWorkerPid: 789,
      backgroundWorkerHealth: "healthy",
      updatedAtUnixMs: 1_400,
      lastError: "provider backoff",
      note: "waiting for indexer",
    }));

    const status = await inspectPassiveClientStatus(dbPath, dataDir, runtimePaths);

    assert.equal(status.wallet.walletRootId, "wallet-root-passive");
    assert.equal(status.wallet.source, "wallet-state");
    assert.equal(status.managedBitcoind.state, "starting");
    assert.equal(status.managedBitcoind.processId, 123);
    assert.equal(status.managedBitcoind.lastError, "Loading block index");
    assert.equal(status.indexer.state, "catching-up");
    assert.equal(status.indexer.coreBestHeight, 10);
    assert.equal(status.indexer.appliedTipHeight, 8);
    assert.equal(status.mining.runMode, "foreground");
    assert.equal(status.mining.miningState, "live");
    assert.equal(status.mining.currentPhase, "waiting-indexer");
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("passive status reports corrupt runtime status files without throwing", async () => {
  const rootDir = createTempDirectory("cogcoin-client-passive-corrupt-runtime");
  const dbPath = join(rootDir, "client", "client.sqlite");
  const dataDir = join(rootDir, "bitcoin");
  const runtimePaths = resolveWalletRuntimePathsForTesting({
    platform: "linux",
    homeDirectory: rootDir,
    env: {
      ...process.env,
      XDG_DATA_HOME: join(rootDir, "data-home"),
      XDG_CONFIG_HOME: join(rootDir, "config-home"),
      XDG_STATE_HOME: join(rootDir, "state-home"),
      XDG_RUNTIME_DIR: join(rootDir, "runtime-home"),
    },
  });

  try {
    await mkdir(dirname(runtimePaths.bitcoindStatusPath), { recursive: true });
    await writeFile(runtimePaths.bitcoindStatusPath, "{not json", "utf8");

    const status = await inspectPassiveClientStatus(dbPath, dataDir, runtimePaths);

    assert.equal(status.managedBitcoind.present, true);
    assert.match(status.managedBitcoind.error ?? "", /JSON/);
    assert.equal(status.indexer.present, false);
    assert.equal(status.mining.present, false);
  } finally {
    await removeTempDirectory(rootDir);
  }
});
