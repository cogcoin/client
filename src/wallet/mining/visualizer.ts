import type { BootstrapProgress, ProgressOutputMode } from "../../bitcoind/types.js";
import { createBootstrapProgress } from "../../bitcoind/progress/formatting.js";
import {
  advanceFollowSceneState,
  createFollowSceneState,
  replaceFollowBlockTimes,
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

const MINING_ARTWORK_COG_WIDTH = 22;
const MINING_SENTENCE_BOARD_SIZE = 5;

export interface MiningSentenceBoardEntry {
  rank: number;
  domainName: string;
  sentence: string;
}

export interface MiningProvisionalSentenceEntry {
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
  visibleBlockTimesByHeight: Record<number, number>;
  settledBlockHeight: number | null;
  settledBoardEntries: MiningSentenceBoardEntry[];
  provisionalRequiredWords: readonly string[];
  provisionalEntry: MiningProvisionalSentenceEntry;
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

function formatCompactCogBalanceText(balanceCogtoshi: bigint | null): string | null {
  if (balanceCogtoshi === null) {
    return null;
  }

  for (let digits = 4; digits >= 1; digits -= 1) {
    const cogSegment = `${formatCogAmountWithDecimals(balanceCogtoshi, {
      maxFractionDigits: digits,
      minFractionDigits: 1,
    })} COG`;

    if (cogSegment.length <= MINING_ARTWORK_COG_WIDTH) {
      return cogSegment;
    }
  }

  return `${formatCogAmountWithDecimals(balanceCogtoshi, {
    maxFractionDigits: 1,
    minFractionDigits: 1,
  })} COG`;
}

function formatCompactSatBalanceText(balanceSats: bigint | null): string | null {
  return balanceSats === null ? null : `${balanceSats.toString()} SAT`;
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

function formatRequiredWordsLine(words: readonly string[]): string {
  if (words.length === 0) {
    return "";
  }

  return `Required words: ${words.map((word) => word.toUpperCase()).join(", ")}`;
}

function formatProvisionalSentenceRow(entry: MiningProvisionalSentenceEntry): string {
  if (entry.domainName === null || entry.sentence === null) {
    return "";
  }

  return `@${entry.domainName}: ${entry.sentence}`;
}

export function createEmptyMiningFollowVisualizerState(): MiningFollowVisualizerState {
  return {
    balanceCogtoshi: null,
    balanceSats: null,
    visibleBlockTimesByHeight: {},
    settledBlockHeight: null,
    settledBoardEntries: [],
    provisionalRequiredWords: [],
    provisionalEntry: {
      domainName: null,
      sentence: null,
    },
    latestSentence: null,
    latestTxid: null,
    recentWin: null,
  };
}

function cloneMiningRuntimeSnapshot(snapshot: MiningRuntimeStatusV1): MiningRuntimeStatusV1 {
  return {
    ...snapshot,
  };
}

function cloneMiningFollowVisualizerState(
  state: MiningFollowVisualizerState,
): MiningFollowVisualizerState {
  return {
    ...state,
    visibleBlockTimesByHeight: { ...state.visibleBlockTimesByHeight },
    settledBoardEntries: state.settledBoardEntries.map((entry) => ({
      ...entry,
    })),
    provisionalRequiredWords: [...state.provisionalRequiredWords],
    provisionalEntry: {
      ...state.provisionalEntry,
    },
    recentWin: state.recentWin === null
      ? null
      : {
        ...state.recentWin,
      },
  };
}

function miningFollowSceneShouldSettle(
  snapshot: MiningRuntimeStatusV1,
  nowUnixMs: number,
): boolean {
  return (
    (snapshot.tipSettledUntilUnixMs ?? 0) > nowUnixMs
    || (snapshot.reconnectSettledUntilUnixMs ?? 0) > nowUnixMs
  );
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
  #ticker: ReturnType<typeof setInterval> | null = null;
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

    if (this.#renderer !== null) {
      this.#ticker = this.#clock.setInterval(() => {
        this.#advanceAndRender();
      }, renderPolicy.repaintIntervalMs);
    }
  }

  update(snapshot: MiningRuntimeStatusV1, uiState?: MiningFollowVisualizerState): void {
    if (this.#renderer === null) {
      return;
    }

    this.#latestSnapshot = cloneMiningRuntimeSnapshot(snapshot);
    if (uiState !== undefined) {
      this.#latestUiState = cloneMiningFollowVisualizerState(uiState);
    }
    replaceFollowBlockTimes(this.#scene, this.#latestUiState.visibleBlockTimesByHeight);
    const indexedHeight = this.#latestSnapshot.indexerTipHeight ?? this.#latestSnapshot.coreBestHeight ?? null;
    const nodeHeight = this.#latestSnapshot.coreBestHeight ?? indexedHeight;
    const settleLatest = miningFollowSceneShouldSettle(this.#latestSnapshot, this.#clock.now());
    syncFollowSceneState(this.#scene, {
      indexedHeight,
      nodeHeight,
      liveActivated: true,
      authoritativeTip: true,
      settleLatest,
    });
    this.#renderThrottle.request();
  }

  close(): void {
    if (this.#ticker !== null) {
      this.#clock.clearInterval(this.#ticker);
      this.#ticker = null;
    }
    this.#renderThrottle.flush();
    this.#renderer?.close();
  }

  #advanceAndRender(): void {
    if (this.#renderer === null || this.#latestSnapshot === null) {
      return;
    }

    advanceFollowSceneState(this.#scene, this.#clock.now());
    this.#renderThrottle.request();
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

    this.#renderer.renderFollowScene(
      this.#progress,
      indexedHeight,
      nodeHeight,
      this.#scene,
      describeMiningVisualizerStatus(snapshot, uiState),
      {
        artworkCogText: formatCompactCogBalanceText(uiState.balanceCogtoshi),
        artworkSatText: formatCompactSatBalanceText(uiState.balanceSats),
        extraLines: [
          `✎ Indexed Block #${uiState.settledBlockHeight ?? "-----"} Sentences ✎`,
          "",
          ...Array.from({ length: MINING_SENTENCE_BOARD_SIZE }, (_value, index) => {
            const entry = uiState.settledBoardEntries[index];
            return entry === undefined
              ? `${index + 1}.`
              : formatSentenceRow(entry.rank, entry.domainName, entry.sentence);
          }),
          "----------",
          formatRequiredWordsLine(uiState.provisionalRequiredWords),
          formatProvisionalSentenceRow(uiState.provisionalEntry),
        ],
      },
    );
  }
}
