import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { WalletSeedKind, WalletRuntimePaths } from "../runtime.js";
import { writeFileAtomic } from "../fs/atomic.js";
import {
  extractWalletRootIdHintFromWalletStateEnvelope,
  loadRawWalletStateEnvelope,
  type RawWalletStateEnvelope,
} from "./storage.js";

export interface WalletSeedRecord {
  name: string;
  kind: WalletSeedKind;
  walletRootId: string;
  createdAtUnixMs: number;
  restoredAtUnixMs: number | null;
}

export interface WalletSeedIndexV1 {
  schemaVersion: 1;
  lastWrittenAtUnixMs: number;
  seeds: WalletSeedRecord[];
}

function createEmptySeedIndex(nowUnixMs: number): WalletSeedIndexV1 {
  return {
    schemaVersion: 1,
    lastWrittenAtUnixMs: nowUnixMs,
    seeds: [],
  };
}

function sortSeedRecords(seeds: readonly WalletSeedRecord[]): WalletSeedRecord[] {
  return [...seeds].sort((left, right) => left.name.localeCompare(right.name));
}

async function readSeedIndexFile(path: string): Promise<WalletSeedIndexV1 | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as WalletSeedIndexV1;

    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.seeds)) {
      throw new Error("wallet_seed_index_invalid");
    }

    return {
      schemaVersion: 1,
      lastWrittenAtUnixMs: typeof parsed.lastWrittenAtUnixMs === "number" ? parsed.lastWrittenAtUnixMs : 0,
      seeds: sortSeedRecords(parsed.seeds),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw new Error("wallet_seed_index_invalid");
  }
}

export function normalizeWalletSeedName(name: string): string {
  return name.trim().toLowerCase();
}

export function isValidWalletSeedName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

export function assertValidImportedWalletSeedName(name: string): string {
  const normalized = normalizeWalletSeedName(name);

  if (!isValidWalletSeedName(normalized)) {
    throw new Error("wallet_seed_name_invalid");
  }

  if (normalized === "main") {
    throw new Error("wallet_seed_name_reserved");
  }

  return normalized;
}

export function findWalletSeedRecord(
  index: WalletSeedIndexV1,
  seedName: string,
): WalletSeedRecord | null {
  const normalized = normalizeWalletSeedName(seedName);
  return index.seeds.find((seed) => seed.name === normalized) ?? null;
}

export async function loadWalletSeedIndex(options: {
  paths: Pick<WalletRuntimePaths, "seedRegistryPath" | "walletStatePath" | "walletStateBackupPath">;
  nowUnixMs?: number;
  loadRawWalletStateEnvelope?: (paths: {
    primaryPath: string;
    backupPath: string;
  }) => Promise<RawWalletStateEnvelope | null>;
}): Promise<WalletSeedIndexV1> {
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const stored = await readSeedIndexFile(options.paths.seedRegistryPath);

  if (stored !== null) {
    return stored;
  }

  const rawEnvelope = await (options.loadRawWalletStateEnvelope ?? loadRawWalletStateEnvelope)({
    primaryPath: options.paths.walletStatePath,
    backupPath: options.paths.walletStateBackupPath,
  }).catch(() => null);
  const mainWalletRootId = extractWalletRootIdHintFromWalletStateEnvelope(rawEnvelope?.envelope ?? null);

  if (mainWalletRootId === null) {
    return createEmptySeedIndex(nowUnixMs);
  }

  return {
    schemaVersion: 1,
    lastWrittenAtUnixMs: nowUnixMs,
    seeds: [{
      name: "main",
      kind: "main",
      walletRootId: mainWalletRootId,
      createdAtUnixMs: nowUnixMs,
      restoredAtUnixMs: null,
    }],
  };
}

export async function saveWalletSeedIndex(
  paths: Pick<WalletRuntimePaths, "seedRegistryPath">,
  index: WalletSeedIndexV1,
): Promise<void> {
  await mkdir(dirname(paths.seedRegistryPath), { recursive: true });
  await writeFileAtomic(
    paths.seedRegistryPath,
    `${JSON.stringify({
      ...index,
      seeds: sortSeedRecords(index.seeds),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export async function ensureMainWalletSeedIndexRecord(options: {
  paths: Pick<WalletRuntimePaths, "seedRegistryPath" | "walletStatePath" | "walletStateBackupPath">;
  walletRootId: string;
  nowUnixMs?: number;
}): Promise<WalletSeedIndexV1> {
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const index = await loadWalletSeedIndex({
    paths: options.paths,
    nowUnixMs,
  });
  const existing = findWalletSeedRecord(index, "main");
  const seeds = index.seeds.filter((seed) => seed.name !== "main");
  seeds.push({
    name: "main",
    kind: "main",
    walletRootId: options.walletRootId,
    createdAtUnixMs: existing?.createdAtUnixMs ?? nowUnixMs,
    restoredAtUnixMs: existing?.restoredAtUnixMs ?? null,
  });
  const nextIndex: WalletSeedIndexV1 = {
    schemaVersion: 1,
    lastWrittenAtUnixMs: nowUnixMs,
    seeds: sortSeedRecords(seeds),
  };
  await saveWalletSeedIndex(options.paths, nextIndex);
  return nextIndex;
}

export async function addImportedWalletSeedRecord(options: {
  paths: Pick<WalletRuntimePaths, "seedRegistryPath" | "walletStatePath" | "walletStateBackupPath">;
  seedName: string;
  walletRootId: string;
  nowUnixMs?: number;
}): Promise<WalletSeedIndexV1> {
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const seedName = assertValidImportedWalletSeedName(options.seedName);
  const index = await loadWalletSeedIndex({
    paths: options.paths,
    nowUnixMs,
  });

  if (findWalletSeedRecord(index, seedName) !== null) {
    throw new Error("wallet_seed_name_exists");
  }

  const nextIndex: WalletSeedIndexV1 = {
    schemaVersion: 1,
    lastWrittenAtUnixMs: nowUnixMs,
    seeds: sortSeedRecords([
      ...index.seeds,
      {
        name: seedName,
        kind: "imported",
        walletRootId: options.walletRootId,
        createdAtUnixMs: nowUnixMs,
        restoredAtUnixMs: nowUnixMs,
      },
    ]),
  };
  await saveWalletSeedIndex(options.paths, nextIndex);
  return nextIndex;
}

export async function removeWalletSeedRecord(options: {
  paths: Pick<WalletRuntimePaths, "seedRegistryPath" | "walletStatePath" | "walletStateBackupPath">;
  seedName: string;
  nowUnixMs?: number;
}): Promise<WalletSeedIndexV1> {
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const seedName = normalizeWalletSeedName(options.seedName);
  const index = await loadWalletSeedIndex({
    paths: options.paths,
    nowUnixMs,
  });
  const nextIndex: WalletSeedIndexV1 = {
    schemaVersion: 1,
    lastWrittenAtUnixMs: nowUnixMs,
    seeds: sortSeedRecords(index.seeds.filter((seed) => seed.name !== seedName)),
  };
  await saveWalletSeedIndex(options.paths, nextIndex);
  return nextIndex;
}
