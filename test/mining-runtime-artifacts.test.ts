import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { loadMiningRuntimeStatus, saveMiningRuntimeStatus } from "../src/wallet/mining/runtime-artifacts.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { createMiningRuntimeStatus } from "./current-model-helpers.js";

test("mining runtime artifacts round-trip the not-found provider state", async (t) => {
  const dir = await createTrackedTempDirectory(t, "cogcoin-mining-runtime-artifacts");
  const statusPath = join(dir, "status.json");

  await saveMiningRuntimeStatus(statusPath, createMiningRuntimeStatus({
    providerState: "not-found",
  }));

  const loaded = await loadMiningRuntimeStatus(statusPath);
  assert.equal(loaded?.providerState, "not-found");
});
