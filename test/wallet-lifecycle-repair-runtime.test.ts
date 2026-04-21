import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";

import {
  ensureIndexerDatabaseHealthy,
  stopRecordedManagedProcess,
  verifyIndexerPostRepairHealth,
} from "../src/wallet/lifecycle/repair-runtime.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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

    if (signal === 0 || signal === undefined) {
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

test("ensureIndexerDatabaseHealthy deletes a corrupt database when reset is allowed", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-repair-runtime");
  const databasePath = `${homeDirectory}/indexer.sqlite`;

  await writeFile(databasePath, "not a sqlite database", "utf8");

  const reset = await ensureIndexerDatabaseHealthy({
    databasePath,
    dataDir: homeDirectory,
    walletRootId: "wallet-root",
    resetIfNeeded: true,
  });

  assert.equal(reset, true);
  assert.equal(await pathExists(databasePath), false);
});

test("stopRecordedManagedProcess sends TERM to a live pid and waits for exit", async (t) => {
  const killLog = installProcessKillMock(t, [8_111]);

  await stopRecordedManagedProcess(8_111, "managed_process_stop_timeout");

  assert.deepEqual(
    killLog.calls.map((call) => [call.pid, call.signal]),
    [
      [8_111, 0],
      [8_111, "SIGTERM"],
      [8_111, 0],
    ],
  );
});

test("verifyIndexerPostRepairHealth falls back to probe status when snapshot read fails", async () => {
  const result = await verifyIndexerPostRepairHealth({
    daemon: {
      async openSnapshot() {
        throw new Error("indexer_snapshot_unavailable");
      },
    } as any,
    probeIndexerDaemon: async () => ({
      compatibility: "compatible",
      status: {
        daemonInstanceId: "daemon-1",
        heartbeatAtUnixMs: 9_995,
        state: "starting",
      },
      client: {
        async close() {},
      },
      error: null,
    }) as any,
    dataDir: "/tmp",
    walletRootId: "wallet-root",
    nowUnixMs: 10_000,
  });

  assert.deepEqual(result, {
    health: "starting",
    daemonInstanceId: "daemon-1",
  });
});
