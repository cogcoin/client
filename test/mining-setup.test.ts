import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
  loadClientConfig,
  saveBuiltInMiningProviderConfig,
  saveClientConfig,
} from "../src/wallet/mining/config.js";
import { promptForMiningProviderConfigForTesting } from "../src/wallet/mining/control.js";
import { MINING_MODEL_DAILY_COST_ESTIMATE_ASSUMPTION } from "../src/wallet/mining/provider-model.js";
import type {
  ClientConfigV1,
  MiningProviderConfigByProvider,
  MiningProviderConfigRecord,
  MiningProviderKind,
} from "../src/wallet/mining/types.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createMemoryWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";

type SelectionOptions = {
  message: string;
  options: Array<{ label: string; description?: string | null; value: string }>;
  initialValue?: string | null;
  footer?: string | null;
};

function createSavedMiningProviderConfig(options: {
  provider: MiningProviderKind;
  apiKey?: string;
  extraPrompt?: string | null;
  modelOverride?: string | null;
  modelSelectionSource?: MiningProviderConfigRecord["modelSelectionSource"];
  updatedAtUnixMs?: number;
}): MiningProviderConfigRecord {
  return {
    provider: options.provider,
    apiKey: options.apiKey ?? `${options.provider}-api-key`,
    extraPrompt: options.extraPrompt ?? null,
    modelOverride: options.modelOverride ?? null,
    modelSelectionSource: options.modelSelectionSource ?? (options.modelOverride == null ? "legacy-default" : "custom"),
    updatedAtUnixMs: options.updatedAtUnixMs ?? 1,
  };
}

function createSetupPrompter(options: {
  promptAnswers: string[];
  selectedValue: string | ((selectionOptions: SelectionOptions) => string);
}) {
  const promptAnswers = [...options.promptAnswers];
  const events: string[] = [];
  const lines: string[] = [];
  const selections: SelectionOptions[] = [];

  return {
    events,
    lines,
    selections,
    prompter: {
      isInteractive: true,
      writeLine(message: string) {
        lines.push(message);
      },
      async prompt(message: string) {
        events.push(`prompt:${message}`);
        const answer = promptAnswers.shift();
        if (answer === undefined) {
          throw new Error(`missing prompt answer for ${message}`);
        }
        return answer;
      },
      async selectOption(selectionOptions: SelectionOptions) {
        events.push(`select:${selectionOptions.message}`);
        selections.push(selectionOptions);
        return typeof options.selectedValue === "function"
          ? options.selectedValue(selectionOptions)
          : options.selectedValue;
      },
    },
  };
}

async function createConfigFixture(t: TestContext) {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-setup");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const secretReference = createWalletSecretReference("wallet-root");
  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 9));

  return {
    paths,
    provider,
    secretReference,
  };
}

test("mine setup prompts provider, model selector, api key, then extra prompt for catalog models", async () => {
  const fixture = createSetupPrompter({
    promptAnswers: [
      "anthropic",
      "test-api-key",
      "keep answers concise",
    ],
    selectedValue: "claude-sonnet-4-6",
  });

  const config = await promptForMiningProviderConfigForTesting(fixture.prompter, 2);

  assert.equal(config.provider, "anthropic");
  assert.equal(config.modelOverride, "claude-sonnet-4-6");
  assert.equal(config.modelSelectionSource, "catalog");
  assert.equal(config.apiKey, "test-api-key");
  assert.equal(config.extraPrompt, "keep answers concise");
  assert.deepEqual(fixture.events, [
    "prompt:Provider (openai/anthropic): ",
    "select:Choose the mining model:",
    "prompt:API key: ",
    "prompt:Extra prompt (optional, blank for none): ",
  ]);
  assert.equal(fixture.selections.length, 1);
  assert.equal(fixture.selections[0]!.initialValue, "claude-sonnet-4-6");
  assert.equal(fixture.selections[0]!.footer, MINING_MODEL_DAILY_COST_ESTIMATE_ASSUMPTION);
  assert.match(fixture.selections[0]!.options[0]!.description ?? "", /\$[0-9]/);
});

test("mine setup only prompts for a custom model ID when the custom row is selected", async () => {
  const fixture = createSetupPrompter({
    promptAnswers: [
      "openai",
      "gpt-special-custom",
      "test-api-key",
      "",
    ],
    selectedValue: "custom",
  });

  const config = await promptForMiningProviderConfigForTesting(fixture.prompter, 4);

  assert.equal(config.provider, "openai");
  assert.equal(config.modelOverride, "gpt-special-custom");
  assert.equal(config.modelSelectionSource, "custom");
  assert.equal(config.extraPrompt, null);
  assert.deepEqual(fixture.events, [
    "prompt:Provider (openai/anthropic): ",
    "select:Choose the mining model:",
    "prompt:Custom model ID: ",
    "prompt:API key: ",
    "prompt:Extra prompt (optional, blank for none): ",
  ]);
});

test("mine setup can reuse the active provider config and jump straight to model selection", async () => {
  const currentConfig = createSavedMiningProviderConfig({
    provider: "anthropic",
    extraPrompt: "keep answers concise",
    modelOverride: null,
    modelSelectionSource: "legacy-default",
  });
  const fixture = createSetupPrompter({
    promptAnswers: [
      "n",
      "",
    ],
    selectedValue: (selectionOptions) => selectionOptions.options.find((option) => option.label === "Current configured model")!.value,
  });

  const config = await promptForMiningProviderConfigForTesting(fixture.prompter, 2, {
    currentConfig,
    rememberedConfigs: {
      anthropic: currentConfig,
    },
  });

  assert.equal(config.provider, "anthropic");
  assert.equal(config.apiKey, currentConfig.apiKey);
  assert.equal(config.modelOverride, null);
  assert.equal(config.modelSelectionSource, "legacy-default");
  assert.equal(config.extraPrompt, currentConfig.extraPrompt);
  assert.deepEqual(fixture.events, [
    "prompt:Use a different provider or API key? [y/N]: ",
    "select:Choose the mining model:",
    "prompt:Extra prompt (optional, blank to keep current: keep answers concise): ",
  ]);
  assert.equal(fixture.selections[0]!.footer, MINING_MODEL_DAILY_COST_ESTIMATE_ASSUMPTION);
  assert.equal(
    fixture.selections[0]!.initialValue,
    fixture.selections[0]!.options.find((option) => option.label === "Current configured model")!.value,
  );
});

test("mine setup preserves the current custom model on blank input when reusing a remembered provider", async () => {
  const currentConfig = createSavedMiningProviderConfig({
    provider: "openai",
    extraPrompt: "focus on precise scoring",
    modelOverride: "gpt-special-custom",
    modelSelectionSource: "custom",
  });
  const fixture = createSetupPrompter({
    promptAnswers: [
      "n",
      "",
      "",
    ],
    selectedValue: "custom",
  });

  const config = await promptForMiningProviderConfigForTesting(fixture.prompter, 4, {
    currentConfig,
    rememberedConfigs: {
      openai: currentConfig,
    },
  });

  assert.equal(config.provider, "openai");
  assert.equal(config.apiKey, currentConfig.apiKey);
  assert.equal(config.modelOverride, currentConfig.modelOverride);
  assert.equal(config.modelSelectionSource, "custom");
  assert.equal(config.extraPrompt, currentConfig.extraPrompt);
  assert.deepEqual(fixture.events, [
    "prompt:Use a different provider or API key? [y/N]: ",
    "select:Choose the mining model:",
    "prompt:Custom model ID (blank to keep current: gpt-special-custom): ",
    "prompt:Extra prompt (optional, blank to keep current: focus on precise scoring): ",
  ]);
  assert.equal(fixture.selections[0]!.initialValue, "custom");
});

test("mine setup can switch to another remembered provider and reuse its saved API key", async () => {
  const currentConfig = createSavedMiningProviderConfig({
    provider: "openai",
    apiKey: "openai-current-key",
    extraPrompt: "openai prompt",
    modelOverride: "gpt-5.4-mini",
    modelSelectionSource: "catalog",
  });
  const rememberedAnthropic = createSavedMiningProviderConfig({
    provider: "anthropic",
    apiKey: "anthropic-remembered-key",
    extraPrompt: "anthropic prompt",
    modelOverride: "claude-haiku-4-5",
    modelSelectionSource: "catalog",
  });
  const fixture = createSetupPrompter({
    promptAnswers: [
      "y",
      "anthropic",
      "",
      "",
    ],
    selectedValue: "claude-haiku-4-5",
  });

  const config = await promptForMiningProviderConfigForTesting(fixture.prompter, 3, {
    currentConfig,
    rememberedConfigs: {
      openai: currentConfig,
      anthropic: rememberedAnthropic,
    },
  });

  assert.equal(config.provider, "anthropic");
  assert.equal(config.apiKey, "anthropic-remembered-key");
  assert.equal(config.modelOverride, "claude-haiku-4-5");
  assert.equal(config.modelSelectionSource, "catalog");
  assert.equal(config.extraPrompt, "anthropic prompt");
  assert.deepEqual(fixture.events, [
    "prompt:Use a different provider or API key? [y/N]: ",
    "prompt:Provider (openai/anthropic): ",
    "prompt:Use saved Anthropic API key? [Y/n]: ",
    "select:Choose the mining model:",
    "prompt:Extra prompt (optional, blank to keep current: anthropic prompt): ",
  ]);
  assert.equal(fixture.selections[0]!.initialValue, "claude-haiku-4-5");
});

test("mine setup prompts for a replacement API key when changing to a remembered provider without reusing its key", async () => {
  const currentConfig = createSavedMiningProviderConfig({
    provider: "openai",
    apiKey: "openai-current-key",
    extraPrompt: "openai prompt",
    modelOverride: "gpt-5.4-mini",
    modelSelectionSource: "catalog",
  });
  const rememberedAnthropic = createSavedMiningProviderConfig({
    provider: "anthropic",
    apiKey: "anthropic-remembered-key",
    extraPrompt: "anthropic prompt",
    modelOverride: "claude-sonnet-4-6",
    modelSelectionSource: "catalog",
  });
  const fixture = createSetupPrompter({
    promptAnswers: [
      "y",
      "anthropic",
      "n",
      "replacement-anthropic-key",
      "",
    ],
    selectedValue: "claude-opus-4-7",
  });

  const config = await promptForMiningProviderConfigForTesting(fixture.prompter, 1, {
    currentConfig,
    rememberedConfigs: {
      openai: currentConfig,
      anthropic: rememberedAnthropic,
    },
  });

  assert.equal(config.provider, "anthropic");
  assert.equal(config.apiKey, "replacement-anthropic-key");
  assert.equal(config.modelOverride, "claude-opus-4-7");
  assert.equal(config.modelSelectionSource, "catalog");
  assert.equal(config.extraPrompt, "anthropic prompt");
  assert.deepEqual(fixture.events, [
    "prompt:Use a different provider or API key? [y/N]: ",
    "prompt:Provider (openai/anthropic): ",
    "prompt:Use saved Anthropic API key? [Y/n]: ",
    "select:Choose the mining model:",
    "prompt:API key: ",
    "prompt:Extra prompt (optional, blank to keep current: anthropic prompt): ",
  ]);
});

test("legacy built-in mining configs backfill remembered provider slots on load", async (t) => {
  const fixture = await createConfigFixture(t);
  const activeConfig = createSavedMiningProviderConfig({
    provider: "openai",
    apiKey: "openai-key",
    extraPrompt: "global fallback",
    modelOverride: "gpt-5.4-mini",
    modelSelectionSource: "catalog",
  });

  await saveClientConfig({
    path: fixture.paths.clientConfigPath,
    provider: fixture.provider,
    secretReference: fixture.secretReference,
    config: {
      schemaVersion: 1,
      mining: {
        builtIn: activeConfig,
        domainExtraPrompts: {},
      },
    },
  });

  const loaded = await loadClientConfig({
    path: fixture.paths.clientConfigPath,
    provider: fixture.provider,
  });

  assert.deepEqual(loaded?.mining.builtIn, activeConfig);
  assert.deepEqual(loaded?.mining.builtInByProvider, {
    openai: activeConfig,
  });
});

test("active built-in mining config overrides a conflicting remembered slot during normalization", async (t) => {
  const fixture = await createConfigFixture(t);
  const activeConfig = createSavedMiningProviderConfig({
    provider: "openai",
    apiKey: "active-openai-key",
    extraPrompt: "active openai prompt",
    modelOverride: "gpt-5.4-mini",
    modelSelectionSource: "catalog",
  });
  const staleOpenAiConfig = createSavedMiningProviderConfig({
    provider: "openai",
    apiKey: "stale-openai-key",
    extraPrompt: "stale openai prompt",
    modelOverride: "gpt-5.4-nano",
    modelSelectionSource: "catalog",
  });
  const rememberedAnthropic = createSavedMiningProviderConfig({
    provider: "anthropic",
    apiKey: "anthropic-key",
    extraPrompt: "anthropic prompt",
    modelOverride: "claude-sonnet-4-6",
    modelSelectionSource: "catalog",
  });

  await saveClientConfig({
    path: fixture.paths.clientConfigPath,
    provider: fixture.provider,
    secretReference: fixture.secretReference,
    config: {
      schemaVersion: 1,
      mining: {
        builtIn: activeConfig,
        builtInByProvider: {
          openai: staleOpenAiConfig,
          anthropic: rememberedAnthropic,
        },
        domainExtraPrompts: {},
      },
    },
  });

  const loaded = await loadClientConfig({
    path: fixture.paths.clientConfigPath,
    provider: fixture.provider,
  });

  assert.deepEqual(loaded?.mining.builtIn, activeConfig);
  assert.deepEqual(loaded?.mining.builtInByProvider, {
    openai: activeConfig,
    anthropic: rememberedAnthropic,
  });
});

test("saving built-in mining setup preserves remembered provider slots while updating the active provider", async (t) => {
  const fixture = await createConfigFixture(t);
  const openAiConfig = createSavedMiningProviderConfig({
    provider: "openai",
    apiKey: "openai-key",
    extraPrompt: "openai prompt",
    modelOverride: "gpt-5.4-mini",
    modelSelectionSource: "catalog",
  });
  const anthropicConfig = createSavedMiningProviderConfig({
    provider: "anthropic",
    apiKey: "anthropic-key",
    extraPrompt: "anthropic prompt",
    modelOverride: "claude-haiku-4-5",
    modelSelectionSource: "catalog",
  });

  await saveBuiltInMiningProviderConfig({
    path: fixture.paths.clientConfigPath,
    provider: fixture.provider,
    secretReference: fixture.secretReference,
    config: openAiConfig,
  });
  await saveBuiltInMiningProviderConfig({
    path: fixture.paths.clientConfigPath,
    provider: fixture.provider,
    secretReference: fixture.secretReference,
    config: anthropicConfig,
  });

  const loaded = await loadClientConfig({
    path: fixture.paths.clientConfigPath,
    provider: fixture.provider,
  });

  assert.deepEqual(loaded?.mining.builtIn, anthropicConfig);
  assert.deepEqual(loaded?.mining.builtInByProvider, {
    openai: openAiConfig,
    anthropic: anthropicConfig,
  });
});
