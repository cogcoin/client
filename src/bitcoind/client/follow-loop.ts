import type {
  FollowLoopControlDependencies,
  FollowLoopSubscriber,
  FollowLoopResources,
  ScheduleSyncDependencies,
  StartFollowingTipLoopDependencies,
  ZeroMqModuleLike,
} from "./internal-types.js";

async function loadZeroMqModule(): Promise<ZeroMqModuleLike> {
  return await import("zeromq") as unknown as ZeroMqModuleLike;
}

async function createSubscriber(
  loadZeroMq?: () => Promise<ZeroMqModuleLike>,
): Promise<FollowLoopSubscriber> {
  try {
    const zeroMq = loadZeroMq === undefined
      ? await loadZeroMqModule()
      : await loadZeroMq();
    return new zeroMq.Subscriber();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Managed tip following could not initialize \`zeromq\`: ${detail}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

export async function startFollowingTipLoop(
  dependencies: StartFollowingTipLoopDependencies,
): Promise<FollowLoopResources> {
  const subscriber = await createSubscriber(dependencies.loadZeroMq);
  const currentTip = await dependencies.client.getTip();
  await dependencies.progress.enableFollowVisualMode(
    currentTip?.height ?? null,
    await dependencies.loadVisibleFollowBlockTimes(currentTip),
  );
  await dependencies.syncToTip();

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
  subscriber: FollowLoopSubscriber,
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
    void dependencies.syncToTip().catch(() => undefined);
  }, dependencies.syncDebounceMs);

  dependencies.setDebounceTimer(timer);
}

export async function closeFollowLoopResources(
  resources: {
    subscriber: FollowLoopSubscriber | null;
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
