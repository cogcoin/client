import { join } from "node:path";

import type { CogcoinPathResolution } from "../app-paths.js";
import { resolveCogcoinPathsForTesting } from "../app-paths.js";

export interface WalletRuntimePathResolution extends CogcoinPathResolution {}

export interface WalletRuntimePaths {
  dataRoot: string;
  clientDataDir: string;
  clientConfigPath: string;
  runtimeRoot: string;
  walletRuntimeRoot: string;
  stateRoot: string;
  walletStateRoot: string;
  bitcoinDataDir: string;
  indexerRoot: string;
  walletStateDirectory: string;
  walletStatePath: string;
  walletStateBackupPath: string;
  walletInitPendingPath: string;
  walletInitPendingBackupPath: string;
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

export function resolveWalletRuntimePathsForTesting(
  resolution: WalletRuntimePathResolution = {},
): WalletRuntimePaths {
  const paths = resolveCogcoinPathsForTesting(resolution);
  return {
    dataRoot: paths.dataRoot,
    clientDataDir: paths.clientDataDir,
    clientConfigPath: paths.clientConfigPath,
    runtimeRoot: paths.runtimeRoot,
    walletRuntimeRoot: paths.runtimeRoot,
    stateRoot: paths.stateRoot,
    walletStateRoot: paths.stateRoot,
    bitcoinDataDir: paths.bitcoinDataDir,
    indexerRoot: paths.indexerRoot,
    walletStateDirectory: paths.stateRoot,
    walletStatePath: join(paths.stateRoot, "wallet-state.enc"),
    walletStateBackupPath: join(paths.stateRoot, "wallet-state.enc.bak"),
    walletInitPendingPath: join(paths.stateRoot, "wallet-init-pending.enc"),
    walletInitPendingBackupPath: join(paths.stateRoot, "wallet-init-pending.enc.bak"),
    walletControlLockPath: paths.walletControlLockPath,
    bitcoindLockPath: paths.bitcoindLockPath,
    bitcoindStatusPath: paths.bitcoindStatusPath,
    indexerDaemonLockPath: paths.indexerDaemonLockPath,
    indexerStatusPath: paths.indexerStatusPath,
    miningRoot: join(paths.runtimeRoot, "mining"),
    miningStatusPath: join(paths.runtimeRoot, "mining", "status.json"),
    miningEventsPath: join(paths.runtimeRoot, "mining", "events.jsonl"),
    miningControlLockPath: paths.miningControlLockPath,
  };
}
