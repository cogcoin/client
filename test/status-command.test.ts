import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createDefaultContext } from "../src/cli/context.js";
import { runStatusCommand } from "../src/cli/commands/status.js";
import { parseCliArgs } from "../src/cli/parse.js";
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

test("status text output immediately renders the balance report after the overview", async (t) => {
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
    resolveWalletRuntimePaths: (seedName) => resolvePaths(seedName),
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

  const exitCode = await runStatusCommand(parseCliArgs(["status"]), context);

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.equal(closeCalls, 1);
  assert.equal(expectedIndexerBinaryVersion, version);
  assert.equal(
    stdout.read(),
    `${formatWalletOverviewReport(readContext, version)}\n${formatBalanceReport(readContext)}\n`,
  );
});
