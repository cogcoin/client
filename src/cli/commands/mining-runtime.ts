import { dirname } from "node:path";

import { DEFAULT_SNAPSHOT_METADATA, resolveBootstrapPathsForTesting } from "../../bitcoind/bootstrap.js";
import type { ManagedIndexerDaemonObservedStatus } from "../../bitcoind/types.js";
import type { MiningRuntimeStatusV1 } from "../../wallet/mining/types.js";
import {
  createEmptyMiningFollowVisualizerState,
  MiningFollowVisualizer,
} from "../../wallet/mining/visualizer.js";
import { resolveWalletRootIdFromLocalArtifacts } from "../../wallet/root-resolution.js";
import { withInteractiveWalletSecretProvider } from "../../wallet/state/provider.js";
import {
  ManagedIndexerProgressObserver,
  assertManagedIndexerStatusRecoverable,
  isManagedIndexerCaughtUp,
  pollManagedIndexerUntilCaughtUp,
} from "../managed-indexer-observer.js";
import { usesTtyProgress, writeLine } from "../io.js";
import { writeHandledCliError } from "../output.js";
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
    throw new Error("Built-in mining provider is not configured. Run `cogcoin mine setup`.");
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

function mapManagedIndexerStateToMiningState(
  state: ManagedIndexerDaemonObservedStatus["state"] | null | undefined,
): MiningRuntimeStatusV1["indexerDaemonState"] {
  switch (state) {
    case "starting":
    case "catching-up":
    case "reorging":
    case "synced":
    case "failed":
    case "schema-mismatch":
    case "service-version-mismatch":
      return state;
    case "stopping":
      return "starting";
    default:
      return "unavailable";
  }
}

function mapManagedIndexerHealth(
  state: ManagedIndexerDaemonObservedStatus["state"] | null | undefined,
): MiningRuntimeStatusV1["indexerHealth"] {
  switch (state) {
    case "synced":
      return "synced";
    case "catching-up":
      return "catching-up";
    case "reorging":
      return "reorging";
    case "starting":
    case "stopping":
      return "starting";
    case "failed":
      return "failed";
    case "schema-mismatch":
      return "schema-mismatch";
    case "service-version-mismatch":
      return "service-version-mismatch";
    default:
      return "unavailable";
  }
}

function createMiningReadinessSnapshot(options: {
  walletRootId: string | null;
  observedStatus: ManagedIndexerDaemonObservedStatus | null;
}): MiningRuntimeStatusV1 {
  const status = options.observedStatus;
  const bitcoindReachable = status?.rpcReachable === true;
  const indexerTipAligned = status === null
    ? null
    : status.coreBestHeight !== null
      && status.appliedTipHeight !== null
      && status.appliedTipHeight === status.coreBestHeight
      && (
        status.coreBestHash === null
        || status.appliedTipHash === null
        || status.appliedTipHash === status.coreBestHash
      );

  return {
    schemaVersion: 1,
    walletRootId: options.walletRootId,
    workerApiVersion: null,
    workerBinaryVersion: null,
    workerBuildId: null,
    updatedAtUnixMs: status?.updatedAtUnixMs ?? Date.now(),
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    backgroundWorkerHeartbeatAtUnixMs: null,
    backgroundWorkerHealth: null,
    indexerDaemonState: mapManagedIndexerStateToMiningState(status?.state),
    indexerDaemonInstanceId: status?.daemonInstanceId ?? null,
    indexerSnapshotSeq: status?.snapshotSeq ?? null,
    indexerSnapshotOpenedAtUnixMs: null,
    indexerTruthSource: "none",
    indexerHeartbeatAtUnixMs: status?.heartbeatAtUnixMs ?? null,
    coreBestHeight: status?.coreBestHeight ?? null,
    coreBestHash: status?.coreBestHash ?? null,
    indexerTipHeight: status?.appliedTipHeight ?? null,
    indexerTipHash: status?.appliedTipHash ?? null,
    indexerReorgDepth: status?.reorgDepth ?? null,
    indexerTipAligned,
    corePublishState: bitcoindReachable ? "healthy" : null,
    providerState: null,
    lastSuspendDetectedAtUnixMs: null,
    reconnectSettledUntilUnixMs: null,
    tipSettledUntilUnixMs: null,
    miningState: "idle",
    currentPhase: "waiting-indexer",
    currentPublishState: "none",
    targetBlockHeight: status?.coreBestHeight === null || status?.coreBestHeight === undefined
      ? null
      : status.coreBestHeight + 1,
    referencedBlockHashDisplay: null,
    currentDomainId: null,
    currentDomainName: null,
    currentSentenceDisplay: null,
    currentCanonicalBlend: null,
    currentTxid: null,
    currentWtxid: null,
    livePublishInMempool: null,
    currentFeeRateSatVb: null,
    currentAbsoluteFeeSats: null,
    currentBlockFeeSpentSats: "0",
    sessionFeeSpentSats: "0",
    lifetimeFeeSpentSats: "0",
    sameDomainCompetitorSuppressed: null,
    higherRankedCompetitorDomainCount: null,
    dedupedCompetitorDomainCount: null,
    competitivenessGateIndeterminate: null,
    mempoolSequenceCacheStatus: null,
    currentPublishDecision: null,
    lastMempoolSequence: null,
    lastCompetitivenessGateAtUnixMs: null,
    pauseReason: null,
    providerConfigured: true,
    providerKind: null,
    bitcoindHealth: bitcoindReachable ? "ready" : status === null ? "starting" : "unavailable",
    bitcoindServiceState: bitcoindReachable ? "ready" : status === null ? "starting" : null,
    bitcoindReplicaStatus: "not-proven",
    nodeHealth: bitcoindReachable ? "synced" : status === null ? "starting" : "unavailable",
    indexerHealth: mapManagedIndexerHealth(status?.state),
    tipsAligned: indexerTipAligned,
    lastEventAtUnixMs: null,
    lastError: status?.lastError ?? null,
    note: null,
  };
}

async function pollManagedMiningReadinessWithVisualizer(options: {
  monitor: Awaited<ReturnType<RequiredCliRunnerContext["openManagedIndexerMonitor"]>>;
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
    options.visualizer.update(
      createMiningReadinessSnapshot({
        walletRootId: options.walletRootId,
        observedStatus: status,
      }),
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

  options.visualizer.update(
    createMiningReadinessSnapshot({
      walletRootId: walletRoot.walletRootId,
      observedStatus: null,
    }),
    EMPTY_MINING_VISUALIZER_STATE,
  );

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
    const runtimePaths = context.resolveWalletRuntimePaths();

    if (parsed.command === "mine") {
      const prompter = context.createPrompter();
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
          abortController?.abort();
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

    if (parsed.command === "mine-start") {
      const prompter = createCommandPrompter(context);
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
      const provider = withInteractiveWalletSecretProvider(
        context.walletSecretProvider,
        context.createPrompter(),
      );
      const snapshot = await context.stopBackgroundMining({
        dataDir,
        databasePath: dbPath,
        provider,
        paths: runtimePaths,
      });
      const nextSteps = getMineStopNextSteps();
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
