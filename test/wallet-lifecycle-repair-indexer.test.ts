import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  INDEXER_DAEMON_SCHEMA_VERSION,
  INDEXER_DAEMON_SERVICE_API_VERSION,
} from "../src/bitcoind/types.js";
import { resolveManagedServicePaths } from "../src/bitcoind/service-paths.js";
import { resolveWalletRepairContext } from "../src/wallet/lifecycle/context.js";
import { repairManagedIndexerStage } from "../src/wallet/lifecycle/repair-indexer.js";
import { createWalletLifecycleFixture } from "./wallet-lifecycle-test-helpers.js";

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createFakeIndexerDaemon(walletRootId: string, daemonInstanceId: string) {
  const handle = {
    token: "snapshot-token",
    expiresAtUnixMs: 10_000,
    serviceApiVersion: INDEXER_DAEMON_SERVICE_API_VERSION,
    binaryVersion: "test-binary",
    buildId: "build-1",
    walletRootId,
    daemonInstanceId,
    schemaVersion: INDEXER_DAEMON_SCHEMA_VERSION,
    processId: 77_777,
    startedAtUnixMs: 1,
    state: "synced",
    heartbeatAtUnixMs: 5_000,
    rpcReachable: true,
    coreBestHeight: 10,
    coreBestHash: "ab".repeat(32),
    appliedTipHeight: 10,
    appliedTipHash: "cd".repeat(32),
    snapshotSeq: "seq-1",
    backlogBlocks: 0,
    reorgDepth: 0,
    lastAppliedAtUnixMs: 4_000,
    activeSnapshotCount: 1,
    lastError: null,
    tipHeight: 10,
    tipHash: "cd".repeat(32),
    openedAtUnixMs: 4_500,
  } as const;

  return {
    async getStatus() {
      return {
        serviceApiVersion: INDEXER_DAEMON_SERVICE_API_VERSION,
        binaryVersion: "test-binary",
        buildId: "build-1",
        updatedAtUnixMs: 5_000,
        walletRootId,
        daemonInstanceId,
        schemaVersion: INDEXER_DAEMON_SCHEMA_VERSION,
        state: "synced",
        processId: 77_777,
        startedAtUnixMs: 1,
        heartbeatAtUnixMs: 5_000,
        ipcReady: true,
        rpcReachable: true,
        coreBestHeight: 10,
        coreBestHash: "ab".repeat(32),
        appliedTipHeight: 10,
        appliedTipHash: "cd".repeat(32),
        snapshotSeq: "seq-1",
        backlogBlocks: 0,
        reorgDepth: 0,
        lastAppliedAtUnixMs: 4_000,
        activeSnapshotCount: 0,
        lastError: null,
      };
    },
    async openSnapshot() {
      return handle;
    },
    async readSnapshot(token: string) {
      assert.equal(token, handle.token);
      return {
        token: handle.token,
        stateBase64: "",
        serviceApiVersion: INDEXER_DAEMON_SERVICE_API_VERSION,
        schemaVersion: INDEXER_DAEMON_SCHEMA_VERSION,
        walletRootId,
        daemonInstanceId,
        processId: handle.processId,
        startedAtUnixMs: handle.startedAtUnixMs,
        snapshotSeq: handle.snapshotSeq,
        tipHeight: handle.tipHeight,
        tipHash: handle.tipHash,
        openedAtUnixMs: handle.openedAtUnixMs,
        tip: {
          height: 10,
          blockHashHex: handle.tipHash,
          previousHashHex: "ef".repeat(32),
          stateHashHex: "12".repeat(32),
        },
        expiresAtUnixMs: handle.expiresAtUnixMs,
      };
    },
    async closeSnapshot() {},
    async resumeBackgroundFollow() {},
    async close() {},
  };
}

test("repairManagedIndexerStage clears stale artifacts, resets a corrupt DB, and verifies synced health", async (t) => {
  const fixture = await createWalletLifecycleFixture(t);
  const servicePaths = resolveManagedServicePaths(fixture.dataDir, fixture.state!.walletRootId);

  await writeJsonFile(servicePaths.indexerDaemonStatusPath, {
    daemonInstanceId: "daemon-stale",
  });
  await writeFile(fixture.databasePath, "not a sqlite database", "utf8");

  const context = resolveWalletRepairContext({
    dataDir: fixture.dataDir,
    databasePath: fixture.databasePath,
    provider: fixture.provider,
    paths: fixture.paths,
    assumeYes: true,
    nowUnixMs: 10_000,
    probeIndexerDaemon: async () => ({
      compatibility: "unreachable",
      status: null,
      client: null,
      error: null,
    }) as any,
    attachIndexerDaemon: async () => createFakeIndexerDaemon(fixture.state!.walletRootId, "daemon-after") as any,
  });

  const result = await repairManagedIndexerStage({
    context,
    servicePaths,
    state: fixture.state!,
  });

  assert.deepEqual(result, {
    resetIndexerDatabase: true,
    indexerDaemonAction: "cleared-stale-artifacts",
    indexerCompatibilityIssue: "none",
    indexerPostRepairHealth: "synced",
  });
});

test("repairManagedIndexerStage preserves daemon identity when no restart was needed", async (t) => {
  const fixture = await createWalletLifecycleFixture(t);
  const servicePaths = resolveManagedServicePaths(fixture.dataDir, fixture.state!.walletRootId);
  const compatibleProbe = async () => ({
    compatibility: "compatible",
    status: {
      daemonInstanceId: "daemon-before",
      heartbeatAtUnixMs: 9_999,
      state: "synced",
      processId: 77_777,
    },
    client: {
      async close() {},
    },
    error: null,
  }) as any;
  const context = resolveWalletRepairContext({
    dataDir: fixture.dataDir,
    databasePath: fixture.databasePath,
    provider: fixture.provider,
    paths: fixture.paths,
    assumeYes: true,
    nowUnixMs: 10_000,
    probeIndexerDaemon: compatibleProbe,
    attachIndexerDaemon: async () => createFakeIndexerDaemon(fixture.state!.walletRootId, "daemon-after") as any,
  });

  await assert.rejects(
    repairManagedIndexerStage({
      context,
      servicePaths,
      state: fixture.state!,
    }),
    /indexer_daemon_repair_identity_changed/,
  );
});
