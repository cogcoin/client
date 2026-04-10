import { cloneBytes } from "../bytes.js";
import { loadBetterSqlite3 } from "./better-sqlite3.js";
import type { SqlitePragmaOptions, SqliteStoreOptions } from "./types.js";

type SqliteValue = bigint | null | number | string | Uint8Array;

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: bigint | number | null;
}

export interface SqliteDatabase {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqliteValue[]): Promise<SqliteRunResult>;
  get<T>(sql: string, params?: readonly SqliteValue[]): Promise<T | null>;
  all<T>(sql: string, params?: readonly SqliteValue[]): Promise<T[]>;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type SqliteRow = Record<string, unknown>;

function normalizeValue(value: SqliteValue): bigint | Buffer | number | string | null {
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  return value;
}

function normalizeRow<T>(row: T | null | undefined): T | null {
  if (row === null || row === undefined) {
    return null;
  }

  if (typeof row !== "object" || row === null) {
    return row;
  }

  const next = { ...(row as SqliteRow) };

  for (const [key, value] of Object.entries(next)) {
    if (value instanceof Uint8Array) {
      next[key] = cloneBytes(value);
    } else if (Buffer.isBuffer(value)) {
      next[key] = new Uint8Array(value);
    }
  }

  return next as T;
}

function normalizeRows<T>(rows: T[]): T[] {
  return rows.map((row) => normalizeRow(row) as T);
}

interface BetterSqliteDatabaseOptions {
  filename: string;
  fileMustExist?: boolean;
  readonly?: boolean;
}

async function openBetterSqliteDatabase(options: BetterSqliteDatabaseOptions): Promise<SqliteDatabase> {
  const BetterSqlite3 = await loadBetterSqlite3();
  const openOptions: {
    fileMustExist?: boolean;
    readonly?: boolean;
  } = {};

  if (options.fileMustExist !== undefined) {
    openOptions.fileMustExist = options.fileMustExist;
  }

  if (options.readonly !== undefined) {
    openOptions.readonly = options.readonly;
  }

  const database = new BetterSqlite3(options.filename, openOptions);

  return {
    async exec(sql: string): Promise<void> {
      database.exec(sql);
    },
    async run(sql: string, params: readonly SqliteValue[] = []): Promise<SqliteRunResult> {
      const statement = database.prepare(sql);
      const result = statement.run(...params.map(normalizeValue));
      return {
        changes: Number(result.changes),
        lastInsertRowid: result.lastInsertRowid,
      };
    },
    async get<T>(sql: string, params: readonly SqliteValue[] = []): Promise<T | null> {
      const statement = database.prepare(sql);
      return normalizeRow((statement.get(...params.map(normalizeValue)) as T | undefined) ?? null);
    },
    async all<T>(sql: string, params: readonly SqliteValue[] = []): Promise<T[]> {
      const statement = database.prepare(sql);
      return normalizeRows((statement.all(...params.map(normalizeValue)) as T[]) ?? []);
    },
    async transaction<T>(operation: () => Promise<T>): Promise<T> {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = await operation();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    async close(): Promise<void> {
      database.close();
    },
  };
}

async function applyPragmas(database: SqliteDatabase, pragmas: SqlitePragmaOptions | undefined): Promise<void> {
  const foreignKeys = pragmas?.foreignKeys ?? true;
  const busyTimeoutMs = pragmas?.busyTimeoutMs ?? 5000;
  const journalMode = pragmas?.journalMode ?? "WAL";
  const synchronous = pragmas?.synchronous ?? "FULL";

  await database.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  await database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  await database.get("PRAGMA journal_mode = " + journalMode);
  await database.exec(`PRAGMA synchronous = ${synchronous}`);
}

export async function openSqliteDatabase(options: SqliteStoreOptions): Promise<SqliteDatabase> {
  const database = await openBetterSqliteDatabase(options);
  await applyPragmas(database, options.pragmas);
  return database;
}

export async function openReadonlySqliteDatabase(filename: string): Promise<SqliteDatabase> {
  return openBetterSqliteDatabase({
    filename,
    fileMustExist: true,
    readonly: true,
  });
}
