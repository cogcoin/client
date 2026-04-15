import assert from "node:assert/strict";
import test from "node:test";

import { resolveTtyRenderPolicy, TtyRenderThrottle } from "../src/bitcoind/progress/render-policy.js";
import { DEFAULT_SNAPSHOT_METADATA, ManagedProgressController } from "../src/bitcoind/testing.js";
import { MiningFollowVisualizer } from "../src/wallet/mining/visualizer.js";
import type { MiningRuntimeStatusV1 } from "../src/wallet/mining/types.js";

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

    return {
      id: nextId,
      timer: nextTimer,
    };
  }
}

function createTtyStream() {
  return {
    isTTY: true,
    columns: 79,
    write(): boolean {
      return true;
    },
  };
}

function createControllerRendererRecorder() {
  const calls: Array<{ kind: "frame" | "follow" | "completion"; phase: string; status: string }> = [];

  return {
    calls,
    factory() {
      return {
        render(
          _displayPhase: string,
          _quote: unknown,
          progress: { phase: string },
          _cogcoinSyncHeight: number | null,
          _cogcoinSyncTargetHeight: number | null,
          _introElapsedMs?: number,
          statusFieldText = "",
        ) {
          calls.push({
            kind: "frame",
            phase: progress.phase,
            status: statusFieldText,
          });
        },
        renderFollowScene(
          progress: { phase: string },
          _cogcoinSyncHeight: number | null,
          _cogcoinSyncTargetHeight: number | null,
          _followScene: unknown,
          statusFieldText = "",
        ) {
          calls.push({
            kind: "follow",
            phase: progress.phase,
            status: statusFieldText,
          });
        },
        renderTrainScene(
          _kind: "intro" | "completion",
          progress: { phase: string },
          _cogcoinSyncHeight: number | null,
          _cogcoinSyncTargetHeight: number | null,
          _elapsedMs: number,
          statusFieldText = "",
        ) {
          calls.push({
            kind: "completion",
            phase: progress.phase,
            status: statusFieldText,
          });
        },
        close() {
          // no-op
        },
      };
    },
  };
}

function createVisualizerRendererRecorder() {
  const calls: Array<{ message: string; status: string }> = [];

  return {
    calls,
    factory() {
      return {
        renderFollowScene(
          progress: { message: string },
          _cogcoinSyncHeight: number | null,
          _cogcoinSyncTargetHeight: number | null,
          _followScene: unknown,
          statusFieldText = "",
        ) {
          calls.push({
            message: progress.message,
            status: statusFieldText,
          });
        },
        close() {
          // no-op
        },
      };
    },
  };
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
    liveMiningFamilyInMempool: false,
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
    hookMode: "builtin",
    providerConfigured: true,
    providerKind: "openai",
    bitcoindHealth: "ready",
    bitcoindServiceState: "ready",
    bitcoindReplicaStatus: "ready",
    nodeHealth: "synced",
    indexerHealth: "synced",
    tipsAligned: true,
    lastValidationState: "unknown",
    lastOperatorValidationState: "never",
    lastValidationAtUnixMs: null,
    lastEventAtUnixMs: null,
    lastError: null,
    note: null,
    ...partial,
  };
}

function createQuoteRotatorStub(startedAtMs: number) {
  return {
    async current(now = startedAtMs) {
      return {
        displayPhase: "banner" as const,
        currentQuote: null,
        displayStartedAt: now,
      };
    },
  };
}

test("resolveTtyRenderPolicy detects Linux headless throttling at 1 Hz", () => {
  assert.deepEqual(
    resolveTtyRenderPolicy("auto", { isTTY: true }, { platform: "linux", env: {} }),
    {
      enabled: true,
      linuxHeadlessThrottle: true,
      repaintIntervalMs: 1_000,
    },
  );

  assert.deepEqual(
    resolveTtyRenderPolicy("auto", { isTTY: true }, { platform: "linux", env: { DISPLAY: ":0" } }),
    {
      enabled: true,
      linuxHeadlessThrottle: false,
      repaintIntervalMs: 250,
    },
  );

  assert.deepEqual(
    resolveTtyRenderPolicy("auto", { isTTY: true }, { platform: "darwin", env: {} }),
    {
      enabled: true,
      linuxHeadlessThrottle: false,
      repaintIntervalMs: 250,
    },
  );

  assert.deepEqual(
    resolveTtyRenderPolicy("none", { isTTY: true }, { platform: "linux", env: {} }),
    {
      enabled: false,
      linuxHeadlessThrottle: false,
      repaintIntervalMs: 250,
    },
  );
});

test("ManagedProgressController coalesces Linux headless redraws while keeping progress callbacks immediate", async () => {
  const clock = new FakeClock(Date.now());
  const stream = createTtyStream();
  const phases: string[] = [];
  const renderer = createControllerRendererRecorder();
  const progress = new ManagedProgressController({
    quoteStatePath: "unused-in-test",
    snapshot: DEFAULT_SNAPSHOT_METADATA,
    progressOutput: "auto",
    quoteRotator: createQuoteRotatorStub(clock.now()),
    rendererFactory: renderer.factory,
    stream,
    platform: "linux",
    env: {},
    clock,
    onProgress(event) {
      phases.push(event.phase);
    },
  });

  await progress.start();
  assert.equal(renderer.calls.length, 1);

  const baselineEvents = phases.length;
  await progress.setPhase("snapshot_download", {
    downloadedBytes: 1024,
    totalBytes: DEFAULT_SNAPSHOT_METADATA.sizeBytes,
    percent: 0.01,
  });
  await progress.setPhase("bitcoin_sync", {
    blocks: 910_010,
    targetHeight: 910_100,
  });
  await progress.setCogcoinSync(910_015, 910_100);

  assert.equal(phases.length, baselineEvents + 3);
  assert.equal(renderer.calls.length, 1);

  await progress.close();
  assert.equal(renderer.calls.length, 2);
});

test("TtyRenderThrottle coalesces Linux headless repaint requests to 1 Hz and flushes the latest frame", () => {
  const clock = new FakeClock(0);
  let renderCount = 0;
  const throttle = new TtyRenderThrottle({
    clock,
    intervalMs: 1_000,
    onRender() {
      renderCount += 1;
    },
    throttled: true,
  });

  throttle.request();
  throttle.request();
  assert.equal(renderCount, 1);

  clock.advance(999);
  assert.equal(renderCount, 1);

  clock.advance(1);
  assert.equal(renderCount, 2);

  throttle.request();
  assert.equal(renderCount, 2);

  throttle.flush();
  assert.equal(renderCount, 3);
});

test("MiningFollowVisualizer coalesces Linux headless tty redraws and renders the latest snapshot", () => {
  const clock = new FakeClock(1_700_000_000_000);
  const stream = {
    isTTY: true,
    columns: 120,
    write(): boolean {
      return true;
    },
  };
  const renderer = createVisualizerRendererRecorder();
  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    rendererFactory: renderer.factory,
    stream,
    platform: "linux",
    env: {},
    clock,
  });

  visualizer.update(createSnapshot({
    currentPhase: "generating",
    note: "First frame.",
  }));
  visualizer.update(createSnapshot({
    currentPhase: "scoring",
    note: "Second frame should be coalesced.",
  }));

  assert.equal(renderer.calls.length, 1);

  clock.advance(500);
  visualizer.update(createSnapshot({
    currentPhase: "publishing",
    note: "Latest coalesced frame.",
  }));
  assert.equal(renderer.calls.length, 1);

  clock.advance(500);
  assert.equal(renderer.calls.length, 2);
  assert.match(renderer.calls.at(-1)?.message ?? "", /Latest coalesced frame\./);

  visualizer.close();
});

test("MiningFollowVisualizer keeps immediate redraws outside Linux headless", () => {
  const clock = new FakeClock(1_700_000_000_000);
  const stream = {
    isTTY: true,
    columns: 120,
    write(): boolean {
      return true;
    },
  };
  const renderer = createVisualizerRendererRecorder();
  const visualizer = new MiningFollowVisualizer({
    progressOutput: "auto",
    rendererFactory: renderer.factory,
    stream,
    platform: "linux",
    env: { DISPLAY: ":0" },
    clock,
  });

  visualizer.update(createSnapshot({
    currentPhase: "generating",
    note: "Frame one.",
  }));
  visualizer.update(createSnapshot({
    currentPhase: "publishing",
    note: "Frame two.",
  }));

  assert.equal(renderer.calls.length, 2);
  visualizer.close();
});
