import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { DEFAULT_SNAPSHOT_METADATA } from "../src/bitcoind/bootstrap.js";
import { createBootstrapProgress } from "../src/bitcoind/progress/formatting.js";
import { resolveManagedServicePaths } from "../src/bitcoind/service-paths.js";
import type { ManagedIndexerDaemonStatus } from "../src/bitcoind/types.js";
import { recordBackgroundFollowFailure } from "../src/bitcoind/indexer-daemon/background-follow.js";
import { createIndexerDaemonClient } from "../src/bitcoind/indexer-daemon/client.js";
import { readSnapshotWithRetry } from "../src/bitcoind/indexer-daemon/lifecycle.js";
import {
  readIndexerDaemonStatusForTesting,
  stopIndexerDaemonServiceWithLockHeld,
  writeIndexerDaemonStatusForTesting,
} from "../src/bitcoind/indexer-daemon/process.js";
import { createIndexerDaemonServer } from "../src/bitcoind/indexer-daemon/server.js";
import {
  buildIndexerDaemonStatus,
  createIndexerSnapshotKey,
  deriveIndexerDaemonLeaseState,
} from "../src/bitcoind/indexer-daemon/status.js";
import {
  closeSnapshotLease,
  createSnapshotHandle,
  pruneExpiredSnapshotLeases,
  readSnapshotLease,
  storeSnapshotLease,
} from "../src/bitcoind/indexer-daemon/snapshot-leases.js";
import type {
  IndexerDaemonClient,
  IndexerDaemonRuntimeState,
  IndexerSnapshotHandle,
  IndexerSnapshotPayload,
  LoadedSnapshotMaterial,
} from "../src/bitcoind/indexer-daemon/types.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";

function createRuntimeState(
  overrides: Partial<IndexerDaemonRuntimeState> = {},
): IndexerDaemonRuntimeState {
  return {
    daemonInstanceId: "daemon-1",
    binaryVersion: "1.1.11",
    startedAtUnixMs: 1_700_000_000_000,
    walletRootId: "wallet-root-test",
    snapshots: new Map(),
    state: "starting",
    heartbeatAtUnixMs: 1_700_000_000_000,
    updatedAtUnixMs: 1_700_000_000_000,
    rpcReachable: false,
    coreBestHeight: null,
    coreBestHash: null,
    appliedTipHeight: null,
    appliedTipHash: null,
    snapshotSeqCounter: 1,
    snapshotSeq: "1",
    lastSnapshotKey: undefined,
    lastAppliedAtUnixMs: null,
    lastError: null,
    hasSuccessfulCoreTipRefresh: false,
    backgroundStore: null,
    backgroundClient: null,
    backgroundResumePromise: null,
    backgroundFollowError: null,
    backgroundFollowActive: false,
    bootstrapPhase: "paused",
    bootstrapProgress: createBootstrapProgress("paused", DEFAULT_SNAPSHOT_METADATA),
    cogcoinSyncHeight: null,
    cogcoinSyncTargetHeight: null,
    ...overrides,
  };
}

function createManagedIndexerDaemonStatus(
  walletRootId: string,
  overrides: Partial<ManagedIndexerDaemonStatus> = {},
): ManagedIndexerDaemonStatus {
  return {
    serviceApiVersion: "cogcoin/indexer-ipc/v1",
    binaryVersion: "1.1.11",
    buildId: null,
    updatedAtUnixMs: 1_700_000_000_100,
    walletRootId,
    daemonInstanceId: "daemon-1",
    schemaVersion: "cogcoin/indexer-db/v1",
    state: "synced",
    processId: 4321,
    startedAtUnixMs: 1_700_000_000_000,
    heartbeatAtUnixMs: 1_700_000_000_100,
    ipcReady: true,
    rpcReachable: true,
    coreBestHeight: 100,
    coreBestHash: "11".repeat(32),
    appliedTipHeight: 100,
    appliedTipHash: "11".repeat(32),
    snapshotSeq: "1",
    backlogBlocks: 0,
    reorgDepth: null,
    lastAppliedAtUnixMs: 1_700_000_000_090,
    activeSnapshotCount: 0,
    lastError: null,
    backgroundFollowActive: true,
    bootstrapPhase: "follow_tip",
    bootstrapProgress: null,
    cogcoinSyncHeight: 100,
    cogcoinSyncTargetHeight: 100,
    ...overrides,
  };
}

function createSnapshotHandleFixture(
  overrides: Partial<IndexerSnapshotHandle> = {},
): IndexerSnapshotHandle {
  return {
    token: "lease-1",
    expiresAtUnixMs: Date.now() + 5_000,
    serviceApiVersion: "cogcoin/indexer-ipc/v1",
    binaryVersion: "1.1.11",
    buildId: null,
    walletRootId: "wallet-root-test",
    daemonInstanceId: "daemon-1",
    schemaVersion: "cogcoin/indexer-db/v1",
    processId: 1234,
    startedAtUnixMs: 1_700_000_000_000,
    state: "synced",
    heartbeatAtUnixMs: 1_700_000_000_100,
    rpcReachable: true,
    coreBestHeight: 100,
    coreBestHash: "11".repeat(32),
    appliedTipHeight: 100,
    appliedTipHash: "11".repeat(32),
    snapshotSeq: "1",
    backlogBlocks: 0,
    reorgDepth: null,
    lastAppliedAtUnixMs: 1_700_000_000_090,
    activeSnapshotCount: 1,
    lastError: null,
    backgroundFollowActive: true,
    bootstrapPhase: "follow_tip",
    bootstrapProgress: null,
    cogcoinSyncHeight: 100,
    cogcoinSyncTargetHeight: 100,
    tipHeight: 100,
    tipHash: "11".repeat(32),
    openedAtUnixMs: 1_700_000_000_100,
    ...overrides,
  };
}

function createSnapshotPayloadFixture(
  overrides: Partial<IndexerSnapshotPayload> = {},
): IndexerSnapshotPayload {
  return {
    token: "lease-1",
    stateBase64: "state-base64",
    serviceApiVersion: "cogcoin/indexer-ipc/v1",
    schemaVersion: "cogcoin/indexer-db/v1",
    walletRootId: "wallet-root-test",
    daemonInstanceId: "daemon-1",
    processId: 1234,
    startedAtUnixMs: 1_700_000_000_000,
    snapshotSeq: "1",
    tipHeight: 100,
    tipHash: "11".repeat(32),
    openedAtUnixMs: 1_700_000_000_100,
    tip: {
      height: 100,
      blockHashHex: "11".repeat(32),
      previousHashHex: "00".repeat(32),
      stateHashHex: null,
    },
    expiresAtUnixMs: Date.now() + 5_000,
    ...overrides,
  };
}

function installProcessKillMock(
  t: TestContext,
  options: {
    livePids?: readonly number[];
    stubbornPids?: readonly number[];
  } = {},
) {
  const originalKill = process.kill;
  const alive = new Set([
    ...(options.livePids ?? []),
    ...(options.stubbornPids ?? []),
  ]);
  const stubborn = new Set(options.stubbornPids ?? []);
  const timeline: string[] = [];

  (process as typeof process & { kill: typeof process.kill }).kill = ((pid: number, signal?: number | NodeJS.Signals) => {
    if (pid === process.pid) {
      return true;
    }

    if (!alive.has(pid)) {
      const error = Object.assign(new Error("process not found"), {
        code: "ESRCH",
      });
      throw error;
    }

    if (signal === undefined || signal === 0) {
      return true;
    }

    if (signal === "SIGTERM") {
      timeline.push(`SIGTERM:${pid}`);
      if (!stubborn.has(pid)) {
        alive.delete(pid);
      }
      return true;
    }

    if (signal === "SIGKILL") {
      timeline.push(`SIGKILL:${pid}`);
      alive.delete(pid);
      return true;
    }

    return true;
  }) as typeof process.kill;

  t.after(() => {
    (process as typeof process & { kill: typeof process.kill }).kill = originalKill;
  });

  return { timeline };
}

async function listenServer(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function sendRawSocketLine(socketPath: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";

    socket.once("connect", () => {
      socket.write(line);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex >= 0) {
        const response = buffer.slice(0, newlineIndex);
        socket.destroy();
        resolve(response);
      }
    });
    socket.once("error", reject);
    socket.once("end", () => {
      if (buffer.length === 0) {
        reject(new Error("connection_closed_without_response"));
      }
    });
  });
}

test("deriveIndexerDaemonLeaseState preserves starting, catching-up, and synced semantics", () => {
  const starting = deriveIndexerDaemonLeaseState({
    coreStatus: {
      rpcReachable: false,
      coreBestHeight: null,
      coreBestHash: null,
      error: "managed_bitcoind_runtime_config_unavailable",
      prerequisiteUnavailable: true,
    },
    appliedTip: null,
    hasSuccessfulCoreTipRefresh: false,
  });
  assert.equal(starting.state, "starting");
  assert.equal(starting.lastError, "managed_bitcoind_runtime_config_unavailable");
  assert.equal(starting.hasSuccessfulCoreTipRefresh, false);

  const catchingUp = deriveIndexerDaemonLeaseState({
    coreStatus: {
      rpcReachable: true,
      coreBestHeight: 101,
      coreBestHash: "22".repeat(32),
      error: null,
      prerequisiteUnavailable: false,
    },
    appliedTip: {
      height: 100,
      blockHashHex: "11".repeat(32),
      previousHashHex: "00".repeat(32),
      stateHashHex: null,
    },
    hasSuccessfulCoreTipRefresh: false,
  });
  assert.equal(catchingUp.state, "catching-up");
  assert.equal(catchingUp.lastError, null);
  assert.equal(catchingUp.hasSuccessfulCoreTipRefresh, true);

  const synced = deriveIndexerDaemonLeaseState({
    coreStatus: {
      rpcReachable: true,
      coreBestHeight: 100,
      coreBestHash: "11".repeat(32),
      error: null,
      prerequisiteUnavailable: false,
    },
    appliedTip: {
      height: 100,
      blockHashHex: "11".repeat(32),
      previousHashHex: "00".repeat(32),
      stateHashHex: null,
    },
    hasSuccessfulCoreTipRefresh: true,
  });
  assert.equal(synced.state, "synced");
  assert.equal(synced.lastError, null);
  assert.equal(synced.hasSuccessfulCoreTipRefresh, true);
});

test("snapshot lease helpers keep rotation and expiry bookkeeping stable", () => {
  const state = createRuntimeState();
  const material: LoadedSnapshotMaterial = {
    token: "lease-1",
    stateBase64: "state-base64",
    tip: {
      height: 100,
      blockHashHex: "11".repeat(32),
      previousHashHex: "00".repeat(32),
      stateHashHex: null,
    },
    expiresAtUnixMs: Date.now() + 5_000,
  };

  const snapshot = storeSnapshotLease({
    state,
    material,
    nowUnixMs: 1_700_000_000_100,
  });
  assert.equal(state.snapshots.size, 1);
  assert.equal(createIndexerSnapshotKey(material.tip), `100:${"11".repeat(32)}:`);

  const handle = createSnapshotHandle({
    snapshot,
    status: buildIndexerDaemonStatus(state),
    binaryVersion: state.binaryVersion,
  });
  assert.equal(handle.activeSnapshotCount, 1);
  assert.equal(handle.tipHeight, 100);

  const payload = readSnapshotLease({
    state,
    token: snapshot.token,
  });
  assert.equal(payload.error, null);
  assert.equal(payload.payload?.token, snapshot.token);

  state.snapshotSeq = "2";
  const rotated = readSnapshotLease({
    state,
    token: snapshot.token,
  });
  assert.equal(rotated.error, "indexer_daemon_snapshot_rotated");
  assert.equal(rotated.changed, true);
  assert.equal(state.snapshots.size, 0);

  const expiredState = createRuntimeState();
  storeSnapshotLease({
    state: expiredState,
    material: {
      ...material,
      token: "lease-expired",
      expiresAtUnixMs: 1,
    },
    nowUnixMs: 1_700_000_000_100,
  });
  assert.equal(pruneExpiredSnapshotLeases(expiredState, Date.now()), true);
  assert.equal(expiredState.snapshots.size, 0);
  assert.equal(closeSnapshotLease(expiredState, "missing"), false);
});

test("recordBackgroundFollowFailure writes failed runtime status with preserved progress semantics", async () => {
  const state = createRuntimeState({
    state: "synced",
    coreBestHeight: 100,
    appliedTipHeight: 99,
    backgroundFollowActive: true,
  });
  const writtenStatuses: ManagedIndexerDaemonStatus[] = [];

  await recordBackgroundFollowFailure({
    state,
    message: "forced resume failure",
    writeStatus: async () => {
      const status = buildIndexerDaemonStatus(state);
      writtenStatuses.push(status);
      return status;
    },
  });

  assert.equal(state.state, "failed");
  assert.equal(state.backgroundFollowActive, false);
  assert.equal(state.lastError, "forced resume failure");
  assert.equal(state.bootstrapPhase, "error");
  assert.equal(state.cogcoinSyncHeight, 99);
  assert.equal(state.cogcoinSyncTargetHeight, 100);
  const written = writtenStatuses.at(-1) ?? null;
  if (written === null) {
    throw new Error("expected status write");
  }
  assert.equal(written.lastError, "forced resume failure");
  assert.equal(written.bootstrapPhase, "error");
});

test("createIndexerDaemonServer returns explicit invalid-json and unknown-method errors", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-indexer-server-owner");
  const socketPath = join(homeDirectory, "indexer.sock");
  const server = createIndexerDaemonServer({
    getStatus: () => createManagedIndexerDaemonStatus("wallet-root-test"),
    openSnapshot: async () => createSnapshotHandleFixture(),
    readSnapshot: async () => createSnapshotPayloadFixture(),
    closeSnapshot: async () => undefined,
    resumeBackgroundFollow: async () => undefined,
  });

  try {
    await listenServer(server, socketPath);

    const invalidResponse = JSON.parse(await sendRawSocketLine(socketPath, "{bad json}\n")) as {
      id: string;
      ok: boolean;
      error?: string;
    };
    assert.equal(invalidResponse.id, "invalid");
    assert.equal(invalidResponse.ok, false);

    const unknownResponse = JSON.parse(await sendRawSocketLine(socketPath, `${JSON.stringify({
      id: "req-1",
      method: "Nope",
    })}\n`)) as {
      id: string;
      ok: boolean;
      error?: string;
    };
    assert.equal(unknownResponse.id, "req-1");
    assert.equal(unknownResponse.ok, false);
    assert.equal(unknownResponse.error, "indexer_daemon_unknown_method_Nope");
  } finally {
    await closeServer(server);
  }
});

test("createIndexerDaemonClient matches request ids and times out when a daemon stays silent", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-indexer-client-owner");
  const socketPath = join(homeDirectory, "indexer.sock");
  const status = createManagedIndexerDaemonStatus("wallet-root-test");
  const matchingServer = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      const line = chunk.toString("utf8").trim();
      const request = JSON.parse(line) as { id: string };
      socket.write(`${JSON.stringify({ id: "other", ok: true, result: { ignored: true } })}\n`);
      socket.write(`${JSON.stringify({ id: request.id, ok: true, result: status })}\n`);
    });
  });

  try {
    await listenServer(matchingServer, socketPath);
    const client = createIndexerDaemonClient(socketPath);
    assert.equal((await client.getStatus()).daemonInstanceId, "daemon-1");
    await client.close();
  } finally {
    await closeServer(matchingServer);
  }

  const timeoutSocketPath = join(homeDirectory, "timeout.sock");
  const timeoutConnections = new Set<net.Socket>();
  const timeoutServer = net.createServer((socket) => {
    timeoutConnections.add(socket);
    socket.on("close", () => {
      timeoutConnections.delete(socket);
    });
    // Keep the connection open without responding.
  });

  try {
    await listenServer(timeoutServer, timeoutSocketPath);
    const client = createIndexerDaemonClient(timeoutSocketPath, {
      serviceLifetime: "persistent",
      ownership: "attached",
      requestTimeoutMs: 10,
      resumeBackgroundFollowRequestTimeoutMs: 10,
    });
    await assert.rejects(
      async () => client.getStatus(),
      /indexer_daemon_request_timeout/,
    );
    await client.close();
  } finally {
    for (const socket of timeoutConnections) {
      socket.destroy();
    }
    await closeServer(timeoutServer);
  }
});

test("readSnapshotWithRetry retries once on rotated leases and returns the second valid snapshot", async () => {
  let openCount = 0;
  const daemon: IndexerDaemonClient = {
    async getStatus() {
      throw new Error("unused");
    },
    async openSnapshot() {
      openCount += 1;
      return createSnapshotHandleFixture({
        token: `lease-${openCount}`,
      });
    },
    async readSnapshot(token: string) {
      if (token === "lease-1") {
        throw new Error("indexer_daemon_snapshot_rotated");
      }

      return createSnapshotPayloadFixture({
        token,
      });
    },
    async closeSnapshot() {
      return undefined;
    },
    async resumeBackgroundFollow() {
      throw new Error("unused");
    },
    async close() {
      return undefined;
    },
  };

  const lease = await readSnapshotWithRetry(daemon, "wallet-root-test");
  assert.equal(lease.payload.token, "lease-2");
  assert.equal(lease.status.daemonInstanceId, "daemon-1");
});

test("stopIndexerDaemonServiceWithLockHeld preserves TERM then KILL semantics and clears runtime artifacts", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-indexer-process-owner");
  const walletRootId = "wallet-root-test";
  const paths = resolveManagedServicePaths(homeDirectory, walletRootId);
  await mkdir(paths.indexerServiceRoot, { recursive: true });
  await writeIndexerDaemonStatusForTesting({
    dataDir: homeDirectory,
    walletRootId,
  }, createManagedIndexerDaemonStatus(walletRootId, {
    processId: 4321,
  }));
  await writeFile(paths.indexerDaemonSocketPath, "");
  const { timeline } = installProcessKillMock(t, {
    stubbornPids: [4321],
  });

  const result = await stopIndexerDaemonServiceWithLockHeld({
    dataDir: homeDirectory,
    walletRootId,
    processId: 4321,
    shutdownTimeoutMs: 1,
  });

  assert.equal(result.status, "stopped");
  assert.deepEqual(timeline, ["SIGTERM:4321", "SIGKILL:4321"]);
  assert.equal(await readIndexerDaemonStatusForTesting({ dataDir: homeDirectory, walletRootId }), null);
  await assert.rejects(
    async () => readFile(paths.indexerDaemonSocketPath, "utf8"),
    /ENOENT/,
  );
});
