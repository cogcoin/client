import { loadBetterSqlite3 } from "../../sqlite/better-sqlite3.js";

export const SQLITE_NATIVE_MODULE_UNAVAILABLE = "sqlite_native_module_unavailable";

type LoadBetterSqlite3 = typeof loadBetterSqlite3;

export function isSqliteNativeModuleLoadFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message;
  return message.includes("NODE_MODULE_VERSION")
    || message.includes("better_sqlite3.node")
    || message.includes("Cannot find module 'better-sqlite3'")
    || message.includes('Cannot find module "better-sqlite3"');
}

export function createSqliteNativeModuleUnavailableError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${SQLITE_NATIVE_MODULE_UNAVAILABLE}: ${detail}`, { cause: error });
}

export async function assertIndexerDaemonNativeDependencies(
  loadBetterSqlite3Impl: LoadBetterSqlite3 = loadBetterSqlite3,
): Promise<void> {
  try {
    await loadBetterSqlite3Impl();
  } catch (error) {
    if (isSqliteNativeModuleLoadFailure(error)) {
      throw createSqliteNativeModuleUnavailableError(error);
    }

    throw error;
  }
}
