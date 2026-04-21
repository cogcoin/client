import { loadMiningRuntimeStatus } from "../mining/runtime-artifacts.js";
import { acquireFileLock, type FileLockHandle } from "../fs/lock.js";
import type {
  ManagedBitcoindObservedStatus,
  ManagedIndexerDaemonObservedStatus,
} from "../../bitcoind/types.js";
import type { WalletRuntimePaths } from "../runtime.js";
import { join } from "node:path";
import { readdir } from "node:fs/promises";

import { readJsonFileOrNull } from "./artifacts.js";
import type {
  TrackedManagedProcess,
  WalletResetProcessCleanupDependencies,
  WalletResetResult,
} from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveProcessCleanupDependencies(
  overrides: WalletResetProcessCleanupDependencies = {},
) {
  return {
    acquireLock: overrides.acquireLock ?? acquireFileLock,
    processKill: overrides.processKill ?? process.kill.bind(process),
    sleep: overrides.sleep ?? sleep,
  };
}

export async function isProcessAlive(
  pid: number | null,
  deps: WalletResetProcessCleanupDependencies = {},
): Promise<boolean> {
  const resolved = resolveProcessCleanupDependencies(deps);

  if (pid === null) {
    return false;
  }

  try {
    resolved.processKill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }

    return true;
  }
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs = 15_000,
  deps: WalletResetProcessCleanupDependencies = {},
): Promise<boolean> {
  const resolved = resolveProcessCleanupDependencies(deps);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!await isProcessAlive(pid, resolved)) {
      return true;
    }

    await resolved.sleep(100);
  }

  return !await isProcessAlive(pid, resolved);
}

export async function terminateTrackedProcesses(
  trackedProcesses: readonly TrackedManagedProcess[],
  deps: WalletResetProcessCleanupDependencies = {},
): Promise<WalletResetResult["stoppedProcesses"]> {
  const resolved = resolveProcessCleanupDependencies(deps);
  const survivors = new Set<number>();

  for (const processInfo of trackedProcesses) {
    try {
      resolved.processKill(processInfo.pid, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }

  for (const processInfo of trackedProcesses) {
    if (!await waitForProcessExit(processInfo.pid, 5_000, resolved)) {
      survivors.add(processInfo.pid);
    }
  }

  for (const pid of survivors) {
    try {
      resolved.processKill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }

  const remaining = new Set<number>();
  for (const pid of survivors) {
    if (!await waitForProcessExit(pid, 5_000, resolved)) {
      remaining.add(pid);
    }
  }

  if (remaining.size > 0) {
    throw new Error("reset_process_shutdown_failed");
  }

  return {
    managedBitcoind: trackedProcesses.filter((processInfo) => processInfo.kind === "managed-bitcoind").length,
    indexerDaemon: trackedProcesses.filter((processInfo) => processInfo.kind === "indexer-daemon").length,
    backgroundMining: trackedProcesses.filter((processInfo) => processInfo.kind === "background-mining").length,
    survivors: 0,
  };
}

export async function collectTrackedManagedProcesses(
  paths: WalletRuntimePaths,
  deps: WalletResetProcessCleanupDependencies = {},
): Promise<{
  trackedProcesses: TrackedManagedProcess[];
  trackedProcessKinds: Array<TrackedManagedProcess["kind"]>;
  serviceLockPaths: string[];
}> {
  const trackedProcesses: TrackedManagedProcess[] = [];
  const trackedProcessKinds = new Set<TrackedManagedProcess["kind"]>();
  const serviceLockPaths = new Set<string>();

  const runtimeEntries = await readdir(paths.runtimeRoot, { withFileTypes: true }).catch((error) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  });

  for (const entry of runtimeEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const serviceRoot = join(paths.runtimeRoot, entry.name);
    const bitcoindStatus = await readJsonFileOrNull<ManagedBitcoindObservedStatus>(join(serviceRoot, "bitcoind-status.json"));

    if (bitcoindStatus?.processId != null && await isProcessAlive(bitcoindStatus.processId, deps)) {
      trackedProcesses.push({
        kind: "managed-bitcoind",
        pid: bitcoindStatus.processId,
      });
      trackedProcessKinds.add("managed-bitcoind");
      serviceLockPaths.add(join(serviceRoot, "bitcoind.lock"));
    }
  }

  const indexerEntries = await readdir(paths.indexerRoot, { withFileTypes: true }).catch((error) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  });

  for (const entry of indexerEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const status = await readJsonFileOrNull<ManagedIndexerDaemonObservedStatus>(join(paths.indexerRoot, entry.name, "status.json"));
    if (status?.processId != null && await isProcessAlive(status.processId, deps)) {
      trackedProcesses.push({
        kind: "indexer-daemon",
        pid: status.processId,
      });
      trackedProcessKinds.add("indexer-daemon");
      serviceLockPaths.add(join(paths.runtimeRoot, entry.name, "indexer-daemon.lock"));
    }
  }

  const miningRuntime = await loadMiningRuntimeStatus(paths.miningStatusPath).catch(() => null);
  if (
    miningRuntime?.backgroundWorkerPid != null
    && await isProcessAlive(miningRuntime.backgroundWorkerPid, deps)
  ) {
    trackedProcesses.push({
      kind: "background-mining",
      pid: miningRuntime.backgroundWorkerPid,
    });
    trackedProcessKinds.add("background-mining");
  }

  const seen = new Set<string>();
  const deduped = trackedProcesses.filter((processInfo) => {
    const key = `${processInfo.kind}:${processInfo.pid}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  return {
    trackedProcesses: deduped,
    trackedProcessKinds: [...trackedProcessKinds],
    serviceLockPaths: [...serviceLockPaths].sort(),
  };
}

export async function acquireResetLocks(
  paths: WalletRuntimePaths,
  serviceLockPaths: readonly string[],
  deps: WalletResetProcessCleanupDependencies = {},
): Promise<FileLockHandle[]> {
  const resolved = resolveProcessCleanupDependencies(deps);
  const lockPaths = [
    paths.walletControlLockPath,
    paths.miningControlLockPath,
    ...serviceLockPaths,
  ];
  const handles: FileLockHandle[] = [];

  try {
    for (const lockPath of lockPaths) {
      handles.push(await resolved.acquireLock(lockPath, {
        purpose: "wallet-reset",
        walletRootId: null,
      }));
    }
    return handles;
  } catch (error) {
    await Promise.all(handles.map(async (handle) => handle.release().catch(() => undefined)));
    throw error;
  }
}
