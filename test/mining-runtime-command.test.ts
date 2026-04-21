import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createDefaultContext } from "../src/cli/context.js";
import { runMiningRuntimeCommand } from "../src/cli/commands/mining-runtime.js";
import { parseCliArgs } from "../src/cli/parse.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import { createMemoryWalletSecretProviderForTesting } from "../src/wallet/state/provider.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { createMiningRuntimeStatus } from "./current-model-helpers.js";

function createStringWriter(options: { isTTY?: boolean; columns?: number } = {}) {
  let text = "";

  return {
    stream: {
      isTTY: options.isTTY ?? false,
      columns: options.columns,
      write(chunk: string) {
        text += chunk;
      },
    },
    read() {
      return text;
    },
  };
}

const QUIET_SIGNAL_SOURCE = {
  on() {},
  off() {},
};

function createSignalSource() {
  const listeners = {
    SIGINT: new Set<() => void>(),
    SIGTERM: new Set<() => void>(),
  };

  return {
    on(event: "SIGINT" | "SIGTERM", listener: () => void) {
      listeners[event].add(listener);
    },
    off(event: "SIGINT" | "SIGTERM", listener: () => void) {
      listeners[event].delete(listener);
    },
    emit(event: "SIGINT" | "SIGTERM") {
      for (const listener of [...listeners[event]]) {
        listener();
      }
    },
  };
}

function createTestRuntimePaths(homeDirectory: string) {
  return () => resolveWalletRuntimePathsForTesting({
    platform: "linux",
    homeDirectory,
    env: {
      ...process.env,
      XDG_DATA_HOME: join(homeDirectory, "data-home"),
      XDG_CONFIG_HOME: join(homeDirectory, "config-home"),
      XDG_STATE_HOME: join(homeDirectory, "state-home"),
      XDG_RUNTIME_DIR: join(homeDirectory, "runtime-home"),
    },
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

function createWalletRootEnvelope(walletRootId = "wallet-root") {
  return {
    envelope: {
      walletRootIdHint: walletRootId,
    },
  } as any;
}

function createObservedIndexerStatus(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    serviceApiVersion: "cogcoin/indexer-ipc/v1",
    binaryVersion: "0.0.0-test",
    buildId: null,
    updatedAtUnixMs: Date.now(),
    walletRootId: "wallet-root",
    daemonInstanceId: "daemon-1",
    schemaVersion: "cogcoin/indexer-db/v1",
    state: "synced",
    processId: 1234,
    startedAtUnixMs: Date.now(),
    heartbeatAtUnixMs: Date.now(),
    ipcReady: true,
    rpcReachable: true,
    coreBestHeight: 10,
    coreBestHash: "00".repeat(32),
    appliedTipHeight: 10,
    appliedTipHash: "00".repeat(32),
    snapshotSeq: "1",
    backlogBlocks: 0,
    reorgDepth: null,
    lastAppliedAtUnixMs: Date.now(),
    activeSnapshotCount: 0,
    lastError: null,
    backgroundFollowActive: true,
    bootstrapPhase: "bitcoin_sync",
    bootstrapProgress: {
      phase: "bitcoin_sync",
      message: "Bitcoin sync is catching up.",
      resumed: false,
      downloadedBytes: 0,
      totalBytes: 0,
      percent: 50,
      bytesPerSecond: null,
      etaSeconds: null,
      headers: 20,
      blocks: 10,
      targetHeight: 20,
      baseHeight: null,
      tipHashHex: null,
      lastError: null,
      updatedAt: Date.now(),
    },
    cogcoinSyncHeight: 10,
    cogcoinSyncTargetHeight: 10,
    ...overrides,
  } as any;
}

function createCompletedSyncMonitor(events: string[]) {
  return {
    async getStatus() {
      events.push("status");
      return createObservedIndexerStatus();
    },
    async close() {
      events.push("close-monitor");
    },
  };
}

test("mine text ensures provider setup, syncs managed services, then starts foreground mining", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = createPrompter();
  const version = "7.8.9";
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-mine-runtime"));
  const runtimePaths = resolvePaths();
  const events: string[] = [];
  let expectedBinaryVersion: string | null = null;
  let runOptions: {
    clientVersion: string | null | undefined;
    updateAvailable: boolean | undefined;
    dataDir: string;
    databasePath: string;
    provider: unknown;
    prompter: unknown;
    builtInSetupEnsured: boolean | undefined;
    paths: unknown;
  } | null = null;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {
      ...process.env,
      COGCOIN_DISABLE_UPDATE_CHECK: "1",
    },
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: provider,
    createPrompter: () => prompter,
    readPackageVersion: async () => version,
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => {
      events.push("setup");
      return true;
    },
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openManagedIndexerMonitor: async (options) => {
      expectedBinaryVersion = options.expectedBinaryVersion ?? null;
      return createCompletedSyncMonitor(events) as any;
    },
    runForegroundMining: async (options) => {
      runOptions = {
        clientVersion: options.clientVersion,
        updateAvailable: options.updateAvailable,
        dataDir: options.dataDir,
        databasePath: options.databasePath,
        provider: options.provider,
        prompter: options.prompter,
        builtInSetupEnsured: options.builtInSetupEnsured,
        paths: options.paths,
      };
      events.push("run");
    },
  });

  const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine"]), context);

  assert.equal(exitCode, 0);
  assert.equal(stdout.read(), "");
  assert.match(stderr.read(), /Bitcoin sync is catching up\./);
  assert.deepEqual(events, [
    "setup",
    "status",
    "close-monitor",
    "run",
  ]);
  assert.notEqual(runOptions, null);
  assert.equal(expectedBinaryVersion, version);
  const actualRunOptions = runOptions!;
  assert.equal(actualRunOptions.clientVersion, version);
  assert.equal(actualRunOptions.updateAvailable, false);
  assert.equal(actualRunOptions.dataDir, "/tmp/bitcoind");
  assert.equal(actualRunOptions.databasePath, "/tmp/cogcoin.db");
  assert.equal(actualRunOptions.provider, provider);
  assert.equal(actualRunOptions.prompter, prompter);
  assert.equal(actualRunOptions.builtInSetupEnsured, true);
  assert.deepEqual(actualRunOptions.paths, runtimePaths);
});

test("mine tty shows the mining visualizer during preflight and reuses it for foreground mining", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter({ isTTY: true, columns: 120 });
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = createPrompter();
  const version = "7.8.9";
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-mine-runtime-tty"));
  const events: string[] = [];
  let receivedVisualizer: unknown = null;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {
      ...process.env,
      COGCOIN_DISABLE_UPDATE_CHECK: "1",
    },
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: provider,
    createPrompter: () => prompter,
    readPackageVersion: async () => version,
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => {
      events.push("setup");
      return true;
    },
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openManagedIndexerMonitor: async () => ({
      async getStatus() {
        events.push("status");
        return createObservedIndexerStatus();
      },
      async close() {
        events.push("close-monitor");
      },
    }) as any,
    runForegroundMining: async (options) => {
      receivedVisualizer = options.visualizer ?? null;
      events.push("run");
    },
  });

  const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine"]), context);

  assert.equal(exitCode, 0);
  assert.equal(stdout.read(), "");
  assert.deepEqual(events, [
    "setup",
    "status",
    "close-monitor",
    "run",
  ]);
  assert.notEqual(receivedVisualizer, null);
  assert.doesNotMatch(stderr.read(), /Bitcoin sync is catching up\./);
  assert.match(stderr.read(), /✎ Block #----- Sentences ✎/);
});

test("mine text marks updateAvailable when tty mining sees a newer npm version", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter({ isTTY: true, columns: 120 });
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = createPrompter();
  const version = "1.1.6";
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mine-runtime-update");
  const resolvePaths = createTestRuntimePaths(homeDirectory);
  const runtimePaths = resolvePaths();
  const cachePath = join(homeDirectory, "update-check.json");
  let runOptions: {
    clientVersion: string | null | undefined;
    updateAvailable: boolean | undefined;
    paths: unknown;
  } | null = null;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: provider,
    createPrompter: () => prompter,
    readPackageVersion: async () => version,
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    resolveUpdateCheckStatePath: () => cachePath,
    ensureBuiltInMiningSetupIfNeeded: async () => true,
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openManagedIndexerMonitor: async () => createCompletedSyncMonitor([]) as any,
    fetchImpl: async () => new Response(JSON.stringify({
      version: "1.1.7",
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    }),
    runForegroundMining: async (options) => {
      runOptions = {
        clientVersion: options.clientVersion,
        updateAvailable: options.updateAvailable,
        paths: options.paths,
      };
    },
  });

  const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine"]), context);

  assert.equal(exitCode, 0);
  assert.notEqual(runOptions, null);
  const actualRunOptions = runOptions!;
  assert.equal(actualRunOptions.clientVersion, version);
  assert.equal(actualRunOptions.updateAvailable, true);
  assert.deepEqual(actualRunOptions.paths, runtimePaths);
  assert.match(
    await readFile(cachePath, "utf8"),
    /"latestVersion": "1.1.7"/,
  );
});

test("mine start text ensures provider setup, syncs managed services, then starts background mining", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = createPrompter();
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-mine-start-runtime"));
  const runtimePaths = resolvePaths();
  const events: string[] = [];
  let startOptions: {
    dataDir: string;
    databasePath: string;
    provider: unknown;
    builtInSetupEnsured: boolean | undefined;
    paths: unknown;
  } | null = null;
  const snapshot = createMiningRuntimeStatus({
    runMode: "background",
    backgroundWorkerPid: 4242,
    backgroundWorkerRunId: "run-1",
    backgroundWorkerHealth: "healthy",
  });
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: provider,
    createPrompter: () => prompter,
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => {
      events.push("setup");
      return true;
    },
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openManagedIndexerMonitor: async () => createCompletedSyncMonitor(events) as any,
    startBackgroundMining: async (options) => {
      startOptions = {
        dataDir: options.dataDir,
        databasePath: options.databasePath,
        provider: options.provider,
        builtInSetupEnsured: options.builtInSetupEnsured,
        paths: options.paths,
      };
      events.push("start");
      return {
        started: true,
        snapshot,
      };
    },
  });

  const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine", "start"]), context);

  assert.equal(exitCode, 0);
  assert.equal(stdout.read(), "Started background mining.\nWorker pid: 4242\n");
  assert.match(stderr.read(), /Bitcoin sync is catching up\./);
  assert.deepEqual(events, [
    "setup",
    "status",
    "close-monitor",
    "start",
  ]);
  assert.notEqual(startOptions, null);
  const actualStartOptions = startOptions!;
  assert.equal(actualStartOptions.dataDir, "/tmp/bitcoind");
  assert.equal(actualStartOptions.databasePath, "/tmp/cogcoin.db");
  assert.equal(actualStartOptions.provider, provider);
  assert.equal(actualStartOptions.builtInSetupEnsured, true);
  assert.deepEqual(actualStartOptions.paths, runtimePaths);
});

test("mine reports a handled error and skips foreground mining when sync preflight fails", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-mine-preflight-fail"));
  let runCalls = 0;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter,
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => true,
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openManagedIndexerMonitor: async () => ({
      async getStatus() {
        throw new Error("managed_bitcoind_protocol_error");
      },
      async close() {},
    }) as any,
    runForegroundMining: async () => {
      runCalls += 1;
    },
  });

  const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine"]), context);

  assert.notEqual(exitCode, 0);
  assert.equal(stdout.read(), "");
  assert.equal(runCalls, 0);
  assert.ok(stderr.read().length > 0);
});

test("mine start reports a handled error and skips background mining when sync preflight fails", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(
    await createTrackedTempDirectory(t, "cogcoin-mine-start-preflight-fail"),
  );
  let startCalls = 0;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter,
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => true,
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openManagedIndexerMonitor: async () => ({
      async getStatus() {
        throw new Error("indexer_daemon_protocol_error");
      },
      async close() {},
    }) as any,
    startBackgroundMining: async () => {
      startCalls += 1;
      return {
        started: true,
        snapshot: null,
      };
    },
  });

  const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine", "start"]), context);

  assert.notEqual(exitCode, 0);
  assert.equal(stdout.read(), "");
  assert.equal(startCalls, 0);
  assert.ok(stderr.read().length > 0);
});

test("mine preflight uses the managed indexer monitor instead of the foreground managed client", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-mine-monitor-only"));
  let runCalls = 0;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter,
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => true,
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openManagedBitcoindClient: async () => {
      throw new Error("foreground_writer_should_not_open");
    },
    openManagedIndexerMonitor: async () => createCompletedSyncMonitor([]) as any,
    runForegroundMining: async () => {
      runCalls += 1;
    },
  });

  const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine"]), context);

  assert.equal(exitCode, 0);
  assert.equal(stdout.read(), "");
  assert.equal(runCalls, 1);
});

test("mine interrupt during sync preflight exits before foreground mining starts", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const signalSource = createSignalSource();
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-mine-interrupt"));
  let runCalls = 0;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource,
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter,
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => true,
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openManagedIndexerMonitor: async () => ({
      async getStatus() {
        queueMicrotask(() => {
          signalSource.emit("SIGINT");
        });
        return await new Promise<never>(() => undefined);
      },
      async close() {},
    }) as any,
    runForegroundMining: async () => {
      runCalls += 1;
    },
  });

  const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine"]), context);

  assert.equal(exitCode, 0);
  assert.equal(stdout.read(), "");
  assert.equal(runCalls, 0);
  assert.match(stderr.read(), /Stopping managed mining readiness observation/);
  assert.match(stderr.read(), /Stopped observing managed mining readiness\./);
});
