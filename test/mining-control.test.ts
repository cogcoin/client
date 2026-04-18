import test from "node:test";
import assert from "node:assert/strict";

import { buildMineStatusJson } from "../src/cli/read-json.js";
import { createMiningControlPlaneView, createMiningRuntimeStatus } from "./current-model-helpers.js";

test("mine status JSON exposes livePublishInMempool", () => {
  const mining = createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      miningState: "paused",
      currentPhase: "waiting",
      livePublishInMempool: true,
      currentPublishDecision: "kept-live-publish",
      note: "Waiting on current publish.",
    }),
  });

  const result = buildMineStatusJson(mining);

  assert.equal(result.data.livePublishInMempool, true);
  assert.equal(result.data.publishDecision, "kept-live-publish");
  assert.match(result.nextSteps[0] ?? "", /live mining publish/);
});

test("mine status explanations avoid family wording", () => {
  const mining = createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      note: "Mining is paused while another wallet mutation is active.",
    }),
  });

  const result = buildMineStatusJson(mining);
  assert.equal(result.explanations[0], "Mining is paused while another wallet mutation is active.");
  assert.doesNotMatch(result.explanations.join("\n"), /family/);
});

test("mine status JSON exposes the effective provider model and not-found next step", () => {
  const mining = createMiningControlPlaneView({
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
  });

  const result = buildMineStatusJson(mining);

  assert.deepEqual(result.data.provider, {
    configured: true,
    kind: "anthropic",
    modelId: "claude-sonnet-4-missing",
    effectiveModel: "claude-sonnet-4-missing",
    modelOverride: "claude-sonnet-4-missing",
    modelSelectionSource: "custom",
    usingDefaultModel: false,
    extraPromptConfigured: false,
    estimatedDailyCostUsd: null,
    estimatedDailyCostDisplay: null,
  });
  assert.equal(result.data.providerState, "not-found");
  assert.equal(result.nextSteps[0], "Run `cogcoin mine setup` and clear or correct the provider model.");
});
