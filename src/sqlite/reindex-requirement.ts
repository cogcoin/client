import { encodeText } from "../bytes.js";
import { openSqliteDatabase, type SqliteDatabase } from "./driver.js";
import { migrateSqliteStore } from "./migrate.js";
import { clearTipMeta, TIP_META_KEYS } from "./tip-meta.js";

export const CLIENT_REINDEX_REQUIREMENT_V1_2_0_KEY = "client_reindex_requirement_v1_2_0";

export type ClientReindexRequirementAction =
  | "already-applied"
  | "marked-empty"
  | "marked-current"
  | "reset-and-marked";

export type ClientReindexRequirementStatus =
  | "applied"
  | "mark-current"
  | "mark-empty"
  | "reset-required";

interface CountRow {
  count: number;
}

interface StateBytesRow {
  state_bytes?: Uint8Array;
  value?: Uint8Array;
}

const textDecoder = new TextDecoder();

async function hasRows(database: SqliteDatabase, sql: string, params: readonly string[] = []): Promise<boolean> {
  return (await database.get<CountRow>(sql, params)) !== null;
}

async function hasIndexerRows(database: SqliteDatabase): Promise<boolean> {
  const hasTipMeta = await hasRows(
    database,
    `SELECT 1 AS count FROM meta WHERE key = ? LIMIT 1`,
    [TIP_META_KEYS.tipHeight],
  );

  if (hasTipMeta) {
    return true;
  }

  if (await hasRows(database, `SELECT 1 AS count FROM checkpoints LIMIT 1`)) {
    return true;
  }

  return await hasRows(database, `SELECT 1 AS count FROM block_records LIMIT 1`);
}

async function loadLatestStateBytes(database: SqliteDatabase): Promise<Uint8Array | null> {
  const tipStateRow = await database.get<StateBytesRow>(
    `SELECT value FROM meta WHERE key = ? LIMIT 1`,
    [TIP_META_KEYS.tipStateBytes],
  );

  if (tipStateRow?.value !== undefined) {
    return tipStateRow.value;
  }

  const checkpointRow = await database.get<StateBytesRow>(
    `SELECT state_bytes FROM checkpoints ORDER BY height DESC LIMIT 1`,
  );

  return checkpointRow?.state_bytes ?? null;
}

function serializedStateIncludesV12HistoryShape(stateBytes: Uint8Array): boolean {
  const serialized = textDecoder.decode(stateBytes);
  return serialized.includes("\"explorerBlocksByHeight\"")
    && serialized.includes("\"explorerTransactionsByHeight\"");
}

async function isRequirementApplied(database: SqliteDatabase): Promise<boolean> {
  const marker = await database.get<{ value: Uint8Array }>(
    `SELECT value FROM meta WHERE key = ?`,
    [CLIENT_REINDEX_REQUIREMENT_V1_2_0_KEY],
  );
  return marker !== null;
}

async function writeRequirementMarker(database: SqliteDatabase): Promise<void> {
  await database.run(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [CLIENT_REINDEX_REQUIREMENT_V1_2_0_KEY, encodeText("applied")],
  );
}

export async function isClientReindexRequirementV12Applied(databasePath: string): Promise<boolean> {
  const database = await openSqliteDatabase({ filename: databasePath });

  try {
    await migrateSqliteStore(database);
    return await isRequirementApplied(database);
  } finally {
    await database.close();
  }
}

async function resolveRequirementStatus(database: SqliteDatabase): Promise<ClientReindexRequirementStatus> {
  if (await isRequirementApplied(database)) {
    return "applied";
  }

  if (!await hasIndexerRows(database)) {
    return "mark-empty";
  }

  const stateBytes = await loadLatestStateBytes(database);

  if (stateBytes !== null && serializedStateIncludesV12HistoryShape(stateBytes)) {
    return "mark-current";
  }

  return "reset-required";
}

export async function resolveClientReindexRequirementV12(databasePath: string): Promise<ClientReindexRequirementStatus> {
  const database = await openSqliteDatabase({ filename: databasePath });

  try {
    await migrateSqliteStore(database);
    return await resolveRequirementStatus(database);
  } finally {
    await database.close();
  }
}

export async function ensureClientReindexRequirementV12(databasePath: string): Promise<{
  action: ClientReindexRequirementAction;
}> {
  const database = await openSqliteDatabase({ filename: databasePath });

  try {
    await migrateSqliteStore(database);

    return await database.transaction(async () => {
      switch (await resolveRequirementStatus(database)) {
        case "applied":
          return { action: "already-applied" };
        case "mark-empty":
          await writeRequirementMarker(database);
          return { action: "marked-empty" };
        case "mark-current":
          await writeRequirementMarker(database);
          return { action: "marked-current" };
        case "reset-required":
          await clearTipMeta(database);
          await database.run(`DELETE FROM checkpoints`);
          await database.run(`DELETE FROM block_records`);
          await writeRequirementMarker(database);
          return { action: "reset-and-marked" };
      }
    });
  } finally {
    await database.close();
  }
}
