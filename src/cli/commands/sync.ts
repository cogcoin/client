import { dirname } from "node:path";

import { formatManagedSyncErrorMessage } from "../../bitcoind/errors.js";
import { formatBytes, formatDuration } from "../../bitcoind/progress/formatting.js";
import type { ManagedBitcoindProgressEvent } from "../../bitcoind/types.js";
import { FileLockBusyError, acquireFileLock } from "../../wallet/fs/lock.js";
import { resolveWalletRootIdFromLocalArtifacts } from "../../wallet/root-resolution.js";
import { usesTtyProgress, writeLine } from "../io.js";
import { classifyCliError, formatCliTextError } from "../output.js";
import { createStopSignalWatcher, waitForCompletionOrStop } from "../signals.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";

const SYNC_PROGRESS_LOG_INTERVAL_MS = 5_000;

function createSyncProgressReporter(options: {
  progressOutput: ParsedCliArgs["progressOutput"];
  write: (line: string) => void;
}): (event: ManagedBitcoindProgressEvent) => void {
  let lastPhase: ManagedBitcoindProgressEvent["phase"] | null = null;
  let lastMessage = "";
  let lastDownloadPrintedAt = 0;
  let lastDownloadBytes: number | null = null;
  let lastImportPrintedAt = 0;
  let lastImportBlocks: number | null = null;
  const infoEnabled = options.progressOutput !== "none";

  function shouldPrintEntryMessage(message: string, phase: ManagedBitcoindProgressEvent["phase"]): boolean {
    if (message === "Waiting to start managed sync." || message === "Sync complete.") {
      return false;
    }

    if (message.startsWith("Warning:")) {
      return true;
    }

    if (!infoEnabled) {
      return false;
    }

    if (phase === "getblock_archive_download" || phase === "getblock_archive_import") {
      return true;
    }

    return phase === "snapshot_download"
      || phase === "wait_headers_for_snapshot"
      || phase === "load_snapshot"
      || phase === "bitcoin_sync"
      || phase === "cogcoin_sync"
      || message.includes("Getblock manifest")
      || message.startsWith("Fetching Getblock manifest.")
      || message.startsWith("Refreshing Getblock manifest.")
      || message.startsWith("Using Getblock range ");
  }

  function formatDownloadLine(
    label: string,
    event: ManagedBitcoindProgressEvent,
  ): string {
    const current = event.progress.downloadedBytes ?? 0;
    const total = event.progress.totalBytes ?? 0;
    const percent = event.progress.percent ?? (total > 0 ? (current / total) * 100 : 0);
    const speed = event.progress.bytesPerSecond === null ? "--" : `${formatBytes(event.progress.bytesPerSecond)}/s`;
    return `${label}: ${percent.toFixed(2)}% (${formatBytes(current)} / ${formatBytes(total)}, ${speed}, ETA ${formatDuration(event.progress.etaSeconds)})`;
  }

  return (event) => {
    const message = event.progress.message.trim();
    const phaseChanged = event.phase !== lastPhase;
    const messageChanged = message !== lastMessage;

    if ((phaseChanged || messageChanged) && shouldPrintEntryMessage(message, event.phase)) {
      options.write(message);
    }

    if (infoEnabled && event.phase === "getblock_archive_download") {
      const now = Date.now();
      const currentBytes = event.progress.downloadedBytes ?? 0;
      const isComplete = (event.progress.percent ?? 0) >= 100;
      const shouldPrintMilestone = phaseChanged
        || lastDownloadBytes !== currentBytes && (
          isComplete
          || now - lastDownloadPrintedAt >= SYNC_PROGRESS_LOG_INTERVAL_MS
        );

      if (shouldPrintMilestone) {
        options.write(formatDownloadLine("Getblock download", event));
        lastDownloadPrintedAt = now;
        lastDownloadBytes = currentBytes;
      }
    } else if (infoEnabled && event.phase === "snapshot_download") {
      const now = Date.now();
      const currentBytes = event.progress.downloadedBytes ?? 0;
      const isComplete = (event.progress.percent ?? 0) >= 100;
      const shouldPrintMilestone = phaseChanged
        || lastDownloadBytes !== currentBytes && (
          isComplete
          || now - lastDownloadPrintedAt >= SYNC_PROGRESS_LOG_INTERVAL_MS
        );

      if (shouldPrintMilestone) {
        options.write(formatDownloadLine("Snapshot download", event));
        lastDownloadPrintedAt = now;
        lastDownloadBytes = currentBytes;
      }
    } else if (infoEnabled && event.phase === "getblock_archive_import") {
      const now = Date.now();
      const currentBlocks = event.progress.blocks ?? 0;
      const targetBlocks = event.progress.targetHeight ?? currentBlocks;
      const isComplete = currentBlocks >= targetBlocks;
      const shouldPrintMilestone = phaseChanged
        || lastImportBlocks !== currentBlocks && (
          isComplete
          || now - lastImportPrintedAt >= SYNC_PROGRESS_LOG_INTERVAL_MS
        );

      if (shouldPrintMilestone) {
        options.write(
          `Getblock import: Bitcoin ${currentBlocks.toLocaleString()} / ${targetBlocks.toLocaleString()}`,
        );
        lastImportPrintedAt = now;
        lastImportBlocks = currentBlocks;
      }
    }

    lastPhase = event.phase;
    lastMessage = message;
  };
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

    const client = await context.openManagedBitcoindClient({
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
