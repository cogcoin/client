import { DEFAULT_SNAPSHOT_METADATA } from "../bitcoind/bootstrap.js";
import { ManagedProgressController } from "../bitcoind/progress.js";
import {
  createBootstrapProgress,
  createDefaultMessage,
} from "../bitcoind/progress/formatting.js";
import type {
  BootstrapPhase,
  BootstrapProgress,
  ManagedBitcoindProgressEvent,
  ManagedIndexerDaemonObservedStatus,
} from "../bitcoind/types.js";
import type { ProgressOutput, WritableLike } from "./types.js";

const INDEXER_MONITOR_POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isTransientIndexerFailureMessage(message: string | null): boolean {
  if (message === null) {
    return false;
  }

  return message === "managed_bitcoind_runtime_config_unavailable"
    || message.includes("cookie file is unavailable")
    || message.includes("ECONNREFUSED")
    || message.includes("ECONNRESET")
    || message.includes("socket hang up");
}

function deriveFallbackPhase(status: ManagedIndexerDaemonObservedStatus): BootstrapPhase {
  switch (status.state) {
    case "synced":
      return "follow_tip";
    case "catching-up":
    case "reorging":
      return "cogcoin_sync";
    case "failed":
      return "error";
    case "starting":
      return "paused";
    case "stopping":
      return "paused";
    case "schema-mismatch":
    case "service-version-mismatch":
      return "error";
    default:
      return "paused";
  }
}

function normalizeBootstrapProgress(status: ManagedIndexerDaemonObservedStatus): {
  phase: BootstrapPhase;
  progress: BootstrapProgress;
  cogcoinSyncHeight: number | null;
  cogcoinSyncTargetHeight: number | null;
} {
  const phase = status.bootstrapPhase ?? deriveFallbackPhase(status);
  const sourceProgress = status.bootstrapProgress ?? createBootstrapProgress(phase, DEFAULT_SNAPSHOT_METADATA);
  const progress: BootstrapProgress = {
    ...sourceProgress,
    phase,
    message: sourceProgress.message || createDefaultMessage(phase),
    blocks: sourceProgress.blocks,
    headers: sourceProgress.headers ?? status.coreBestHeight,
    targetHeight: sourceProgress.targetHeight ?? status.coreBestHeight,
    lastError: status.lastError ?? sourceProgress.lastError,
    updatedAt: sourceProgress.updatedAt ?? status.updatedAtUnixMs,
  };
  const cogcoinSyncHeight = status.cogcoinSyncHeight ?? status.appliedTipHeight ?? null;
  const cogcoinSyncTargetHeight = status.cogcoinSyncTargetHeight ?? status.coreBestHeight ?? null;

  if (phase === "cogcoin_sync") {
    progress.blocks = progress.blocks ?? cogcoinSyncHeight;
    progress.headers = progress.headers ?? cogcoinSyncTargetHeight;
    progress.targetHeight = progress.targetHeight ?? cogcoinSyncTargetHeight;
  } else if (phase === "follow_tip") {
    progress.blocks = status.coreBestHeight ?? progress.blocks;
    progress.headers = status.coreBestHeight ?? progress.headers;
    progress.targetHeight = status.coreBestHeight ?? progress.targetHeight;
  } else if (phase === "error" && progress.message === createDefaultMessage("error") && status.lastError !== null) {
    progress.message = status.lastError;
  }

  return {
    phase,
    progress,
    cogcoinSyncHeight,
    cogcoinSyncTargetHeight,
  };
}

export function isManagedIndexerCaughtUp(status: ManagedIndexerDaemonObservedStatus): boolean {
  return status.state === "synced"
    && status.coreBestHeight !== null
    && status.appliedTipHeight === status.coreBestHeight
    && (
      status.coreBestHash === null
      || status.appliedTipHash === null
      || status.coreBestHash === status.appliedTipHash
    );
}

export function assertManagedIndexerStatusRecoverable(status: ManagedIndexerDaemonObservedStatus): void {
  if (status.state === "schema-mismatch" || status.state === "service-version-mismatch") {
    throw new Error(status.lastError ?? `indexer_daemon_${status.state}`);
  }

  if (status.state === "failed" && !isTransientIndexerFailureMessage(status.lastError)) {
    throw new Error(status.lastError ?? "indexer_daemon_failed");
  }
}

export class ManagedIndexerProgressObserver {
  readonly #progress: ManagedProgressController;
  readonly #followVisualMode: boolean;
  #started = false;
  #followVisualModeEnabled = false;

  constructor(options: {
    quoteStatePath: string;
    stream: WritableLike;
    progressOutput: ProgressOutput;
    followVisualMode?: boolean;
    onProgress?: (event: ManagedBitcoindProgressEvent) => void;
  }) {
    this.#followVisualMode = options.followVisualMode ?? false;
    this.#progress = new ManagedProgressController({
      onProgress: options.onProgress,
      progressOutput: options.progressOutput,
      snapshot: DEFAULT_SNAPSHOT_METADATA,
      quoteStatePath: options.quoteStatePath,
      stream: options.stream,
    });
  }

  async applyStatus(status: ManagedIndexerDaemonObservedStatus): Promise<void> {
    if (!this.#started) {
      await this.#progress.start();
      this.#started = true;
    }

    if (this.#followVisualMode && !this.#followVisualModeEnabled) {
      await this.#progress.enableFollowVisualMode(status.appliedTipHeight ?? null);
      this.#followVisualModeEnabled = true;
    }

    const normalized = normalizeBootstrapProgress(status);

    if (
      normalized.phase === "cogcoin_sync"
      || (normalized.phase === "follow_tip" && this.#followVisualMode)
    ) {
      await this.#progress.setCogcoinSync(
        normalized.cogcoinSyncHeight,
        normalized.cogcoinSyncTargetHeight,
        normalized.progress.etaSeconds,
      );
    }

    const { phase: _phase, updatedAt: _updatedAt, ...patch } = normalized.progress;
    await this.#progress.setPhase(normalized.phase, patch);
  }

  async playCompletionScene(): Promise<void> {
    if (!this.#started) {
      return;
    }

    await this.#progress.playCompletionScene();
  }

  async close(): Promise<void> {
    if (!this.#started) {
      return;
    }

    await this.#progress.close();
    this.#started = false;
  }
}

export async function pollManagedIndexerUntilCaughtUp(options: {
  monitor: {
    getStatus(): Promise<ManagedIndexerDaemonObservedStatus>;
  };
  observer: ManagedIndexerProgressObserver;
  signal?: AbortSignal;
  pollIntervalMs?: number;
}): Promise<ManagedIndexerDaemonObservedStatus> {
  while (true) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("managed_indexer_observer_aborted");
    }

    const status = await options.monitor.getStatus();
    await options.observer.applyStatus(status);
    assertManagedIndexerStatusRecoverable(status);

    if (isManagedIndexerCaughtUp(status)) {
      return status;
    }

    await sleep(options.pollIntervalMs ?? INDEXER_MONITOR_POLL_INTERVAL_MS);
  }
}

export async function followManagedIndexerStatus(options: {
  monitor: {
    getStatus(): Promise<ManagedIndexerDaemonObservedStatus>;
  };
  observer: ManagedIndexerProgressObserver;
  signal?: AbortSignal;
  pollIntervalMs?: number;
}): Promise<void> {
  while (true) {
    if (options.signal?.aborted) {
      return;
    }

    const status = await options.monitor.getStatus();
    await options.observer.applyStatus(status);
    assertManagedIndexerStatusRecoverable(status);
    await sleep(options.pollIntervalMs ?? INDEXER_MONITOR_POLL_INTERVAL_MS);
  }
}
