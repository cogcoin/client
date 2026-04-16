import { dirname } from "node:path";

import { formatManagedSyncErrorMessage } from "../../bitcoind/errors.js";
import { FileLockBusyError, acquireFileLock } from "../../wallet/fs/lock.js";
import { resolveWalletRootIdFromLocalArtifacts } from "../../wallet/root-resolution.js";
import { writeLine } from "../io.js";
import { classifyCliError, formatCliTextError } from "../output.js";
import { createStopSignalWatcher, waitForCompletionOrStop } from "../signals.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";

export async function runSyncCommand(
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
        purpose: "managed-sync",
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
      const syncOutcome = await waitForCompletionOrStop(client.syncToTip(), stopWatcher);

      if (syncOutcome.kind === "stopped") {
        return syncOutcome.code;
      }

      const result = syncOutcome.value;

      if (typeof client.playSyncCompletionScene === "function") {
        const completionOutcome = await waitForCompletionOrStop(
          client.playSyncCompletionScene().catch(() => undefined),
          stopWatcher,
        );

        if (completionOutcome.kind === "stopped") {
          return completionOutcome.code;
        }
      }

      writeLine(context.stdout, `Applied blocks: ${result.appliedBlocks}`);
      writeLine(context.stdout, `Rewound blocks: ${result.rewoundBlocks}`);
      writeLine(context.stdout, `Indexed ending height: ${result.endingHeight ?? "none"}`);
      writeLine(context.stdout, `Node best height: ${result.bestHeight}`);
      return 0;
    } finally {
      stopWatcher.cleanup();
      await client.close();
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
      const message = formatManagedSyncErrorMessage(error instanceof Error ? error.message : String(error));
      writeLine(context.stderr, `sync failed: ${message}`);
    }

    if (storeOwned && store !== null) {
      await store.close().catch(() => undefined);
    }
    return classified.exitCode;
  } finally {
    await controlLock?.release().catch(() => undefined);
  }
}
