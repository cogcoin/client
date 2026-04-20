import assert from "node:assert/strict";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import { runCli } from "../src/cli/runner.js";
import { loadClientConfig, saveClientConfig } from "../src/wallet/mining/config.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../src/wallet/runtime.js";
import {
  createMemoryWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { createWalletReadContext, createWalletState } from "./current-model-helpers.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";

function createStringWriter(isTTY = false) {
  let text = "";
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean };
  stream.isTTY = isTTY;
  stream.on("data", (chunk) => {
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });

  return {
    stream,
    read() {
      return text;
    },
  };
}

function createPrompter(options: {
  interactive: boolean;
  answers?: string[];
}) {
  const answers = [...(options.answers ?? [])];

  return {
    prompter: {
      isInteractive: options.interactive,
      writeLine() {},
      async prompt() {
        return answers.shift() ?? "";
      },
    },
  };
}

function createRuntimePaths(homeDirectory: string): WalletRuntimePaths {
  return resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
}

function createMineableReadContext(options: {
  mineableDomains?: Array<{ name: string; domainId: number }>;
}) {
  const mineableDomains = options.mineableDomains ?? [];
  const walletScriptPubKeyHex = "0014" + "11".repeat(20);
  const state = createWalletState({
    funding: {
      address: "bc1qfunding",
      scriptPubKeyHex: walletScriptPubKeyHex,
    },
    domains: mineableDomains.map((domain) => ({
      name: domain.name,
      domainId: domain.domainId,
      currentOwnerScriptPubKeyHex: walletScriptPubKeyHex,
      canonicalChainStatus: "anchored",
      foundingMessageText: null,
      birthTime: null,
    } as any)),
  });

  return {
    ...createWalletReadContext({
      localState: {
        availability: "ready",
        clientPasswordReadiness: "ready",
        unlockRequired: false,
        walletRootId: state.walletRootId,
        state,
        source: "primary",
        hasPrimaryStateFile: true,
        hasBackupStateFile: false,
        message: null,
      },
      model: {
        walletRootId: state.walletRootId,
        walletAddress: state.funding.address,
        walletScriptPubKeyHex,
        domains: mineableDomains.map((domain) => ({
          name: domain.name,
          anchored: true,
          readOnly: false,
          localRelationship: "local",
          domainId: domain.domainId,
          ownerAddress: state.funding.address,
          ownerScriptPubKeyHex: walletScriptPubKeyHex,
        })),
      },
      snapshot: {
        state: {
          consensus: {
            domainIdsByName: new Map(mineableDomains.map((domain) => [domain.name, domain.domainId])),
            domainsById: new Map(mineableDomains.map((domain) => [domain.domainId, {
              domainId: domain.domainId,
              name: domain.name,
              anchored: true,
              anchorHeight: 100,
              ownerScriptPubKey: Buffer.from(walletScriptPubKeyHex, "hex"),
              endpoint: null,
              delegate: null,
              miner: null,
            }])),
            balances: new Map(),
          },
          history: {
            foundingMessageByDomain: new Map(),
            blockWinnersByHeight: new Map(),
          },
        },
      },
    }),
    close: async () => undefined,
  } as any;
}

async function seedClientConfig(options: {
  paths: WalletRuntimePaths;
  provider: ReturnType<typeof createMemoryWalletSecretProviderForTesting>;
  builtInExtraPrompt?: string | null;
  domainExtraPrompts?: Record<string, string>;
}): Promise<void> {
  const secretReference = createWalletSecretReference("wallet-root");
  await options.provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 9));
  await saveClientConfig({
    path: options.paths.clientConfigPath,
    provider: options.provider,
    secretReference,
    config: {
      schemaVersion: 1,
      mining: {
        builtIn: {
          provider: "openai",
          apiKey: "test-api-key",
          extraPrompt: options.builtInExtraPrompt ?? null,
          modelOverride: "gpt-5.4-mini",
          modelSelectionSource: "catalog",
          updatedAtUnixMs: 1,
        },
        domainExtraPrompts: options.domainExtraPrompts ?? {},
      },
    },
  });
}

async function createFixture(t: TestContext, options: {
  mineableDomains?: Array<{ name: string; domainId: number }>;
  builtInExtraPrompt?: string | null;
  domainExtraPrompts?: Record<string, string>;
}) {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mine-prompt");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  await seedClientConfig({
    paths,
    provider,
    builtInExtraPrompt: options.builtInExtraPrompt,
    domainExtraPrompts: options.domainExtraPrompts,
  });

  return {
    homeDirectory,
    paths,
    provider,
    createReadContext: () => createMineableReadContext({
      mineableDomains: options.mineableDomains,
    }),
  };
}

async function runMinePromptListCommand(options: {
  argv: string[];
  fixture: Awaited<ReturnType<typeof createFixture>>;
}) {
  const stdout = createStringWriter();
  const stderr = createStringWriter();

  const exitCode = await runCli(options.argv, {
    stdout: stdout.stream,
    stderr: stderr.stream,
    walletSecretProvider: options.fixture.provider,
    resolveWalletRuntimePaths: () => options.fixture.paths,
    resolveDefaultClientDatabasePath: () => join(options.fixture.homeDirectory, "indexer.sqlite"),
    resolveDefaultBitcoindDataDir: () => join(options.fixture.homeDirectory, "bitcoin"),
    openWalletReadContext: async () => options.fixture.createReadContext(),
  });

  return {
    exitCode,
    stderr: stderr.read(),
    output: stdout.read(),
  };
}

test("mine prompt updates config for a mineable domain", async (t) => {
  const fixture = await createFixture(t, {
    mineableDomains: [{ name: "alpha", domainId: 7 }],
    builtInExtraPrompt: "global fallback",
  });
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const prompt = createPrompter({
    interactive: true,
    answers: ["focus alpha"],
  });

  const exitCode = await runCli(["mine", "prompt", "alpha"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    walletSecretProvider: fixture.provider,
    createPrompter: () => prompt.prompter as any,
    resolveWalletRuntimePaths: () => fixture.paths,
    resolveDefaultClientDatabasePath: () => join(fixture.homeDirectory, "indexer.sqlite"),
    resolveDefaultBitcoindDataDir: () => join(fixture.homeDirectory, "bitcoin"),
    openWalletReadContext: async () => fixture.createReadContext(),
  });

  assert.equal(exitCode, 0);
  const saved = await loadClientConfig({
    path: fixture.paths.clientConfigPath,
    provider: fixture.provider,
  });
  assert.equal(saved?.mining.domainExtraPrompts.alpha, "focus alpha");
  assert.match(stdout.read(), /Current domain prompt: none/);
  assert.match(stdout.read(), /Per-domain mining prompt updated\./);
  assert.equal(stderr.read(), "");
});

test("mine prompt text output reports cleared prompts", async (t) => {
  const fixture = await createFixture(t, {
    mineableDomains: [{ name: "alpha", domainId: 7 }],
    domainExtraPrompts: { alpha: "legacy alpha" },
  });
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const prompt = createPrompter({
    interactive: true,
    answers: [""],
  });

  const exitCode = await runCli(["mine", "prompt", "alpha"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    walletSecretProvider: fixture.provider,
    createPrompter: () => prompt.prompter as any,
    resolveWalletRuntimePaths: () => fixture.paths,
    resolveDefaultClientDatabasePath: () => join(fixture.homeDirectory, "indexer.sqlite"),
    resolveDefaultBitcoindDataDir: () => join(fixture.homeDirectory, "bitcoin"),
    openWalletReadContext: async () => fixture.createReadContext(),
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.read(), /Domain: alpha/);
  assert.match(stdout.read(), /Domain prompt: none/);
  assert.match(stdout.read(), /Previous domain prompt: legacy alpha/);
  assert.match(stdout.read(), /Per-domain mining prompt cleared\./);
});

test("mine prompt requires an interactive terminal", async (t) => {
  const fixture = await createFixture(t, {
    mineableDomains: [{ name: "alpha", domainId: 7 }],
  });
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const prompt = createPrompter({
    interactive: false,
    answers: ["focus alpha"],
  });

  const exitCode = await runCli(["mine", "prompt", "alpha"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    walletSecretProvider: fixture.provider,
    createPrompter: () => prompt.prompter as any,
    resolveWalletRuntimePaths: () => fixture.paths,
    resolveDefaultClientDatabasePath: () => join(fixture.homeDirectory, "indexer.sqlite"),
    resolveDefaultBitcoindDataDir: () => join(fixture.homeDirectory, "bitcoin"),
    openWalletReadContext: async () => fixture.createReadContext(),
  });

  assert.equal(exitCode, 4);
  assert.match(stderr.read(), /interactive terminal/i);
});

test("mine prompt rejects non-mineable domains without stored prompts", async (t) => {
  const fixture = await createFixture(t, {
    mineableDomains: [{ name: "alpha", domainId: 7 }],
  });
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const prompt = createPrompter({
    interactive: true,
    answers: ["focus beta"],
  });

  const exitCode = await runCli(["mine", "prompt", "beta"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    walletSecretProvider: fixture.provider,
    createPrompter: () => prompt.prompter as any,
    resolveWalletRuntimePaths: () => fixture.paths,
    resolveDefaultClientDatabasePath: () => join(fixture.homeDirectory, "indexer.sqlite"),
    resolveDefaultBitcoindDataDir: () => join(fixture.homeDirectory, "bitcoin"),
    openWalletReadContext: async () => fixture.createReadContext(),
  });

  assert.equal(exitCode, 4);
  assert.match(stderr.read(), /mineable anchored root domain/i);
});

test("mine prompt can edit dormant stored prompt entries", async (t) => {
  const fixture = await createFixture(t, {
    mineableDomains: [],
    domainExtraPrompts: { legacy: "legacy prompt" },
  });
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const prompt = createPrompter({
    interactive: true,
    answers: ["updated dormant prompt"],
  });

  const exitCode = await runCli(["mine", "prompt", "legacy"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    walletSecretProvider: fixture.provider,
    createPrompter: () => prompt.prompter as any,
    resolveWalletRuntimePaths: () => fixture.paths,
    resolveDefaultClientDatabasePath: () => join(fixture.homeDirectory, "indexer.sqlite"),
    resolveDefaultBitcoindDataDir: () => join(fixture.homeDirectory, "bitcoin"),
    openWalletReadContext: async () => fixture.createReadContext(),
  });

  assert.equal(exitCode, 0);
  const saved = await loadClientConfig({
    path: fixture.paths.clientConfigPath,
    provider: fixture.provider,
  });
  assert.equal(saved?.mining.domainExtraPrompts.legacy, "updated dormant prompt");
  assert.match(stdout.read(), /Per-domain mining prompt updated\./);
  assert.equal(stderr.read(), "");
});

test("mine prompt text output suggests the first mineable domain without a custom prompt", async (t) => {
  const fixture = await createFixture(t, {
    mineableDomains: [
      { name: "alpha", domainId: 7 },
      { name: "beta", domainId: 8 },
      { name: "gamma", domainId: 9 },
    ],
    builtInExtraPrompt: "global fallback",
    domainExtraPrompts: {
      alpha: "focus alpha",
    },
  });
  const stdout = createStringWriter();
  const stderr = createStringWriter();

  const exitCode = await runCli(["mine", "prompt"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    walletSecretProvider: fixture.provider,
    resolveWalletRuntimePaths: () => fixture.paths,
    resolveDefaultClientDatabasePath: () => join(fixture.homeDirectory, "indexer.sqlite"),
    resolveDefaultBitcoindDataDir: () => join(fixture.homeDirectory, "bitcoin"),
    openWalletReadContext: async () => fixture.createReadContext(),
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.read(), /Mining Prompt List/);
  assert.match(stdout.read(), /Next step: cogcoin mine prompt beta/);
  assert.doesNotMatch(stdout.read(), /Next step: cogcoin mine prompt gamma/);
  assert.equal(stderr.read(), "");
});

test("mine prompt text suggests the first missing custom prompt and includes dormant entries", async (t) => {
  const fixture = await createFixture(t, {
    mineableDomains: [
      { name: "alpha", domainId: 7 },
      { name: "beta", domainId: 8 },
      { name: "gamma", domainId: 9 },
    ],
    builtInExtraPrompt: "global fallback",
    domainExtraPrompts: {
      alpha: "focus alpha",
      legacy: "legacy prompt",
    },
  });
  const { exitCode, stderr, output } = await runMinePromptListCommand({
    argv: ["mine", "prompt"],
    fixture,
  });

  assert.equal(exitCode, 0);
  assert.match(output, /Mining Prompt List/);
  assert.match(output, /Global fallback prompt: configured/);
  assert.match(output, /alpha  domainId=7  mineable  source=domain/);
  assert.match(output, /beta  domainId=8  mineable  source=global-fallback/);
  assert.match(output, /gamma  domainId=9  mineable  source=global-fallback/);
  assert.match(output, /legacy  domainId=none  dormant  source=domain/);
  assert.match(output, /Next step: cogcoin mine prompt beta/);
  assert.equal(stderr, "");
});

test("mine prompt list alias keeps the same next-step behavior", async (t) => {
  const fixture = await createFixture(t, {
    mineableDomains: [
      { name: "alpha", domainId: 7 },
      { name: "beta", domainId: 8 },
    ],
    domainExtraPrompts: {
      alpha: "focus alpha",
    },
  });
  const canonical = await runMinePromptListCommand({
    argv: ["mine", "prompt"],
    fixture,
  });
  const alias = await runMinePromptListCommand({
    argv: ["mine", "prompt", "list"],
    fixture,
  });

  assert.equal(canonical.exitCode, 0);
  assert.equal(alias.exitCode, 0);
  assert.equal(canonical.output, alias.output);
  assert.match(alias.output, /Next step: cogcoin mine prompt beta/);
  assert.equal(alias.stderr, "");
});

test("mine prompt text emits no domain-edit next step when all mineable domains already have custom prompts", async (t) => {
  const fixture = await createFixture(t, {
    mineableDomains: [
      { name: "alpha", domainId: 7 },
      { name: "beta", domainId: 8 },
    ],
    domainExtraPrompts: {
      alpha: "focus alpha",
      beta: "focus beta",
    },
  });
  const { exitCode, stderr, output } = await runMinePromptListCommand({
    argv: ["mine", "prompt"],
    fixture,
  });

  assert.equal(exitCode, 0);
  assert.doesNotMatch(output, /Next step:/);
  assert.equal(stderr, "");
});

test("mine prompt text keeps the domains guidance next step when no prompts exist at all", async (t) => {
  const fixture = await createFixture(t, {
    mineableDomains: [],
  });
  const { exitCode, stderr, output } = await runMinePromptListCommand({
    argv: ["mine", "prompt"],
    fixture,
  });

  assert.equal(exitCode, 0);
  assert.match(output, /No mineable root domains or stored per-domain mining prompts are configured\./);
  assert.match(output, /Next step: cogcoin domains --mineable/);
  assert.equal(stderr, "");
});

test("mine prompt text emits no domain-edit next step when only dormant stored prompts exist", async (t) => {
  const fixture = await createFixture(t, {
    mineableDomains: [],
    domainExtraPrompts: {
      legacy: "legacy prompt",
    },
  });
  const { exitCode, stderr, output } = await runMinePromptListCommand({
    argv: ["mine", "prompt"],
    fixture,
  });

  assert.equal(exitCode, 0);
  assert.match(output, /legacy  domainId=none  dormant  source=domain/);
  assert.doesNotMatch(output, /Next step:/);
  assert.equal(stderr, "");
});

test("client config normalizes domain prompt keys and values", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mine-prompt-config");
  const paths = createRuntimePaths(homeDirectory);
  const provider = createMemoryWalletSecretProviderForTesting();
  const secretReference = createWalletSecretReference("wallet-root");
  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 9));

  await saveClientConfig({
    path: paths.clientConfigPath,
    provider,
    secretReference,
    config: {
      schemaVersion: 1,
      mining: {
        builtIn: {
          provider: "openai",
          apiKey: "test-api-key",
          extraPrompt: "global fallback",
          modelOverride: "gpt-5.4-mini",
          modelSelectionSource: "catalog",
          updatedAtUnixMs: 1,
        },
        domainExtraPrompts: {
          " Alpha ": "  focus alpha  ",
          beta: "   ",
          "": "skip me",
        },
      },
    },
  });

  const config = await loadClientConfig({
    path: paths.clientConfigPath,
    provider,
  });

  assert.deepEqual(config?.mining.domainExtraPrompts, {
    alpha: "focus alpha",
  });
  assert.equal(config?.mining.builtIn?.extraPrompt, "global fallback");
});
