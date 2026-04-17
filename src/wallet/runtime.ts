import { join } from "node:path";

import type { CogcoinPathResolution } from "../app-paths.js";
import { resolveCogcoinPathsForTesting } from "../app-paths.js";

export type WalletSeedKind = "main" | "imported";

export interface WalletRuntimePathResolution extends CogcoinPathResolution {
  seedName?: string | null;
}

export interface WalletRuntimePaths {
  dataRoot: string;
  clientDataDir: string;
  clientConfigPath: string;
  runtimeRoot: string;
  walletRuntimeRoot: string;
  stateRoot: string;
  walletStateRoot: string;
  seedRegistryPath: string;
  selectedSeedName: string;
  selectedSeedKind: WalletSeedKind;
  bitcoinDataDir: string;
  indexerRoot: string;
  walletStateDirectory: string;
  walletStatePath: string;
  walletStateBackupPath: string;
  walletInitPendingPath: string;
  walletInitPendingBackupPath: string;
  walletUnlockSessionPath: string;
  walletExplicitLockPath: string;
  walletControlLockPath: string;
  bitcoindLockPath: string;
  bitcoindStatusPath: string;
  indexerDaemonLockPath: string;
  indexerStatusPath: string;
  miningRoot: string;
  miningStatusPath: string;
  miningEventsPath: string;
  miningControlLockPath: string;
}

function resolveSeedLayout(
  sharedStateRoot: string,
  sharedRuntimeRoot: string,
  seedName: string,
): {
  seedKind: WalletSeedKind;
  walletStateRoot: string;
  walletRuntimeRoot: string;
} {
  if (seedName === "main") {
    return {
      seedKind: "main",
      walletStateRoot: sharedStateRoot,
      walletRuntimeRoot: sharedRuntimeRoot,
    };
  }

  return {
    seedKind: "imported",
    walletStateRoot: join(sharedStateRoot, "seeds", seedName),
    walletRuntimeRoot: join(sharedRuntimeRoot, "seeds", seedName),
  };
}

export function deriveWalletRuntimePathsForSeed(
  basePaths: WalletRuntimePaths,
  seedName: string | null | undefined,
): WalletRuntimePaths {
  const resolvedSeedName = seedName ?? "main";
  const seedLayout = resolveSeedLayout(basePaths.stateRoot, basePaths.runtimeRoot, resolvedSeedName);

  return {
    ...basePaths,
    walletRuntimeRoot: seedLayout.walletRuntimeRoot,
    walletStateRoot: seedLayout.walletStateRoot,
    selectedSeedName: resolvedSeedName,
    selectedSeedKind: seedLayout.seedKind,
    walletStateDirectory: seedLayout.walletStateRoot,
    walletStatePath: join(seedLayout.walletStateRoot, "wallet-state.enc"),
    walletStateBackupPath: join(seedLayout.walletStateRoot, "wallet-state.enc.bak"),
    walletInitPendingPath: join(seedLayout.walletStateRoot, "wallet-init-pending.enc"),
    walletInitPendingBackupPath: join(seedLayout.walletStateRoot, "wallet-init-pending.enc.bak"),
    walletUnlockSessionPath: join(seedLayout.walletRuntimeRoot, "wallet-unlock-session.enc"),
    walletExplicitLockPath: join(seedLayout.walletRuntimeRoot, "wallet-explicit-lock.json"),
    miningRoot: join(seedLayout.walletRuntimeRoot, "mining"),
    miningStatusPath: join(seedLayout.walletRuntimeRoot, "mining", "status.json"),
    miningEventsPath: join(seedLayout.walletRuntimeRoot, "mining", "events.jsonl"),
  };
}

export function resolveWalletRuntimePathsForTesting(
  resolution: WalletRuntimePathResolution = {},
): WalletRuntimePaths {
  const paths = resolveCogcoinPathsForTesting(resolution);
  return deriveWalletRuntimePathsForSeed({
    dataRoot: paths.dataRoot,
    clientDataDir: paths.clientDataDir,
    clientConfigPath: paths.clientConfigPath,
    runtimeRoot: paths.runtimeRoot,
    walletRuntimeRoot: paths.runtimeRoot,
    stateRoot: paths.stateRoot,
    walletStateRoot: paths.stateRoot,
    seedRegistryPath: join(paths.stateRoot, "seed-index.json"),
    selectedSeedName: "main",
    selectedSeedKind: "main",
    bitcoinDataDir: paths.bitcoinDataDir,
    indexerRoot: paths.indexerRoot,
    walletStateDirectory: paths.stateRoot,
    walletStatePath: join(paths.stateRoot, "wallet-state.enc"),
    walletStateBackupPath: join(paths.stateRoot, "wallet-state.enc.bak"),
    walletInitPendingPath: join(paths.stateRoot, "wallet-init-pending.enc"),
    walletInitPendingBackupPath: join(paths.stateRoot, "wallet-init-pending.enc.bak"),
    walletUnlockSessionPath: join(paths.runtimeRoot, "wallet-unlock-session.enc"),
    walletExplicitLockPath: join(paths.runtimeRoot, "wallet-explicit-lock.json"),
    walletControlLockPath: paths.walletControlLockPath,
    bitcoindLockPath: paths.bitcoindLockPath,
    bitcoindStatusPath: paths.bitcoindStatusPath,
    indexerDaemonLockPath: paths.indexerDaemonLockPath,
    indexerStatusPath: paths.indexerStatusPath,
    miningRoot: join(paths.runtimeRoot, "mining"),
    miningStatusPath: join(paths.runtimeRoot, "mining", "status.json"),
    miningEventsPath: join(paths.runtimeRoot, "mining", "events.jsonl"),
    miningControlLockPath: paths.miningControlLockPath,
  }, resolution.seedName);
}
