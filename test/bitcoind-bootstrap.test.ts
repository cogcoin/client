import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  AssumeUtxoBootstrapController,
  DEFAULT_SNAPSHOT_METADATA,
  ManagedProgressController,
  TtyProgressRenderer,
  WritingQuoteRotator,
  advanceFollowSceneStateForTesting,
  createFollowSceneStateForTesting,
  createBootstrapProgressForTesting,
  createBootstrapStateForTesting,
  downloadSnapshotFileForTesting,
  formatCompactFollowAgeLabelForTesting,
  formatProgressLineForTesting,
  loadBannerArtForTesting,
  loadBootstrapStateForTesting,
  loadTrainCarArtForTesting,
  renderCompletionFrameForTesting,
  renderFollowFrameForTesting,
  loadScrollArtForTesting,
  loadTrainArtForTesting,
  loadTrainSmokeArtForTesting,
  loadWritingQuotesForTesting,
  renderArtFrameForTesting,
  renderIntroFrameForTesting,
  resolveCompletionMessageForTesting,
  resolveIntroMessageForTesting,
  resolveBootstrapPathsForTesting,
  resolveStatusFieldTextForTesting,
  saveBootstrapStateForTesting,
  setFollowBlockTimesForTesting,
  syncFollowSceneStateForTesting,
  waitForHeadersForTesting,
} from "../src/bitcoind/testing.js";
import { MANAGED_RPC_RETRY_MESSAGE } from "../src/bitcoind/retryable-rpc.js";
import type { BootstrapPhase, SnapshotChunkManifest, SnapshotMetadata, WritingQuote } from "../src/bitcoind/types.js";
import { createTempDirectory, removeTempDirectory } from "./bitcoind-helpers.js";

const execFileAsync = promisify(execFile);

function createDeterministicRandom(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index] ?? values[values.length - 1] ?? 0.5;
    index += 1;
    return value;
  };
}

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function extractScrollWindow(frame: string[]): string[] {
  return frame.slice(3, 11).map((line) => line.slice(7, 72));
}

function extractFollowWindow(frame: string[]): string[] {
  return frame.slice(3, 11).map((line) => line.slice(6, 74));
}

function extractTrainClipWindow(frame: string[]): string[] {
  return frame.slice(3, 11).map((line) => line.slice(6, 73));
}

function extractField(frame: string[], row: number): string {
  return frame[row - 1]?.slice(8, 72) ?? "";
}

function extractFollowBalanceLanes(frame: string[]): {
  cog: string;
  title: string;
  sat: string;
} {
  const field = extractField(frame, 2);
  return {
    cog: field.slice(0, 22),
    title: field.slice(22, 41),
    sat: field.slice(41, 64),
  };
}

function createIdentityPermutation(length: number): number[] {
  return Array.from({ length }, (_value, index) => index);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function resolveChunkSize(manifest: SnapshotChunkManifest, chunkIndex: number): number {
  const lastChunkIndex = manifest.chunkSha256s.length - 1;

  if (chunkIndex < lastChunkIndex) {
    return manifest.chunkSizeBytes;
  }

  const trailingBytes = manifest.snapshotSizeBytes % manifest.chunkSizeBytes;
  return trailingBytes === 0 ? manifest.chunkSizeBytes : trailingBytes;
}

function resolveVerifiedBytes(manifest: SnapshotChunkManifest, verifiedChunkCount: number): number {
  if (verifiedChunkCount <= 0) {
    return 0;
  }

  if (verifiedChunkCount >= manifest.chunkSha256s.length) {
    return manifest.snapshotSizeBytes;
  }

  return verifiedChunkCount * manifest.chunkSizeBytes;
}

function setVerifiedFrontierState(
  state: ReturnType<typeof createBootstrapStateForTesting>,
  manifest: SnapshotChunkManifest,
  verifiedChunkCount: number,
): void {
  state.integrityVersion = manifest.formatVersion;
  state.chunkSizeBytes = manifest.chunkSizeBytes;
  state.verifiedChunkCount = verifiedChunkCount;
  state.downloadedBytes = resolveVerifiedBytes(manifest, verifiedChunkCount);
}

function createChunkManifestForPayload(
  payload: Buffer,
  metadata: SnapshotMetadata,
  chunkSizeBytes = 4,
): SnapshotChunkManifest {
  const chunkSha256s: string[] = [];

  for (let offset = 0; offset < payload.length; offset += chunkSizeBytes) {
    chunkSha256s.push(createHash("sha256").update(payload.subarray(offset, offset + chunkSizeBytes)).digest("hex"));
  }

  return {
    formatVersion: 1,
    chunkSizeBytes,
    snapshotFilename: metadata.filename,
    snapshotHeight: metadata.height,
    snapshotSizeBytes: metadata.sizeBytes,
    snapshotSha256: metadata.sha256,
    chunkSha256s,
  };
}

function makeLongWord(length: number): string {
  return "x".repeat(length);
}

function expectedFollowAgeStart(heightLabelStart: number): number {
  return heightLabelStart + 2;
}

function findCenteredBlockRows(frame: string[]): {
  window: string[];
  nonEmptyRows: number[];
  bylineRow: number;
} {
  const window = extractScrollWindow(frame);
  const nonEmptyRows = window
    .map((line, index) => ({ index, trimmed: line.trim() }))
    .filter((line) => line.trimmed.length > 0)
    .map((line) => line.index);
  const bylineRow = nonEmptyRows[nonEmptyRows.length - 1] ?? -1;

  return {
    window,
    nonEmptyRows,
    bylineRow,
  };
}

function assertCenteredSprite(frame: string[], sprite: string[]): void {
  const window = extractScrollWindow(frame);
  assert.equal(window[0]?.trim(), "");
  assert.equal(window[7]?.trim(), "");

  for (const [index, line] of sprite.entries()) {
    assert.equal(window[index + 1], ` ${line}`);
  }
}

function assertCenteredField(frame: string[], row: number, text: string): void {
  const field = extractField(frame, row);

  assert.equal(field.trim(), text.trim());
  assert.equal(field.indexOf(text), Math.floor((64 - text.length) / 2));
}

function findSpriteBounds(frame: string[]): { minColumn: number; maxColumn: number } {
  const window = extractScrollWindow(frame);
  let minColumn = Number.POSITIVE_INFINITY;
  let maxColumn = Number.NEGATIVE_INFINITY;

  for (const line of window) {
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === " ") {
        continue;
      }

      minColumn = Math.min(minColumn, index);
      maxColumn = Math.max(maxColumn, index);
    }
  }

  return { minColumn, maxColumn };
}

function findFollowSpriteBounds(frame: string[]): { minColumn: number; maxColumn: number } {
  const window = extractFollowWindow(frame);
  let minColumn = Number.POSITIVE_INFINITY;
  let maxColumn = Number.NEGATIVE_INFINITY;

  for (const line of window) {
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] === " ") {
        continue;
      }

      minColumn = Math.min(minColumn, index);
      maxColumn = Math.max(maxColumn, index);
    }
  }

  return { minColumn, maxColumn };
}

test("snapshot chunk manifest generator writes reproducible chunk hashes and passes check mode", async () => {
  const rootDir = createTempDirectory("cogcoin-client-bootstrap-manifest-script");

  try {
    const payload = Buffer.from("manifest-script-payload");
    const inputPath = join(rootDir, "tiny.dat");
    const outputPath = join(rootDir, "manifest.ts");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const metadata: SnapshotMetadata = {
      url: "https://snapshots.cogcoin.org/tiny.dat",
      filename: "tiny.dat",
      height: 321,
      sha256,
      sizeBytes: payload.length,
    };
    const manifest = createChunkManifestForPayload(payload, metadata, 4);
    await writeFile(inputPath, payload);

    await execFileAsync("node", [
      "scripts/generate-default-snapshot-chunk-manifest.mjs",
      "--input", inputPath,
      "--output", outputPath,
      "--snapshot-filename", metadata.filename,
      "--snapshot-height", String(metadata.height),
      "--snapshot-size-bytes", String(metadata.sizeBytes),
      "--snapshot-sha256", metadata.sha256,
      "--chunk-size-bytes", String(manifest.chunkSizeBytes),
    ], {
      cwd: process.cwd(),
    });

    const output = await readFile(outputPath, "utf8");
    assert.ok(output.includes(`"snapshotFilename": "${metadata.filename}"`));
    assert.ok(output.includes(`"snapshotSha256": "${metadata.sha256}"`));
    assert.ok(output.includes(`"chunkSha256s": [`));
    assert.ok(output.includes(manifest.chunkSha256s[0] ?? ""));
    assert.ok(output.includes(manifest.chunkSha256s[manifest.chunkSha256s.length - 1] ?? ""));

    await execFileAsync("node", [
      "scripts/generate-default-snapshot-chunk-manifest.mjs",
      "--check",
      "--input", inputPath,
      "--output", outputPath,
      "--snapshot-filename", metadata.filename,
      "--snapshot-height", String(metadata.height),
      "--snapshot-size-bytes", String(metadata.sizeBytes),
      "--snapshot-sha256", metadata.sha256,
      "--chunk-size-bytes", String(manifest.chunkSizeBytes),
    ], {
      cwd: process.cwd(),
    });
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("art templates are 80x13 and copied into the test build output", async () => {
  const banner = loadBannerArtForTesting();
  const scroll = loadScrollArtForTesting();
  const trainSmoke = loadTrainSmokeArtForTesting();
  const train = loadTrainArtForTesting();
  const trainCar = loadTrainCarArtForTesting();

  for (const frame of [banner, scroll]) {
    assert.equal(frame.length, 13);

    for (const line of frame) {
      assert.equal(line.length, 80);
    }
  }

  for (const sprite of [trainSmoke, train]) {
    assert.equal(sprite.length, 6);

    for (const line of sprite) {
      assert.equal(line.length, 64);
    }
  }

  assert.equal(trainCar.length, 6);

  for (const line of trainCar) {
    assert.equal(line.length, 9);
  }

  await execFileAsync(process.execPath, ["./scripts/copy-static-assets.mjs", "build"], {
    cwd: process.cwd(),
  });

  await Promise.all([
    stat(join(process.cwd(), ".test-dist", "src", "art", "banner.txt")),
    stat(join(process.cwd(), ".test-dist", "src", "art", "balance.txt")),
    stat(join(process.cwd(), ".test-dist", "src", "art", "scroll.txt")),
    stat(join(process.cwd(), ".test-dist", "src", "art", "train-smoke.txt")),
    stat(join(process.cwd(), ".test-dist", "src", "art", "train.txt")),
    stat(join(process.cwd(), ".test-dist", "src", "art", "train-car.txt")),
    stat(join(process.cwd(), ".test-dist", "src", "art", "wallet.txt")),
    stat(join(process.cwd(), "dist", "art", "balance.txt")),
  ]);
});

test("downloadSnapshotFileForTesting resumes from the verified chunk frontier instead of raw file size", async () => {
  const payload = Buffer.from("assumeutxo-range-download");
  const requests: string[] = [];
  const rootDir = createTempDirectory("cogcoin-client-bootstrap-range");
  const server = createServer((request, response) => {
    requests.push(request.headers.range ?? "none");

    const rangeHeader = request.headers.range;

    if (rangeHeader) {
      const match = /^bytes=(\d+)-$/.exec(rangeHeader);
      const start = Number(match?.[1] ?? 0);
      const body = payload.subarray(start);
      response.writeHead(206, {
        "content-length": String(body.length),
        "content-range": `bytes ${start}-${payload.length - 1}/${payload.length}`,
      });
      response.end(body);
      return;
    }

    response.writeHead(200, {
      "content-length": String(payload.length),
    });
    response.end(payload);
  });

  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("test_http_server_address_missing");
    }

    const metadata: SnapshotMetadata = {
      url: `http://127.0.0.1:${address.port}/utxo.dat`,
      filename: "utxo.dat",
      height: 123,
      sha256: createHash("sha256").update(payload).digest("hex"),
      sizeBytes: payload.length,
    };
    const manifest = createChunkManifestForPayload(payload, metadata, 4);
    const paths = resolveBootstrapPathsForTesting(rootDir, metadata);
    const state = createBootstrapStateForTesting(metadata);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.partialSnapshotPath, payload.subarray(0, 6));
    setVerifiedFrontierState(state, manifest, 1);
    await saveBootstrapStateForTesting(paths, state);
    const progress = new ManagedProgressController({
      quoteStatePath: paths.quoteStatePath,
      snapshot: metadata,
      progressOutput: "none",
    });

    await progress.start();
    await downloadSnapshotFileForTesting({
      metadata,
      manifest,
      paths,
      progress,
      state,
    });
    await progress.close();

    assert.deepEqual(await readFile(paths.snapshotPath), payload);
    assert.deepEqual(requests[0], "bytes=4-");
    const persisted = await loadBootstrapStateForTesting(paths, metadata);
    assert.equal(persisted.validated, true);
    assert.equal(persisted.downloadedBytes, payload.length);
    assert.equal(persisted.verifiedChunkCount, manifest.chunkSha256s.length);
  } finally {
    server.close();
    await removeTempDirectory(rootDir);
  }
});

test("downloadSnapshotFileForTesting retries from the failed chunk instead of restarting at zero", async () => {
  const goodPayload = Buffer.from("correct-snapshot-payload");
  const badPayload = Buffer.from(goodPayload);
  badPayload[5] = 0x78;
  const requests: string[] = [];
  const rootDir = createTempDirectory("cogcoin-client-bootstrap-retry");
  const server = createServer((request, response) => {
    requests.push(request.headers.range ?? "none");
    const body = requests.length === 1 ? badPayload : goodPayload.subarray(4);
    response.writeHead(request.headers.range ? 206 : 200, {
      "content-length": String(body.length),
    });
    response.end(body);
  });

  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("test_http_server_address_missing");
    }

    const metadata: SnapshotMetadata = {
      url: `http://127.0.0.1:${address.port}/utxo.dat`,
      filename: "utxo.dat",
      height: 456,
      sha256: createHash("sha256").update(goodPayload).digest("hex"),
      sizeBytes: goodPayload.length,
    };
    const manifest = createChunkManifestForPayload(goodPayload, metadata, 4);
    const paths = resolveBootstrapPathsForTesting(rootDir, metadata);
    const state = createBootstrapStateForTesting(metadata);
    const progress = new ManagedProgressController({
      quoteStatePath: paths.quoteStatePath,
      snapshot: metadata,
      progressOutput: "none",
    });

    await progress.start();
    await downloadSnapshotFileForTesting({
      metadata,
      manifest,
      paths,
      progress,
      state,
    });
    await progress.close();

    assert.deepEqual(requests.slice(0, 2), ["none", "bytes=4-"]);
    assert.deepEqual(await readFile(paths.snapshotPath), goodPayload);
    const persisted = await loadBootstrapStateForTesting(paths, metadata);
    assert.equal(persisted.lastError, null);
    assert.equal(persisted.validated, true);
    assert.equal(persisted.verifiedChunkCount, manifest.chunkSha256s.length);
  } finally {
    server.close();
    await removeTempDirectory(rootDir);
  }
});

test("downloadSnapshotFileForTesting scans an untrusted partial file and preserves the last good chunk", async () => {
  const payload = Buffer.from("0123456789ab");
  const corrupted = Buffer.from(payload);
  corrupted[6] = 0x78;
  const requests: string[] = [];
  const rootDir = createTempDirectory("cogcoin-client-bootstrap-scan");
  const server = createServer((request, response) => {
    requests.push(request.headers.range ?? "none");
    const rangeHeader = request.headers.range;
    const start = Number(/^bytes=(\d+)-$/.exec(rangeHeader ?? "")?.[1] ?? 0);
    const body = payload.subarray(start);
    response.writeHead(rangeHeader ? 206 : 200, {
      "content-length": String(body.length),
    });
    response.end(body);
  });

  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("test_http_server_address_missing");
    }

    const metadata: SnapshotMetadata = {
      url: `http://127.0.0.1:${address.port}/utxo.dat`,
      filename: "utxo.dat",
      height: 400,
      sha256: createHash("sha256").update(payload).digest("hex"),
      sizeBytes: payload.length,
    };
    const manifest = createChunkManifestForPayload(payload, metadata, 4);
    const paths = resolveBootstrapPathsForTesting(rootDir, metadata);
    const state = createBootstrapStateForTesting(metadata);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.partialSnapshotPath, corrupted);
    state.downloadedBytes = corrupted.length;
    await saveBootstrapStateForTesting(paths, state);
    const progress = new ManagedProgressController({
      quoteStatePath: paths.quoteStatePath,
      snapshot: metadata,
      progressOutput: "none",
    });

    await progress.start();
    await downloadSnapshotFileForTesting({
      metadata,
      manifest,
      paths,
      progress,
      state,
    });
    await progress.close();

    assert.deepEqual(requests[0], "bytes=4-");
    assert.deepEqual(await readFile(paths.snapshotPath), payload);
    const persisted = await loadBootstrapStateForTesting(paths, metadata);
    assert.equal(persisted.validated, true);
    assert.equal(persisted.verifiedChunkCount, manifest.chunkSha256s.length);
  } finally {
    server.close();
    await removeTempDirectory(rootDir);
  }
});

test("downloadSnapshotFileForTesting upgrades a legacy state file by scanning verified chunks", async () => {
  const payload = Buffer.from("legacy-upgrade");
  const requests: string[] = [];
  const rootDir = createTempDirectory("cogcoin-client-bootstrap-legacy");
  const server = createServer((request, response) => {
    requests.push(request.headers.range ?? "none");
    const rangeHeader = request.headers.range;
    const start = Number(/^bytes=(\d+)-$/.exec(rangeHeader ?? "")?.[1] ?? 0);
    const body = payload.subarray(start);
    response.writeHead(rangeHeader ? 206 : 200, {
      "content-length": String(body.length),
    });
    response.end(body);
  });

  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("test_http_server_address_missing");
    }

    const metadata: SnapshotMetadata = {
      url: `http://127.0.0.1:${address.port}/utxo.dat`,
      filename: "utxo.dat",
      height: 401,
      sha256: createHash("sha256").update(payload).digest("hex"),
      sizeBytes: payload.length,
    };
    const manifest = createChunkManifestForPayload(payload, metadata, 4);
    const paths = resolveBootstrapPathsForTesting(rootDir, metadata);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.partialSnapshotPath, payload.subarray(0, 10));
    await writeFile(paths.statePath, JSON.stringify({
      metadataVersion: 1,
      snapshot: metadata,
      phase: "snapshot_download",
      downloadedBytes: 10,
      validated: false,
      loadTxOutSetComplete: false,
      baseHeight: null,
      tipHashHex: null,
      lastError: null,
      updatedAt: Date.now(),
    }, null, 2));
    const state = await loadBootstrapStateForTesting(paths, metadata);
    const progress = new ManagedProgressController({
      quoteStatePath: paths.quoteStatePath,
      snapshot: metadata,
      progressOutput: "none",
    });

    await progress.start();
    await downloadSnapshotFileForTesting({
      metadata,
      manifest,
      paths,
      progress,
      state,
    });
    await progress.close();

    assert.deepEqual(requests[0], "bytes=8-");
    const persisted = await loadBootstrapStateForTesting(paths, metadata);
    assert.equal(persisted.metadataVersion, 2);
    assert.equal(persisted.integrityVersion, 1);
    assert.equal(persisted.chunkSizeBytes, manifest.chunkSizeBytes);
    assert.equal(persisted.verifiedChunkCount, manifest.chunkSha256s.length);
    assert.equal(persisted.validated, true);
  } finally {
    server.close();
    await removeTempDirectory(rootDir);
  }
});

test("downloadSnapshotFileForTesting preserves the verified prefix when a resumed request gets HTTP 200", async () => {
  const payload = Buffer.from("resume-http-200");
  const requests: string[] = [];
  const rootDir = createTempDirectory("cogcoin-client-bootstrap-http200");

  try {
    const metadata: SnapshotMetadata = {
      url: "https://snapshots.cogcoin.org/utxo.dat",
      filename: "utxo.dat",
      height: 402,
      sha256: createHash("sha256").update(payload).digest("hex"),
      sizeBytes: payload.length,
    };
    const manifest = createChunkManifestForPayload(payload, metadata, 4);
    const paths = resolveBootstrapPathsForTesting(rootDir, metadata);
    const state = createBootstrapStateForTesting(metadata);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.partialSnapshotPath, payload.subarray(0, 4));
    setVerifiedFrontierState(state, manifest, 1);
    await saveBootstrapStateForTesting(paths, state);
    const progress = new ManagedProgressController({
      quoteStatePath: paths.quoteStatePath,
      snapshot: metadata,
      progressOutput: "none",
    });

    await progress.start();
    await downloadSnapshotFileForTesting({
      metadata,
      manifest,
      paths,
      progress,
      state,
      fetchImpl: async (_url, init) => {
        requests.push((init?.headers as Record<string, string> | undefined)?.Range ?? "none");

        if (requests.length === 1) {
          return new Response(payload, {
            status: 200,
            headers: {
              "content-length": String(payload.length),
            },
          });
        }

        return new Response(payload.subarray(4), {
          status: 206,
          headers: {
            "content-length": String(payload.length - 4),
          },
        });
      },
    });
    await progress.close();

    assert.deepEqual(requests.slice(0, 2), ["bytes=4-", "bytes=4-"]);
    assert.deepEqual(await readFile(paths.snapshotPath), payload);
    const persisted = await loadBootstrapStateForTesting(paths, metadata);
    assert.equal(persisted.validated, true);
    assert.equal(persisted.downloadedBytes, payload.length);
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("downloadSnapshotFileForTesting aborts mid-chunk and keeps only the last verified checkpoint", async () => {
  const payload = Buffer.from("abort-checkpoint");
  const rootDir = createTempDirectory("cogcoin-client-bootstrap-abort");

  try {
    const metadata: SnapshotMetadata = {
      url: "https://snapshots.cogcoin.org/utxo.dat",
      filename: "utxo.dat",
      height: 403,
      sha256: createHash("sha256").update(payload).digest("hex"),
      sizeBytes: payload.length,
    };
    const manifest = createChunkManifestForPayload(payload, metadata, 4);
    const paths = resolveBootstrapPathsForTesting(rootDir, metadata);
    const state = createBootstrapStateForTesting(metadata);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.partialSnapshotPath, payload.subarray(0, 4));
    setVerifiedFrontierState(state, manifest, 1);
    await saveBootstrapStateForTesting(paths, state);
    const progress = new ManagedProgressController({
      quoteStatePath: paths.quoteStatePath,
      snapshot: metadata,
      progressOutput: "none",
    });
    const abortController = new AbortController();

    await progress.start();
    const downloadPromise = downloadSnapshotFileForTesting({
      metadata,
      manifest,
      paths,
      progress,
      state,
      signal: abortController.signal,
      fetchImpl: async (_url, init) => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(payload.subarray(4, 6));
          const signal = init?.signal;

          if (signal instanceof AbortSignal) {
            signal.addEventListener("abort", () => {
              controller.error(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          }
        },
      }), {
        status: 206,
        headers: {
          "content-length": String(payload.length - 4),
        },
      }),
    });

    setTimeout(() => {
      abortController.abort(new Error("managed_sync_aborted"));
    }, 25);

    await assert.rejects(downloadPromise, /managed_sync_aborted|AbortError/);
    await progress.close();

    const partialInfo = await stat(paths.partialSnapshotPath);
    assert.equal(partialInfo.size, 4);
    const persisted = await loadBootstrapStateForTesting(paths, metadata);
    assert.equal(persisted.downloadedBytes, 4);
    assert.equal(persisted.verifiedChunkCount, 1);
    assert.equal(persisted.lastError, null);
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("downloadSnapshotFileForTesting surfaces actionable fetch errors before retrying", async () => {
  const payload = Buffer.from("snapshot-after-fetch-retry");
  let requestCount = 0;
  const reportedErrors: string[] = [];
  const rootDir = createTempDirectory("cogcoin-client-bootstrap-fetch-error");

  try {
    const metadata: SnapshotMetadata = {
      url: "https://snapshots.cogcoin.org/utxo.dat",
      filename: "utxo.dat",
      height: 789,
      sha256: createHash("sha256").update(payload).digest("hex"),
      sizeBytes: payload.length,
    };
    const manifest = createChunkManifestForPayload(payload, metadata, 4);
    const paths = resolveBootstrapPathsForTesting(rootDir, metadata);
    const state = createBootstrapStateForTesting(metadata);
    const progress = new ManagedProgressController({
      quoteStatePath: paths.quoteStatePath,
      snapshot: metadata,
      progressOutput: "none",
      onProgress(event) {
        if (event.progress.lastError !== null) {
          reportedErrors.push(event.progress.lastError);
        }
      },
    });

    await progress.start();
    await downloadSnapshotFileForTesting({
      metadata,
      manifest,
      paths,
      progress,
      state,
      fetchImpl: async () => {
        requestCount += 1;

        if (requestCount === 1) {
          throw new TypeError("fetch failed", {
            cause: new Error("getaddrinfo ENOTFOUND snapshots.cogcoin.org"),
          });
        }

        return new Response(payload, {
          status: 200,
          headers: {
            "content-length": String(payload.length),
          },
        });
      },
    });
    await progress.close();

    assert.ok(reportedErrors.some((message) =>
      message.includes("The snapshot download failed from snapshots.cogcoin.org: getaddrinfo ENOTFOUND snapshots.cogcoin.org.")
      && message.includes("Next: Check your internet connection, DNS, firewall, or VPN access to the snapshot host, then rerun sync.")));
    assert.deepEqual(await readFile(paths.snapshotPath), payload);
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("bootstrap state persists resume metadata", async () => {
  const rootDir = createTempDirectory("cogcoin-client-bootstrap-state");

  try {
    const paths = resolveBootstrapPathsForTesting(rootDir);
    const state = createBootstrapStateForTesting();
    const manifest = createChunkManifestForPayload(Buffer.from("state-persist"), {
      url: "https://snapshots.cogcoin.org/state-persist.dat",
      filename: "state-persist.dat",
      height: 910001,
      sha256: createHash("sha256").update(Buffer.from("state-persist")).digest("hex"),
      sizeBytes: Buffer.byteLength("state-persist"),
    }, 4);
    state.phase = "load_snapshot";
    state.integrityVersion = manifest.formatVersion;
    state.chunkSizeBytes = manifest.chunkSizeBytes;
    state.verifiedChunkCount = 2;
    state.downloadedBytes = resolveVerifiedBytes(manifest, 2);
    state.validated = true;
    state.loadTxOutSetComplete = true;
    state.baseHeight = 910_000;
    state.tipHashHex = "aa".repeat(32);
    state.lastError = "temporary";

    await saveBootstrapStateForTesting(paths, state);
    const reloaded = await loadBootstrapStateForTesting(paths);

    assert.equal(reloaded.phase, "load_snapshot");
    assert.equal(reloaded.integrityVersion, 1);
    assert.equal(reloaded.chunkSizeBytes, 4);
    assert.equal(reloaded.verifiedChunkCount, 2);
    assert.equal(reloaded.downloadedBytes, resolveVerifiedBytes(manifest, 2));
    assert.equal(reloaded.validated, true);
    assert.equal(reloaded.loadTxOutSetComplete, true);
    assert.equal(reloaded.baseHeight, 910_000);
    assert.equal(reloaded.tipHashHex, "aa".repeat(32));
    assert.equal(reloaded.lastError, "temporary");
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("WritingQuoteRotator keeps a duplicate-free randomized cycle", async () => {
  const rootDir = createTempDirectory("cogcoin-client-quotes-cycle");

  try {
    const statePath = join(rootDir, "quote-state.json");
    const rotator = await WritingQuoteRotator.create(
      statePath,
      createDeterministicRandom(Array.from({ length: 512 }, (_value, index) => ((index % 7) + 1) / 10)),
    );
    const snapshot = await rotator.getPersistedStateForTesting();
    const { quotes } = await loadWritingQuotesForTesting();

    assert.equal(snapshot.permutation.length, quotes.length);
    assert.equal(new Set(snapshot.permutation).size, quotes.length);
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("writing quote dataset stays focused on writing-related quotes", async () => {
  const { quotes } = await loadWritingQuotesForTesting();
  const quoteTexts = new Set(quotes.map((entry) => entry.quote));

  assert.ok(quotes.every((entry) => entry.author !== "Joseph Stalin"));
  assert.ok(!quoteTexts.has("A single death is a tragedy; a million deaths is a statistic."));
  assert.ok(!quoteTexts.has("The only truth is music."));
  assert.ok(!quoteTexts.has("Not all those who wander are lost."));
  assert.ok(quoteTexts.has("Easy reading is damn hard writing."));
  assert.ok(quoteTexts.has("Omit needless words."));
});

test("WritingQuoteRotator starts with a banner and restarts it on resume", async () => {
  const rootDir = createTempDirectory("cogcoin-client-quotes-banner");

  try {
    const statePath = join(rootDir, "quote-state.json");
    const rotator = await WritingQuoteRotator.create(
      statePath,
      createDeterministicRandom(Array.from({ length: 128 }, (_value, index) => ((index % 5) + 1) / 10)),
    );
    const initial = await rotator.getPersistedStateForTesting();
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as { displayStartedAt: number };

    assert.equal(initial.displayPhase, "banner");
    assert.equal(initial.quoteStartedAt - initial.displayStartedAt, 15_000);
    assert.equal(persisted.displayStartedAt, initial.displayStartedAt);

    const duringBanner = await rotator.current(initial.displayStartedAt + 5_000);
    assert.equal(duringBanner.displayPhase, "banner");
    assert.equal(duringBanner.index, initial.index);

    const resumeStartedAt = Date.now();
    const reopened = await WritingQuoteRotator.create(
      statePath,
      createDeterministicRandom(Array.from({ length: 128 }, (_value, index) => ((index % 5) + 1) / 10)),
    );
    const resumeFinishedAt = Date.now();
    const resumedBanner = await reopened.getPersistedStateForTesting();
    const firstScroll = await reopened.current(resumedBanner.displayStartedAt + 15_000);

    assert.equal(resumedBanner.displayPhase, "banner");
    assert.ok(resumedBanner.displayStartedAt >= resumeStartedAt);
    assert.ok(resumedBanner.displayStartedAt <= resumeFinishedAt);
    assert.equal(resumedBanner.quoteStartedAt - resumedBanner.displayStartedAt, 15_000);
    assert.equal(resumedBanner.index, initial.index);
    assert.equal(firstScroll.displayPhase, "scroll");
    assert.equal(firstScroll.index, initial.index);
    assert.deepEqual(firstScroll.currentQuote, initial.currentQuote);
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("WritingQuoteRotator persists quote position and reshuffles only after a full cycle", async () => {
  const rootDir = createTempDirectory("cogcoin-client-quotes-persist");

  try {
    const statePath = join(rootDir, "quote-state.json");
    const { quotes } = await loadWritingQuotesForTesting();
    const randomValues = [
      ...Array.from({ length: quotes.length }, () => 0.0),
      ...Array.from({ length: quotes.length }, () => 0.99),
    ];
    const rotator = await WritingQuoteRotator.create(statePath, createDeterministicRandom(randomValues));
    const initial = await rotator.getPersistedStateForTesting();
    const baseTime = initial.quoteStartedAt;
    const progressed = await rotator.current(baseTime + 14_000);

    const reopened = await WritingQuoteRotator.create(statePath, createDeterministicRandom(randomValues));
    const reopenedSnapshot = await reopened.getPersistedStateForTesting();
    const firstVisibleAfterResume = await reopened.current(reopenedSnapshot.displayStartedAt + 15_000);
    assert.equal(reopenedSnapshot.displayPhase, "banner");
    assert.equal(reopenedSnapshot.index, progressed.index);
    assert.deepEqual(reopenedSnapshot.currentQuote, progressed.currentQuote);
    assert.equal(firstVisibleAfterResume.displayPhase, "scroll");
    assert.equal(firstVisibleAfterResume.index, progressed.index);
    assert.deepEqual(firstVisibleAfterResume.currentQuote, progressed.currentQuote);

    const rollover = await reopened.current(
      reopenedSnapshot.quoteStartedAt + (quotes.length * 7_000) + 7_000,
    );
    assert.ok(rollover.completedCycles >= 1);
    assert.equal(new Set(rollover.permutation).size, quotes.length);
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("WritingQuoteRotator migrates legacy state and replays the banner on resume", async () => {
  const rootDir = createTempDirectory("cogcoin-client-quotes-legacy");

  try {
    const statePath = join(rootDir, "quote-state.json");
    const now = Date.now();
    const legacyQuoteStartedAt = now - 5_000;
    const { datasetHash, quotes } = await loadWritingQuotesForTesting();

    await writeFile(statePath, JSON.stringify({
      datasetHash,
      permutation: createIdentityPermutation(quotes.length),
      index: 0,
      quoteStartedAt: legacyQuoteStartedAt,
      completedCycles: 0,
      updatedAt: now,
    }, null, 2));

    const resumeStartedAt = Date.now();
    const rotator = await WritingQuoteRotator.create(statePath, createDeterministicRandom([0.5]));
    const resumeFinishedAt = Date.now();
    const snapshot = await rotator.getPersistedStateForTesting();
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      displayStartedAt: number;
      quoteStartedAt: number;
    };

    assert.equal(snapshot.displayPhase, "banner");
    assert.ok(snapshot.displayStartedAt >= resumeStartedAt);
    assert.ok(snapshot.displayStartedAt <= resumeFinishedAt);
    assert.equal(snapshot.quoteStartedAt - snapshot.displayStartedAt, 15_000);
    assert.equal(persisted.displayStartedAt, snapshot.displayStartedAt);
    assert.equal(persisted.quoteStartedAt, snapshot.quoteStartedAt);
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("ManagedProgressController hides the quote during the banner window, including on resume", async () => {
  const rootDir = createTempDirectory("cogcoin-client-progress-banner");

  try {
    const { datasetHash, quotes } = await loadWritingQuotesForTesting();
    const statePath = join(rootDir, "quote-state.json");
    const now = Date.now();
    const baseState = {
      datasetHash,
      permutation: createIdentityPermutation(quotes.length),
      index: 0,
      completedCycles: 0,
      updatedAt: now,
    };

    await writeFile(statePath, JSON.stringify({
      ...baseState,
      displayStartedAt: now - 1_000,
      quoteStartedAt: now + 9_000,
    }, null, 2));

    const bannerProgress = new ManagedProgressController({
      quoteStatePath: statePath,
      snapshot: DEFAULT_SNAPSHOT_METADATA,
      progressOutput: "none",
    });
    await bannerProgress.start();
    assert.equal(bannerProgress.getStatusSnapshot().currentQuote, null);
    await bannerProgress.close();

    await writeFile(statePath, JSON.stringify({
      ...baseState,
      displayStartedAt: now - 11_000,
      quoteStartedAt: now - 1_000,
    }, null, 2));

    const scrollProgress = new ManagedProgressController({
      quoteStatePath: statePath,
      snapshot: DEFAULT_SNAPSHOT_METADATA,
      progressOutput: "none",
    });
    await scrollProgress.start();
    assert.equal(scrollProgress.getStatusSnapshot().currentQuote, null);
    await scrollProgress.close();
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("waitForHeaders turns a no-peer stall into an actionable error", async () => {
  let currentNow = 0;
  const messages: string[] = [];

  await assert.rejects(
    () => waitForHeadersForTesting(
      {
        async getBlockchainInfo() {
          return {
            chain: "main",
            blocks: 0,
            headers: 0,
            bestblockhash: "00".repeat(32),
            pruned: false,
          };
        },
        async getNetworkInfo() {
          return {
            networkactive: true,
            connections: 0,
            connections_in: 0,
            connections_out: 0,
          };
        },
      },
      DEFAULT_SNAPSHOT_METADATA,
      {
        async setPhase(_phase, patch = {}) {
          messages.push(patch.message ?? "");
        },
      },
      {
        now: () => currentNow,
        sleep: async () => {
          currentNow += 30_000;
        },
        noPeerTimeoutMs: 60_000,
      },
    ),
    /No Bitcoin peers were available for header sync\./,
  );

  assert.equal(
    messages.at(-1),
    "Waiting for Bitcoin peers before downloading headers (0 peers; check internet/firewall).",
  );
});

test("waitForHeaders uses debug.log header progress when RPC headers lag", async () => {
  const messages: string[] = [];
  const headersSeen: Array<number | null | undefined> = [];
  let infoCalls = 0;

  await waitForHeadersForTesting(
    {
      async getBlockchainInfo() {
        infoCalls += 1;

        return {
          chain: "main",
          blocks: infoCalls === 1 ? 0 : DEFAULT_SNAPSHOT_METADATA.height,
          headers: infoCalls === 1 ? 0 : DEFAULT_SNAPSHOT_METADATA.height,
          bestblockhash: "22".repeat(32),
          pruned: false,
        };
      },
      async getNetworkInfo() {
        return {
          networkactive: true,
          connections: 8,
          connections_in: 0,
          connections_out: 8,
        };
      },
    },
    DEFAULT_SNAPSHOT_METADATA,
    {
      async setPhase(_phase, patch = {}) {
        messages.push(patch.message ?? "");
        headersSeen.push(patch.headers);
      },
    },
    {
      sleep: async () => {},
      debugLogPath: "/tmp/cogcoin-debug.log",
      async readDebugLogProgress() {
        return {
          height: 88_000,
          message: "Pre-synchronizing blockheaders, height: 88,000 (~9.67%)",
        };
      },
    },
  );

  assert.equal(headersSeen[0], 88_000);
  assert.equal(messages[0], "Pre-synchronizing blockheaders, height: 88,000 (~9.67%)");
  assert.equal(messages.at(-1), "Waiting for Bitcoin headers to reach the snapshot height.");
});

test("waitForHeaders ignores debug.log progress as soon as RPC headers become positive", async () => {
  const messages: string[] = [];
  const headersSeen: Array<number | null | undefined> = [];
  let debugLogReads = 0;

  await waitForHeadersForTesting(
    {
      async getBlockchainInfo() {
        return {
          chain: "main",
          blocks: DEFAULT_SNAPSHOT_METADATA.height,
          headers: DEFAULT_SNAPSHOT_METADATA.height,
          bestblockhash: "33".repeat(32),
          pruned: false,
        };
      },
      async getNetworkInfo() {
        return {
          networkactive: true,
          connections: 8,
          connections_in: 0,
          connections_out: 8,
        };
      },
    },
    DEFAULT_SNAPSHOT_METADATA,
    {
      async setPhase(_phase, patch = {}) {
        messages.push(patch.message ?? "");
        headersSeen.push(patch.headers);
      },
    },
    {
      sleep: async () => {},
      debugLogPath: "/tmp/cogcoin-debug.log",
      async readDebugLogProgress() {
        debugLogReads += 1;
        return {
          height: 88_000,
          message: "Pre-synchronizing blockheaders, height: 88,000 (~9.67%)",
        };
      },
    },
  );

  assert.equal(debugLogReads, 0);
  assert.equal(headersSeen[0], DEFAULT_SNAPSHOT_METADATA.height);
  assert.equal(messages[0], "Waiting for Bitcoin headers to reach the snapshot height.");
});

test("waitForHeaders retries transient managed RPC outages and resumes polling", async () => {
  const messages: string[] = [];
  const lastErrors: Array<string | null | undefined> = [];
  let infoCalls = 0;

  await waitForHeadersForTesting(
    {
      async getBlockchainInfo() {
        infoCalls += 1;

        if (infoCalls === 1) {
          throw new Error(
            "The managed Bitcoin RPC request to 127.0.0.1:8332 for getblockchaininfo failed: The operation was aborted due to timeout.",
          );
        }

        return {
          chain: "main",
          blocks: DEFAULT_SNAPSHOT_METADATA.height,
          headers: DEFAULT_SNAPSHOT_METADATA.height,
          bestblockhash: "11".repeat(32),
          pruned: false,
        };
      },
      async getNetworkInfo() {
        return {
          networkactive: true,
          connections: 8,
          connections_in: 0,
          connections_out: 8,
        };
      },
    },
    DEFAULT_SNAPSHOT_METADATA,
    {
      async setPhase(_phase, patch = {}) {
        messages.push(patch.message ?? "");
        lastErrors.push(patch.lastError);
      },
    },
    {
      sleep: async () => {},
    },
  );

  assert.equal(messages[0], MANAGED_RPC_RETRY_MESSAGE);
  assert.match(lastErrors[0] ?? "", /getblockchaininfo failed/);
  assert.equal(messages.at(-1), "Waiting for Bitcoin headers to reach the snapshot height.");
  assert.equal(lastErrors.at(-1), null);
});

test("bootstrap recovers when loadtxoutset times out after the snapshot finished loading", async () => {
  const rootDir = createTempDirectory("cogcoin-client-bootstrap-loadtxoutset-retry");

  try {
    const payload = Buffer.from("bootstrap-loadtxoutset-timeout");
    const metadata: SnapshotMetadata = {
      url: "https://snapshots.cogcoin.org/bootstrap-loadtxoutset-timeout.dat",
      filename: "bootstrap-loadtxoutset-timeout.dat",
      height: 12,
      sha256: createHash("sha256").update(payload).digest("hex"),
      sizeBytes: payload.length,
    };
    const manifest = createChunkManifestForPayload(payload, metadata);
    const paths = resolveBootstrapPathsForTesting(rootDir, metadata);
    const initialState = createBootstrapStateForTesting(metadata);
    initialState.validated = true;
    initialState.downloadedBytes = payload.length;
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.snapshotPath, payload);
    await saveBootstrapStateForTesting(paths, initialState);

    let chainStateProbeCount = 0;
    let loadCalls = 0;
    const controller = new AssumeUtxoBootstrapController({
      rpc: {
        async getChainStates() {
          chainStateProbeCount += 1;

          if (chainStateProbeCount === 1) {
            return { chainstates: [] };
          }

          return {
            chainstates: [{
              blocks: metadata.height,
              validated: false,
              snapshot_blockhash: "ab".repeat(32),
            }],
          };
        },
        async getBlockchainInfo() {
          return {
            chain: "main",
            blocks: metadata.height,
            headers: metadata.height,
            bestblockhash: "cd".repeat(32),
            pruned: false,
          };
        },
        async getNetworkInfo() {
          return {
            networkactive: true,
            connections: 8,
            connections_in: 0,
            connections_out: 8,
          };
        },
        async loadTxOutSet() {
          loadCalls += 1;
          throw new Error(
            "The managed Bitcoin RPC request to 127.0.0.1:8332 for loadtxoutset failed: The operation was aborted due to timeout.",
          );
        },
      } as unknown as ConstructorParameters<typeof AssumeUtxoBootstrapController>[0]["rpc"],
      dataDir: rootDir,
      progress: {
        async setPhase() {},
      } as unknown as ConstructorParameters<typeof AssumeUtxoBootstrapController>[0]["progress"],
      snapshot: metadata,
      manifest,
    });

    await controller.ensureReady(null, "main");
    const recoveredState = await controller.getStateForTesting();

    assert.equal(loadCalls, 1);
    assert.equal(recoveredState.loadTxOutSetComplete, true);
    assert.equal(recoveredState.baseHeight, metadata.height);
    assert.equal(recoveredState.tipHashHex, "ab".repeat(32));
    assert.equal(recoveredState.lastError, null);
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("bootstrap resume keeps sync mode out of follow_tip when an indexed tip already exists", async () => {
  const rootDir = createTempDirectory("cogcoin-client-bootstrap-resume-sync");

  try {
    const phases: string[] = [];
    const controller = new AssumeUtxoBootstrapController({
      rpc: {} as ConstructorParameters<typeof AssumeUtxoBootstrapController>[0]["rpc"],
      dataDir: rootDir,
      progress: {
        async setPhase(phase: BootstrapPhase) {
          phases.push(phase);
        },
      } as unknown as ConstructorParameters<typeof AssumeUtxoBootstrapController>[0]["progress"],
      snapshot: DEFAULT_SNAPSHOT_METADATA,
    });

    await controller.ensureReady({
      height: 910_000,
      blockHashHex: "aa".repeat(32),
      previousHashHex: "bb".repeat(32),
      stateHashHex: null,
    }, "main", {
      resumeDisplayMode: "sync",
    });

    assert.deepEqual(phases, []);
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("bootstrap resume still enters follow_tip when follow mode resumes an indexed tip", async () => {
  const rootDir = createTempDirectory("cogcoin-client-bootstrap-resume-follow");

  try {
    const phases: string[] = [];
    const messages: string[] = [];
    const controller = new AssumeUtxoBootstrapController({
      rpc: {} as ConstructorParameters<typeof AssumeUtxoBootstrapController>[0]["rpc"],
      dataDir: rootDir,
      progress: {
        async setPhase(phase: BootstrapPhase, patch: { message?: string } = {}) {
          phases.push(phase);
          messages.push(patch.message ?? "");
        },
      } as unknown as ConstructorParameters<typeof AssumeUtxoBootstrapController>[0]["progress"],
      snapshot: DEFAULT_SNAPSHOT_METADATA,
    });

    await controller.ensureReady({
      height: 910_000,
      blockHashHex: "aa".repeat(32),
      previousHashHex: "bb".repeat(32),
      stateHashHex: null,
    }, "main", {
      resumeDisplayMode: "follow",
    });

    assert.deepEqual(phases, ["follow_tip"]);
    assert.deepEqual(messages, ["Resuming from the persisted Cogcoin indexed tip."]);
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("bootstrap startup cleans obsolete snapshot artifacts and skips loadtxoutset", async () => {
  const rootDir = createTempDirectory("cogcoin-client-bootstrap-cleanup-obsolete");

  try {
    const payload = Buffer.from("bootstrap-cleanup-obsolete");
    const metadata: SnapshotMetadata = {
      url: "https://snapshots.cogcoin.org/bootstrap-cleanup-obsolete.dat",
      filename: "bootstrap-cleanup-obsolete.dat",
      height: 24,
      sha256: createHash("sha256").update(payload).digest("hex"),
      sizeBytes: payload.length,
    };
    const paths = resolveBootstrapPathsForTesting(rootDir, metadata);
    const state = createBootstrapStateForTesting(metadata);
    state.loadTxOutSetComplete = true;
    state.baseHeight = metadata.height;
    state.tipHashHex = "ab".repeat(32);
    state.phase = "load_snapshot";
    state.lastError = "stale error";
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.snapshotPath, payload);
    await writeFile(paths.partialSnapshotPath, `${payload.toString("hex")}\n`);
    await saveBootstrapStateForTesting(paths, state);

    const phases: BootstrapPhase[] = [];
    let loadCalls = 0;
    const controller = new AssumeUtxoBootstrapController({
      rpc: {
        async getChainStates() {
          return { chainstates: [] };
        },
        async getBlockchainInfo() {
          return {
            chain: "main",
            blocks: 30,
            headers: 35,
            bestblockhash: "cd".repeat(32),
            pruned: false,
          };
        },
        async loadTxOutSet() {
          loadCalls += 1;
          return {
            base_height: metadata.height,
            coins_loaded: 0,
            tip_hash: "ab".repeat(32),
          };
        },
      } as unknown as ConstructorParameters<typeof AssumeUtxoBootstrapController>[0]["rpc"],
      dataDir: rootDir,
      progress: {
        async setPhase(phase: BootstrapPhase) {
          phases.push(phase);
        },
      } as unknown as ConstructorParameters<typeof AssumeUtxoBootstrapController>[0]["progress"],
      snapshot: metadata,
      fetchImpl: async () => {
        throw new Error("snapshot download should not run");
      },
    });

    await controller.ensureReady(null, "main");
    const persisted = await loadBootstrapStateForTesting(paths, metadata);

    assert.equal(loadCalls, 0);
    assert.deepEqual(phases, ["bitcoin_sync"]);
    assert.equal(await pathExists(paths.snapshotPath), false);
    assert.equal(await pathExists(paths.partialSnapshotPath), false);
    assert.equal(persisted.loadTxOutSetComplete, true);
    assert.equal(persisted.phase, "bitcoin_sync");
    assert.equal(persisted.lastError, null);
    assert.equal(await pathExists(paths.statePath), true);
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("bootstrap startup keeps the snapshot file while the snapshot chainstate remains active", async () => {
  const rootDir = createTempDirectory("cogcoin-client-bootstrap-cleanup-active");

  try {
    const payload = Buffer.from("bootstrap-cleanup-active");
    const metadata: SnapshotMetadata = {
      url: "https://snapshots.cogcoin.org/bootstrap-cleanup-active.dat",
      filename: "bootstrap-cleanup-active.dat",
      height: 28,
      sha256: createHash("sha256").update(payload).digest("hex"),
      sizeBytes: payload.length,
    };
    const paths = resolveBootstrapPathsForTesting(rootDir, metadata);
    const state = createBootstrapStateForTesting(metadata);
    state.loadTxOutSetComplete = true;
    state.validated = true;
    state.downloadedBytes = payload.length;
    state.baseHeight = metadata.height;
    state.tipHashHex = "ef".repeat(32);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.snapshotPath, payload);
    await writeFile(paths.partialSnapshotPath, `${payload.toString("hex")}\n`);
    await saveBootstrapStateForTesting(paths, state);

    let loadCalls = 0;
    const controller = new AssumeUtxoBootstrapController({
      rpc: {
        async getChainStates() {
          return {
            chainstates: [{
              blocks: metadata.height,
              validated: false,
              snapshot_blockhash: "ef".repeat(32),
            }],
          };
        },
        async loadTxOutSet() {
          loadCalls += 1;
          return {
            base_height: metadata.height,
            coins_loaded: 0,
            tip_hash: "ef".repeat(32),
          };
        },
      } as unknown as ConstructorParameters<typeof AssumeUtxoBootstrapController>[0]["rpc"],
      dataDir: rootDir,
      progress: {
        async setPhase() {},
      } as unknown as ConstructorParameters<typeof AssumeUtxoBootstrapController>[0]["progress"],
      snapshot: metadata,
    });

    await controller.ensureReady(null, "main");

    assert.equal(loadCalls, 0);
    assert.equal(await pathExists(paths.snapshotPath), true);
    assert.equal(await pathExists(paths.partialSnapshotPath), true);
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("bootstrap startup skip-path avoids both download and loadtxoutset once the snapshot is obsolete", async () => {
  const rootDir = createTempDirectory("cogcoin-client-bootstrap-skip-obsolete");

  try {
    const payload = Buffer.from("bootstrap-skip-obsolete");
    const metadata: SnapshotMetadata = {
      url: "https://snapshots.cogcoin.org/bootstrap-skip-obsolete.dat",
      filename: "bootstrap-skip-obsolete.dat",
      height: 32,
      sha256: createHash("sha256").update(payload).digest("hex"),
      sizeBytes: payload.length,
    };
    const paths = resolveBootstrapPathsForTesting(rootDir, metadata);
    const state = createBootstrapStateForTesting(metadata);
    state.loadTxOutSetComplete = true;
    state.baseHeight = metadata.height;
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.snapshotPath, payload);
    await saveBootstrapStateForTesting(paths, state);

    let fetchCalls = 0;
    let loadCalls = 0;
    const controller = new AssumeUtxoBootstrapController({
      rpc: {
        async getChainStates() {
          return { chainstates: [] };
        },
        async getBlockchainInfo() {
          return {
            chain: "main",
            blocks: 40,
            headers: 42,
            bestblockhash: "12".repeat(32),
            pruned: false,
          };
        },
        async loadTxOutSet() {
          loadCalls += 1;
          return {
            base_height: metadata.height,
            coins_loaded: 0,
            tip_hash: "00".repeat(32),
          };
        },
      } as unknown as ConstructorParameters<typeof AssumeUtxoBootstrapController>[0]["rpc"],
      dataDir: rootDir,
      progress: {
        async setPhase() {},
      } as unknown as ConstructorParameters<typeof AssumeUtxoBootstrapController>[0]["progress"],
      snapshot: metadata,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("fetch should not run");
      },
    });

    await controller.ensureReady(null, "main");

    assert.equal(fetchCalls, 0);
    assert.equal(loadCalls, 0);
  } finally {
    await removeTempDirectory(rootDir);
  }
});

test("intro scene starts as an empty scroll frame before the train enters", () => {
  const progress = createBootstrapProgressForTesting("snapshot_download", DEFAULT_SNAPSHOT_METADATA);
  const statusField = resolveStatusFieldTextForTesting(progress, DEFAULT_SNAPSHOT_METADATA.height);
  const frame = renderIntroFrameForTesting(0, statusField);

  assert.deepEqual(extractScrollWindow(frame), extractScrollWindow(loadScrollArtForTesting()));
  assertCenteredField(frame, 2, resolveIntroMessageForTesting(0));
  assertCenteredField(frame, 13, statusField);
});

test("intro scene enters from the right with smoke art", () => {
  const enteringFrame = renderIntroFrameForTesting(
    2_500,
    resolveStatusFieldTextForTesting(
      createBootstrapProgressForTesting("snapshot_download", DEFAULT_SNAPSHOT_METADATA),
      DEFAULT_SNAPSHOT_METADATA.height,
    ),
  );
  const bounds = findSpriteBounds(enteringFrame);

  assert.ok(Number.isFinite(bounds.minColumn));
  assert.ok(bounds.minColumn >= 33);
  assert.ok(bounds.maxColumn <= 64);
  assertCenteredField(enteringFrame, 2, resolveIntroMessageForTesting(2_500));
});

test("train clip extends one extra character on both scroll edges", () => {
  const statusField = resolveStatusFieldTextForTesting(
    createBootstrapProgressForTesting("bitcoin_sync", DEFAULT_SNAPSHOT_METADATA),
    DEFAULT_SNAPSHOT_METADATA.height,
  );
  const nearCenterEntry = extractTrainClipWindow(renderIntroFrameForTesting(4_900, statusField));
  const earlyExit = extractTrainClipWindow(renderIntroFrameForTesting(10_150, statusField));

  assert.ok(nearCenterEntry.some((line) => line[66] !== " "));
  assert.ok(earlyExit.some((line) => line[0] !== " "));
});

test("intro scene centers stationary train art during the pause", () => {
  const statusField = resolveStatusFieldTextForTesting(
    createBootstrapProgressForTesting("bitcoin_sync", DEFAULT_SNAPSHOT_METADATA),
    DEFAULT_SNAPSHOT_METADATA.height,
  );
  const centeredAtPauseStart = renderIntroFrameForTesting(5_000, statusField);
  const centeredMidPause = renderIntroFrameForTesting(7_500, statusField);
  const train = loadTrainArtForTesting();

  assertCenteredSprite(centeredAtPauseStart, train);
  assert.deepEqual(centeredMidPause, centeredAtPauseStart);
  assertCenteredField(centeredAtPauseStart, 2, resolveIntroMessageForTesting(5_000));
  assertCenteredField(centeredAtPauseStart, 13, statusField);
});

test("intro scene uses smoke art again while exiting left", () => {
  const statusField = resolveStatusFieldTextForTesting(
    createBootstrapProgressForTesting("cogcoin_sync", DEFAULT_SNAPSHOT_METADATA),
    DEFAULT_SNAPSHOT_METADATA.height,
  );
  const exitStart = renderIntroFrameForTesting(10_000, statusField);
  const trainSmoke = loadTrainSmokeArtForTesting();

  assertCenteredSprite(exitStart, trainSmoke);
  assert.notDeepEqual(renderIntroFrameForTesting(12_500, statusField), exitStart);
  assertCenteredField(exitStart, 2, resolveIntroMessageForTesting(10_000));
  assertCenteredField(exitStart, 13, statusField);
});

test("intro scene hands off to quotes after 15 seconds", () => {
  const statusField = resolveStatusFieldTextForTesting(
    createBootstrapProgressForTesting("bitcoin_sync", DEFAULT_SNAPSHOT_METADATA),
    DEFAULT_SNAPSHOT_METADATA.height,
  );
  const frame = renderIntroFrameForTesting(15_000, statusField);

  assert.deepEqual(extractScrollWindow(frame), extractScrollWindow(loadScrollArtForTesting()));
  assert.equal(extractField(frame, 2).trim(), "⛭  C O G C O I N  ⛭");
  assertCenteredField(frame, 13, statusField);
});

test("completion scene freezes on the centered pause frame after entry", () => {
  const entryFrame = renderCompletionFrameForTesting(0);
  const pauseFrame = renderCompletionFrameForTesting(5_000);
  const finalFrame = renderCompletionFrameForTesting(10_000);
  const postTotalFrame = renderCompletionFrameForTesting(15_000);
  const train = loadTrainArtForTesting();

  assertCenteredField(entryFrame, 2, resolveCompletionMessageForTesting(0));
  assertCenteredField(pauseFrame, 2, resolveCompletionMessageForTesting(5_000));
  assertCenteredField(finalFrame, 2, resolveCompletionMessageForTesting(10_000));
  assertCenteredField(postTotalFrame, 2, resolveCompletionMessageForTesting(15_000));
  assertCenteredSprite(pauseFrame, train);
  assertCenteredSprite(finalFrame, train);
  assertCenteredSprite(postTotalFrame, train);
  assert.equal(extractField(entryFrame, 13).trim(), "");
  assert.equal(extractField(pauseFrame, 13).trim(), "");
  assert.equal(extractField(finalFrame, 13).trim(), "");
  assert.equal(extractField(postTotalFrame, 13).trim(), "");
  assert.equal(resolveCompletionMessageForTesting(10_000), "You shape your own future.");
  assert.equal(resolveCompletionMessageForTesting(15_000), "You shape your own future.");
});

test("follow scene starts as a plain scroll frame instead of the intro animation", () => {
  const progress = createBootstrapProgressForTesting("bitcoin_sync", DEFAULT_SNAPSHOT_METADATA);
  const statusField = resolveStatusFieldTextForTesting(progress, DEFAULT_SNAPSHOT_METADATA.height, 0);
  const state = createFollowSceneStateForTesting();
  const frame = renderFollowFrameForTesting(state, statusField, 0);

  assert.equal(frame[0], loadScrollArtForTesting()[0]);
  assert.deepEqual(extractFollowWindow(frame), extractFollowWindow(loadScrollArtForTesting()));
  assert.equal(extractField(frame, 2).trim(), "⛭  C O G C O I N  ⛭");
  assertCenteredField(frame, 13, statusField);
});

test("follow scene renders split mining balance lanes around the centered title", () => {
  const frame = renderFollowFrameForTesting(
    createFollowSceneStateForTesting(),
    "Waiting for next block to be mined...",
    0,
    {
      artworkCogText: "0.1 COG",
      artworkSatText: "150000 SAT",
    },
  );
  const lanes = extractFollowBalanceLanes(frame);

  assert.equal(lanes.cog.trim(), "0.1 COG");
  assert.equal(lanes.title, "⛭  C O G C O I N  ⛭");
  assert.equal(lanes.sat.trim(), "150000 SAT");
});

test("follow scene truncates mining balance lanes without overwriting the centered title", () => {
  const frame = renderFollowFrameForTesting(
    createFollowSceneStateForTesting(),
    "Waiting for next block to be mined...",
    0,
    {
      artworkCogText: "123456789012345678901234 COG",
      artworkSatText: "123456789012345678901234 SAT",
    },
  );
  const lanes = extractFollowBalanceLanes(frame);

  assert.equal(lanes.cog.length, 22);
  assert.equal(lanes.title, "⛭  C O G C O I N  ⛭");
  assert.equal(lanes.sat.length, 23);
  assert.notEqual(lanes.cog.trim(), "123456789012345678901234 COG");
  assert.notEqual(lanes.sat.trim(), "123456789012345678901234 SAT");
});

test("follow scene leaves missing mining balance lanes blank while keeping the centered title", () => {
  const cogOnlyFrame = renderFollowFrameForTesting(
    createFollowSceneStateForTesting(),
    "Waiting for next block to be mined...",
    0,
    {
      artworkCogText: "1.2345 COG",
      artworkSatText: null,
    },
  );
  const satOnlyFrame = renderFollowFrameForTesting(
    createFollowSceneStateForTesting(),
    "Waiting for next block to be mined...",
    0,
    {
      artworkCogText: null,
      artworkSatText: "42 SAT",
    },
  );
  const emptyFrame = renderFollowFrameForTesting(
    createFollowSceneStateForTesting(),
    "Waiting for next block to be mined...",
    0,
    {
      artworkCogText: null,
      artworkSatText: null,
    },
  );

  assert.equal(extractFollowBalanceLanes(cogOnlyFrame).cog.trim(), "1.2345 COG");
  assert.equal(extractFollowBalanceLanes(cogOnlyFrame).sat.trim(), "");
  assert.equal(extractFollowBalanceLanes(cogOnlyFrame).title, "⛭  C O G C O I N  ⛭");

  assert.equal(extractFollowBalanceLanes(satOnlyFrame).cog.trim(), "");
  assert.equal(extractFollowBalanceLanes(satOnlyFrame).sat.trim(), "42 SAT");
  assert.equal(extractFollowBalanceLanes(satOnlyFrame).title, "⛭  C O G C O I N  ⛭");

  assert.equal(extractField(emptyFrame, 2).trim(), "⛭  C O G C O I N  ⛭");
});

test("follow scene renders a lower-right mining version beside the status text", () => {
  const statusText = "Waiting for next block";
  const frame = renderFollowFrameForTesting(
    createFollowSceneStateForTesting(),
    statusText,
    0,
    {
      artworkStatusRightText: "v1.1.10",
    },
  );
  const field = extractField(frame, 13);

  assert.match(field, /Waiting for next block\s{2,}v1\.1\.10$/);
  assert.equal(field.indexOf(statusText), Math.floor((64 - statusText.length) / 2));
});

test("follow scene renders an UPDATE badge on the left while keeping semver on the right", () => {
  const statusText = "Waiting for next block";
  const frame = renderFollowFrameForTesting(
    createFollowSceneStateForTesting(),
    statusText,
    0,
    {
      artworkStatusLeftText: "UPDATE",
      artworkStatusRightText: "v1.1.10",
    },
  );
  const field = extractField(frame, 13);

  assert.match(field, /^UPDATE\s{2,}.*Waiting for next block.*\s{2,}v1\.1\.10$/);
  assert.equal(field.indexOf(statusText), Math.floor((64 - statusText.length) / 2));
});

test("follow scene animates the pending placeholder car in from the left", () => {
  const state = createFollowSceneStateForTesting(910_000);

  syncFollowSceneStateForTesting(state, {
    indexedHeight: 910_000,
    nodeHeight: 910_000,
    liveActivated: true,
  });
  advanceFollowSceneStateForTesting(state, 0);

  const frame = renderFollowFrameForTesting(state, "Syncing Cogcoin Blocks...", 1_000);
  const window = extractFollowWindow(frame);
  const bounds = findFollowSpriteBounds(frame);

  assert.equal(window[2]?.indexOf("910000"), 30);
  assert.equal(window[2]?.includes("~10 min"), false);
  assert.equal(window[5]?.indexOf("~10 min"), 1);
  assert.equal(bounds.minColumn, 0);
  assert.ok(window.some((line) => line[0] !== " "));
  assert.equal(extractField(frame, 2).trim(), "⛭  C O G C O I N  ⛭");
});

test("follow scene moves a newly detected block toward the convoy in 3 seconds, connects flush, and then shifts it into the middle", () => {
  const state = createFollowSceneStateForTesting(910_000);

  syncFollowSceneStateForTesting(state, {
    indexedHeight: 910_000,
    nodeHeight: 910_000,
    liveActivated: true,
  });
  advanceFollowSceneStateForTesting(state, 0);
  advanceFollowSceneStateForTesting(state, 1_000);
  syncFollowSceneStateForTesting(state, {
    nodeHeight: 910_001,
    liveActivated: true,
  });
  advanceFollowSceneStateForTesting(state, 1_000);

  const approachFrame = renderFollowFrameForTesting(state, "Syncing Cogcoin Blocks...", 2_500);
  const approachWindow = extractFollowWindow(approachFrame);

  assert.equal(approachWindow[2]?.indexOf("910000"), 30);
  assert.ok((approachWindow[2]?.indexOf("910001") ?? -1) > 0);
  assert.ok((approachWindow[2]?.indexOf("910001") ?? -1) < 30);

  advanceFollowSceneStateForTesting(state, 4_000);
  const flushFrame = renderFollowFrameForTesting(state, "Syncing Cogcoin Blocks...", 4_000);
  const flushWindow = extractFollowWindow(flushFrame);

  assert.equal((flushWindow[2]?.indexOf("910000") ?? -1) - (flushWindow[2]?.indexOf("910001") ?? -1), 8);

  const shiftFrame = renderFollowFrameForTesting(state, "Syncing Cogcoin Blocks...", 4_500);
  const shiftWindow = extractFollowWindow(shiftFrame);

  assert.ok((shiftWindow[2]?.indexOf("910001") ?? -1) > 21);
  assert.ok((shiftWindow[2]?.indexOf("910000") ?? -1) > 30);

  advanceFollowSceneStateForTesting(state, 5_000);
  const settledFrame = renderFollowFrameForTesting(state, "Syncing Cogcoin Blocks...", 5_500);
  const settledWindow = extractFollowWindow(settledFrame);
  const settledBounds = findFollowSpriteBounds(settledFrame);

  assert.equal(state.displayedCenterHeight, 910_001);
  assert.equal(settledWindow[2]?.indexOf("910001"), 30);
  assert.equal(settledBounds.maxColumn, 67);
  assert.ok(settledWindow.some((line) => line[67] !== " "));
});

test("follow scene accelerates catch-up animation when the displayed convoy is more than two blocks behind the Bitcoin tip", () => {
  const state = createFollowSceneStateForTesting(910_000);

  syncFollowSceneStateForTesting(state, {
    indexedHeight: 910_000,
    nodeHeight: 910_000,
    liveActivated: true,
  });
  advanceFollowSceneStateForTesting(state, 0);
  advanceFollowSceneStateForTesting(state, 1_000);
  syncFollowSceneStateForTesting(state, {
    nodeHeight: 910_003,
    liveActivated: true,
  });
  advanceFollowSceneStateForTesting(state, 1_000);

  assert.equal(state.animation?.kind, "tip_approach");
  assert.equal(state.animation?.durationMs, 1_000);
  assert.equal(state.animation?.height, 910_001);

  const fastApproachFrame = renderFollowFrameForTesting(state, "Syncing Cogcoin Blocks...", 1_500);
  const fastApproachWindow = extractFollowWindow(fastApproachFrame);

  assert.ok((fastApproachWindow[2]?.indexOf("910001") ?? -1) > 0);
  assert.ok((fastApproachWindow[2]?.indexOf("910001") ?? -1) < 30);

  advanceFollowSceneStateForTesting(state, 2_000);

  assert.equal(state.animation?.kind, "convoy_shift");
  assert.equal(state.animation?.durationMs, 1_000);

  const fastShiftFrame = renderFollowFrameForTesting(state, "Syncing Cogcoin Blocks...", 2_125);
  const fastShiftWindow = extractFollowWindow(fastShiftFrame);

  assert.ok((fastShiftWindow[2]?.indexOf("910001") ?? -1) > 21);
  assert.ok((fastShiftWindow[2]?.indexOf("910000") ?? -1) > 30);

  advanceFollowSceneStateForTesting(state, 2_250);

  assert.equal(state.displayedCenterHeight, 910_000);
  assert.equal(state.animation?.kind, "convoy_shift");
  assert.equal(state.animation?.durationMs, 1_000);

  advanceFollowSceneStateForTesting(state, 3_000);

  assert.equal(state.displayedCenterHeight, 910_001);
  assert.equal(state.animation?.kind, "tip_approach");
  assert.equal(state.animation?.height, 910_002);
  assert.equal(state.animation?.durationMs, 1_000);
});

test("follow scene keeps fast catch-up timing when the indexed height is ahead but the displayed convoy is still lagging", () => {
  const state = createFollowSceneStateForTesting(910_003);

  syncFollowSceneStateForTesting(state, {
    indexedHeight: 910_003,
    nodeHeight: 910_004,
    liveActivated: true,
  });

  state.displayedCenterHeight = 910_000;
  state.pendingLabel = "910001";
  state.pendingStaticX = 0;
  state.queuedHeights = [910_001, 910_002, 910_003, 910_004];

  advanceFollowSceneStateForTesting(state, 0);

  assert.equal(state.animation?.kind, "tip_approach");
  assert.equal(state.animation?.height, 910_001);
  assert.equal(state.animation?.durationMs, 1_000);
});

test("follow scene queues multiple detected tips in order and skips the placeholder until the queue drains", () => {
  const state = createFollowSceneStateForTesting(910_000);

  syncFollowSceneStateForTesting(state, {
    indexedHeight: 910_000,
    nodeHeight: 910_000,
    liveActivated: true,
  });
  advanceFollowSceneStateForTesting(state, 0);
  advanceFollowSceneStateForTesting(state, 1_000);
  syncFollowSceneStateForTesting(state, {
    nodeHeight: 910_003,
    liveActivated: true,
  });
  advanceFollowSceneStateForTesting(state, 1_000);
  advanceFollowSceneStateForTesting(state, 5_000);

  assert.deepEqual(state.queuedHeights, [910_002, 910_003]);
  assert.equal(state.animation?.kind, "tip_approach");
  assert.equal(state.animation?.height, 910_002);
  assert.equal(state.pendingLabel, "910002");
});

test("follow scene resets to the current indexed truth on a reorg-like height decrease", () => {
  const state = createFollowSceneStateForTesting(910_000);

  syncFollowSceneStateForTesting(state, {
    indexedHeight: 910_000,
    nodeHeight: 910_002,
    liveActivated: true,
  });
  advanceFollowSceneStateForTesting(state, 1_000);
  syncFollowSceneStateForTesting(state, {
    indexedHeight: 909_998,
    nodeHeight: 909_998,
    liveActivated: true,
  });
  advanceFollowSceneStateForTesting(state, 1_000);

  assert.equal(state.displayedCenterHeight, 909_998);
  assert.deepEqual(state.queuedHeights, []);
  assert.equal(state.animation?.kind, "placeholder_enter");
});

test("compact follow ages use short second, minute, hour, and day labels", () => {
  const now = Date.UTC(2026, 3, 6, 12, 0, 0);

  assert.equal(formatCompactFollowAgeLabelForTesting(Math.floor(now / 1000) - 5, now), "5s");
  assert.equal(formatCompactFollowAgeLabelForTesting(Math.floor(now / 1000) - 42, now), "42s");
  assert.equal(formatCompactFollowAgeLabelForTesting(Math.floor(now / 1000) - (32 * 60), now), "32m");
  assert.equal(formatCompactFollowAgeLabelForTesting(Math.floor(now / 1000) - (60 * 60), now), "1h");
  assert.equal(formatCompactFollowAgeLabelForTesting(Math.floor(now / 1000) - (2 * 60 * 60), now), "2h");
  assert.equal(formatCompactFollowAgeLabelForTesting(Math.floor(now / 1000) - (24 * 60 * 60), now), "1d");
  assert.equal(formatCompactFollowAgeLabelForTesting(Math.floor(now / 1000) + 600, now), "1s");
});

test("follow scene renders compact age labels beneath the newest and prior settled cars", () => {
  const now = Date.UTC(2026, 3, 6, 12, 0, 0);
  const state = createFollowSceneStateForTesting(910_000);

  setFollowBlockTimesForTesting(state, {
    910000: Math.floor(now / 1000) - (10 * 60),
    909999: Math.floor(now / 1000) - (1 * 60),
    909998: Math.floor(now / 1000) - (32 * 60),
    909997: Math.floor(now / 1000) - (60 * 60),
    909996: Math.floor(now / 1000) - (2 * 60 * 60),
  });
  syncFollowSceneStateForTesting(state, {
    indexedHeight: 910_000,
    nodeHeight: 910_000,
    liveActivated: true,
  });
  advanceFollowSceneStateForTesting(state, 0);
  advanceFollowSceneStateForTesting(state, 1_000);

  const frame = renderFollowFrameForTesting(state, "Waiting for next block to be mined...", now);
  const window = extractFollowWindow(frame);
  const labelRow = window[2] ?? "";
  const ageRow = window[5] ?? "";

  assert.equal(ageRow.indexOf("10m"), expectedFollowAgeStart(labelRow.indexOf("910000")));
  assert.equal(ageRow.indexOf("1m"), expectedFollowAgeStart(labelRow.indexOf("909999")));
  assert.equal(ageRow.indexOf("32m"), expectedFollowAgeStart(labelRow.indexOf("909998")));
  assert.equal(ageRow.indexOf("1h"), expectedFollowAgeStart(labelRow.indexOf("909997")));
  assert.equal(ageRow.indexOf("2h"), expectedFollowAgeStart(labelRow.indexOf("909996")));
});

test("follow scene moves prior-car age labels with the convoy shift", () => {
  const now = Date.UTC(2026, 3, 6, 12, 0, 0);
  const state = createFollowSceneStateForTesting(910_000);

  setFollowBlockTimesForTesting(state, {
    910000: Math.floor(now / 1000) - (32 * 60),
    909999: Math.floor(now / 1000) - (60 * 60),
    909998: Math.floor(now / 1000) - (2 * 60 * 60),
    909997: Math.floor(now / 1000) - (24 * 60 * 60),
    910001: Math.floor(now / 1000) - (5 * 60),
  });
  syncFollowSceneStateForTesting(state, {
    indexedHeight: 910_000,
    nodeHeight: 910_000,
    liveActivated: true,
  });
  advanceFollowSceneStateForTesting(state, now);
  advanceFollowSceneStateForTesting(state, now + 1_000);
  syncFollowSceneStateForTesting(state, {
    nodeHeight: 910_001,
    liveActivated: true,
  });
  advanceFollowSceneStateForTesting(state, now + 1_000);
  advanceFollowSceneStateForTesting(state, now + 4_000);

  const shiftFrame = renderFollowFrameForTesting(state, "Waiting for next block to be mined...", now + 4_500);
  const shiftWindow = extractFollowWindow(shiftFrame);
  const shiftLabelRow = shiftWindow[2] ?? "";
  const shiftAgeRow = shiftWindow[5] ?? "";

  assert.equal(shiftAgeRow.indexOf("32m"), expectedFollowAgeStart(shiftLabelRow.indexOf("910000")));
  assert.equal(shiftAgeRow.indexOf("1h"), expectedFollowAgeStart(shiftLabelRow.indexOf("909999")));
  assert.equal(shiftAgeRow.includes("5m"), false);
});

test("follow scene clears stale block times on a reorg-like reset and accepts rebuilt times", () => {
  const now = Date.UTC(2026, 3, 6, 12, 0, 0);
  const state = createFollowSceneStateForTesting(910_000);

  setFollowBlockTimesForTesting(state, {
    910000: Math.floor(now / 1000) - (10 * 60),
    909999: Math.floor(now / 1000) - (32 * 60),
  });
  syncFollowSceneStateForTesting(state, {
    indexedHeight: 910_000,
    nodeHeight: 910_002,
    liveActivated: true,
  });
  syncFollowSceneStateForTesting(state, {
    indexedHeight: 909_998,
    nodeHeight: 909_998,
    liveActivated: true,
  });

  assert.deepEqual(state.blockTimesByHeight, {});

  setFollowBlockTimesForTesting(state, {
    909998: Math.floor(now / 1000) - (60 * 60),
    909997: Math.floor(now / 1000) - (2 * 60 * 60),
  });
  advanceFollowSceneStateForTesting(state, 1_000);
  const frame = renderFollowFrameForTesting(state, "Waiting for next block to be mined...", now);
  const window = extractFollowWindow(frame);

  assert.match(window[5] ?? "", /2h/);
});

test("ManagedProgressController follow resume reuses the indexed tip after a bitcoin-sync phase", async () => {
  const rootDir = createTempDirectory("cogcoin-client-follow-resume");
  const paths = resolveBootstrapPathsForTesting(rootDir, DEFAULT_SNAPSHOT_METADATA);
  const progress = new ManagedProgressController({
    quoteStatePath: paths.quoteStatePath,
    snapshot: DEFAULT_SNAPSHOT_METADATA,
    progressOutput: "none",
  });

  try {
    await progress.start();
    await progress.enableFollowVisualMode(945_799);
    await progress.setPhase("follow_tip", {
      blocks: 945_799,
      targetHeight: 945_799,
      message: "Resuming from the persisted Cogcoin indexed tip.",
    });
    await progress.setPhase("bitcoin_sync", {
      blocks: 945_810,
      headers: 945_810,
      targetHeight: 945_810,
      message: "Fetching Getblock manifest.",
    });
    await progress.setPhase("follow_tip", {
      blocks: 945_799,
      targetHeight: 945_799,
      message: "Resuming from the persisted Cogcoin indexed tip.",
    });

    await assert.doesNotReject(async () => {
      await progress.setCogcoinSync(945_799, 945_810, 1);
    });
  } finally {
    await progress.close().catch(() => undefined);
    await removeTempDirectory(rootDir);
  }
});

test("follow scene state sync tolerates very large queued height lists", () => {
  const state = createFollowSceneStateForTesting(945_799);
  state.liveActivated = true;
  state.displayedCenterHeight = 945_799;
  state.observedNodeHeight = 945_799;
  state.queuedHeights = Array.from({ length: 200_000 }, (_, index) => index);

  assert.doesNotThrow(() => {
    syncFollowSceneStateForTesting(state, {
      indexedHeight: 945_799,
      nodeHeight: 945_810,
      liveActivated: true,
    });
  });
});

test("scroll art centers the quote and byline inside the usable window", () => {
  const quote: WritingQuote = {
    quote: "Easy reading is damn hard writing.",
    author: "Nathaniel Hawthorne",
  };
  const frame = renderArtFrameForTesting("scroll", quote, "Syncing Cogcoin Blocks...");
  const template = loadScrollArtForTesting();
  const { window, nonEmptyRows } = findCenteredBlockRows(frame);
  const nonEmpty = nonEmptyRows.map((index) => ({ index, trimmed: window[index]?.trim() ?? "" }));

  assert.equal(nonEmpty.length, 2);
  assert.equal(nonEmpty[0]?.trimmed, "\"Easy reading is damn hard writing.\"");
  assert.equal(nonEmpty[1]?.trimmed, "- Nathaniel Hawthorne");
  assert.equal(nonEmpty[0]?.index, 3);
  assert.equal(nonEmpty[1]?.index, 5);
  assert.equal((nonEmpty[1]?.index ?? 0) - (nonEmpty[0]?.index ?? 0), 2);
  assert.equal(window[(nonEmpty[0]?.index ?? 0) + 1]?.trim(), "");
  assert.equal(
    window[nonEmpty[0]?.index ?? 0]?.indexOf(nonEmpty[0]?.trimmed ?? ""),
    Math.floor((65 - (nonEmpty[0]?.trimmed.length ?? 0)) / 2),
  );
  assert.equal(
    window[nonEmpty[1]?.index ?? 0]?.indexOf(nonEmpty[1]?.trimmed ?? ""),
    Math.floor((65 - (nonEmpty[1]?.trimmed.length ?? 0)) / 2),
  );

  for (let row = 3; row < 11; row += 1) {
    assert.equal(frame[row]?.slice(0, 7), template[row]?.slice(0, 7));
    assert.equal(frame[row]?.slice(72), template[row]?.slice(72));
  }

  assert.equal(extractField(frame, 2).trim(), "⛭  C O G C O I N  ⛭");
  assertCenteredField(frame, 13, "Syncing Cogcoin Blocks...");
});

test("scroll art anchors the last line of a multiline quote to an earlier centered line", () => {
  const quote: WritingQuote = {
    quote: [
      makeLongWord(30),
      makeLongWord(30),
      makeLongWord(30),
      makeLongWord(30),
      makeLongWord(10),
    ].join(" "),
    author: "Anchored Ending",
  };
  const { window, nonEmptyRows, bylineRow } = findCenteredBlockRows(renderArtFrameForTesting("scroll", quote));
  const quoteRows = nonEmptyRows.filter((row) => row !== bylineRow);
  const quoteLines = quoteRows.map((row) => window[row] ?? "");
  const trimmedQuoteLines = quoteLines.map((line) => line.trim());
  const lineStarts = quoteLines.map((line, index) => line.indexOf(trimmedQuoteLines[index] ?? ""));
  const lastLine = trimmedQuoteLines[trimmedQuoteLines.length - 1] ?? "";
  const earlierStarts = lineStarts.slice(0, -1);
  const expectedCenteredLastStart = Math.floor((65 - lastLine.length) / 2);

  assert.equal(quoteRows.length, 3);
  assert.ok(trimmedQuoteLines[0]?.startsWith("\""));
  assert.ok(lastLine.endsWith("\""));
  assert.equal(lineStarts[lineStarts.length - 1], Math.min(...earlierStarts));
  assert.ok((lineStarts[lineStarts.length - 1] ?? -1) < expectedCenteredLastStart);
});

test("scroll art lower-biases vertical centering for odd-height quote blocks", () => {
  const threeLineQuote: WritingQuote = {
    quote: [makeLongWord(40), makeLongWord(40), makeLongWord(40)].join(" "),
    author: "Three Lines",
  };
  const fiveLineQuote: WritingQuote = {
    quote: [makeLongWord(40), makeLongWord(40), makeLongWord(40), makeLongWord(40), makeLongWord(40)].join(" "),
    author: "Five Lines",
  };

  const threeLineFrame = renderArtFrameForTesting("scroll", threeLineQuote);
  const fiveLineFrame = renderArtFrameForTesting("scroll", fiveLineQuote);
  const threeLineRows = findCenteredBlockRows(threeLineFrame);
  const fiveLineRows = findCenteredBlockRows(fiveLineFrame);

  assert.deepEqual(threeLineRows.nonEmptyRows, [2, 3, 4, 6]);
  assert.equal(threeLineRows.window[5]?.trim(), "");
  assert.deepEqual(fiveLineRows.nonEmptyRows, [1, 2, 3, 4, 5, 7]);
  assert.equal(fiveLineRows.window[6]?.trim(), "");
});

test("scroll art keeps even-height quote blocks in their existing centered position", () => {
  const twoLineQuote: WritingQuote = {
    quote: [makeLongWord(40), makeLongWord(40)].join(" "),
    author: "Two Lines",
  };
  const frame = renderArtFrameForTesting("scroll", twoLineQuote);
  const { window, nonEmptyRows } = findCenteredBlockRows(frame);

  assert.deepEqual(nonEmptyRows, [2, 3, 5]);
  assert.equal(window[4]?.trim(), "");
});

test("scroll art truncates long quotes while preserving the byline layout", () => {
  const quote: WritingQuote = {
    quote: Array.from({ length: 80 }, () => "word").join(" "),
    author: "Verbose Author",
  };
  const frame = renderArtFrameForTesting("scroll", quote);
  const window = extractScrollWindow(frame);
  const bylineIndex = window.findIndex((line) => line.trim() === "- Verbose Author");
  const quoteLines = window.slice(0, bylineIndex - 1).map((line) => line.trim()).filter(Boolean);

  assert.equal(bylineIndex, 7);
  assert.equal(window[6]?.trim(), "");
  assert.equal(quoteLines.length, 6);
  assert.ok(quoteLines[0]?.startsWith("\""));
  assert.ok(quoteLines[quoteLines.length - 1]?.endsWith("…\""));
});

test("TTY renderer writes the animated intro frame before quotes and updates it in place", () => {
  const writes: string[] = [];
  const renderer = new TtyProgressRenderer({
    isTTY: true,
    columns: 120,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  });
  const quote: WritingQuote = {
    quote: "Easy reading is damn hard writing.",
    author: "Nathaniel Hawthorne",
  };
  const progress = createBootstrapProgressForTesting("snapshot_download", DEFAULT_SNAPSHOT_METADATA);
  progress.downloadedBytes = 1024;
  progress.totalBytes = DEFAULT_SNAPSHOT_METADATA.sizeBytes;
  progress.percent = 0.01;
  const introStatus = resolveStatusFieldTextForTesting(progress, DEFAULT_SNAPSHOT_METADATA.height);
  const scrollStatus = resolveStatusFieldTextForTesting(
    createBootstrapProgressForTesting("cogcoin_sync", DEFAULT_SNAPSHOT_METADATA),
    DEFAULT_SNAPSHOT_METADATA.height,
  );

  renderer.render("banner", null, progress, null, null, 2_500, introStatus);
  renderer.render("scroll", quote, progress, null, null, 0, scrollStatus);
  renderer.close();

  const initialLines = (writes[0] ?? "").split("\n");
  const updatedLines = (writes[2] ?? "").split("\n");

  assert.equal(initialLines.length, 16);
  assert.deepEqual(initialLines.slice(0, 13), renderIntroFrameForTesting(2_500, introStatus));
  assert.equal(initialLines[13], "");
  assert.match(initialLines[14] ?? "", /ETA/);
  assert.equal(initialLines[15], "");
  assert.equal(countMatches(writes[1] ?? "", /\u001B\[2K/g), 16);
  assert.equal(countMatches(writes[1] ?? "", /\u001B\[1A/g), 15);
  assert.equal(updatedLines.length, 16);
  assert.equal(extractField(updatedLines.slice(0, 13), 2).trim(), "⛭  C O G C O I N  ⛭");
  assertCenteredField(updatedLines.slice(0, 13), 13, scrollStatus);
  assert.equal(updatedLines[13], "");
  assert.equal(updatedLines[15], "");
  assert.match(writes[2] ?? "", /Nathaniel Hawthorne/);
});

test("TTY renderer falls back to the compact view with a blank line below progress on narrow terminals", () => {
  const writes: string[] = [];
  const renderer = new TtyProgressRenderer({
    isTTY: true,
    columns: 79,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  });
  const quote: WritingQuote = {
    quote: "Easy reading is damn hard writing.",
    author: "Nathaniel Hawthorne",
  };
  const progress = createBootstrapProgressForTesting("snapshot_download", DEFAULT_SNAPSHOT_METADATA);
  progress.downloadedBytes = 1024;
  progress.totalBytes = DEFAULT_SNAPSHOT_METADATA.sizeBytes;
  progress.percent = 0.01;

  renderer.render("scroll", quote, progress, null, null);
  renderer.close();

  const lines = (writes[0] ?? "").split("\n");
  assert.equal(lines.length, 3);
  assert.match(writes[0] ?? "", /Nathaniel Hawthorne/);
  assert.equal(lines[2], "");
});

test("TTY renderer reprints a fresh follow frame after external writes instead of clearing upward", () => {
  const writes: string[] = [];
  const stream = {
    isTTY: true,
    columns: 120,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };
  const renderer = new TtyProgressRenderer(stream);
  const progress = createBootstrapProgressForTesting("follow_tip", DEFAULT_SNAPSHOT_METADATA);
  const state = createFollowSceneStateForTesting(910_000);
  const statusField = resolveStatusFieldTextForTesting(progress, DEFAULT_SNAPSHOT_METADATA.height, 0);

  renderer.renderFollowScene(progress, null, null, state, statusField);
  stream.write("(external warning)\n");
  renderer.renderFollowScene(progress, null, null, state, statusField);
  renderer.close();

  assert.equal(writes[1], "(external warning)\n");
  assert.ok(!(writes[2] ?? "").includes("\u001B[2K"));
  assert.ok((writes[2] ?? "").startsWith(" _____"));
});

test("status field text maps bootstrap phases to the requested copy", () => {
  const paused = resolveStatusFieldTextForTesting(
    createBootstrapProgressForTesting("paused", DEFAULT_SNAPSHOT_METADATA),
    DEFAULT_SNAPSHOT_METADATA.height,
    0,
  );
  const pausedMid = resolveStatusFieldTextForTesting(
    createBootstrapProgressForTesting("paused", DEFAULT_SNAPSHOT_METADATA),
    DEFAULT_SNAPSHOT_METADATA.height,
    500,
  );
  const pausedFull = resolveStatusFieldTextForTesting(
    createBootstrapProgressForTesting("paused", DEFAULT_SNAPSHOT_METADATA),
    DEFAULT_SNAPSHOT_METADATA.height,
    1_000,
  );
  const pausedOverflow = resolveStatusFieldTextForTesting(
    createBootstrapProgressForTesting("paused", DEFAULT_SNAPSHOT_METADATA),
    DEFAULT_SNAPSHOT_METADATA.height,
    1_500,
  );
  const download = resolveStatusFieldTextForTesting(
    createBootstrapProgressForTesting("snapshot_download", DEFAULT_SNAPSHOT_METADATA),
    DEFAULT_SNAPSHOT_METADATA.height,
    0,
  );
  const downloadMid = resolveStatusFieldTextForTesting(
    createBootstrapProgressForTesting("snapshot_download", DEFAULT_SNAPSHOT_METADATA),
    DEFAULT_SNAPSHOT_METADATA.height,
    500,
  );
  const downloadFull = resolveStatusFieldTextForTesting(
    createBootstrapProgressForTesting("snapshot_download", DEFAULT_SNAPSHOT_METADATA),
    DEFAULT_SNAPSHOT_METADATA.height,
    1_000,
  );
  const downloadOverflow = resolveStatusFieldTextForTesting(
    createBootstrapProgressForTesting("snapshot_download", DEFAULT_SNAPSHOT_METADATA),
    DEFAULT_SNAPSHOT_METADATA.height,
    1_500,
  );
  const waitHeaders = resolveStatusFieldTextForTesting(
    createBootstrapProgressForTesting("wait_headers_for_snapshot", DEFAULT_SNAPSHOT_METADATA),
    DEFAULT_SNAPSHOT_METADATA.height,
    1_500,
  );
  const waitHeadersRpc = resolveStatusFieldTextForTesting(
    {
      ...createBootstrapProgressForTesting("wait_headers_for_snapshot", DEFAULT_SNAPSHOT_METADATA),
      headers: 1,
      message: "Waiting for Bitcoin headers to reach the snapshot height.",
    },
    DEFAULT_SNAPSHOT_METADATA.height,
    1_500,
  );
  const bitcoin = resolveStatusFieldTextForTesting(
    createBootstrapProgressForTesting("bitcoin_sync", DEFAULT_SNAPSHOT_METADATA),
    DEFAULT_SNAPSHOT_METADATA.height,
    1_500,
  );
  const cogcoin = resolveStatusFieldTextForTesting(
    createBootstrapProgressForTesting("follow_tip", DEFAULT_SNAPSHOT_METADATA),
    DEFAULT_SNAPSHOT_METADATA.height,
    1_500,
  );
  const complete = resolveStatusFieldTextForTesting(
    createBootstrapProgressForTesting("complete", DEFAULT_SNAPSHOT_METADATA),
    DEFAULT_SNAPSHOT_METADATA.height,
    1_500,
  );

  assert.equal(paused, "Waiting to start managed sync   ");
  assert.equal(pausedMid, "Waiting to start managed sync.  ");
  assert.equal(pausedFull, "Waiting to start managed sync.. ");
  assert.equal(pausedOverflow, "Waiting to start managed sync...");
  assert.equal(download, "Downloading snapshot to 910000   ");
  assert.equal(downloadMid, "Downloading snapshot to 910000.  ");
  assert.equal(downloadFull, "Downloading snapshot to 910000.. ");
  assert.equal(downloadOverflow, "Downloading snapshot to 910000...");
  assert.equal(waitHeaders, "Pre-synchronizing blockheaders...");
  assert.equal(waitHeadersRpc, "Waiting for Bitcoin headers to reach the snapshot height...");
  assert.equal(bitcoin, "Syncing Bitcoin Blocks...");
  assert.equal(cogcoin, "Waiting for next block to be mined...");
  assert.equal(complete, "Sync complete...");
});

test("status field keeps its centered anchor fixed while ellipsis animates", () => {
  const progress = createBootstrapProgressForTesting("bitcoin_sync", DEFAULT_SNAPSHOT_METADATA);
  const frameOne = renderIntroFrameForTesting(
    0,
    resolveStatusFieldTextForTesting(progress, DEFAULT_SNAPSHOT_METADATA.height, 0),
  );
  const frameTwo = renderIntroFrameForTesting(
    0,
    resolveStatusFieldTextForTesting(progress, DEFAULT_SNAPSHOT_METADATA.height, 500),
  );
  const frameThree = renderIntroFrameForTesting(
    0,
    resolveStatusFieldTextForTesting(progress, DEFAULT_SNAPSHOT_METADATA.height, 1_000),
  );
  const frameFour = renderIntroFrameForTesting(
    0,
    resolveStatusFieldTextForTesting(progress, DEFAULT_SNAPSHOT_METADATA.height, 1_500),
  );
  const fieldOne = extractField(frameOne, 13);
  const fieldTwo = extractField(frameTwo, 13);
  const fieldThree = extractField(frameThree, 13);
  const fieldFour = extractField(frameFour, 13);
  const firstNonSpace = (value: string): number => value.search(/\S/);

  assert.equal(firstNonSpace(fieldOne), firstNonSpace(fieldTwo));
  assert.equal(firstNonSpace(fieldTwo), firstNonSpace(fieldThree));
  assert.equal(firstNonSpace(fieldThree), firstNonSpace(fieldFour));
});

test("load_snapshot progress formatting shows a live indeterminate bar", () => {
  const progress = createBootstrapProgressForTesting("load_snapshot", DEFAULT_SNAPSHOT_METADATA);
  const first = formatProgressLineForTesting(progress, null, null, 120, 0);
  const second = formatProgressLineForTesting(progress, null, null, 120, 1_000);

  assert.match(first, /^\[[█░]{20}\] Loading the UTXO snapshot into bitcoind\./);
  assert.match(second, /^\[[█░]{20}\] Loading the UTXO snapshot into bitcoind\./);
  assert.notEqual(first, second);
});

test("follow_tip progress formatting shows the live indeterminate bar without height counters", () => {
  const progress = createBootstrapProgressForTesting("follow_tip", DEFAULT_SNAPSHOT_METADATA);
  const first = formatProgressLineForTesting(progress, 0, 910_000, 120, 0);
  const second = formatProgressLineForTesting(progress, 0, 910_000, 120, 1_000);

  assert.match(first, /^\[[█░]{20}\] Following the live Bitcoin tip\./);
  assert.match(second, /^\[[█░]{20}\] Following the live Bitcoin tip\./);
  assert.ok(!first.includes("0 / 910,000"));
  assert.notEqual(first, second);
});

test("wait_headers_for_snapshot progress formatting shows a determinate empty bar before headers arrive", () => {
  const progress = createBootstrapProgressForTesting("wait_headers_for_snapshot", DEFAULT_SNAPSHOT_METADATA);
  progress.headers = 0;
  progress.targetHeight = 910_000;

  const first = formatProgressLineForTesting(progress, null, null, 120, 0);
  const second = formatProgressLineForTesting(progress, null, null, 120, 1_000);

  assert.equal(first, "[░░░░░░░░░░░░░░░░░░░░] Headers 0 / 910,000 Pre-synchronizing blockheaders.");
  assert.equal(second, first);
});

test("wait_headers_for_snapshot progress formatting shows the debug.log message while RPC headers lag", () => {
  const progress = createBootstrapProgressForTesting("wait_headers_for_snapshot", DEFAULT_SNAPSHOT_METADATA);
  progress.headers = 88_000;
  progress.targetHeight = 910_000;
  progress.message = "Pre-synchronizing blockheaders, height: 88,000 (~9.67%)";

  const line = formatProgressLineForTesting(progress, null, null, 120, 0);

  assert.equal(line, "[██░░░░░░░░░░░░░░░░░░] Headers 88,000 / 910,000 Pre-synchronizing blockheaders, height: 88,000 (~9.67%)");
});

test("wait_headers_for_snapshot progress formatting switches to a ratio bar after headers start moving", () => {
  const progress = createBootstrapProgressForTesting("wait_headers_for_snapshot", DEFAULT_SNAPSHOT_METADATA);
  progress.headers = 455_000;
  progress.targetHeight = 910_000;
  progress.message = "Waiting for Bitcoin headers to reach the snapshot height.";

  const line = formatProgressLineForTesting(progress, null, null, 120, 0);

  assert.match(line, /^\[[█░]{20}\] Headers 455,000 \/ 910,000 Waiting for Bitcoin headers to reach the snapshot height\./);
  assert.ok(!line.includes("Headers 0 / 910,000"));
});

test("progress formatting reports bitcoin and cogcoin height progress", () => {
  const bitcoinProgress = createBootstrapProgressForTesting("bitcoin_sync", DEFAULT_SNAPSHOT_METADATA);
  bitcoinProgress.blocks = 910_500;
  bitcoinProgress.targetHeight = 912_000;
  bitcoinProgress.etaSeconds = 90;

  const bitcoinLine = formatProgressLineForTesting(bitcoinProgress, null, null);
  assert.match(bitcoinLine, /Bitcoin 910,500 \/ 912,000 ETA 00:01:30/);

  const cogcoinProgress = createBootstrapProgressForTesting("cogcoin_sync", DEFAULT_SNAPSHOT_METADATA);
  cogcoinProgress.etaSeconds = 3600;
  const cogcoinLine = formatProgressLineForTesting(cogcoinProgress, 12_345, 910_500);
  assert.match(cogcoinLine, /Cogcoin 12,345 \/ 910,500 ETA 01:00:00/);
});
