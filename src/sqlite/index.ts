import { createSqliteStoreAdapter } from "./store.js";
import { openSqliteDatabase } from "./driver.js";
import { migrateSqliteStore } from "./migrate.js";
import type { SqliteStoreOptions } from "./types.js";

export { migrateSqliteStore } from "./migrate.js";
export type * from "./types.js";

export async function openSqliteStore(options: SqliteStoreOptions) {
  const database = await openSqliteDatabase(options);
  await migrateSqliteStore(database);
  return createSqliteStoreAdapter(database);
}
