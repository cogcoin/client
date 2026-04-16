import { dirname } from "node:path";

import { FileLockBusyError, acquireFileLock } from "../../wallet/fs/lock.js";
import { resolveWalletRootIdFromLocalArtifacts } from "../../wallet/root-resolution.js";
import { usesTtyProgress, writeLine } from "../io.js";
import { classifyCliError, formatCliTextError } from "../output.js";
import { createStopSignalWatcher } from "../signals.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";

export async function runFollowCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();
  const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
  const runtimePaths = context.resolveWalletRuntimePaths();
  let controlLock: Awaited<ReturnType<typeof acquireFileLock>> | null = null;
  let store: Awaited<ReturnType<typeof context.openSqliteStore>> | null = null;
  let storeOwned = true;

  try {
    const walletRoot = await resolveWalletRootIdFromLocalArtifacts({
      paths: runtimePaths,
      provider: context.walletSecretProvider,
      loadRawWalletStateEnvelope: context.loadRawWalletStateEnvelope,
      loadUnlockSession: context.loadUnlockSession,
      loadWalletExplicitLock: context.loadWalletExplicitLock,
    });

    try {
      controlLock = await acquireFileLock(runtimePaths.walletControlLockPath, {
        purpose: "managed-follow",
        walletRootId: walletRoot.walletRootId,
      });
    } catch (error) {
      if (error instanceof FileLockBusyError) {
        throw new Error("wallet_control_lock_busy");
      }

      throw error;
    }

    await context.ensureDirectory(dirname(dbPath));
    store = await context.openSqliteStore({ filename: dbPath });

    const client = await context.openManagedBitcoindClient({
      store,
      databasePath: dbPath,
      dataDir,
      walletRootId: walletRoot.walletRootId,
      progressOutput: parsed.progressOutput,
    });
    storeOwned = false;
    const stopWatcher = createStopSignalWatcher(
      context.signalSource,
      context.stderr,
      client,
      context.forceExit,
      [runtimePaths.walletControlLockPath],
    );

    try {
      await client.startFollowingTip();

      if (!usesTtyProgress(parsed.progressOutput, context.stderr)) {
        writeLine(context.stdout, "Following managed Cogcoin tip. Press Ctrl-C to stop.");
      }

      return await stopWatcher.promise;
    } catch (error) {
      writeLine(context.stderr, `follow failed: ${error instanceof Error ? error.message : String(error)}`);
      await client.close().catch(() => undefined);
      return classifyCliError(error).exitCode;
    } finally {
      stopWatcher.cleanup();
    }
  } catch (error) {
    const classified = classifyCliError(error);

    if (classified.errorCode === "wallet_control_lock_busy") {
      const formatted = formatCliTextError(error);

      if (formatted !== null) {
        for (const line of formatted) {
          writeLine(context.stderr, line);
        }
      } else {
        writeLine(context.stderr, classified.message);
      }
    } else {
      writeLine(context.stderr, `follow failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (storeOwned && store !== null) {
      await store.close().catch(() => undefined);
    }
    return classified.exitCode;
  } finally {
    await controlLock?.release().catch(() => undefined);
  }
}
