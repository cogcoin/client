import assert from "node:assert/strict";
import { basename } from "node:path";
import test from "node:test";

import { getBitcoinCliPath, getBitcoindPath } from "@cogcoin/bitcoin";

import {
  buildBitcoindArgsForTesting,
  normalizeRpcBlock,
  resolveDefaultBitcoindDataDirForTesting,
  validateNodeConfigForTesting,
} from "../src/bitcoind/testing.js";
import { bytesToHex } from "../src/bytes.js";
import type { ClientStoreAdapter } from "../src/types.js";
import type { RpcBlock } from "../src/bitcoind/types.js";

const noopStore: ClientStoreAdapter = {
  async loadTip() {
    return null;
  },
  async loadLatestSnapshot() {
    return null;
  },
  async loadLatestCheckpointAtOrBelow() {
    return null;
  },
  async loadBlockRecordsAfter() {
    return [];
  },
  async writeAppliedBlock() {},
  async deleteBlockRecordsAbove() {},
  async loadBlockRecord() {
    return null;
  },
  async close() {},
};

test("bitcoin loader resolves bitcoind and bitcoin-cli paths", async () => {
  const [bitcoindPath, bitcoinCliPath] = await Promise.all([
    getBitcoindPath(),
    getBitcoinCliPath(),
  ]);

  assert.equal(basename(bitcoindPath), process.platform === "win32" ? "bitcoind.exe" : "bitcoind");
  assert.equal(basename(bitcoinCliPath), process.platform === "win32" ? "bitcoin-cli.exe" : "bitcoin-cli");
});

test("bitcoind args stay local-only and datadir-scoped", () => {
  const args = buildBitcoindArgsForTesting(
    {
      store: noopStore,
      dataDir: "/tmp/cogcoin-client-bitcoind",
      chain: "regtest",
      startHeight: 0,
    },
    18443,
    28332,
    18444,
  );

  assert.ok(args.includes("-nosettings=1"));
  assert.ok(args.includes("-server=1"));
  assert.ok(args.includes("-disablewallet=1"));
  assert.ok(args.includes("-prune=0"));
  assert.ok(args.includes("-dnsseed=1"));
  assert.ok(args.includes("-listen=0"));
  assert.ok(args.includes("-chain=regtest"));
  assert.ok(args.includes("-rpcbind=127.0.0.1"));
  assert.ok(args.includes("-rpcallowip=127.0.0.1"));
  assert.ok(args.includes("-rpcport=18443"));
  assert.ok(args.includes("-port=18444"));
  assert.ok(args.includes("-zmqpubhashblock=tcp://127.0.0.1:28332"));
  assert.ok(args.includes("-datadir=/tmp/cogcoin-client-bitcoind"));
});

test("default managed bitcoind datadir matches Cogcoin app-data conventions", () => {
  assert.equal(
    resolveDefaultBitcoindDataDirForTesting({
      platform: "darwin",
      homeDirectory: "/Users/cogtoshi",
      env: {},
    }),
    "/Users/cogtoshi/Library/Application Support/Cogcoin/bitcoin",
  );

  assert.equal(
    resolveDefaultBitcoindDataDirForTesting({
      platform: "linux",
      homeDirectory: "/home/cogtoshi",
      env: {},
    }),
    "/home/cogtoshi/.local/share/cogcoin/bitcoin",
  );

  assert.equal(
    resolveDefaultBitcoindDataDirForTesting({
      platform: "win32",
      homeDirectory: "C:\\Users\\Cogtoshi",
      env: {
        LOCALAPPDATA: "C:\\Users\\Cogtoshi\\AppData\\Local",
      },
    }),
    "C:\\Users\\Cogtoshi\\AppData\\Local\\Cogcoin\\bitcoin",
  );
});

test("normalizeRpcBlock preserves hashes, prevout scripts, and satoshi values", () => {
  const rpcBlock: RpcBlock = {
    hash: "11".repeat(32),
    previousblockhash: "22".repeat(32),
    height: 42,
    tx: [
      {
        txid: "33".repeat(32),
        vin: [
          {
            txid: "44".repeat(32),
            prevout: {
              scriptPubKey: {
                hex: "51",
              },
            },
          },
        ],
        vout: [
          {
            value: "0.12345678",
            n: 0,
            scriptPubKey: {
              hex: "0014" + "aa".repeat(20),
            },
          },
        ],
      },
    ],
  };

  const normalized = normalizeRpcBlock(rpcBlock);

  assert.equal(normalized.height, 42);
  assert.equal(bytesToHex(normalized.hash), rpcBlock.hash);
  assert.equal(bytesToHex(normalized.previousHash ?? new Uint8Array()), rpcBlock.previousblockhash);
  assert.equal(bytesToHex(normalized.transactions[0]?.txid ?? new Uint8Array()), rpcBlock.tx[0]?.txid);
  assert.equal(
    bytesToHex(normalized.transactions[0]?.inputs[0]?.prevoutScriptPubKey ?? new Uint8Array()),
    "51",
  );
  assert.equal(normalized.transactions[0]?.outputs[0]?.valueSats, 12_345_678n);
  assert.equal(
    bytesToHex(normalized.transactions[0]?.outputs[0]?.scriptPubKey ?? new Uint8Array()),
    "0014" + "aa".repeat(20),
  );
});

test("node validation rejects wrong network, prune mode, and missing ZMQ", async () => {
  await assert.rejects(
    () =>
      validateNodeConfigForTesting(
        {
          async getBlockchainInfo() {
            return {
              chain: "regtest",
              blocks: 0,
              headers: 0,
              bestblockhash: "00".repeat(32),
              pruned: false,
            };
          },
          async getZmqNotifications() {
            return [
              {
                type: "pubhashblock",
                address: "tcp://127.0.0.1:28332",
                hwm: 1000,
              },
            ];
          },
        } as never,
        "main",
        "tcp://127.0.0.1:28332",
      ),
    /bitcoind_chain_expected_main_got_regtest/,
  );

  await assert.rejects(
    () =>
      validateNodeConfigForTesting(
        {
          async getBlockchainInfo() {
            return {
              chain: "main",
              blocks: 0,
              headers: 0,
              bestblockhash: "00".repeat(32),
              pruned: true,
            };
          },
          async getZmqNotifications() {
            return [
              {
                type: "pubhashblock",
                address: "tcp://127.0.0.1:28332",
                hwm: 1000,
              },
            ];
          },
        } as never,
        "main",
        "tcp://127.0.0.1:28332",
      ),
    /bitcoind_pruned_unsupported/,
  );

  await assert.rejects(
    () =>
      validateNodeConfigForTesting(
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
          async getZmqNotifications() {
            return [];
          },
        } as never,
        "main",
        "tcp://127.0.0.1:28332",
      ),
    /bitcoind_zmq_hashblock_missing/,
  );
});
