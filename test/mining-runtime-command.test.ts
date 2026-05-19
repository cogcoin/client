import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createDefaultContext } from "../src/cli/context.js";
import { runMiningRuntimeCommand } from "../src/cli/commands/mining-runtime.js";
import { parseCliArgs } from "../src/cli/parse.js";
import { INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED } from "../src/bitcoind/indexer-daemon.js";
import {
  loadMiningRuntimeStatus,
  readMiningEvents,
  saveMiningRuntimeStatus,
} from "../src/wallet/mining/runtime-artifacts.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createMemoryWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { saveWalletState } from "../src/wallet/state/storage.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { createMiningRuntimeStatus, createWalletState } from "./current-model-helpers.js";
import {
  CURRENT_CLIENT_VERSION,
  NEWER_CLIENT_VERSION,
} from "./version-helpers.js";

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
    listenerCount(event: "SIGINT" | "SIGTERM") {
      return listeners[event].size;
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

function createPrompter(isInteractive = true) {
  return {
    isInteractive,
    writeLine() {},
    async prompt() {
      return "";
    },
    async promptHidden() {
      return "";
    },
  };
}

function createMineSetupPrompter(events: string[]) {
  const answers = new Map([
    ["Provider (openai/anthropic): ", "openai"],
    ["API key: ", "test-api-key"],
    ["Extra prompt (optional, blank for none): ", ""],
  ]);

  return {
    isInteractive: true,
    writeLine(message: string) {
      events.push(`line:${message}`);
    },
    async prompt(message: string) {
      events.push(`prompt:${message}`);
      const answer = answers.get(message);
      if (answer === undefined) {
        throw new Error(`unexpected_prompt:${message}`);
      }
      return answer;
    },
    async promptHidden() {
      return "";
    },
    async selectOption(options: { message: string }) {
      events.push(`select:${options.message}`);
      return "gpt-5.4-mini";
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

function createSequencedSyncMonitor(
  statuses: readonly any[],
  options: {
    onBeforeStatus?: (index: number) => void | Promise<void>;
    onClose?: () => void;
  } = {},
) {
  let index = 0;

  return {
    async getStatus() {
      await options.onBeforeStatus?.(index);
      const status = statuses[Math.min(index, statuses.length - 1)]!;
      index += 1;
      return status;
    },
    async close() {
      options.onClose?.();
    },
  };
}

test("mine text auto-runs provider setup, then syncs managed services and starts foreground mining", async (t) => {
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

test("mine preflight refreshes stale mining runtime status while waiting for the indexer", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-mine-runtime-preflight-refresh"));
  const runtimePaths = resolvePaths();
  const coreHash = "11".repeat(32);
  let runCalls = 0;
  let observedAfterFirstPoll: Awaited<ReturnType<typeof loadMiningRuntimeStatus>> = null;
  let nowUnixMs = 10_000;

  await saveMiningRuntimeStatus(
    runtimePaths.miningStatusPath,
    createMiningRuntimeStatus({
      walletRootId: "wallet-root",
      updatedAtUnixMs: 1_000,
      runMode: "foreground",
      currentPhase: "waiting-indexer",
      indexerDaemonState: "catching-up",
      currentDomainId: 7,
      currentDomainName: "samplemine",
      currentSentenceDisplay: "Synthetic preflight status preserves the prior mining sentence.",
      currentCanonicalBlend: "123456789",
      currentTxid: "aa".repeat(32),
      currentBlockFeeSpentSats: "1234",
      sessionFeeSpentSats: "1234",
      lifetimeFeeSpentSats: "1234",
      currentPublishDecision: "tx-confirmed-while-down",
      note: "Mining is waiting for Bitcoin Core and the indexer to align.",
    }),
  );

  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {
      ...process.env,
      COGCOIN_DISABLE_UPDATE_CHECK: "1",
    },
    now: () => {
      nowUnixMs += 1;
      return nowUnixMs;
    },
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter,
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => true,
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openManagedIndexerMonitor: async () => createSequencedSyncMonitor(
      [
        createObservedIndexerStatus({
          state: "catching-up",
          coreBestHeight: 20,
          coreBestHash: coreHash,
          appliedTipHeight: 19,
          appliedTipHash: "22".repeat(32),
          snapshotSeq: "2",
          backlogBlocks: 1,
          cogcoinSyncHeight: 19,
          cogcoinSyncTargetHeight: 20,
        }),
        createObservedIndexerStatus({
          state: "synced",
          coreBestHeight: 20,
          coreBestHash: coreHash,
          appliedTipHeight: 20,
          appliedTipHash: coreHash,
          snapshotSeq: "3",
          backlogBlocks: 0,
          cogcoinSyncHeight: 20,
          cogcoinSyncTargetHeight: 20,
        }),
      ],
      {
        onBeforeStatus: async (index) => {
          if (index === 1) {
            observedAfterFirstPoll = await loadMiningRuntimeStatus(runtimePaths.miningStatusPath);
          }
        },
      },
    ) as any,
    runForegroundMining: async () => {
      runCalls += 1;
    },
  });

  const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine", "--progress", "none"]), context);

  assert.equal(exitCode, 0);
  assert.equal(stdout.read(), "");
  assert.equal(runCalls, 1);
  const intermediateStatus: Awaited<ReturnType<typeof loadMiningRuntimeStatus>> = observedAfterFirstPoll;
  assert.notEqual(intermediateStatus, null);
  assert.equal(intermediateStatus!.runMode, "foreground");
  assert.equal(intermediateStatus!.indexerDaemonState, "catching-up");
  assert.equal(intermediateStatus!.indexerHealth, "catching-up");
  assert.equal(intermediateStatus!.currentPhase, "waiting-indexer");
  assert.equal(intermediateStatus!.coreBestHeight, 20);
  assert.equal(intermediateStatus!.indexerTipHeight, null);
  assert.equal(intermediateStatus!.indexerStatusTipHeight, 19);
  assert.equal(intermediateStatus!.tipsAligned, false);
  assert.equal(intermediateStatus!.currentTxid, "aa".repeat(32));
  assert.equal(intermediateStatus!.currentBlockFeeSpentSats, "1234");

  const finalStatus = await loadMiningRuntimeStatus(runtimePaths.miningStatusPath);
  assert.equal(finalStatus?.runMode, "foreground");
  assert.equal(finalStatus?.indexerDaemonState, "synced");
  assert.equal(finalStatus?.indexerHealth, "synced");
  assert.equal(finalStatus?.currentPhase, "waiting");
  assert.equal(finalStatus?.coreBestHeight, 20);
  assert.equal(finalStatus?.indexerTipHeight, null);
  assert.equal(finalStatus?.indexerStatusTipHeight, 20);
  assert.equal(finalStatus?.tipsAligned, true);
  assert.equal(finalStatus?.targetBlockHeight, 21);
  assert.equal(finalStatus?.referencedBlockHashDisplay, coreHash);
  assert.equal(finalStatus?.lastError, null);
  assert.equal(finalStatus?.note, "Mining preflight completed; starting foreground mining.");
  assert.equal(finalStatus?.currentDomainName, "samplemine");
  assert.equal(finalStatus?.currentSentenceDisplay, "Synthetic preflight status preserves the prior mining sentence.");
  assert.equal(finalStatus?.currentPublishDecision, "tx-confirmed-while-down");
  assert.equal(stderr.read(), "");
});

test("mine uses the real setup gate before preflight when provider config is absent", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const provider = createMemoryWalletSecretProviderForTesting();
  const version = "7.8.9";
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-mine-runtime-real-setup"));
  const runtimePaths = resolvePaths();
  const secretReference = createWalletSecretReference("wallet-root");
  const events: string[] = [];
  let expectedBinaryVersion: string | null = null;
  let runCalls = 0;

  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 7));
  await saveWalletState({
    primaryPath: runtimePaths.walletStatePath,
    backupPath: runtimePaths.walletStateBackupPath,
  }, createWalletState(), {
    provider,
    secretReference,
  });

  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {
      ...process.env,
      COGCOIN_DISABLE_UPDATE_CHECK: "1",
    },
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: provider,
    createPrompter: () => createMineSetupPrompter(events),
    readPackageVersion: async () => version,
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openManagedIndexerMonitor: async (options) => {
      expectedBinaryVersion = options.expectedBinaryVersion ?? null;
      events.push("status");
      return createCompletedSyncMonitor(events) as any;
    },
    runForegroundMining: async (options) => {
      runCalls += 1;
      assert.equal(options.builtInSetupEnsured, true);
      events.push("run");
    },
  });

  const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine"]), context);

  assert.equal(exitCode, 0);
  assert.equal(stdout.read(), "");
  assert.equal(expectedBinaryVersion, version);
  assert.equal(runCalls, 1);
  assert.deepEqual(events.filter((event) => !event.startsWith("line:")), [
    "prompt:Provider (openai/anthropic): ",
    "select:Choose the mining model:",
    "prompt:API key: ",
    "prompt:Extra prompt (optional, blank for none): ",
    "status",
    "status",
    "close-monitor",
    "run",
  ]);
});

test("mine stops before preflight when auto-setup is canceled", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-mine-setup-canceled"));
  let monitorCalls = 0;
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
    ensureBuiltInMiningSetupIfNeeded: async () => {
      throw new Error("mining_setup_canceled");
    },
    openManagedIndexerMonitor: async () => {
      monitorCalls += 1;
      return createCompletedSyncMonitor([]) as any;
    },
    runForegroundMining: async () => {
      runCalls += 1;
    },
  });

  const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine"]), context);

  assert.notEqual(exitCode, 0);
  assert.equal(stdout.read(), "");
  assert.equal(monitorCalls, 0);
  assert.equal(runCalls, 0);
  assert.match(stderr.read(), /Mining setup was canceled\./);
});

test("mine stops before preflight when auto-setup validation fails", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-mine-setup-invalid"));
  let monitorCalls = 0;
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
    ensureBuiltInMiningSetupIfNeeded: async () => {
      throw new Error("mining_setup_missing_api_key");
    },
    openManagedIndexerMonitor: async () => {
      monitorCalls += 1;
      return createCompletedSyncMonitor([]) as any;
    },
    runForegroundMining: async () => {
      runCalls += 1;
    },
  });

  const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine"]), context);

  assert.notEqual(exitCode, 0);
  assert.equal(stdout.read(), "");
  assert.equal(monitorCalls, 0);
  assert.equal(runCalls, 0);
  assert.match(stderr.read(), /Mining provider API key is required\./);
});

test("mine with missing config in a non-interactive terminal fails before preflight", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-mine-setup-noninteractive"));
  let monitorCalls = 0;
  let runCalls = 0;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter: () => createPrompter(false),
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => false,
    openManagedIndexerMonitor: async () => {
      monitorCalls += 1;
      return createCompletedSyncMonitor([]) as any;
    },
    runForegroundMining: async () => {
      runCalls += 1;
    },
  });

  const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine"]), context);

  assert.notEqual(exitCode, 0);
  assert.equal(stdout.read(), "");
  assert.equal(monitorCalls, 0);
  assert.equal(runCalls, 0);
  assert.match(stderr.read(), /Interactive terminal input is required\./);
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
    readPackageVersion: async () => CURRENT_CLIENT_VERSION,
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    resolveUpdateCheckStatePath: () => cachePath,
    ensureBuiltInMiningSetupIfNeeded: async () => true,
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openManagedIndexerMonitor: async () => createCompletedSyncMonitor([]) as any,
    fetchImpl: async () => new Response(JSON.stringify({
      version: NEWER_CLIENT_VERSION,
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
  assert.equal(actualRunOptions.clientVersion, CURRENT_CLIENT_VERSION);
  assert.equal(actualRunOptions.updateAvailable, true);
  assert.deepEqual(actualRunOptions.paths, runtimePaths);
  assert.match(
    await readFile(cachePath, "utf8"),
    new RegExp(`"latestVersion": "${NEWER_CLIENT_VERSION.replaceAll(".", "\\.")}"`),
  );
});

test("mine reports a handled error and skips foreground mining when sync preflight fails", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-mine-preflight-fail"));
  const runtimePaths = resolvePaths();
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
  const runtimeStatus = await loadMiningRuntimeStatus(runtimePaths.miningStatusPath);
  assert.equal(runtimeStatus?.runMode, "stopped");
  assert.equal(runtimeStatus?.currentPhase, "waiting-indexer");
  assert.equal(runtimeStatus?.indexerHealth, "failed");
  assert.equal(runtimeStatus?.lastError, "managed_bitcoind_protocol_error");
  const events = await readMiningEvents({
    eventsPath: runtimePaths.miningEventsPath,
    all: true,
  });
  const runtimeError = events.find((event) => event.kind === "runtime-error") ?? null;
  assert.equal(runtimeError?.message, "Mining preflight stopped because managed indexer readiness failed: managed_bitcoind_protocol_error");
});

test("mine rejects an outdated live indexer daemon before auto-replacing it", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-mine-outdated-indexer"));
  const runtimePaths = resolvePaths();
  const events: string[] = [];
  let runCalls = 0;
  let monitorCalls = 0;

  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {
      ...process.env,
      COGCOIN_DISABLE_UPDATE_CHECK: "1",
    },
    now: () => 234_567,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter,
    readPackageVersion: async () => CURRENT_CLIENT_VERSION,
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => true,
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    probeIndexerDaemon: async () => ({
      compatibility: "compatible",
      status: createObservedIndexerStatus({
        binaryVersion: "1.2.9",
      }),
      client: {
        async close() {
          events.push("close-probe");
        },
      } as any,
      error: null,
    }),
    openManagedIndexerMonitor: async () => {
      monitorCalls += 1;
      throw new Error("monitor_should_not_open");
    },
    runForegroundMining: async () => {
      runCalls += 1;
    },
  });

  const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine", "--progress", "none"]), context);

  assert.notEqual(exitCode, 0);
  assert.equal(stdout.read(), "");
  assert.equal(runCalls, 0);
  assert.equal(monitorCalls, 0);
  assert.deepEqual(events, ["close-probe"]);
  const stderrText = stderr.read();
  assert.match(stderrText, /live managed indexer daemon is older than this CLI/i);
  assert.match(stderrText, /Next: Run `cogcoin repair` to update the managed indexer daemon, then rerun `cogcoin mine`\./);

  const runtimeStatus = await loadMiningRuntimeStatus(runtimePaths.miningStatusPath);
  assert.equal(runtimeStatus?.updatedAtUnixMs, 234_567);
  assert.equal(runtimeStatus?.runMode, "stopped");
  assert.equal(runtimeStatus?.currentPhase, "waiting-indexer");
  assert.equal(runtimeStatus?.indexerDaemonState, "failed");
  assert.equal(runtimeStatus?.indexerHealth, "failed");
  assert.equal(runtimeStatus?.lastError, "indexer_daemon_binary_outdated");

  const miningEvents = await readMiningEvents({
    eventsPath: runtimePaths.miningEventsPath,
    all: true,
  });
  const runtimeError = miningEvents.find((event) => event.kind === "runtime-error") ?? null;
  assert.equal(runtimeError?.level, "error");
  assert.equal(runtimeError?.message, "Mining preflight stopped because managed indexer readiness failed: indexer_daemon_binary_outdated");
  assert.equal(runtimeError?.timestampUnixMs, 234_567);
  assert.equal(runtimeError?.reason, "indexer_daemon_binary_outdated");
});

test("mine preflight records background-follow recovery failures before surfacing the error", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-mine-preflight-background-follow-fail"));
  const runtimePaths = resolvePaths();
  let runCalls = 0;

  await saveMiningRuntimeStatus(
    runtimePaths.miningStatusPath,
    createMiningRuntimeStatus({
      walletRootId: "wallet-root",
      runMode: "foreground",
      currentPhase: "waiting-indexer",
      currentDomainName: "samplemine",
      currentTxid: "bb".repeat(32),
    }),
  );

  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {
      ...process.env,
      COGCOIN_DISABLE_UPDATE_CHECK: "1",
    },
    now: () => 123_456,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter,
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureBuiltInMiningSetupIfNeeded: async () => true,
    loadRawWalletStateEnvelope: async () => createWalletRootEnvelope(),
    openManagedIndexerMonitor: async () => {
      throw new Error(INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED);
    },
    runForegroundMining: async () => {
      runCalls += 1;
    },
  });

  const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine", "--progress", "none"]), context);

  assert.notEqual(exitCode, 0);
  assert.equal(stdout.read(), "");
  assert.equal(runCalls, 0);
  assert.match(stderr.read(), /managed indexer daemon could not recover automatic background follow/i);
  const runtimeStatus = await loadMiningRuntimeStatus(runtimePaths.miningStatusPath);
  assert.equal(runtimeStatus?.updatedAtUnixMs, 123_456);
  assert.equal(runtimeStatus?.runMode, "stopped");
  assert.equal(runtimeStatus?.currentPhase, "waiting-indexer");
  assert.equal(runtimeStatus?.indexerDaemonState, "failed");
  assert.equal(runtimeStatus?.indexerHealth, "failed");
  assert.equal(runtimeStatus?.lastError, INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED);
  assert.match(runtimeStatus?.note ?? "", /background follow could not recover/);
  assert.equal(runtimeStatus?.currentDomainName, "samplemine");
  assert.equal(runtimeStatus?.currentTxid, "bb".repeat(32));

  const events = await readMiningEvents({
    eventsPath: runtimePaths.miningEventsPath,
    all: true,
  });
  const runtimeError = events.find((event) => event.kind === "runtime-error") ?? null;
  assert.equal(runtimeError?.level, "error");
  assert.equal(runtimeError?.message, "Mining preflight stopped because the managed indexer background follow could not recover.");
  assert.equal(runtimeError?.timestampUnixMs, 123_456);
  assert.equal(runtimeError?.reason, INDEXER_DAEMON_BACKGROUND_FOLLOW_RECOVERY_FAILED);
  assert.equal(runtimeError?.txid, "bb".repeat(32));
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

test("mine runtime handoff keeps only one runtime stop listener on the CLI signal source", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const signalSource = createSignalSource();
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-mine-runtime-handoff"));
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
    openManagedIndexerMonitor: async () => createCompletedSyncMonitor([]) as any,
    runForegroundMining: async (options) => {
      runCalls += 1;
      assert.equal(signalSource.listenerCount("SIGINT"), 1);
      assert.equal(signalSource.listenerCount("SIGTERM"), 1);
      signalSource.emit("SIGINT");
      assert.equal(options.signal?.aborted, true);
    },
  });

  const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine"]), context);

  assert.equal(exitCode, 0);
  assert.equal(runCalls, 1);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});
