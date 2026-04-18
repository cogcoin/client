import {
  createInitialState,
  deserializeIndexerState,
} from "@cogcoin/indexer";
import type {
  GenesisParameters,
  IndexerState,
} from "@cogcoin/indexer/types";

import type {
  ClientStoreAdapter,
  ClientTip,
  WriteAppliedBlockEntry,
} from "../types.js";
import { internalHashHexToDisplayHashHex } from "../bitcoind/hash-order.js";

function createResetEntry(): WriteAppliedBlockEntry {
  return {
    tip: null,
    stateBytes: null,
    blockRecord: null,
    checkpoint: null,
    deleteAboveHeight: -1,
  };
}

function snapshotUsesLegacyHashOrder(state: IndexerState, snapshotHashHex: string): boolean {
  const currentHashHex = state.history.currentHashHex;

  return currentHashHex !== null
    && currentHashHex === snapshotHashHex
    && internalHashHexToDisplayHashHex(currentHashHex) !== snapshotHashHex;
}

export async function initializeState(
  store: ClientStoreAdapter,
  genesisParameters: GenesisParameters,
): Promise<{ state: IndexerState; tip: ClientTip | null }> {
  const tip = await store.loadTip();
  const snapshot = await store.loadLatestSnapshot();

  if (snapshot === null) {
    if (tip !== null) {
      throw new Error("client_store_tip_without_snapshot");
    }

    // Repair orphaned rewind rows from previously interrupted writers so the
    // next replay pass does not collide on a stale future height.
    await store.deleteBlockRecordsAbove(-1);

    return {
      state: createInitialState(genesisParameters),
      tip: null,
    };
  }

  const state = deserializeIndexerState(snapshot.stateBytes);

  if (snapshotUsesLegacyHashOrder(state, snapshot.blockHashHex)) {
    await store.writeAppliedBlock(createResetEntry());

    return {
      state: createInitialState(genesisParameters),
      tip: null,
    };
  }

  if (tip === null) {
    await store.deleteBlockRecordsAbove(snapshot.height);

    return {
      state,
      tip: {
        height: snapshot.height,
        blockHashHex: snapshot.blockHashHex,
        previousHashHex: null,
        stateHashHex: state.history.stateHashByHeight.get(snapshot.height) ?? null,
      },
    };
  }

  if (tip.height !== snapshot.height || tip.blockHashHex !== snapshot.blockHashHex) {
    throw new Error("client_store_snapshot_tip_mismatch");
  }

  await store.deleteBlockRecordsAbove(tip.height);

  return { state, tip };
}
