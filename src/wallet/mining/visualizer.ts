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
import { TtyProgressRenderer, type FollowSceneRenderOptions } from "../../bitcoind/progress/tty-renderer.js";
import type { MiningRuntimeStatusV1 } from "./types.js";

interface VisualizerRendererLike {
  renderFollowScene(
    progress: BootstrapProgress,
    cogcoinSyncHeight: number | null,
    cogcoinSyncTargetHeight: number | null,
    followScene: ReturnType<typeof createFollowSceneState>,
    statusFieldText?: string,
    renderOptions?: FollowSceneRenderOptions,
  ): void;
  close(): void;
}

const MINING_ARTWORK_BALANCE_WIDTH = 23;
const MINING_SENTENCE_BOARD_SIZE = 5;

export interface MiningSentenceBoardEntry {
  rank: number;
  domainName: string;
  sentence: string;
}

export interface MiningSelfSentenceEntry {
  rank: number | "-" | null;
  domainName: string | null;
  sentence: string | null;
}

export interface MiningRecentWinSummary {
  rank: number;
  rewardCogtoshi: bigint;
  blockHeight: number;
}

export interface MiningFollowVisualizerState {
  balanceCogtoshi: bigint | null;
  balanceSats: bigint | null;
  blockHeight: number | null;
  visibleBoardEntries: MiningSentenceBoardEntry[];
  selfEntry: MiningSelfSentenceEntry;
  latestSentence: string | null;
  latestTxid: string | null;
  recentWin: MiningRecentWinSummary | null;
}

function formatCogAmountWithDecimals(
  value: bigint,
  {
    maxFractionDigits,
    minFractionDigits,
  }: {
    maxFractionDigits: number;
    minFractionDigits: number;
  },
): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 100_000_000n;
  const fraction = absolute % 100_000_000n;
  const paddedFraction = fraction.toString().padStart(8, "0");
  const clampedMax = Math.max(0, Math.min(8, maxFractionDigits));
  const clampedMin = Math.max(0, Math.min(clampedMax, minFractionDigits));
  let fractionText = paddedFraction.slice(0, clampedMax);

  while (fractionText.length > clampedMin && fractionText.endsWith("0")) {
    fractionText = fractionText.slice(0, -1);
  }

  if (fractionText.length === 0 && clampedMin > 0) {
    fractionText = "".padEnd(clampedMin, "0");
  }

  return fractionText.length > 0
    ? `${sign}${whole.toString()}.${fractionText}`
    : `${sign}${whole.toString()}`;
}

function formatCompactBalanceText(balanceCogtoshi: bigint | null, balanceSats: bigint | null): string | null {
  if (balanceCogtoshi === null && balanceSats === null) {
    return null;
  }

  const satSegment = balanceSats === null ? null : `SAT${balanceSats.toString()}`;

  if (balanceCogtoshi === null) {
    return satSegment;
  }

  for (let digits = 4; digits >= 1; digits -= 1) {
    const cogSegment = `COG${formatCogAmountWithDecimals(balanceCogtoshi, {
      maxFractionDigits: digits,
      minFractionDigits: 1,
    })}`;
    const combined = satSegment === null ? cogSegment : `${cogSegment}|${satSegment}`;

    if (combined.length <= MINING_ARTWORK_BALANCE_WIDTH) {
      return combined;
    }
  }

  if (satSegment === null) {
    const clippedCogOnly = `COG${formatCogAmountWithDecimals(balanceCogtoshi, {
      maxFractionDigits: 1,
      minFractionDigits: 1,
    })}`;
    return clippedCogOnly.slice(Math.max(0, clippedCogOnly.length - MINING_ARTWORK_BALANCE_WIDTH));
  }

  const compactCog = `COG${formatCogAmountWithDecimals(balanceCogtoshi, {
    maxFractionDigits: 1,
    minFractionDigits: 1,
  })}`;
  const reserved = Math.min(MINING_ARTWORK_BALANCE_WIDTH, satSegment.length + 1);
  const availableCogWidth = Math.max(0, MINING_ARTWORK_BALANCE_WIDTH - reserved);
  const clippedCog = compactCog.slice(Math.max(0, compactCog.length - availableCogWidth));
  return `${clippedCog}${clippedCog.length > 0 ? "|" : ""}${satSegment}`.slice(-MINING_ARTWORK_BALANCE_WIDTH);
}

function formatRewardCogAmount(value: bigint): string {
  return `${formatCogAmountWithDecimals(value, {
    maxFractionDigits: 8,
    minFractionDigits: 1,
  })} COG`;
}

function formatSentenceRow(rank: number, domainName: string, sentence: string): string {
  return `${rank}. @${domainName}: ${sentence}`;
}

function formatSelfSentenceRow(entry: MiningSelfSentenceEntry): string {
  if (entry.domainName === null || entry.sentence === null) {
    return "";
  }

  const rankLabel = entry.rank === null ? "" : `${entry.rank}.`;
  return `${rankLabel} @${entry.domainName}: ${entry.sentence}`.trimStart();
}

export function createEmptyMiningFollowVisualizerState(): MiningFollowVisualizerState {
  return {
    balanceCogtoshi: null,
    balanceSats: null,
    blockHeight: null,
    visibleBoardEntries: [],
    selfEntry: {
      rank: null,
      domainName: null,
      sentence: null,
    },
    latestSentence: null,
    latestTxid: null,
    recentWin: null,
  };
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
  ui: MiningFollowVisualizerState = createEmptyMiningFollowVisualizerState(),
): string {
  if (ui.recentWin !== null) {
    return `You got #${ui.recentWin.rank} and mined ${formatRewardCogAmount(ui.recentWin.rewardCogtoshi)} in block #${ui.recentWin.blockHeight}`;
  }

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
  #latestUiState: MiningFollowVisualizerState = createEmptyMiningFollowVisualizerState();

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

  update(snapshot: MiningRuntimeStatusV1, uiState?: MiningFollowVisualizerState): void {
    if (this.#renderer === null) {
      return;
    }

    this.#latestSnapshot = snapshot;
    if (uiState !== undefined) {
      this.#latestUiState = uiState;
    }
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
    const uiState = this.#latestUiState;
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
      describeMiningVisualizerStatus(snapshot, uiState),
      {
        artworkBalanceText: formatCompactBalanceText(uiState.balanceCogtoshi, uiState.balanceSats),
        extraLines: [
          `✎ Block #${uiState.blockHeight ?? "-----"} Sentences ✎`,
          "",
          ...Array.from({ length: MINING_SENTENCE_BOARD_SIZE }, (_value, index) => {
            const entry = uiState.visibleBoardEntries[index];
            return entry === undefined
              ? `${index + 1}.`
              : formatSentenceRow(entry.rank, entry.domainName, entry.sentence);
          }),
          "----------",
          formatSelfSentenceRow(uiState.selfEntry),
          "",
          `Latest sentence: ${uiState.latestSentence ?? ""}`,
          `View at ${uiState.latestTxid === null ? "" : `https://mempool.space/${uiState.latestTxid}/`}`,
        ],
      },
    );
  }
}
