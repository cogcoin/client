import type { BootstrapProgress, ProgressOutputMode } from "../../bitcoind/types.js";
import { createBootstrapProgress } from "../../bitcoind/progress/formatting.js";
import {
  createFollowSceneState,
  syncFollowSceneState,
} from "../../bitcoind/progress/follow-scene.js";
import {
  DEFAULT_RENDER_CLOCK,
  resolveTtyRenderPolicy,
  TtyRenderThrottle,
  type RenderClock,
  type TtyRenderStream,
} from "../../bitcoind/progress/render-policy.js";
import { TtyProgressRenderer } from "../../bitcoind/progress/tty-renderer.js";
import type { MiningRuntimeStatusV1 } from "./types.js";

interface VisualizerRendererLike {
  renderFollowScene(
    progress: BootstrapProgress,
    cogcoinSyncHeight: number | null,
    cogcoinSyncTargetHeight: number | null,
    followScene: ReturnType<typeof createFollowSceneState>,
    statusFieldText?: string,
  ): void;
  close(): void;
}

const VISUALIZER_PROGRESS_SNAPSHOT = {
  url: "",
  filename: "mining-follow-visualizer",
  height: 0,
  sha256: "",
  sizeBytes: 1,
} as const;

export function describeMiningVisualizerStatus(
  snapshot: MiningRuntimeStatusV1,
): string {
  switch (snapshot.currentPhase) {
    case "resuming":
      return "Resuming after suspend";
    case "waiting-provider":
      return "Waiting for provider";
    case "waiting-indexer":
      return snapshot.indexerDaemonState === "reorging"
        ? "Indexer replaying reorg"
        : "Waiting for indexer";
    case "waiting-bitcoin-network":
      return "Waiting for Bitcoin node";
    case "generating":
      return "Generating candidates";
    case "scoring":
      return "Scoring candidates";
    case "publishing":
      return snapshot.currentPublishDecision === "fee-bump"
        ? "Fee-bumping mining tx"
        : snapshot.currentPublishDecision === "replacing"
          || snapshot.currentPublishDecision === "replaced"
          ? "Replacing mining tx"
          : "Broadcasting mining tx";
    case "replacing":
      return "Replacing mining tx";
    default:
      break;
  }

  if (snapshot.miningState === "repair-required") {
    return "Mining repair required";
  }

  if (snapshot.pauseReason === "zero-reward") {
    return "Zero-reward height";
  }

  if (snapshot.currentPublishDecision === "suppressed-same-domain-mempool") {
    return "Same-domain tx already live";
  }

  if (snapshot.currentPublishDecision === "suppressed-top5-mempool") {
    return "Stronger mempool roots live";
  }

  if (snapshot.currentPublishDecision === "indeterminate-mempool-gate") {
    return "Mempool gate indeterminate";
  }

  if (snapshot.livePublishInMempool) {
    return "Waiting for next block";
  }

  return "Waiting for next block";
}

export function describeMiningVisualizerProgress(
  snapshot: MiningRuntimeStatusV1,
): string {
  if (snapshot.note !== null && snapshot.note !== undefined && snapshot.note.length > 0) {
    return snapshot.note;
  }

  switch (snapshot.currentPhase) {
    case "resuming":
      return "Mining discarded stale in-flight work after a large local runtime gap and is rechecking health.";
    case "waiting-provider":
      return "Mining is waiting for the sentence provider to recover.";
    case "waiting-indexer":
      return "Mining is waiting for Bitcoin Core and the indexer to align.";
    case "waiting-bitcoin-network":
      return "Mining is waiting for the local Bitcoin node to become publishable.";
    case "generating":
      return "Generating mining sentences for eligible root domains.";
    case "scoring":
      return "Scoring mining candidates for the current tip.";
    case "publishing":
      return snapshot.currentPublishDecision === "fee-bump"
        ? "Publishing a fee bump for the live mining transaction."
        : snapshot.currentPublishDecision === "replacing"
          || snapshot.currentPublishDecision === "replaced"
          ? "Replacing the live mining transaction for the current tip."
          : "Broadcasting the best mining candidate for the current tip.";
    case "replacing":
      return "Replacing the live mining transaction for the current tip.";
    default:
      return "Waiting for the next block while mining stays ready on the current tip.";
  }
}

export class MiningFollowVisualizer {
  readonly #renderer: VisualizerRendererLike | null;
  readonly #clock: RenderClock;
  readonly #renderThrottle: TtyRenderThrottle;
  readonly #progress = createBootstrapProgress("follow_tip", VISUALIZER_PROGRESS_SNAPSHOT);
  readonly #scene = createFollowSceneState();
  #latestSnapshot: MiningRuntimeStatusV1 | null = null;

  constructor(options: {
    progressOutput?: ProgressOutputMode;
    stream?: TtyRenderStream;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    clock?: RenderClock;
    rendererFactory?: (stream: TtyRenderStream) => VisualizerRendererLike;
  } = {}) {
    const stream = options.stream ?? process.stderr;
    const progressOutput = options.progressOutput ?? "auto";
    const renderPolicy = resolveTtyRenderPolicy(
      progressOutput,
      stream,
      {
        platform: options.platform,
        env: options.env,
      },
    );
    this.#clock = options.clock ?? DEFAULT_RENDER_CLOCK;

    this.#renderer = renderPolicy.enabled
      ? options.rendererFactory?.(stream) ?? new TtyProgressRenderer(stream)
      : null;
    this.#renderThrottle = new TtyRenderThrottle({
      clock: this.#clock,
      intervalMs: renderPolicy.repaintIntervalMs,
      onRender: () => {
        this.#renderLatestSnapshot();
      },
      throttled: renderPolicy.linuxHeadlessThrottle,
    });
  }

  update(snapshot: MiningRuntimeStatusV1): void {
    if (this.#renderer === null) {
      return;
    }

    this.#latestSnapshot = snapshot;
    this.#renderThrottle.request();
  }

  close(): void {
    this.#renderThrottle.flush();
    this.#renderer?.close();
  }

  #renderLatestSnapshot(): void {
    if (this.#renderer === null || this.#latestSnapshot === null) {
      return;
    }

    const snapshot = this.#latestSnapshot;
    const indexedHeight = snapshot.indexerTipHeight ?? snapshot.coreBestHeight ?? null;
    const nodeHeight = snapshot.coreBestHeight ?? indexedHeight;

    this.#progress.phase = "follow_tip";
    this.#progress.message = describeMiningVisualizerProgress(snapshot);
    this.#progress.updatedAt = this.#clock.now();
    this.#progress.blocks = nodeHeight;
    this.#progress.targetHeight = nodeHeight;
    this.#progress.etaSeconds = null;
    this.#progress.lastError = snapshot.lastError;

    syncFollowSceneState(this.#scene, {
      indexedHeight,
      nodeHeight,
      liveActivated: true,
    });

    this.#renderer.renderFollowScene(
      this.#progress,
      indexedHeight,
      nodeHeight,
      this.#scene,
      describeMiningVisualizerStatus(snapshot),
    );
  }
}
