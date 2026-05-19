import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  loadMiningRuntimeStatus,
  saveForegroundMiningHeartbeatStatus,
  saveMiningRuntimeStatus,
} from "../src/wallet/mining/runtime-artifacts.js";
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

test("mining runtime artifacts normalize new optional status fields to null", async (t) => {
  const dir = await createTrackedTempDirectory(t, "cogcoin-mining-runtime-artifacts-legacy-fields");
  const statusPath = join(dir, "status.json");
  const legacy = createMiningRuntimeStatus() as unknown as Record<string, unknown>;
  delete legacy["foregroundPid"];
  delete legacy["foregroundRunId"];
  delete legacy["foregroundHeartbeatAtUnixMs"];
  delete legacy["cycleStartedAtUnixMs"];
  delete legacy["phaseEnteredAtUnixMs"];
  delete legacy["indexerStatusTipHeight"];
  delete legacy["indexerStatusTipHash"];
  delete legacy["indexerObservedAtUnixMs"];

  await writeFile(statusPath, `${JSON.stringify(legacy)}\n`, "utf8");

  const loaded = await loadMiningRuntimeStatus(statusPath);
  assert.equal(loaded?.foregroundPid, null);
  assert.equal(loaded?.foregroundRunId, null);
  assert.equal(loaded?.foregroundHeartbeatAtUnixMs, null);
  assert.equal(loaded?.cycleStartedAtUnixMs, null);
  assert.equal(loaded?.phaseEnteredAtUnixMs, null);
  assert.equal(loaded?.indexerStatusTipHeight, null);
  assert.equal(loaded?.indexerStatusTipHash, null);
  assert.equal(loaded?.indexerObservedAtUnixMs, null);
});

test("foreground mining heartbeat writes preserve newer full cycle snapshots", async (t) => {
  const dir = await createTrackedTempDirectory(t, "cogcoin-mining-runtime-artifacts-heartbeat-ordering");
  const statusPath = join(dir, "status.json");

  await saveMiningRuntimeStatus(statusPath, createMiningRuntimeStatus({
    updatedAtUnixMs: 10_000,
    runMode: "foreground",
    foregroundPid: 123,
    foregroundRunId: "run-1",
    foregroundHeartbeatAtUnixMs: 10_000,
    cycleStartedAtUnixMs: 9_000,
    phaseEnteredAtUnixMs: 9_500,
    currentPhase: "scoring",
    targetBlockHeight: 101,
    currentDomainName: "cogdemo",
    lastError: "full snapshot error",
    note: "full snapshot note",
  }));

  await saveForegroundMiningHeartbeatStatus({
    statusPath,
    foregroundPid: 123,
    foregroundRunId: "run-1",
    heartbeatAtUnixMs: 10_500,
  });

  let loaded = await loadMiningRuntimeStatus(statusPath);
  assert.equal(loaded?.updatedAtUnixMs, 10_000);
  assert.equal(loaded?.foregroundHeartbeatAtUnixMs, 10_500);
  assert.equal(loaded?.cycleStartedAtUnixMs, 9_000);
  assert.equal(loaded?.phaseEnteredAtUnixMs, 9_500);
  assert.equal(loaded?.currentPhase, "scoring");
  assert.equal(loaded?.targetBlockHeight, 101);
  assert.equal(loaded?.currentDomainName, "cogdemo");
  assert.equal(loaded?.lastError, "full snapshot error");
  assert.equal(loaded?.note, "full snapshot note");

  await saveMiningRuntimeStatus(statusPath, createMiningRuntimeStatus({
    updatedAtUnixMs: 11_000,
    runMode: "foreground",
    foregroundPid: 123,
    foregroundRunId: "run-1",
    foregroundHeartbeatAtUnixMs: 11_000,
    cycleStartedAtUnixMs: 10_900,
    phaseEnteredAtUnixMs: 11_000,
    currentPhase: "publishing",
    targetBlockHeight: 102,
    currentDomainName: "newdomain",
    lastError: null,
    note: "new full snapshot",
  }));
  await saveForegroundMiningHeartbeatStatus({
    statusPath,
    foregroundPid: 123,
    foregroundRunId: "run-1",
    heartbeatAtUnixMs: 10_750,
  });

  loaded = await loadMiningRuntimeStatus(statusPath);
  assert.equal(loaded?.updatedAtUnixMs, 11_000);
  assert.equal(loaded?.foregroundHeartbeatAtUnixMs, 11_000);
  assert.equal(loaded?.cycleStartedAtUnixMs, 10_900);
  assert.equal(loaded?.phaseEnteredAtUnixMs, 11_000);
  assert.equal(loaded?.currentPhase, "publishing");
  assert.equal(loaded?.targetBlockHeight, 102);
  assert.equal(loaded?.currentDomainName, "newdomain");
  assert.equal(loaded?.note, "new full snapshot");
});
