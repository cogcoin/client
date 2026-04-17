import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDefaultContext } from "../src/cli/context.js";
import { runClientAdminCommand } from "../src/cli/commands/client-admin.js";
import { runWalletAdminCommand } from "../src/cli/commands/wallet-admin.js";
import { parseCliArgs } from "../src/cli/parse.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createDefaultWalletSecretProviderForTesting,
  createMemoryWalletSecretProviderForTesting,
  lockClientPassword,
  readClientPasswordStatus,
} from "../src/wallet/state/provider.js";
import { createWalletState } from "./current-model-helpers.js";
import { configureTestClientPassword } from "./client-password-test-helpers.js";

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

const WELCOME_ART = readFileSync(new URL("../src/art/welcome.txt", import.meta.url), "utf8");

test("init text output starts with the welcome art before the existing init content", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await mkdtemp(join(tmpdir(), "cogcoin-cli-init-welcome-output-")));
  const paths = resolvePaths();
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    forceExit(code) {
      throw new Error(`unexpected forceExit: ${code}`);
    },
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter: () => ({
      isInteractive: true,
      writeLine() {},
      async prompt() {
        return "";
      },
    }),
    resolveWalletRuntimePaths: (seedName) => resolvePaths(seedName),
    resolveDefaultBitcoindDataDir: () => paths.bitcoinDataDir,
    initializeWallet: async () => ({
      passwordAction: "created",
      walletAction: "initialized",
      walletRootId: "wallet-init-root",
      fundingAddress: "bc1qinitwelcome",
      state: createWalletState(),
    }),
  });

  const exitCode = await runWalletAdminCommand(parseCliArgs(["wallet", "init"]), context);
  const rendered = stdout.read();

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.ok(rendered.startsWith(`\n${WELCOME_ART}\n\nWallet initialized.\n`));
  assert.match(rendered, /Client password: created/);
  assert.match(rendered, /Wallet root: wallet-init-root/);
  assert.match(rendered, /Funding address: bc1qinitwelcome/);
});

test("init text output describes the 24-hour client unlock window after setup migration", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await mkdtemp(join(tmpdir(), "cogcoin-cli-init-output-")));
  const paths = resolvePaths();
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    forceExit(code) {
      throw new Error(`unexpected forceExit: ${code}`);
    },
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter: () => ({
      isInteractive: true,
      writeLine() {},
      async prompt() {
        return "";
      },
    }),
    resolveWalletRuntimePaths: (seedName) => resolvePaths(seedName),
    resolveDefaultBitcoindDataDir: () => paths.bitcoinDataDir,
    initializeWallet: async () => ({
      passwordAction: "migrated",
      walletAction: "already-initialized",
      walletRootId: "wallet-test-root",
      fundingAddress: "bc1qinitoutput",
      state: createWalletState(),
    }),
  });

  const exitCode = await runWalletAdminCommand(parseCliArgs(["init"]), context);
  const rendered = stdout.read();

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.ok(rendered.startsWith(`\n${WELCOME_ART}\n\nWallet already initialized.\n`));
  assert.match(rendered, /Wallet already initialized\./);
  assert.match(rendered, /Client password: migrated/);
  assert.match(rendered, /Client unlock: active for 86400 seconds\./);
  assert.match(rendered, /cogcoin client unlock/);
  assert.match(rendered, /cogcoin client lock/);
});

test("restore text output describes the 24-hour client unlock window after password setup", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await mkdtemp(join(tmpdir(), "cogcoin-cli-restore-output-")));
  const paths = resolvePaths("seed-2");
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    forceExit(code) {
      throw new Error(`unexpected forceExit: ${code}`);
    },
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter: () => ({
      isInteractive: true,
      writeLine() {},
      async prompt() {
        return "";
      },
    }),
    resolveWalletRuntimePaths: (seedName) => resolvePaths(seedName),
    resolveDefaultBitcoindDataDir: () => paths.bitcoinDataDir,
    restoreWalletFromMnemonic: async () => ({
      passwordAction: "created",
      seedName: "seed-2",
      walletRootId: "wallet-restore-root",
      fundingAddress: "bc1qrestoreoutput",
      state: createWalletState(),
      warnings: [],
    }),
  });

  const exitCode = await runWalletAdminCommand(parseCliArgs(["restore", "--seed", "seed-2"]), context);
  const rendered = stdout.read();

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.match(rendered, /Wallet seed "seed-2" restored from mnemonic\./);
  assert.match(rendered, /Client unlock: active for 86400 seconds\./);
  assert.match(rendered, /cogcoin client unlock/);
  assert.match(rendered, /cogcoin client lock/);
});

test("client change-password text output reports the resulting unlock expiry", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const unlockUntilUnixMs = Date.now() + 86_000;
  const provider = Object.assign(createMemoryWalletSecretProviderForTesting(), {
    async changeClientPassword() {
      return {
        unlocked: true,
        unlockUntilUnixMs,
      };
    },
  });
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    walletSecretProvider: provider,
    createPrompter: () => ({
      isInteractive: true,
      writeLine() {},
      async prompt() {
        return "";
      },
      async promptHidden() {
        return "";
      },
    }),
  });

  const exitCode = await runClientAdminCommand(parseCliArgs(["client", "change-password"]), context);
  const rendered = stdout.read();

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.match(rendered, /Client password changed\. Client unlocked until /);
  assert.match(rendered, new RegExp(new Date(unlockUntilUnixMs).toISOString().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("client change-password json output uses the stable mutation envelope", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const unlockUntilUnixMs = Date.now() + 120_000;
  const provider = Object.assign(createMemoryWalletSecretProviderForTesting(), {
    async changeClientPassword() {
      return {
        unlocked: true,
        unlockUntilUnixMs,
      };
    },
  });
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    walletSecretProvider: provider,
  });

  const exitCode = await runClientAdminCommand(parseCliArgs(["client", "change-password", "--output", "json"]), context);
  const rendered = JSON.parse(stdout.read()) as {
    schema: string;
    outcome: string;
    data: {
      operation: {
        kind: string;
        changed: boolean;
        unlocked: boolean;
        unlockUntilUnixMs: number;
      };
    };
  };

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.equal(rendered.schema, "cogcoin/client-change-password/v1");
  assert.equal(rendered.outcome, "changed");
  assert.equal(rendered.data.operation.kind, "client-change-password");
  assert.equal(rendered.data.operation.changed, true);
  assert.equal(rendered.data.operation.unlocked, true);
  assert.equal(rendered.data.operation.unlockUntilUnixMs, unlockUntilUnixMs);
});

test("client unlock text output reports the refreshed unlock expiry", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-cli-client-unlock-output-"));
  const resolvePaths = createTestRuntimePaths(tempRoot);
  const paths = resolvePaths();
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot: paths.stateRoot,
    runtimeRoot: paths.runtimeRoot,
  });
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  let hiddenPromptCount = 0;

  await configureTestClientPassword(provider);
  t.after(async () => {
    await lockClientPassword(provider);
  });

  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    walletSecretProvider: provider,
    createPrompter: () => ({
      isInteractive: true,
      writeLine() {},
      async prompt() {
        return "120";
      },
      async promptHidden() {
        hiddenPromptCount += 1;
        throw new Error("password should not be requested while already unlocked");
      },
    }),
  });

  const exitCode = await runClientAdminCommand(parseCliArgs(["client", "unlock"]), context);
  const status = await readClientPasswordStatus(provider);
  const rendered = stdout.read();

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.equal(hiddenPromptCount, 0);
  assert.equal(status.unlocked, true);
  assert.match(rendered, /Client unlocked until /);
  assert.match(rendered, new RegExp((status.unlockUntilUnixMs != null
    ? new Date(status.unlockUntilUnixMs).toISOString()
    : "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
