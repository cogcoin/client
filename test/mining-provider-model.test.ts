import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateBuiltInModelDailyCost,
  normalizeMiningProviderConfigRecord,
  resolveBuiltInProviderSelection,
} from "../src/wallet/mining/provider-model.js";

test("daily cost estimates scale deterministically with eligible anchored root count", () => {
  const openAiZeroRoots = estimateBuiltInModelDailyCost("openai", "gpt-5.4-mini", 0);
  const openAiOneRoot = estimateBuiltInModelDailyCost("openai", "gpt-5.4-mini", 1);
  const anthropicManyRoots = estimateBuiltInModelDailyCost("anthropic", "claude-haiku-4-5", 3);

  assert.deepEqual(openAiZeroRoots, {
    estimatedDailyCostUsd: 0.11448,
    estimatedDailyCostDisplay: "$0.11/day",
  });
  assert.deepEqual(openAiOneRoot, {
    estimatedDailyCostUsd: 0.1917,
    estimatedDailyCostDisplay: "$0.19/day",
  });
  assert.deepEqual(anthropicManyRoots, {
    estimatedDailyCostUsd: 0.39888,
    estimatedDailyCostDisplay: "$0.40/day",
  });
});

test("legacy mining configs normalize to explicit legacy model selection sources", () => {
  const legacyDefault = normalizeMiningProviderConfigRecord({
    provider: "anthropic",
    apiKey: "secret",
    extraPrompt: null,
    modelOverride: null,
    modelSelectionSource: undefined as any,
    updatedAtUnixMs: 1,
  });
  const legacyCustom = normalizeMiningProviderConfigRecord({
    provider: "openai",
    apiKey: "secret",
    extraPrompt: "focus on code",
    modelOverride: "gpt-5.4-nano",
    modelSelectionSource: undefined as any,
    updatedAtUnixMs: 1,
  });

  assert.equal(legacyDefault.modelSelectionSource, "legacy-default");
  assert.equal(legacyCustom.modelSelectionSource, "legacy-custom");

  assert.deepEqual(resolveBuiltInProviderSelection(legacyDefault), {
    modelId: "claude-sonnet-4-20250514",
    effectiveModel: "claude-sonnet-4-20250514",
    modelSelectionSource: "legacy-default",
    usingDefaultModel: true,
  });
  assert.deepEqual(resolveBuiltInProviderSelection(legacyCustom), {
    modelId: "gpt-5.4-nano",
    effectiveModel: "gpt-5.4-nano",
    modelSelectionSource: "legacy-custom",
    usingDefaultModel: false,
  });
});
