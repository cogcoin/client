import assert from "node:assert/strict";
import test from "node:test";

import {
  applyBlockWithScoring,
  createInitialState,
  loadBundledGenesisParameters,
  serializeBlockRecord,
  serializeIndexerState,
} from "@cogcoin/indexer";
import { displayHashHexToInternalBytes, internalBytesToDisplayHashHex } from "../src/bitcoind/hash-order.js";
import { bytesToHex } from "../src/bytes.js";
import { DefaultClient } from "../src/client/default-client.js";
import { openClient } from "../src/index.js";
import { openSqliteStore } from "../src/sqlite/index.js";
import { createTempDatabasePath, loadHistoryVector, materializeBlock } from "./helpers.js";

function createInternalOrderBlock(
  height: number,
  displayHashHex: string,
  previousDisplayHashHex: string | null,
) {
  return {
    height,
    hash: displayHashHexToInternalBytes(displayHashHex),
    previousHash: previousDisplayHashHex === null ? null : displayHashHexToInternalBytes(previousDisplayHashHex),
    transactions: [],
  };
}

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

test("client exposes coherent mirror snapshot and delta reads", async () => {
  const databasePath = createTempDatabasePath("cogcoin-client-mirror-reads");
  const historyVector = loadHistoryVector();
  const blocks = [...historyVector.setupBlocks, ...historyVector.testBlocks].slice(0, 4).map(materializeBlock);
  const genesis = await loadBundledGenesisParameters();

  const store = await openSqliteStore({ filename: databasePath });
  const client = await openClient({
    store,
    genesisParameters: genesis,
    snapshotInterval: 1000,
    blockRecordRetention: 8,
  });

  for (const block of blocks) {
    await client.applyBlock(block);
  }

  const mirrorSnapshot = await client.readMirrorSnapshot();
  assert.deepEqual(mirrorSnapshot.tip, await client.getTip());
  assert.equal(
    Buffer.from(mirrorSnapshot.stateBytes).toString("hex"),
    Buffer.from(serializeIndexerState(await client.getState())).toString("hex"),
  );

  const mirrorDelta = await client.readMirrorDelta(blocks[1]!.height);
  assert.deepEqual(mirrorDelta.tip, await client.getTip());
  assert.deepEqual(mirrorDelta.blockRecords.map((record) => record.height), [blocks[2]!.height, blocks[3]!.height]);
  assert.deepEqual(
    mirrorDelta.blockRecords.map((record) => record.blockHashHex),
    blocks.slice(2).map((block) => internalBytesToDisplayHashHex(block.hash)),
  );

  await client.close();
});

test("client queues mirror reads behind in-flight mutations", async () => {
  const databasePath = createTempDatabasePath("cogcoin-client-mirror-queue");
  const historyVector = loadHistoryVector();
  const blocks = [...historyVector.setupBlocks, ...historyVector.testBlocks].slice(0, 2).map(materializeBlock);
  const genesis = await loadBundledGenesisParameters();

  const store = await openSqliteStore({ filename: databasePath });
  const client = await openClient({
    store,
    genesisParameters: genesis,
    snapshotInterval: 1000,
    blockRecordRetention: 8,
  });

  const firstApply = client.applyBlock(blocks[0]!);
  const queuedSnapshot = client.readMirrorSnapshot();
  const queuedDelta = client.readMirrorDelta(blocks[0]!.height - 1);
  const [firstResult, firstSnapshot, firstDelta] = await Promise.all([firstApply, queuedSnapshot, queuedDelta]);

  assert.deepEqual(firstSnapshot.tip, firstResult.tip);
  assert.equal(
    Buffer.from(firstSnapshot.stateBytes).toString("hex"),
    Buffer.from(serializeIndexerState(firstResult.applied.state)).toString("hex"),
  );
  assert.equal(firstDelta.tip?.height, firstResult.tip.height);
  assert.deepEqual(firstDelta.blockRecords.map((record) => record.height), [blocks[0]!.height]);

  await client.applyBlock(blocks[1]!);

  const rewindPromise = (client as DefaultClient).rewindToHeight(-1);
  const postRewindSnapshotPromise = client.readMirrorSnapshot();
  const [rewoundTip, rewoundSnapshot] = await Promise.all([rewindPromise, postRewindSnapshotPromise]);

  assert.equal(rewoundTip, null);
  assert.equal(rewoundSnapshot.tip, null);
  assert.equal(
    Buffer.from(rewoundSnapshot.stateBytes).toString("hex"),
    Buffer.from(serializeIndexerState(createInitialState(genesis))).toString("hex"),
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

test("client restores a persisted checkpoint and prunes newer rewind data", async () => {
  const databasePath = createTempDatabasePath("cogcoin-client-restore");
  const historyVector = loadHistoryVector();
  const blocks = [...historyVector.setupBlocks, ...historyVector.testBlocks].slice(0, 4).map(materializeBlock);
  const genesis = await loadBundledGenesisParameters();

  const store = await openSqliteStore({ filename: databasePath });
  const client = await openClient({
    store,
    genesisParameters: genesis,
    snapshotInterval: 2,
  }) as DefaultClient;

  for (const block of blocks) {
    await client.applyBlock(block);
  }

  const checkpointBoundHeight = blocks[2]!.height;
  const checkpoint = await store.loadLatestCheckpointAtOrBelow(checkpointBoundHeight);
  assert.ok(checkpoint !== null);
  assert.ok(checkpoint.height < blocks.at(-1)!.height);
  assert.ok(await store.loadBlockRecord(blocks[3]!.height));

  const restoredTip = await client.restoreCheckpoint(checkpoint);

  assert.equal(restoredTip.height, checkpoint.height);
  assert.equal(restoredTip.blockHashHex, checkpoint.blockHashHex);
  assert.equal(restoredTip.previousHashHex, null);
  assert.equal((await client.getTip())?.height, checkpoint.height);
  assert.equal(await store.loadBlockRecord(blocks[2]!.height), null);
  assert.equal(await store.loadBlockRecord(blocks[3]!.height), null);
  assert.equal((await store.loadLatestCheckpointAtOrBelow(blocks[3]!.height))?.height, checkpoint.height);
  assert.equal(
    Buffer.from(serializeIndexerState(await client.getState())).toString("hex"),
    Buffer.from(checkpoint.stateBytes).toString("hex"),
  );

  await client.close();
});

test("client resetToInitialState clears persisted snapshots and rewind data", async () => {
  const databasePath = createTempDatabasePath("cogcoin-client-reset");
  const historyVector = loadHistoryVector();
  const blocks = [...historyVector.setupBlocks, ...historyVector.testBlocks].slice(0, 2).map(materializeBlock);
  const genesis = await loadBundledGenesisParameters();

  const store = await openSqliteStore({ filename: databasePath });
  const client = await openClient({
    store,
    genesisParameters: genesis,
    snapshotInterval: 1,
  }) as DefaultClient;

  for (const block of blocks) {
    await client.applyBlock(block);
  }

  await client.resetToInitialState();

  assert.equal(await client.getTip(), null);
  assert.equal(await store.loadLatestSnapshot(), null);
  assert.equal(await store.loadLatestCheckpointAtOrBelow(blocks.at(-1)?.height ?? 0), null);
  assert.equal(await store.loadBlockRecord(blocks[0]!.height), null);
  assert.equal(
    Buffer.from(serializeIndexerState(await client.getState())).toString("hex"),
    Buffer.from(serializeIndexerState(createInitialState(genesis))).toString("hex"),
  );

  await client.close();
});

test("client stores display-order tip and rewind metadata while preserving internal-order kernel state", async () => {
  const databasePath = createTempDatabasePath("cogcoin-client-hash-order");
  const genesis = await loadBundledGenesisParameters();
  const parentDisplayHashHex = "00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f";
  const firstDisplayHashHex = "0f1e2d3c4b5a69788796a5b4c3d2e1f000112233445566778899aabbccddeeff";
  const secondDisplayHashHex = "fedcba98765432100123456789abcdef112233445566778899aabbccddeeff00";
  const firstBlock = createInternalOrderBlock(genesis.genesisBlock - 1, firstDisplayHashHex, parentDisplayHashHex);
  const secondBlock = createInternalOrderBlock(genesis.genesisBlock, secondDisplayHashHex, firstDisplayHashHex);

  const store = await openSqliteStore({ filename: databasePath });
  const client = await openClient({
    store,
    genesisParameters: genesis,
    snapshotInterval: 1000,
  });

  await client.applyBlock(firstBlock);
  await client.applyBlock(secondBlock);

  const tip = await client.getTip();
  const state = await client.getState();
  const storedRecord = await store.loadBlockRecord(secondBlock.height);

  assert.equal(tip?.blockHashHex, secondDisplayHashHex);
  assert.equal(tip?.previousHashHex, firstDisplayHashHex);
  assert.equal(state.history.currentHashHex, bytesToHex(secondBlock.hash));
  assert.ok(storedRecord !== null);
  assert.equal(storedRecord.blockHashHex, secondDisplayHashHex);
  assert.equal(storedRecord.previousHashHex, firstDisplayHashHex);

  await client.close();

  const reopenedStore = await openSqliteStore({ filename: databasePath });
  const reopenedClient = await openClient({
    store: reopenedStore,
    genesisParameters: genesis,
    snapshotInterval: 1000,
  });

  const reopenedTip = await reopenedClient.getTip();
  assert.equal(reopenedTip?.blockHashHex, secondDisplayHashHex);
  assert.equal(reopenedTip?.previousHashHex, firstDisplayHashHex);

  const rewoundTip = await reopenedClient.rewindToHeight(firstBlock.height);
  assert.equal(rewoundTip?.blockHashHex, firstDisplayHashHex);
  assert.equal(rewoundTip?.previousHashHex, parentDisplayHashHex);
  assert.equal(internalBytesToDisplayHashHex(firstBlock.hash), rewoundTip?.blockHashHex);

  await reopenedClient.close();
});

test("openClient resets legacy indexed state that stored internal-order hashes as client tip metadata", async () => {
  const databasePath = createTempDatabasePath("cogcoin-client-legacy-reset");
  const genesis = await loadBundledGenesisParameters();
  const legacyDisplayHashHex = "102132435465768798a9bacbdcedfe0f00112233445566778899aabbccddeeff";
  const legacyPreviousDisplayHashHex = "ffeeddccbbaa998877665544332211000f1e2d3c4b5a69788796a5b4c3d2e1f0";
  const legacyBlock = createInternalOrderBlock(
    genesis.genesisBlock - 1,
    legacyDisplayHashHex,
    legacyPreviousDisplayHashHex,
  );
  const applied = await applyBlockWithScoring(createInitialState(genesis), legacyBlock, genesis);
  const stateBytes = serializeIndexerState(applied.state);
  const store = await openSqliteStore({ filename: databasePath });
  const createdAt = Date.now();

  await store.writeAppliedBlock({
    tip: {
      height: legacyBlock.height,
      blockHashHex: bytesToHex(legacyBlock.hash),
      previousHashHex: legacyBlock.previousHash === null ? null : bytesToHex(legacyBlock.previousHash),
      stateHashHex: applied.stateHashHex,
    },
    stateBytes,
    blockRecord: {
      height: applied.blockRecord.height,
      blockHashHex: applied.blockRecord.hashHex,
      previousHashHex: applied.blockRecord.previousHashHex,
      stateHashHex: applied.blockRecord.stateHashHex,
      recordBytes: serializeBlockRecord(applied.blockRecord),
      createdAt,
    },
    checkpoint: {
      height: legacyBlock.height,
      blockHashHex: bytesToHex(legacyBlock.hash),
      stateBytes,
      createdAt,
    },
  });

  const client = await openClient({
    store,
    genesisParameters: genesis,
    snapshotInterval: 1000,
  });

  assert.equal(await client.getTip(), null);
  assert.equal(await store.loadLatestSnapshot(), null);
  assert.equal(await store.loadLatestCheckpointAtOrBelow(legacyBlock.height), null);
  assert.equal(await store.loadBlockRecord(legacyBlock.height), null);
  assert.equal(
    Buffer.from(serializeIndexerState(await client.getState())).toString("hex"),
    Buffer.from(serializeIndexerState(createInitialState(genesis))).toString("hex"),
  );

  await client.close();
});
