import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDefaultContext } from "../src/cli/context.js";
import { runMiningRuntimeCommand } from "../src/cli/commands/mining-runtime.js";
import { buildMineStartData } from "../src/cli/mining-json.js";
import {
  createMutationSuccessEnvelope,
  createPreviewSuccessEnvelope,
  describeCanonicalCommand,
  formatCliTextError,
  resolvePreviewJsonSchema,
  resolveStableMiningControlJsonSchema,
} from "../src/cli/output.js";
import { parseCliArgs } from "../src/cli/parse.js";
import { buildMineStartPreviewData } from "../src/cli/preview-json.js";
import { acquireFileLock } from "../src/wallet/fs/lock.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import { createMemoryWalletSecretProviderForTesting } from "../src/wallet/state/provider.js";
import { createMiningRuntimeStatus } from "./current-model-helpers.js";

function createStringWriter() {
  let text = "";

  return {
    stream: {
      isTTY: false,
      write(chunk: string) {
        text += chunk;
      },
    },
    read() {
      return text;
    },
  };
}

function parseJsonOutput(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

function assertStableJsonEnvelope(
  actualText: string,
  expected: unknown,
): void {
  const actual = parseJsonOutput(actualText);
  const expectedObject = structuredClone(expected) as Record<string, unknown>;
  assert.equal(typeof actual.generatedAtUnixMs, "number");
  delete actual.generatedAtUnixMs;
  delete expectedObject.generatedAtUnixMs;
  assert.deepEqual(actual, expectedObject);
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
  return (seedName: string | null = null) => resolveWalletRuntimePathsForTesting({
    platform: "linux",
    homeDirectory,
    seedName,
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

function createCompletedSyncClient(events: string[], onProgress?: (event: any) => void) {
  return {
    async syncToTip() {
      events.push("sync");
      onProgress?.({
        phase: "bitcoin_sync",
        progress: {
          message: "Bitcoin sync is catching up.",
          percent: 50,
          downloadedBytes: 0,
          totalBytes: 0,
          bytesPerSecond: null,
          etaSeconds: null,
          blocks: 10,
          headers: 20,
          targetHeight: 20,
        },
      });
      return {
        appliedBlocks: 4,
        rewoundBlocks: 0,
        endingHeight: 10,
        bestHeight: 10,
      };
    },
    async detachToBackgroundFollow() {
      events.push("detach");
    },
    async startFollowingTip() {},
    async getNodeStatus() {
      return {
        indexedTip: {
          height: 10,
          blockHashHex: "00".repeat(32),
          stateHashHex: null,
        },
        nodeBestHeight: 10,
      };
    },
    async close() {
      events.push("close-client");
    },
  };
}

test("mine text ensures provider setup, syncs managed services, then starts foreground mining", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = createPrompter();
  const resolvePaths = createTestRuntimePaths(await mkdtemp(join(tmpdir(), "cogcoin-mine-runtime-")));
  const runtimePaths = resolvePaths(null);
  const events: string[] = [];
  let runOptions: {
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
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: provider,
    createPrompter: () => prompter,
    resolveWalletRuntimePaths: (seedName) => resolvePaths(seedName),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => {
      events.push("setup");
      return true;
    },
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openSqliteStore: async () => {
      events.push("open-store");
      return {
        async close() {
          events.push("close-store");
        },
      } as any;
    },
    openManagedBitcoindClient: async () => {
      events.push("open-client");
      return createCompletedSyncClient(events) as any;
    },
    runForegroundMining: async (options) => {
      runOptions = {
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
  assert.match(stderr.read(), /Detached cleanly; background indexer follow resumed\./);
  assert.deepEqual(events, [
    "setup",
    "open-store",
    "open-client",
    "sync",
    "detach",
    "close-client",
    "run",
  ]);
  assert.notEqual(runOptions, null);
  const actualRunOptions = runOptions!;
  assert.equal(actualRunOptions.dataDir, "/tmp/bitcoind");
  assert.equal(actualRunOptions.databasePath, "/tmp/cogcoin.db");
  assert.equal(actualRunOptions.provider, provider);
  assert.equal(actualRunOptions.prompter, prompter);
  assert.equal(actualRunOptions.builtInSetupEnsured, true);
  assert.deepEqual(actualRunOptions.paths, runtimePaths);
});

test("mine start text ensures provider setup, syncs managed services, then starts background mining", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = createPrompter();
  const resolvePaths = createTestRuntimePaths(await mkdtemp(join(tmpdir(), "cogcoin-mine-start-runtime-")));
  const runtimePaths = resolvePaths(null);
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
    resolveWalletRuntimePaths: (seedName) => resolvePaths(seedName),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => {
      events.push("setup");
      return true;
    },
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openSqliteStore: async () => {
      events.push("open-store");
      return {
        async close() {
          events.push("close-store");
        },
      } as any;
    },
    openManagedBitcoindClient: async () => {
      events.push("open-client");
      return createCompletedSyncClient(events) as any;
    },
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
  assert.match(stderr.read(), /Detached cleanly; background indexer follow resumed\./);
  assert.deepEqual(events, [
    "setup",
    "open-store",
    "open-client",
    "sync",
    "detach",
    "close-client",
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

test("mine start JSON output stays on stdout while sync progress goes to stderr", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const provider = createMemoryWalletSecretProviderForTesting();
  const resolvePaths = createTestRuntimePaths(await mkdtemp(join(tmpdir(), "cogcoin-mine-start-json-")));
  const snapshot = createMiningRuntimeStatus({
    runMode: "background",
    backgroundWorkerPid: 5151,
    backgroundWorkerRunId: "run-json",
    backgroundWorkerHealth: "healthy",
  });
  const result = {
    started: true,
    snapshot,
  };
  const parsed = parseCliArgs(["mine", "start", "--output", "json"]);
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: provider,
    resolveWalletRuntimePaths: (seedName) => resolvePaths(seedName),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => true,
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openSqliteStore: async () => ({
      async close() {},
    }) as any,
    openManagedBitcoindClient: async (options) => createCompletedSyncClient([], options.onProgress) as any,
    startBackgroundMining: async () => result,
  });

  const exitCode = await runMiningRuntimeCommand(parsed, context);

  assert.equal(exitCode, 0);
  assert.match(stderr.read(), /Bitcoin sync is catching up\./);
  assert.match(stderr.read(), /Detached cleanly; background indexer follow resumed\./);
  assertStableJsonEnvelope(
    stdout.read(),
    createMutationSuccessEnvelope(
      resolveStableMiningControlJsonSchema(parsed)!,
      "cogcoin mine start",
      "started",
      buildMineStartData(result),
      {
        generatedAtUnixMs: 0,
      },
    ),
  );
});

test("mine start preview JSON output stays on stdout while sync progress goes to stderr", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const provider = createMemoryWalletSecretProviderForTesting();
  const resolvePaths = createTestRuntimePaths(await mkdtemp(join(tmpdir(), "cogcoin-mine-start-preview-")));
  const snapshot = createMiningRuntimeStatus({
    runMode: "background",
    backgroundWorkerPid: 6161,
    backgroundWorkerRunId: "run-preview",
    backgroundWorkerHealth: "healthy",
  });
  const result = {
    started: true,
    snapshot,
  };
  const parsed = parseCliArgs(["mine", "start", "--output", "preview-json"]);
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: provider,
    resolveWalletRuntimePaths: (seedName) => resolvePaths(seedName),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => true,
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openSqliteStore: async () => ({
      async close() {},
    }) as any,
    openManagedBitcoindClient: async (options) => createCompletedSyncClient([], options.onProgress) as any,
    startBackgroundMining: async () => result,
  });

  const exitCode = await runMiningRuntimeCommand(parsed, context);

  assert.equal(exitCode, 0);
  assert.match(stderr.read(), /Bitcoin sync is catching up\./);
  assert.match(stderr.read(), /Detached cleanly; background indexer follow resumed\./);
  assertStableJsonEnvelope(
    stdout.read(),
    createPreviewSuccessEnvelope(
      resolvePreviewJsonSchema(parsed)!,
      describeCanonicalCommand(parsed),
      "started",
      buildMineStartPreviewData(result),
      {
        generatedAtUnixMs: 0,
      },
    ),
  );
});

test("mine reports a handled error and skips foreground mining when sync preflight fails", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await mkdtemp(join(tmpdir(), "cogcoin-mine-preflight-fail-")));
  let runCalls = 0;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter,
    resolveWalletRuntimePaths: (seedName) => resolvePaths(seedName),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => true,
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openSqliteStore: async () => ({
      async close() {},
    }) as any,
    openManagedBitcoindClient: async () => ({
      async syncToTip() {
        throw new Error("managed_bitcoind_protocol_error");
      },
      async startFollowingTip() {},
      async getNodeStatus() {
        return {
          indexedTip: null,
          nodeBestHeight: null,
        };
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

test("mine start reports a handled error and skips background mining when sync preflight fails", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await mkdtemp(join(tmpdir(), "cogcoin-mine-start-preflight-fail-")));
  let startCalls = 0;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter,
    resolveWalletRuntimePaths: (seedName) => resolvePaths(seedName),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => true,
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openSqliteStore: async () => ({
      async close() {},
    }) as any,
    openManagedBitcoindClient: async () => ({
      async syncToTip() {
        throw new Error("indexer_daemon_protocol_error");
      },
      async startFollowingTip() {},
      async getNodeStatus() {
        return {
          indexedTip: null,
          nodeBestHeight: null,
        };
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

test("mine reports the existing wallet-control-lock error when sync preflight is busy", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await mkdtemp(join(tmpdir(), "cogcoin-mine-lock-busy-")));
  const runtimePaths = resolvePaths(null);
  const heldLock = await acquireFileLock(runtimePaths.walletControlLockPath, {
    purpose: "test-lock-holder",
    walletRootId: "wallet-root",
  });
  let runCalls = 0;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter,
    resolveWalletRuntimePaths: (seedName) => resolvePaths(seedName),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => true,
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    runForegroundMining: async () => {
      runCalls += 1;
    },
  });

  try {
    const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine"]), context);
    const expected = (formatCliTextError(new Error("wallet_control_lock_busy")) ?? []).join("\n");

    assert.notEqual(exitCode, 0);
    assert.equal(stdout.read(), "");
    assert.equal(runCalls, 0);
    assert.match(stderr.read(), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await heldLock.release();
  }
});

test("mine interrupt during sync preflight exits before foreground mining starts", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const signalSource = createSignalSource();
  const resolvePaths = createTestRuntimePaths(await mkdtemp(join(tmpdir(), "cogcoin-mine-interrupt-")));
  let runCalls = 0;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource,
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter,
    resolveWalletRuntimePaths: (seedName) => resolvePaths(seedName),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => true,
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openSqliteStore: async () => ({
      async close() {},
    }) as any,
    openManagedBitcoindClient: async () => ({
      async syncToTip() {
        queueMicrotask(() => {
          signalSource.emit("SIGINT");
        });
        return await new Promise<never>(() => undefined);
      },
      async startFollowingTip() {},
      async getNodeStatus() {
        return {
          indexedTip: null,
          nodeBestHeight: null,
        };
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
  assert.match(stderr.read(), /Detaching from managed Cogcoin client and resuming background indexer follow/);
  assert.match(stderr.read(), /Detached cleanly; background indexer follow resumed\./);
});
