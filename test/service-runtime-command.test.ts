import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli-runner.js";
import type { ManagedBitcoindServiceStatus } from "../src/bitcoind/types.js";

class MemoryStream {
  readonly chunks: string[] = [];
  isTTY = false;

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  toString(): string {
    return this.chunks.join("");
  }
}

function createManagedBitcoindStatus(overrides: Partial<ManagedBitcoindServiceStatus> = {}): ManagedBitcoindServiceStatus {
  return {
    serviceApiVersion: "cogcoin/bitcoind-service/v1",
    binaryVersion: "30.2.0",
    buildId: null,
    serviceInstanceId: "service-instance",
    state: "starting",
    processId: 1234,
    walletRootId: "wallet-root-service",
    chain: "main",
    dataDir: "/tmp/cogcoin-bitcoind",
    runtimeRoot: "/tmp/cogcoin-runtime",
    startHeight: 0,
    rpc: {
      url: "http://127.0.0.1:18443",
      cookieFile: "/tmp/cogcoin-bitcoind/.cookie",
      port: 18443,
    },
    zmq: {
      endpoint: "tcp://127.0.0.1:28332",
      topic: "hashblock",
      rawTxTopic: "rawtx",
      port: 28332,
      pollIntervalMs: 2_000,
    },
    p2pPort: 18444,
    getblockArchiveEndHeight: null,
    getblockArchiveSha256: null,
    walletReplica: null,
    startedAtUnixMs: 1_700_000_000_000,
    heartbeatAtUnixMs: 1_700_000_000_100,
    updatedAtUnixMs: 1_700_000_000_100,
    lastError: "bitcoind_rpc_getblockchaininfo_-28_Loading block index…",
    ...overrides,
  };
}

test("bitcoin status reconciles stale starting status after live RPC readiness", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const startingStatus = createManagedBitcoindStatus();
  const readyStatus = createManagedBitcoindStatus({
    state: "ready",
    heartbeatAtUnixMs: 1_700_000_001_000,
    updatedAtUnixMs: 1_700_000_001_000,
    lastError: null,
  });
  let refreshCalls = 0;
  const progressMessages: string[] = [];

  const code = await runCli(["bitcoin", "status"], {
    stdout,
    stderr,
    resolveDefaultBitcoindDataDir: () => "/tmp/cogcoin-bitcoind",
    loadRawWalletStateEnvelope: async () => null,
    probeManagedBitcoindService: async (options) => {
      await options.rpcReadyProgress?.({
        code: "bitcoind-rpc-ready",
        message: "Bitcoin Core RPC is ready.",
        elapsedMs: 1,
        lastError: null,
      });
      return {
        compatibility: "compatible",
        status: startingStatus,
        error: null,
      };
    },
    refreshManagedBitcoindServiceStatus: async () => {
      refreshCalls += 1;
      return readyStatus;
    },
    createBitcoinRpcClient: () => ({
      getBlockchainInfo: async () => ({
        chain: "main",
        blocks: 948_745,
        headers: 948_745,
        bestblockhash: "aa".repeat(32),
        verificationprogress: 1,
        initialblockdownload: false,
      }),
      getNetworkInfo: async () => ({
        networkactive: true,
        connections: 8,
        connections_in: 1,
        connections_out: 7,
      }),
    }) as never,
  });

  assert.equal(code, 0);
  assert.equal(refreshCalls, 1);
  const output = stdout.toString();
  progressMessages.push(...output.split("\n").filter((line) => line.includes("Bitcoin Core RPC is ready.")));
  assert.deepEqual(progressMessages, ["Bitcoin Core RPC is ready."]);
  assert.match(output, /Service state: ready/u);
  assert.doesNotMatch(output, /Service error: bitcoind_rpc_getblockchaininfo_-28/u);
  assert.equal(stderr.toString(), "");
});
