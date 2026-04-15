import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  prepareLatestGetblockArchiveForTesting,
  resolveGetblockArchivePathsForTesting,
  resolveReadyGetblockArchiveForTesting,
} from "../src/bitcoind/testing.js";
import type { GetblockArchiveManifest } from "../src/bitcoind/types.js";

function chunkSha256s(payload: Buffer, chunkSizeBytes: number): string[] {
  const hashes: string[] = [];

  for (let offset = 0; offset < payload.length; offset += chunkSizeBytes) {
    hashes.push(createHash("sha256").update(payload.subarray(offset, offset + chunkSizeBytes)).digest("hex"));
  }

  return hashes;
}

function createManifest(payload: Buffer, endHeight: number, chunkSizeBytes = 4): GetblockArchiveManifest {
  return {
    formatVersion: 1,
    chain: "main",
    baseSnapshotHeight: 910_000,
    firstBlockHeight: 910_001,
    endHeight,
    blockCount: 0,
    artifactFilename: "getblock-910000-latest.dat",
    artifactSizeBytes: payload.length,
    artifactSha256: createHash("sha256").update(payload).digest("hex"),
    chunkSizeBytes,
    chunkSha256s: chunkSha256s(payload, chunkSizeBytes),
    blocks: [],
  };
}

function createFetchForArchive(
  manifest: GetblockArchiveManifest,
  payload: Buffer,
  requests: string[],
): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    requests.push(url);

    if (url.endsWith(".json") || url.includes(".json?")) {
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    if (url.endsWith(".dat") || url.includes(".dat?")) {
      const rangeHeader = init?.headers !== undefined && !Array.isArray(init.headers)
        ? init.headers instanceof Headers
          ? init.headers.get("Range")
          : "Range" in init.headers
            ? init.headers.Range
            : null
        : null;

      if (typeof rangeHeader === "string" && rangeHeader.startsWith("bytes=")) {
        const start = Number(rangeHeader.slice("bytes=".length, -1));
        return new Response(payload.subarray(start), { status: 206 });
      }

      return new Response(payload, { status: 200 });
    }

    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

test("prepareLatestGetblockArchiveForTesting downloads and validates the latest getblock archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-client-getblock-archive-"));
  const payload = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const manifest = createManifest(payload, 945_188);
  const requests: string[] = [];

  try {
    const ready = await prepareLatestGetblockArchiveForTesting({
      dataDir: root,
      progress: {
        async setPhase() {},
      },
      fetchImpl: createFetchForArchive(manifest, payload, requests),
    });

    assert.ok(ready !== null);
    assert.equal(ready.manifest.endHeight, 945_188);
    assert.deepEqual(requests, [
      "https://snapshots.cogcoin.org/getblock-910000-latest.json",
      "https://snapshots.cogcoin.org/getblock-910000-latest.dat?end=945188",
    ]);

    const artifact = await readFile(ready.artifactPath);
    assert.deepEqual(artifact, payload);
    const persisted = await resolveReadyGetblockArchiveForTesting(root);
    assert.ok(persisted !== null);
    assert.equal(persisted.manifest.artifactSha256, manifest.artifactSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareLatestGetblockArchiveForTesting falls back to the verified local archive when manifest refresh fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-client-getblock-archive-local-"));
  const payload = Buffer.from("ffeeddccbbaa99887766554433221100", "hex");
  const manifest = createManifest(payload, 945_188);
  const requests: string[] = [];

  try {
    const paths = resolveGetblockArchivePathsForTesting(root);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.artifactPath, payload);
    await writeFile(paths.manifestPath, JSON.stringify(manifest, null, 2));
    await writeFile(paths.statePath, JSON.stringify({
      metadataVersion: 1,
      formatVersion: manifest.formatVersion,
      endHeight: manifest.endHeight,
      artifactSizeBytes: manifest.artifactSizeBytes,
      artifactSha256: manifest.artifactSha256,
      chunkSizeBytes: manifest.chunkSizeBytes,
      verifiedChunkCount: manifest.chunkSha256s.length,
      downloadedBytes: manifest.artifactSizeBytes,
      validated: true,
      lastError: null,
      updatedAt: Date.now(),
    }, null, 2));

    const ready = await prepareLatestGetblockArchiveForTesting({
      dataDir: root,
      progress: {
        async setPhase() {},
      },
      fetchImpl: (async (input) => {
        requests.push(String(input));
        throw new Error("manifest fetch failed");
      }) as typeof fetch,
    });

    assert.ok(ready !== null);
    assert.equal(ready.manifest.endHeight, manifest.endHeight);
    assert.deepEqual(requests, [
      "https://snapshots.cogcoin.org/getblock-910000-latest.json?end=945188",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
