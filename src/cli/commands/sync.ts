import { dirname } from "node:path";

import { formatManagedSyncErrorMessage } from "../../bitcoind/errors.js";
import { FileLockBusyError, acquireFileLock } from "../../wallet/fs/lock.js";
import { resolveWalletRootIdFromLocalArtifacts } from "../../wallet/root-resolution.js";
import { withInteractiveWalletSecretProvider } from "../../wallet/state/provider.js";
import { usesTtyProgress, writeLine } from "../io.js";
import { classifyCliError, formatCliTextError } from "../output.js";
import { createTerminalPrompter } from "../prompt.js";
import { createStopSignalWatcher, waitForCompletionOrStop } from "../signals.js";
import { createSyncProgressReporter } from "../sync-progress.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";
import { formatBalanceReport } from "../wallet-format.js";

async function writePostSyncBalanceReport(options: {
  context: RequiredCliRunnerContext;
  dataDir: string;
  databasePath: string;
  runtimePaths: ReturnType<RequiredCliRunnerContext["resolveWalletRuntimePaths"]>;
}): Promise<void> {
  const provider = withInteractiveWalletSecretProvider(
    options.context.walletSecretProvider,
    options.context.createPrompter?.() ?? createTerminalPrompter(options.context.stdin, options.context.stdout),
  );
  const readContext = await options.context.openWalletReadContext({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    secretProvider: provider,
    walletControlLockHeld: true,
    paths: options.runtimePaths,
  });

  try {
    writeLine(options.context.stdout, formatBalanceReport(readContext));
  } finally {
    await readContext.close().catch(() => undefined);
  }
}

export async function runSyncCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();
  const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
  const runtimePaths = context.resolveWalletRuntimePaths();
  const ttyProgressActive = usesTtyProgress(parsed.progressOutput, context.stderr);
  let controlLock: Awaited<ReturnType<typeof acquireFileLock>> | null = null;
  let store: Awaited<ReturnType<typeof context.openSqliteStore>> | null = null;
  let storeOwned = true;
  let client: Awaited<ReturnType<typeof context.openManagedBitcoindClient>> | null = null;
  let clientClosed = false;

  try {
    const walletRoot = await resolveWalletRootIdFromLocalArtifacts({
      paths: runtimePaths,
      provider: context.walletSecretProvider,
      loadRawWalletStateEnvelope: context.loadRawWalletStateEnvelope,
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

    client = await context.openManagedBitcoindClient({
      store,
      databasePath: dbPath,
      dataDir,
      walletRootId: walletRoot.walletRootId,
      progressOutput: parsed.progressOutput,
      onProgress: ttyProgressActive ? undefined : createSyncProgressReporter({
        progressOutput: parsed.progressOutput,
        write: (line) => {
          writeLine(context.stderr, line);
        },
      }),
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

      if (result.endingHeight !== null && result.endingHeight === result.bestHeight) {
        stopWatcher.cleanup();

        const detachPromise = typeof client.detachToBackgroundFollow === "function"
          ? client.detachToBackgroundFollow()
          : Promise.resolve();

        if (typeof client.playSyncCompletionScene === "function") {
          await client.playSyncCompletionScene().catch(() => undefined);
        }

        try {
          await detachPromise;
          await client.close();
          clientClosed = true;
          writeLine(context.stderr, "Detached cleanly; background indexer follow resumed.");
          await writePostSyncBalanceReport({
            context,
            dataDir,
            databasePath: dbPath,
            runtimePaths,
          }).catch(() => undefined);
          return 0;
        } catch {
          writeLine(context.stderr, "Detach failed before background indexer follow was confirmed.");
          return 1;
        }
      }

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
      if (!clientClosed) {
        await client.close();
      }
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
