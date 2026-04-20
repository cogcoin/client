import assert from "node:assert/strict";
import test from "node:test";

import { closeFollowLoopResources, startFollowingTipLoop } from "../src/bitcoind/client/follow-loop.js";
import { DEFAULT_MANAGED_BITCOIND_FOLLOW_POLL_INTERVAL_MS } from "../src/bitcoind/types.js";
import type {
  FollowLoopSubscriber,
  StartFollowingTipLoopDependencies,
  ZeroMqModuleLike,
} from "../src/bitcoind/client/internal-types.js";
import type { SyncResult } from "../src/bitcoind/types.js";

class FakeSubscriber implements FollowLoopSubscriber {
  connectedTo: string | null = null;
  subscribedTo: string | null = null;
  closed = false;

  connect(endpoint: string): void {
    this.connectedTo = endpoint;
  }

  subscribe(topic: string): void {
    this.subscribedTo = topic;
  }

  close(): void {
    this.closed = true;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {}
}

function createSyncResult(): SyncResult {
  return {
    appliedBlocks: 0,
    rewoundBlocks: 0,
    commonAncestorHeight: null,
    startingHeight: null,
    endingHeight: null,
    bestHeight: 0,
    bestHashHex: "",
  };
}

function createDependencies(
  overrides: Partial<StartFollowingTipLoopDependencies> = {},
): StartFollowingTipLoopDependencies {
  return {
    client: {
      async getTip() {
        return {
          height: 12,
          blockHashHex: "00".repeat(32),
          previousHashHex: null,
          stateHashHex: null,
        };
      },
    } as StartFollowingTipLoopDependencies["client"],
    progress: {
      async enableFollowVisualMode() {},
    } as StartFollowingTipLoopDependencies["progress"],
    node: {
      zmq: {
        endpoint: "tcp://127.0.0.1:28332",
        topic: "hashblock",
        pollIntervalMs: DEFAULT_MANAGED_BITCOIND_FOLLOW_POLL_INTERVAL_MS,
      },
    } as StartFollowingTipLoopDependencies["node"],
    async syncToTip() {
      return createSyncResult();
    },
    scheduleSync() {},
    shouldContinue() {
      return false;
    },
    async loadVisibleFollowBlockTimes() {
      return {};
    },
    ...overrides,
  };
}

test("managed follow polling defaults to the shared 2-second backstop", () => {
  assert.equal(DEFAULT_MANAGED_BITCOIND_FOLLOW_POLL_INTERVAL_MS, 2_000);
});

test("startFollowingTipLoop loads zeromq lazily before wiring follow mode", async () => {
  const createdSubscriber = { current: null as FakeSubscriber | null };
  let visualModeArgs: [number | null, Record<number, number>] | null = null;
  let syncCalls = 0;

  const resources = await startFollowingTipLoop(createDependencies({
    progress: {
      async enableFollowVisualMode(
        height: number | null,
        visibleBlockTimes: Record<number, number>,
      ) {
        visualModeArgs = [height, visibleBlockTimes];
      },
    } as StartFollowingTipLoopDependencies["progress"],
    async syncToTip() {
      syncCalls += 1;
      return createSyncResult();
    },
    async loadVisibleFollowBlockTimes() {
      return { 12: 1_700_000_000 };
    },
    async loadZeroMq(): Promise<ZeroMqModuleLike> {
      return {
        Subscriber: class extends FakeSubscriber {
          constructor() {
            super();
            createdSubscriber.current = this;
          }
        },
      };
    },
  }));

  try {
    assert.deepEqual(visualModeArgs, [12, { 12: 1_700_000_000 }]);
    assert.equal(syncCalls, 1);
    const subscriber = createdSubscriber.current;
    assert.notEqual(subscriber, null);
    if (subscriber === null) {
      throw new Error("expected a subscriber instance");
    }
    assert.equal(subscriber.connectedTo, "tcp://127.0.0.1:28332");
    assert.equal(subscriber.subscribedTo, "hashblock");
    await resources.followLoop;
  } finally {
    await closeFollowLoopResources(resources);
  }

  const subscriber = createdSubscriber.current;
  assert.notEqual(subscriber, null);
  if (subscriber === null) {
    throw new Error("expected a subscriber instance");
  }
  assert.equal(subscriber.closed, true);
});

test("startFollowingTipLoop adds context when zeromq initialization fails", async () => {
  let syncCalls = 0;

  await assert.rejects(
    async () => startFollowingTipLoop(createDependencies({
      async syncToTip() {
        syncCalls += 1;
        return createSyncResult();
      },
      async loadZeroMq(): Promise<ZeroMqModuleLike> {
        throw new Error("Cannot find package 'zeromq' imported");
      },
    })),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /could not initialize `zeromq`/);
      assert.match(error.message, /Cannot find package 'zeromq' imported/);
      return true;
    },
  );

  assert.equal(syncCalls, 0);
});

test("startFollowingTipLoop schedules syncs from polling when ZMQ stays quiet", async () => {
  let scheduleCalls = 0;

  const resources = await startFollowingTipLoop(createDependencies({
    node: {
      zmq: {
        endpoint: "tcp://127.0.0.1:28332",
        topic: "hashblock",
        pollIntervalMs: 20,
      },
    } as StartFollowingTipLoopDependencies["node"],
    shouldContinue() {
      return true;
    },
    scheduleSync() {
      scheduleCalls += 1;
    },
    async loadZeroMq(): Promise<ZeroMqModuleLike> {
      return {
        Subscriber: FakeSubscriber,
      };
    },
  }));

  try {
    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.ok(scheduleCalls >= 1);
  } finally {
    await closeFollowLoopResources(resources);
  }
});
