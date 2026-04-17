import type { QuoteDisplayPhase } from "../quotes.js";
import { WritingQuoteRotator as QuoteRotator } from "../quotes.js";
import type {
  BootstrapPhase,
  BootstrapProgress,
  ManagedBitcoindProgressEvent,
  ProgressOutputMode,
  SnapshotMetadata,
  WritingQuote,
} from "../types.js";
import { INTRO_TOTAL_MS } from "./constants.js";
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
import {
  DEFAULT_RENDER_CLOCK,
  resolveTtyRenderPolicy,
  TtyRenderThrottle,
  type RenderClock,
  type TtyRenderStream,
} from "./render-policy.js";
import { TtyProgressRenderer, type FollowSceneRenderOptions } from "./tty-renderer.js";

interface QuoteRotatorLike {
  current(now?: number): Promise<{
    displayPhase: QuoteDisplayPhase;
    currentQuote: WritingQuote | null;
    displayStartedAt: number;
  }>;
}

interface ProgressRendererLike {
  render(
    displayPhase: QuoteDisplayPhase,
    quote: WritingQuote | null,
    progress: BootstrapProgress,
    cogcoinSyncHeight: number | null,
    cogcoinSyncTargetHeight: number | null,
    introElapsedMs?: number,
    statusFieldText?: string,
  ): void;
  renderTrainScene(
    kind: "intro" | "completion",
    progress: BootstrapProgress,
    cogcoinSyncHeight: number | null,
    cogcoinSyncTargetHeight: number | null,
    elapsedMs: number,
    statusFieldText?: string,
  ): void;
  renderFollowScene(
    progress: BootstrapProgress,
    cogcoinSyncHeight: number | null,
    cogcoinSyncTargetHeight: number | null,
    followScene: FollowSceneStateForTesting,
    statusFieldText?: string,
    renderOptions?: FollowSceneRenderOptions,
  ): void;
  close(): void;
}

interface ProgressControllerOptions {
  onProgress?: (event: ManagedBitcoindProgressEvent) => void;
  progressOutput?: ProgressOutputMode;
  quoteStatePath: string;
  snapshot: SnapshotMetadata;
  quoteRotator?: QuoteRotatorLike;
  rendererFactory?: (stream: TtyRenderStream) => ProgressRendererLike;
  stream?: TtyRenderStream;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  clock?: RenderClock;
}

export class ManagedProgressController {
  readonly #options: ProgressControllerOptions;
  readonly #snapshot: SnapshotMetadata;
  readonly #outputMode: ProgressOutputMode;
  readonly #clock: RenderClock;
  readonly #renderStream: TtyRenderStream;
  readonly #renderThrottle: TtyRenderThrottle;
  readonly #renderIntervalMs: number;
  #quoteRotator: QuoteRotatorLike | null = null;
  #renderer: ProgressRendererLike | null = null;
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
    this.#clock = options.clock ?? DEFAULT_RENDER_CLOCK;
    this.#renderStream = options.stream ?? process.stderr;
    const renderPolicy = resolveTtyRenderPolicy(
      this.#outputMode,
      this.#renderStream,
      {
        platform: options.platform,
        env: options.env,
      },
    );
    this.#renderIntervalMs = renderPolicy.repaintIntervalMs;
    this.#renderThrottle = new TtyRenderThrottle({
      clock: this.#clock,
      intervalMs: this.#renderIntervalMs,
      onRender: () => {
        this.#renderToTty();
      },
      throttled: renderPolicy.linuxHeadlessThrottle,
    });
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }

    this.#started = true;
    this.#quoteRotator = this.#options.quoteRotator
      ?? await QuoteRotator.create(this.#options.quoteStatePath);

    if (resolveTtyRenderPolicy(
      this.#outputMode,
      this.#renderStream,
      {
        platform: this.#options.platform,
        env: this.#options.env,
      },
    ).enabled) {
      this.#renderer = this.#options.rendererFactory?.(this.#renderStream)
        ?? new TtyProgressRenderer(this.#renderStream);
    }

    await this.#refresh();
    this.#ticker = this.#clock.setInterval(() => {
      void this.#refresh();
    }, this.#renderIntervalMs);
  }

  async close(): Promise<void> {
    if (this.#ticker !== null) {
      this.#clock.clearInterval(this.#ticker);
      this.#ticker = null;
    }

    this.#renderThrottle.flush();
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

    this.#renderThrottle.flush();

    if (this.#ticker !== null) {
      this.#clock.clearInterval(this.#ticker);
      this.#ticker = null;
    }

    const startedAt = this.#clock.now();

    while (true) {
      const elapsedMs = Math.min(INTRO_TOTAL_MS, this.#clock.now() - startedAt);
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
        this.#clock.setTimeout(resolve, this.#renderIntervalMs);
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

    const now = this.#clock.now();

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

    this.#renderThrottle.request();
  }

  #renderToTty(): void {
    if (!this.#started || this.#renderer === null) {
      return;
    }

    const now = this.#clock.now();
    const statusFieldText = resolveStatusFieldText(this.#progress, this.#snapshot.height, now);

    if (this.#followVisualMode) {
      this.#renderer.renderFollowScene(
        this.#progress,
        this.#cogcoinSyncHeight,
        this.#cogcoinSyncTargetHeight,
        this.#followScene,
        statusFieldText,
      );
      return;
    }

    this.#renderer.render(
      this.#currentDisplayPhase,
      this.#currentQuote,
      this.#progress,
      this.#cogcoinSyncHeight,
      this.#cogcoinSyncTargetHeight,
      Math.max(0, now - this.#currentDisplayStartedAt),
      statusFieldText,
    );
  }
}
