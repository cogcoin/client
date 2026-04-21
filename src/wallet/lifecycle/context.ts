import { access, constants } from "node:fs/promises";

import {
  attachOrStartIndexerDaemon,
  probeIndexerDaemon,
} from "../../bitcoind/indexer-daemon.js";
import { createRpcClient } from "../../bitcoind/node.js";
import {
  attachOrStartManagedBitcoindService,
  probeManagedBitcoindService,
} from "../../bitcoind/service.js";
import { acquireFileLock } from "../fs/lock.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../runtime.js";
import {
  createDefaultWalletSecretProvider,
  type WalletSecretProvider,
} from "../state/provider.js";
import type {
  WalletManagedCoreContext,
  WalletManagedCoreDependencies,
  WalletPrompter,
  WalletRepairContext,
  WalletRepairDependencies,
  WalletSetupContext,
  WalletSetupDependencies,
} from "./types.js";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function walletStateExists(paths: WalletRuntimePaths): Promise<boolean> {
  const [hasPrimaryState, hasBackupState] = await Promise.all([
    pathExists(paths.walletStatePath),
    pathExists(paths.walletStateBackupPath),
  ]);

  return hasPrimaryState || hasBackupState;
}

export function resolveWalletManagedCoreContext(options: {
  provider?: WalletSecretProvider;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
} & WalletManagedCoreDependencies): WalletManagedCoreContext {
  return {
    provider: options.provider ?? createDefaultWalletSecretProvider(),
    paths: options.paths ?? resolveWalletRuntimePathsForTesting(),
    nowUnixMs: options.nowUnixMs ?? Date.now(),
    attachService: options.attachService ?? attachOrStartManagedBitcoindService,
    rpcFactory: options.rpcFactory ?? createRpcClient as WalletManagedCoreContext["rpcFactory"],
  };
}

export function resolveWalletSetupContext(options: {
  dataDir: string;
  prompter: WalletPrompter;
  provider?: WalletSecretProvider;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
} & WalletSetupDependencies): WalletSetupContext {
  return {
    ...resolveWalletManagedCoreContext(options),
    dataDir: options.dataDir,
    prompter: options.prompter,
  };
}

export function resolveWalletRepairContext(options: {
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  assumeYes?: boolean;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
} & WalletRepairDependencies): WalletRepairContext {
  return {
    ...resolveWalletManagedCoreContext(options),
    dataDir: options.dataDir,
    databasePath: options.databasePath,
    assumeYes: options.assumeYes ?? false,
    probeBitcoindService: options.probeBitcoindService ?? probeManagedBitcoindService,
    attachIndexerDaemon: options.attachIndexerDaemon ?? attachOrStartIndexerDaemon,
    probeIndexerDaemon: options.probeIndexerDaemon ?? probeIndexerDaemon,
    requestMiningPreemption: options.requestMiningPreemption,
  };
}

export async function acquireWalletControlLock(
  paths: WalletRuntimePaths,
  purpose: "wallet-init" | "wallet-show-mnemonic" | "wallet-repair",
) {
  return await acquireFileLock(paths.walletControlLockPath, {
    purpose,
    walletRootId: null,
  });
}
