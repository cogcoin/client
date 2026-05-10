import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createDefaultContext } from "../src/cli/context.js";
import { runStatusCommand } from "../src/cli/commands/status.js";
import { parseCliArgs } from "../src/cli/parse.js";
import { formatStatusReport } from "../src/cli/status-format.js";
import { formatBalanceReport, formatWalletOverviewReport } from "../src/cli/wallet-format.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import { createMemoryWalletSecretProviderForTesting } from "../src/wallet/state/provider.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { createWalletReadContext } from "./current-model-helpers.js";

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

const QUIET_SIGNAL_SOURCE = {
  on() {},
  off() {},
};

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

test("default status uses passive inspection and does not open live wallet services", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-status-command-passive"));
  const runtimePaths = resolvePaths();
  let passiveCall: {
    dbPath: string;
    dataDir: string;
    runtimePaths: typeof runtimePaths;
  } | null = null;
  const passiveStatus = {
    dbPath: "/tmp/cogcoin.db",
    bitcoinDataDir: "/tmp/bitcoind",
    wallet: {
      walletRootId: "wallet-root",
      source: "wallet-state",
      error: null,
    },
    storeInitialized: true,
    storeExists: true,
    indexedTip: {
      height: 123,
      blockHashHex: "aa".repeat(32),
      previousHashHex: "bb".repeat(32),
      stateHashHex: "cc".repeat(32),
      updatedAt: 1,
    },
    latestCheckpoint: null,
    bootstrap: null,
    managedBitcoind: {
      statusPath: null,
      present: false,
      state: null,
      processId: null,
      walletRootId: null,
      heartbeatAtUnixMs: null,
      updatedAtUnixMs: null,
      lastError: null,
      error: null,
    },
    indexer: {
      statusPath: null,
      present: false,
      state: null,
      processId: null,
      walletRootId: null,
      coreBestHeight: null,
      appliedTipHeight: null,
      appliedTipHash: null,
      heartbeatAtUnixMs: null,
      updatedAtUnixMs: null,
      lastError: null,
      error: null,
    },
    mining: {
      statusPath: null,
      present: false,
      runMode: null,
      miningState: null,
      currentPhase: null,
      backgroundWorkerPid: null,
      backgroundWorkerHealth: null,
      updatedAtUnixMs: null,
      lastError: null,
      note: null,
      error: null,
    },
    storeError: null,
  } as const;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter: () => {
      throw new Error("status_default_must_not_prompt");
    },
    readPackageVersion: async () => {
      throw new Error("status_default_must_not_read_package_version");
    },
    resolveWalletRuntimePaths: () => runtimePaths,
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureDirectory: async () => {
      throw new Error("status_default_must_not_create_directories");
    },
    openWalletReadContext: async () => {
      throw new Error("status_default_must_not_open_live_wallet");
    },
    inspectPassiveClientStatus: async (dbPath, dataDir, paths) => {
      passiveCall = {
        dbPath,
        dataDir,
        runtimePaths: paths!,
      };
      return passiveStatus;
    },
  });

  const exitCode = await runStatusCommand(parseCliArgs(["status"]), context);

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.deepEqual(passiveCall, {
    dbPath: "/tmp/cogcoin.db",
    dataDir: "/tmp/bitcoind",
    runtimePaths,
  });
  assert.equal(stdout.read(), `${formatStatusReport(passiveStatus)}\n`);
});

test("status --live text output renders the balance report after the overview", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const version = "9.9.9";
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-status-command"));
  const readContext = createWalletReadContext();
  let closeCalls = 0;
  let expectedIndexerBinaryVersion: string | null = null;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter: () => ({
      isInteractive: false,
      writeLine() {},
      async prompt() {
        return "";
      },
      async promptHidden() {
        return "";
      },
    }),
    readPackageVersion: async () => version,
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureDirectory: async () => undefined,
    openWalletReadContext: async (options) => {
      expectedIndexerBinaryVersion = options.expectedIndexerBinaryVersion ?? null;
      return {
        ...readContext,
        async close() {
          closeCalls += 1;
        },
      };
    },
  });

  const exitCode = await runStatusCommand(parseCliArgs(["status", "--live"]), context);

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.equal(closeCalls, 1);
  assert.equal(expectedIndexerBinaryVersion, version);
  assert.equal(
    stdout.read(),
    `${formatWalletOverviewReport(readContext, version)}\n${formatBalanceReport(readContext)}\n`,
  );
});
