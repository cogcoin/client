import type { ClientStoreAdapter } from "../types.js";

export function assertClientStoreAdapter(store: ClientStoreAdapter): ClientStoreAdapter {
  const requiredMethods: Array<keyof ClientStoreAdapter> = [
    "loadTip",
    "loadLatestSnapshot",
    "loadLatestCheckpointAtOrBelow",
    "loadBlockRecordsAfter",
    "writeAppliedBlock",
    "deleteBlockRecordsAbove",
    "loadBlockRecord",
    "close",
  ];

  for (const method of requiredMethods) {
    if (typeof store[method] !== "function") {
      throw new TypeError(`client_store_adapter_missing_${String(method)}`);
    }
  }

  return store;
}

export function createClientStoreAdapter(store: ClientStoreAdapter): ClientStoreAdapter {
  return assertClientStoreAdapter(store);
}
