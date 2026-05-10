import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createDefaultContext } from "../src/cli/context.js";
import { runStatusCommand } from "../src/cli/commands/status.js";
import { parseCliArgs } from "../src/cli/parse.js";
import { formatStatusReport } from "../src/cli/status-format.js";
import { formatBalanceReport, formatWalletOverviewReport } from "../src/cli/wallet-format.js";
import type { PassiveClientStatus } from "../src/passive-status.js";
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

function createPassiveStatus(overrides: Partial<PassiveClientStatus> = {}): PassiveClientStatus {
  const base: PassiveClientStatus = {
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
    latestCheckpoint: {
      height: 120,
      blockHashHex: "dd".repeat(32),
      createdAt: 2,
    },
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
  };

  return {
    ...base,
    ...overrides,
    wallet: {
      ...base.wallet,
      ...overrides.wallet,
    },
    managedBitcoind: {
      ...base.managedBitcoind,
      ...overrides.managedBitcoind,
    },
    indexer: {
      ...base.indexer,
      ...overrides.indexer,
    },
    mining: {
      ...base.mining,
      ...overrides.mining,
    },
  };
}

test("default status uses passive inspection and does not open live wallet services", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const version = "9.9.9";
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-status-command-passive"));
  const runtimePaths = resolvePaths();
  let readPackageVersionCalls = 0;
  let passiveCall: {
    dbPath: string;
    dataDir: string;
    runtimePaths: typeof runtimePaths;
  } | null = null;
  const passiveStatus = createPassiveStatus({
    latestCheckpoint: null,
  });
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter: () => {
      throw new Error("status_default_must_not_prompt");
    },
    readPackageVersion: async () => {
      readPackageVersionCalls += 1;
      return version;
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
    attachManagedBitcoindService: async () => {
      throw new Error("status_default_must_not_attach_bitcoind");
    },
    probeManagedBitcoindService: async () => {
      throw new Error("status_default_must_not_probe_bitcoind");
    },
    attachIndexerDaemon: async () => {
      throw new Error("status_default_must_not_attach_indexer");
    },
    probeIndexerDaemon: async () => {
      throw new Error("status_default_must_not_probe_indexer");
    },
    createBitcoinRpcClient: () => {
      throw new Error("status_default_must_not_create_rpc_client");
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
  assert.equal(readPackageVersionCalls, 1);
  assert.deepEqual(passiveCall, {
    dbPath: "/tmp/cogcoin.db",
    dataDir: "/tmp/bitcoind",
    runtimePaths,
  });
  assert.equal(stdout.read(), `${formatStatusReport(passiveStatus, version)}\n`);
});

test("passive status formatter renders rich sections and derived lag hints", () => {
  const status = createPassiveStatus({
    indexedTip: {
      height: 950,
      blockHashHex: "11".repeat(32),
      previousHashHex: "22".repeat(32),
      stateHashHex: "33".repeat(32),
      updatedAt: 10,
    },
    managedBitcoind: {
      statusPath: "/tmp/bitcoind-status.json",
      present: true,
      state: "ready",
      processId: 1234,
      walletRootId: "wallet-root",
      heartbeatAtUnixMs: 1000,
      updatedAtUnixMs: 1001,
      lastError: null,
      error: null,
    },
    indexer: {
      statusPath: "/tmp/indexer-status.json",
      present: true,
      state: "catching-up",
      processId: 2345,
      walletRootId: "wallet-root",
      coreBestHeight: 1000,
      appliedTipHeight: 949,
      appliedTipHash: "44".repeat(32),
      heartbeatAtUnixMs: 1002,
      updatedAtUnixMs: 1003,
      lastError: null,
      error: null,
    },
    mining: {
      statusPath: "/tmp/mining-status.json",
      present: true,
      runMode: "foreground",
      miningState: "waiting",
      currentPhase: "indexer-alignment",
      backgroundWorkerPid: null,
      backgroundWorkerHealth: null,
      updatedAtUnixMs: 1004,
      lastError: null,
      note: null,
      error: null,
    },
  });

  const output = formatStatusReport(status, "1.2.5");

  assert.match(output, /^⛭ Cogcoin Status v1\.2\.5 \(passive\) ⛭/);
  assert.match(output, /Paths\n✓ DB path: \/tmp\/cogcoin\.db\n✓ Bitcoin datadir: \/tmp\/bitcoind/);
  assert.match(output, /Wallet\n✓ Wallet root: wallet-root \(wallet-state\)/);
  assert.match(output, /Local Store[\s\S]*✓ Store\/indexer height delta: \+1/);
  assert.match(output, /Managed Services[\s\S]*✓ Managed bitcoind: ready/);
  assert.match(output, /Managed Services[\s\S]*✗ Indexer: catching-up/);
  assert.match(output, /Managed Services[\s\S]*✗ Indexer lag: 51 blocks/);
  assert.match(output, /Passive Mode\n✓ Live node: not checked/);
  assert.match(output, /Run cogcoin status --live for RPC-backed balance and full service verification\.$/);
});

test("passive status formatter marks missing service files as unavailable", () => {
  const output = formatStatusReport(createPassiveStatus({
    storeExists: false,
    storeInitialized: false,
    indexedTip: null,
    latestCheckpoint: null,
    wallet: {
      walletRootId: null,
      source: "none",
      error: null,
    },
  }), "1.2.5");

  assert.match(output, /Wallet\n✗ Wallet root: unknown \(none\)/);
  assert.match(output, /Local Store[\s\S]*✗ Store exists: no/);
  assert.match(output, /Local Store[\s\S]*✗ Store initialized: no/);
  assert.match(output, /Managed Services\n✗ Managed bitcoind: unavailable\n✗ Indexer: unavailable/);
  assert.match(output, /Mining\n✗ Mining state: unavailable/);
});

test("passive status formatter surfaces corrupt runtime files and store errors", () => {
  const output = formatStatusReport(createPassiveStatus({
    storeInitialized: false,
    indexedTip: null,
    latestCheckpoint: null,
    storeError: "sqlite native version mismatch",
    managedBitcoind: {
      statusPath: "/tmp/bitcoind-status.json",
      present: true,
      state: null,
      processId: null,
      walletRootId: null,
      heartbeatAtUnixMs: null,
      updatedAtUnixMs: null,
      lastError: null,
      error: "Unexpected token",
    },
    indexer: {
      statusPath: "/tmp/indexer-status.json",
      present: true,
      state: null,
      processId: null,
      walletRootId: null,
      coreBestHeight: null,
      appliedTipHeight: null,
      appliedTipHash: null,
      heartbeatAtUnixMs: null,
      updatedAtUnixMs: null,
      lastError: null,
      error: "Unexpected end of JSON input",
    },
    mining: {
      statusPath: "/tmp/mining-status.json",
      present: true,
      runMode: null,
      miningState: null,
      currentPhase: null,
      backgroundWorkerPid: null,
      backgroundWorkerHealth: null,
      updatedAtUnixMs: null,
      lastError: null,
      note: null,
      error: "invalid mining status",
    },
  }), "1.2.5");

  assert.match(output, /✗ Store error: sqlite native version mismatch/);
  assert.match(output, /✗ Managed bitcoind: corrupt/);
  assert.match(output, /✗ Managed bitcoind status error: Unexpected token/);
  assert.match(output, /✗ Indexer: corrupt/);
  assert.match(output, /✗ Indexer status error: Unexpected end of JSON input/);
  assert.match(output, /✗ Mining state: corrupt/);
  assert.match(output, /✗ Mining status error: invalid mining status/);
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
