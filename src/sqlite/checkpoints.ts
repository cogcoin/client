import { bytesToHex, cloneBytes, hexToBytes } from "../bytes.js";
import type { ClientCheckpoint } from "../types.js";
import type { SqliteDatabase } from "./driver.js";

interface CheckpointRow {
  height: number;
  block_hash: Uint8Array;
  state_bytes: Uint8Array;
  created_at: number;
}

export interface StoredCheckpointRow {
  height: number;
  blockHashHex: string;
  stateBytes: Uint8Array;
  createdAt: number;
}

function decodeCheckpointRow(row: CheckpointRow | null): StoredCheckpointRow | null {
  if (row === null) {
    return null;
  }

  return {
    height: row.height,
    blockHashHex: bytesToHex(row.block_hash),
    stateBytes: cloneBytes(row.state_bytes),
    createdAt: row.created_at,
  };
}

export async function loadLatestCheckpoint(database: SqliteDatabase): Promise<StoredCheckpointRow | null> {
  return decodeCheckpointRow(
    await database.get<CheckpointRow>(
      `SELECT height, block_hash, state_bytes, created_at FROM checkpoints ORDER BY height DESC LIMIT 1`,
    ),
  );
}

export async function replaceCheckpoint(database: SqliteDatabase, checkpoint: ClientCheckpoint): Promise<void> {
  await database.run(
    `INSERT OR REPLACE INTO checkpoints (height, block_hash, state_bytes, created_at)
     VALUES (?, ?, ?, ?)`,
    [
      checkpoint.height,
      hexToBytes(checkpoint.blockHashHex),
      checkpoint.stateBytes,
      checkpoint.createdAt,
    ],
  );
}

export async function deleteCheckpointsAbove(database: SqliteDatabase, height: number): Promise<void> {
  await database.run(`DELETE FROM checkpoints WHERE height > ?`, [height]);
}
