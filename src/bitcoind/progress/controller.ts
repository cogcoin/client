import type { QuoteDisplayPhase, WritingQuoteRotator } from "../quotes.js";
import { WritingQuoteRotator as QuoteRotator } from "../quotes.js";
import type {
  BootstrapPhase,
  BootstrapProgress,
  ManagedBitcoindProgressEvent,
  ProgressOutputMode,
  SnapshotMetadata,
  WritingQuote,
} from "../types.js";
import { INTRO_TOTAL_MS, PROGRESS_TICK_MS } from "./constants.js";
import {
  advanceFollowSceneState,
  createFollowSceneState,
  replaceFollowBlockTimes,
  setFollowBlockTime,
  syncFollowSceneState,
  type FollowSceneStateForTesting,
} from "./follow-scene.js";
import {
  createBootstrapProgress,
  createDefaultMessage,
  resolveStatusFieldText,
} from "./formatting.js";
import { TtyProgressRenderer } from "./tty-renderer.js";

interface ProgressControllerOptions {
  onProgress?: (event: ManagedBitcoindProgressEvent) => void;
  progressOutput?: ProgressOutputMode;
  quoteStatePath: string;
  snapshot: SnapshotMetadata;
}

export class ManagedProgressController {
  readonly #options: ProgressControllerOptions;
  readonly #snapshot: SnapshotMetadata;
  readonly #outputMode: ProgressOutputMode;
  #quoteRotator: WritingQuoteRotator | null = null;
  #renderer: TtyProgressRenderer | null = null;
  #ticker: ReturnType<typeof setInterval> | null = null;
  #currentQuote: WritingQuote | null = null;
  #currentDisplayPhase: QuoteDisplayPhase = "banner";
  #currentDisplayStartedAt = 0;
  #cogcoinSyncHeight: number | null = null;
  #cogcoinSyncTargetHeight: number | null = null;
  #progress: BootstrapProgress;
  #started = false;
  #followVisualMode = false;
  #followScene: FollowSceneStateForTesting = createFollowSceneState();

  constructor(options: ProgressControllerOptions) {
    this.#options = options;
    this.#snapshot = options.snapshot;
    this.#outputMode = options.progressOutput ?? "auto";
    this.#progress = createBootstrapProgress("paused", options.snapshot);
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }

    this.#started = true;
    this.#quoteRotator = await QuoteRotator.create(this.#options.quoteStatePath);

    if (this.#shouldRenderToTty()) {
      this.#renderer = new TtyProgressRenderer();
    }

    await this.#refresh();
    this.#ticker = setInterval(() => {
      void this.#refresh();
    }, PROGRESS_TICK_MS);
  }

  async close(): Promise<void> {
    if (this.#ticker !== null) {
      clearInterval(this.#ticker);
      this.#ticker = null;
    }

    this.#renderer?.close();
    this.#renderer = null;
    this.#started = false;
  }

  async enableFollowVisualMode(
    indexedHeight: number | null = null,
    blockTimesByHeight: Record<number, number> = {},
  ): Promise<void> {
    this.#followVisualMode = true;
    this.#followScene = createFollowSceneState(indexedHeight, blockTimesByHeight);
    this.#currentQuote = null;

    if (this.#started) {
      await this.#refresh();
    }
  }

  setFollowBlockTime(height: number, blockTime: number): void {
    if (!this.#followVisualMode) {
      return;
    }

    setFollowBlockTime(this.#followScene, height, blockTime);
  }

  replaceFollowBlockTimes(blockTimesByHeight: Record<number, number>): void {
    if (!this.#followVisualMode) {
      return;
    }

    replaceFollowBlockTimes(this.#followScene, blockTimesByHeight);
  }

  async playCompletionScene(): Promise<void> {
    if (!this.#started || this.#renderer === null) {
      return;
    }

    if (this.#ticker !== null) {
      clearInterval(this.#ticker);
      this.#ticker = null;
    }

    const startedAt = Date.now();

    while (true) {
      const elapsedMs = Math.min(INTRO_TOTAL_MS, Date.now() - startedAt);
      this.#renderer.renderTrainScene(
        "completion",
        this.#progress,
        this.#cogcoinSyncHeight,
        this.#cogcoinSyncTargetHeight,
        elapsedMs,
      );

      if (elapsedMs >= INTRO_TOTAL_MS) {
        break;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, PROGRESS_TICK_MS);
      });
    }
  }

  async setPhase(
    phase: BootstrapPhase,
    patch: Partial<Omit<BootstrapProgress, "phase" | "updatedAt">> = {},
  ): Promise<void> {
    this.#progress = {
      ...this.#progress,
      ...patch,
      phase,
      message: patch.message ?? createDefaultMessage(phase),
      updatedAt: Date.now(),
    };

    if (phase !== "cogcoin_sync" && phase !== "follow_tip") {
      this.#cogcoinSyncHeight = null;
      this.#cogcoinSyncTargetHeight = null;
    }

    if (this.#followVisualMode) {
      syncFollowSceneState(this.#followScene, {
        indexedHeight: phase === "follow_tip" ? this.#cogcoinSyncHeight : undefined,
        nodeHeight: this.#progress.blocks,
        liveActivated: phase === "follow_tip" || this.#followScene.liveActivated,
      });
    }

    await this.#refresh();
  }

  async setCogcoinSync(
    height: number | null,
    targetHeight: number | null,
    etaSeconds: number | null = null,
  ): Promise<void> {
    this.#cogcoinSyncHeight = height;
    this.#cogcoinSyncTargetHeight = targetHeight;
    this.#progress = {
      ...this.#progress,
      phase: "cogcoin_sync",
      message: createDefaultMessage("cogcoin_sync"),
      etaSeconds,
      lastError: null,
      updatedAt: Date.now(),
    };

    if (this.#followVisualMode) {
      syncFollowSceneState(this.#followScene, {
        indexedHeight: height,
        nodeHeight: targetHeight,
        liveActivated: this.#followScene.liveActivated,
      });
    }

    await this.#refresh();
  }

  getStatusSnapshot(): {
    bootstrapPhase: BootstrapPhase;
    bootstrapProgress: BootstrapProgress;
    cogcoinSyncHeight: number | null;
    cogcoinSyncTargetHeight: number | null;
    currentQuote: WritingQuote | null;
    snapshot: SnapshotMetadata;
  } {
    return {
      bootstrapPhase: this.#progress.phase,
      bootstrapProgress: { ...this.#progress },
      cogcoinSyncHeight: this.#cogcoinSyncHeight,
      cogcoinSyncTargetHeight: this.#cogcoinSyncTargetHeight,
      currentQuote: this.#currentQuote,
      snapshot: this.#snapshot,
    };
  }

  async #refresh(): Promise<void> {
    if (!this.#started || this.#quoteRotator === null) {
      return;
    }

    const now = Date.now();

    if (this.#followVisualMode) {
      advanceFollowSceneState(this.#followScene, now);
      this.#currentQuote = null;
    } else {
      const snapshot = await this.#quoteRotator.current(now);
      this.#currentDisplayPhase = snapshot.displayPhase;
      this.#currentDisplayStartedAt = snapshot.displayStartedAt;
      this.#currentQuote = snapshot.displayPhase === "scroll"
        ? snapshot.currentQuote
        : null;
    }

    const event: ManagedBitcoindProgressEvent = {
      phase: this.#progress.phase,
      progress: { ...this.#progress },
      snapshot: this.#snapshot,
      currentQuote: this.#currentQuote,
      cogcoinSyncHeight: this.#cogcoinSyncHeight,
      cogcoinSyncTargetHeight: this.#cogcoinSyncTargetHeight,
    };

    try {
      this.#options.onProgress?.(event);
    } catch {
      // User progress callbacks should never break managed sync.
    }

    const statusFieldText = resolveStatusFieldText(this.#progress, this.#snapshot.height, now);

    if (this.#followVisualMode) {
      this.#renderer?.renderFollowScene(
        this.#progress,
        this.#cogcoinSyncHeight,
        this.#cogcoinSyncTargetHeight,
        this.#followScene,
        statusFieldText,
      );
      return;
    }

    this.#renderer?.render(
      this.#currentDisplayPhase,
      this.#currentQuote,
      this.#progress,
      this.#cogcoinSyncHeight,
      this.#cogcoinSyncTargetHeight,
      Math.max(0, now - this.#currentDisplayStartedAt),
      statusFieldText,
    );
  }

  #shouldRenderToTty(): boolean {
    if (this.#outputMode === "none") {
      return false;
    }

    if (this.#outputMode === "tty") {
      return true;
    }

    return process.stderr.isTTY === true;
  }
}
