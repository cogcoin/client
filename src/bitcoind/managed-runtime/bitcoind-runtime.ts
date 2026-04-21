import { resolveManagedBitcoindProbeDecision } from "./bitcoind-policy.js";
import type {
  ManagedBitcoindObservedStatus,
} from "../types.js";
import type {
  ManagedBitcoindRuntimeOptionsLike,
  ManagedBitcoindRuntimePathsLike,
  ManagedBitcoindServiceProbeResult,
  ManagedBitcoindStatusCandidate,
  ManagedRuntimeLockLike,
} from "./types.js";

type ManagedBitcoindRuntimeDependencies<TOptions, THandle> = {
  getPaths(options: TOptions): ManagedBitcoindRuntimePathsLike;
  listStatusCandidates(options: {
    dataDir: string;
    runtimeRoot: string;
    expectedStatusPath: string;
  }): Promise<ManagedBitcoindStatusCandidate[]>;
  isProcessAlive(processId: number | null): Promise<boolean>;
  probeStatusCandidate(
    status: ManagedBitcoindObservedStatus,
    options: TOptions,
    runtimeRoot: string,
  ): Promise<ManagedBitcoindServiceProbeResult>;
  attachExisting(options: TOptions): Promise<THandle | null>;
  acquireStartLock(options: TOptions, paths: ManagedBitcoindRuntimePathsLike): Promise<ManagedRuntimeLockLike>;
  startService(options: TOptions, paths: ManagedBitcoindRuntimePathsLike): Promise<THandle>;
  isLockBusyError(error: unknown): boolean;
  sleep(ms: number): Promise<void>;
};

async function waitForManagedBitcoindRuntime<TOptions extends ManagedBitcoindRuntimeOptionsLike, THandle>(
  options: TOptions,
  dependencies: ManagedBitcoindRuntimeDependencies<TOptions, THandle>,
): Promise<THandle> {
  const deadline = Date.now() + options.startupTimeoutMs;

  while (Date.now() < deadline) {
    const attached = await dependencies.attachExisting(options).catch(() => null);

    if (attached !== null) {
      return attached;
    }

    await dependencies.sleep(250);
  }

  throw new Error("managed_bitcoind_service_start_timeout");
}

export async function probeManagedBitcoindRuntime<TOptions extends ManagedBitcoindRuntimeOptionsLike>(
  options: TOptions,
  dependencies: Pick<
    ManagedBitcoindRuntimeDependencies<TOptions, never>,
    "getPaths" | "listStatusCandidates" | "isProcessAlive" | "probeStatusCandidate"
  >,
): Promise<ManagedBitcoindServiceProbeResult> {
  const paths = dependencies.getPaths(options);
  const candidates = await dependencies.listStatusCandidates({
    dataDir: options.dataDir,
    runtimeRoot: paths.runtimeRoot,
    expectedStatusPath: paths.bitcoindStatusPath,
  });
  const expectedCandidate = candidates.find((candidate) => candidate.statusPath === paths.bitcoindStatusPath) ?? null;

  for (const candidate of candidates) {
    if (!await dependencies.isProcessAlive(candidate.status.processId)) {
      continue;
    }

    return dependencies.probeStatusCandidate(candidate.status, options, paths.walletRuntimeRoot);
  }

  return {
    compatibility: "unreachable",
    status: expectedCandidate?.status ?? candidates[0]?.status ?? null,
    error: null,
  };
}

export async function attachOrStartManagedBitcoindRuntime<
  TOptions extends ManagedBitcoindRuntimeOptionsLike,
  THandle,
>(
  options: TOptions,
  dependencies: ManagedBitcoindRuntimeDependencies<TOptions, THandle>,
): Promise<THandle> {
  const existingProbe = await probeManagedBitcoindRuntime(options, dependencies);
  const existingDecision = resolveManagedBitcoindProbeDecision(existingProbe);

  if (existingDecision.action === "attach") {
    const existing = await dependencies.attachExisting(options);

    if (existing !== null) {
      return existing;
    }

    throw new Error("managed_bitcoind_protocol_error");
  }

  if (existingDecision.action === "reject") {
    throw new Error(existingDecision.error ?? "managed_bitcoind_protocol_error");
  }

  const paths = dependencies.getPaths(options);

  try {
    const lock = await dependencies.acquireStartLock(options, paths);

    try {
      const liveProbe = await probeManagedBitcoindRuntime(options, dependencies);
      const liveDecision = resolveManagedBitcoindProbeDecision(liveProbe);

      if (liveDecision.action === "attach") {
        const reattached = await dependencies.attachExisting(options);

        if (reattached !== null) {
          return reattached;
        }

        throw new Error("managed_bitcoind_protocol_error");
      }

      if (liveDecision.action === "reject") {
        throw new Error(liveDecision.error ?? "managed_bitcoind_protocol_error");
      }

      return await dependencies.startService(options, paths);
    } finally {
      await lock.release();
    }
  } catch (error) {
    if (dependencies.isLockBusyError(error)) {
      return waitForManagedBitcoindRuntime(options, dependencies);
    }

    throw error;
  }
}
