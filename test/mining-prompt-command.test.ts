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

test("mine prompt json output reports cleared prompts", async (t) => {
  const fixture = await createFixture(t, {
    mineableDomains: [{ name: "alpha", domainId: 7 }],
    domainExtraPrompts: { alpha: "legacy alpha" },
  });
  const stdout = createStringWriter();
  const stderr = createStringWriter(true);
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  stdin.end("\n");

  const exitCode = await runCli(["mine", "prompt", "alpha", "--output", "json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin,
    walletSecretProvider: fixture.provider,
    resolveWalletRuntimePaths: () => fixture.paths,
    resolveDefaultClientDatabasePath: () => join(fixture.homeDirectory, "indexer.sqlite"),
    resolveDefaultBitcoindDataDir: () => join(fixture.homeDirectory, "bitcoin"),
    openWalletReadContext: async () => fixture.createReadContext(),
  });

  const payload = JSON.parse(stdout.read()) as {
    ok: boolean;
    schema: string;
    outcome: string;
    data: {
      previousPrompt: string | null;
      prompt: string | null;
      status: string;
      fallbackPromptConfigured: boolean;
      domain: {
        name: string;
        domainId: number | null;
      };
    };
  };

  assert.equal(exitCode, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.schema, "cogcoin/mine-prompt/v1");
  assert.equal(payload.outcome, "cleared");
  assert.equal(payload.data.previousPrompt, "legacy alpha");
  assert.equal(payload.data.prompt, null);
  assert.equal(payload.data.status, "cleared");
  assert.equal(payload.data.domain.name, "alpha");
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

test("mine prompt list json includes mineable and dormant prompt entries", async (t) => {
  const fixture = await createFixture(t, {
    mineableDomains: [
      { name: "alpha", domainId: 7 },
      { name: "beta", domainId: 8 },
    ],
    builtInExtraPrompt: "global fallback",
    domainExtraPrompts: {
      alpha: "focus alpha",
      legacy: "legacy prompt",
    },
  });
  const stdout = createStringWriter();

  const exitCode = await runCli(["mine", "prompt", "list", "--output", "json"], {
    stdout: stdout.stream,
    stderr: createStringWriter().stream,
    walletSecretProvider: fixture.provider,
    resolveWalletRuntimePaths: () => fixture.paths,
    resolveDefaultClientDatabasePath: () => join(fixture.homeDirectory, "indexer.sqlite"),
    resolveDefaultBitcoindDataDir: () => join(fixture.homeDirectory, "bitcoin"),
    openWalletReadContext: async () => fixture.createReadContext(),
  });

  const payload = JSON.parse(stdout.read()) as {
    ok: boolean;
    schema: string;
    data: {
      fallbackPromptConfigured: boolean;
      prompts: Array<{
        domain: {
          name: string;
          domainId: number | null;
        };
        mineable: boolean;
        prompt: string | null;
        effectivePromptSource: string;
      }>;
    };
  };

  assert.equal(exitCode, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.schema, "cogcoin/mine-prompt-list/v1");
  assert.equal(payload.data.fallbackPromptConfigured, true);
  assert.deepEqual(payload.data.prompts, [
    {
      domain: { name: "alpha", domainId: 7 },
      mineable: true,
      prompt: "focus alpha",
      effectivePromptSource: "domain",
    },
    {
      domain: { name: "beta", domainId: 8 },
      mineable: true,
      prompt: null,
      effectivePromptSource: "global-fallback",
    },
    {
      domain: { name: "legacy", domainId: null },
      mineable: false,
      prompt: "legacy prompt",
      effectivePromptSource: "domain",
    },
  ]);
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
