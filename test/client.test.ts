import assert from "node:assert/strict";
import test from "node:test";

import {
  applyBlockWithScoring,
  createInitialState,
  loadBundledGenesisParameters,
  serializeIndexerState,
} from "@cogcoin/indexer";
import { openClient } from "../src/index.js";
import { openSqliteStore } from "../src/sqlite/index.js";
import { createTempDatabasePath, loadHistoryVector, materializeBlock } from "./helpers.js";

test("client applies vector-shaped blocks, survives restart, and rewinds cleanly", async () => {
  const databasePath = createTempDatabasePath("cogcoin-client");
  const historyVector = loadHistoryVector();
  const blocks = [...historyVector.setupBlocks, ...historyVector.testBlocks].map(materializeBlock);
  const genesis = await loadBundledGenesisParameters();

  const store = await openSqliteStore({ filename: databasePath });
  const client = await openClient({
    store,
    genesisParameters: genesis,
    snapshotInterval: 1000,
  });

  let directState = createInitialState(genesis);
  let lastClientResult = null;

  for (const block of blocks) {
    lastClientResult = await client.applyBlock(block);
    const directApplied = await applyBlockWithScoring(directState, block, genesis);
    directState = directApplied.state;
    assert.equal(lastClientResult.applied.stateHashHex, directApplied.stateHashHex);
  }

  assert.ok(lastClientResult !== null);
  assert.equal(
    lastClientResult.applied.stateHashHex,
    historyVector.testBlocks.at(-1)?.expected?.stateHashHex ?? null,
  );

  const clientState = await client.getState();
  assert.equal(
    Buffer.from(serializeIndexerState(clientState)).toString("hex"),
    Buffer.from(serializeIndexerState(directState)).toString("hex"),
  );

  const originalTip = await client.getTip();
  await client.close();

  const reopenedStore = await openSqliteStore({ filename: databasePath });
  const reopenedClient = await openClient({
    store: reopenedStore,
    genesisParameters: genesis,
    snapshotInterval: 1000,
  });

  const reopenedTip = await reopenedClient.getTip();
  assert.deepEqual(reopenedTip, originalTip);
  assert.equal(
    Buffer.from(serializeIndexerState(await reopenedClient.getState())).toString("hex"),
    Buffer.from(serializeIndexerState(directState)).toString("hex"),
  );

  const rewoundTip = await reopenedClient.rewindToHeight(historyVector.testBlocks[0]?.height ?? 0);
  assert.equal(rewoundTip?.height ?? null, historyVector.testBlocks[0]?.height ?? null);
  assert.equal(rewoundTip?.stateHashHex ?? null, historyVector.testBlocks[0]?.expected?.stateHashHex ?? null);

  await reopenedClient.close();
});

test("rewinding below genesis clears the tip and restores the initial state", async () => {
  const databasePath = createTempDatabasePath("cogcoin-client-empty");
  const historyVector = loadHistoryVector();
  const firstBlock = materializeBlock(historyVector.setupBlocks[0]);
  const genesis = await loadBundledGenesisParameters();

  const store = await openSqliteStore({ filename: databasePath });
  const client = await openClient({
    store,
    genesisParameters: genesis,
  });

  await client.applyBlock(firstBlock);
  const rewoundTip = await client.rewindToHeight(-1);
  assert.equal(rewoundTip, null);
  assert.equal(await client.getTip(), null);
  assert.equal(
    Buffer.from(serializeIndexerState(await client.getState())).toString("hex"),
    Buffer.from(serializeIndexerState(createInitialState(genesis))).toString("hex"),
  );

  await client.close();
});

test("client prunes block records below the retained rewind window", async () => {
  const databasePath = createTempDatabasePath("cogcoin-client-retention");
  const historyVector = loadHistoryVector();
  const blocks = [...historyVector.setupBlocks, ...historyVector.testBlocks].slice(0, 4).map(materializeBlock);
  const genesis = await loadBundledGenesisParameters();

  const store = await openSqliteStore({ filename: databasePath });
  const client = await openClient({
    store,
    genesisParameters: genesis,
    snapshotInterval: 1000,
    blockRecordRetention: 2,
  });

  for (const block of blocks) {
    await client.applyBlock(block);
  }

  assert.equal(await store.loadBlockRecord(blocks[0].height), null);
  assert.equal(await store.loadBlockRecord(blocks[1].height), null);
  assert.ok(await store.loadBlockRecord(blocks[2].height));
  assert.ok(await store.loadBlockRecord(blocks[3].height));

  await assert.rejects(
    async () => client.rewindToHeight(blocks[0].height),
    /client_store_missing_block_record_/,
  );

  await client.close();
});

test("client keeps blocks below genesis inactive and activates exactly at genesis", async () => {
  const databasePath = createTempDatabasePath("cogcoin-client-genesis-boundary");
  const historyVector = loadHistoryVector();
  const genesisBlock = materializeBlock(historyVector.setupBlocks[0]);
  const genesis = await loadBundledGenesisParameters();
  const preGenesisBlock = {
    ...genesisBlock,
    height: genesis.genesisBlock - 1,
    hash: new Uint8Array(32).fill(0xaa),
    previousHash: new Uint8Array(32).fill(0x55),
  };
  const activatedGenesisBlock = {
    ...genesisBlock,
    previousHash: preGenesisBlock.hash,
  };

  const store = await openSqliteStore({ filename: databasePath });
  const client = await openClient({
    store,
    genesisParameters: genesis,
  });

  const preGenesisResult = await client.applyBlock(preGenesisBlock);
  assert.equal(preGenesisResult.applied.state.consensus.activationBlock, null);
  assert.equal((await client.getState()).consensus.activationBlock, null);

  const genesisResult = await client.applyBlock(activatedGenesisBlock);
  assert.equal(genesisResult.applied.state.consensus.activationBlock, genesis.genesisBlock);
  assert.equal((await client.getState()).consensus.activationBlock, genesis.genesisBlock);

  await client.close();
});
