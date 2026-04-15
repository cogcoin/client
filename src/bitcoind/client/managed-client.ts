import type { BitcoinBlock } from "@cogcoin/indexer/types";

import type { Client, ClientStoreAdapter } from "../../types.js";
import {
  AssumeUtxoBootstrapController,
  deleteGetblockArchiveRange,
  prepareGetblockArchiveRange,
} from "../bootstrap.js";
import type { IndexerDaemonClient } from "../indexer-daemon.js";
import { createRpcClient } from "../node.js";
import type { ManagedProgressController } from "../progress.js";
import type { BitcoinRpcClient } from "../rpc.js";
import {
  attachOrStartManagedBitcoindService,
  stopManagedBitcoindService,
} from "../service.js";
import type {
  ManagedBitcoindClient,
  ManagedBitcoindNodeHandle,
  ManagedBitcoindStatus,
  SyncResult,
} from "../types.js";
import { closeFollowLoopResources, scheduleSync, startFollowingTipLoop } from "./follow-loop.js";
import { loadVisibleFollowBlockTimes } from "./follow-block-times.js";
import {
  createBlockRateTracker,
  createInitialSyncResult,
  type FollowLoopSubscriber,
} from "./internal-types.js";
import { syncToTip as runManagedSync } from "./sync-engine.js";

const GETBLOCK_RANGE_BASE_HEIGHT = 910_000;
const GETBLOCK_RANGE_SIZE = 500;

function isBoundaryHeight(height: number): boolean {
  return height >= GETBLOCK_RANGE_BASE_HEIGHT
    && (height - GETBLOCK_RANGE_BASE_HEIGHT) % GETBLOCK_RANGE_SIZE === 0;
}

function resolveNextBoundary(height: number): number | null {
  if (height < GETBLOCK_RANGE_BASE_HEIGHT) {
    return GETBLOCK_RANGE_BASE_HEIGHT;
  }

  if (isBoundaryHeight(height)) {
    return height;
  }

  return GETBLOCK_RANGE_BASE_HEIGHT
    + Math.ceil((height - GETBLOCK_RANGE_BASE_HEIGHT) / GETBLOCK_RANGE_SIZE) * GETBLOCK_RANGE_SIZE;
}

function mergeSyncResults(target: SyncResult, source: SyncResult): void {
  target.appliedBlocks += source.appliedBlocks;
  target.rewoundBlocks += source.rewoundBlocks;
  target.startingHeight = target.startingHeight ?? source.startingHeight;
  target.endingHeight = source.endingHeight;
  target.bestHeight = source.bestHeight;
  target.bestHashHex = source.bestHashHex;

  if (source.commonAncestorHeight !== null) {
    target.commonAncestorHeight = target.commonAncestorHeight === null
      ? source.commonAncestorHeight
      : Math.min(target.commonAncestorHeight, source.commonAncestorHeight);
  }
}

export class DefaultManagedBitcoindClient implements ManagedBitcoindClient {
  readonly #client: Client;
  readonly #store: ClientStoreAdapter;
  #node: ManagedBitcoindNodeHandle;
  #rpc: BitcoinRpcClient;
  readonly #progress: ManagedProgressController;
  #bootstrap: AssumeUtxoBootstrapController;
  #indexerDaemon: IndexerDaemonClient | null;
  readonly #reattachIndexerDaemon: (() => Promise<IndexerDaemonClient | null>) | null;
  readonly #startHeight: number;
  readonly #syncDebounceMs: number;
  readonly #dataDir: string;
  readonly #walletRootId: string;
  readonly #startupTimeoutMs: number | undefined;
  readonly #shutdownTimeoutMs: number | undefined;
  readonly #fetchImpl: typeof fetch | undefined;
  #following = false;
  #closed = false;
  #subscriber: FollowLoopSubscriber | null = null;
  #followLoop: Promise<void> | null = null;
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #bitcoinRateTracker = createBlockRateTracker();
  #cogcoinRateTracker = createBlockRateTracker();
  #syncPromise: Promise<SyncResult> = Promise.resolve(createInitialSyncResult());
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #syncAbortControllers = new Set<AbortController>();

  constructor(
    client: Client,
    store: ClientStoreAdapter,
    node: ManagedBitcoindNodeHandle,
    rpc: BitcoinRpcClient,
    progress: ManagedProgressController,
    bootstrap: AssumeUtxoBootstrapController,
    indexerDaemon: IndexerDaemonClient | null,
    reattachIndexerDaemon: (() => Promise<IndexerDaemonClient | null>) | null,
    startHeight: number,
    syncDebounceMs: number,
    dataDir: string,
    walletRootId: string,
    startupTimeoutMs: number | undefined,
    shutdownTimeoutMs: number | undefined,
    fetchImpl: typeof fetch | undefined,
  ) {
    this.#client = client;
    this.#store = store;
    this.#node = node;
    this.#rpc = rpc;
    this.#progress = progress;
    this.#bootstrap = bootstrap;
    this.#indexerDaemon = indexerDaemon;
    this.#reattachIndexerDaemon = reattachIndexerDaemon;
    this.#startHeight = startHeight;
    this.#syncDebounceMs = syncDebounceMs;
    this.#dataDir = dataDir;
    this.#walletRootId = walletRootId;
    this.#startupTimeoutMs = startupTimeoutMs;
    this.#shutdownTimeoutMs = shutdownTimeoutMs;
    this.#fetchImpl = fetchImpl;
  }

  async getTip() {
    return this.#client.getTip();
  }

  async getState() {
    return this.#client.getState();
  }

  async applyBlock(block: BitcoinBlock) {
    return this.#client.applyBlock(block);
  }

  async rewindToHeight(height: number) {
    return this.#client.rewindToHeight(height);
  }

  async syncToTip(): Promise<SyncResult> {
    this.#assertOpen();
    await this.#progress.start();

    const run = async (): Promise<SyncResult> => {
      const abortController = new AbortController();
      this.#syncAbortControllers.add(abortController);

      try {
        if (this.#node.expectedChain !== "main") {
          return await this.#runManagedSyncPass(null, abortController.signal);
        }

        return await this.#syncWithStagedRanges(abortController.signal);
      } finally {
        this.#syncAbortControllers.delete(abortController);
      }
    };

    const nextPromise = this.#syncPromise.then(run, run);
    this.#syncPromise = nextPromise;
    return nextPromise;
  }

  async startFollowingTip(): Promise<void> {
    this.#assertOpen();

    if (this.#following) {
      return;
    }

    this.#following = true;

    const resources = await startFollowingTipLoop({
      client: this.#client,
      progress: this.#progress,
      node: this.#node,
      syncToTip: () => this.syncToTip(),
      scheduleSync: () => this.#scheduleSync(),
      shouldContinue: () => this.#following && !this.#closed,
      loadVisibleFollowBlockTimes: (tip) => this.#loadVisibleFollowBlockTimes(tip),
    });

    this.#subscriber = resources.subscriber;
    this.#followLoop = resources.followLoop;
    this.#pollTimer = resources.pollTimer;
  }

  async getNodeStatus(): Promise<ManagedBitcoindStatus> {
    this.#assertOpen();

    const indexedTip = await this.#client.getTip();
    const progressStatus = this.#progress.getStatusSnapshot();
    const serviceStatus = await this.#node.refreshServiceStatus?.();
    const daemonStatus = await this.#indexerDaemon?.getStatus().catch(() => null);

    try {
      const info = await this.#rpc.getBlockchainInfo();

      return {
        ready: true,
        following: this.#following,
        chain: info.chain,
        pid: this.#node.pid,
        walletRootId: this.#node.walletRootId ?? null,
        rpc: this.#node.rpc,
        zmq: this.#node.zmq,
        indexedTip,
        nodeBestHeight: info.blocks,
        nodeBestHashHex: info.bestblockhash,
        bootstrapPhase: progressStatus.bootstrapPhase,
        bootstrapProgress: progressStatus.bootstrapProgress,
        cogcoinSyncHeight: progressStatus.cogcoinSyncHeight,
        cogcoinSyncTargetHeight: progressStatus.cogcoinSyncTargetHeight,
        currentQuote: progressStatus.currentQuote,
        snapshot: progressStatus.snapshot,
        serviceRuntimeRoot: this.#node.runtimeRoot,
        serviceUpdatedAtUnixMs: serviceStatus?.updatedAtUnixMs ?? null,
        walletReplica: serviceStatus?.walletReplica ?? null,
        serviceStatus: serviceStatus ?? null,
        indexerDaemon: daemonStatus ?? null,
      };
    } catch {
      return {
        ready: false,
        following: this.#following,
        chain: this.#node.expectedChain,
        pid: this.#node.pid,
        walletRootId: this.#node.walletRootId ?? null,
        rpc: this.#node.rpc,
        zmq: this.#node.zmq,
        indexedTip,
        nodeBestHeight: null,
        nodeBestHashHex: null,
        bootstrapPhase: progressStatus.bootstrapPhase,
        bootstrapProgress: progressStatus.bootstrapProgress,
        cogcoinSyncHeight: progressStatus.cogcoinSyncHeight,
        cogcoinSyncTargetHeight: progressStatus.cogcoinSyncTargetHeight,
        currentQuote: progressStatus.currentQuote,
        snapshot: progressStatus.snapshot,
        serviceRuntimeRoot: this.#node.runtimeRoot,
        serviceUpdatedAtUnixMs: serviceStatus?.updatedAtUnixMs ?? null,
        walletReplica: serviceStatus?.walletReplica ?? null,
        serviceStatus: serviceStatus ?? null,
        indexerDaemon: daemonStatus ?? null,
      };
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#following = false;

    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }

    await closeFollowLoopResources({
      subscriber: this.#subscriber,
      followLoop: this.#followLoop,
      pollTimer: this.#pollTimer,
    });
    this.#subscriber = null;
    this.#followLoop = null;
    this.#pollTimer = null;
    for (const abortController of this.#syncAbortControllers) {
      abortController.abort(new Error("managed_sync_aborted"));
    }

    await this.#syncPromise.catch(() => undefined);
    await this.#progress.close();
    await this.#node.stop();
    await this.#client.close();
    await this.#resumeIndexerBackgroundFollow();
    await this.#indexerDaemon?.close();
  }

  async playSyncCompletionScene(): Promise<void> {
    this.#assertOpen();
    await this.#progress.playCompletionScene();
  }

  async #syncWithStagedRanges(abortSignal: AbortSignal): Promise<SyncResult> {
    const aggregate = createInitialSyncResult();
    let stagedModeEnabled = true;

    await this.#ensureBootstrapReady(abortSignal);

    while (stagedModeEnabled) {
      const info = await this.#rpc.getBlockchainInfo();

      if (info.blocks < GETBLOCK_RANGE_BASE_HEIGHT) {
        break;
      }

      const nextBoundary = resolveNextBoundary(info.blocks);

      if (nextBoundary === null) {
        break;
      }

      if (!isBoundaryHeight(info.blocks)) {
        mergeSyncResults(aggregate, await this.#runManagedSyncPass(nextBoundary, abortSignal));
        continue;
      }

      const firstBlockHeight = info.blocks + 1;
      const lastBlockHeight = info.blocks + GETBLOCK_RANGE_SIZE;
      let readyRange;

      try {
        readyRange = await prepareGetblockArchiveRange({
          dataDir: this.#dataDir,
          progress: this.#progress,
          firstBlockHeight,
          lastBlockHeight,
          fetchImpl: this.#fetchImpl,
          signal: abortSignal,
        });
      } catch {
        stagedModeEnabled = false;
        break;
      }

      if (readyRange === null) {
        stagedModeEnabled = false;
        break;
      }

      const stagedRestartActive = await this.#restartManagedNodeWithRange(readyRange, abortSignal);
      mergeSyncResults(aggregate, await this.#runManagedSyncPass(lastBlockHeight, abortSignal));

      if (stagedRestartActive) {
        await deleteGetblockArchiveRange({
          dataDir: this.#dataDir,
          firstBlockHeight,
          lastBlockHeight,
        }).catch(() => undefined);
      } else {
        stagedModeEnabled = false;
      }
    }

    mergeSyncResults(aggregate, await this.#runManagedSyncPass(null, abortSignal));
    return aggregate;
  }

  async #runManagedSyncPass(targetHeightCap: number | null, abortSignal: AbortSignal): Promise<SyncResult> {
    return runManagedSync({
      client: this.#client,
      store: this.#store,
      node: this.#node,
      rpc: this.#rpc,
      progress: this.#progress,
      bootstrap: this.#bootstrap,
      startHeight: this.#startHeight,
      targetHeightCap,
      bitcoinRateTracker: this.#bitcoinRateTracker,
      cogcoinRateTracker: this.#cogcoinRateTracker,
      abortSignal,
      isFollowing: () => this.#following,
      loadVisibleFollowBlockTimes: (tip) => this.#loadVisibleFollowBlockTimes(tip),
    });
  }

  async #ensureBootstrapReady(signal: AbortSignal): Promise<void> {
    await this.#node.validate();
    const indexedTipBeforeBootstrap = await this.#client.getTip();
    await this.#bootstrap.ensureReady(indexedTipBeforeBootstrap, this.#node.expectedChain, { signal });
  }

  async #restartManagedNodeWithRange(
    readyRange: {
      manifest: {
        lastBlockHeight: number;
        artifactSha256: string;
      };
      artifactPath: string;
    },
    abortSignal: AbortSignal,
  ): Promise<boolean> {
    if (abortSignal.aborted) {
      throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error("managed_sync_aborted");
    }

    const baseOptions = {
      chain: this.#node.expectedChain,
      startHeight: this.#node.startHeight,
      dataDir: this.#dataDir,
      walletRootId: this.#walletRootId,
      startupTimeoutMs: this.#startupTimeoutMs,
      shutdownTimeoutMs: this.#shutdownTimeoutMs,
    };

    try {
      await stopManagedBitcoindService({
        dataDir: this.#dataDir,
        walletRootId: this.#walletRootId,
        shutdownTimeoutMs: this.#shutdownTimeoutMs,
      });

      const node = await attachOrStartManagedBitcoindService({
        ...baseOptions,
        getblockArchivePath: readyRange.artifactPath,
        getblockArchiveEndHeight: readyRange.manifest.lastBlockHeight,
        getblockArchiveSha256: readyRange.manifest.artifactSha256,
      });

      await this.#replaceManagedBindings(node);
      return true;
    } catch {
      const node = await attachOrStartManagedBitcoindService({
        ...baseOptions,
        getblockArchivePath: null,
        getblockArchiveEndHeight: null,
        getblockArchiveSha256: null,
      });

      await this.#replaceManagedBindings(node);
      return false;
    }
  }

  async #replaceManagedBindings(node: ManagedBitcoindNodeHandle): Promise<void> {
    this.#node = node;
    this.#rpc = createRpcClient(node.rpc);
    this.#bootstrap = new AssumeUtxoBootstrapController({
      rpc: this.#rpc,
      dataDir: node.dataDir,
      progress: this.#progress,
      snapshot: this.#progress.getStatusSnapshot().snapshot,
    });

    if (this.#subscriber !== null) {
      this.#subscriber.connect(node.zmq.endpoint);
      this.#subscriber.subscribe(node.zmq.topic);
    }
  }

  #scheduleSync(): void {
    scheduleSync({
      syncDebounceMs: this.#syncDebounceMs,
      isFollowing: () => this.#following,
      isClosed: () => this.#closed,
      getDebounceTimer: () => this.#debounceTimer,
      setDebounceTimer: (timer) => {
        this.#debounceTimer = timer;
      },
      syncToTip: () => this.syncToTip(),
    });
  }

  async #loadVisibleFollowBlockTimes(
    tip: Awaited<ReturnType<Client["getTip"]>>,
  ): Promise<Record<number, number>> {
    return loadVisibleFollowBlockTimes({
      tip,
      startHeight: this.#startHeight,
      store: this.#store,
      rpc: this.#rpc,
    });
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("managed_bitcoind_client_closed");
    }
  }

  async #resumeIndexerBackgroundFollow(): Promise<void> {
    if (this.#indexerDaemon === null) {
      return;
    }

    try {
      await this.#indexerDaemon.resumeBackgroundFollow();
      return;
    } catch (error) {
      if (this.#reattachIndexerDaemon === null) {
        throw error;
      }
    }

    const replacementDaemon = await this.#reattachIndexerDaemon();
    this.#indexerDaemon = replacementDaemon;
    await replacementDaemon?.resumeBackgroundFollow();
  }
}
