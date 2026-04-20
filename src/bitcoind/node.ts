import { execFile, spawn } from "node:child_process";
import { access, constants, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import net from "node:net";

import { getBitcoindPath } from "@cogcoin/bitcoin";

import { resolveDefaultBitcoindDataDirForTesting } from "../app-paths.js";
import { DEFAULT_MANAGED_BITCOIND_FOLLOW_POLL_INTERVAL_MS } from "./types.js";
import { BitcoinRpcClient } from "./rpc.js";
import type {
  BitcoindRpcConfig,
  BitcoindZmqConfig,
  InternalManagedBitcoindOptions,
  ManagedBitcoindNodeHandle,
  RpcBlockchainInfo,
} from "./types.js";

const execFileAsync = promisify(execFile);
const SUPPORTED_BITCOIND_VERSION = "30.2.0";
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
const LOCAL_HOST = "127.0.0.1";

export { resolveDefaultBitcoindDataDirForTesting };

interface ResolvedManagedBitcoindOptions extends InternalManagedBitcoindOptions {
  dataDir: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

function getCookieFile(dataDir: string, chain: "main" | "regtest"): string {
  if (chain === "main") {
    return join(dataDir, ".cookie");
  }

  return join(dataDir, chain, ".cookie");
}

function resolveManagedBitcoindOptions(
  options: InternalManagedBitcoindOptions,
): ResolvedManagedBitcoindOptions {
  return {
    ...options,
    dataDir: options.dataDir ?? resolveDefaultBitcoindDataDirForTesting(),
  };
}

export function buildBitcoindArgsForTesting(
  options: InternalManagedBitcoindOptions,
  rpcPort: number,
  zmqPort: number,
  p2pPort: number,
): string[] {
  const resolvedOptions = resolveManagedBitcoindOptions(options);
  const args = [
    "-nosettings=1",
    `-datadir=${resolvedOptions.dataDir}`,
    `-rpcbind=${LOCAL_HOST}`,
    `-rpcallowip=${LOCAL_HOST}`,
    `-rpcport=${rpcPort}`,
    `-port=${p2pPort}`,
    `-zmqpubhashblock=tcp://${LOCAL_HOST}:${zmqPort}`,
    "-server=1",
    "-disablewallet=1",
    "-prune=0",
    "-dnsseed=1",
    "-listen=0",
  ];

  if (resolvedOptions.chain === "regtest") {
    args.push("-chain=regtest");
  }

  return args;
}

async function verifyBitcoindVersion(bitcoindPath: string): Promise<void> {
  const { stdout } = await execFileAsync(bitcoindPath, ["-nosettings=1", "-version"]);

  if (!stdout.includes("Bitcoin Core") || !stdout.includes(`v${SUPPORTED_BITCOIND_VERSION}`)) {
    throw new Error("bitcoind_version_unsupported");
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
  rpcClient: BitcoinRpcClient,
  cookieFile: string,
  expectedChain: "main" | "regtest",
  timeoutMs: number,
): Promise<RpcBlockchainInfo> {
  await waitForCookie(cookieFile, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const info = await rpcClient.getBlockchainInfo();

      if (info.chain !== expectedChain) {
        throw new Error(`bitcoind_chain_expected_${expectedChain}_got_${info.chain}`);
      }

      return info;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("bitcoind_rpc_timeout");
}

export async function validateNodeConfigForTesting(
  rpcClient: BitcoinRpcClient,
  expectedChain: "main" | "regtest",
  zmqEndpoint: string,
): Promise<void> {
  const info = await rpcClient.getBlockchainInfo();

  if (info.chain !== expectedChain) {
    throw new Error(`bitcoind_chain_expected_${expectedChain}_got_${info.chain}`);
  }

  if (info.pruned) {
    throw new Error("bitcoind_pruned_unsupported");
  }

  const notifications = await rpcClient.getZmqNotifications();
  const hasHashBlock = notifications.some((notification) =>
    notification.type === "pubhashblock" && notification.address === zmqEndpoint);

  if (!hasHashBlock) {
    throw new Error("bitcoind_zmq_hashblock_missing");
  }
}

export async function launchManagedBitcoindNode(
  options: InternalManagedBitcoindOptions,
): Promise<ManagedBitcoindNodeHandle> {
  const resolvedOptions = resolveManagedBitcoindOptions(options);
  const bitcoindPath = await getBitcoindPath();
  await verifyBitcoindVersion(bitcoindPath);

  await mkdir(resolvedOptions.dataDir, { recursive: true });

  const reservedPorts = new Set<number>();
  const rpcPort = options.rpcPort ?? await allocateDistinctPort(reservedPorts);
  reservedPorts.add(rpcPort);
  const zmqPort = options.zmqPort ?? await allocateDistinctPort(reservedPorts);
  reservedPorts.add(zmqPort);
  const p2pPort = options.p2pPort ?? await allocateDistinctPort(reservedPorts);
  const cookieFile = getCookieFile(resolvedOptions.dataDir, resolvedOptions.chain);
  const rpcUrl = `http://${LOCAL_HOST}:${rpcPort}`;
  const zmqEndpoint = `tcp://${LOCAL_HOST}:${zmqPort}`;
  const rpcConfig: BitcoindRpcConfig = {
    url: rpcUrl,
    cookieFile,
    port: rpcPort,
  };
  const zmqConfig: BitcoindZmqConfig = {
    endpoint: zmqEndpoint,
    topic: "hashblock",
    port: zmqPort,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_MANAGED_BITCOIND_FOLLOW_POLL_INTERVAL_MS,
  };
  const child = spawn(bitcoindPath, buildBitcoindArgsForTesting(resolvedOptions, rpcPort, zmqPort, p2pPort), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rpcClient = new BitcoinRpcClient(rpcUrl, cookieFile);
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let stopped = false;

  child.stdout?.resume();
  child.stderr?.resume();

  try {
    await waitForRpcReady(rpcClient, cookieFile, resolvedOptions.chain, startupTimeoutMs);
    await validateNodeConfigForTesting(rpcClient, resolvedOptions.chain, zmqEndpoint);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }

  return {
    rpc: rpcConfig,
    zmq: zmqConfig,
    pid: child.pid ?? null,
    expectedChain: resolvedOptions.chain,
    startHeight: resolvedOptions.startHeight,
    dataDir: resolvedOptions.dataDir,
    getblockArchiveEndHeight: null,
    getblockArchiveSha256: null,
    async validate(): Promise<void> {
      await validateNodeConfigForTesting(rpcClient, resolvedOptions.chain, zmqEndpoint);
    },
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }

      stopped = true;

      try {
        await rpcClient.stop();
      } catch {
        if (!child.killed) {
          child.kill("SIGTERM");
        }
      }

      await Promise.race([
        new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
        }),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            if (!child.killed) {
              child.kill("SIGKILL");
            }
            resolve();
          }, shutdownTimeoutMs);
        }),
      ]);
    },
  };
}

export function createRpcClient(config: BitcoindRpcConfig): BitcoinRpcClient {
  return new BitcoinRpcClient(config.url, config.cookieFile);
}
