import { dirname } from "node:path";

import { DEFAULT_SNAPSHOT_METADATA, resolveBootstrapPathsForTesting } from "../../bitcoind/bootstrap.js";
import type { ManagedIndexerDaemonObservedStatus } from "../../bitcoind/types.js";
import {
  createEmptyMiningFollowVisualizerState,
  MiningFollowVisualizer,
} from "../../wallet/mining/visualizer.js";
import {
  createMiningReadinessSnapshot,
  isIndexerBackgroundFollowRecoveryFailure,
  recordMiningIndexerRuntimeError,
  recordMiningReadinessSnapshot,
} from "../../wallet/mining/runtime-status-snapshots.js";
import { createMiningStopRequestedError } from "../../wallet/mining/stop.js";
import { resolveWalletRootIdFromLocalArtifacts } from "../../wallet/root-resolution.js";
import { withInteractiveWalletSecretProvider } from "../../wallet/state/provider.js";
import { bindClientPasswordPromptSessionPolicy } from "../../wallet/state/client-password/session-policy.js";
import {
  ManagedIndexerProgressObserver,
  assertManagedIndexerStatusRecoverable,
  isManagedIndexerCaughtUp,
  pollManagedIndexerUntilCaughtUp,
} from "../managed-indexer-observer.js";
import { usesTtyProgress, writeLine } from "../io.js";
import { writeHandledCliError } from "../output.js";
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

const MANAGED_MINING_READINESS_POLL_INTERVAL_MS = 500;
const EMPTY_MINING_VISUALIZER_STATE = createEmptyMiningFollowVisualizerState();

function createCommandPrompter(
  context: RequiredCliRunnerContext,
) {
  return context.createPrompter();
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
    throw new Error(
      options.prompter.isInteractive
        ? "Built-in mining provider is not configured. Run `cogcoin mine setup`."
        : "mine_setup_requires_tty",
    );
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function recordManagedMiningReadinessFailure(options: {
  context: RequiredCliRunnerContext;
  runtimePaths: ReturnType<RequiredCliRunnerContext["resolveWalletRuntimePaths"]>;
  walletRootId: string | null;
  error: unknown;
}): Promise<void> {
  const errorMessage = formatUnknownError(options.error);
  const eventMessage = isIndexerBackgroundFollowRecoveryFailure(options.error)
    ? "Mining preflight stopped because the managed indexer background follow could not recover."
    : `Mining preflight stopped because managed indexer readiness failed: ${errorMessage}`;
  await recordMiningIndexerRuntimeError({
    paths: options.runtimePaths,
    walletRootId: options.walletRootId,
    nowUnixMs: options.context.now(),
    errorMessage,
    eventMessage,
  }).catch(() => undefined);
}

async function pollManagedMiningReadinessWithVisualizer(options: {
  monitor: Awaited<ReturnType<RequiredCliRunnerContext["openManagedIndexerMonitor"]>>;
  context: RequiredCliRunnerContext;
  runtimePaths: ReturnType<RequiredCliRunnerContext["resolveWalletRuntimePaths"]>;
  walletRootId: string;
  visualizer: MiningFollowVisualizer;
  signal?: AbortSignal;
  pollIntervalMs?: number;
}): Promise<void> {
  while (true) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("managed_indexer_observer_aborted");
    }

    const status = await options.monitor.getStatus();
    const snapshot = await recordMiningReadinessSnapshot({
      paths: options.runtimePaths,
      walletRootId: options.walletRootId,
      observedStatus: status,
      nowUnixMs: options.context.now(),
    });
    options.visualizer.update(
      snapshot,
      EMPTY_MINING_VISUALIZER_STATE,
    );
    assertManagedIndexerStatusRecoverable(status);

    if (isManagedIndexerCaughtUp(status)) {
      return;
    }

    await sleep(options.pollIntervalMs ?? MANAGED_MINING_READINESS_POLL_INTERVAL_MS, options.signal);
  }
}

async function syncManagedMiningReadinessWithVisualizer(options: {
  context: RequiredCliRunnerContext;
  dataDir: string;
  databasePath: string;
  expectedBinaryVersion: string;
  provider: RequiredCliRunnerContext["walletSecretProvider"];
  runtimePaths: ReturnType<RequiredCliRunnerContext["resolveWalletRuntimePaths"]>;
  visualizer: MiningFollowVisualizer;
}): Promise<number | null> {
  let monitor: Awaited<ReturnType<RequiredCliRunnerContext["openManagedIndexerMonitor"]>> | null = null;

  const walletRoot = await resolveWalletRootIdFromLocalArtifacts({
    paths: options.runtimePaths,
    provider: options.provider,
    loadRawWalletStateEnvelope: options.context.loadRawWalletStateEnvelope,
  });

  const initialSnapshot = await recordMiningReadinessSnapshot({
    paths: options.runtimePaths,
    walletRootId: walletRoot.walletRootId,
    observedStatus: null,
    nowUnixMs: options.context.now(),
  });
  options.visualizer.update(initialSnapshot, EMPTY_MINING_VISUALIZER_STATE);

  try {
    await options.context.ensureDirectory(dirname(options.databasePath));
    monitor = await options.context.openManagedIndexerMonitor({
      dataDir: options.dataDir,
      databasePath: options.databasePath,
      walletRootId: walletRoot.walletRootId,
      expectedBinaryVersion: options.expectedBinaryVersion,
    });

    const abortController = new AbortController();
    const stopWatcher = createCloseSignalWatcher({
      signalSource: options.context.signalSource,
      stderr: options.context.stderr,
      closeable: {
        close: async () => {
          abortController.abort(new Error("managed_indexer_preflight_aborted"));
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
        pollManagedMiningReadinessWithVisualizer({
          monitor,
          context: options.context,
          runtimePaths: options.runtimePaths,
          walletRootId: walletRoot.walletRootId,
          visualizer: options.visualizer,
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
      await monitor?.close().catch(() => undefined);
    }
  } catch (error) {
    await recordManagedMiningReadinessFailure({
      context: options.context,
      runtimePaths: options.runtimePaths,
      walletRootId: walletRoot.walletRootId,
      error,
    });
    throw error;
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

  await recordMiningReadinessSnapshot({
    paths: options.runtimePaths,
    walletRootId: walletRoot.walletRootId,
    observedStatus: null,
    nowUnixMs: options.context.now(),
  });

  try {
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
          onStatus: async (status) => {
            await recordMiningReadinessSnapshot({
              paths: options.runtimePaths,
              walletRootId: walletRoot.walletRootId,
              observedStatus: status,
              nowUnixMs: options.context.now(),
            });
          },
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
  } catch (error) {
    await recordManagedMiningReadinessFailure({
      context: options.context,
      runtimePaths: options.runtimePaths,
      walletRootId: walletRoot.walletRootId,
      error,
    });
    throw error;
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
    const runtimePaths = context.resolveWalletRuntimePaths();

    if (parsed.command === "mine") {
      const prompter = bindClientPasswordPromptSessionPolicy(
        context.createPrompter(),
        "mining-indefinite",
      );
      const provider = withInteractiveWalletSecretProvider(context.walletSecretProvider, prompter);
      const ttyProgressActive = usesTtyProgress(parsed.progressOutput, context.stderr);
      await ensureMiningProviderSetup({
        context,
        provider,
        prompter,
        runtimePaths,
      });
      let visualizer: MiningFollowVisualizer | null = null;
      let abortController: AbortController | null = null;
      let onStop: (() => void) | null = null;

      try {
        if (ttyProgressActive) {
          visualizer = new MiningFollowVisualizer({
            clientVersion: packageVersion,
            progressOutput: parsed.progressOutput,
            stream: context.stderr,
          });
          visualizer.update(
            createMiningReadinessSnapshot({
              walletRootId: null,
              observedStatus: null,
              nowUnixMs: context.now(),
            }),
            EMPTY_MINING_VISUALIZER_STATE,
          );
        }

        const preflightCode = ttyProgressActive && visualizer !== null
          ? await syncManagedMiningReadinessWithVisualizer({
            context,
            dataDir,
            databasePath: dbPath,
            expectedBinaryVersion: packageVersion,
            provider,
            runtimePaths,
            visualizer,
          })
          : await syncManagedMiningReadiness({
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

        const updateAvailable = ttyProgressActive
          ? await resolveMineUpdateAvailable(packageVersion, context)
          : false;
        abortController = new AbortController();
        onStop = (): void => {
          abortController?.abort(createMiningStopRequestedError());
        };

        context.signalSource.on("SIGINT", onStop);
        context.signalSource.on("SIGTERM", onStop);

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
          visualizer: visualizer ?? undefined,
        });
      } finally {
        if (onStop !== null) {
          context.signalSource.off("SIGINT", onStop);
          context.signalSource.off("SIGTERM", onStop);
        }
        visualizer?.close();
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
