import { execFile } from "node:child_process";
import { mkdtempSync, type Dirent } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";

import {
  applyBlockWithScoring,
  createInitialState,
  loadBundledGenesisParameters,
  serializeIndexerState,
} from "@cogcoin/indexer";
import type { BitcoinBlock, IndexerState } from "@cogcoin/indexer/types";
import { getBitcoinCliPath } from "@cogcoin/bitcoin";

import {
  shutdownIndexerDaemonForTesting,
  shutdownManagedBitcoindServiceForTesting,
} from "../src/bitcoind/testing.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";

const execFileAsync = promisify(execFile);
const MANAGED_TEST_DATA_DIR_NAMES = new Set(["bitcoin", "bitcoind"]);
const TEMP_ROOT_SEARCH_DEPTH = 6;

type ManagedTestCleanupHooks = {
  shutdownIndexerDaemon?: (options: {
    dataDir: string;
  }) => Promise<void>;
  shutdownManagedBitcoind?: (options: {
    dataDir: string;
    chain?: "main" | "regtest";
  }) => Promise<void>;
};

let bitcoinCliPathPromise: Promise<string> | null = null;

export function createTempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export async function createTrackedTempDirectory(t: TestContext, prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `${prefix}-`));
  t.after(async () => {
    await cleanupTrackedTempDirectory(path);
  });
  return path;
}

async function collectManagedDataDirsInTree(root: string): Promise<Set<string>> {
  const matches = new Set<string>();

  async function visit(directory: string, depth: number): Promise<void> {
    let entries: Dirent[];

    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const childPath = join(directory, entry.name);

      if (MANAGED_TEST_DATA_DIR_NAMES.has(entry.name)) {
        matches.add(resolve(childPath));
      }

      if (depth < TEMP_ROOT_SEARCH_DEPTH) {
        await visit(childPath, depth + 1);
      }
    }
  }

  await visit(root, 0);
  return matches;
}

function collectLikelyManagedDataDirs(root: string): Set<string> {
  const dataDirs = new Set<string>();
  const add = (path: string) => {
    dataDirs.add(resolve(path));
  };

  add(join(root, "bitcoind"));
  add(resolveWalletRuntimePathsForTesting({
    platform: "darwin",
    homeDirectory: root,
  }).bitcoinDataDir);
  add(resolveWalletRuntimePathsForTesting({
    platform: "linux",
    homeDirectory: root,
  }).bitcoinDataDir);
  add(resolveWalletRuntimePathsForTesting({
    platform: "linux",
    homeDirectory: root,
    env: {
      ...process.env,
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
    },
  }).bitcoinDataDir);
  add(resolveWalletRuntimePathsForTesting({
    platform: "linux",
    homeDirectory: root,
    env: {
      ...process.env,
      XDG_DATA_HOME: join(root, "data-home"),
      XDG_CONFIG_HOME: join(root, "config-home"),
      XDG_STATE_HOME: join(root, "state-home"),
      XDG_RUNTIME_DIR: join(root, "runtime-home"),
    },
  }).bitcoinDataDir);

  return dataDirs;
}

export async function resolveManagedDataDirsForTempRootForTesting(root: string): Promise<string[]> {
  const dataDirs = collectLikelyManagedDataDirs(root);
  const discoveredDataDirs = await collectManagedDataDirsInTree(root);

  for (const dataDir of discoveredDataDirs) {
    dataDirs.add(dataDir);
  }

  return [...dataDirs].sort();
}

export async function cleanupTrackedTempDirectory(
  path: string,
  hooks: ManagedTestCleanupHooks = {},
): Promise<void> {
  const dataDirs = await resolveManagedDataDirsForTempRootForTesting(path);
  const shutdownIndexerDaemon = hooks.shutdownIndexerDaemon ?? shutdownIndexerDaemonForTesting;
  const shutdownManagedBitcoind = hooks.shutdownManagedBitcoind ?? shutdownManagedBitcoindServiceForTesting;

  for (const dataDir of dataDirs) {
    await shutdownIndexerDaemon({ dataDir }).catch(() => undefined);
    await shutdownManagedBitcoind({
      dataDir,
      chain: "main",
    }).catch(() => undefined);
    await shutdownManagedBitcoind({
      dataDir,
      chain: "regtest",
    }).catch(() => undefined);
  }

  await removeTempDirectory(path);
}

function isRetriableRemoveError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM";
}

export async function removeTempDirectory(path: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetriableRemoveError(error) || attempt === 7) {
        throw error;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 100 * (attempt + 1));
      });
    }
  }
}

async function getCliPath(): Promise<string> {
  bitcoinCliPathPromise ??= getBitcoinCliPath();
  return bitcoinCliPathPromise;
}

export async function runBitcoinCli(
  dataDir: string,
  rpcPort: number,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const cliPath = await getCliPath();
  return execFileAsync(cliPath, [
    "-regtest",
    `-datadir=${dataDir}`,
    `-rpcconnect=127.0.0.1`,
    `-rpcport=${rpcPort}`,
    ...args,
  ]);
}

export async function getMiningDescriptor(
  dataDir: string,
  rpcPort: number,
  scriptHex = "51",
): Promise<string> {
  const { stdout } = await runBitcoinCli(dataDir, rpcPort, ["getdescriptorinfo", `raw(${scriptHex})`]);
  const payload = JSON.parse(stdout) as { descriptor: string };
  return payload.descriptor;
}

export async function generateBlocks(
  dataDir: string,
  rpcPort: number,
  count: number,
  descriptor: string,
): Promise<string[]> {
  const { stdout } = await runBitcoinCli(dataDir, rpcPort, ["generatetodescriptor", String(count), descriptor]);
  return JSON.parse(stdout) as string[];
}

export async function invalidateBlock(dataDir: string, rpcPort: number, hashHex: string): Promise<void> {
  await runBitcoinCli(dataDir, rpcPort, ["invalidateblock", hashHex]);
}

export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  throw new Error("wait_for_condition_timeout");
}

export async function replayBlocks(blocks: BitcoinBlock[]): Promise<IndexerState> {
  const genesis = await loadBundledGenesisParameters();
  let state = createInitialState(genesis);

  for (const block of blocks) {
    const applied = await applyBlockWithScoring(state, block, genesis);
    state = applied.state;
  }

  return state;
}

export function serializeStateHex(state: IndexerState): string {
  return Buffer.from(serializeIndexerState(state)).toString("hex");
}
