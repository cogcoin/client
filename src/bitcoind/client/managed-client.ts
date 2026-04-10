import type { BitcoinBlock } from "@cogcoin/indexer/types";
import type { Subscriber } from "zeromq";

import type { Client, ClientStoreAdapter } from "../../types.js";
import type { AssumeUtxoBootstrapController } from "../bootstrap.js";
import type { IndexerDaemonClient } from "../indexer-daemon.js";
import type { ManagedProgressController } from "../progress.js";
import type { BitcoinRpcClient } from "../rpc.js";
import type {
  ManagedBitcoindClient,
  ManagedBitcoindNodeHandle,
  ManagedBitcoindStatus,
  SyncResult,
} from "../types.js";
import { closeFollowLoopResources, scheduleSync, startFollowingTipLoop } from "./follow-loop.js";
import { loadVisibleFollowBlockTimes } from "./follow-block-times.js";
import { createBlockRateTracker, createInitialSyncResult } from "./internal-types.js";
import { syncToTip as runManagedSync } from "./sync-engine.js";

export class DefaultManagedBitcoindClient implements ManagedBitcoindClient {
  readonly #client: Client;
  readonly #store: ClientStoreAdapter;
  readonly #node: ManagedBitcoindNodeHandle;
  readonly #rpc: BitcoinRpcClient;
  readonly #progress: ManagedProgressController;
  readonly #bootstrap: AssumeUtxoBootstrapController;
  readonly #indexerDaemon: IndexerDaemonClient | null;
  readonly #startHeight: number;
  readonly #syncDebounceMs: number;
  #following = false;
  #closed = false;
  #subscriber: Subscriber | null = null;
  #followLoop: Promise<void> | null = null;
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #bitcoinRateTracker = createBlockRateTracker();
  #cogcoinRateTracker = createBlockRateTracker();
  #syncPromise: Promise<SyncResult> = Promise.resolve(createInitialSyncResult());
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    client: Client,
    store: ClientStoreAdapter,
    node: ManagedBitcoindNodeHandle,
    rpc: BitcoinRpcClient,
    progress: ManagedProgressController,
    bootstrap: AssumeUtxoBootstrapController,
    indexerDaemon: IndexerDaemonClient | null,
    syncDebounceMs: number,
  ) {
    this.#client = client;
    this.#store = store;
    this.#node = node;
    this.#rpc = rpc;
    this.#progress = progress;
    this.#bootstrap = bootstrap;
    this.#indexerDaemon = indexerDaemon;
    this.#startHeight = node.startHeight;
    this.#syncDebounceMs = syncDebounceMs;
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

    const run = async (): Promise<SyncResult> => runManagedSync({
      client: this.#client,
      store: this.#store,
      node: this.#node,
      rpc: this.#rpc,
      progress: this.#progress,
      bootstrap: this.#bootstrap,
      startHeight: this.#startHeight,
      bitcoinRateTracker: this.#bitcoinRateTracker,
      cogcoinRateTracker: this.#cogcoinRateTracker,
      isFollowing: () => this.#following,
      loadVisibleFollowBlockTimes: (tip) => this.#loadVisibleFollowBlockTimes(tip),
    });

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

    await this.#syncPromise.catch(() => undefined);
    await this.#progress.close();
    await this.#node.stop();
    await this.#indexerDaemon?.close();
    await this.#client.close();
  }

  async playSyncCompletionScene(): Promise<void> {
    this.#assertOpen();
    await this.#progress.playCompletionScene();
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
}
