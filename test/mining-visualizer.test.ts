import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmptyMiningFollowVisualizerState,
  MiningFollowVisualizer,
  describeMiningVisualizerProgress,
  describeMiningVisualizerStatus,
} from "../src/wallet/mining/visualizer.js";
import { centerLine } from "../src/bitcoind/progress/formatting.js";
import { renderFollowFrameForTesting } from "../src/bitcoind/progress/follow-scene.js";
import type { FollowSceneRenderOptions } from "../src/bitcoind/progress/tty-renderer.js";
import type { MiningRuntimeStatusV1 } from "../src/wallet/mining/types.js";
import type { MiningFollowVisualizerState, MiningSentenceBoardEntry } from "../src/wallet/mining/visualizer.js";

interface FakeTimer {
  callback: () => void;
  dueAtMs: number;
  intervalMs: number | null;
}

class FakeClock {
  #nextId = 1;
  #timers = new Map<number, FakeTimer>();
  nowMs: number;

  constructor(nowMs = Date.now()) {
    this.nowMs = nowMs;
  }

  now = (): number => this.nowMs;

  setTimeout: typeof setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const id = this.#nextId++;
    this.#timers.set(id, {
      callback: () => callback(...args),
      dueAtMs: this.nowMs + Math.max(0, delay ?? 0),
      intervalMs: null,
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;

  clearTimeout: typeof clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    this.#timers.delete(handle as unknown as number);
  }) as typeof clearTimeout;

  setInterval: typeof setInterval = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const id = this.#nextId++;
    this.#timers.set(id, {
      callback: () => callback(...args),
      dueAtMs: this.nowMs + Math.max(0, delay ?? 0),
      intervalMs: Math.max(0, delay ?? 0),
    });
    return id as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;

  clearInterval: typeof clearInterval = ((handle: ReturnType<typeof setInterval>) => {
    this.#timers.delete(handle as unknown as number);
  }) as typeof clearInterval;

  advance(ms: number): void {
    const targetMs = this.nowMs + ms;

    while (true) {
      const next = this.#nextDueTimer(targetMs);

      if (next === null) {
        break;
      }

      this.nowMs = next.timer.dueAtMs;

      if (next.timer.intervalMs === null) {
        this.#timers.delete(next.id);
      } else {
        next.timer.dueAtMs += next.timer.intervalMs;
      }

      next.timer.callback();
    }

    this.nowMs = targetMs;
  }

  #nextDueTimer(targetMs: number): { id: number; timer: FakeTimer } | null {
    let nextId: number | null = null;
    let nextTimer: FakeTimer | null = null;

    for (const [id, timer] of this.#timers) {
      if (timer.dueAtMs > targetMs) {
        continue;
      }

      if (nextTimer === null || timer.dueAtMs < nextTimer.dueAtMs) {
        nextId = id;
        nextTimer = timer;
      }
    }

    if (nextId === null || nextTimer === null) {
      return null;
    }

    return { id: nextId, timer: nextTimer };
  }
}

class MemoryStream {
  readonly chunks: string[] = [];
  isTTY?: boolean;
  columns?: number;

  constructor(options: { isTTY?: boolean; columns?: number } = {}) {
    this.isTTY = options.isTTY;
    this.columns = options.columns;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  toString(): string {
    return this.chunks.join("");
  }
}

function createSnapshot(
  partial: Partial<MiningRuntimeStatusV1> = {},
): MiningRuntimeStatusV1 {
  return {
    schemaVersion: 1,
    walletRootId: "wallet-root-test",
    workerApiVersion: null,
    workerBinaryVersion: null,
    workerBuildId: null,
    updatedAtUnixMs: 1_700_000_000_000,
    runMode: "foreground",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    backgroundWorkerHeartbeatAtUnixMs: null,
    backgroundWorkerHealth: null,
    indexerDaemonState: "synced",
    indexerDaemonInstanceId: "daemon-1",
    indexerSnapshotSeq: "seq-1",
    indexerSnapshotOpenedAtUnixMs: 1_700_000_000_000,
    indexerTruthSource: "lease",
    indexerHeartbeatAtUnixMs: 1_700_000_000_000,
    coreBestHeight: 100,
    coreBestHash: "00".repeat(32),
    indexerTipHeight: 100,
    indexerTipHash: "11".repeat(32),
    indexerReorgDepth: null,
    indexerTipAligned: true,
    corePublishState: "healthy",
    providerState: "ready",
    lastSuspendDetectedAtUnixMs: null,
    reconnectSettledUntilUnixMs: null,
    tipSettledUntilUnixMs: null,
    miningState: "idle",
    currentPhase: "idle",
    currentPublishState: "none",
    targetBlockHeight: null,
    referencedBlockHashDisplay: null,
    currentDomainId: null,
    currentDomainName: null,
    currentSentenceDisplay: null,
    currentCanonicalBlend: null,
    currentTxid: null,
    currentWtxid: null,
    livePublishInMempool: false,
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
    providerKind: "openai",
    bitcoindHealth: "ready",
    bitcoindServiceState: "ready",
    bitcoindReplicaStatus: "ready",
    nodeHealth: "synced",
    indexerHealth: "synced",
    tipsAligned: true,
    lastEventAtUnixMs: null,
    lastError: null,
    note: null,
    ...partial,
  };
}

function createUiState(
  partial: Partial<MiningFollowVisualizerState> = {},
): MiningFollowVisualizerState {
  return {
    ...createEmptyMiningFollowVisualizerState(),
    ...partial,
  };
}

function createBoardEntry(
  rank: number,
  domainName: string,
  sentence: string,
  requiredWords: readonly string[] = [],
): MiningSentenceBoardEntry {
  return {
    rank,
    domainName,
    sentence,
    requiredWords,
  };
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function createCenteredBoardTitle(settledBlockHeight: number | string): string {
  return centerLine(`✎ Block #${settledBlockHeight} Sentences ✎`, 80);
}

function createSceneCaptureVisualizer(options: {
  clock: FakeClock;
  scenes: Array<{
    displayedCenterHeight: number | null;
    queuedHeights: number[];
    pendingLabel: string | null;
    animationKind: string | null;
    animationHeight: number | null;
  }>;
}): MiningFollowVisualizer {
  return new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    clock: options.clock,
    platform: "linux",
    env: { DISPLAY: ":0" },
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        _cogcoinSyncHeight,
        _cogcoinSyncTargetHeight,
        followScene,
      ) {
        options.scenes.push({
          displayedCenterHeight: followScene.displayedCenterHeight,
          queuedHeights: [...followScene.queuedHeights],
          pendingLabel: followScene.pendingLabel,
          animationKind: followScene.animation?.kind ?? null,
          animationHeight: followScene.animation?.height ?? null,
        });
      },
      close() {
        // no-op
      },
    }),
  });
}

test("mining follow visualizer renders the follow scene on tty streams", () => {
  const stream = new MemoryStream({ isTTY: true, columns: 120 });
  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream,
  });

  visualizer.update(createSnapshot({
    currentPhase: "generating",
    note: "Generating mining sentences for eligible root domains.",
  }));
  visualizer.close();

  const output = stream.toString();
  assert.match(output, /Generating candidates/);
  assert.match(output, /Generating mining sentences for eligible root domains\./);
});

test("mining follow visualizer passes the client semver to the right artwork status lane", () => {
  let capturedOptions: FollowSceneRenderOptions | undefined;

  const visualizer = new MiningFollowVisualizer({
    clientVersion: " 1.1.10 ",
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        _cogcoinSyncHeight,
        _cogcoinSyncTargetHeight,
        _followScene,
        _statusFieldText,
        renderOptions,
      ) {
        capturedOptions = renderOptions;
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot({
    currentPhase: "waiting",
  }));
  visualizer.close();

  assert.equal(capturedOptions?.artworkStatusLeftText, undefined);
  assert.equal(capturedOptions?.artworkStatusRightText, "v1.1.10");
});

test("mining follow visualizer adds an UPDATE badge on the left while keeping semver on the right", () => {
  let capturedOptions: FollowSceneRenderOptions | undefined;

  const visualizer = new MiningFollowVisualizer({
    clientVersion: "1.1.10",
    updateAvailable: true,
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        _cogcoinSyncHeight,
        _cogcoinSyncTargetHeight,
        _followScene,
        _statusFieldText,
        renderOptions,
      ) {
        capturedOptions = renderOptions;
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot({
    currentPhase: "waiting",
  }));
  visualizer.close();

  assert.equal(capturedOptions?.artworkStatusLeftText, "UPDATE");
  assert.equal(capturedOptions?.artworkStatusRightText, "v1.1.10");
});

test("mining follow visualizer stays quiet when tty progress is disabled", () => {
  const stream = new MemoryStream({ isTTY: true, columns: 120 });
  const visualizer = new MiningFollowVisualizer({
    progressOutput: "none",
    stream,
  });

  visualizer.update(createSnapshot({
    currentPhase: "publishing",
    currentPublishDecision: "broadcast",
  }));
  visualizer.close();

  assert.equal(stream.toString(), "");
});

test("mining visualizer descriptions surface zero-reward and note overrides", () => {
  const zeroRewardSnapshot = createSnapshot({
    currentPhase: "idle",
    pauseReason: "zero-reward",
  });

  assert.equal(describeMiningVisualizerStatus(zeroRewardSnapshot), "Zero-reward height");

  const notedSnapshot = createSnapshot({
    currentPhase: "waiting-indexer",
    note: "Custom mining note.",
  });

  assert.equal(describeMiningVisualizerProgress(notedSnapshot), "Custom mining note.");
});

test("mining visualizer progress uses provider-specific waiting text without changing the short status label", () => {
  const snapshot = createSnapshot({
    currentPhase: "waiting-provider",
    providerState: "rate-limited",
    note: null,
  });

  assert.equal(
    describeMiningVisualizerProgress(snapshot),
    "Mining is waiting because the sentence provider is rate limited and will be retried automatically.",
  );
  assert.equal(describeMiningVisualizerStatus(snapshot), "Waiting for provider");
});

test("mining follow visualizer renders and advances follow-style age labels when block times are provided", () => {
  const clock = new FakeClock(180_000);
  const renderedFrames: string[] = [];

  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    clock,
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        _cogcoinSyncHeight,
        _cogcoinSyncTargetHeight,
        followScene,
        statusFieldText,
        renderOptions,
      ) {
        renderedFrames.push(renderFollowFrameForTesting(
          followScene,
          statusFieldText ?? "",
          clock.now(),
          {
            artworkCogText: renderOptions?.artworkCogText ?? null,
            artworkSatText: renderOptions?.artworkSatText ?? null,
          },
        ).join("\n"));
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot({
    currentPhase: "waiting",
  }), createUiState({
    visibleBlockTimesByHeight: {
      100: 60,
    },
  }));

  assert.match(renderedFrames[0] ?? "", /\b2m\b/);

  clock.advance(60_000);

  assert.ok(renderedFrames.some((frame) => /\b3m\b/.test(frame)));
  visualizer.close();
});

test("mining follow visualizer omits age labels when block times are unavailable", () => {
  const clock = new FakeClock(180_000);
  const renderedFrames: string[] = [];

  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    clock,
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        _cogcoinSyncHeight,
        _cogcoinSyncTargetHeight,
        followScene,
        statusFieldText,
        renderOptions,
      ) {
        renderedFrames.push(renderFollowFrameForTesting(
          followScene,
          statusFieldText ?? "",
          clock.now(),
          {
            artworkCogText: renderOptions?.artworkCogText ?? null,
            artworkSatText: renderOptions?.artworkSatText ?? null,
          },
        ).join("\n"));
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot({
    currentPhase: "waiting",
  }), createUiState());
  visualizer.close();

  assert.doesNotMatch(renderedFrames[0] ?? "", /\b\d+[smhd]\b/);
});

test("mining follow visualizer renders the current mined block board when settled winners are available", () => {
  let capturedOptions: FollowSceneRenderOptions | undefined;

  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        _cogcoinSyncHeight,
        _cogcoinSyncTargetHeight,
        _followScene,
        _statusFieldText,
        renderOptions,
      ) {
        capturedOptions = renderOptions;
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot(), createUiState({
    balanceCogtoshi: 123_450_000n,
    balanceSats: 42n,
    settledBlockHeight: 100,
    settledBoardEntries: [
      createBoardEntry(1, "alpha", "alpha sentence"),
      createBoardEntry(2, "beta", "beta sentence"),
    ],
    provisionalRequiredWords: ["under", "tree", "monkey", "youth", "basket"],
    provisionalEntry: {
      domainName: "local",
      sentence: "local sentence",
    },
    provisionalBroadcastTxid: "ab".repeat(32),
    latestSentence: "local sentence",
    latestTxid: "ab".repeat(32),
  }));
  visualizer.close();

  assert.deepEqual(capturedOptions, {
    artworkCogText: "1.2345 COG",
    artworkSatText: "42 SAT",
    extraLines: [
      createCenteredBoardTitle(100),
      "1. @alpha: alpha sentence",
      "2. @beta: beta sentence",
      "3.",
      "4.",
      "5.",
      "@local: local sentence",
      "",
      `View at: https://mempool.space/tx/${"ab".repeat(32)}`,
    ],
  });
});

test("mining follow visualizer replaces the provisional tx link with deposit guidance when BTC is insufficient", () => {
  let capturedOptions: FollowSceneRenderOptions | undefined;
  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        _cogcoinSyncHeight,
        _cogcoinSyncTargetHeight,
        _followScene,
        _statusFieldText,
        renderOptions,
      ) {
        capturedOptions = renderOptions;
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot({
    currentPhase: "waiting",
    currentPublishDecision: "publish-paused-insufficient-funds",
  }), createUiState({
    fundingAddress: "bc1qfunding",
    settledBlockHeight: 100,
    settledBoardEntries: [
      createBoardEntry(1, "alpha", "alpha sentence"),
      createBoardEntry(2, "beta", "beta sentence"),
    ],
    provisionalRequiredWords: ["under", "tree", "monkey", "youth", "basket"],
    provisionalEntry: {
      domainName: "local",
      sentence: "local sentence",
    },
    provisionalBroadcastTxid: "ab".repeat(32),
    latestSentence: "local sentence",
    latestTxid: "ab".repeat(32),
  }));
  visualizer.close();

  assert.ok(capturedOptions?.extraLines);
  assert.equal(capturedOptions.extraLines[6], "@local: local sentence");
  assert.equal(capturedOptions.extraLines[7], "");
  assert.equal(capturedOptions.extraLines[8], "Deposit BTC to bc1qfunding to mine.");
});

test("mining follow visualizer falls back to a generic deposit line when the funding address is unavailable", () => {
  let capturedOptions: FollowSceneRenderOptions | undefined;
  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        _cogcoinSyncHeight,
        _cogcoinSyncTargetHeight,
        _followScene,
        _statusFieldText,
        renderOptions,
      ) {
        capturedOptions = renderOptions;
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot({
    currentPhase: "waiting",
    currentPublishDecision: "publish-paused-insufficient-funds",
  }), createUiState({
    settledBlockHeight: 100,
    provisionalRequiredWords: ["under", "tree", "monkey", "youth", "basket"],
    provisionalEntry: {
      domainName: "local",
      sentence: "local sentence",
    },
  }));
  visualizer.close();

  assert.ok(capturedOptions?.extraLines);
  assert.equal(capturedOptions.extraLines[6], "@local: local sentence");
  assert.equal(capturedOptions.extraLines[7], "");
  assert.equal(capturedOptions.extraLines[8], "Deposit BTC to this wallet address to mine.");
});

test("mining follow visualizer uppercases each settled row with its own required words without cross-row bleed", () => {
  let capturedOptions: FollowSceneRenderOptions | undefined;

  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        _cogcoinSyncHeight,
        _cogcoinSyncTargetHeight,
        _followScene,
        _statusFieldText,
        renderOptions,
      ) {
        capturedOptions = renderOptions;
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot(), createUiState({
    settledBlockHeight: 100,
    settledBoardEntries: [
      createBoardEntry(1, "alpha", "under tree trees treetop youth, basket.", ["under", "tree", "youth", "basket"]),
      createBoardEntry(2, "beta", "candy vanish year toast toasty under.", ["candy", "vanish", "year", "toast"]),
    ],
    provisionalRequiredWords: ["monkey", "under", "tree"],
    provisionalEntry: {
      domainName: "local",
      sentence: "monkey under tree trees.",
    },
  }));
  visualizer.close();

  assert.equal(capturedOptions?.extraLines?.[1], "1. @alpha: UNDER TREE TREES TREETOP YOUTH, BASKET.");
  assert.equal(capturedOptions?.extraLines?.[2], "2. @beta: CANDY VANISH YEAR TOAST TOASTY under.");
  assert.equal(capturedOptions?.extraLines?.[6], "@local: MONKEY UNDER TREE TREES.");
  assert.equal(capturedOptions?.extraLines?.[7], "");
  assert.equal(capturedOptions?.extraLines?.[8], "");
});

test("mining follow visualizer uppercases whole alphabetic tokens for suffix, prefix, and prefix-plus-suffix matches", () => {
  let capturedOptions: FollowSceneRenderOptions | undefined;

  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        _cogcoinSyncHeight,
        _cogcoinSyncTargetHeight,
        _followScene,
        _statusFieldText,
        renderOptions,
      ) {
        capturedOptions = renderOptions;
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot(), createUiState({
    settledBlockHeight: 100,
    settledBoardEntries: [
      createBoardEntry(1, "alpha", "engages, recover, and reengages promptly.", ["engage", "cover"]),
    ],
    provisionalRequiredWords: ["engage", "cover"],
    provisionalEntry: {
      domainName: "local",
      sentence: "engages, recover, and reengages.",
    },
  }));
  visualizer.close();

  assert.equal(capturedOptions?.extraLines?.[1], "1. @alpha: ENGAGES, RECOVER, and REENGAGES promptly.");
  assert.equal(capturedOptions?.extraLines?.[6], "@local: ENGAGES, RECOVER, and REENGAGES.");
  assert.equal(capturedOptions?.extraLines?.[7], "");
  assert.equal(capturedOptions?.extraLines?.[8], "");
});

test("mining follow visualizer keeps the full settled sentence line instead of ellipsizing at 80 columns", () => {
  let capturedOptions: FollowSceneRenderOptions | undefined;

  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        _cogcoinSyncHeight,
        _cogcoinSyncTargetHeight,
        _followScene,
        _statusFieldText,
        renderOptions,
      ) {
        capturedOptions = renderOptions;
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot(), createUiState({
    settledBlockHeight: 100,
    settledBoardEntries: [
      createBoardEntry(
        1,
        "alpha",
        "under tree monkey youth basket raven orchard lantern window harbor candle feather velvet thunder meadow sunrise river canyon marble silver lantern window harbor candle feather velvet thunder meadow sunrise river canyon marble silver.",
        ["under", "tree", "monkey", "youth", "basket"],
      ),
    ],
  }));
  visualizer.close();

  const firstLine = capturedOptions?.extraLines?.[1] ?? "";

  assert.ok(firstLine.length > 80);
  assert.ok(firstLine.includes("UNDER TREE MONKEY YOUTH BASKET"));
  assert.ok(firstLine.includes("river canyon marble silver."));
  assert.ok(!firstLine.endsWith("…"));
  assert.equal(capturedOptions?.extraLines?.[2], "2.");
});

test("mining follow visualizer wraps and ellipsizes the provisional sentence slot to two lines", () => {
  let capturedOptions: FollowSceneRenderOptions | undefined;

  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        _cogcoinSyncHeight,
        _cogcoinSyncTargetHeight,
        _followScene,
        _statusFieldText,
        renderOptions,
      ) {
        capturedOptions = renderOptions;
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot(), createUiState({
    settledBlockHeight: 100,
    provisionalRequiredWords: ["under", "tree", "monkey", "youth", "basket"],
    provisionalEntry: {
      domainName: "local",
      sentence: "under tree monkey youth basket raven orchard lantern window harbor candle feather velvet thunder meadow sunrise river canyon marble silver lantern window harbor candle feather velvet thunder meadow sunrise river canyon marble silver.",
    },
  }));
  visualizer.close();

  const firstLine = capturedOptions?.extraLines?.[6] ?? "";
  const secondLine = capturedOptions?.extraLines?.[7] ?? "";
  const indent = " ".repeat("@local: ".length);

  assert.ok(firstLine.length <= 80);
  assert.ok(secondLine.length <= 80);
  assert.ok(firstLine.includes("UNDER TREE MONKEY YOUTH BASKET"));
  assert.ok(secondLine.startsWith(indent));
  assert.ok(secondLine.endsWith("…"));
  assert.equal(capturedOptions?.extraLines?.[8], "");
});

test("mining follow visualizer keeps the raw tip rail while labeling the older indexed sentence board explicitly", () => {
  let capturedIndexedHeight: number | null | undefined;
  let capturedNodeHeight: number | null | undefined;
  let capturedOptions: FollowSceneRenderOptions | undefined;

  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        cogcoinSyncHeight,
        cogcoinSyncTargetHeight,
        _followScene,
        _statusFieldText,
        renderOptions,
      ) {
        capturedIndexedHeight = cogcoinSyncHeight;
        capturedNodeHeight = cogcoinSyncTargetHeight;
        capturedOptions = renderOptions;
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot({
    coreBestHeight: 102,
    indexerTipHeight: 100,
    currentPhase: "waiting-indexer",
  }), createUiState({
    settledBlockHeight: 100,
    settledBoardEntries: [
      createBoardEntry(1, "alpha", "indexed sentence"),
    ],
  }));
  visualizer.close();

  assert.equal(capturedIndexedHeight, 100);
  assert.equal(capturedNodeHeight, 102);
  assert.equal(capturedOptions?.extraLines?.[0], createCenteredBoardTitle(100));
  assert.equal(capturedOptions?.extraLines?.[1], "1. @alpha: indexed sentence");
});

test("mining follow visualizer renders blank indexed rows when the ui state itself has no settled board entries", () => {
  let capturedOptions: FollowSceneRenderOptions | undefined;

  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        _cogcoinSyncHeight,
        _cogcoinSyncTargetHeight,
        _followScene,
        _statusFieldText,
        renderOptions,
      ) {
        capturedOptions = renderOptions;
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot(), createUiState({
    settledBlockHeight: 101,
  }));
  visualizer.close();

  assert.equal(capturedOptions?.artworkCogText, null);
  assert.equal(capturedOptions?.artworkSatText, null);
  assert.deepEqual(capturedOptions?.extraLines, [
    createCenteredBoardTitle(101),
    "1.",
    "2.",
    "3.",
    "4.",
    "5.",
    "",
    "",
    "",
  ]);
});

test("mining follow visualizer centers the placeholder board title when the settled height is unavailable", () => {
  let capturedOptions: FollowSceneRenderOptions | undefined;

  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        _cogcoinSyncHeight,
        _cogcoinSyncTargetHeight,
        _followScene,
        _statusFieldText,
        renderOptions,
      ) {
        capturedOptions = renderOptions;
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot(), createUiState());
  visualizer.close();

  assert.equal(capturedOptions?.extraLines?.[0], createCenteredBoardTitle("-----"));
});

test("mining follow visualizer keeps a fixed-height frame across empty, unpublished, and published states", () => {
  const stream = new MemoryStream({ isTTY: true, columns: 120 });
  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream,
  });

  visualizer.update(createSnapshot({
    currentPhase: "waiting",
  }), createUiState({
    settledBlockHeight: 102,
  }));
  visualizer.update(createSnapshot({
    currentPhase: "waiting",
  }), createUiState({
    settledBlockHeight: 102,
    provisionalRequiredWords: ["under", "tree", "monkey", "youth", "basket"],
    provisionalEntry: {
      domainName: "local",
      sentence: "candidate not published",
    },
    latestSentence: "candidate not published",
  }));
  visualizer.update(createSnapshot({
    currentPhase: "waiting",
  }), createUiState({
    settledBlockHeight: 102,
    settledBoardEntries: [
      createBoardEntry(1, "alpha", "alpha sentence"),
    ],
    provisionalRequiredWords: ["under", "tree", "monkey", "youth", "basket"],
    provisionalEntry: {
      domainName: "local",
      sentence: "candidate published",
    },
    latestSentence: "candidate published",
    latestTxid: "cd".repeat(32),
  }));
  visualizer.close();

  const expectedFrameHeight = 25;
  assert.equal(countMatches(stream.chunks[1] ?? "", /\u001B\[2K/g), expectedFrameHeight);
  assert.equal(countMatches(stream.chunks[1] ?? "", /\u001B\[1A/g), expectedFrameHeight - 1);
  assert.equal(countMatches(stream.chunks[3] ?? "", /\u001B\[2K/g), expectedFrameHeight);
  assert.equal(countMatches(stream.chunks[3] ?? "", /\u001B\[1A/g), expectedFrameHeight - 1);
});

test("mining follow visualizer renders a blank spacer above the board title", () => {
  const stream = new MemoryStream({ isTTY: true, columns: 120 });
  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream,
  });

  visualizer.update(createSnapshot({
    currentPhase: "waiting",
  }), createUiState({
    settledBlockHeight: 102,
  }));
  visualizer.close();

  const lines = (stream.chunks[0] ?? "").split("\n");
  const titleIndex = lines.findIndex((line) => line.trim() === "✎ Block #102 Sentences ✎");

  assert.notEqual(titleIndex, -1);
  assert.equal(lines[titleIndex - 1], "");
});

test("mining follow visualizer snapshots runtime and board state for ticker redraws", () => {
  const clock = new FakeClock(0);
  const renders: Array<{
    message: string;
    indexedHeight: number | null;
    nodeHeight: number | null;
    extraLines: string[];
  }> = [];

  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    clock,
    platform: "linux",
    env: { DISPLAY: ":0" },
    rendererFactory: () => ({
      renderFollowScene(
        progress,
        cogcoinSyncHeight,
        cogcoinSyncTargetHeight,
        _followScene,
        _statusFieldText,
        renderOptions,
      ) {
        renders.push({
          message: progress.message,
          indexedHeight: cogcoinSyncHeight,
          nodeHeight: cogcoinSyncTargetHeight,
          extraLines: [...(renderOptions?.extraLines ?? [])],
        });
      },
      close() {
        // no-op
      },
    }),
  });

  const snapshot = createSnapshot({
    currentPhase: "waiting",
    note: "Stable runtime frame.",
    coreBestHeight: 100,
    indexerTipHeight: 100,
  });
  const indexedRequiredWords = ["under"];
  const uiState = createUiState({
    settledBlockHeight: 100,
    settledBoardEntries: [
      createBoardEntry(1, "alpha", "under indexed sentence", indexedRequiredWords),
    ],
    provisionalRequiredWords: ["under", "tree", "monkey", "youth", "basket"],
    provisionalEntry: {
      domainName: "local",
      sentence: "local sentence",
    },
  });

  visualizer.update(snapshot, uiState);
  assert.equal(renders.length, 1);

  snapshot.currentPhase = "publishing";
  snapshot.note = "Mutated runtime frame.";
  snapshot.coreBestHeight = 101;
  snapshot.indexerTipHeight = 101;
  uiState.settledBlockHeight = 101;
  uiState.settledBoardEntries[0]!.sentence = "mutated sentence";
  indexedRequiredWords[0] = "mutated";
  uiState.provisionalRequiredWords = ["raise", "shove", "only", "nasty", "wrestle"];
  uiState.provisionalEntry = {
    domainName: "mutated",
    sentence: "mutated local sentence",
  };

  clock.advance(250);

  assert.ok(renders.length >= 2);
  assert.deepEqual(renders.at(-1), {
    message: "Stable runtime frame.",
    indexedHeight: 100,
    nodeHeight: 100,
    extraLines: [
      createCenteredBoardTitle(100),
      "1. @alpha: UNDER indexed sentence",
      "2.",
      "3.",
      "4.",
      "5.",
      "@local: local sentence",
      "",
      "",
    ],
  });

  visualizer.close();
});

test("mining follow visualizer snapshots queued headless redraw state", () => {
  const clock = new FakeClock(1_700_000_000_000);
  const renders: Array<{
    message: string;
    indexedHeight: number | null;
    nodeHeight: number | null;
    extraLines: string[];
  }> = [];

  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    clock,
    platform: "linux",
    env: {},
    rendererFactory: () => ({
      renderFollowScene(
        progress,
        cogcoinSyncHeight,
        cogcoinSyncTargetHeight,
        _followScene,
        _statusFieldText,
        renderOptions,
      ) {
        renders.push({
          message: progress.message,
          indexedHeight: cogcoinSyncHeight,
          nodeHeight: cogcoinSyncTargetHeight,
          extraLines: [...(renderOptions?.extraLines ?? [])],
        });
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot({
    currentPhase: "generating",
    note: "Initial frame.",
  }), createUiState({
    settledBlockHeight: 99,
  }));
  assert.equal(renders.length, 1);

  clock.advance(500);

  const queuedSnapshot = createSnapshot({
    currentPhase: "waiting-indexer",
    note: "Queued frame.",
    coreBestHeight: 101,
    indexerTipHeight: 100,
  });
  const queuedRequiredWords = ["under"];
  const queuedUiState = createUiState({
    settledBlockHeight: 100,
    settledBoardEntries: [
      createBoardEntry(1, "alpha", "under queued sentence", queuedRequiredWords),
    ],
    provisionalRequiredWords: ["under", "tree", "monkey", "youth", "basket"],
    provisionalEntry: {
      domainName: "local",
      sentence: "queued local sentence",
    },
  });

  visualizer.update(queuedSnapshot, queuedUiState);
  assert.equal(renders.length, 1);

  queuedSnapshot.note = "Mutated queued frame.";
  queuedSnapshot.coreBestHeight = 102;
  queuedSnapshot.indexerTipHeight = 102;
  queuedRequiredWords[0] = "mutated";
  queuedUiState.settledBlockHeight = 101;
  queuedUiState.settledBoardEntries[0]!.sentence = "mutated queued sentence";
  queuedUiState.provisionalRequiredWords = ["raise", "shove", "only", "nasty", "wrestle"];
  queuedUiState.provisionalEntry = {
    domainName: "mutated",
    sentence: "mutated queued local sentence",
  };

  clock.advance(500);

  assert.equal(renders.length, 2);
  assert.deepEqual(renders[1], {
    message: "Queued frame.",
    indexedHeight: 100,
    nodeHeight: 101,
    extraLines: [
      createCenteredBoardTitle(100),
      "1. @alpha: UNDER queued sentence",
      "2.",
      "3.",
      "4.",
      "5.",
      "@local: queued local sentence",
      "",
      "",
    ],
  });

  visualizer.close();
});

test("mining follow visualizer keeps ordinary adjacent tip updates animated", () => {
  const clock = new FakeClock(1_700_000_000_000);
  const scenes: Array<{
    displayedCenterHeight: number | null;
    queuedHeights: number[];
    pendingLabel: string | null;
    animationKind: string | null;
    animationHeight: number | null;
  }> = [];
  const visualizer = createSceneCaptureVisualizer({
    clock,
    scenes,
  });

  visualizer.update(createSnapshot({
    coreBestHeight: 100,
    indexerTipHeight: 100,
  }), createUiState());
  visualizer.update(createSnapshot({
    coreBestHeight: 101,
    indexerTipHeight: 100,
  }), createUiState());
  visualizer.close();

  assert.deepEqual(scenes.at(-1), {
    displayedCenterHeight: 100,
    queuedHeights: [101],
    pendingLabel: null,
    animationKind: null,
    animationHeight: null,
  });
});

test("mining follow visualizer discards stale queued tip history and reattaches to the latest tip", () => {
  const clock = new FakeClock(1_700_000_000_000);
  const scenes: Array<{
    displayedCenterHeight: number | null;
    queuedHeights: number[];
    pendingLabel: string | null;
    animationKind: string | null;
    animationHeight: number | null;
  }> = [];
  const visualizer = createSceneCaptureVisualizer({
    clock,
    scenes,
  });

  visualizer.update(createSnapshot({
    coreBestHeight: 100,
    indexerTipHeight: 100,
  }), createUiState());
  visualizer.update(createSnapshot({
    coreBestHeight: 101,
    indexerTipHeight: 101,
  }), createUiState());
  visualizer.update(createSnapshot({
    coreBestHeight: 104,
    indexerTipHeight: 104,
  }), createUiState());
  visualizer.close();

  assert.deepEqual(scenes.at(-1), {
    displayedCenterHeight: 104,
    queuedHeights: [],
    pendingLabel: null,
    animationKind: null,
    animationHeight: null,
  });
});

test("mining follow visualizer settles immediately to the latest tip while a tip settle window is active", () => {
  const clock = new FakeClock(1_700_000_000_000);
  const scenes: Array<{
    displayedCenterHeight: number | null;
    queuedHeights: number[];
    pendingLabel: string | null;
    animationKind: string | null;
    animationHeight: number | null;
  }> = [];
  const visualizer = createSceneCaptureVisualizer({
    clock,
    scenes,
  });

  visualizer.update(createSnapshot({
    coreBestHeight: 100,
    indexerTipHeight: 100,
  }), createUiState());
  visualizer.update(createSnapshot({
    coreBestHeight: 101,
    indexerTipHeight: 101,
  }), createUiState());
  visualizer.update(createSnapshot({
    coreBestHeight: 103,
    indexerTipHeight: 103,
    tipSettledUntilUnixMs: clock.now() + 1_000,
  }), createUiState());

  assert.deepEqual(scenes.at(-1), {
    displayedCenterHeight: 103,
    queuedHeights: [],
    pendingLabel: null,
    animationKind: null,
    animationHeight: null,
  });

  clock.advance(1_001);
  visualizer.update(createSnapshot({
    coreBestHeight: 104,
    indexerTipHeight: 103,
    tipSettledUntilUnixMs: null,
  }), createUiState());
  visualizer.close();

  assert.deepEqual(scenes.at(-1), {
    displayedCenterHeight: 103,
    queuedHeights: [104],
    pendingLabel: "104",
    animationKind: "placeholder_enter",
    animationHeight: null,
  });
});

test("mining follow visualizer settles immediately to the latest tip while a reconnect settle window is active", () => {
  const clock = new FakeClock(1_700_000_000_000);
  const scenes: Array<{
    displayedCenterHeight: number | null;
    queuedHeights: number[];
    pendingLabel: string | null;
    animationKind: string | null;
    animationHeight: number | null;
  }> = [];
  const visualizer = createSceneCaptureVisualizer({
    clock,
    scenes,
  });

  visualizer.update(createSnapshot({
    coreBestHeight: 100,
    indexerTipHeight: 100,
  }), createUiState());
  visualizer.update(createSnapshot({
    coreBestHeight: 101,
    indexerTipHeight: 101,
  }), createUiState());
  visualizer.update(createSnapshot({
    coreBestHeight: 103,
    indexerTipHeight: 102,
    reconnectSettledUntilUnixMs: clock.now() + 1_000,
  }), createUiState({
    settledBlockHeight: 102,
  }));
  visualizer.close();

  assert.deepEqual(scenes.at(-1), {
    displayedCenterHeight: 103,
    queuedHeights: [],
    pendingLabel: null,
    animationKind: null,
    animationHeight: null,
  });
});

test("mining visualizer status prefers the recent settled win banner", () => {
  const status = describeMiningVisualizerStatus(
    createSnapshot({
      currentPhase: "waiting",
    }),
    createUiState({
      recentWin: {
        rank: 2,
        rewardCogtoshi: 123_000_000n,
        blockHeight: 101,
      },
    }),
  );

  assert.equal(status, "You got #2 and mined 1.23 COG in block #101");
});

test("mining follow visualizer advances the follow scene without a second update", () => {
  const clock = new FakeClock(0);
  const renders: Array<{
    displayedCenterHeight: number | null;
    queuedHeights: number[];
    animationKind: string | null;
  }> = [];

  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    clock,
    rendererFactory: () => ({
      renderFollowScene(
        _progress,
        _cogcoinSyncHeight,
        _cogcoinSyncTargetHeight,
        followScene,
      ) {
        renders.push({
          displayedCenterHeight: followScene.displayedCenterHeight,
          queuedHeights: [...followScene.queuedHeights],
          animationKind: followScene.animation?.kind ?? null,
        });
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot({
    coreBestHeight: 101,
    indexerTipHeight: 100,
    currentPhase: "waiting",
  }));

  assert.equal(renders.length, 1);
  assert.equal(renders[0]?.displayedCenterHeight, 100);
  assert.deepEqual(renders[0]?.queuedHeights, [101]);
  assert.equal(renders[0]?.animationKind, null);

  clock.advance(250);

  assert.equal(renders.length, 2);
  assert.equal(renders[1]?.displayedCenterHeight, 100);
  assert.deepEqual(renders[1]?.queuedHeights, [101]);
  assert.equal(renders[1]?.animationKind, "tip_approach");

  clock.advance(4_000);

  assert.ok(renders.length >= 3);
  assert.ok(renders.some((entry) => entry.displayedCenterHeight === 101));
  visualizer.close();
});

test("mining follow visualizer stops ticking after close", () => {
  const clock = new FakeClock(0);
  let renderCount = 0;

  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    stream: new MemoryStream({ isTTY: true, columns: 120 }),
    clock,
    rendererFactory: () => ({
      renderFollowScene() {
        renderCount += 1;
      },
      close() {
        // no-op
      },
    }),
  });

  visualizer.update(createSnapshot({
    coreBestHeight: 102,
    indexerTipHeight: 100,
    currentPhase: "waiting",
  }));
  assert.equal(renderCount, 1);

  clock.advance(250);
  assert.equal(renderCount, 2);

  visualizer.close();
  clock.advance(1_000);

  assert.equal(renderCount, 2);
});
