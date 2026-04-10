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
