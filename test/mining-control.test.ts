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
