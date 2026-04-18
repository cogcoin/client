import assert from "node:assert/strict";
import test from "node:test";

import { createInitialState, loadBundledGenesisParameters, serializeIndexerState } from "@cogcoin/indexer";

import { initializeState } from "../src/client/initialization.js";
import type { ClientCheckpoint, ClientStoreAdapter, ClientTip, StoredBlockRecord, WriteAppliedBlockEntry } from "../src/types.js";

function createMockStore(options: {
  tip: ClientTip | null;
  snapshot: ClientCheckpoint | null;
}) {
  const deletedAboveHeights: number[] = [];

  const store: ClientStoreAdapter = {
    async loadTip() {
      return options.tip;
    },
    async loadLatestSnapshot() {
      return options.snapshot;
    },
    async loadLatestCheckpointAtOrBelow() {
      return null;
    },
    async loadBlockRecordsAfter(): Promise<StoredBlockRecord[]> {
      return [];
    },
    async writeAppliedBlock(_entry: WriteAppliedBlockEntry): Promise<void> {},
    async deleteBlockRecordsAbove(height: number): Promise<void> {
      deletedAboveHeights.push(height);
    },
    async loadBlockRecord() {
      return null;
    },
    async close(): Promise<void> {},
  };

  return {
    store,
    deletedAboveHeights,
  };
}

test("initializeState prunes stale future block records above the persisted tip", async () => {
  const genesis = await loadBundledGenesisParameters();
  const state = createInitialState(genesis);
  const stateBytes = serializeIndexerState(state);
  const snapshot = {
    height: genesis.genesisBlock,
    blockHashHex: "11".repeat(32),
    stateBytes,
    createdAt: 1,
  };
  const tip = {
    height: snapshot.height,
    blockHashHex: snapshot.blockHashHex,
    previousHashHex: null,
    stateHashHex: state.history.stateHashByHeight.get(snapshot.height) ?? null,
  };
  const { store, deletedAboveHeights } = createMockStore({ tip, snapshot });

  const initialized = await initializeState(store, genesis);

  assert.deepEqual(initialized.tip, tip);
  assert.deepEqual(deletedAboveHeights, [tip.height]);
});

test("initializeState clears orphaned block records when no snapshot exists", async () => {
  const genesis = await loadBundledGenesisParameters();
  const { store, deletedAboveHeights } = createMockStore({
    tip: null,
    snapshot: null,
  });

  const initialized = await initializeState(store, genesis);

  assert.equal(initialized.tip, null);
  assert.deepEqual(
    Buffer.from(serializeIndexerState(initialized.state)).toString("hex"),
    Buffer.from(serializeIndexerState(createInitialState(genesis))).toString("hex"),
  );
  assert.deepEqual(deletedAboveHeights, [-1]);
});
