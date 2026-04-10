import type { ClientTip } from "../../types.js";
import { createBootstrapProgressForTesting, ManagedProgressController } from "../progress.js";
import { BitcoinRpcClient } from "../rpc.js";
import { DEFAULT_SNAPSHOT_METADATA } from "./constants.js";
import { downloadSnapshotFileForTesting } from "./download.js";
import { waitForHeaders } from "./headers.js";
import { resolveBootstrapPaths } from "./paths.js";
import { loadBootstrapState, saveBootstrapState } from "./state.js";
import { isSnapshotAlreadyLoaded } from "./chainstate.js";
import type {
  BootstrapPersistentState,
  BootstrapPaths,
} from "./types.js";
import type {
  RpcLoadTxOutSetResult,
  BootstrapPhase,
  SnapshotMetadata,
} from "../types.js";

async function loadSnapshotIntoNode(
  rpc: Pick<BitcoinRpcClient, "loadTxOutSet">,
  snapshotPath: string,
): Promise<RpcLoadTxOutSetResult> {
  return rpc.loadTxOutSet(snapshotPath);
}

export class AssumeUtxoBootstrapController {
  readonly #rpc: BitcoinRpcClient;
  readonly #paths: BootstrapPaths;
  readonly #progress: ManagedProgressController;
  readonly #snapshot: SnapshotMetadata;
  readonly #fetchImpl?: typeof fetch;
  #statePromise: Promise<BootstrapPersistentState> | null = null;

  constructor(options: {
    rpc: BitcoinRpcClient;
    dataDir: string;
    progress: ManagedProgressController;
    snapshot?: SnapshotMetadata;
    fetchImpl?: typeof fetch;
  }) {
    this.#rpc = options.rpc;
    this.#progress = options.progress;
    this.#snapshot = options.snapshot ?? DEFAULT_SNAPSHOT_METADATA;
    this.#paths = resolveBootstrapPaths(options.dataDir, this.#snapshot);
    this.#fetchImpl = options.fetchImpl;
  }

  get quoteStatePath(): string {
    return this.#paths.quoteStatePath;
  }

  get snapshot(): SnapshotMetadata {
    return this.#snapshot;
  }

  async ensureReady(indexedTip: ClientTip | null, expectedChain: "main" | "regtest"): Promise<void> {
    if (expectedChain !== "main") {
      await this.#progress.setPhase("paused", {
        ...createBootstrapProgressForTesting("paused", this.#snapshot),
        message: "Managed regtest sync does not use assumeutxo bootstrap.",
      });
      return;
    }

    if (indexedTip !== null) {
      await this.#progress.setPhase("follow_tip", {
        blocks: indexedTip.height,
        targetHeight: indexedTip.height,
        message: "Resuming from the persisted Cogcoin indexed tip.",
      });
      return;
    }

    const state = await this.#loadState();

    if (state.loadTxOutSetComplete && await isSnapshotAlreadyLoaded(this.#rpc, this.#snapshot, state)) {
      await this.#progress.setPhase("bitcoin_sync", {
        blocks: state.baseHeight,
        targetHeight: state.baseHeight ?? this.#snapshot.height,
        baseHeight: state.baseHeight,
        tipHashHex: state.tipHashHex,
        message: "Using the previously loaded assumeutxo chainstate.",
        lastError: state.lastError,
      });
      return;
    }

    await downloadSnapshotFileForTesting({
      fetchImpl: this.#fetchImpl,
      metadata: this.#snapshot,
      paths: this.#paths,
      progress: this.#progress,
      state,
    });

    if (!await isSnapshotAlreadyLoaded(this.#rpc, this.#snapshot, state)) {
      await waitForHeaders(this.#rpc, this.#snapshot, this.#progress);
      await this.#progress.setPhase("load_snapshot", {
        downloadedBytes: this.#snapshot.sizeBytes,
        totalBytes: this.#snapshot.sizeBytes,
        percent: 100,
        message: "Loading the UTXO snapshot into bitcoind.",
      });
      const loadResult = await loadSnapshotIntoNode(this.#rpc, this.#paths.snapshotPath);
      state.loadTxOutSetComplete = true;
      state.baseHeight = loadResult.base_height;
      state.tipHashHex = loadResult.tip_hash;
      state.phase = "bitcoin_sync";
      state.lastError = null;
      await saveBootstrapState(this.#paths, state);
    }

    const info = await this.#rpc.getBlockchainInfo();
    await this.#progress.setPhase("bitcoin_sync", {
      blocks: info.blocks,
      headers: info.headers,
      targetHeight: info.headers,
      baseHeight: state.baseHeight,
      tipHashHex: state.tipHashHex,
      message: "Bitcoin Core is syncing blocks after assumeutxo bootstrap.",
      lastError: state.lastError,
    });
  }

  async getStateForTesting(): Promise<{
    metadataVersion: number;
    snapshot: SnapshotMetadata;
    phase: BootstrapPhase;
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
    this.#statePromise ??= loadBootstrapState(this.#paths, this.#snapshot);
    return this.#statePromise;
  }
}
