import { randomUUID } from "node:crypto";
import net from "node:net";
import { access, constants, mkdir, readFile, rm } from "node:fs/promises";

import { loadBundledGenesisParameters, serializeIndexerState } from "@cogcoin/indexer";

import { openManagedBitcoindClientInternal } from "./client.js";
import { openClient } from "../client.js";
import { openSqliteStore } from "../sqlite/index.js";
import { writeRuntimeStatusFile } from "../wallet/fs/status-file.js";
import { createRpcClient } from "./node.js";
import { normalizeCogcoinProcessingStartHeight } from "./processing-start-height.js";
import { resolveManagedServicePaths, UNINITIALIZED_WALLET_ROOT_ID } from "./service-paths.js";
import type { ClientTip } from "../types.js";
import {
  INDEXER_DAEMON_SCHEMA_VERSION,
  INDEXER_DAEMON_SERVICE_API_VERSION,
  type ManagedBitcoindObservedStatus,
  type ManagedBitcoindClient,
  type ManagedBitcoindRuntimeConfig,
  type ManagedIndexerSnapshotIdentity,
  type ManagedIndexerDaemonState,
  type ManagedIndexerDaemonStatus,
} from "./types.js";
import type { DaemonRequest, DaemonResponse, IndexerSnapshotHandle, IndexerSnapshotPayload } from "./indexer-daemon.js";

const SNAPSHOT_TTL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 1_000;

interface LoadedSnapshotMaterial {
  token: string;
  stateBase64: string;
  tip: ClientTip | null;
  expiresAtUnixMs: number;
}

interface LoadedSnapshot extends LoadedSnapshotMaterial, ManagedIndexerSnapshotIdentity {}

interface CoreTipStatus {
  rpcReachable: boolean;
  coreBestHeight: number | null;
  coreBestHash: string | null;
  error: string | null;
  prerequisiteUnavailable: boolean;
}

interface IndexedTipStatus {
  appliedTip: ClientTip | null;
  error: string | null;
  schemaMismatch: boolean;
}

function parseArg(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));

  if (!value) {
    throw new Error(`indexer_daemon_missing_arg_${name}`);
  }

  return value.slice(prefix.length);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function readManagedBitcoindStatus(
  paths: ReturnType<typeof resolveManagedServicePaths>,
): Promise<ManagedBitcoindObservedStatus | null> {
  return readJsonFile<ManagedBitcoindObservedStatus>(paths.bitcoindStatusPath);
}

async function readPackageVersionFromDisk(): Promise<string> {
  try {
    const raw = await readFile(new URL("../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function createSnapshotKey(appliedTip: ClientTip | null): string {
  return appliedTip === null
    ? "__null__"
    : [
      appliedTip.height,
      appliedTip.blockHashHex,
      appliedTip.stateHashHex ?? "",
    ].join(":");
}

function createManagedBitcoindCookieUnavailableMessage(cookieFile: string): string {
  return `The managed Bitcoin RPC cookie file is unavailable at ${cookieFile} while preparing getblockchaininfo. The managed node is not running or is shutting down.`;
}

async function readCoreTipStatus(paths: ReturnType<typeof resolveManagedServicePaths>): Promise<CoreTipStatus> {
  const runtimeConfig = await readJsonFile<ManagedBitcoindRuntimeConfig>(paths.bitcoindRuntimeConfigPath).catch(() => null);

  if (runtimeConfig?.rpc === undefined || runtimeConfig.rpc === null) {
    return {
      rpcReachable: false,
      coreBestHeight: null,
      coreBestHash: null,
      error: "managed_bitcoind_runtime_config_unavailable",
      prerequisiteUnavailable: true,
    };
  }

  try {
    await access(runtimeConfig.rpc.cookieFile, constants.R_OK);
  } catch {
    return {
      rpcReachable: false,
      coreBestHeight: null,
      coreBestHash: null,
      error: createManagedBitcoindCookieUnavailableMessage(runtimeConfig.rpc.cookieFile),
      prerequisiteUnavailable: true,
    };
  }

  try {
    const rpc = createRpcClient(runtimeConfig.rpc);
    const info = await rpc.getBlockchainInfo();
    return {
      rpcReachable: true,
      coreBestHeight: info.blocks,
      coreBestHash: info.bestblockhash,
      error: null,
      prerequisiteUnavailable: false,
    };
  } catch (error) {
    return {
      rpcReachable: false,
      coreBestHeight: null,
      coreBestHash: null,
      error: error instanceof Error ? error.message : String(error),
      prerequisiteUnavailable: false,
    };
  }
}

async function readAppliedTipStatus(databasePath: string): Promise<IndexedTipStatus> {
  try {
    const store = await openSqliteStore({ filename: databasePath });

    try {
      const client = await openClient({ store });

      try {
        return {
          appliedTip: await client.getTip(),
          error: null,
          schemaMismatch: false,
        };
      } finally {
        await client.close();
      }
    } finally {
      await store.close().catch(() => undefined);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      appliedTip: null,
      error: message,
      schemaMismatch: message === "sqlite_store_schema_version_unsupported",
    };
  }
}

async function loadSnapshot(databasePath: string): Promise<LoadedSnapshotMaterial> {
  const store = await openSqliteStore({ filename: databasePath });

  try {
    const client = await openClient({ store });

    try {
      const [tip, state] = await Promise.all([client.getTip(), client.getState()]);
      return {
        token: randomUUID(),
        stateBase64: Buffer.from(serializeIndexerState(state)).toString("base64"),
        tip,
        expiresAtUnixMs: Date.now() + SNAPSHOT_TTL_MS,
      };
    } finally {
      await client.close();
    }
  } finally {
    await store.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const dataDir = parseArg("data-dir");
  const databasePath = parseArg("database-path");
  const walletRootId = parseArg("wallet-root-id") || UNINITIALIZED_WALLET_ROOT_ID;
  const paths = resolveManagedServicePaths(dataDir, walletRootId);
  const daemonInstanceId = randomUUID();
  const binaryVersion = await readPackageVersionFromDisk();
  const genesisParameters = await loadBundledGenesisParameters();
  const startedAtUnixMs = Date.now();
  const snapshots = new Map<string, LoadedSnapshot>();
  let state: ManagedIndexerDaemonState = "starting";
  let heartbeatAtUnixMs = startedAtUnixMs;
  let updatedAtUnixMs = startedAtUnixMs;
  let rpcReachable = false;
  let coreBestHeight: number | null = null;
  let coreBestHash: string | null = null;
  let appliedTipHeight: number | null = null;
  let appliedTipHash: string | null = null;
  let snapshotSeqCounter = 0;
  let snapshotSeq: string | null = null;
  let lastSnapshotKey: string | undefined;
  let lastAppliedAtUnixMs: number | null = null;
  let lastError: string | null = null;
  let hasSuccessfulCoreTipRefresh = false;
  let backgroundStore: Awaited<ReturnType<typeof openSqliteStore>> | null = null;
  let backgroundClient: ManagedBitcoindClient | null = null;
  let backgroundResumePromise: Promise<void> | null = null;

  await mkdir(paths.indexerServiceRoot, { recursive: true });
  await rm(paths.indexerDaemonSocketPath, { force: true }).catch(() => undefined);

  const observeAppliedTip = (appliedTip: ClientTip | null, now: number) => {
    appliedTipHeight = appliedTip?.height ?? null;
    appliedTipHash = appliedTip?.blockHashHex ?? null;
    const snapshotKey = createSnapshotKey(appliedTip);

    if (lastSnapshotKey !== snapshotKey) {
      snapshotSeqCounter += 1;
      snapshotSeq = String(snapshotSeqCounter);
      lastSnapshotKey = snapshotKey;
      lastAppliedAtUnixMs = now;
    }
  };

  const deriveLeaseState = (coreStatus: CoreTipStatus, appliedTip: ClientTip | null): {
    state: ManagedIndexerDaemonState;
    lastError: string | null;
  } => {
    if (coreStatus.error !== null) {
      return {
        state: coreStatus.prerequisiteUnavailable && !hasSuccessfulCoreTipRefresh ? "starting" : "failed",
        lastError: coreStatus.error,
      };
    }

    hasSuccessfulCoreTipRefresh = true;

    if (
      coreStatus.coreBestHeight !== null
      && appliedTip?.height !== undefined
      && coreStatus.coreBestHash !== null
      && appliedTip?.blockHashHex !== undefined
    ) {
      return {
        state: coreStatus.coreBestHeight === appliedTip.height && coreStatus.coreBestHash === appliedTip.blockHashHex
          ? "synced"
          : "catching-up",
        lastError: null,
      };
    }

    return {
      state: "starting",
      lastError: null,
    };
  };

  const buildStatus = (): ManagedIndexerDaemonStatus => ({
    serviceApiVersion: INDEXER_DAEMON_SERVICE_API_VERSION,
    binaryVersion,
    buildId: null,
    updatedAtUnixMs,
    walletRootId,
    daemonInstanceId,
    schemaVersion: INDEXER_DAEMON_SCHEMA_VERSION,
    state,
    processId: process.pid ?? null,
    startedAtUnixMs,
    heartbeatAtUnixMs,
    ipcReady: true,
    rpcReachable,
    coreBestHeight,
    coreBestHash,
    appliedTipHeight,
    appliedTipHash,
    snapshotSeq,
    backlogBlocks:
      coreBestHeight === null || appliedTipHeight === null
        ? null
        : Math.max(coreBestHeight - appliedTipHeight, 0),
    reorgDepth: null,
    lastAppliedAtUnixMs,
    activeSnapshotCount: snapshots.size,
    lastError,
  });

  const writeStatus = async (): Promise<ManagedIndexerDaemonStatus> => {
    const status = buildStatus();
    await writeRuntimeStatusFile(paths.indexerDaemonStatusPath, status);
    return status;
  };

  const refreshStatus = async (): Promise<ManagedIndexerDaemonStatus> => {
    const now = Date.now();
    heartbeatAtUnixMs = now;
    updatedAtUnixMs = now;

    const [coreStatus, indexedStatus] = await Promise.all([
      readCoreTipStatus(paths),
      readAppliedTipStatus(databasePath),
    ]);
    rpcReachable = coreStatus.rpcReachable;
    coreBestHeight = coreStatus.coreBestHeight;
    coreBestHash = coreStatus.coreBestHash;
    observeAppliedTip(indexedStatus.appliedTip, now);

    if (indexedStatus.schemaMismatch) {
      state = "schema-mismatch";
      lastError = indexedStatus.error;
      return writeStatus();
    }

    if (indexedStatus.error !== null) {
      state = "failed";
      lastError = indexedStatus.error;
      return writeStatus();
    }

    const leaseState = deriveLeaseState(coreStatus, indexedStatus.appliedTip);
    state = leaseState.state;
    lastError = leaseState.lastError;

    return writeStatus();
  };

  const pauseBackgroundFollow = async (): Promise<void> => {
    const pendingResume = backgroundResumePromise;
    backgroundResumePromise = null;
    await pendingResume?.catch(() => undefined);

    const client = backgroundClient;
    const store = backgroundStore;
    backgroundClient = null;
    backgroundStore = null;

    await client?.close().catch(() => undefined);
    await store?.close().catch(() => undefined);
  };

  const resumeBackgroundFollow = async (): Promise<void> => {
    if (backgroundClient !== null) {
      return;
    }

    if (backgroundResumePromise !== null) {
      return backgroundResumePromise;
    }

    backgroundResumePromise = (async () => {
      const bitcoindStatus = await readManagedBitcoindStatus(paths);
      const store = await openSqliteStore({ filename: databasePath });
      const chain = bitcoindStatus?.chain ?? "main";
      const startHeight = normalizeCogcoinProcessingStartHeight({
        chain,
        startHeight: bitcoindStatus?.startHeight,
        genesisParameters,
      });

      try {
        const client = await openManagedBitcoindClientInternal({
          store,
          dataDir,
          chain,
          startHeight,
          walletRootId,
          progressOutput: "none",
        });

        try {
          await client.startFollowingTip();
          backgroundStore = store;
          backgroundClient = client;
        } catch (error) {
          await client.close().catch(() => undefined);
          throw error;
        }
      } catch (error) {
        await store.close().catch(() => undefined);
        throw error;
      }
    })();

    try {
      await backgroundResumePromise;
    } finally {
      backgroundResumePromise = null;
    }
  };

  const heartbeat = setInterval(() => {
    void refreshStatus().catch(() => undefined);

    const now = Date.now();
    for (const [token, snapshot] of snapshots.entries()) {
      if (snapshot.expiresAtUnixMs <= now) {
        snapshots.delete(token);
        void writeStatus();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const server = net.createServer((socket) => {
    let buffer = "";

    const writeResponse = (response: DaemonResponse) => {
      socket.write(`${JSON.stringify(response)}\n`);
    };

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.trim().length === 0) {
          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        let request: DaemonRequest;

        try {
          request = JSON.parse(line) as DaemonRequest;
        } catch (error) {
          writeResponse({
            id: "invalid",
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        void (async () => {
          try {
            if (request.method === "GetStatus") {
              writeResponse({
                id: request.id,
                ok: true,
                result: buildStatus(),
              });
              return;
            }

            if (request.method === "OpenSnapshot") {
              const [snapshotMaterial, coreStatus] = await Promise.all([
                loadSnapshot(databasePath),
                readCoreTipStatus(paths),
              ]);
              const now = Date.now();
              heartbeatAtUnixMs = now;
              updatedAtUnixMs = now;
              rpcReachable = coreStatus.rpcReachable;
              coreBestHeight = coreStatus.coreBestHeight;
              coreBestHash = coreStatus.coreBestHash;
              observeAppliedTip(snapshotMaterial.tip, now);
              const leaseState = deriveLeaseState(coreStatus, snapshotMaterial.tip);
              state = leaseState.state;
              lastError = leaseState.lastError;
              const snapshot: LoadedSnapshot = {
                ...snapshotMaterial,
                serviceApiVersion: INDEXER_DAEMON_SERVICE_API_VERSION,
                schemaVersion: INDEXER_DAEMON_SCHEMA_VERSION,
                walletRootId,
                daemonInstanceId,
                processId: process.pid ?? null,
                startedAtUnixMs,
                snapshotSeq,
                tipHeight: snapshotMaterial.tip?.height ?? null,
                tipHash: snapshotMaterial.tip?.blockHashHex ?? null,
                openedAtUnixMs: now,
              };
              snapshots.set(snapshot.token, snapshot);
              const leaseStatus = await writeStatus();
              const result: IndexerSnapshotHandle = {
                token: snapshot.token,
                expiresAtUnixMs: snapshot.expiresAtUnixMs,
                serviceApiVersion: snapshot.serviceApiVersion,
                binaryVersion,
                buildId: null,
                walletRootId: snapshot.walletRootId,
                daemonInstanceId: snapshot.daemonInstanceId,
                schemaVersion: snapshot.schemaVersion,
                processId: snapshot.processId,
                startedAtUnixMs: snapshot.startedAtUnixMs,
                state: leaseStatus.state,
                heartbeatAtUnixMs: leaseStatus.heartbeatAtUnixMs,
                rpcReachable: leaseStatus.rpcReachable,
                coreBestHeight: leaseStatus.coreBestHeight,
                coreBestHash: leaseStatus.coreBestHash,
                appliedTipHeight: leaseStatus.appliedTipHeight,
                appliedTipHash: leaseStatus.appliedTipHash,
                snapshotSeq: snapshot.snapshotSeq,
                backlogBlocks: leaseStatus.backlogBlocks,
                reorgDepth: leaseStatus.reorgDepth,
                lastAppliedAtUnixMs: leaseStatus.lastAppliedAtUnixMs,
                activeSnapshotCount: leaseStatus.activeSnapshotCount,
                lastError: leaseStatus.lastError,
                tipHeight: snapshot.tipHeight,
                tipHash: snapshot.tipHash,
                openedAtUnixMs: snapshot.openedAtUnixMs,
              };
              writeResponse({
                id: request.id,
                ok: true,
                result,
              });
              return;
            }

            if (request.method === "ReadSnapshot") {
              const snapshot = request.token ? snapshots.get(request.token) : null;

              if (!snapshot || snapshot.expiresAtUnixMs <= Date.now()) {
                if (request.token) {
                  snapshots.delete(request.token);
                  await writeStatus();
                }
                throw new Error("indexer_daemon_snapshot_invalid");
              }

              if (snapshot.snapshotSeq !== snapshotSeq) {
                snapshots.delete(snapshot.token);
                await writeStatus();
                throw new Error("indexer_daemon_snapshot_rotated");
              }

              const result: IndexerSnapshotPayload = {
                token: snapshot.token,
                stateBase64: snapshot.stateBase64,
                serviceApiVersion: snapshot.serviceApiVersion,
                schemaVersion: snapshot.schemaVersion,
                walletRootId: snapshot.walletRootId,
                daemonInstanceId: snapshot.daemonInstanceId,
                processId: snapshot.processId,
                startedAtUnixMs: snapshot.startedAtUnixMs,
                snapshotSeq: snapshot.snapshotSeq,
                tipHeight: snapshot.tipHeight,
                tipHash: snapshot.tipHash,
                openedAtUnixMs: snapshot.openedAtUnixMs,
                tip: snapshot.tip,
                expiresAtUnixMs: snapshot.expiresAtUnixMs,
              };
              writeResponse({
                id: request.id,
                ok: true,
                result,
              });
              return;
            }

            if (request.method === "CloseSnapshot") {
              if (request.token) {
                snapshots.delete(request.token);
                await writeStatus();
              }
              writeResponse({
                id: request.id,
                ok: true,
                result: null,
              });
              return;
            }

            if (request.method === "PauseBackgroundFollow") {
              await pauseBackgroundFollow();
              writeResponse({
                id: request.id,
                ok: true,
                result: null,
              });
              return;
            }

            if (request.method === "ResumeBackgroundFollow") {
              await resumeBackgroundFollow();
              writeResponse({
                id: request.id,
                ok: true,
                result: null,
              });
              return;
            }

            throw new Error(`indexer_daemon_unknown_method_${request.method}`);
          } catch (error) {
            writeResponse({
              id: request.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();

        newlineIndex = buffer.indexOf("\n");
      }
    });
  });

  const shutdown = async () => {
    clearInterval(heartbeat);
    await pauseBackgroundFollow().catch(() => undefined);
    state = "stopping";
    heartbeatAtUnixMs = Date.now();
    updatedAtUnixMs = heartbeatAtUnixMs;
    await writeStatus().catch(() => undefined);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await rm(paths.indexerDaemonSocketPath, { force: true }).catch(() => undefined);
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.indexerDaemonSocketPath, async () => {
      server.off("error", reject);
      await writeStatus();
      await refreshStatus().catch(() => undefined);
      resolve();
    });
  });
}

await main();
