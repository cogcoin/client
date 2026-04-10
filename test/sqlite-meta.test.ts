import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { openClient } from "../src/client.js";
import { encodeInteger, encodeNullableText, hexToBytes } from "../src/bytes.js";
import { inspectPassiveClientStatus } from "../src/passive-status.js";
import { decodeTipMeta, requireTipStateBytes, TIP_META_KEYS } from "../src/sqlite/tip-meta.js";
import { openSqliteStore } from "../src/sqlite/index.js";
import { loadHistoryVector, materializeBlock } from "./helpers.js";
import { createTempDirectory, removeTempDirectory } from "./bitcoind-helpers.js";

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
