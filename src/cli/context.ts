import { mkdir, readFile } from "node:fs/promises";

import {
  attachOrStartIndexerDaemon,
  probeIndexerDaemon,
  readObservedIndexerDaemonStatus,
  stopIndexerDaemonService,
} from "../bitcoind/indexer-daemon.js";
import { createRpcClient } from "../bitcoind/node.js";
import {
  attachOrStartManagedBitcoindService,
  probeManagedBitcoindService,
  stopManagedBitcoindService,
} from "../bitcoind/service.js";
import {
  resolveDefaultBitcoindDataDirForTesting,
  resolveDefaultClientDatabasePathForTesting,
  resolveDefaultUpdateCheckStatePathForTesting,
} from "../app-paths.js";
import { openManagedBitcoindClient } from "../bitcoind/index.js";
import { inspectPassiveClientStatus } from "../passive-status.js";
import { openSqliteStore } from "../sqlite/index.js";
import {
  initializeWallet,
  deleteImportedWalletSeed,
  previewResetWallet,
  repairWallet,
  resetWallet,
  restoreWalletFromMnemonic,
  showWalletMnemonic,
} from "../wallet/lifecycle.js";
import { resolveWalletRuntimePathsForTesting } from "../wallet/runtime.js";
import { openWalletReadContext } from "../wallet/read/index.js";
import { loadRawWalletStateEnvelope, loadWalletState } from "../wallet/state/storage.js";
import {
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
  const packageUrls = [
    new URL("../../package.json", import.meta.url),
    new URL("../../../package.json", import.meta.url),
  ];

  for (const packageUrl of packageUrls) {
    try {
      const raw = await readFile(packageUrl, "utf8");
      const parsed = JSON.parse(raw) as { version?: string };
      return parsed.version ?? "0.0.0";
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : null;

      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  return "0.0.0";
}

export function createDefaultContext(overrides: CliRunnerContext = {}): RequiredCliRunnerContext {
  return {
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    stdin: overrides.stdin ?? process.stdin,
    env: overrides.env ?? process.env,
    now: overrides.now ?? (() => Date.now()),
    signalSource: overrides.signalSource ?? process,
    forceExit: overrides.forceExit ?? ((code) => {
      process.exit(code);
    }),
    fetchImpl: overrides.fetchImpl ?? fetch,
    openSqliteStore: overrides.openSqliteStore ?? openSqliteStore,
    openManagedBitcoindClient: overrides.openManagedBitcoindClient ?? openManagedBitcoindClient,
    inspectPassiveClientStatus: overrides.inspectPassiveClientStatus ?? inspectPassiveClientStatus,
    openWalletReadContext: overrides.openWalletReadContext ?? openWalletReadContext,
    initializeWallet: overrides.initializeWallet ?? initializeWallet,
    restoreWalletFromMnemonic: overrides.restoreWalletFromMnemonic ?? restoreWalletFromMnemonic,
    previewResetWallet: overrides.previewResetWallet ?? previewResetWallet,
    deleteImportedWalletSeed: overrides.deleteImportedWalletSeed ?? deleteImportedWalletSeed,
    showWalletMnemonic: overrides.showWalletMnemonic ?? showWalletMnemonic,
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
    inspectMiningControlPlane: overrides.inspectMiningControlPlane ?? inspectMiningControlPlane,
    runForegroundMining: overrides.runForegroundMining ?? runForegroundMining,
    startBackgroundMining: overrides.startBackgroundMining ?? startBackgroundMining,
    stopBackgroundMining: overrides.stopBackgroundMining ?? stopBackgroundMining,
    setupBuiltInMining: overrides.setupBuiltInMining ?? setupBuiltInMining,
    readMiningLog: overrides.readMiningLog ?? readMiningLog,
    followMiningLog: overrides.followMiningLog ?? followMiningLog,
    repairWallet: overrides.repairWallet ?? repairWallet,
    resetWallet: overrides.resetWallet ?? resetWallet,
    walletSecretProvider: overrides.walletSecretProvider ?? createLazyDefaultWalletSecretProvider(),
    createPrompter: overrides.createPrompter ?? (() => createTerminalPrompter(
      overrides.stdin ?? process.stdin,
      overrides.stdout ?? process.stdout,
    )),
    ensureDirectory: overrides.ensureDirectory ?? (async (path) => {
      await mkdir(path, { recursive: true });
    }),
    attachManagedBitcoindService: overrides.attachManagedBitcoindService ?? attachOrStartManagedBitcoindService,
    probeManagedBitcoindService: overrides.probeManagedBitcoindService ?? probeManagedBitcoindService,
    stopManagedBitcoindService: overrides.stopManagedBitcoindService ?? stopManagedBitcoindService,
    createBitcoinRpcClient: overrides.createBitcoinRpcClient ?? createRpcClient,
    attachIndexerDaemon: overrides.attachIndexerDaemon ?? attachOrStartIndexerDaemon,
    probeIndexerDaemon: overrides.probeIndexerDaemon ?? probeIndexerDaemon,
    readObservedIndexerDaemonStatus: overrides.readObservedIndexerDaemonStatus ?? readObservedIndexerDaemonStatus,
    stopIndexerDaemonService: overrides.stopIndexerDaemonService ?? stopIndexerDaemonService,
    readPackageVersion: overrides.readPackageVersion ?? readPackageVersionFromDisk,
    loadWalletState: overrides.loadWalletState ?? loadWalletState,
    loadRawWalletStateEnvelope: overrides.loadRawWalletStateEnvelope ?? loadRawWalletStateEnvelope,
    resolveDefaultBitcoindDataDir: overrides.resolveDefaultBitcoindDataDir ?? resolveDefaultBitcoindDataDirForTesting,
    resolveDefaultClientDatabasePath: overrides.resolveDefaultClientDatabasePath ?? resolveDefaultClientDatabasePathForTesting,
    resolveUpdateCheckStatePath: overrides.resolveUpdateCheckStatePath ?? resolveDefaultUpdateCheckStatePathForTesting,
    resolveWalletRuntimePaths: overrides.resolveWalletRuntimePaths ?? ((seedName) =>
      resolveWalletRuntimePathsForTesting({ seedName })),
  };
}
