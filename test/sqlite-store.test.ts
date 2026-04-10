import assert from "node:assert/strict";
import test from "node:test";

import {
  applyBlockWithScoring,
  createInitialState,
  loadBundledGenesisParameters,
  serializeBlockRecord,
  serializeIndexerState,
} from "@cogcoin/indexer";
import { openSqliteStore } from "../src/sqlite/index.js";
import { createTempDatabasePath, loadHistoryVector, materializeBlock } from "./helpers.js";

test("sqlite store initializes empty and migrations are idempotent", async () => {
  const databasePath = createTempDatabasePath("cogcoin-store");

  const firstStore = await openSqliteStore({ filename: databasePath });
  assert.equal(await firstStore.loadTip(), null);
  assert.equal(await firstStore.loadLatestSnapshot(), null);
  await firstStore.close();

  const secondStore = await openSqliteStore({ filename: databasePath });
  assert.equal(await secondStore.loadTip(), null);
  await secondStore.close();
});

test("sqlite store persists tip and snapshot bytes for applied blocks", async () => {
  const databasePath = createTempDatabasePath("cogcoin-store-apply");
  const historyVector = loadHistoryVector();
  const firstBlock = materializeBlock(historyVector.setupBlocks[0]);
  const genesis = await loadBundledGenesisParameters();
  const applied = await applyBlockWithScoring(createInitialState(genesis), firstBlock, genesis);
  const store = await openSqliteStore({ filename: databasePath });
  const now = Date.now();

  await store.writeAppliedBlock({
    tip: {
      height: firstBlock.height,
      blockHashHex: Buffer.from(firstBlock.hash).toString("hex"),
      previousHashHex: firstBlock.previousHash === null ? null : Buffer.from(firstBlock.previousHash).toString("hex"),
      stateHashHex: applied.stateHashHex,
    },
    stateBytes: serializeIndexerState(applied.state),
    blockRecord: {
      height: applied.blockRecord.height,
      blockHashHex: applied.blockRecord.hashHex,
      previousHashHex: applied.blockRecord.previousHashHex,
      stateHashHex: applied.blockRecord.stateHashHex,
      recordBytes: serializeBlockRecord(applied.blockRecord),
      createdAt: now,
    },
    checkpoint: {
      height: firstBlock.height,
      blockHashHex: Buffer.from(firstBlock.hash).toString("hex"),
      stateBytes: serializeIndexerState(applied.state),
      createdAt: now,
    },
  });

  const tip = await store.loadTip();
  const snapshot = await store.loadLatestSnapshot();
  const loadedRecord = await store.loadBlockRecord(firstBlock.height);

  assert.equal(tip?.height, firstBlock.height);
  assert.equal(snapshot?.height, firstBlock.height);
  assert.ok(loadedRecord !== null);
  assert.equal(
    Buffer.from(snapshot?.stateBytes ?? new Uint8Array()).toString("hex"),
    Buffer.from(serializeIndexerState(applied.state)).toString("hex"),
  );

  await store.close();
});

test("sqlite store rolls back tip changes when a block-record insert fails", async () => {
  const databasePath = createTempDatabasePath("cogcoin-store-rollback");
  const historyVector = loadHistoryVector();
  const firstBlock = materializeBlock(historyVector.setupBlocks[0]);
  const genesis = await loadBundledGenesisParameters();
  const applied = await applyBlockWithScoring(createInitialState(genesis), firstBlock, genesis);
  const store = await openSqliteStore({ filename: databasePath });
  const recordBytes = serializeBlockRecord(applied.blockRecord);
  const stateBytes = serializeIndexerState(applied.state);
  const firstEntry = {
    tip: {
      height: firstBlock.height,
      blockHashHex: Buffer.from(firstBlock.hash).toString("hex"),
      previousHashHex: firstBlock.previousHash === null ? null : Buffer.from(firstBlock.previousHash).toString("hex"),
      stateHashHex: applied.stateHashHex,
    },
    stateBytes,
    blockRecord: {
      height: applied.blockRecord.height,
      blockHashHex: applied.blockRecord.hashHex,
      previousHashHex: applied.blockRecord.previousHashHex,
      stateHashHex: applied.blockRecord.stateHashHex,
      recordBytes,
      createdAt: 1,
    },
    checkpoint: null,
  } as const;

  await store.writeAppliedBlock(firstEntry);
  const previousTip = await store.loadTip();

  await assert.rejects(async () => {
    await store.writeAppliedBlock({
      tip: {
        height: firstBlock.height + 1,
        blockHashHex: "ff".repeat(32),
        previousHashHex: firstEntry.tip.blockHashHex,
        stateHashHex: "00".repeat(32),
      },
      stateBytes,
      blockRecord: {
        height: firstEntry.blockRecord.height,
        blockHashHex: firstEntry.blockRecord.blockHashHex,
        previousHashHex: firstEntry.blockRecord.previousHashHex,
        stateHashHex: firstEntry.blockRecord.stateHashHex,
        recordBytes: firstEntry.blockRecord.recordBytes,
        createdAt: 2,
      },
      checkpoint: null,
    });
  });

  assert.deepEqual(await store.loadTip(), previousTip);
  await store.close();
});
