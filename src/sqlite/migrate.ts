import type { SqliteDatabase } from "./driver.js";

const SCHEMA_VERSION = 1;

export async function migrateSqliteStore(database: SqliteDatabase): Promise<void> {
  const versionRow = await database.get<{ user_version: number }>("PRAGMA user_version");
  const currentVersion = versionRow?.user_version ?? 0;

  if (currentVersion > SCHEMA_VERSION) {
    throw new Error("sqlite_store_schema_version_unsupported");
  }

  if (currentVersion === 0) {
    await database.transaction(async () => {
      await database.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value BLOB NOT NULL
        )
      `);
      await database.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          height INTEGER PRIMARY KEY,
          block_hash BLOB NOT NULL,
          state_bytes BLOB NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      await database.exec(`
        CREATE TABLE IF NOT EXISTS block_records (
          height INTEGER PRIMARY KEY,
          block_hash BLOB NOT NULL UNIQUE,
          previous_hash BLOB NOT NULL,
          record_bytes BLOB NOT NULL,
          state_hash_hex TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      await database.exec("PRAGMA user_version = 1");
    });
  }
}
