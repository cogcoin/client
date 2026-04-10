type BetterSqliteValue = bigint | Buffer | number | string | null;

export interface BetterSqliteRow {
  [key: string]: unknown;
}

export interface BetterSqliteStatement {
  run(...params: BetterSqliteValue[]): {
    changes: bigint | number;
    lastInsertRowid: bigint | number;
  };
  get(...params: BetterSqliteValue[]): BetterSqliteRow | undefined;
  all(...params: BetterSqliteValue[]): BetterSqliteRow[];
}

export interface BetterSqliteDatabaseHandle {
  exec(sql: string): void;
  prepare(sql: string): BetterSqliteStatement;
  close(): void;
}

export interface BetterSqliteOpenOptions {
  fileMustExist?: boolean;
  readonly?: boolean;
}

interface BetterSqliteConstructor {
  new (filename: string, options?: BetterSqliteOpenOptions): BetterSqliteDatabaseHandle;
}

export async function loadBetterSqlite3(): Promise<BetterSqliteConstructor> {
  const imported = await import("better-sqlite3");
  return (imported.default ?? imported) as unknown as BetterSqliteConstructor;
}
