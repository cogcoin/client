import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createDefaultContext } from "../src/cli/context.js";
import { runClientAdminCommand } from "../src/cli/commands/client-admin.js";
import { runWalletAdminCommand } from "../src/cli/commands/wallet-admin.js";
import { parseCliArgs } from "../src/cli/parse.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createMemoryWalletSecretProviderForTesting,
} from "../src/wallet/state/provider.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { createWalletState } from "./current-model-helpers.js";

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

function createWalletStateEnvelopeStub(walletRootId: string) {
  return {
    source: "primary" as const,
    envelope: {
      format: "cogcoin-local-wallet-state",
      version: 1 as const,
      wrappedBy: "secret-provider",
      cipher: "aes-256-gcm" as const,
      walletRootIdHint: walletRootId,
      nonce: "nonce",
      tag: "tag",
      ciphertext: "ciphertext",
    },
  };
}

function createInitAutoSyncOverrides(options: {
  walletRootId: string;
  onSyncStart?: () => void;
}) {
  return {
    ensureDirectory: async () => undefined,
    loadRawWalletStateEnvelope: async () => createWalletStateEnvelopeStub(options.walletRootId),
    openManagedIndexerMonitor: async () => ({
      async getStatus() {
        options.onSyncStart?.();
        return {
          serviceApiVersion: "cogcoin/indexer-ipc/v1",
          binaryVersion: "0.0.0-test",
          buildId: null,
          updatedAtUnixMs: 0,
          walletRootId: options.walletRootId,
          daemonInstanceId: "daemon-init-test",
          schemaVersion: "cogcoin/indexer-db/v1",
          state: "synced" as const,
          processId: 1,
          startedAtUnixMs: 0,
          heartbeatAtUnixMs: 0,
          ipcReady: true,
          rpcReachable: true,
          coreBestHeight: 0,
          coreBestHash: "00".repeat(32),
          appliedTipHeight: 0,
          appliedTipHash: "00".repeat(32),
          snapshotSeq: "1",
          backlogBlocks: 0,
          reorgDepth: null,
          lastAppliedAtUnixMs: 0,
          activeSnapshotCount: 0,
          lastError: null,
          backgroundFollowActive: true,
          bootstrapPhase: "follow_tip" as const,
          bootstrapProgress: null,
          cogcoinSyncHeight: 0,
          cogcoinSyncTargetHeight: 0,
        };
      },
      async close() {},
    }),
  };
}

const WELCOME_ART = readFileSync(new URL("../src/art/welcome.txt", import.meta.url), "utf8");
const WELCOME_ART_BLOCK = `\n${WELCOME_ART}\n\n`;

function countOccurrences(text: string, fragment: string): number {
  let count = 0;
  let offset = 0;

  while (true) {
    const index = text.indexOf(fragment, offset);

    if (index === -1) {
      return count;
    }

    count += 1;
    offset = index + fragment.length;
  }
}

test("init text output prints welcome art before prompt text and again before the final summary", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-cli-init-prompt-order"));
  const paths = resolvePaths();
  const promptLine = "Prompt: create client password.";
  let syncCalls = 0;
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
      writeLine(message: string) {
        stdout.stream.write(`${message}\n`);
      },
      async prompt() {
        return "";
      },
    }),
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => paths.bitcoinDataDir,
    initializeWallet: async ({ prompter }) => {
      prompter.writeLine(promptLine);
      return {
        setupMode: "generated",
        passwordAction: "created",
        walletAction: "initialized",
        walletRootId: "wallet-init-root",
        fundingAddress: "bc1qinitwelcome",
        state: createWalletState(),
      };
    },
    ...createInitAutoSyncOverrides({
      walletRootId: "wallet-init-root",
      onSyncStart: () => {
        syncCalls += 1;
      },
    }),
  });

  const exitCode = await runWalletAdminCommand(parseCliArgs(["init"]), context);
  const rendered = stdout.read();
  const promptIndex = rendered.indexOf(`${promptLine}\n`);
  const secondArtIndex = rendered.indexOf(WELCOME_ART_BLOCK, WELCOME_ART_BLOCK.length);
  const summaryIndex = rendered.indexOf("Wallet initialized.\n");

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.equal(syncCalls, 1);
  assert.ok(rendered.startsWith(WELCOME_ART_BLOCK));
  assert.ok(promptIndex >= WELCOME_ART_BLOCK.length);
  assert.ok(secondArtIndex > promptIndex);
  assert.ok(summaryIndex > secondArtIndex);
  assert.equal(countOccurrences(rendered, WELCOME_ART_BLOCK), 2);
});

test("init text output keeps the welcome art before the initialized summary", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-cli-init-welcome-output"));
  const paths = resolvePaths();
  let syncCalls = 0;
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
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => paths.bitcoinDataDir,
    initializeWallet: async () => ({
      setupMode: "generated",
      passwordAction: "created",
      walletAction: "initialized",
      walletRootId: "wallet-init-root",
      fundingAddress: "bc1qinitwelcome",
      state: createWalletState(),
    }),
    ...createInitAutoSyncOverrides({
      walletRootId: "wallet-init-root",
      onSyncStart: () => {
        syncCalls += 1;
      },
    }),
  });

  const exitCode = await runWalletAdminCommand(parseCliArgs(["wallet", "init"]), context);
  const rendered = stdout.read();

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.equal(syncCalls, 1);
  assert.ok(rendered.startsWith(`${WELCOME_ART_BLOCK}${WELCOME_ART_BLOCK}Wallet initialized.\n`));
  assert.equal(countOccurrences(rendered, WELCOME_ART_BLOCK), 2);
  assert.match(rendered, /Client password: created/);
  assert.match(rendered, /Wallet root: wallet-init-root/);
  assert.match(rendered, /Funding address: bc1qinitwelcome/);
  assert.match(rendered, /Funding address: bc1qinitwelcome\n\nQuickstart: /);
  assert.match(rendered, /Quickstart: Fund this wallet with about 0\.0015 BTC/);
  assert.doesNotMatch(rendered, /Next step:/);
});

test("init text output describes process-local client password reuse after setup migration", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-cli-init-output"));
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
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => paths.bitcoinDataDir,
    initializeWallet: async () => ({
      setupMode: "existing",
      passwordAction: "migrated",
      walletAction: "already-initialized",
      walletRootId: "wallet-test-root",
      fundingAddress: "bc1qinitoutput",
      state: createWalletState(),
    }),
    ...createInitAutoSyncOverrides({
      walletRootId: "wallet-test-root",
    }),
  });

  const exitCode = await runWalletAdminCommand(parseCliArgs(["init"]), context);
  const rendered = stdout.read();

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.ok(rendered.startsWith(`${WELCOME_ART_BLOCK}${WELCOME_ART_BLOCK}Wallet already initialized.\n`));
  assert.equal(countOccurrences(rendered, WELCOME_ART_BLOCK), 2);
  assert.match(rendered, /Wallet already initialized\./);
  assert.match(rendered, /\nWallet\n✓ Client password: migrated\n✓ Wallet root: wallet-test-root\n✓ Funding address: bc1qinitoutput\n/);
  assert.match(rendered, /Client password reuse stays active for up to 86400 seconds while this command keeps running\./);
  assert.match(rendered, /Future Cogcoin commands will prompt again when they need wallet-local secrets\./);
  assert.doesNotMatch(rendered, /cogcoin client unlock/);
  assert.doesNotMatch(rendered, /cogcoin client lock/);
  assert.doesNotMatch(rendered, /Next step:/);
});

test("init text output shows a checkmarked wallet section when already configured", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(
    await createTrackedTempDirectory(t, "cogcoin-cli-init-already-configured-output"),
  );
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
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => paths.bitcoinDataDir,
    initializeWallet: async () => ({
      setupMode: "existing",
      passwordAction: "already-configured",
      walletAction: "already-initialized",
      walletRootId: "wallet-0123456789abcdef0123456789abcdef",
      fundingAddress: "bc1qsamplewallet0000000000000000000000000",
      state: createWalletState(),
    }),
    ...createInitAutoSyncOverrides({
      walletRootId: "wallet-0123456789abcdef0123456789abcdef",
    }),
  });

  const exitCode = await runWalletAdminCommand(parseCliArgs(["init"]), context);
  const rendered = stdout.read();

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.ok(rendered.startsWith(`${WELCOME_ART_BLOCK}${WELCOME_ART_BLOCK}Wallet already initialized.\n`));
  assert.equal(countOccurrences(rendered, WELCOME_ART_BLOCK), 2);
  assert.match(
    rendered,
    /\nWallet\n✓ Client password: already-configured\n✓ Wallet root: wallet-0123456789abcdef0123456789abcdef\n✓ Funding address: bc1qsamplewallet0000000000000000000000000\n/,
  );
  assert.doesNotMatch(rendered, /Client unlock: active for 86400 seconds\./);
  assert.doesNotMatch(rendered, /cogcoin client unlock/);
  assert.doesNotMatch(rendered, /cogcoin client lock/);
  assert.match(rendered, /bc1qsamplewallet0000000000000000000000000\n\nQuickstart: /);
  assert.doesNotMatch(rendered, /Next step:/);
});

test("init text output fails before printing welcome art when no interactive prompter is available", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  let initializeCalls = 0;
  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    signalSource: QUIET_SIGNAL_SOURCE,
    forceExit(code) {
      throw new Error(`unexpected forceExit: ${code}`);
    },
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter: () => ({
      isInteractive: false,
      writeLine() {},
      async prompt() {
        return "";
      },
    }),
    initializeWallet: async () => {
      initializeCalls += 1;
      throw new Error("initialize_wallet_should_not_run");
    },
  });

  const exitCode = await runWalletAdminCommand(parseCliArgs(["init"]), context);

  assert.notEqual(exitCode, 0);
  assert.equal(initializeCalls, 0);
  assert.equal(stdout.read(), "");
  assert.doesNotMatch(stderr.read(), new RegExp(WELCOME_ART.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("init text output describes process-local client password reuse after restore", async (t) => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const resolvePaths = createTestRuntimePaths(await createTrackedTempDirectory(t, "cogcoin-cli-restore-output"));
  const paths = resolvePaths();
  let syncCalls = 0;
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
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => paths.bitcoinDataDir,
    initializeWallet: async () => ({
      setupMode: "restored",
      passwordAction: "created",
      walletAction: "initialized",
      walletRootId: "wallet-restore-root",
      fundingAddress: "bc1qrestoreoutput",
      state: createWalletState(),
    }),
    ...createInitAutoSyncOverrides({
      walletRootId: "wallet-restore-root",
      onSyncStart: () => {
        syncCalls += 1;
      },
    }),
  });

  const exitCode = await runWalletAdminCommand(parseCliArgs(["init"]), context);
  const rendered = stdout.read();

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.equal(syncCalls, 1);
  assert.match(rendered, /Wallet restored\./);
  assert.match(rendered, /Client password reuse stays active for up to 86400 seconds while this command keeps running\./);
  assert.match(rendered, /Future Cogcoin commands will prompt again when they need wallet-local secrets\./);
  assert.doesNotMatch(rendered, /cogcoin client unlock/);
  assert.doesNotMatch(rendered, /cogcoin client lock/);
});

test("client change-password text output no longer reports a reusable unlock expiry", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const provider = Object.assign(createMemoryWalletSecretProviderForTesting(), {
    async changeClientPassword() {
      return {
        unlocked: true,
        unlockUntilUnixMs: Date.now() + 86_000,
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
  assert.equal(rendered, "Client password changed.\n");
});
