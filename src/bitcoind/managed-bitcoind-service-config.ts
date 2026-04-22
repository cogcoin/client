import { execFile } from "node:child_process";
import { access, constants, mkdir } from "node:fs/promises";
import { totalmem } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import net from "node:net";

import { writeFileAtomic } from "../wallet/fs/atomic.js";
import { readJsonFileIfPresent } from "./managed-runtime/status.js";
import type {
  BitcoindRpcConfig,
  BitcoindZmqConfig,
  ManagedBitcoindRuntimeConfig,
  ManagedBitcoindServiceStatus,
} from "./types.js";
import type { ManagedBitcoindServiceOptions } from "./managed-bitcoind-service-types.js";

const execFileAsync = promisify(execFile);
export const LOCAL_HOST = "127.0.0.1";
export const SUPPORTED_BITCOIND_VERSION = "30.2.0";
const DEFAULT_DBCACHE_MIB = 450;
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

export function detectManagedBitcoindDbcacheMiB(): number {
  try {
    return resolveManagedBitcoindDbcacheMiB(totalmem());
  } catch {
    return DEFAULT_DBCACHE_MIB;
  }
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

export async function verifyManagedBitcoindVersion(bitcoindPath: string): Promise<void> {
  const { stdout } = await execFileAsync(bitcoindPath, ["-nosettings=1", "-version"]);

  if (!stdout.includes("Bitcoin Core") || !stdout.includes(`v${SUPPORTED_BITCOIND_VERSION}`)) {
    throw new Error("bitcoind_version_unsupported");
  }
}

export function getManagedBitcoindCookieFile(dataDir: string, chain: "main" | "regtest"): string {
  return chain === "main" ? join(dataDir, ".cookie") : join(dataDir, chain, ".cookie");
}

export async function resolveManagedBitcoindRuntimeConfig(
  statusPath: string,
  configPath: string,
  options: ManagedBitcoindServiceOptions,
): Promise<ManagedBitcoindRuntimeConfig> {
  const previousStatus = await readJsonFileIfPresent<ManagedBitcoindServiceStatus>(statusPath);
  const previousConfig = await readJsonFileIfPresent<ManagedBitcoindRuntimeConfig>(configPath);
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
      cookieFile: getManagedBitcoindCookieFile(options.dataDir ?? "", options.chain),
      port: rpcPort,
    },
    zmqPort,
    p2pPort,
    dbcacheMiB: detectManagedBitcoindDbcacheMiB(),
    getblockArchiveEndHeight: options.getblockArchiveEndHeight ?? null,
    getblockArchiveSha256: options.getblockArchiveSha256 ?? null,
  };
}

export async function writeBitcoinConfForTesting(
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

export function buildManagedServiceArgsForTesting(
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

  if (options.getblockArchivePath !== undefined && options.getblockArchivePath !== null) {
    args.push(`-loadblock=${options.getblockArchivePath}`);
  }

  return args;
}

export async function waitForManagedBitcoindCookie(cookieFile: string, timeoutMs: number, sleepImpl: (ms: number) => Promise<void>): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await access(cookieFile, constants.R_OK);
      return;
    } catch {
      await sleepImpl(250);
    }
  }

  throw new Error("bitcoind_cookie_timeout");
}

export type {
  BitcoindRpcConfig,
  BitcoindZmqConfig,
};
