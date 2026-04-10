import { join } from "node:path";

import { DEFAULT_SNAPSHOT_METADATA } from "./constants.js";
import type { BootstrapPaths } from "./types.js";
import type { SnapshotMetadata } from "../types.js";

export function resolveBootstrapPaths(
  dataDir: string,
  snapshot: SnapshotMetadata,
): BootstrapPaths {
  const directory = join(dataDir, "bootstrap");
  return {
    directory,
    snapshotPath: join(directory, snapshot.filename),
    partialSnapshotPath: join(directory, `${snapshot.filename}.part`),
    statePath: join(directory, "state.json"),
    quoteStatePath: join(directory, "quote-state.json"),
  };
}

export function resolveBootstrapPathsForTesting(
  dataDir: string,
  snapshot: SnapshotMetadata = DEFAULT_SNAPSHOT_METADATA,
): BootstrapPaths {
  return resolveBootstrapPaths(dataDir, snapshot);
}
