import { dirname } from "node:path";

import { DEFAULT_SNAPSHOT_METADATA, resolveBootstrapPathsForTesting } from "../../bitcoind/bootstrap.js";
import { formatManagedSyncErrorMessage } from "../../bitcoind/errors.js";
import { resolveWalletRootIdFromLocalArtifacts } from "../../wallet/root-resolution.js";
import { withInteractiveWalletSecretProvider } from "../../wallet/state/provider.js";
import {
  ManagedIndexerProgressObserver,
  pollManagedIndexerUntilCaughtUp,
} from "../managed-indexer-observer.js";
import { usesTtyProgress, writeLine } from "../io.js";
import { classifyCliError } from "../output.js";
import { createTerminalPrompter } from "../prompt.js";
import { createCloseSignalWatcher, waitForCompletionOrStop } from "../signals.js";
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
  let monitor: Awaited<ReturnType<typeof context.openManagedIndexerMonitor>> | null = null;
  let observer: ManagedIndexerProgressObserver | null = null;

  try {
    const walletRoot = await resolveWalletRootIdFromLocalArtifacts({
      paths: runtimePaths,
      provider: context.walletSecretProvider,
      loadRawWalletStateEnvelope: context.loadRawWalletStateEnvelope,
    });

    await context.ensureDirectory(dirname(dbPath));
    monitor = await context.openManagedIndexerMonitor({
      dataDir,
      databasePath: dbPath,
      walletRootId: walletRoot.walletRootId,
    });
    observer = new ManagedIndexerProgressObserver({
      quoteStatePath: resolveBootstrapPathsForTesting(dataDir, DEFAULT_SNAPSHOT_METADATA).quoteStatePath,
      stream: context.stderr,
      progressOutput: parsed.progressOutput,
      onProgress: ttyProgressActive ? undefined : createSyncProgressReporter({
        progressOutput: parsed.progressOutput,
        write: (line) => {
          writeLine(context.stderr, line);
        },
      }),
    });
    const abortController = new AbortController();
    const stopWatcher = createCloseSignalWatcher({
      signalSource: context.signalSource,
      stderr: context.stderr,
      closeable: {
        close: async () => {
          abortController.abort(new Error("managed_indexer_observer_aborted"));
          await observer?.close().catch(() => undefined);
          await monitor?.close().catch(() => undefined);
        },
      },
      forceExit: context.forceExit,
      firstMessage: "Stopping managed Cogcoin sync observation...",
      successMessage: "Stopped observing managed Cogcoin sync.",
      failureMessage: "Managed Cogcoin sync observation cleanup failed.",
    });

    try {
      const syncOutcome = await waitForCompletionOrStop(
        pollManagedIndexerUntilCaughtUp({
          monitor,
          observer,
          signal: abortController.signal,
        }),
        stopWatcher,
      );

      if (syncOutcome.kind === "stopped") {
        return syncOutcome.code;
      }

      if (ttyProgressActive) {
        await observer.playCompletionScene().catch(() => undefined);
      }

      await writePostSyncBalanceReport({
        context,
        dataDir,
        databasePath: dbPath,
        runtimePaths,
      }).catch(() => undefined);
      return 0;
    } finally {
      stopWatcher.cleanup();
      await observer?.close().catch(() => undefined);
      await monitor?.close().catch(() => undefined);
    }
  } catch (error) {
    const message = formatManagedSyncErrorMessage(error instanceof Error ? error.message : String(error));
    writeLine(context.stderr, `sync failed: ${message}`);
    return classifyCliError(error).exitCode;
  }
}
