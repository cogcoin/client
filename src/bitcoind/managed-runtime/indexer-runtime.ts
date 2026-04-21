import type { ManagedIndexerDaemonObservedStatus } from "../types.js";
import { resolveIndexerDaemonProbeDecision } from "./indexer-policy.js";
import type {
  ManagedIndexerDaemonProbeResult,
  ManagedIndexerRuntimeOptionsLike,
  ManagedIndexerRuntimePathsLike,
  ManagedRuntimeLockLike,
} from "./types.js";

type ManagedIndexerRuntimeDependencies<TOptions, TClient> = {
  getPaths(options: TOptions): ManagedIndexerRuntimePathsLike;
  probeDaemon(
    options: TOptions,
    paths: ManagedIndexerRuntimePathsLike,
  ): Promise<ManagedIndexerDaemonProbeResult<TClient>>;
  requestBackgroundFollow(
    client: TClient,
    observedStatus: ManagedIndexerDaemonObservedStatus | null,
  ): Promise<TClient>;
  closeClient(client: TClient): Promise<void>;
  acquireStartLock(options: TOptions, paths: ManagedIndexerRuntimePathsLike): Promise<ManagedRuntimeLockLike>;
  startDaemon(options: TOptions, paths: ManagedIndexerRuntimePathsLike): Promise<TClient>;
  stopWithLockHeld(
    options: TOptions,
    paths: ManagedIndexerRuntimePathsLike,
    processId: number | null,
  ): Promise<unknown>;
  isLockBusyError(error: unknown): boolean;
  sleep(ms: number): Promise<void>;
};

async function waitForManagedIndexerRuntime<TOptions extends ManagedIndexerRuntimeOptionsLike, TClient>(
  options: TOptions,
  dependencies: ManagedIndexerRuntimeDependencies<TOptions, TClient>,
  paths: ManagedIndexerRuntimePathsLike,
): Promise<void> {
  const deadline = Date.now() + options.startupTimeoutMs;

  while (Date.now() < deadline) {
    const probe = await dependencies.probeDaemon(options, paths);

    if (probe.compatibility === "compatible" && probe.client !== null) {
      await dependencies.closeClient(probe.client).catch(() => undefined);
      return;
    }

    if (probe.compatibility !== "unreachable") {
      throw new Error(probe.error ?? "indexer_daemon_protocol_error");
    }

    await dependencies.sleep(250);
  }

  throw new Error("indexer_daemon_start_timeout");
}

export async function attachOrStartManagedIndexerRuntime<
  TOptions extends ManagedIndexerRuntimeOptionsLike,
  TClient,
>(
  options: TOptions,
  dependencies: ManagedIndexerRuntimeDependencies<TOptions, TClient>,
): Promise<TClient> {
  const paths = dependencies.getPaths(options);
  const existingProbe = await dependencies.probeDaemon(options, paths);
  const existingDecision = resolveIndexerDaemonProbeDecision({
    probe: existingProbe,
    expectedBinaryVersion: options.expectedBinaryVersion ?? null,
  });

  if (existingDecision.action === "attach" && existingProbe.client !== null) {
    try {
      return await dependencies.requestBackgroundFollow(existingProbe.client, existingProbe.status);
    } catch {
      await dependencies.closeClient(existingProbe.client).catch(() => undefined);
    }
  }

  if (existingDecision.action === "replace" && existingProbe.client !== null) {
    await dependencies.closeClient(existingProbe.client).catch(() => undefined);
  }

  if (existingDecision.action === "reject") {
    throw new Error(existingDecision.error ?? "indexer_daemon_protocol_error");
  }

  try {
    const lock = await dependencies.acquireStartLock(options, paths);

    try {
      const liveProbe = await dependencies.probeDaemon(options, paths);
      const liveDecision = resolveIndexerDaemonProbeDecision({
        probe: liveProbe,
        expectedBinaryVersion: options.expectedBinaryVersion ?? null,
      });

      if (liveDecision.action === "attach" && liveProbe.client !== null) {
        try {
          return await dependencies.requestBackgroundFollow(liveProbe.client, liveProbe.status);
        } catch {
          await dependencies.closeClient(liveProbe.client).catch(() => undefined);
          await dependencies.stopWithLockHeld(options, paths, liveProbe.status?.processId ?? null);
        }
      } else if (liveDecision.action === "replace" && liveProbe.client !== null) {
        await dependencies.closeClient(liveProbe.client).catch(() => undefined);
        await dependencies.stopWithLockHeld(options, paths, liveProbe.status?.processId ?? null);
      } else if (liveDecision.action === "reject") {
        throw new Error(liveDecision.error ?? "indexer_daemon_protocol_error");
      }

      const daemon = await dependencies.startDaemon(options, paths);

      try {
        return await dependencies.requestBackgroundFollow(daemon, null);
      } catch (error) {
        await dependencies.closeClient(daemon).catch(() => undefined);
        throw new Error("indexer_daemon_background_follow_recovery_failed", { cause: error });
      }
    } finally {
      await lock.release();
    }
  } catch (error) {
    if (dependencies.isLockBusyError(error)) {
      await waitForManagedIndexerRuntime(options, dependencies, paths);
      return attachOrStartManagedIndexerRuntime(options, dependencies);
    }

    throw error;
  }
}
