import test from "node:test";
import assert from "node:assert/strict";

import { formatMineStatusReport } from "../src/cli/mining-format.js";
import { createMiningControlPlaneView, createMiningRuntimeStatus } from "./current-model-helpers.js";

test("mine status text renders the default provider model", () => {
  const report = formatMineStatusReport(createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      providerState: "ready",
    }),
    provider: {
      configured: true,
      provider: "anthropic",
      status: "ready",
      message: null,
      modelId: "claude-sonnet-4-20250514",
      effectiveModel: "claude-sonnet-4-20250514",
      modelOverride: null,
      modelSelectionSource: "legacy-default",
      usingDefaultModel: true,
      extraPromptConfigured: false,
      estimatedDailyCostUsd: null,
      estimatedDailyCostDisplay: null,
    },
  }));

  assert.match(report, /Provider: anthropic configured/);
  assert.match(report, /Provider model: claude-sonnet-4-20250514 \(default\)/);
  assert.match(report, /Provider model source: legacy-default/);
});

test("mine status text renders the override provider model and 404 next step", () => {
  const report = formatMineStatusReport(createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      currentPhase: "waiting-provider",
      miningState: "paused",
      providerState: "not-found",
      lastError: "The built-in Anthropic mining provider returned HTTP 404 for model \"claude-sonnet-4-missing\". The configured model override may be invalid. Rerun `cogcoin mine setup` to clear or correct it.",
    }),
    provider: {
      configured: true,
      provider: "anthropic",
      status: "ready",
      message: null,
      modelId: "claude-sonnet-4-missing",
      effectiveModel: "claude-sonnet-4-missing",
      modelOverride: "claude-sonnet-4-missing",
      modelSelectionSource: "custom",
      usingDefaultModel: false,
      extraPromptConfigured: false,
      estimatedDailyCostUsd: null,
      estimatedDailyCostDisplay: null,
    },
  }));

  assert.match(report, /Provider model: claude-sonnet-4-missing \(override\)/);
  assert.match(report, /Provider model source: custom/);
  assert.match(report, /Provider runtime: not-found/);
  assert.match(report, /Next: run `cogcoin mine setup` and clear or correct the provider model\./);
});
