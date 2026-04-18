import { dirname } from "node:path";

import { FileLockBusyError, acquireFileLock } from "../../wallet/fs/lock.js";
import { resolveWalletRootIdFromLocalArtifacts } from "../../wallet/root-resolution.js";
import { withInteractiveWalletSecretProvider } from "../../wallet/state/provider.js";
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
import { createStopSignalWatcher, waitForCompletionOrStop } from "../signals.js";
import { createSyncProgressReporter } from "../sync-progress.js";
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
  provider: RequiredCliRunnerContext["walletSecretProvider"];
  runtimePaths: ReturnType<RequiredCliRunnerContext["resolveWalletRuntimePaths"]>;
}): Promise<number | null> {
  const ttyProgressActive = usesTtyProgress(options.parsed.progressOutput, options.context.stderr);
  let controlLock: Awaited<ReturnType<typeof acquireFileLock>> | null = null;
  let store: Awaited<ReturnType<RequiredCliRunnerContext["openSqliteStore"]>> | null = null;
  let storeOwned = true;
  let client: Awaited<ReturnType<RequiredCliRunnerContext["openManagedBitcoindClient"]>> | null = null;
  let clientClosed = false;

  try {
    const walletRoot = await resolveWalletRootIdFromLocalArtifacts({
      paths: options.runtimePaths,
      provider: options.provider,
      loadRawWalletStateEnvelope: options.context.loadRawWalletStateEnvelope,
    });

    try {
      controlLock = await acquireFileLock(options.runtimePaths.walletControlLockPath, {
        purpose: "managed-sync",
        walletRootId: walletRoot.walletRootId,
      });
    } catch (error) {
      if (error instanceof FileLockBusyError) {
        throw new Error("wallet_control_lock_busy");
      }

      throw error;
    }

    await options.context.ensureDirectory(dirname(options.databasePath));
    store = await options.context.openSqliteStore({ filename: options.databasePath });
    client = await options.context.openManagedBitcoindClient({
      store,
      databasePath: options.databasePath,
      dataDir: options.dataDir,
      walletRootId: walletRoot.walletRootId,
      progressOutput: options.parsed.progressOutput,
      onProgress: ttyProgressActive ? undefined : createSyncProgressReporter({
        progressOutput: options.parsed.progressOutput,
        write: (line) => {
          writeLine(options.context.stderr, line);
        },
      }),
    });
    storeOwned = false;
    const stopWatcher = createStopSignalWatcher(
      options.context.signalSource,
      options.context.stderr,
      client,
      options.context.forceExit,
      [options.runtimePaths.walletControlLockPath],
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

        try {
          await detachPromise;
          await client.close();
          clientClosed = true;
          writeLine(options.context.stderr, "Detached cleanly; background indexer follow resumed.");
          return null;
        } catch {
          writeLine(options.context.stderr, "Detach failed before background indexer follow was confirmed.");
          return 1;
        }
      }

      throw new Error("Managed sync did not reach the current Bitcoin tip.");
    } finally {
      stopWatcher.cleanup();
      if (!clientClosed) {
        await client.close();
      }
    }
  } finally {
    if (storeOwned && store !== null) {
      await store.close().catch(() => undefined);
    }
    await controlLock?.release().catch(() => undefined);
  }
}

export async function runMiningRuntimeCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  try {
    const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();
    const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
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
        provider,
        runtimePaths,
      });
      if (preflightCode !== null) {
        return preflightCode;
      }
      const abortController = new AbortController();
      const onStop = (): void => {
        abortController.abort();
      };

      context.signalSource.on("SIGINT", onStop);
      context.signalSource.on("SIGTERM", onStop);

      try {
        await context.runForegroundMining({
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
