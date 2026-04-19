import { dirname } from "node:path";

import { DEFAULT_SNAPSHOT_METADATA, resolveBootstrapPathsForTesting } from "../../bitcoind/bootstrap.js";
import { resolveWalletRootIdFromLocalArtifacts } from "../../wallet/root-resolution.js";
import { withInteractiveWalletSecretProvider } from "../../wallet/state/provider.js";
import {
  ManagedIndexerProgressObserver,
  pollManagedIndexerUntilCaughtUp,
} from "../managed-indexer-observer.js";
import {
  buildMineStartData,
  buildMineStopData,
} from "../mining-json.js";
import {
  buildMineStartPreviewData,
  buildMineStopPreviewData,
} from "../preview-json.js";
import { usesTtyProgress, writeLine } from "../io.js";
import { createTerminalPrompter } from "../prompt.js";
import {
  createPreviewSuccessEnvelope,
  createMutationSuccessEnvelope,
  describeCanonicalCommand,
  resolvePreviewJsonSchema,
  resolveStableMiningControlJsonSchema,
  writeHandledCliError,
  writeJsonValue,
} from "../output.js";
import {
  formatNextStepLines,
  getMineStopNextSteps,
} from "../workflow-hints.js";
import { createCloseSignalWatcher, waitForCompletionOrStop } from "../signals.js";
import { createSyncProgressReporter } from "../sync-progress.js";
import {
  PASSIVE_UPDATE_CHECK_TIMEOUT_MS,
  applyUpdateCheckResult,
  compareSemver,
  createEmptyUpdateCheckCache,
  fetchLatestPublishedVersion,
  isUpdateCheckDisabled,
  loadUpdateCheckCache,
  persistUpdateCheckCache,
  shouldRefreshUpdateCheck,
} from "../update-service.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";

function createCommandPrompter(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
) {
  return parsed.outputMode !== "text"
    ? createTerminalPrompter(context.stdin, context.stderr)
    : context.createPrompter();
}

async function ensureMiningProviderSetup(options: {
  context: RequiredCliRunnerContext;
  provider: RequiredCliRunnerContext["walletSecretProvider"];
  prompter: ReturnType<typeof createCommandPrompter>;
  runtimePaths: ReturnType<RequiredCliRunnerContext["resolveWalletRuntimePaths"]>;
}): Promise<void> {
  const setupReady = await options.context.ensureBuiltInMiningSetupIfNeeded({
    provider: options.provider,
    prompter: options.prompter,
    paths: options.runtimePaths,
  });

  if (!setupReady) {
    throw new Error("Built-in mining provider is not configured. Run `cogcoin mine setup`.");
  }
}

async function syncManagedMiningReadiness(options: {
  parsed: ParsedCliArgs;
  context: RequiredCliRunnerContext;
  dataDir: string;
  databasePath: string;
  expectedBinaryVersion: string;
  provider: RequiredCliRunnerContext["walletSecretProvider"];
  runtimePaths: ReturnType<RequiredCliRunnerContext["resolveWalletRuntimePaths"]>;
}): Promise<number | null> {
  const ttyProgressActive = usesTtyProgress(options.parsed.progressOutput, options.context.stderr);
  let monitor: Awaited<ReturnType<RequiredCliRunnerContext["openManagedIndexerMonitor"]>> | null = null;
  let observer: ManagedIndexerProgressObserver | null = null;

  const walletRoot = await resolveWalletRootIdFromLocalArtifacts({
    paths: options.runtimePaths,
    provider: options.provider,
    loadRawWalletStateEnvelope: options.context.loadRawWalletStateEnvelope,
  });

  await options.context.ensureDirectory(dirname(options.databasePath));
  monitor = await options.context.openManagedIndexerMonitor({
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    walletRootId: walletRoot.walletRootId,
    expectedBinaryVersion: options.expectedBinaryVersion,
  });
  observer = new ManagedIndexerProgressObserver({
    quoteStatePath: resolveBootstrapPathsForTesting(
      options.dataDir,
      DEFAULT_SNAPSHOT_METADATA,
    ).quoteStatePath,
    stream: options.context.stderr,
    progressOutput: options.parsed.progressOutput,
    onProgress: ttyProgressActive ? undefined : createSyncProgressReporter({
      progressOutput: options.parsed.progressOutput,
      write: (line) => {
        writeLine(options.context.stderr, line);
      },
    }),
  });
  const abortController = new AbortController();
  const stopWatcher = createCloseSignalWatcher({
    signalSource: options.context.signalSource,
    stderr: options.context.stderr,
    closeable: {
      close: async () => {
        abortController.abort(new Error("managed_indexer_preflight_aborted"));
        await observer?.close().catch(() => undefined);
        await monitor?.close().catch(() => undefined);
      },
    },
    forceExit: options.context.forceExit,
    firstMessage: "Stopping managed mining readiness observation...",
    successMessage: "Stopped observing managed mining readiness.",
    failureMessage: "Managed mining readiness observation cleanup failed.",
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

    return null;
  } finally {
    stopWatcher.cleanup();
    await observer?.close().catch(() => undefined);
    await monitor?.close().catch(() => undefined);
  }
}

async function resolveMineUpdateAvailable(
  currentVersion: string,
  context: RequiredCliRunnerContext,
): Promise<boolean> {
  if (isUpdateCheckDisabled(context.env)) {
    return false;
  }

  try {
    const cachePath = context.resolveUpdateCheckStatePath();
    const now = context.now();
    let cache = await loadUpdateCheckCache(cachePath) ?? createEmptyUpdateCheckCache();
    let cacheChanged = false;

    if (shouldRefreshUpdateCheck(cache, now)) {
      const updateResult = await fetchLatestPublishedVersion(context.fetchImpl, {
        timeoutMs: PASSIVE_UPDATE_CHECK_TIMEOUT_MS,
      });
      cache = applyUpdateCheckResult(cache, updateResult, now);
      cacheChanged = true;
    }

    if (cacheChanged) {
      await persistUpdateCheckCache(cachePath, cache);
    }

    if (cache.latestVersion === null) {
      return false;
    }

    const comparison = compareSemver(cache.latestVersion, currentVersion);
    return comparison !== null && comparison > 0;
  } catch {
    return false;
  }
}

export async function runMiningRuntimeCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  try {
    const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();
    const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
    const packageVersion = await context.readPackageVersion();
    const runtimePaths = context.resolveWalletRuntimePaths(parsed.seedName);

    if (parsed.command === "mine") {
      const prompter = context.createPrompter();
      const provider = withInteractiveWalletSecretProvider(context.walletSecretProvider, prompter);
      await ensureMiningProviderSetup({
        context,
        provider,
        prompter,
        runtimePaths,
      });
      const preflightCode = await syncManagedMiningReadiness({
        parsed,
        context,
        dataDir,
        databasePath: dbPath,
        expectedBinaryVersion: packageVersion,
        provider,
        runtimePaths,
      });
      if (preflightCode !== null) {
        return preflightCode;
      }
      const updateAvailable = usesTtyProgress(parsed.progressOutput, context.stderr)
        ? await resolveMineUpdateAvailable(packageVersion, context)
        : false;
      const abortController = new AbortController();
      const onStop = (): void => {
        abortController.abort();
      };

      context.signalSource.on("SIGINT", onStop);
      context.signalSource.on("SIGTERM", onStop);

      try {
        await context.runForegroundMining({
          clientVersion: packageVersion,
          updateAvailable,
          dataDir,
          databasePath: dbPath,
          provider,
          prompter,
          signal: abortController.signal,
          stdout: context.stdout,
          stderr: context.stderr,
          progressOutput: parsed.progressOutput,
          builtInSetupEnsured: true,
          paths: runtimePaths,
        });
      } finally {
        context.signalSource.off("SIGINT", onStop);
        context.signalSource.off("SIGTERM", onStop);
      }

      return 0;
    }

    if (parsed.command === "mine-start") {
      const prompter = createCommandPrompter(parsed, context);
      const provider = withInteractiveWalletSecretProvider(
        context.walletSecretProvider,
        prompter,
      );
      await ensureMiningProviderSetup({
        context,
        provider,
        prompter,
        runtimePaths,
      });
      const preflightCode = await syncManagedMiningReadiness({
        parsed,
        context,
        dataDir,
        databasePath: dbPath,
        expectedBinaryVersion: packageVersion,
        provider,
        runtimePaths,
      });
      if (preflightCode !== null) {
        return preflightCode;
      }
      const result = await context.startBackgroundMining({
        dataDir,
        databasePath: dbPath,
        provider,
        prompter,
        builtInSetupEnsured: true,
        paths: runtimePaths,
      });

      if (parsed.outputMode === "preview-json") {
        writeJsonValue(context.stdout, createPreviewSuccessEnvelope(
          resolvePreviewJsonSchema(parsed)!,
          describeCanonicalCommand(parsed),
          result.started ? "started" : "already-active",
          buildMineStartPreviewData(result),
        ));
        return 0;
      }

      if (parsed.outputMode === "json") {
        writeJsonValue(context.stdout, createMutationSuccessEnvelope(
          resolveStableMiningControlJsonSchema(parsed)!,
          "cogcoin mine start",
          result.started ? "started" : "already-active",
          buildMineStartData(result),
        ));
        return 0;
      }

      if (!result.started) {
        writeLine(context.stdout, "Background mining is already active.");
        if (result.snapshot?.backgroundWorkerPid !== null && result.snapshot?.backgroundWorkerPid !== undefined) {
          writeLine(context.stdout, `Worker pid: ${result.snapshot.backgroundWorkerPid}`);
        }
        return 0;
      }

      writeLine(context.stdout, "Started background mining.");
      if (result.snapshot?.backgroundWorkerPid !== null && result.snapshot?.backgroundWorkerPid !== undefined) {
        writeLine(context.stdout, `Worker pid: ${result.snapshot.backgroundWorkerPid}`);
      }
      return 0;
    }

    if (parsed.command === "mine-stop") {
      const provider = parsed.outputMode === "text"
        ? withInteractiveWalletSecretProvider(context.walletSecretProvider, context.createPrompter())
        : context.walletSecretProvider;
      const snapshot = await context.stopBackgroundMining({
        dataDir,
        databasePath: dbPath,
        provider,
        paths: runtimePaths,
      });
      const nextSteps = getMineStopNextSteps();
      if (parsed.outputMode === "preview-json") {
        writeJsonValue(context.stdout, createPreviewSuccessEnvelope(
          resolvePreviewJsonSchema(parsed)!,
          describeCanonicalCommand(parsed),
          snapshot === null ? "not-active" : "stopped",
          buildMineStopPreviewData(snapshot),
          {
            nextSteps,
          },
        ));
        return 0;
      }
      if (parsed.outputMode === "json") {
        writeJsonValue(context.stdout, createMutationSuccessEnvelope(
          resolveStableMiningControlJsonSchema(parsed)!,
          "cogcoin mine stop",
          snapshot === null ? "not-active" : "stopped",
          buildMineStopData(snapshot),
          {
            nextSteps,
          },
        ));
        return 0;
      }
      writeLine(context.stdout, snapshot?.note ?? "Background mining was not active.");
      for (const line of formatNextStepLines(nextSteps)) {
        writeLine(context.stdout, line);
      }
      return 0;
    }

    writeLine(context.stderr, `mining runtime command not implemented: ${parsed.command}`);
    return 1;
  } catch (error) {
    return writeHandledCliError({
      parsed,
      stdout: context.stdout,
      stderr: context.stderr,
      error,
    });
  }
}
