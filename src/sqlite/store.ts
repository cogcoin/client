import {
  bytesToHex,
  cloneBytes,
  hexToBytes,
} from "../bytes.js";
import type {
  ClientCheckpoint,
  ClientStoreAdapter,
  ClientTip,
  StoredBlockRecord,
  WriteAppliedBlockEntry,
} from "../types.js";
import {
  deleteCheckpointsAbove,
  loadLatestCheckpoint,
  replaceCheckpoint,
} from "./checkpoints.js";
import type { SqliteDatabase } from "./driver.js";
import {
  loadTipSnapshotMeta,
  writeTipMeta,
} from "./tip-meta.js";

interface BlockRecordRow {
  height: number;
  block_hash: Uint8Array;
  previous_hash: Uint8Array;
  record_bytes: Uint8Array;
  state_hash_hex: string;
  created_at: number;
}

export function createSqliteStoreAdapter(database: SqliteDatabase): ClientStoreAdapter {
  let writeQueue: Promise<void> = Promise.resolve();
  let closed = false;

  function assertOpen(): void {
    if (closed) {
      throw new Error("sqlite_store_closed");
    }
  }

  function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = writeQueue.then(operation, operation);
    writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    async loadTip(): Promise<ClientTip | null> {
      assertOpen();
      const decoded = await loadTipSnapshotMeta(database);
      return decoded === null ? null : decoded.tip;
    },

    async loadLatestSnapshot(): Promise<ClientCheckpoint | null> {
      assertOpen();

      const tipMeta = await loadTipSnapshotMeta(database);

      if (tipMeta !== null) {
        return {
          height: tipMeta.tip.height,
          blockHashHex: tipMeta.tip.blockHashHex,
          stateBytes: tipMeta.stateBytes,
          createdAt: tipMeta.updatedAt,
        };
      }

      const row = await loadLatestCheckpoint(database);

      if (row === null) {
        return null;
      }

      return {
        height: row.height,
        blockHashHex: row.blockHashHex,
        stateBytes: row.stateBytes,
        createdAt: row.createdAt,
      };
    },

    async loadBlockRecordsAfter(height: number): Promise<StoredBlockRecord[]> {
      assertOpen();

      const rows = await database.all<BlockRecordRow>(
        `SELECT height, block_hash, previous_hash, record_bytes, state_hash_hex, created_at
         FROM block_records
         WHERE height > ?
         ORDER BY height ASC`,
        [height],
      );

      return rows.map((row) => ({
        height: row.height,
        blockHashHex: bytesToHex(row.block_hash),
        previousHashHex: row.previous_hash.length === 0 ? null : bytesToHex(row.previous_hash),
        stateHashHex: row.state_hash_hex.length === 0 ? null : row.state_hash_hex,
        recordBytes: cloneBytes(row.record_bytes),
        createdAt: row.created_at,
      }));
    },

    async writeAppliedBlock(entry: WriteAppliedBlockEntry): Promise<void> {
      assertOpen();

      await enqueueWrite(async () => {
        const createdAt = entry.blockRecord?.createdAt ?? entry.checkpoint?.createdAt ?? Date.now();

        await database.transaction(async () => {
          if (entry.deleteAboveHeight !== null && entry.deleteAboveHeight !== undefined) {
            await database.run(`DELETE FROM block_records WHERE height > ?`, [entry.deleteAboveHeight]);
            await deleteCheckpointsAbove(database, entry.deleteAboveHeight);
          }

          if (entry.deleteBelowHeight !== null && entry.deleteBelowHeight !== undefined) {
            await database.run(`DELETE FROM block_records WHERE height < ?`, [entry.deleteBelowHeight]);
          }

          if (entry.blockRecord !== null && entry.blockRecord !== undefined) {
            await database.run(
              `INSERT INTO block_records (height, block_hash, previous_hash, record_bytes, state_hash_hex, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [
                entry.blockRecord.height,
                hexToBytes(entry.blockRecord.blockHashHex),
                entry.blockRecord.previousHashHex === null ? new Uint8Array() : hexToBytes(entry.blockRecord.previousHashHex),
                entry.blockRecord.recordBytes,
                entry.blockRecord.stateHashHex ?? "",
                entry.blockRecord.createdAt,
              ],
            );
          }

          await writeTipMeta(database, entry.tip, entry.stateBytes, createdAt);

          if (entry.checkpoint !== null && entry.checkpoint !== undefined) {
            await replaceCheckpoint(database, entry.checkpoint);
          }
        });
      });
    },

    async deleteBlockRecordsAbove(height: number): Promise<void> {
      assertOpen();
      await enqueueWrite(async () => {
        await database.transaction(async () => {
          await database.run(`DELETE FROM block_records WHERE height > ?`, [height]);
          await deleteCheckpointsAbove(database, height);
        });
      });
    },

    async loadBlockRecord(height: number): Promise<StoredBlockRecord | null> {
      assertOpen();

      const row = await database.get<BlockRecordRow>(
        `SELECT height, block_hash, previous_hash, record_bytes, state_hash_hex, created_at
         FROM block_records
         WHERE height = ?`,
        [height],
      );

      if (row === null) {
        return null;
      }

      return {
        height: row.height,
        blockHashHex: bytesToHex(row.block_hash),
        previousHashHex: row.previous_hash.length === 0 ? null : bytesToHex(row.previous_hash),
        stateHashHex: row.state_hash_hex.length === 0 ? null : row.state_hash_hex,
        recordBytes: cloneBytes(row.record_bytes),
        createdAt: row.created_at,
      };
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }

      await writeQueue;
      closed = true;
      await database.close();
    },
  };
}
