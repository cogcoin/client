import {
  bytesToHex,
  cloneBytes,
  decodeInteger,
  decodeNullableText,
  encodeInteger,
  encodeNullableText,
  hexToBytes,
} from "../bytes.js";
import type { ClientTip } from "../types.js";
import type { SqliteDatabase } from "./driver.js";

export const TIP_META_KEYS = {
  tipHeight: "tip_height",
  tipBlockHash: "tip_block_hash",
  tipPreviousHash: "tip_previous_hash",
  tipStateHashHex: "tip_state_hash_hex",
  tipStateBytes: "tip_state_bytes",
  tipUpdatedAt: "tip_updated_at",
} as const;

interface MetaRow {
  key: string;
  value: Uint8Array;
}

export interface StoredTipMeta {
  tip: ClientTip;
  stateBytes: Uint8Array | null;
  updatedAt: number;
}

export interface StoredTipSnapshot {
  tip: ClientTip;
  stateBytes: Uint8Array;
  updatedAt: number;
}

function readMetaValue(meta: Map<string, Uint8Array>, key: string): Uint8Array | null {
  return meta.get(key) ?? null;
}

function allTipMetaKeys(): string[] {
  return [
    TIP_META_KEYS.tipHeight,
    TIP_META_KEYS.tipBlockHash,
    TIP_META_KEYS.tipPreviousHash,
    TIP_META_KEYS.tipStateHashHex,
    TIP_META_KEYS.tipStateBytes,
    TIP_META_KEYS.tipUpdatedAt,
  ];
}

export function decodeTipMeta(meta: Map<string, Uint8Array>): StoredTipMeta | null {
  const heightBytes = readMetaValue(meta, TIP_META_KEYS.tipHeight);
  const hashBytes = readMetaValue(meta, TIP_META_KEYS.tipBlockHash);
  const previousHashBytes = readMetaValue(meta, TIP_META_KEYS.tipPreviousHash);
  const stateHashHexBytes = readMetaValue(meta, TIP_META_KEYS.tipStateHashHex);
  const stateBytes = readMetaValue(meta, TIP_META_KEYS.tipStateBytes);
  const updatedAtBytes = readMetaValue(meta, TIP_META_KEYS.tipUpdatedAt);

  if (
    heightBytes === null &&
    hashBytes === null &&
    previousHashBytes === null &&
    stateHashHexBytes === null &&
    stateBytes === null &&
    updatedAtBytes === null
  ) {
    return null;
  }

  if (
    heightBytes === null ||
    hashBytes === null ||
    previousHashBytes === null ||
    stateHashHexBytes === null ||
    updatedAtBytes === null
  ) {
    throw new Error("sqlite_store_tip_meta_incomplete");
  }

  return {
    tip: {
      height: decodeInteger(heightBytes),
      blockHashHex: bytesToHex(hashBytes),
      previousHashHex: previousHashBytes.length === 0 ? null : bytesToHex(previousHashBytes),
      stateHashHex: decodeNullableText(stateHashHexBytes),
    },
    stateBytes: stateBytes === null ? null : cloneBytes(stateBytes),
    updatedAt: decodeInteger(updatedAtBytes),
  };
}

export function requireTipStateBytes(meta: StoredTipMeta | null): StoredTipSnapshot | null {
  if (meta === null) {
    return null;
  }

  if (meta.stateBytes === null) {
    throw new Error("sqlite_store_tip_meta_incomplete");
  }

  return {
    tip: meta.tip,
    stateBytes: meta.stateBytes,
    updatedAt: meta.updatedAt,
  };
}

export async function loadTipMeta(database: SqliteDatabase): Promise<StoredTipMeta | null> {
  const rows = await database.all<MetaRow>(
    `SELECT key, value FROM meta WHERE key IN (?, ?, ?, ?, ?, ?)`,
    allTipMetaKeys(),
  );
  const meta = new Map<string, Uint8Array>();

  for (const row of rows) {
    meta.set(row.key, cloneBytes(row.value));
  }

  return decodeTipMeta(meta);
}

export async function loadTipSnapshotMeta(database: SqliteDatabase): Promise<StoredTipSnapshot | null> {
  return requireTipStateBytes(await loadTipMeta(database));
}

async function upsertMeta(database: SqliteDatabase, key: string, value: Uint8Array): Promise<void> {
  await database.run(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

export async function clearTipMeta(database: SqliteDatabase): Promise<void> {
  await database.run(
    `DELETE FROM meta WHERE key IN (?, ?, ?, ?, ?, ?)`,
    allTipMetaKeys(),
  );
}

export async function writeTipMeta(
  database: SqliteDatabase,
  tip: ClientTip | null,
  stateBytes: Uint8Array | null,
  updatedAt: number,
): Promise<void> {
  if (tip === null || stateBytes === null) {
    await clearTipMeta(database);
    return;
  }

  await upsertMeta(database, TIP_META_KEYS.tipHeight, encodeInteger(tip.height));
  await upsertMeta(database, TIP_META_KEYS.tipBlockHash, hexToBytes(tip.blockHashHex));
  await upsertMeta(
    database,
    TIP_META_KEYS.tipPreviousHash,
    tip.previousHashHex === null ? new Uint8Array() : hexToBytes(tip.previousHashHex),
  );
  await upsertMeta(database, TIP_META_KEYS.tipStateHashHex, encodeNullableText(tip.stateHashHex));
  await upsertMeta(database, TIP_META_KEYS.tipStateBytes, stateBytes);
  await upsertMeta(database, TIP_META_KEYS.tipUpdatedAt, encodeInteger(updatedAt));
}
