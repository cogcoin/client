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
    assert.match(text, /^zmqpubhashblock=tcp:\/\/127\.0\.0\.1:\d+$/m);
    assert.match(text, /^zmqpubrawtx=tcp:\/\/127\.0\.0\.1:\d+$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeBitcoinConfForTesting scopes regtest ports and ZMQ into the regtest section", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-client-regtest-conf-"));
  const filePath = join(root, "bitcoin.conf");

  try {
    await writeBitcoinConfForTesting(filePath, {
      dataDir: root,
      chain: "regtest",
      startHeight: 0,
    }, createRuntimeConfig(768));

    const text = await readFile(filePath, "utf8");
    assert.match(text, /\n\[regtest\]\n/u);
    assert.match(text, /\[regtest\]\ndnsseed=1\nlisten=0\nrpcbind=127\.0\.0\.1\nrpcallowip=127\.0\.0\.1\nrpcport=18443\nport=18444\nzmqpubhashblock=tcp:\/\/127\.0\.0\.1:28332\nzmqpubrawtx=tcp:\/\/127\.0\.0\.1:28332\nwalletdir=.+\/wallets\n$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildManagedServiceArgsForTesting keeps managed runtime config in bitcoin.conf", () => {
  const args = buildManagedServiceArgsForTesting({
    dataDir: "/tmp/cogcoin-bitcoind",
    chain: "main",
    startHeight: 937_337,
  }, createRuntimeConfig(768));

  assert.ok(args.includes("-nosettings=1"));
  assert.ok(args.includes("-datadir=/tmp/cogcoin-bitcoind"));
  for (const prefix of [
    "-rpcbind=",
    "-rpcallowip=",
    "-rpcport=",
    "-port=",
    "-zmqpubhashblock=",
    "-zmqpubrawtx=",
    "-walletdir=",
    "-server=",
    "-prune=",
    "-dnsseed=",
    "-listen=",
    "-dbcache=",
  ]) {
    assert.equal(args.some((arg) => arg.startsWith(prefix)), false, `${prefix} should be written through bitcoin.conf`);
  }
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
