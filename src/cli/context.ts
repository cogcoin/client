import { mkdir, readFile } from "node:fs/promises";

import {
  resolveDefaultBitcoindDataDirForTesting,
  resolveDefaultClientDatabasePathForTesting,
} from "../app-paths.js";
import { openManagedBitcoindClient } from "../bitcoind/index.js";
import { inspectPassiveClientStatus } from "../passive-status.js";
import { openSqliteStore } from "../sqlite/index.js";
import {
  exportWallet,
  importWallet,
  initializeWallet,
  lockWallet,
  repairWallet,
  unlockWallet,
} from "../wallet/lifecycle.js";
import { openWalletReadContext } from "../wallet/read/index.js";
import {
  disableMiningHooks,
  enableMiningHooks,
  followMiningLog,
  inspectMiningControlPlane,
  readMiningLog,
  runForegroundMining,
  setupBuiltInMining,
  startBackgroundMining,
  stopBackgroundMining,
} from "../wallet/mining/index.js";
import { createLazyDefaultWalletSecretProvider } from "../wallet/state/provider.js";
import {
  anchorDomain,
  buyDomain,
  claimCogLock,
  clearDomainDelegate,
  clearDomainEndpoint,
  clearDomainMiner,
  clearField,
  createField,
  giveReputation,
  lockCogToDomain,
  registerDomain,
  reclaimCogLock,
  revokeReputation,
  sendCog,
  setField,
  setDomainCanonical,
  setDomainDelegate,
  setDomainEndpoint,
  setDomainMiner,
  sellDomain,
  transferDomain,
} from "../wallet/tx/index.js";
import { createTerminalPrompter } from "./prompt.js";
import type { CliRunnerContext, RequiredCliRunnerContext } from "./types.js";

export async function readPackageVersionFromDisk(): Promise<string> {
  const raw = await readFile(new URL("../../package.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "0.0.0";
}

export function createDefaultContext(overrides: CliRunnerContext = {}): RequiredCliRunnerContext {
  return {
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    stdin: overrides.stdin ?? process.stdin,
    signalSource: overrides.signalSource ?? process,
    forceExit: overrides.forceExit ?? ((code) => {
      process.exit(code);
    }),
    openSqliteStore: overrides.openSqliteStore ?? openSqliteStore,
    openManagedBitcoindClient: overrides.openManagedBitcoindClient ?? openManagedBitcoindClient,
    inspectPassiveClientStatus: overrides.inspectPassiveClientStatus ?? inspectPassiveClientStatus,
    openWalletReadContext: overrides.openWalletReadContext ?? openWalletReadContext,
    initializeWallet: overrides.initializeWallet ?? initializeWallet,
    exportWallet: overrides.exportWallet ?? exportWallet,
    importWallet: overrides.importWallet ?? importWallet,
    unlockWallet: overrides.unlockWallet ?? unlockWallet,
    lockWallet: overrides.lockWallet ?? lockWallet,
    registerDomain: overrides.registerDomain ?? registerDomain,
    anchorDomain: overrides.anchorDomain ?? anchorDomain,
    transferDomain: overrides.transferDomain ?? transferDomain,
    sellDomain: overrides.sellDomain ?? sellDomain,
    buyDomain: overrides.buyDomain ?? buyDomain,
    sendCog: overrides.sendCog ?? sendCog,
    claimCogLock: overrides.claimCogLock ?? claimCogLock,
    reclaimCogLock: overrides.reclaimCogLock ?? reclaimCogLock,
    lockCogToDomain: overrides.lockCogToDomain ?? lockCogToDomain,
    setDomainEndpoint: overrides.setDomainEndpoint ?? setDomainEndpoint,
    clearDomainEndpoint: overrides.clearDomainEndpoint ?? clearDomainEndpoint,
    setDomainDelegate: overrides.setDomainDelegate ?? setDomainDelegate,
    clearDomainDelegate: overrides.clearDomainDelegate ?? clearDomainDelegate,
    setDomainMiner: overrides.setDomainMiner ?? setDomainMiner,
    clearDomainMiner: overrides.clearDomainMiner ?? clearDomainMiner,
    setDomainCanonical: overrides.setDomainCanonical ?? setDomainCanonical,
    createField: overrides.createField ?? createField,
    setField: overrides.setField ?? setField,
    clearField: overrides.clearField ?? clearField,
    giveReputation: overrides.giveReputation ?? giveReputation,
    revokeReputation: overrides.revokeReputation ?? revokeReputation,
    enableMiningHooks: overrides.enableMiningHooks ?? enableMiningHooks,
    disableMiningHooks: overrides.disableMiningHooks ?? disableMiningHooks,
    inspectMiningControlPlane: overrides.inspectMiningControlPlane ?? inspectMiningControlPlane,
    runForegroundMining: overrides.runForegroundMining ?? runForegroundMining,
    startBackgroundMining: overrides.startBackgroundMining ?? startBackgroundMining,
    stopBackgroundMining: overrides.stopBackgroundMining ?? stopBackgroundMining,
    setupBuiltInMining: overrides.setupBuiltInMining ?? setupBuiltInMining,
    readMiningLog: overrides.readMiningLog ?? readMiningLog,
    followMiningLog: overrides.followMiningLog ?? followMiningLog,
    repairWallet: overrides.repairWallet ?? repairWallet,
    walletSecretProvider: overrides.walletSecretProvider ?? createLazyDefaultWalletSecretProvider(),
    createPrompter: overrides.createPrompter ?? (() => createTerminalPrompter(
      overrides.stdin ?? process.stdin,
      overrides.stdout ?? process.stdout,
    )),
    ensureDirectory: overrides.ensureDirectory ?? (async (path) => {
      await mkdir(path, { recursive: true });
    }),
    readPackageVersion: overrides.readPackageVersion ?? readPackageVersionFromDisk,
    resolveDefaultBitcoindDataDir: overrides.resolveDefaultBitcoindDataDir ?? resolveDefaultBitcoindDataDirForTesting,
    resolveDefaultClientDatabasePath: overrides.resolveDefaultClientDatabasePath ?? resolveDefaultClientDatabasePathForTesting,
  };
}
