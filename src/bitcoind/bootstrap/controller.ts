import { join } from "node:path";

import type { ClientTip } from "../../types.js";
import { createBootstrapProgressForTesting, ManagedProgressController } from "../progress.js";
import { BitcoinRpcClient } from "../rpc.js";
import { DEFAULT_SNAPSHOT_METADATA } from "./constants.js";
import { downloadSnapshotFileForTesting } from "./download.js";
import { waitForHeaders } from "./headers.js";
import { resolveBootstrapPaths } from "./paths.js";
import { loadBootstrapStateRecord, saveBootstrapState } from "./state.js";
import { findLoadedSnapshotChainState, isSnapshotAlreadyLoaded } from "./chainstate.js";
import {
  describeManagedRpcRetryError,
  type ManagedRpcRetryState,
  isRetryableManagedRpcError,
} from "../retryable-rpc.js";
import type {
  BootstrapPersistentState,
  BootstrapPaths,
  LoadedBootstrapState,
} from "./types.js";
import type {
  RpcLoadTxOutSetResult,
  BootstrapPhase,
  SnapshotMetadata,
  SnapshotChunkManifest,
} from "../types.js";

async function loadSnapshotIntoNode(
  rpc: Pick<BitcoinRpcClient, "loadTxOutSet">,
  snapshotPath: string,
): Promise<RpcLoadTxOutSetResult> {
  return rpc.loadTxOutSet(snapshotPath);
}

type ResumeDisplayMode = "sync" | "follow";

export class AssumeUtxoBootstrapController {
  readonly #rpc: BitcoinRpcClient;
  readonly #paths: BootstrapPaths;
  readonly #progress: ManagedProgressController;
  readonly #snapshot: SnapshotMetadata;
  readonly #debugLogPath: string;
  readonly #manifest: SnapshotChunkManifest | undefined;
  readonly #fetchImpl?: typeof fetch;
  #stateRecordPromise: Promise<LoadedBootstrapState> | null = null;

  constructor(options: {
    rpc: BitcoinRpcClient;
    dataDir: string;
    progress: ManagedProgressController;
    snapshot?: SnapshotMetadata;
    manifest?: SnapshotChunkManifest;
    fetchImpl?: typeof fetch;
  }) {
    this.#rpc = options.rpc;
    this.#progress = options.progress;
    this.#snapshot = options.snapshot ?? DEFAULT_SNAPSHOT_METADATA;
    this.#manifest = options.manifest;
    this.#paths = resolveBootstrapPaths(options.dataDir, this.#snapshot);
    this.#debugLogPath = join(options.dataDir, "debug.log");
    this.#fetchImpl = options.fetchImpl;
  }

  get quoteStatePath(): string {
    return this.#paths.quoteStatePath;
  }

  get snapshot(): SnapshotMetadata {
    return this.#snapshot;
  }

  async ensureReady(
    indexedTip: ClientTip | null,
    expectedChain: "main" | "regtest",
    options: {
      signal?: AbortSignal;
      retryState?: ManagedRpcRetryState;
      resumeDisplayMode?: ResumeDisplayMode;
    } = {},
  ): Promise<void> {
    if (expectedChain !== "main") {
      await this.#progress.setPhase("paused", {
        ...createBootstrapProgressForTesting("paused", this.#snapshot),
        message: "Managed regtest sync does not use assumeutxo bootstrap.",
      });
      return;
    }

    if (indexedTip !== null) {
      if ((options.resumeDisplayMode ?? "sync") === "follow") {
        await this.#progress.setPhase("follow_tip", {
          blocks: indexedTip.height,
          targetHeight: indexedTip.height,
          message: "Resuming from the persisted Cogcoin indexed tip.",
        });
      }
      return;
    }

    const { state, snapshotIdentity } = await this.#loadStateRecord();

    if (state.loadTxOutSetComplete && await isSnapshotAlreadyLoaded(this.#rpc, this.#snapshot, state)) {
      if (state.lastError !== null) {
        state.lastError = null;
        await saveBootstrapState(this.#paths, state);
      }

      await this.#progress.setPhase("bitcoin_sync", {
        blocks: state.baseHeight,
        targetHeight: state.baseHeight ?? this.#snapshot.height,
        baseHeight: state.baseHeight,
        tipHashHex: state.tipHashHex,
        message: "Using the previously loaded assumeutxo chainstate.",
        lastError: null,
      });
      return;
    }

    await downloadSnapshotFileForTesting({
      fetchImpl: this.#fetchImpl,
      manifest: this.#manifest,
      metadata: this.#snapshot,
      paths: this.#paths,
      progress: this.#progress,
      state,
      signal: options.signal,
      snapshotIdentity,
    });

    if (!await isSnapshotAlreadyLoaded(this.#rpc, this.#snapshot, state)) {
      await waitForHeaders(this.#rpc, this.#snapshot, this.#progress, {
        signal: options.signal,
        retryState: options.retryState,
        debugLogPath: this.#debugLogPath,
      });
      await this.#progress.setPhase("load_snapshot", {
        downloadedBytes: this.#snapshot.sizeBytes,
        totalBytes: this.#snapshot.sizeBytes,
        percent: 100,
        message: "Loading the UTXO snapshot into bitcoind.",
        lastError: null,
      });
      let loadResult: RpcLoadTxOutSetResult;

      try {
        loadResult = await loadSnapshotIntoNode(this.#rpc, this.#paths.snapshotPath);
      } catch (error) {
        if (!isRetryableManagedRpcError(error)) {
          throw error;
        }

        state.lastError = describeManagedRpcRetryError(error);
        await saveBootstrapState(this.#paths, state);
        const loadedChainState = await findLoadedSnapshotChainState(this.#rpc, this.#snapshot, state);

        if (loadedChainState === null) {
          throw error;
        }

        loadResult = {
          base_height: loadedChainState.blocks ?? this.#snapshot.height,
          coins_loaded: 0,
          tip_hash: loadedChainState.snapshot_blockhash ?? state.tipHashHex ?? "",
        };
      }

      state.loadTxOutSetComplete = true;
      state.baseHeight = loadResult.base_height;
      state.tipHashHex = loadResult.tip_hash === "" ? state.tipHashHex : loadResult.tip_hash;
      state.phase = "bitcoin_sync";
      state.lastError = null;
      await saveBootstrapState(this.#paths, state);
    }

    const info = await this.#rpc.getBlockchainInfo();
    if (state.lastError !== null) {
      state.lastError = null;
      await saveBootstrapState(this.#paths, state);
    }
    await this.#progress.setPhase("bitcoin_sync", {
      blocks: info.blocks,
      headers: info.headers,
      targetHeight: info.headers,
      baseHeight: state.baseHeight,
      tipHashHex: state.tipHashHex,
      message: "Bitcoin Core is syncing blocks after assumeutxo bootstrap.",
      lastError: null,
    });
  }

  async getStateForTesting(): Promise<{
    metadataVersion: number;
    snapshot: SnapshotMetadata;
    phase: BootstrapPhase;
    integrityVersion: number;
    chunkSizeBytes: number;
    verifiedChunkCount: number;
    downloadedBytes: number;
    validated: boolean;
    loadTxOutSetComplete: boolean;
    baseHeight: number | null;
    tipHashHex: string | null;
    lastError: string | null;
    updatedAt: number;
  }> {
    return { ...(await this.#loadState()) };
  }

  async #loadState(): Promise<BootstrapPersistentState> {
    return (await this.#loadStateRecord()).state;
  }

  async #loadStateRecord(): Promise<LoadedBootstrapState> {
    this.#stateRecordPromise ??= loadBootstrapStateRecord(this.#paths, this.#snapshot);
    return this.#stateRecordPromise;
  }
}
