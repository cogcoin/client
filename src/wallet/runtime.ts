import type { CogcoinPathResolution } from "../app-paths.js";
import { resolveCogcoinPathsForTesting } from "../app-paths.js";

export interface WalletRuntimePaths {
  dataRoot: string;
  clientConfigPath: string;
  runtimeRoot: string;
  hooksRoot: string;
  stateRoot: string;
  bitcoinDataDir: string;
  indexerRoot: string;
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
  hooksMiningDir: string;
  hooksMiningEntrypointPath: string;
  hooksMiningPackageJsonPath: string;
  miningRoot: string;
  miningStatusPath: string;
  miningEventsPath: string;
  miningControlLockPath: string;
}

export function resolveWalletRuntimePathsForTesting(
  resolution: CogcoinPathResolution = {},
): WalletRuntimePaths {
  const paths = resolveCogcoinPathsForTesting(resolution);

  return {
    dataRoot: paths.dataRoot,
    clientConfigPath: paths.clientConfigPath,
    runtimeRoot: paths.runtimeRoot,
    hooksRoot: paths.hooksRoot,
    stateRoot: paths.stateRoot,
    bitcoinDataDir: paths.bitcoinDataDir,
    indexerRoot: paths.indexerRoot,
    walletStatePath: paths.walletStatePath,
    walletStateBackupPath: paths.walletStateBackupPath,
    walletInitPendingPath: paths.walletInitPendingPath,
    walletInitPendingBackupPath: paths.walletInitPendingBackupPath,
    walletUnlockSessionPath: paths.walletUnlockSessionPath,
    walletExplicitLockPath: paths.walletExplicitLockPath,
    walletControlLockPath: paths.walletControlLockPath,
    bitcoindLockPath: paths.bitcoindLockPath,
    bitcoindStatusPath: paths.bitcoindStatusPath,
    indexerDaemonLockPath: paths.indexerDaemonLockPath,
    indexerStatusPath: paths.indexerStatusPath,
    hooksMiningDir: paths.hooksMiningDir,
    hooksMiningEntrypointPath: paths.hooksMiningEntrypointPath,
    hooksMiningPackageJsonPath: paths.hooksMiningPackageJsonPath,
    miningRoot: paths.miningRoot,
    miningStatusPath: paths.miningStatusPath,
    miningEventsPath: paths.miningEventsPath,
    miningControlLockPath: paths.miningControlLockPath,
  };
}
