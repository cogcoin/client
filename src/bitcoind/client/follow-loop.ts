import { Subscriber } from "zeromq";

import type {
  FollowLoopControlDependencies,
  FollowLoopResources,
  ScheduleSyncDependencies,
  StartFollowingTipLoopDependencies,
} from "./internal-types.js";

export async function startFollowingTipLoop(
  dependencies: StartFollowingTipLoopDependencies,
): Promise<FollowLoopResources> {
  const currentTip = await dependencies.client.getTip();
  await dependencies.progress.enableFollowVisualMode(
    currentTip?.height ?? null,
    await dependencies.loadVisibleFollowBlockTimes(currentTip),
  );
  await dependencies.syncToTip();

  const subscriber = new Subscriber();
  subscriber.connect(dependencies.node.zmq.endpoint);
  subscriber.subscribe(dependencies.node.zmq.topic);
  const followLoop = consumeZmq(subscriber, {
    shouldContinue: dependencies.shouldContinue,
    scheduleSync: dependencies.scheduleSync,
  });
  const pollTimer = setInterval(() => {
    dependencies.scheduleSync();
  }, dependencies.node.zmq.pollIntervalMs);

  return {
    subscriber,
    followLoop,
    pollTimer,
  };
}

export async function consumeZmq(
  subscriber: Subscriber,
  dependencies: FollowLoopControlDependencies,
): Promise<void> {
  try {
    for await (const _frames of subscriber) {
      if (!dependencies.shouldContinue()) {
        break;
      }

      dependencies.scheduleSync();
    }
  } catch {
    // The polling backstop remains active if the ZMQ loop exits.
  }
}

export function scheduleSync(dependencies: ScheduleSyncDependencies): void {
  if (
    !dependencies.isFollowing()
    || dependencies.isClosed()
    || dependencies.getDebounceTimer() !== null
  ) {
    return;
  }

  const timer = setTimeout(() => {
    dependencies.setDebounceTimer(null);
    void dependencies.syncToTip();
  }, dependencies.syncDebounceMs);

  dependencies.setDebounceTimer(timer);
}

export async function closeFollowLoopResources(
  resources: {
    subscriber: Subscriber | null;
    followLoop: Promise<void> | null;
    pollTimer: ReturnType<typeof setInterval> | null;
  },
): Promise<void> {
  if (resources.pollTimer !== null) {
    clearInterval(resources.pollTimer);
  }

  if (resources.subscriber !== null) {
    resources.subscriber.close();
  }

  if (resources.followLoop !== null) {
    await resources.followLoop;
  }
}
