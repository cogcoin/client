import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  applyBlockWithScoring,
  createInitialState,
  loadBundledGenesisParameters,
  serializeIndexerState,
} from "@cogcoin/indexer";
import type { BitcoinBlock, IndexerState } from "@cogcoin/indexer/types";
import { getBitcoinCliPath } from "@cogcoin/bitcoin";

const execFileAsync = promisify(execFile);

let bitcoinCliPathPromise: Promise<string> | null = null;

export function createTempDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
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
