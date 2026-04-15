import assert from "node:assert/strict";
import test from "node:test";

import { loadBundledGenesisParameters } from "@cogcoin/indexer";

import type { BitcoinBlock, ClientTip } from "../src/types.js";
import { syncToTip } from "../src/bitcoind/client/sync-engine.js";
import { createBlockRateTracker } from "../src/bitcoind/client/internal-types.js";
import { createBootstrapProgressForTesting, DEFAULT_SNAPSHOT_METADATA } from "../src/bitcoind/testing.js";
import type {
  BootstrapPhase,
  BootstrapProgress,
  RpcBlock,
  RpcBlockchainInfo,
} from "../src/bitcoind/types.js";

function createRetryableRpcTimeout(method: string): Error {
  return new Error(
    `The managed Bitcoin RPC request to 127.0.0.1:8332 for ${method} failed: The operation was aborted due to timeout.`,
  );
}

function createBlockchainInfo(blocks: number, headers = blocks): RpcBlockchainInfo {
  return {
    chain: "main",
    blocks,
    headers,
    bestblockhash: "ff".repeat(32),
    pruned: false,
  };
}

function createRpcBlock(height: number, hash: string, previousblockhash?: string): RpcBlock {
  return {
    hash,
    previousblockhash,
    height,
    time: 1_700_000_000 + height,
    tx: [{
      txid: `${height.toString(16).padStart(2, "0")}`.repeat(32),
      vin: [{
        prevout: {
          scriptPubKey: { hex: "51" },
        },
      }],
      vout: [{
        n: 0,
        value: 50,
        scriptPubKey: { hex: "51" },
      }],
    }],
  };
}

function createProgressRecorder(initialPhase: BootstrapPhase = "paused"): {
  progress: {
    setPhase(phase: BootstrapPhase, patch?: Partial<Omit<BootstrapProgress, "phase" | "updatedAt">>): Promise<void>;
    setCogcoinSync(height: number | null, targetHeight: number | null, etaSeconds?: number | null): Promise<void>;
    getStatusSnapshot(): {
      bootstrapPhase: BootstrapPhase;
      bootstrapProgress: BootstrapProgress;
      cogcoinSyncHeight: number | null;
      cogcoinSyncTargetHeight: number | null;
      currentQuote: null;
      snapshot: typeof DEFAULT_SNAPSHOT_METADATA;
    };
    replaceFollowBlockTimes(blockTimesByHeight: Record<number, number>): void;
    setFollowBlockTime(height: number, blockTime: number): void;
  };
  phases: BootstrapPhase[];
  messages: string[];
  lastErrors: Array<string | null>;
} {
  let bootstrapPhase = initialPhase;
  let bootstrapProgress = createBootstrapProgressForTesting(initialPhase, DEFAULT_SNAPSHOT_METADATA);
  let cogcoinSyncHeight: number | null = null;
  let cogcoinSyncTargetHeight: number | null = null;
  const phases: BootstrapPhase[] = [];
  const messages: string[] = [];
  const lastErrors: Array<string | null> = [];

  return {
    progress: {
      async setPhase(phase, patch = {}) {
        bootstrapPhase = phase;
        bootstrapProgress = {
          ...bootstrapProgress,
          ...patch,
          phase,
          updatedAt: Date.now(),
          message: patch.message ?? bootstrapProgress.message,
        };
        if (phase !== "cogcoin_sync" && phase !== "follow_tip") {
          cogcoinSyncHeight = null;
          cogcoinSyncTargetHeight = null;
        }
        phases.push(phase);
        messages.push(bootstrapProgress.message);
        lastErrors.push(bootstrapProgress.lastError);
      },
      async setCogcoinSync(height, targetHeight, etaSeconds = null) {
        bootstrapPhase = "cogcoin_sync";
        cogcoinSyncHeight = height;
        cogcoinSyncTargetHeight = targetHeight;
        bootstrapProgress = {
          ...bootstrapProgress,
          phase: "cogcoin_sync",
          etaSeconds,
          lastError: null,
          updatedAt: Date.now(),
          message: "Applying blocks to the local Cogcoin index.",
        };
        phases.push("cogcoin_sync");
        messages.push(bootstrapProgress.message);
        lastErrors.push(bootstrapProgress.lastError);
      },
      getStatusSnapshot() {
        return {
          bootstrapPhase,
          bootstrapProgress: { ...bootstrapProgress },
          cogcoinSyncHeight,
          cogcoinSyncTargetHeight,
          currentQuote: null,
          snapshot: DEFAULT_SNAPSHOT_METADATA,
        };
      },
      replaceFollowBlockTimes() {},
      setFollowBlockTime() {},
    },
    phases,
    messages,
    lastErrors,
  };
}

function createSyncDependencies(options: {
  startHeight: number;
  progressPhase?: BootstrapPhase;
  validate?: () => Promise<void>;
  ensureReady?: () => Promise<void>;
  getBlockchainInfo: () => Promise<RpcBlockchainInfo>;
  getBlockHash?: (height: number) => Promise<string>;
  getBlock?: (hash: string) => Promise<RpcBlock>;
  isFollowing?: boolean;
  loadVisibleFollowBlockTimes?: (tip: ClientTip | null) => Promise<Record<number, number>>;
}) {
  let tip: ClientTip | null = null;
  const appliedHeights: number[] = [];
  const { progress, phases, messages, lastErrors } = createProgressRecorder(options.progressPhase);

  return {
    appliedHeights,
    phases,
    messages,
    lastErrors,
    dependencies: {
      client: {
        async getTip() {
          return tip;
        },
        async getState() {
          return {} as never;
        },
        async applyBlock(block: BitcoinBlock) {
          tip = {
            height: block.height,
            blockHashHex: Buffer.from(block.hash).toString("hex"),
            previousHashHex: block.previousHash === null ? null : Buffer.from(block.previousHash).toString("hex"),
            stateHashHex: null,
          };
          appliedHeights.push(block.height);
          return {} as never;
        },
        async rewindToHeight() {
          return tip;
        },
        async close() {},
      },
      store: {
        async loadTip() {
          return tip;
        },
        async loadLatestSnapshot() {
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
      },
      node: {
        expectedChain: "main",
        async validate() {
          await (options.validate?.() ?? Promise.resolve());
        },
      },
      rpc: {
        getBlockchainInfo: options.getBlockchainInfo,
        async getBlockHash(height: number) {
          if (!options.getBlockHash) {
            return `${height.toString(16).padStart(2, "0")}`.repeat(32);
          }

          return options.getBlockHash(height);
        },
        async getBlock(hash: string) {
          if (!options.getBlock) {
            throw new Error(`unexpected getBlock(${hash})`);
          }

          return options.getBlock(hash);
        },
      },
      progress,
      bootstrap: {
        async ensureReady() {
          await (options.ensureReady?.() ?? Promise.resolve());
        },
      },
      startHeight: options.startHeight,
      bitcoinRateTracker: createBlockRateTracker(),
      cogcoinRateTracker: createBlockRateTracker(),
      abortSignal: undefined,
      isFollowing() {
        return options.isFollowing ?? false;
      },
      async loadVisibleFollowBlockTimes(tipValue: ClientTip | null) {
        return await (options.loadVisibleFollowBlockTimes?.(tipValue) ?? Promise.resolve({}));
      },
    },
  };
}

test("syncToTip retries a transient managed RPC timeout during bitcoin sync polling", async () => {
  let blockchainInfoCalls = 0;
  const { dependencies, phases, messages, lastErrors } = createSyncDependencies({
    startHeight: 1,
    async getBlockchainInfo() {
      blockchainInfoCalls += 1;

      if (blockchainInfoCalls === 1) {
        throw createRetryableRpcTimeout("getblockchaininfo");
      }

      return createBlockchainInfo(0);
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.equal(result.appliedBlocks, 0);
  assert.equal(result.bestHeight, 0);
  assert.ok(messages.includes("Managed Bitcoin RPC temporarily unavailable; retrying until canceled."));
  assert.match(lastErrors[0] ?? "", /getblockchaininfo failed/);
  assert.equal(phases.includes("error"), false);
});

test("syncToTip stays idle while Bitcoin Core remains below the Cogcoin genesis height", async () => {
  const genesis = await loadBundledGenesisParameters();
  const { dependencies, appliedHeights, phases } = createSyncDependencies({
    startHeight: genesis.genesisBlock,
    async getBlockchainInfo() {
      return createBlockchainInfo(genesis.genesisBlock - 1);
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.equal(result.appliedBlocks, 0);
  assert.equal(result.bestHeight, genesis.genesisBlock - 1);
  assert.deepEqual(appliedHeights, []);
  assert.equal(phases.includes("cogcoin_sync"), false);
});

test("syncToTip begins Cogcoin processing exactly at the bundled genesis height", async () => {
  const genesis = await loadBundledGenesisParameters();
  const genesisHash = "33".repeat(32);
  const previousHash = "22".repeat(32);
  const { dependencies, appliedHeights, phases } = createSyncDependencies({
    startHeight: genesis.genesisBlock,
    async getBlockchainInfo() {
      return createBlockchainInfo(genesis.genesisBlock);
    },
    async getBlockHash(height: number) {
      assert.equal(height, genesis.genesisBlock);
      return genesisHash;
    },
    async getBlock(hash: string) {
      assert.equal(hash, genesisHash);
      return createRpcBlock(genesis.genesisBlock, genesisHash, previousHash);
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.equal(result.appliedBlocks, 1);
  assert.deepEqual(appliedHeights, [genesis.genesisBlock]);
  assert.equal(phases.includes("cogcoin_sync"), true);
});

test("syncToTip retries a transient getblock timeout without duplicating applied work", async () => {
  const hashByHeight = new Map([
    [1, "11".repeat(32)],
    [2, "22".repeat(32)],
  ]);
  const blockByHash = new Map([
    ["11".repeat(32), createRpcBlock(1, "11".repeat(32), "00".repeat(32))],
    ["22".repeat(32), createRpcBlock(2, "22".repeat(32), "11".repeat(32))],
  ]);
  let blockchainInfoCalls = 0;
  let block2Calls = 0;
  const { dependencies, appliedHeights, phases } = createSyncDependencies({
    startHeight: 1,
    async getBlockchainInfo() {
      blockchainInfoCalls += 1;
      return createBlockchainInfo(2);
    },
    async getBlockHash(height: number) {
      return hashByHeight.get(height) ?? "00".repeat(32);
    },
    async getBlock(hash: string) {
      if (hash === "22".repeat(32)) {
        block2Calls += 1;

        if (block2Calls === 1) {
          throw createRetryableRpcTimeout("getblock");
        }
      }

      const block = blockByHash.get(hash);

      if (!block) {
        throw new Error(`missing block ${hash}`);
      }

      return block;
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.equal(result.appliedBlocks, 2);
  assert.deepEqual(appliedHeights, [1, 2]);
  assert.equal(block2Calls, 2);
  assert.equal(phases.includes("error"), false);
  assert.ok(blockchainInfoCalls >= 2);
});

test("syncToTip keeps follow mode alive across a transient RPC timeout", async () => {
  let getBlockchainInfoCalls = 0;
  let visibleBlockCalls = 0;
  const hash = "11".repeat(32);
  const { dependencies, phases, lastErrors } = createSyncDependencies({
    startHeight: 1,
    isFollowing: true,
    async getBlockchainInfo() {
      getBlockchainInfoCalls += 1;
      return createBlockchainInfo(1);
    },
    async getBlockHash() {
      return hash;
    },
    async getBlock() {
      return createRpcBlock(1, hash, "00".repeat(32));
    },
    async loadVisibleFollowBlockTimes() {
      visibleBlockCalls += 1;

      if (visibleBlockCalls === 1) {
        throw createRetryableRpcTimeout("getblockchaininfo");
      }

      return { 1: 1_700_000_001 };
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.equal(result.appliedBlocks, 1);
  assert.ok(getBlockchainInfoCalls >= 2);
  assert.equal(visibleBlockCalls, 2);
  assert.equal(phases.at(-1), "follow_tip");
  assert.equal(lastErrors.at(-1), null);
});

test("syncToTip aborts promptly during retry backoff", async () => {
  const abortController = new AbortController();
  const { dependencies } = createSyncDependencies({
    startHeight: 1,
    async getBlockchainInfo() {
      throw createRetryableRpcTimeout("getblockchaininfo");
    },
  });

  (dependencies as { abortSignal?: AbortSignal }).abortSignal = abortController.signal;
  setTimeout(() => abortController.abort(), 25);

  await assert.rejects(
    async () => syncToTip(dependencies as never),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "AbortError");
      assert.match(error.message, /managed_sync_aborted|This operation was aborted/);
      return true;
    },
  );
});

test("syncToTip still fails immediately on non-retryable managed node errors", async () => {
  const { dependencies, phases, lastErrors } = createSyncDependencies({
    startHeight: 1,
    async getBlockchainInfo() {
      throw new Error("bitcoind_zmq_hashblock_missing");
    },
  });

  await assert.rejects(
    async () => syncToTip(dependencies as never),
    /bitcoind_zmq_hashblock_missing/,
  );

  assert.equal(phases.at(-1), "error");
  assert.equal(lastErrors.at(-1), "bitcoind_zmq_hashblock_missing");
});
