import { loadBundledGenesisParameters } from "@cogcoin/indexer";

import { DefaultClient } from "./default-client.js";
import { initializeState } from "./initialization.js";
import { createClientStoreAdapter } from "./store-adapter.js";
import type {
  Client,
  ClientOptions,
} from "../types.js";

const DEFAULT_SNAPSHOT_INTERVAL = 1000;
const DEFAULT_BLOCK_RECORD_RETENTION = 1000;

export async function openClient(options: ClientOptions): Promise<Client> {
  const store = createClientStoreAdapter(options.store);
  const genesisParameters = options.genesisParameters ?? await loadBundledGenesisParameters();
  const snapshotInterval = options.snapshotInterval ?? DEFAULT_SNAPSHOT_INTERVAL;
  const blockRecordRetention = options.blockRecordRetention ?? DEFAULT_BLOCK_RECORD_RETENTION;

  if (!Number.isInteger(snapshotInterval) || snapshotInterval < 1) {
    throw new RangeError("client_snapshot_interval_invalid");
  }

  if (!Number.isInteger(blockRecordRetention) || blockRecordRetention < 1) {
    throw new RangeError("client_block_record_retention_invalid");
  }

  const { state, tip } = await initializeState(store, genesisParameters);

  return new DefaultClient(store, genesisParameters, state, tip, snapshotInterval, blockRecordRetention);
}
