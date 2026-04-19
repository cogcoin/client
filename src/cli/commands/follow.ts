import { dirname } from "node:path";

import { DEFAULT_SNAPSHOT_METADATA, resolveBootstrapPathsForTesting } from "../../bitcoind/bootstrap.js";
import { resolveWalletRootIdFromLocalArtifacts } from "../../wallet/root-resolution.js";
import {
  followManagedIndexerStatus,
  ManagedIndexerProgressObserver,
} from "../managed-indexer-observer.js";
import { usesTtyProgress, writeLine } from "../io.js";
import { classifyCliError } from "../output.js";
import { createCloseSignalWatcher, waitForCompletionOrStop } from "../signals.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";

export async function runFollowCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();
  const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
  const runtimePaths = context.resolveWalletRuntimePaths();
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
      followVisualMode: true,
    });
    const abortController = new AbortController();
    const stopWatcher = createCloseSignalWatcher({
      signalSource: context.signalSource,
      stderr: context.stderr,
      closeable: {
        close: async () => {
          abortController.abort(new Error("managed_indexer_follow_aborted"));
          await observer?.close().catch(() => undefined);
          await monitor?.close().catch(() => undefined);
        },
      },
      forceExit: context.forceExit,
      firstMessage: "Stopping managed Cogcoin tip observation...",
      successMessage: "Stopped observing managed Cogcoin tip.",
      failureMessage: "Managed Cogcoin tip observation cleanup failed.",
    });

    try {
      if (!usesTtyProgress(parsed.progressOutput, context.stderr)) {
        writeLine(context.stdout, "Following managed Cogcoin tip. Press Ctrl-C to stop.");
      }

      const followOutcome = await waitForCompletionOrStop(
        followManagedIndexerStatus({
          monitor,
          observer,
          signal: abortController.signal,
        }),
        stopWatcher,
      );

      if (followOutcome.kind === "stopped") {
        return followOutcome.code;
      }

      return 0;
    } catch (error) {
      writeLine(context.stderr, `follow failed: ${error instanceof Error ? error.message : String(error)}`);
      return classifyCliError(error).exitCode;
    } finally {
      stopWatcher.cleanup();
      await observer?.close().catch(() => undefined);
      await monitor?.close().catch(() => undefined);
    }
  } catch (error) {
    writeLine(context.stderr, `follow failed: ${error instanceof Error ? error.message : String(error)}`);
    return classifyCliError(error).exitCode;
  }
}
