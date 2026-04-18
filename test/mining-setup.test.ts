import assert from "node:assert/strict";
import test from "node:test";

import { buildMineSetupData } from "../src/cli/mining-json.js";
import { promptForMiningProviderConfigForTesting } from "../src/wallet/mining/control.js";
import { MINING_MODEL_DAILY_COST_ESTIMATE_ASSUMPTION } from "../src/wallet/mining/provider-model.js";
import { createMiningControlPlaneView } from "./current-model-helpers.js";

type SelectionOptions = {
  message: string;
  options: Array<{ label: string; description?: string | null; value: string }>;
  initialValue?: string | null;
  footer?: string | null;
};

function createSetupPrompter(options: {
  promptAnswers: string[];
  selectedValue: string;
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
        return options.selectedValue;
      },
    },
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

test("mine setup state-change JSON includes the selected model metadata and daily cost", () => {
  const result = buildMineSetupData(createMiningControlPlaneView({
    provider: {
      configured: true,
      provider: "anthropic",
      status: "ready",
      message: null,
      modelId: "claude-sonnet-4-6",
      effectiveModel: "claude-sonnet-4-6",
      modelOverride: "claude-sonnet-4-6",
      modelSelectionSource: "catalog",
      usingDefaultModel: false,
      extraPromptConfigured: true,
      estimatedDailyCostUsd: 0.43776,
      estimatedDailyCostDisplay: "$0.44/day",
    },
  }));
  const provider = result.state.provider as {
    modelId: string;
    modelSelectionSource: string;
    estimatedDailyCostUsd: number;
    estimatedDailyCostDisplay: string;
    effectiveModel: string;
  };

  assert.equal(provider.modelId, "claude-sonnet-4-6");
  assert.equal(provider.modelSelectionSource, "catalog");
  assert.equal(provider.estimatedDailyCostUsd, 0.43776);
  assert.equal(provider.estimatedDailyCostDisplay, "$0.44/day");
  assert.equal(provider.effectiveModel, "claude-sonnet-4-6");
});
