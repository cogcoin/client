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
  resolvePreviewJsonSchema,
  resolveStableMiningControlJsonSchema,
} from "../src/cli/output.js";
import { parseCliArgs } from "../src/cli/parse.js";
import { buildMineStartPreviewData } from "../src/cli/preview-json.js";
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

test("mine text prestarts managed services before foreground mining", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = createPrompter();
  const resolvePaths = createTestRuntimePaths(await mkdtemp(join(tmpdir(), "cogcoin-mine-runtime-")));
  const runtimePaths = resolvePaths(null);
  const events: string[] = [];
  let openOptions: Record<string, unknown> | null = null;
  let runOptions: {
    dataDir: string;
    databasePath: string;
    provider: unknown;
    prompter: unknown;
    paths: unknown;
  } | null = null;
  let closeCalls = 0;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: provider,
    createPrompter: () => prompter,
    resolveWalletRuntimePaths: (seedName) => resolvePaths(seedName),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureDirectory: async () => undefined,
    openWalletReadContext: async (options) => {
      openOptions = options as Record<string, unknown>;
      events.push("open");
      return {
        async close() {
          closeCalls += 1;
          events.push("close");
        },
      } as any;
    },
    runForegroundMining: async (options) => {
      runOptions = {
        dataDir: options.dataDir,
        databasePath: options.databasePath,
        provider: options.provider,
        prompter: options.prompter,
        paths: options.paths,
      };
      events.push("run");
    },
  });

  const exitCode = await runMiningRuntimeCommand(parseCliArgs(["mine"]), context);

  assert.equal(exitCode, 0);
  assert.equal(stdout.read(), "");
  assert.equal(stderr.read(), "");
  assert.deepEqual(events, ["open", "close", "run"]);
  assert.equal(closeCalls, 1);
  assert.notEqual(runOptions, null);
  const actualRunOptions = runOptions!;
  assert.deepEqual(openOptions, {
    dataDir: "/tmp/bitcoind",
    databasePath: "/tmp/cogcoin.db",
    secretProvider: provider,
    paths: runtimePaths,
  });
  assert.equal(actualRunOptions.dataDir, "/tmp/bitcoind");
  assert.equal(actualRunOptions.databasePath, "/tmp/cogcoin.db");
  assert.equal(actualRunOptions.provider, provider);
  assert.equal(actualRunOptions.prompter, prompter);
  assert.deepEqual(actualRunOptions.paths, runtimePaths);
});

test("mine start text prestarts managed services before starting background mining", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = createPrompter();
  const resolvePaths = createTestRuntimePaths(await mkdtemp(join(tmpdir(), "cogcoin-mine-start-runtime-")));
  const runtimePaths = resolvePaths(null);
  const events: string[] = [];
  let openOptions: Record<string, unknown> | null = null;
  let startOptions: {
    dataDir: string;
    databasePath: string;
    provider: unknown;
    prompter: unknown;
    paths: unknown;
  } | null = null;
  let closeCalls = 0;
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
    ensureDirectory: async () => undefined,
    openWalletReadContext: async (options) => {
      openOptions = options as Record<string, unknown>;
      events.push("open");
      return {
        async close() {
          closeCalls += 1;
          events.push("close");
        },
      } as any;
    },
    startBackgroundMining: async (options) => {
      startOptions = {
        dataDir: options.dataDir,
        databasePath: options.databasePath,
        provider: options.provider,
        prompter: options.prompter,
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
  assert.equal(stderr.read(), "");
  assert.equal(stdout.read(), "Started background mining.\nWorker pid: 4242\n");
  assert.deepEqual(events, ["open", "close", "start"]);
  assert.equal(closeCalls, 1);
  assert.notEqual(startOptions, null);
  const actualStartOptions = startOptions!;
  assert.deepEqual(openOptions, {
    dataDir: "/tmp/bitcoind",
    databasePath: "/tmp/cogcoin.db",
    secretProvider: provider,
    paths: runtimePaths,
  });
  assert.equal(actualStartOptions.dataDir, "/tmp/bitcoind");
  assert.equal(actualStartOptions.databasePath, "/tmp/cogcoin.db");
  assert.equal(actualStartOptions.provider, provider);
  assert.equal(actualStartOptions.prompter, prompter);
  assert.deepEqual(actualStartOptions.paths, runtimePaths);
});

test("mine start JSON output is unchanged after the managed-service preflight", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const provider = createMemoryWalletSecretProviderForTesting();
  const resolvePaths = createTestRuntimePaths(await mkdtemp(join(tmpdir(), "cogcoin-mine-start-json-")));
  let closeCalls = 0;
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
    createPrompter,
    resolveWalletRuntimePaths: (seedName) => resolvePaths(seedName),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureDirectory: async () => undefined,
    openWalletReadContext: async () => ({
      async close() {
        closeCalls += 1;
      },
    }) as any,
    startBackgroundMining: async () => result,
  });

  const exitCode = await runMiningRuntimeCommand(parsed, context);

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.equal(closeCalls, 1);
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

test("mine start preview JSON output is unchanged after the managed-service preflight", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const provider = createMemoryWalletSecretProviderForTesting();
  const resolvePaths = createTestRuntimePaths(await mkdtemp(join(tmpdir(), "cogcoin-mine-start-preview-")));
  let closeCalls = 0;
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
    createPrompter,
    resolveWalletRuntimePaths: (seedName) => resolvePaths(seedName),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureDirectory: async () => undefined,
    openWalletReadContext: async () => ({
      async close() {
        closeCalls += 1;
      },
    }) as any,
    startBackgroundMining: async () => result,
  });

  const exitCode = await runMiningRuntimeCommand(parsed, context);

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.equal(closeCalls, 1);
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

test("mine reports a handled error and skips foreground mining when the preflight fails", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  let runCalls = 0;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter,
    resolveWalletRuntimePaths: () => resolveWalletRuntimePathsForTesting({ platform: "linux" }),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureDirectory: async () => undefined,
    openWalletReadContext: async () => {
      throw new Error("managed_bitcoind_protocol_error");
    },
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

test("mine start reports a handled error and skips background mining when the preflight fails", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  let startCalls = 0;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter,
    resolveWalletRuntimePaths: () => resolveWalletRuntimePathsForTesting({ platform: "linux" }),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureDirectory: async () => undefined,
    openWalletReadContext: async () => {
      throw new Error("indexer_daemon_protocol_error");
    },
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
