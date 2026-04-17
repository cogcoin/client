import type { Client, ClientCheckpoint, ClientStoreAdapter, ClientTip } from "../../types.js";
import type { AssumeUtxoBootstrapController } from "../bootstrap.js";
import type { ManagedProgressController } from "../progress.js";
import type { BitcoinRpcClient } from "../rpc.js";
import type {
  ManagedBitcoindNodeHandle,
  RpcBlockchainInfo,
  SyncResult,
} from "../types.js";

export interface SyncPassResult {
  appliedBlocks: number;
  rewoundBlocks: number;
  commonAncestorHeight: number | null;
}

export interface SyncRecoveryClient extends Client {
  restoreCheckpoint(checkpoint: ClientCheckpoint): Promise<ClientTip>;
  resetToInitialState(): Promise<null>;
}

export interface BlockRateTracker {
  lastHeight: number | null;
  lastUpdatedAt: number | null;
  blocksPerSecond: number | null;
}

export interface SyncEngineDependencies {
  client: SyncRecoveryClient;
  store: ClientStoreAdapter;
  node: ManagedBitcoindNodeHandle;
  rpc: BitcoinRpcClient;
  progress: ManagedProgressController;
  bootstrap: AssumeUtxoBootstrapController;
  startHeight: number;
  targetHeightCap?: number | null;
  bitcoinRateTracker: BlockRateTracker;
  cogcoinRateTracker: BlockRateTracker;
  abortSignal?: AbortSignal;
  isFollowing(): boolean;
  loadVisibleFollowBlockTimes(tip: Awaited<ReturnType<SyncRecoveryClient["getTip"]>>): Promise<Record<number, number>>;
}

export interface FollowLoopSubscriber extends AsyncIterable<unknown> {
  close(): void;
  connect(endpoint: string): void;
  subscribe(topic: string): void;
}

export interface ZeroMqModuleLike {
  Subscriber: new () => FollowLoopSubscriber;
}

export interface FollowLoopResources {
  subscriber: FollowLoopSubscriber;
  followLoop: Promise<void>;
  pollTimer: ReturnType<typeof setInterval>;
}

export interface StartFollowingTipLoopDependencies {
  client: Client;
  progress: ManagedProgressController;
  node: ManagedBitcoindNodeHandle;
  syncToTip(): Promise<SyncResult>;
  scheduleSync(): void;
  shouldContinue(): boolean;
  loadVisibleFollowBlockTimes(tip: Awaited<ReturnType<Client["getTip"]>>): Promise<Record<number, number>>;
  loadZeroMq?(): Promise<ZeroMqModuleLike>;
}

export interface ScheduleSyncDependencies {
  syncDebounceMs: number;
  isFollowing(): boolean;
  isClosed(): boolean;
  getDebounceTimer(): ReturnType<typeof setTimeout> | null;
  setDebounceTimer(timer: ReturnType<typeof setTimeout> | null): void;
  syncToTip(): Promise<SyncResult>;
}

export interface FollowLoopControlDependencies {
  shouldContinue(): boolean;
  scheduleSync(): void;
}

export interface BitcoinSyncProgressDependencies {
  node: ManagedBitcoindNodeHandle;
  progress: ManagedProgressController;
  bitcoinRateTracker: BlockRateTracker;
}

export function createInitialSyncResult(): SyncResult {
  return {
    appliedBlocks: 0,
    rewoundBlocks: 0,
    commonAncestorHeight: null,
    startingHeight: null,
    endingHeight: null,
    bestHeight: 0,
    bestHashHex: "",
  };
}

export function createBlockRateTracker(): BlockRateTracker {
  return {
    lastHeight: null,
    lastUpdatedAt: null,
    blocksPerSecond: null,
  };
}

export type { RpcBlockchainInfo };
