import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  prepareGetblockArchiveRangeForTesting,
  resolveGetblockArchivePathsForTesting,
  resolveReadyGetblockArchiveForTesting,
} from "../src/bitcoind/testing.js";
import type { GetblockArchiveManifest, GetblockRangeManifest } from "../src/bitcoind/types.js";

function chunkSha256s(payload: Buffer, chunkSizeBytes: number): string[] {
  const hashes: string[] = [];

  for (let offset = 0; offset < payload.length; offset += chunkSizeBytes) {
    hashes.push(createHash("sha256").update(payload.subarray(offset, offset + chunkSizeBytes)).digest("hex"));
  }

  return hashes;
}

function createRangeManifest(
  payload: Buffer,
  firstBlockHeight: number,
  lastBlockHeight: number,
  chunkSizeBytes = 4,
): GetblockArchiveManifest {
  return {
    formatVersion: 1,
    chain: "main",
    baseSnapshotHeight: 910_000,
    firstBlockHeight,
    lastBlockHeight,
    artifactFilename: `getblock-${firstBlockHeight}-${lastBlockHeight}.dat`,
    artifactSizeBytes: payload.length,
    artifactSha256: createHash("sha256").update(payload).digest("hex"),
    chunkSizeBytes,
    chunkSha256s: chunkSha256s(payload, chunkSizeBytes),
  };
}

function createAggregateManifest(range: GetblockArchiveManifest): GetblockRangeManifest {
  return {
    formatVersion: 1,
    chain: "main",
    baseSnapshotHeight: 910_000,
    rangeSizeBlocks: 500,
    publishedThroughHeight: range.lastBlockHeight,
    ranges: [range],
  };
}

function createFetchForArchive(
  manifest: GetblockArchiveManifest,
  payload: Buffer,
  requests: string[],
): typeof fetch {
  const aggregateManifest = createAggregateManifest(manifest);

  return (async (input, init) => {
    const url = String(input);
    requests.push(url);

    if (url.endsWith("getblock-manifest.json")) {
      return new Response(JSON.stringify(aggregateManifest), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    if (url.endsWith(manifest.artifactFilename)) {
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

test("prepareGetblockArchiveRangeForTesting downloads and validates a published 500-block range", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-client-getblock-range-"));
  const payload = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const manifest = createRangeManifest(payload, 910_001, 910_500);
  const requests: string[] = [];

  try {
    const ready = await prepareGetblockArchiveRangeForTesting({
      dataDir: root,
      progress: {
        async setPhase() {},
      },
      firstBlockHeight: manifest.firstBlockHeight,
      lastBlockHeight: manifest.lastBlockHeight,
      fetchImpl: createFetchForArchive(manifest, payload, requests),
    });

    assert.ok(ready !== null);
    assert.equal(ready.manifest.lastBlockHeight, 910_500);
    assert.deepEqual(requests, [
      "https://snapshots.cogcoin.org/getblock-manifest.json",
      "https://snapshots.cogcoin.org/getblock-910001-910500.dat",
    ]);

    const artifact = await readFile(ready.artifactPath);
    assert.deepEqual(artifact, payload);
    const persisted = await resolveReadyGetblockArchiveForTesting(root, manifest);
    assert.ok(persisted !== null);
    assert.equal(persisted.manifest.artifactSha256, manifest.artifactSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareGetblockArchiveRangeForTesting falls back to the verified local range when manifest refresh fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-client-getblock-range-local-"));
  const payload = Buffer.from("ffeeddccbbaa99887766554433221100", "hex");
  const manifest = createRangeManifest(payload, 910_501, 911_000);
  const requests: string[] = [];

  try {
    const paths = resolveGetblockArchivePathsForTesting(root, manifest.firstBlockHeight, manifest.lastBlockHeight);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.artifactPath, payload);
    await writeFile(paths.statePath, JSON.stringify({
      metadataVersion: 1,
      formatVersion: manifest.formatVersion,
      firstBlockHeight: manifest.firstBlockHeight,
      lastBlockHeight: manifest.lastBlockHeight,
      artifactSizeBytes: manifest.artifactSizeBytes,
      artifactSha256: manifest.artifactSha256,
      chunkSizeBytes: manifest.chunkSizeBytes,
      verifiedChunkCount: manifest.chunkSha256s.length,
      downloadedBytes: manifest.artifactSizeBytes,
      validated: true,
      lastError: null,
      updatedAt: Date.now(),
    }, null, 2));

    const ready = await prepareGetblockArchiveRangeForTesting({
      dataDir: root,
      progress: {
        async setPhase() {},
      },
      firstBlockHeight: manifest.firstBlockHeight,
      lastBlockHeight: manifest.lastBlockHeight,
      fetchImpl: (async (input) => {
        requests.push(String(input));
        throw new Error("manifest fetch failed");
      }) as typeof fetch,
    });

    assert.ok(ready !== null);
    assert.equal(ready.manifest.lastBlockHeight, manifest.lastBlockHeight);
    assert.deepEqual(requests, [
      "https://snapshots.cogcoin.org/getblock-manifest.json",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
