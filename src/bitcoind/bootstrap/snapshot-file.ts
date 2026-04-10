import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";

import { DEFAULT_SNAPSHOT_METADATA } from "./constants.js";
import type { BootstrapPaths } from "./types.js";
import type { SnapshotMetadata } from "../types.js";

export async function statOrNull(path: string): Promise<{ size: number } | null> {
  try {
    const info = await stat(path);
    return { size: info.size };
  } catch {
    return null;
  }
}

export async function resetSnapshotFiles(paths: BootstrapPaths): Promise<void> {
  await Promise.all([
    rm(paths.snapshotPath, { force: true }),
    rm(paths.partialSnapshotPath, { force: true }),
  ]);
}

async function hashFileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

export async function validateSnapshotFileForTesting(
  path: string,
  snapshot: SnapshotMetadata = DEFAULT_SNAPSHOT_METADATA,
): Promise<void> {
  const info = await stat(path);

  if (info.size !== snapshot.sizeBytes) {
    throw new Error(`snapshot_size_mismatch_${info.size}`);
  }

  const sha256 = await hashFileSha256(path);

  if (sha256 !== snapshot.sha256) {
    throw new Error(`snapshot_sha256_mismatch_${sha256}`);
  }
}
