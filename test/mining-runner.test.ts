import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  runForegroundMining,
  startBackgroundMining,
  takeOverMiningRuntimeForTesting,
} from "../src/wallet/mining/runner.js";
import { loadMiningRuntimeStatus, saveMiningRuntimeStatus } from "../src/wallet/mining/runtime-artifacts.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../src/wallet/runtime.js";
import { createMemoryWalletSecretProviderForTesting } from "../src/wallet/state/provider.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { createMiningRuntimeStatus } from "./current-model-helpers.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createRuntimePaths(homeDirectory: string, seedName: string | null = null): WalletRuntimePaths {
  return resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
    seedName,
  });
}

function createPrompter() {
  return {
    isInteractive: true,
    writeLine() {},
    async prompt() {
      return "";
    },
    async promptHidden() {
      return "";
    },
  };
}

function createStderrStream() {
  return {
    isTTY: false,
    columns: 80,
    write() {
      return true;
    },
  };
}

function installProcessKillMock(
  t: TestContext,
  options: {
    livePids?: readonly number[];
    stubbornPids?: readonly number[];
  } = {},
) {
  const originalKill = process.kill;
  const alive = new Set([...(options.livePids ?? []), ...(options.stubbornPids ?? [])]);
  const stubborn = new Set(options.stubbornPids ?? []);
  const calls: Array<{ pid: number; signal: number | NodeJS.Signals | undefined }> = [];
  const timeline: string[] = [];

  (process as typeof process & {
    kill: typeof process.kill;
  }).kill = ((pid: number, signal?: number | NodeJS.Signals) => {
    calls.push({ pid, signal });

    if (pid === process.pid) {
      return true;
    }

    if (!alive.has(pid)) {
      const error = Object.assign(new Error("process not found"), {
        code: "ESRCH",
      });
      throw error;
    }

    if (signal === undefined || signal === 0) {
      return true;
    }

    if (signal === "SIGTERM") {
      timeline.push(`SIGTERM:${pid}`);
      if (!stubborn.has(pid)) {
        alive.delete(pid);
      }
      return true;
    }

    if (signal === "SIGKILL") {
      timeline.push(`SIGKILL:${pid}`);
      alive.delete(pid);
      return true;
    }

    return true;
  }) as typeof process.kill;

  t.after(() => {
    (process as typeof process & {
      kill: typeof process.kill;
    }).kill = originalKill;
  });

  return {
    calls,
    timeline,
  };
}

test("runForegroundMining replaces an existing background miner in the same runtime", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-mine-fg-bg");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  const killLog = installProcessKillMock(t, {
    livePids: [7_001],
  });
  const events: string[] = [];

  await saveMiningRuntimeStatus(
    paths.miningStatusPath,
    createMiningRuntimeStatus({
      runMode: "background",
      backgroundWorkerPid: 7_001,
      backgroundWorkerRunId: "run-old",
      backgroundWorkerHealth: "healthy",
    }),
  );

  await runForegroundMining({
    dataDir: homeDirectory,
    databasePath: join(homeDirectory, "indexer.sqlite"),
    provider,
    prompter: createPrompter(),
    builtInSetupEnsured: true,
    paths,
    stderr: createStderrStream(),
    runMiningLoopImpl: async () => {
      events.push("run");
    },
    saveStopSnapshotImpl: async () => {
      events.push("save-stop");
    },
    shutdownGraceMs: 1,
    sleepImpl: async () => undefined,
  });

  assert.equal(
    killLog.calls.filter((call) => call.pid === 7_001 && call.signal === "SIGTERM").length,
    1,
  );
  assert.deepEqual(events, ["run", "save-stop"]);
  const runtime = await loadMiningRuntimeStatus(paths.miningStatusPath);
  assert.equal(runtime?.runMode, "stopped");
  assert.equal(runtime?.backgroundWorkerPid, null);
});

test("runForegroundMining replaces an existing foreground miner in the same runtime", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-mine-fg-fg");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  const killLog = installProcessKillMock(t, {
    livePids: [8_001],
  });
  const events: string[] = [];

  await writeJsonFile(paths.miningControlLockPath, {
    processId: 8_001,
    acquiredAtUnixMs: 1,
    purpose: "mine-foreground",
    walletRootId: "wallet-root",
  });
  await saveMiningRuntimeStatus(
    paths.miningStatusPath,
    createMiningRuntimeStatus({
      runMode: "foreground",
      note: "existing foreground miner",
    }),
  );

  await runForegroundMining({
    dataDir: homeDirectory,
    databasePath: join(homeDirectory, "indexer.sqlite"),
    provider,
    prompter: createPrompter(),
    builtInSetupEnsured: true,
    paths,
    stderr: createStderrStream(),
    runMiningLoopImpl: async () => {
      events.push("run");
    },
    saveStopSnapshotImpl: async () => {
      events.push("save-stop");
    },
    shutdownGraceMs: 1,
    sleepImpl: async () => undefined,
  });

  assert.equal(
    killLog.calls.filter((call) => call.pid === 8_001 && call.signal === "SIGTERM").length,
    1,
  );
  assert.deepEqual(events, ["run", "save-stop"]);
  assert.equal(await pathExists(paths.miningControlLockPath), false);
});

test("startBackgroundMining replaces an existing background miner and returns started true", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-mine-start-bg");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  const killLog = installProcessKillMock(t, {
    livePids: [9_001],
  });
  const spawned: string[][] = [];
  const healthySnapshot = createMiningRuntimeStatus({
    runMode: "background",
    backgroundWorkerPid: 4_242,
    backgroundWorkerRunId: "run-new",
    backgroundWorkerHealth: "healthy",
  });

  await saveMiningRuntimeStatus(
    paths.miningStatusPath,
    createMiningRuntimeStatus({
      runMode: "background",
      backgroundWorkerPid: 9_001,
      backgroundWorkerRunId: "run-old",
      backgroundWorkerHealth: "healthy",
    }),
  );

  const result = await startBackgroundMining({
    dataDir: homeDirectory,
    databasePath: join(homeDirectory, "indexer.sqlite"),
    provider,
    prompter: createPrompter(),
    builtInSetupEnsured: true,
    paths,
    spawnWorkerProcess: ((...args: unknown[]) => {
      spawned.push(args[1] as string[]);
      return {
        pid: 4_242,
        unref() {},
      } as any;
    }) as any,
    waitForBackgroundHealthyImpl: async () => healthySnapshot,
    shutdownGraceMs: 1,
    sleepImpl: async () => undefined,
  });

  assert.equal(result.started, true);
  assert.equal(result.snapshot?.backgroundWorkerPid, 4_242);
  assert.equal(spawned.length, 1);
  assert.equal(
    killLog.calls.filter((call) => call.pid === 9_001 && call.signal === "SIGTERM").length,
    1,
  );
});

test("startBackgroundMining replaces an existing foreground miner in the same runtime", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-mine-start-fg");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  const killLog = installProcessKillMock(t, {
    livePids: [9_101],
  });
  const healthySnapshot = createMiningRuntimeStatus({
    runMode: "background",
    backgroundWorkerPid: 5_151,
    backgroundWorkerRunId: "run-new",
    backgroundWorkerHealth: "healthy",
  });

  await writeJsonFile(paths.miningControlLockPath, {
    processId: 9_101,
    acquiredAtUnixMs: 1,
    purpose: "mine-foreground",
    walletRootId: "wallet-root",
  });
  await saveMiningRuntimeStatus(
    paths.miningStatusPath,
    createMiningRuntimeStatus({
      runMode: "foreground",
      note: "existing foreground miner",
    }),
  );

  const result = await startBackgroundMining({
    dataDir: homeDirectory,
    databasePath: join(homeDirectory, "indexer.sqlite"),
    provider,
    prompter: createPrompter(),
    builtInSetupEnsured: true,
    paths,
    spawnWorkerProcess: (() => ({
      pid: 5_151,
      unref() {},
    })) as any,
    waitForBackgroundHealthyImpl: async () => healthySnapshot,
    shutdownGraceMs: 1,
    sleepImpl: async () => undefined,
  });

  assert.equal(result.started, true);
  assert.equal(result.snapshot?.backgroundWorkerPid, 5_151);
  assert.equal(
    killLog.calls.filter((call) => call.pid === 9_101 && call.signal === "SIGTERM").length,
    1,
  );
});

test("takeOverMiningRuntime clears only the current runtime, dedupes pids, and preempts before termination", async (t) => {
  const currentHomeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-takeover-current");
  const otherHomeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-takeover-other");
  const currentPaths = createRuntimePaths(currentHomeDirectory);
  const otherPaths = createRuntimePaths(otherHomeDirectory);
  const killLog = installProcessKillMock(t, {
    livePids: [9_201, 9_401],
  });
  const events: string[] = [];

  await writeJsonFile(currentPaths.miningControlLockPath, {
    processId: 9_201,
    acquiredAtUnixMs: 1,
    purpose: "mine-start",
    walletRootId: "wallet-a",
  });
  await writeJsonFile(join(currentPaths.miningRoot, "generation-request.json"), {
    schemaVersion: 1,
    requestId: "replace-1",
    requestedAtUnixMs: 1,
    reason: "test",
  });
  await writeJsonFile(join(currentPaths.miningRoot, "generation-activity.json"), {
    schemaVersion: 1,
    generationActive: true,
    generationOwnerPid: 9_202,
    runId: "run-old",
    generationStartedAtUnixMs: 1,
    generationEndedAtUnixMs: null,
    acknowledgedRequestId: null,
    updatedAtUnixMs: 1,
  });
  await saveMiningRuntimeStatus(
    currentPaths.miningStatusPath,
    createMiningRuntimeStatus({
      walletRootId: "wallet-a",
      runMode: "background",
      backgroundWorkerPid: 9_201,
      backgroundWorkerRunId: "run-old",
      backgroundWorkerHealth: "healthy",
      currentPhase: "generating",
    }),
  );

  await writeJsonFile(otherPaths.miningControlLockPath, {
    processId: 9_401,
    acquiredAtUnixMs: 1,
    purpose: "mine-foreground",
    walletRootId: "wallet-b",
  });
  await saveMiningRuntimeStatus(
    otherPaths.miningStatusPath,
    createMiningRuntimeStatus({
      walletRootId: "wallet-b",
      runMode: "background",
      backgroundWorkerPid: 9_401,
      backgroundWorkerRunId: "run-other",
      backgroundWorkerHealth: "healthy",
    }),
  );

  const result = await takeOverMiningRuntimeForTesting({
    paths: currentPaths,
    reason: "mine-start-replace",
    clearControlLockFile: true,
    requestMiningPreemption: async () => {
      events.push("preempt");
      return {
        requestId: "replace-preempt",
        async release() {
          events.push("release");
        },
      };
    },
    shutdownGraceMs: 1,
    sleepImpl: async () => undefined,
  });

  assert.equal(result.replaced, true);
  assert.deepEqual(events, ["preempt", "release"]);
  assert.deepEqual(killLog.timeline, ["SIGTERM:9201"]);
  assert.equal(
    killLog.calls.filter((call) => call.pid === 9_201 && call.signal === "SIGTERM").length,
    1,
  );
  assert.equal(
    killLog.calls.filter((call) => call.pid === 9_202 && call.signal === "SIGTERM").length,
    0,
  );
  assert.equal(
    killLog.calls.filter((call) => call.pid === 9_401 && call.signal === "SIGTERM").length,
    0,
  );
  assert.equal(await pathExists(currentPaths.miningControlLockPath), false);
  assert.equal(await pathExists(join(currentPaths.miningRoot, "generation-request.json")), false);
  assert.equal(await pathExists(join(currentPaths.miningRoot, "generation-activity.json")), false);
  const currentRuntime = await loadMiningRuntimeStatus(currentPaths.miningStatusPath);
  assert.equal(currentRuntime?.runMode, "stopped");
  assert.equal(currentRuntime?.backgroundWorkerPid, null);
  assert.equal(await pathExists(otherPaths.miningControlLockPath), true);
  const otherRuntime = await loadMiningRuntimeStatus(otherPaths.miningStatusPath);
  assert.equal(otherRuntime?.runMode, "background");
  assert.equal(otherRuntime?.backgroundWorkerPid, 9_401);
});

test("takeOverMiningRuntime uses SIGKILL only when SIGTERM does not stop the miner", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-runner-takeover-kill");
  const paths = createRuntimePaths(homeDirectory);
  const killLog = installProcessKillMock(t, {
    stubbornPids: [9_301],
  });

  await saveMiningRuntimeStatus(
    paths.miningStatusPath,
    createMiningRuntimeStatus({
      runMode: "background",
      backgroundWorkerPid: 9_301,
      backgroundWorkerRunId: "run-old",
      backgroundWorkerHealth: "healthy",
    }),
  );

  const result = await takeOverMiningRuntimeForTesting({
    paths,
    reason: "mine-start-replace",
    shutdownGraceMs: 1,
    sleepImpl: async () => undefined,
  });

  assert.equal(result.replaced, true);
  assert.deepEqual(killLog.timeline, ["SIGTERM:9301", "SIGKILL:9301"]);
  assert.equal(
    killLog.calls.filter((call) => call.pid === 9_301 && call.signal === "SIGKILL").length,
    1,
  );
});
