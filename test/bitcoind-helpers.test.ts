import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  cleanupTrackedTempDirectory,
  createTrackedTempDirectory,
  createTempDirectory,
  removeTempDirectory,
  resolveManagedDataDirsForTempRootForTesting,
} from "./bitcoind-helpers.js";

test("resolveManagedDataDirsForTempRootForTesting discovers managed Bitcoin data dirs under temp homes", async (t) => {
  const root = createTempDirectory("cogcoin-temp-dir-cleanup-discovery");
  t.after(async () => {
    await removeTempDirectory(root).catch(() => undefined);
  });

  const darwinBitcoinDir = join(root, "Library", "Application Support", "Cogcoin", "bitcoin");
  const linuxBitcoinDir = join(root, ".local", "share", "cogcoin", "bitcoin");
  const xdgBitcoinDir = join(root, "data", "cogcoin", "bitcoin");
  const xdgHomeBitcoinDir = join(root, "data-home", "cogcoin", "bitcoin");
  const nestedBitcoindDir = join(root, "nested", "runtime-fixture", "bitcoind");

  await Promise.all([
    mkdir(darwinBitcoinDir, { recursive: true }),
    mkdir(linuxBitcoinDir, { recursive: true }),
    mkdir(xdgBitcoinDir, { recursive: true }),
    mkdir(xdgHomeBitcoinDir, { recursive: true }),
    mkdir(nestedBitcoindDir, { recursive: true }),
  ]);

  const dataDirs = await resolveManagedDataDirsForTempRootForTesting(root);

  assert.ok(dataDirs.includes(resolve(darwinBitcoinDir)));
  assert.ok(dataDirs.includes(resolve(linuxBitcoinDir)));
  assert.ok(dataDirs.includes(resolve(xdgBitcoinDir)));
  assert.ok(dataDirs.includes(resolve(xdgHomeBitcoinDir)));
  assert.ok(dataDirs.includes(resolve(nestedBitcoindDir)));
  assert.ok(!dataDirs.includes(resolve(root)));
});

test("cleanupTrackedTempDirectory shuts down discovered managed services before removing the temp root", async (t) => {
  const root = createTempDirectory("cogcoin-temp-dir-cleanup");
  t.after(async () => {
    await removeTempDirectory(root).catch(() => undefined);
  });
  const dataDirs = [
    join(root, "bitcoind"),
    join(root, "Library", "Application Support", "Cogcoin", "bitcoin"),
    join(root, ".local", "share", "cogcoin", "bitcoin"),
    join(root, "data", "cogcoin", "bitcoin"),
    join(root, "data-home", "cogcoin", "bitcoin"),
    join(root, "nested", "fixture", "bitcoind"),
  ].map((path) => resolve(path));

  await Promise.all(dataDirs.map((path) => mkdir(path, { recursive: true })));

  const shutdownCalls: string[] = [];

  await cleanupTrackedTempDirectory(root, {
    async shutdownIndexerDaemon({ dataDir }) {
      shutdownCalls.push(`indexer:${resolve(dataDir)}`);
    },
    async shutdownManagedBitcoind({ dataDir, chain }) {
      shutdownCalls.push(`${chain ?? "main"}:${resolve(dataDir)}`);
    },
  });

  await assert.rejects(access(root));

  for (const dataDir of dataDirs) {
    assert.equal(
      shutdownCalls.filter((call) => call === `indexer:${dataDir}`).length,
      1,
    );
    assert.equal(
      shutdownCalls.filter((call) => call === `main:${dataDir}`).length,
      1,
    );
    assert.equal(
      shutdownCalls.filter((call) => call === `regtest:${dataDir}`).length,
      1,
    );
  }
});

test("createTrackedTempDirectory registers cleanup before the test completes", async (t) => {
  let root = "";

  await t.test("tracked temp root", async (subtest) => {
    root = await createTrackedTempDirectory(subtest, "cogcoin-tracked-temp-dir");
    await mkdir(join(root, "marker"), { recursive: true });
  });

  assert.notEqual(root, "");
  await assert.rejects(access(root));
});
