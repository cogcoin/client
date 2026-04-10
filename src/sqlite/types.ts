export interface SqlitePragmaOptions {
  foreignKeys?: boolean;
  busyTimeoutMs?: number;
  journalMode?: "WAL" | "DELETE" | "TRUNCATE" | "PERSIST" | "MEMORY" | "OFF";
  synchronous?: "FULL" | "NORMAL" | "OFF" | "EXTRA";
}

export interface SqliteStoreOptions {
  filename: string;
  pragmas?: SqlitePragmaOptions;
}
