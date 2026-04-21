import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { resolveManagedServicePaths } from "../service-paths.js";
import type { ManagedBitcoindObservedStatus } from "../types.js";
import type { ManagedBitcoindStatusCandidate } from "./types.js";
import { readJsonFileIfPresent } from "./status.js";

export async function listManagedBitcoindStatusCandidates(options: {
  dataDir: string;
  runtimeRoot: string;
  expectedStatusPath: string;
}): Promise<ManagedBitcoindStatusCandidate[]> {
  const candidates = new Map<string, ManagedBitcoindObservedStatus>();
  const addCandidate = async (statusPath: string, allowDataDirMismatch = false): Promise<void> => {
    const status = await readJsonFileIfPresent<ManagedBitcoindObservedStatus>(statusPath);

    if (status === null) {
      return;
    }

    if (!allowDataDirMismatch && status.dataDir !== options.dataDir) {
      return;
    }

    candidates.set(statusPath, status);
  };

  await addCandidate(options.expectedStatusPath, true);

  try {
    const entries = await readdir(options.runtimeRoot, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const statusPath = join(options.runtimeRoot, entry.name, "bitcoind-status.json");

      if (statusPath === options.expectedStatusPath) {
        continue;
      }

      await addCandidate(statusPath);
    }
  } catch {
    // Missing runtime roots are handled by returning no candidates.
  }

  return [...candidates.entries()].map(([statusPath, status]) => ({
    statusPath,
    status,
  }));
}

export async function readManagedBitcoindObservedStatus(options: {
  dataDir: string;
  walletRootId: string;
}): Promise<ManagedBitcoindObservedStatus | null> {
  const paths = resolveManagedServicePaths(options.dataDir, options.walletRootId);
  return readJsonFileIfPresent<ManagedBitcoindObservedStatus>(paths.bitcoindStatusPath);
}
