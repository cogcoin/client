import assert from "node:assert/strict";
import test from "node:test";

import { loadBundledGenesisParameters } from "@cogcoin/indexer";

import type { BitcoinBlock, ClientCheckpoint, ClientTip, StoredBlockRecord } from "../src/types.js";
import { internalBytesToDisplayHashHex } from "../src/bitcoind/hash-order.js";
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

function createRetryableRpcWarmup(method: string): Error {
  return new Error(`bitcoind_rpc_${method}_-28_Verifying blocks…`);
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

function hashForHeight(height: number): string {
  return `${height.toString(16).padStart(2, "0")}`.repeat(32);
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
  initialTip?: ClientTip | null;
  targetHeightCap?: number | null;
  getblockArchiveEndHeight?: number | null;
  validate?: () => Promise<void>;
  ensureReady?: (
    indexedTip: ClientTip | null,
    expectedChain: "main" | "regtest",
    options?: {
      signal?: AbortSignal;
      retryState?: unknown;
      resumeDisplayMode?: "sync" | "follow";
    },
  ) => Promise<void>;
  cleanupObsoleteSnapshotFilesIfNeeded?: () => Promise<boolean>;
  getBlockchainInfo: () => Promise<RpcBlockchainInfo>;
  getBlockHash?: (height: number) => Promise<string>;
  getBlock?: (hash: string) => Promise<RpcBlock>;
  loadBlockRecord?: (height: number) => Promise<StoredBlockRecord | null>;
  loadLatestCheckpointAtOrBelow?: (height: number) => Promise<ClientCheckpoint | null>;
  rewindToHeight?: (height: number) => Promise<ClientTip | null>;
  restoreCheckpoint?: (checkpoint: ClientCheckpoint) => Promise<ClientTip>;
  resetToInitialState?: () => Promise<null>;
  isFollowing?: boolean;
  loadVisibleFollowBlockTimes?: (tip: ClientTip | null) => Promise<Record<number, number>>;
}) {
  let tip: ClientTip | null = options.initialTip ?? null;
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
            blockHashHex: internalBytesToDisplayHashHex(block.hash),
            previousHashHex: block.previousHash === null ? null : internalBytesToDisplayHashHex(block.previousHash),
            stateHashHex: null,
          };
          appliedHeights.push(block.height);
          return {} as never;
        },
        async rewindToHeight(height: number) {
          if (!options.rewindToHeight) {
            return tip;
          }

          tip = await options.rewindToHeight(height);
          return tip;
        },
        async restoreCheckpoint(checkpoint: ClientCheckpoint): Promise<ClientTip> {
          if (!options.restoreCheckpoint) {
            const restoredTip = {
              height: checkpoint.height,
              blockHashHex: checkpoint.blockHashHex,
              previousHashHex: null,
              stateHashHex: null,
            };
            tip = restoredTip;
            return restoredTip;
          }

          const restoredTip = await options.restoreCheckpoint(checkpoint);
          tip = restoredTip;
          return restoredTip;
        },
        async resetToInitialState(): Promise<null> {
          if (!options.resetToInitialState) {
            tip = null;
            return null;
          }

          await options.resetToInitialState();
          tip = null;
          return null;
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
        async loadLatestCheckpointAtOrBelow(height: number) {
          return await (options.loadLatestCheckpointAtOrBelow?.(height) ?? Promise.resolve(null));
        },
        async loadBlockRecordsAfter() {
          return [];
        },
        async writeAppliedBlock() {},
        async deleteBlockRecordsAbove() {},
        async loadBlockRecord(height: number) {
          return await (options.loadBlockRecord?.(height) ?? Promise.resolve(null));
        },
        async close() {},
      },
      node: {
        expectedChain: "main",
        getblockArchiveEndHeight: options.getblockArchiveEndHeight ?? null,
        getblockArchiveSha256: options.getblockArchiveEndHeight === undefined || options.getblockArchiveEndHeight === null
          ? null
          : "ab".repeat(32),
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
        async cleanupObsoleteSnapshotFilesIfNeeded() {
          return await (options.cleanupObsoleteSnapshotFilesIfNeeded?.() ?? Promise.resolve(false));
        },
        async ensureReady(
          indexedTip: ClientTip | null,
          expectedChain: "main" | "regtest",
          ensureOptions?: {
            signal?: AbortSignal;
            retryState?: unknown;
            resumeDisplayMode?: "sync" | "follow";
          },
        ) {
          await (options.ensureReady?.(indexedTip, expectedChain, ensureOptions) ?? Promise.resolve());
        },
      },
      startHeight: options.startHeight,
      targetHeightCap: options.targetHeightCap ?? null,
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

test("syncToTip probes snapshot cleanup at startup and before a successful return", async () => {
  const events: string[] = [];
  let cleanupCalls = 0;
  const { dependencies, appliedHeights } = createSyncDependencies({
    startHeight: 100,
    ensureReady: async () => {
      events.push("ensureReady");
    },
    cleanupObsoleteSnapshotFilesIfNeeded: async () => {
      cleanupCalls += 1;
      events.push(`cleanup:${cleanupCalls}`);
      return cleanupCalls === 2;
    },
    async getBlockchainInfo() {
      return createBlockchainInfo(100, 100);
    },
    async getBlock(hash: string) {
      return createRpcBlock(100, hash, "63".repeat(32));
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.equal(result.endingHeight, 100);
  assert.deepEqual(appliedHeights, [100]);
  assert.deepEqual(events, ["cleanup:1", "ensureReady", "cleanup:2"]);
});

test("syncToTip removes the obsolete snapshot on a later natural rerun when the probe flips", async () => {
  const cleanupResults = [false, false, true, false];
  const events: string[] = [];
  const { dependencies } = createSyncDependencies({
    startHeight: 100,
    cleanupObsoleteSnapshotFilesIfNeeded: async () => {
      const next = cleanupResults.shift() ?? false;
      events.push(`cleanup:${next ? "removed" : "kept"}`);
      return next;
    },
    async getBlockchainInfo() {
      return createBlockchainInfo(99, 99);
    },
  });

  const first = await syncToTip(dependencies as never);
  const second = await syncToTip(dependencies as never);

  assert.equal(first.bestHeight, 99);
  assert.equal(second.bestHeight, 99);
  assert.deepEqual(events, [
    "cleanup:kept",
    "cleanup:kept",
    "cleanup:removed",
    "cleanup:kept",
  ]);
});

test("syncToTip ignores snapshot cleanup probe failures", async () => {
  let cleanupCalls = 0;
  const { dependencies } = createSyncDependencies({
    startHeight: 1,
    cleanupObsoleteSnapshotFilesIfNeeded: async () => {
      cleanupCalls += 1;
      throw new Error("cleanup failed");
    },
    async getBlockchainInfo() {
      return createBlockchainInfo(0);
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.equal(result.bestHeight, 0);
  assert.equal(cleanupCalls, 2);
});

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

test("syncToTip retries a transient raw Core warmup error during bitcoin sync polling", async () => {
  let blockchainInfoCalls = 0;
  const { dependencies, phases, messages, lastErrors } = createSyncDependencies({
    startHeight: 1,
    async getBlockchainInfo() {
      blockchainInfoCalls += 1;

      if (blockchainInfoCalls === 1) {
        throw createRetryableRpcWarmup("getblockchaininfo");
      }

      return createBlockchainInfo(0);
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.equal(result.appliedBlocks, 0);
  assert.equal(result.bestHeight, 0);
  assert.ok(blockchainInfoCalls >= 2);
  assert.ok(messages.includes("Managed Bitcoin RPC temporarily unavailable; retrying until canceled."));
  assert.equal(lastErrors[0], "bitcoind_rpc_getblockchaininfo_-28_Verifying blocks…");
  assert.equal(phases.includes("error"), false);
});

test("syncToTip suppresses follow_tip when resuming an indexed tip during sync", async () => {
  const resumeDisplayModes: Array<"sync" | "follow" | undefined> = [];
  const { dependencies, appliedHeights, phases } = createSyncDependencies({
    startHeight: 100,
    initialTip: {
      height: 100,
      blockHashHex: "64".repeat(32),
      previousHashHex: "63".repeat(32),
      stateHashHex: null,
    },
    ensureReady: async (_indexedTip, _expectedChain, options) => {
      resumeDisplayModes.push(options?.resumeDisplayMode);
    },
    async getBlockchainInfo() {
      return createBlockchainInfo(101, 101);
    },
    async getBlock(hash: string) {
      return createRpcBlock(101, hash, "64".repeat(32));
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.deepEqual(resumeDisplayModes, ["sync"]);
  assert.deepEqual(appliedHeights, [101]);
  assert.equal(result.endingHeight, 101);
  assert.equal(phases.includes("follow_tip"), false);
  assert.deepEqual(phases, [
    "cogcoin_sync",
    "cogcoin_sync",
    "complete",
  ]);
});

test("syncToTip still uses follow_tip when resuming an indexed tip during follow mode", async () => {
  const resumeDisplayModes: Array<"sync" | "follow" | undefined> = [];
  const { dependencies, phases } = createSyncDependencies({
    startHeight: 100,
    initialTip: {
      height: 100,
      blockHashHex: "64".repeat(32),
      previousHashHex: "63".repeat(32),
      stateHashHex: null,
    },
    isFollowing: true,
    ensureReady: async (indexedTip, _expectedChain, options) => {
      resumeDisplayModes.push(options?.resumeDisplayMode);
      if (options?.resumeDisplayMode === "follow" && indexedTip !== null) {
        await dependencies.progress.setPhase("follow_tip", {
          blocks: indexedTip.height,
          targetHeight: indexedTip.height,
          message: "Resuming from the persisted Cogcoin indexed tip.",
        });
      }
    },
    async getBlockchainInfo() {
      return createBlockchainInfo(100, 100);
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.deepEqual(resumeDisplayModes, ["follow"]);
  assert.equal(result.endingHeight, 100);
  assert.ok(phases.includes("follow_tip"));
  assert.equal(phases.at(-1), "follow_tip");
});

test("syncToTip keeps the progress phase on cogcoin_sync while Bitcoin advances during replay", async () => {
  const blockchainInfoSequence = [
    createBlockchainInfo(100),
    createBlockchainInfo(101),
    createBlockchainInfo(101),
    createBlockchainInfo(101),
  ];
  let blockchainInfoIndex = 0;

  const { dependencies, appliedHeights, phases } = createSyncDependencies({
    startHeight: 100,
    async getBlockchainInfo() {
      const info = blockchainInfoSequence[Math.min(blockchainInfoIndex, blockchainInfoSequence.length - 1)]!;
      blockchainInfoIndex += 1;
      return info;
    },
    async getBlock(hash: string) {
      const height = Number.parseInt(hash.slice(0, 2), 16);
      const previousHeight = height - 1;
      return createRpcBlock(
        height,
        hash,
        previousHeight >= 100 ? `${previousHeight.toString(16).padStart(2, "0")}`.repeat(32) : undefined,
      );
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.deepEqual(appliedHeights, [100, 101]);
  assert.equal(result.endingHeight, 101);
  assert.equal(phases.includes("bitcoin_sync"), false);
  assert.deepEqual(phases, [
    "cogcoin_sync",
    "cogcoin_sync",
    "cogcoin_sync",
    "cogcoin_sync",
    "complete",
  ]);
});

test("syncToTip does not immediately flip back to bitcoin_sync when Cogcoin just caught up to the current block tip", async () => {
  const blockchainInfoSequence = [
    createBlockchainInfo(100, 101),
    createBlockchainInfo(100, 101),
    createBlockchainInfo(101, 101),
    createBlockchainInfo(101, 101),
  ];
  let blockchainInfoIndex = 0;

  const { dependencies, appliedHeights, phases } = createSyncDependencies({
    startHeight: 100,
    async getBlockchainInfo() {
      const info = blockchainInfoSequence[Math.min(blockchainInfoIndex, blockchainInfoSequence.length - 1)]!;
      blockchainInfoIndex += 1;
      return info;
    },
    async getBlock(hash: string) {
      const height = Number.parseInt(hash.slice(0, 2), 16);
      const previousHeight = height - 1;
      return createRpcBlock(
        height,
        hash,
        previousHeight >= 100 ? `${previousHeight.toString(16).padStart(2, "0")}`.repeat(32) : undefined,
      );
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.deepEqual(appliedHeights, [100, 101]);
  assert.equal(result.endingHeight, 101);
  assert.deepEqual(phases, [
    "cogcoin_sync",
    "cogcoin_sync",
    "cogcoin_sync",
    "cogcoin_sync",
    "complete",
  ]);
});

test("syncToTip does not re-enter bitcoin_sync during a brief idle poll before the next replay block arrives", async () => {
  const blockchainInfoSequence = [
    createBlockchainInfo(100, 101),
    createBlockchainInfo(100, 101),
    createBlockchainInfo(100, 101),
    createBlockchainInfo(101, 101),
    createBlockchainInfo(101, 101),
    createBlockchainInfo(101, 101),
  ];
  let blockchainInfoIndex = 0;

  const { dependencies, appliedHeights, phases } = createSyncDependencies({
    startHeight: 100,
    progressPhase: "cogcoin_sync",
    initialTip: {
      height: 100,
      blockHashHex: "64".repeat(32),
      previousHashHex: "63".repeat(32),
      stateHashHex: null,
    },
    async getBlockchainInfo() {
      const info = blockchainInfoSequence[Math.min(blockchainInfoIndex, blockchainInfoSequence.length - 1)]!;
      blockchainInfoIndex += 1;
      return info;
    },
    async getBlock(hash: string) {
      const height = Number.parseInt(hash.slice(0, 2), 16);
      const previousHeight = height - 1;
      return createRpcBlock(
        height,
        hash,
        previousHeight >= 100 ? `${previousHeight.toString(16).padStart(2, "0")}`.repeat(32) : undefined,
      );
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.deepEqual(appliedHeights, [101]);
  assert.equal(result.endingHeight, 101);
  assert.equal(phases.includes("bitcoin_sync"), false);
  assert.deepEqual(phases, [
    "cogcoin_sync",
    "cogcoin_sync",
    "complete",
  ]);
});

test("syncToTip does not emit complete for an internal capped pass", async () => {
  const { dependencies, appliedHeights, phases } = createSyncDependencies({
    startHeight: 100,
    targetHeightCap: 100,
    async getBlockchainInfo() {
      return createBlockchainInfo(100, 101);
    },
    async getBlock(hash: string) {
      return createRpcBlock(100, hash, "63".repeat(32));
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.deepEqual(appliedHeights, [100]);
  assert.equal(result.endingHeight, 100);
  assert.equal(result.bestHeight, 100);
  assert.equal(phases.includes("complete"), false);
  assert.deepEqual(phases, [
    "cogcoin_sync",
    "cogcoin_sync",
  ]);
});

test("syncToTip waits for a capped boundary target instead of returning at the current Bitcoin height", async () => {
  const blockchainInfoSequence = [
    createBlockchainInfo(120, 120),
    createBlockchainInfo(120, 120),
    createBlockchainInfo(150, 150),
    createBlockchainInfo(150, 150),
  ];
  let blockchainInfoIndex = 0;

  const { dependencies, appliedHeights, phases } = createSyncDependencies({
    startHeight: 100,
    targetHeightCap: 150,
    initialTip: {
      height: 119,
      blockHashHex: "77".repeat(32),
      previousHashHex: "76".repeat(32),
      stateHashHex: null,
    },
    async getBlockchainInfo() {
      const info = blockchainInfoSequence[Math.min(blockchainInfoIndex, blockchainInfoSequence.length - 1)]!;
      blockchainInfoIndex += 1;
      return info;
    },
    async getBlock(hash: string) {
      const height = Number.parseInt(hash.slice(0, 2), 16);
      const previousHeight = height - 1;
      return createRpcBlock(
        height,
        hash,
        previousHeight >= 100 ? `${previousHeight.toString(16).padStart(2, "0")}`.repeat(32) : undefined,
      );
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.equal(result.endingHeight, 150);
  assert.equal(result.bestHeight, 150);
  assert.equal(phases.includes("complete"), false);
  assert.deepEqual(appliedHeights, Array.from({ length: 31 }, (_, index) => 120 + index));
});

test("syncToTip does not alternate between bitcoin_sync and follow_tip across capped sync passes", async () => {
  const resumeDisplayModes: Array<"sync" | "follow" | undefined> = [];
  const { dependencies, appliedHeights, phases } = createSyncDependencies({
    startHeight: 100,
    initialTip: {
      height: 100,
      blockHashHex: "64".repeat(32),
      previousHashHex: "63".repeat(32),
      stateHashHex: null,
    },
    targetHeightCap: 101,
    ensureReady: async (_indexedTip, _expectedChain, options) => {
      resumeDisplayModes.push(options?.resumeDisplayMode);
    },
    async getBlockchainInfo() {
      return createBlockchainInfo(101, 102);
    },
    async getBlock(hash: string) {
      return createRpcBlock(101, hash, "64".repeat(32));
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.deepEqual(resumeDisplayModes, ["sync"]);
  assert.deepEqual(appliedHeights, [101]);
  assert.equal(result.endingHeight, 101);
  assert.equal(phases.includes("follow_tip"), false);
  assert.deepEqual(phases, [
    "cogcoin_sync",
    "cogcoin_sync",
  ]);
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

test("syncToTip waits for getblock archive import before normal bitcoin sync", async () => {
  let blockchainInfoCalls = 0;
  const { dependencies, phases, messages } = createSyncDependencies({
    startHeight: 950_000,
    getblockArchiveEndHeight: 945_188,
    async getBlockchainInfo() {
      blockchainInfoCalls += 1;

      if (blockchainInfoCalls === 1) {
        return createBlockchainInfo(945_180, 945_188);
      }

      return createBlockchainInfo(945_188, 945_188);
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.equal(result.appliedBlocks, 0);
  assert.ok(phases.includes("getblock_archive_import"));
  assert.ok(phases.includes("bitcoin_sync"));
  assert.ok(messages.includes("Bitcoin Core is importing getblock range blocks."));
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

test("syncToTip restores the newest matching checkpoint when retained rewind history is exhausted", async () => {
  const checkpointBounds: number[] = [];
  const restoredHeights: number[] = [];
  const checkpoints: ClientCheckpoint[] = [
    { height: 104, blockHashHex: "ee".repeat(32), stateBytes: new Uint8Array(), createdAt: 3 },
    { height: 102, blockHashHex: hashForHeight(102), stateBytes: new Uint8Array(), createdAt: 2 },
    { height: 100, blockHashHex: hashForHeight(100), stateBytes: new Uint8Array(), createdAt: 1 },
  ];
  const { dependencies, appliedHeights, messages } = createSyncDependencies({
    startHeight: 100,
    initialTip: {
      height: 105,
      blockHashHex: "ff".repeat(32),
      previousHashHex: hashForHeight(104),
      stateHashHex: null,
    },
    async getBlockchainInfo() {
      return createBlockchainInfo(105);
    },
    async getBlockHash(height: number) {
      return hashForHeight(height);
    },
    async getBlock(hash: string) {
      const height = Number.parseInt(hash.slice(0, 2), 16);
      return createRpcBlock(height, hash, height > 100 ? hashForHeight(height - 1) : undefined);
    },
    async loadBlockRecord(height: number) {
      assert.equal(height, 104);
      return null;
    },
    async loadLatestCheckpointAtOrBelow(height: number) {
      checkpointBounds.push(height);
      return checkpoints.find((checkpoint) => checkpoint.height <= height) ?? null;
    },
    async restoreCheckpoint(checkpoint: ClientCheckpoint) {
      restoredHeights.push(checkpoint.height);
      return {
        height: checkpoint.height,
        blockHashHex: checkpoint.blockHashHex,
        previousHashHex: null,
        stateHashHex: null,
      };
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.deepEqual(checkpointBounds, [105, 103]);
  assert.deepEqual(restoredHeights, [102]);
  assert.deepEqual(appliedHeights, [103, 104, 105]);
  assert.equal(result.appliedBlocks, 3);
  assert.equal(result.rewoundBlocks, 3);
  assert.equal(result.commonAncestorHeight, 102);
  assert.ok(messages.some((message) => message.includes("restoring checkpoint at height 102")));
});

test("syncToTip resets to the processing start when no persisted checkpoint matches the node chain", async () => {
  const checkpointBounds: number[] = [];
  const resetCalls: number[] = [];
  const checkpoints: ClientCheckpoint[] = [
    { height: 101, blockHashHex: "cc".repeat(32), stateBytes: new Uint8Array(), createdAt: 2 },
    { height: 100, blockHashHex: "bb".repeat(32), stateBytes: new Uint8Array(), createdAt: 1 },
  ];
  const { dependencies, appliedHeights, messages } = createSyncDependencies({
    startHeight: 100,
    initialTip: {
      height: 102,
      blockHashHex: "aa".repeat(32),
      previousHashHex: hashForHeight(101),
      stateHashHex: null,
    },
    async getBlockchainInfo() {
      return createBlockchainInfo(102);
    },
    async getBlockHash(height: number) {
      return hashForHeight(height);
    },
    async getBlock(hash: string) {
      const height = Number.parseInt(hash.slice(0, 2), 16);
      return createRpcBlock(height, hash, height > 100 ? hashForHeight(height - 1) : undefined);
    },
    async loadBlockRecord(height: number) {
      assert.equal(height, 101);
      return null;
    },
    async loadLatestCheckpointAtOrBelow(height: number) {
      checkpointBounds.push(height);
      return checkpoints.find((checkpoint) => checkpoint.height <= height) ?? null;
    },
    async resetToInitialState() {
      resetCalls.push(Date.now());
      return null;
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.deepEqual(checkpointBounds, [102, 100, 99]);
  assert.equal(resetCalls.length, 1);
  assert.deepEqual(appliedHeights, [100, 101, 102]);
  assert.equal(result.appliedBlocks, 3);
  assert.equal(result.rewoundBlocks, 3);
  assert.equal(result.commonAncestorHeight, null);
  assert.ok(messages.some((message) => message.includes("resetting to the processing start and replaying")));
});

test("syncToTip falls back to checkpoint recovery when a shallow rewind still hits a missing block record", async () => {
  const rewindTargets: number[] = [];
  const restoredHeights: number[] = [];
  const checkpoint: ClientCheckpoint = {
    height: 102,
    blockHashHex: hashForHeight(102),
    stateBytes: new Uint8Array(),
    createdAt: 1,
  };
  const { dependencies, appliedHeights } = createSyncDependencies({
    startHeight: 100,
    initialTip: {
      height: 103,
      blockHashHex: "ff".repeat(32),
      previousHashHex: hashForHeight(102),
      stateHashHex: null,
    },
    async getBlockchainInfo() {
      return createBlockchainInfo(103);
    },
    async getBlockHash(height: number) {
      return hashForHeight(height);
    },
    async getBlock(hash: string) {
      const height = Number.parseInt(hash.slice(0, 2), 16);
      return createRpcBlock(height, hash, height > 100 ? hashForHeight(height - 1) : undefined);
    },
    async loadBlockRecord(height: number) {
      if (height !== 102) {
        return null;
      }

      return {
        height,
        blockHashHex: hashForHeight(height),
        previousHashHex: hashForHeight(height - 1),
        stateHashHex: null,
        recordBytes: new Uint8Array(),
        createdAt: 1,
      };
    },
    async loadLatestCheckpointAtOrBelow(height: number) {
      return height >= checkpoint.height ? checkpoint : null;
    },
    async rewindToHeight(height: number) {
      rewindTargets.push(height);
      throw new Error("client_store_missing_block_record_103");
    },
    async restoreCheckpoint(restoredCheckpoint: ClientCheckpoint) {
      restoredHeights.push(restoredCheckpoint.height);
      return {
        height: restoredCheckpoint.height,
        blockHashHex: restoredCheckpoint.blockHashHex,
        previousHashHex: null,
        stateHashHex: null,
      };
    },
  });

  const result = await syncToTip(dependencies as never);

  assert.deepEqual(rewindTargets, [102]);
  assert.deepEqual(restoredHeights, [102]);
  assert.deepEqual(appliedHeights, [103]);
  assert.equal(result.appliedBlocks, 1);
  assert.equal(result.rewoundBlocks, 1);
  assert.equal(result.commonAncestorHeight, 102);
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
