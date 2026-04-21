import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  cleanupMiningForRepair,
  createStoppedMiningRuntimeSnapshotForRepair,
  resumeBackgroundMiningAfterRepair,
} from "../src/wallet/lifecycle/repair-mining.js";
import { saveClientConfig } from "../src/wallet/mining/config.js";
import { loadMiningRuntimeStatus, saveMiningRuntimeStatus } from "../src/wallet/mining/runtime-artifacts.js";
import { createWalletSecretReference } from "../src/wallet/state/provider.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { createMiningRuntimeStatus } from "./current-model-helpers.js";
import {
  createDerivedWalletState,
  createWalletLifecycleFixture,
} from "./wallet-lifecycle-test-helpers.js";

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function installProcessKillMock(t: TestContext, livePids: readonly number[]) {
  const originalKill = process.kill;
  const alive = new Set(livePids);
  const calls: Array<{ pid: number; signal: number | NodeJS.Signals | undefined }> = [];

  (process as typeof process & {
    kill: typeof process.kill;
  }).kill = ((pid: number, signal?: number | NodeJS.Signals) => {
    calls.push({ pid, signal });

    if (!alive.has(pid)) {
      const error = Object.assign(new Error("process not found"), {
        code: "ESRCH",
      });
      throw error;
    }

    if (signal === undefined || signal === 0) {
      return true;
    }

    if (signal === "SIGTERM" || signal === "SIGKILL") {
      alive.delete(pid);
      return true;
    }

    return true;
  }) as typeof process.kill;

  t.after(() => {
    (process as typeof process & {
      kill: typeof process.kill;
    }).kill = originalKill;
  });

  return {
    calls,
  };
}

test("createStoppedMiningRuntimeSnapshotForRepair carries live publish context into the stopped snapshot", () => {
  const state = createDerivedWalletState();
  state.miningState = {
    ...state.miningState,
    runMode: "background",
    state: "paused",
    livePublishInMempool: true,
    currentPublishState: "broadcasting",
    currentTxid: "aa".repeat(32),
  };

  const snapshot = createStoppedMiningRuntimeSnapshotForRepair({
    state,
    snapshot: createMiningRuntimeStatus({
      runMode: "background",
      currentPhase: "publishing",
      livePublishInMempool: true,
    }),
    nowUnixMs: 55,
  });

  assert.equal(snapshot.runMode, "stopped");
  assert.equal(snapshot.currentPhase, "idle");
  assert.equal(snapshot.currentPublishState, "broadcasting");
  assert.equal(snapshot.currentTxid, "aa".repeat(32));
  assert.equal(
    snapshot.note,
    "Background mining stopped for wallet repair. The last mining transaction may still confirm from mempool.",
  );
});

test("cleanupMiningForRepair removes live mining artifacts and writes a stopped runtime snapshot", async (t) => {
  const state = createDerivedWalletState();
  state.miningState = {
    ...state.miningState,
    runMode: "background",
    state: "live",
  };
  const fixture = await createWalletLifecycleFixture(t, { state });
  const killLog = installProcessKillMock(t, [9_111]);

  await writeJsonFile(fixture.paths.miningControlLockPath, {
    processId: 9_111,
    acquiredAtUnixMs: 1,
    purpose: "mine-foreground",
    walletRootId: state.walletRootId,
  });
  await writeJsonFile(join(fixture.paths.miningRoot, "generation-request.json"), {
    schemaVersion: 1,
    requestId: "repair-1",
    requestedAtUnixMs: 1,
    reason: "wallet-repair",
  });
  await writeJsonFile(join(fixture.paths.miningRoot, "generation-activity.json"), {
    schemaVersion: 1,
    generationActive: true,
    generationOwnerPid: 9_111,
    runId: "run-1",
    generationStartedAtUnixMs: 1,
    generationEndedAtUnixMs: null,
    acknowledgedRequestId: null,
    updatedAtUnixMs: 1,
  });
  await saveMiningRuntimeStatus(
    fixture.paths.miningStatusPath,
    createMiningRuntimeStatus({
      runMode: "background",
      backgroundWorkerPid: 9_111,
      backgroundWorkerRunId: "run-1",
      currentPhase: "generating",
      miningState: "live",
    }),
  );

  const result = await cleanupMiningForRepair({
    paths: fixture.paths,
    state,
    snapshot: await loadMiningRuntimeStatus(fixture.paths.miningStatusPath),
    nowUnixMs: 123,
  });

  assert.equal(result.preRepairRunMode, "background");
  assert.equal(
    killLog.calls.filter((call) => call.pid === 9_111 && call.signal === "SIGTERM").length,
    1,
  );
  const runtime = await loadMiningRuntimeStatus(fixture.paths.miningStatusPath);
  assert.equal(runtime?.runMode, "stopped");
  assert.equal(runtime?.backgroundWorkerPid, null);
});

test("resumeBackgroundMiningAfterRepair restarts background mining when post-repair health is ready", async (t) => {
  const fixture = await createWalletLifecycleFixture(t, {
    state: createDerivedWalletState(),
  });
  const secretReference = createWalletSecretReference(fixture.state!.walletRootId);
  let startCalls = 0;

  await saveClientConfig({
    path: fixture.paths.clientConfigPath,
    provider: fixture.provider,
    secretReference,
    config: {
      schemaVersion: 1,
      mining: {
        builtIn: {
          provider: "openai",
          apiKey: "test-api-key",
          extraPrompt: null,
          modelOverride: "gpt-5.4-mini",
          modelSelectionSource: "catalog",
          updatedAtUnixMs: 1,
        },
        domainExtraPrompts: {},
      },
    },
  });

  const result = await resumeBackgroundMiningAfterRepair({
    miningPreRepairRunMode: "background",
    provider: fixture.provider,
    paths: fixture.paths,
    repairedState: fixture.state!,
    bitcoindPostRepairHealth: "ready",
    indexerPostRepairHealth: "synced",
    dataDir: fixture.dataDir,
    databasePath: fixture.databasePath,
    startBackgroundMining: async () => {
      startCalls += 1;
      return {
        started: true,
        snapshot: createMiningRuntimeStatus({
          runMode: "background",
        }),
      } as any;
    },
  });

  assert.equal(startCalls, 1);
  assert.deepEqual(result, {
    miningResumeAction: "resumed-background",
    miningPostRepairRunMode: "background",
    miningResumeError: null,
  });
});
