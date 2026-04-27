import {
  applyBlockWithScoring,
  createInitialState,
  deserializeBlockRecord,
  deserializeIndexerState,
  rewindBlock,
  serializeIndexerState,
} from "@cogcoin/indexer";
import type {
  BitcoinBlock,
  GenesisParameters,
  IndexerState,
} from "@cogcoin/indexer/types";

import { internalHashHexToDisplayHashHex } from "../bitcoind/hash-order.js";
import { createCheckpoint, createStoredBlockRecord, createTip } from "./persistence.js";
import type {
  ApplyBlockResult,
  Client,
  ClientCheckpoint,
  ClientMirrorDelta,
  ClientMirrorSnapshot,
  ClientStoreAdapter,
  ClientTip,
  WriteAppliedBlockEntry,
} from "../types.js";

export class DefaultClient implements Client {
  readonly #store: ClientStoreAdapter;
  readonly #genesisParameters: GenesisParameters;
  readonly #snapshotInterval: number;
  readonly #blockRecordRetention: number;
  #state: IndexerState;
  #tip: ClientTip | null;
  #closed = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    store: ClientStoreAdapter,
    genesisParameters: GenesisParameters,
    state: IndexerState,
    tip: ClientTip | null,
    snapshotInterval: number,
    blockRecordRetention: number,
  ) {
    this.#store = store;
    this.#genesisParameters = genesisParameters;
    this.#state = state;
    this.#tip = tip;
    this.#snapshotInterval = snapshotInterval;
    this.#blockRecordRetention = blockRecordRetention;
  }

  async getTip(): Promise<ClientTip | null> {
    await this.#queue;
    return this.#tip === null ? null : { ...this.#tip };
  }

  async getState(): Promise<IndexerState> {
    await this.#queue;
    return this.#state;
  }

  async readMirrorSnapshot(): Promise<ClientMirrorSnapshot> {
    return this.#enqueue(async () => {
      this.#assertOpen();

      return {
        tip: this.#tip === null ? null : { ...this.#tip },
        stateBytes: serializeIndexerState(this.#state),
      };
    });
  }

  async readMirrorDelta(afterHeight: number): Promise<ClientMirrorDelta> {
    return this.#enqueue(async () => {
      this.#assertOpen();

      const blockRecords = await this.#store.loadBlockRecordsAfter(afterHeight);

      return {
        tip: this.#tip === null ? null : { ...this.#tip },
        blockRecords: blockRecords.map((record) => ({
          ...record,
          recordBytes: new Uint8Array(record.recordBytes),
        })),
      };
    });
  }

  async applyBlock(block: BitcoinBlock): Promise<ApplyBlockResult> {
    return this.#enqueue(async () => {
      this.#assertOpen();

      const applied = await applyBlockWithScoring(this.#state, block, this.#genesisParameters);
      const tip = createTip(block, applied.stateHashHex);
      const stateBytes = serializeIndexerState(applied.state);
      const createdAt = Date.now();
      const checkpoint = this.#shouldCheckpoint(block.height)
        ? createCheckpoint(tip, stateBytes, createdAt)
        : null;
      const writeEntry: WriteAppliedBlockEntry = {
        tip,
        stateBytes,
        blockRecord: createStoredBlockRecord(applied.blockRecord, createdAt),
        checkpoint,
        deleteAboveHeight: null,
        deleteBelowHeight: this.#blockRecordLowerBound(block.height),
      };

      await this.#store.writeAppliedBlock(writeEntry);

      this.#state = applied.state;
      this.#tip = tip;

      return {
        tip,
        checkpoint,
        applied,
      };
    });
  }

  async rewindToHeight(height: number): Promise<ClientTip | null> {
    return this.#enqueue(async () => {
      this.#assertOpen();

      if (this.#tip === null) {
        return null;
      }

      if (height >= this.#tip.height) {
        return { ...this.#tip };
      }

      let nextState = this.#state;
      let nextTip: ClientTip | null = this.#tip;

      while (nextTip !== null && nextTip.height > height) {
        const storedRecord = await this.#store.loadBlockRecord(nextTip.height);

        if (storedRecord === null) {
          throw new Error(`client_store_missing_block_record_${nextTip.height}`);
        }

        nextState = rewindBlock(nextState, deserializeBlockRecord(storedRecord.recordBytes));
        const currentHeight = nextState.history.currentHeight;

        if (currentHeight === null) {
          nextTip = null;
          continue;
        }

        const currentRecord = await this.#store.loadBlockRecord(currentHeight);

        nextTip = {
          height: currentHeight,
          blockHashHex:
            currentRecord?.blockHashHex
            ?? (nextState.history.currentHashHex === null ? "" : internalHashHexToDisplayHashHex(nextState.history.currentHashHex)),
          previousHashHex: currentRecord?.previousHashHex ?? null,
          stateHashHex: nextState.history.stateHashByHeight.get(currentHeight) ?? null,
        };
      }

      const stateBytes = nextTip === null ? null : serializeIndexerState(nextState);
      await this.#store.writeAppliedBlock({
        tip: nextTip,
        stateBytes,
        blockRecord: null,
        checkpoint: null,
        deleteAboveHeight: height,
      });

      this.#state = nextState;
      this.#tip = nextTip;

      return nextTip === null ? null : { ...nextTip };
    });
  }

  async restoreCheckpoint(checkpoint: ClientCheckpoint): Promise<ClientTip> {
    return this.#enqueue(async () => {
      this.#assertOpen();

      const nextState = deserializeIndexerState(checkpoint.stateBytes);

      if (nextState.history.currentHeight !== checkpoint.height) {
        throw new Error("client_checkpoint_height_mismatch");
      }

      const nextTip: ClientTip = {
        height: checkpoint.height,
        blockHashHex: checkpoint.blockHashHex,
        previousHashHex: null,
        stateHashHex: nextState.history.stateHashByHeight.get(checkpoint.height) ?? null,
      };

      await this.#store.writeAppliedBlock({
        tip: nextTip,
        stateBytes: checkpoint.stateBytes,
        blockRecord: null,
        checkpoint,
        deleteAboveHeight: checkpoint.height,
      });

      this.#state = nextState;
      this.#tip = nextTip;

      return { ...nextTip };
    });
  }

  async resetToInitialState(): Promise<null> {
    return this.#enqueue(async () => {
      this.#assertOpen();

      const nextState = createInitialState(this.#genesisParameters);

      await this.#store.writeAppliedBlock({
        tip: null,
        stateBytes: null,
        blockRecord: null,
        checkpoint: null,
        deleteAboveHeight: -1,
      });

      this.#state = nextState;
      this.#tip = null;

      return null;
    });
  }

  async close(): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#closed) {
        return;
      }

      this.#closed = true;
      await this.#store.close();
    });
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("client_closed");
    }
  }

  #shouldCheckpoint(height: number): boolean {
    return this.#snapshotInterval > 0 && height % this.#snapshotInterval === 0;
  }

  #blockRecordLowerBound(height: number): number {
    return height - this.#blockRecordRetention + 1;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
