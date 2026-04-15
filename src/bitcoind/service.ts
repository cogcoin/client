import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { access, constants, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { totalmem } from "node:os";
import { promisify } from "node:util";
import net from "node:net";

import { getBitcoindPath } from "@cogcoin/bitcoin";

import { acquireFileLock, FileLockBusyError } from "../wallet/fs/lock.js";
import { writeFileAtomic } from "../wallet/fs/atomic.js";
import { writeRuntimeStatusFile } from "../wallet/fs/status-file.js";
import { stopIndexerDaemonServiceWithLockHeld } from "./indexer-daemon.js";
import { createRpcClient, validateNodeConfigForTesting } from "./node.js";
import { resolveManagedServicePaths, UNINITIALIZED_WALLET_ROOT_ID } from "./service-paths.js";
import type {
  BitcoindRpcConfig,
  BitcoindZmqConfig,
  InternalManagedBitcoindOptions,
  ManagedBitcoindObservedStatus,
  ManagedBitcoindServiceStatus,
  ManagedBitcoindRuntimeConfig,
  ManagedBitcoindNodeHandle,
  ManagedCoreWalletReplicaStatus,
} from "./types.js";
import { MANAGED_BITCOIND_SERVICE_API_VERSION as MANAGED_BITCOIND_SERVICE_API_VERSION_VALUE } from "./types.js";

const execFileAsync = promisify(execFile);
const LOCAL_HOST = "127.0.0.1";
const SUPPORTED_BITCOIND_VERSION = "30.2.0";
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
const DEFAULT_DBCACHE_MIB = 450;
const claimedUninitializedRuntimeKeys = new Set<string>();

const GIB = 1024 ** 3;

export function resolveManagedBitcoindDbcacheMiB(totalRamBytes: number): number {
  if (!Number.isFinite(totalRamBytes) || totalRamBytes <= 0) {
    return DEFAULT_DBCACHE_MIB;
  }

  if (totalRamBytes < 8 * GIB) {
    return 450;
  }

  if (totalRamBytes < 16 * GIB) {
    return 768;
  }

  if (totalRamBytes < 32 * GIB) {
    return 1024;
  }

  return 2048;
}

function detectManagedBitcoindDbcacheMiB(): number {
  try {
    return resolveManagedBitcoindDbcacheMiB(totalmem());
  } catch {
    return DEFAULT_DBCACHE_MIB;
  }
}

interface ManagedWalletReplicaRpc {
  listWallets(): Promise<string[]>;
  loadWallet(walletName: string, loadOnStartup?: boolean): Promise<{ name: string; warning: string }>;
  createWallet(walletName: string, options: {
    blank: boolean;
    descriptors: boolean;
    disablePrivateKeys: boolean;
    loadOnStartup: boolean;
    passphrase: string;
  }): Promise<unknown>;
  getWalletInfo(walletName: string): Promise<{
    descriptors: boolean;
    private_keys_enabled: boolean;
  }>;
  walletLock(walletName: string): Promise<null>;
}

type ManagedBitcoindServiceOptions = Pick<
  InternalManagedBitcoindOptions,
  | "dataDir"
  | "chain"
  | "startHeight"
  | "walletRootId"
  | "rpcPort"
  | "zmqPort"
  | "p2pPort"
  | "pollIntervalMs"
  | "startupTimeoutMs"
  | "shutdownTimeoutMs"
  | "managedWalletPassphrase"
>;

export type ManagedBitcoindServiceCompatibility =
  | "compatible"
  | "service-version-mismatch"
  | "wallet-root-mismatch"
  | "runtime-mismatch"
  | "unreachable"
  | "protocol-error";

export interface ManagedBitcoindServiceProbeResult {
  compatibility: ManagedBitcoindServiceCompatibility;
  status: ManagedBitcoindObservedStatus | null;
  error: string | null;
}

export interface ManagedBitcoindServiceStopResult {
  status: "stopped" | "not-running";
  walletRootId: string;
}

interface ManagedBitcoindStatusCandidate {
  status: ManagedBitcoindObservedStatus;
  statusPath: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  errorCode: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!await isProcessAlive(pid)) {
      return;
    }

    await sleep(250);
  }

  throw new Error(errorCode);
}

async function acquireFileLockWithRetry(
  lockPath: string,
  metadata: Parameters<typeof acquireFileLock>[1],
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof acquireFileLock>>> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      return await acquireFileLock(lockPath, metadata);
    } catch (error) {
      if (!(error instanceof FileLockBusyError) || Date.now() >= deadline) {
        throw error;
      }

      await sleep(250);
    }
  }
}

function getWalletReplicaName(walletRootId: string): string {
  return `cogcoin-${walletRootId}`.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 63);
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

async function listManagedBitcoindStatusCandidates(options: {
  dataDir: string;
  runtimeRoot: string;
  expectedStatusPath: string;
}): Promise<ManagedBitcoindStatusCandidate[]> {
  const candidates = new Map<string, ManagedBitcoindObservedStatus>();
  const addCandidate = async (statusPath: string, allowDataDirMismatch = false): Promise<void> => {
    const status = await readJsonFile<ManagedBitcoindObservedStatus>(statusPath);

    if (status === null) {
      return;
    }

    if (!allowDataDirMismatch && status.dataDir !== options.dataDir) {
      return;
    }

    candidates.set(statusPath, status);
  };

  await addCandidate(options.expectedStatusPath, true);

  try {
    const entries = await readdir(options.runtimeRoot, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const statusPath = join(options.runtimeRoot, entry.name, "bitcoind-status.json");

      if (statusPath === options.expectedStatusPath) {
        continue;
      }

      await addCandidate(statusPath);
    }
  } catch {
    // Missing runtime roots are handled by returning no candidates.
  }

  return [...candidates.entries()].map(([statusPath, status]) => ({
    statusPath,
    status,
  }));
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, LOCAL_HOST, () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("bitcoind_port_allocation_failed"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function allocateDistinctPort(reserved: Set<number>): Promise<number> {
  while (true) {
    const port = await allocatePort();

    if (!reserved.has(port)) {
      reserved.add(port);
      return port;
    }
  }
}

async function verifyBitcoindVersion(bitcoindPath: string): Promise<void> {
  const { stdout } = await execFileAsync(bitcoindPath, ["-nosettings=1", "-version"]);

  if (!stdout.includes("Bitcoin Core") || !stdout.includes(`v${SUPPORTED_BITCOIND_VERSION}`)) {
    throw new Error("bitcoind_version_unsupported");
  }
}

function getCookieFile(dataDir: string, chain: "main" | "regtest"): string {
  return chain === "main" ? join(dataDir, ".cookie") : join(dataDir, chain, ".cookie");
}

function createMissingManagedWalletReplicaStatus(walletRootId: string, message: string): ManagedCoreWalletReplicaStatus {
  return {
    walletRootId,
    walletName: getWalletReplicaName(walletRootId),
    loaded: false,
    descriptors: false,
    privateKeysEnabled: false,
    created: false,
    proofStatus: "missing",
    descriptorChecksum: null,
    fundingAddress0: null,
    fundingScriptPubKeyHex0: null,
    message,
  };
}

async function isProcessAlive(pid: number | null): Promise<boolean> {
  if (pid === null) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }

    return true;
  }
}

async function waitForCookie(cookieFile: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await access(cookieFile, constants.R_OK);
      return;
    } catch {
      await sleep(250);
    }
  }

  throw new Error("bitcoind_cookie_timeout");
}

async function waitForRpcReady(
  rpc: ReturnType<typeof createRpcClient>,
  cookieFile: string,
  expectedChain: "main" | "regtest",
  timeoutMs: number,
): Promise<void> {
  await waitForCookie(cookieFile, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const info = await rpc.getBlockchainInfo();

      if (info.chain !== expectedChain) {
        throw new Error(`bitcoind_chain_expected_${expectedChain}_got_${info.chain}`);
      }

      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("bitcoind_rpc_timeout");
}

function validateManagedBitcoindStatus(
  status: ManagedBitcoindObservedStatus,
  options: ManagedBitcoindServiceOptions,
  runtimeRoot: string,
): void {
  if (status.serviceApiVersion !== MANAGED_BITCOIND_SERVICE_API_VERSION_VALUE) {
    throw new Error("managed_bitcoind_service_version_mismatch");
  }

  if (status.walletRootId !== (options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID)) {
    throw new Error("managed_bitcoind_wallet_root_mismatch");
  }

  if (
    status.chain !== options.chain
    || status.dataDir !== (options.dataDir ?? "")
    || status.runtimeRoot !== runtimeRoot
  ) {
    throw new Error("managed_bitcoind_runtime_mismatch");
  }
}

function isRuntimeMismatchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.startsWith("bitcoind_chain_expected_")
    || error.message === "managed_bitcoind_runtime_mismatch";
}

function isUnreachableManagedBitcoindError(error: unknown): boolean {
  if (error instanceof Error) {
    if ("code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET";
    }

    return error.message === "bitcoind_cookie_timeout"
      || error.message.includes("cookie file is unavailable")
      || error.message.includes("ECONNREFUSED")
      || error.message.includes("ECONNRESET")
      || error.message.includes("socket hang up");
  }

  return false;
}

function createBitcoindServiceStatus(options: {
  binaryVersion: string;
  serviceInstanceId: string;
  state: ManagedBitcoindServiceStatus["state"];
  processId: number | null;
  walletRootId: string;
  chain: "main" | "regtest";
  dataDir: string;
  runtimeRoot: string;
  startHeight: number;
  rpc: BitcoindRpcConfig;
  zmq: BitcoindZmqConfig;
  p2pPort: number;
  walletReplica: ManagedCoreWalletReplicaStatus | null;
  startedAtUnixMs: number;
  heartbeatAtUnixMs: number;
  lastError: string | null;
}): ManagedBitcoindServiceStatus {
  return {
    serviceApiVersion: MANAGED_BITCOIND_SERVICE_API_VERSION_VALUE,
    binaryVersion: options.binaryVersion,
    buildId: null,
    serviceInstanceId: options.serviceInstanceId,
    state: options.state,
    processId: options.processId,
    walletRootId: options.walletRootId,
    chain: options.chain,
    dataDir: options.dataDir,
    runtimeRoot: options.runtimeRoot,
    startHeight: options.startHeight,
    rpc: options.rpc,
    zmq: options.zmq,
    p2pPort: options.p2pPort,
    walletReplica: options.walletReplica,
    startedAtUnixMs: options.startedAtUnixMs,
    heartbeatAtUnixMs: options.heartbeatAtUnixMs,
    updatedAtUnixMs: options.heartbeatAtUnixMs,
    lastError: options.lastError,
  };
}

function mapManagedBitcoindValidationError(error: unknown): ManagedBitcoindServiceProbeResult {
  return {
    compatibility: error instanceof Error
      ? error.message === "managed_bitcoind_service_version_mismatch"
        ? "service-version-mismatch"
        : error.message === "managed_bitcoind_wallet_root_mismatch"
          ? "wallet-root-mismatch"
          : "runtime-mismatch"
      : "protocol-error",
    status: null,
    error: error instanceof Error ? error.message : "managed_bitcoind_protocol_error",
  };
}

async function probeManagedBitcoindStatusCandidate(
  status: ManagedBitcoindObservedStatus,
  options: ManagedBitcoindServiceOptions,
  runtimeRoot: string,
): Promise<ManagedBitcoindServiceProbeResult> {
  try {
    validateManagedBitcoindStatus(status, options, runtimeRoot);
  } catch (error) {
    const mapped = mapManagedBitcoindValidationError(error);
    return {
      ...mapped,
      status,
    };
  }

  const rpc = createRpcClient(status.rpc);

  try {
    await waitForRpcReady(
      rpc,
      status.rpc.cookieFile,
      status.chain,
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    );
    await validateNodeConfigForTesting(rpc, status.chain, status.zmq.endpoint);
    return {
      compatibility: "compatible",
      status,
      error: null,
    };
  } catch (error) {
    if (isRuntimeMismatchError(error)) {
      return {
        compatibility: "runtime-mismatch",
        status,
        error: "managed_bitcoind_runtime_mismatch",
      };
    }

    if (isUnreachableManagedBitcoindError(error)) {
      return {
        compatibility: "unreachable",
        status,
        error: null,
      };
    }

    return {
      compatibility: "protocol-error",
      status,
      error: "managed_bitcoind_protocol_error",
    };
  }
}

async function resolveRuntimeConfig(
  statusPath: string,
  configPath: string,
  options: ManagedBitcoindServiceOptions,
): Promise<ManagedBitcoindRuntimeConfig> {
  const previousStatus = await readJsonFile<ManagedBitcoindServiceStatus>(statusPath);
  const previousConfig = await readJsonFile<ManagedBitcoindRuntimeConfig>(configPath);
  const reserved = new Set<number>();
  const rpcPort = options.rpcPort
    ?? previousStatus?.rpc.port
    ?? previousConfig?.rpc?.port
    ?? await allocateDistinctPort(reserved);
  reserved.add(rpcPort);
  const zmqPort = options.zmqPort
    ?? previousStatus?.zmq.port
    ?? previousConfig?.zmqPort
    ?? await allocateDistinctPort(reserved);
  reserved.add(zmqPort);
  const p2pPort = options.p2pPort
    ?? previousStatus?.p2pPort
    ?? previousConfig?.p2pPort
    ?? await allocateDistinctPort(reserved);

  return {
    chain: options.chain,
    rpc: {
      url: `http://${LOCAL_HOST}:${rpcPort}`,
      cookieFile: getCookieFile(options.dataDir ?? "", options.chain),
      port: rpcPort,
    },
    zmqPort,
    p2pPort,
    dbcacheMiB: detectManagedBitcoindDbcacheMiB(),
  };
}

async function writeBitcoinConf(
  filePath: string,
  options: ManagedBitcoindServiceOptions,
  runtimeConfig: ManagedBitcoindRuntimeConfig,
): Promise<void> {
  const walletDir = join(options.dataDir ?? "", "wallets");
  await mkdir(dirname(filePath), { recursive: true });
  await mkdir(walletDir, { recursive: true });

  const lines = [
    "server=1",
    "prune=0",
    "dnsseed=1",
    "listen=0",
    `dbcache=${runtimeConfig.dbcacheMiB}`,
    `rpcbind=${LOCAL_HOST}`,
    `rpcallowip=${LOCAL_HOST}`,
    `rpcport=${runtimeConfig.rpc.port}`,
    `port=${runtimeConfig.p2pPort}`,
    `zmqpubhashblock=tcp://${LOCAL_HOST}:${runtimeConfig.zmqPort}`,
    `walletdir=${walletDir}`,
  ];

  await writeFileAtomic(filePath, `${lines.join("\n")}\n`, { mode: 0o600 });
}

function buildManagedServiceArgs(
  options: ManagedBitcoindServiceOptions,
  runtimeConfig: ManagedBitcoindRuntimeConfig,
): string[] {
  const walletDir = join(options.dataDir ?? "", "wallets");
  const args = [
    "-nosettings=1",
    `-datadir=${options.dataDir}`,
    `-rpcbind=${LOCAL_HOST}`,
    `-rpcallowip=${LOCAL_HOST}`,
    `-rpcport=${runtimeConfig.rpc.port}`,
    `-port=${runtimeConfig.p2pPort}`,
    `-zmqpubhashblock=tcp://${LOCAL_HOST}:${runtimeConfig.zmqPort}`,
    `-walletdir=${walletDir}`,
    "-server=1",
    "-prune=0",
    "-dnsseed=1",
    "-listen=0",
    `-dbcache=${runtimeConfig.dbcacheMiB}`,
  ];

  if (options.chain === "regtest") {
    args.push("-chain=regtest");
  }

  return args;
}

export async function writeBitcoinConfForTesting(
  filePath: string,
  options: ManagedBitcoindServiceOptions,
  runtimeConfig: ManagedBitcoindRuntimeConfig,
): Promise<void> {
  await writeBitcoinConf(filePath, options, runtimeConfig);
}

export function buildManagedServiceArgsForTesting(
  options: ManagedBitcoindServiceOptions,
  runtimeConfig: ManagedBitcoindRuntimeConfig,
): string[] {
  return buildManagedServiceArgs(options, runtimeConfig);
}

function isMissingWalletError(message: string): boolean {
  return message.includes("bitcoind_rpc_loadwallet_-18_")
    || message.includes("Path does not exist")
    || message.includes("not found");
}

async function loadManagedWalletReplicaIfPresent(
  rpc: ManagedWalletReplicaRpc,
  walletRootId: string,
  dataDir: string,
): Promise<ManagedCoreWalletReplicaStatus> {
  const walletName = getWalletReplicaName(walletRootId);
  const loadedWallets = await rpc.listWallets();
  let loaded = loadedWallets.includes(walletName);

  if (!loaded) {
    try {
      await rpc.loadWallet(walletName, false);
      loaded = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (!isMissingWalletError(message)) {
        return {
          walletRootId,
          walletName,
          loaded: false,
          descriptors: false,
          privateKeysEnabled: false,
          created: false,
          proofStatus: "mismatch",
          descriptorChecksum: null,
          fundingAddress0: null,
          fundingScriptPubKeyHex0: null,
          message,
        };
      }

      const walletDir = join(dataDir, "wallets", walletName);
      const walletDirExists = await access(walletDir, constants.F_OK).then(() => true).catch(() => false);

      return createMissingManagedWalletReplicaStatus(
        walletRootId,
        walletDirExists
          ? "Managed Core wallet replica exists on disk but is not loaded."
          : "Managed Core wallet replica is missing.",
      );
    }
  }

  const info = await rpc.getWalletInfo(walletName);

  if (!info.descriptors || !info.private_keys_enabled) {
    return {
      walletRootId,
      walletName,
      loaded: true,
      descriptors: info.descriptors,
      privateKeysEnabled: info.private_keys_enabled,
      created: false,
      proofStatus: "mismatch",
      descriptorChecksum: null,
      fundingAddress0: null,
      fundingScriptPubKeyHex0: null,
      message: "Managed Core wallet replica is not an encrypted descriptor wallet with private keys enabled.",
    };
  }

  try {
    await rpc.walletLock(walletName);
  } catch {
    // A freshly created encrypted wallet may already be locked.
  }

  return {
    walletRootId,
    walletName,
    loaded: true,
    descriptors: info.descriptors,
    privateKeysEnabled: info.private_keys_enabled,
    created: false,
    proofStatus: "not-proven",
    descriptorChecksum: null,
    fundingAddress0: null,
    fundingScriptPubKeyHex0: null,
    message: null,
  };
}

export async function createManagedWalletReplica(
  rpc: ManagedWalletReplicaRpc,
  walletRootId: string,
  options: {
    managedWalletPassphrase?: string;
  } = {},
): Promise<ManagedCoreWalletReplicaStatus> {
  const walletName = getWalletReplicaName(walletRootId);
  const loadedWallets = await rpc.listWallets();
  let created = false;

  if (!loadedWallets.includes(walletName)) {
    try {
      await rpc.loadWallet(walletName, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (!isMissingWalletError(message)) {
        throw error;
      }

      await rpc.createWallet(walletName, {
        blank: true,
        descriptors: true,
        disablePrivateKeys: false,
        loadOnStartup: false,
        passphrase: options.managedWalletPassphrase ?? randomBytes(32).toString("hex"),
      });
      created = true;
    }
  }

  const info = await rpc.getWalletInfo(walletName);

  if (!info.descriptors || !info.private_keys_enabled) {
    throw new Error("managed_bitcoind_wallet_replica_invalid");
  }

  try {
    await rpc.walletLock(walletName);
  } catch {
    // A freshly created encrypted wallet may already be locked.
  }

  return {
    walletRootId,
    walletName,
    loaded: true,
    descriptors: info.descriptors,
    privateKeysEnabled: info.private_keys_enabled,
    created,
    proofStatus: "not-proven",
    descriptorChecksum: null,
    fundingAddress0: null,
    fundingScriptPubKeyHex0: null,
    message: null,
  };
}

async function writeBitcoindStatus(
  paths: ReturnType<typeof resolveManagedServicePaths>,
  status: ManagedBitcoindServiceStatus,
): Promise<void> {
  await mkdir(paths.walletRuntimeRoot, { recursive: true });
  await writeRuntimeStatusFile(paths.bitcoindStatusPath, status);
  await writeFileAtomic(paths.bitcoindPidPath, `${status.processId ?? ""}\n`, { mode: 0o600 });
  await writeFileAtomic(paths.bitcoindReadyPath, `${status.updatedAtUnixMs}\n`, { mode: 0o600 });
  await writeRuntimeStatusFile(paths.bitcoindWalletStatusPath, status.walletReplica ?? createMissingManagedWalletReplicaStatus(
    status.walletRootId,
    "Managed Core wallet replica is missing.",
  ));
  await writeRuntimeStatusFile(paths.bitcoindRuntimeConfigPath, {
    chain: status.chain,
    rpc: status.rpc,
    zmqPort: status.zmq.port,
    p2pPort: status.p2pPort,
  });
}

async function clearManagedBitcoindRuntimeArtifacts(
  paths: ReturnType<typeof resolveManagedServicePaths>,
): Promise<void> {
  await rm(paths.bitcoindStatusPath, { force: true }).catch(() => undefined);
  await rm(paths.bitcoindPidPath, { force: true }).catch(() => undefined);
  await rm(paths.bitcoindReadyPath, { force: true }).catch(() => undefined);
  await rm(paths.bitcoindWalletStatusPath, { force: true }).catch(() => undefined);
}

export async function stopManagedBitcoindServiceWithLockHeld(options: {
  dataDir: string;
  walletRootId?: string;
  shutdownTimeoutMs?: number;
  paths?: ReturnType<typeof resolveManagedServicePaths>;
}): Promise<ManagedBitcoindServiceStopResult> {
  const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const paths = options.paths ?? resolveManagedServicePaths(options.dataDir, walletRootId);
  const status = await readJsonFile<ManagedBitcoindServiceStatus>(paths.bitcoindStatusPath);
  const processId = status?.processId ?? null;

  if (status === null || processId === null || !await isProcessAlive(processId)) {
    await clearManagedBitcoindRuntimeArtifacts(paths);
    return {
      status: "not-running",
      walletRootId,
    };
  }

  const rpc = createRpcClient(status.rpc);

  try {
    await rpc.stop();
  } catch {
    try {
      process.kill(processId, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) {
        throw error;
      }
    }
  }

  await waitForProcessExit(
    processId,
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    "managed_bitcoind_service_stop_timeout",
  );
  await clearManagedBitcoindRuntimeArtifacts(paths);
  return {
    status: "stopped",
    walletRootId,
  };
}

export async function withClaimedUninitializedManagedRuntime<T>(options: {
  dataDir: string;
  walletRootId?: string;
  shutdownTimeoutMs?: number;
}, callback: () => Promise<T>): Promise<T> {
  const targetWalletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;

  if (targetWalletRootId === UNINITIALIZED_WALLET_ROOT_ID) {
    return callback();
  }

  const claimKey = `${options.dataDir}\n${targetWalletRootId}`;

  if (claimedUninitializedRuntimeKeys.has(claimKey)) {
    return callback();
  }

  claimedUninitializedRuntimeKeys.add(claimKey);
  const uninitializedPaths = resolveManagedServicePaths(options.dataDir, UNINITIALIZED_WALLET_ROOT_ID);
  const lockTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const bitcoindLock = await acquireFileLockWithRetry(
    uninitializedPaths.bitcoindLockPath,
    {
      purpose: "managed-bitcoind-claim-uninitialized",
      walletRootId: UNINITIALIZED_WALLET_ROOT_ID,
      dataDir: options.dataDir,
    },
    lockTimeoutMs,
  );

  try {
    const indexerLock = await acquireFileLockWithRetry(
      uninitializedPaths.indexerDaemonLockPath,
      {
        purpose: "managed-indexer-claim-uninitialized",
        walletRootId: UNINITIALIZED_WALLET_ROOT_ID,
        dataDir: options.dataDir,
      },
      lockTimeoutMs,
    );

    try {
      await stopIndexerDaemonServiceWithLockHeld({
        dataDir: options.dataDir,
        walletRootId: UNINITIALIZED_WALLET_ROOT_ID,
        shutdownTimeoutMs: options.shutdownTimeoutMs,
        paths: uninitializedPaths,
      });
      await stopManagedBitcoindServiceWithLockHeld({
        dataDir: options.dataDir,
        walletRootId: UNINITIALIZED_WALLET_ROOT_ID,
        shutdownTimeoutMs: options.shutdownTimeoutMs,
        paths: uninitializedPaths,
      });
      return await callback();
    } finally {
      await indexerLock.release();
    }
  } finally {
    claimedUninitializedRuntimeKeys.delete(claimKey);
    await bitcoindLock.release();
  }
}

async function refreshManagedBitcoindStatus(
  status: ManagedBitcoindServiceStatus,
  paths: ReturnType<typeof resolveManagedServicePaths>,
  options: ManagedBitcoindServiceOptions,
): Promise<ManagedBitcoindServiceStatus> {
  const nowUnixMs = Date.now();
  const rpc = createRpcClient(status.rpc);

  try {
    await waitForRpcReady(rpc, status.rpc.cookieFile, status.chain, options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    await validateNodeConfigForTesting(rpc, status.chain, status.zmq.endpoint);
    const walletReplica = await loadManagedWalletReplicaIfPresent(rpc, status.walletRootId, status.dataDir);
    const nextStatus: ManagedBitcoindServiceStatus = {
      ...status,
      state: "ready",
      processId: await isProcessAlive(status.processId) ? status.processId : null,
      walletReplica,
      heartbeatAtUnixMs: nowUnixMs,
      updatedAtUnixMs: nowUnixMs,
      lastError: walletReplica.message ?? null,
    };
    await writeBitcoindStatus(paths, nextStatus);
    return nextStatus;
  } catch (error) {
    const nextStatus: ManagedBitcoindServiceStatus = {
      ...status,
      state: "failed",
      processId: await isProcessAlive(status.processId) ? status.processId : null,
      heartbeatAtUnixMs: nowUnixMs,
      updatedAtUnixMs: nowUnixMs,
      lastError: error instanceof Error ? error.message : String(error),
    };
    await writeBitcoindStatus(paths, nextStatus);
    return nextStatus;
  }
}

function createNodeHandle(
  status: ManagedBitcoindServiceStatus,
  paths: ReturnType<typeof resolveManagedServicePaths>,
  options: ManagedBitcoindServiceOptions,
): ManagedBitcoindNodeHandle {
  let currentStatus = status;
  const rpc = createRpcClient(currentStatus.rpc);

  return {
    rpc: currentStatus.rpc,
    zmq: currentStatus.zmq,
    pid: currentStatus.processId,
    expectedChain: currentStatus.chain,
    startHeight: currentStatus.startHeight,
    dataDir: currentStatus.dataDir,
    walletRootId: currentStatus.walletRootId,
    runtimeRoot: paths.walletRuntimeRoot,
    async validate(): Promise<void> {
      await validateNodeConfigForTesting(rpc, currentStatus.chain, currentStatus.zmq.endpoint);
    },
    async refreshServiceStatus() {
      currentStatus = await refreshManagedBitcoindStatus(currentStatus, paths, options);
      return currentStatus;
    },
    async stop(): Promise<void> {
      // Public managed clients detach from the persistent service instead of
      // shutting it down on ordinary command exit.
      return;
    },
  };
}

async function tryAttachExistingManagedBitcoindService(
  options: ManagedBitcoindServiceOptions,
): Promise<ManagedBitcoindNodeHandle | null> {
  const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const paths = resolveManagedServicePaths(options.dataDir ?? "", walletRootId);
  const probe = await probeManagedBitcoindService(options);

  if (probe.compatibility !== "compatible" || probe.status === null) {
    return null;
  }

  const refreshed = await refreshManagedBitcoindStatus(
    probe.status as ManagedBitcoindServiceStatus,
    paths,
    options,
  );

  return createNodeHandle(refreshed, paths, options);
}

async function waitForManagedBitcoindService(
  options: ManagedBitcoindServiceOptions,
  timeoutMs: number,
): Promise<ManagedBitcoindNodeHandle> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const attached = await tryAttachExistingManagedBitcoindService(options).catch(() => null);

    if (attached !== null) {
      return attached;
    }

    await sleep(250);
  }

  throw new Error("managed_bitcoind_service_start_timeout");
}

export async function probeManagedBitcoindService(
  options: ManagedBitcoindServiceOptions,
): Promise<ManagedBitcoindServiceProbeResult> {
  const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const paths = resolveManagedServicePaths(options.dataDir ?? "", walletRootId);
  const candidates = await listManagedBitcoindStatusCandidates({
    dataDir: options.dataDir ?? "",
    runtimeRoot: paths.runtimeRoot,
    expectedStatusPath: paths.bitcoindStatusPath,
  });
  const expectedCandidate = candidates.find((candidate) => candidate.statusPath === paths.bitcoindStatusPath) ?? null;

  for (const candidate of candidates) {
    if (!await isProcessAlive(candidate.status.processId)) {
      continue;
    }

    return probeManagedBitcoindStatusCandidate(candidate.status, options, paths.walletRuntimeRoot);
  }

  if (expectedCandidate !== null) {
    return {
      compatibility: "unreachable",
      status: expectedCandidate.status,
      error: null,
    };
  }

  return {
    compatibility: "unreachable",
    status: candidates[0]?.status ?? null,
    error: null,
  };
}

export async function attachOrStartManagedBitcoindService(
  options: ManagedBitcoindServiceOptions,
): Promise<ManagedBitcoindNodeHandle> {
  const resolvedOptions: ManagedBitcoindServiceOptions = {
    ...options,
    dataDir: options.dataDir,
    walletRootId: options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID,
  };
  const startupTimeoutMs = resolvedOptions.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  return withClaimedUninitializedManagedRuntime({
    dataDir: resolvedOptions.dataDir ?? "",
    walletRootId: resolvedOptions.walletRootId,
    shutdownTimeoutMs: resolvedOptions.shutdownTimeoutMs,
  }, async () => {
    const existingProbe = await probeManagedBitcoindService(resolvedOptions);
    if (existingProbe.compatibility === "compatible") {
      const existing = await tryAttachExistingManagedBitcoindService(resolvedOptions);
      if (existing !== null) {
        return existing;
      }
    }

    if (existingProbe.compatibility !== "unreachable") {
      throw new Error(existingProbe.error ?? "managed_bitcoind_protocol_error");
    }

    const paths = resolveManagedServicePaths(resolvedOptions.dataDir ?? "", resolvedOptions.walletRootId);

    try {
      const lock = await acquireFileLock(paths.bitcoindLockPath, {
        purpose: "managed-bitcoind-start",
        walletRootId: resolvedOptions.walletRootId,
        dataDir: resolvedOptions.dataDir,
      });

      try {
        const liveProbe = await probeManagedBitcoindService(resolvedOptions);
        if (liveProbe.compatibility === "compatible") {
          const reattached = await tryAttachExistingManagedBitcoindService(resolvedOptions);

          if (reattached !== null) {
            return reattached;
          }
        }

        if (liveProbe.compatibility !== "unreachable") {
          throw new Error(liveProbe.error ?? "managed_bitcoind_protocol_error");
        }

        const bitcoindPath = await getBitcoindPath();
        await verifyBitcoindVersion(bitcoindPath);
        const binaryVersion = SUPPORTED_BITCOIND_VERSION;
        await mkdir(resolvedOptions.dataDir ?? "", { recursive: true });
        const runtimeConfig = await resolveRuntimeConfig(
          paths.bitcoindStatusPath,
          paths.bitcoindRuntimeConfigPath,
          resolvedOptions,
        );
        await writeBitcoinConf(paths.bitcoinConfPath, resolvedOptions, runtimeConfig);

        const rpcConfig: BitcoindRpcConfig = runtimeConfig.rpc;
        const zmqConfig: BitcoindZmqConfig = {
          endpoint: `tcp://${LOCAL_HOST}:${runtimeConfig.zmqPort}`,
          topic: "hashblock",
          port: runtimeConfig.zmqPort,
          pollIntervalMs: resolvedOptions.pollIntervalMs ?? 15_000,
        };
        const child = spawn(bitcoindPath, buildManagedServiceArgs(resolvedOptions, runtimeConfig), {
          detached: true,
          stdio: "ignore",
        });
        child.unref();

        const rpc = createRpcClient(rpcConfig);

        try {
          await waitForRpcReady(rpc, rpcConfig.cookieFile, resolvedOptions.chain, startupTimeoutMs);
          await validateNodeConfigForTesting(rpc, resolvedOptions.chain, zmqConfig.endpoint);
        } catch (error) {
          if (child.pid !== undefined) {
            try {
              process.kill(child.pid, "SIGTERM");
            } catch {
              // ignore kill failures during startup cleanup
            }
          }
          throw error;
        }

        const nowUnixMs = Date.now();
        const walletRootId = resolvedOptions.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
        const walletReplica = await loadManagedWalletReplicaIfPresent(
          rpc,
          walletRootId,
          resolvedOptions.dataDir ?? "",
        );
        const status = createBitcoindServiceStatus({
          binaryVersion,
          serviceInstanceId: randomBytes(16).toString("hex"),
          state: "ready",
          processId: child.pid ?? null,
          walletRootId,
          chain: resolvedOptions.chain,
          dataDir: resolvedOptions.dataDir ?? "",
          runtimeRoot: paths.walletRuntimeRoot,
          startHeight: resolvedOptions.startHeight,
          rpc: rpcConfig,
          zmq: zmqConfig,
          p2pPort: runtimeConfig.p2pPort,
          walletReplica,
          startedAtUnixMs: nowUnixMs,
          heartbeatAtUnixMs: nowUnixMs,
          lastError: walletReplica.message ?? null,
        });
        await writeBitcoindStatus(paths, status);

        return createNodeHandle(status, paths, resolvedOptions);
      } finally {
        await lock.release();
      }
    } catch (error) {
      if (error instanceof FileLockBusyError) {
        return waitForManagedBitcoindService(resolvedOptions, startupTimeoutMs);
      }

      throw error;
    }
  });
}

export async function stopManagedBitcoindService(options: {
  dataDir: string;
  walletRootId?: string;
  shutdownTimeoutMs?: number;
}): Promise<ManagedBitcoindServiceStopResult> {
  const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
  const paths = resolveManagedServicePaths(options.dataDir, walletRootId);
  const lock = await acquireFileLock(paths.bitcoindLockPath, {
    purpose: "managed-bitcoind-stop",
    walletRootId,
    dataDir: options.dataDir,
  });

  try {
    return stopManagedBitcoindServiceWithLockHeld({
      ...options,
      walletRootId,
      paths,
    });
  } finally {
    await lock.release();
  }
}

export async function readManagedBitcoindServiceStatusForTesting(
  dataDir: string,
  walletRootId = UNINITIALIZED_WALLET_ROOT_ID,
): Promise<ManagedBitcoindObservedStatus | null> {
  const paths = resolveManagedServicePaths(dataDir, walletRootId);
  return readJsonFile<ManagedBitcoindObservedStatus>(paths.bitcoindStatusPath);
}

export async function shutdownManagedBitcoindServiceForTesting(
  options: {
    dataDir: string;
    chain?: "main" | "regtest";
    walletRootId?: string;
    shutdownTimeoutMs?: number;
  },
): Promise<void> {
  await stopManagedBitcoindService({
    dataDir: options.dataDir,
    walletRootId: options.walletRootId,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
  }).catch(async (error) => {
    const walletRootId = options.walletRootId ?? UNINITIALIZED_WALLET_ROOT_ID;
    const paths = resolveManagedServicePaths(options.dataDir, walletRootId);
    await rm(paths.bitcoindReadyPath, { force: true }).catch(() => undefined);
    throw error;
  });
}
