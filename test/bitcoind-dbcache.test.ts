import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ManagedBitcoindRuntimeConfig } from "../src/bitcoind/types.js";
import {
  buildManagedServiceArgsForTesting,
  resolveManagedBitcoindDbcacheMiB,
  writeBitcoinConfForTesting,
} from "../src/bitcoind/testing.js";

function createRuntimeConfig(dbcacheMiB: number): ManagedBitcoindRuntimeConfig {
  return {
    chain: "main",
    rpc: {
      url: "http://127.0.0.1:18443",
      cookieFile: "/tmp/cogcoin/.cookie",
      port: 18443,
    },
    zmqPort: 28332,
    p2pPort: 18444,
    dbcacheMiB,
    getblockArchiveEndHeight: null,
    getblockArchiveSha256: null,
  };
}

test("resolveManagedBitcoindDbcacheMiB uses the requested RAM tiers", () => {
  const GiB = 1024 ** 3;

  assert.equal(resolveManagedBitcoindDbcacheMiB(0), 450);
  assert.equal(resolveManagedBitcoindDbcacheMiB(8 * GiB - 1), 450);
  assert.equal(resolveManagedBitcoindDbcacheMiB(8 * GiB), 768);
  assert.equal(resolveManagedBitcoindDbcacheMiB(16 * GiB), 1024);
  assert.equal(resolveManagedBitcoindDbcacheMiB(32 * GiB), 2048);
});

test("writeBitcoinConfForTesting writes dbcache into managed bitcoin.conf", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-client-dbcache-conf-"));
  const filePath = join(root, "bitcoin.conf");

  try {
    await writeBitcoinConfForTesting(filePath, {
      dataDir: root,
      chain: "main",
      startHeight: 937_337,
    }, createRuntimeConfig(1024));

    const text = await readFile(filePath, "utf8");
    assert.match(text, /^listen=0$/m);
    assert.match(text, /^dbcache=1024$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildManagedServiceArgsForTesting includes dbcache in the managed bitcoind argv", () => {
  const args = buildManagedServiceArgsForTesting({
    dataDir: "/tmp/cogcoin-bitcoind",
    chain: "main",
    startHeight: 937_337,
  }, createRuntimeConfig(768));

  assert.ok(args.includes("-listen=0"));
  assert.ok(args.includes("-dbcache=768"));
});

test("buildManagedServiceArgsForTesting includes loadblock when a getblock archive is ready", () => {
  const args = buildManagedServiceArgsForTesting({
    dataDir: "/tmp/cogcoin-bitcoind",
    chain: "main",
    startHeight: 937_337,
    getblockArchivePath: "/tmp/cogcoin-bitcoind/bootstrap/getblock/getblock-910001-910500.dat",
    getblockArchiveEndHeight: 945_188,
    getblockArchiveSha256: "ab".repeat(32),
  }, {
    ...createRuntimeConfig(1024),
    getblockArchiveEndHeight: 945_188,
    getblockArchiveSha256: "ab".repeat(32),
  });

  assert.ok(args.includes("-loadblock=/tmp/cogcoin-bitcoind/bootstrap/getblock/getblock-910001-910500.dat"));
});
