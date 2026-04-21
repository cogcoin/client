import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

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
import { openManagedIndexerMonitor } from "../bitcoind/indexer-monitor.js";
import { readPackageVersionFromDisk } from "../package-version.js";
import { inspectPassiveClientStatus } from "../passive-status.js";
import { openSqliteStore } from "../sqlite/index.js";
import {
  initializeWallet,
  previewResetWallet,
  repairWallet,
  resetWallet,
  showWalletMnemonic,
} from "../wallet/lifecycle.js";
import { resolveWalletRuntimePathsForTesting } from "../wallet/runtime.js";
import { openWalletReadContext } from "../wallet/read/index.js";
import { loadRawWalletStateEnvelope, loadWalletState } from "../wallet/state/storage.js";
import {
  ensureBuiltInMiningSetupIfNeeded,
  followMiningLog,
  inspectMiningControlPlane,
  inspectMiningDomainPromptState,
  readMiningLog,
  runForegroundMining,
  setupBuiltInMining,
  updateMiningDomainPrompt,
} from "../wallet/mining/index.js";
import { createLazyDefaultWalletSecretProvider } from "../wallet/state/provider.js";
import {
  anchorDomain,
  transferBitcoin,
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
import type { CliRunnerContext, RequiredCliRunnerContext, WritableLike } from "./types.js";

async function runGlobalClientUpdateInstall(options: {
  stdout: WritableLike;
  stderr: WritableLike;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const binary = process.platform === "win32" ? "npm.cmd" : "npm";

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ["install", "-g", "@cogcoin/client"], {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk) => {
      options.stdout.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk) => {
      options.stderr.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });

    child.on("error", (error) => {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("cli_update_npm_not_found"));
        return;
      }

      reject(new Error("cli_update_install_failed"));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error("cli_update_install_failed"));
    });
  });
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
    runGlobalClientUpdateInstall: overrides.runGlobalClientUpdateInstall ?? runGlobalClientUpdateInstall,
    openSqliteStore: overrides.openSqliteStore ?? openSqliteStore,
    openManagedBitcoindClient: overrides.openManagedBitcoindClient ?? openManagedBitcoindClient,
    openManagedIndexerMonitor: overrides.openManagedIndexerMonitor ?? openManagedIndexerMonitor,
    inspectPassiveClientStatus: overrides.inspectPassiveClientStatus ?? inspectPassiveClientStatus,
    openWalletReadContext: overrides.openWalletReadContext ?? openWalletReadContext,
    initializeWallet: overrides.initializeWallet ?? initializeWallet,
    previewResetWallet: overrides.previewResetWallet ?? previewResetWallet,
    showWalletMnemonic: overrides.showWalletMnemonic ?? showWalletMnemonic,
    registerDomain: overrides.registerDomain ?? registerDomain,
    anchorDomain: overrides.anchorDomain ?? anchorDomain,
    transferBitcoin: overrides.transferBitcoin ?? transferBitcoin,
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
    inspectMiningDomainPromptState: overrides.inspectMiningDomainPromptState ?? inspectMiningDomainPromptState,
    ensureBuiltInMiningSetupIfNeeded: overrides.ensureBuiltInMiningSetupIfNeeded ?? ensureBuiltInMiningSetupIfNeeded,
    runForegroundMining: overrides.runForegroundMining ?? runForegroundMining,
    setupBuiltInMining: overrides.setupBuiltInMining ?? setupBuiltInMining,
    updateMiningDomainPrompt: overrides.updateMiningDomainPrompt ?? updateMiningDomainPrompt,
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
    resolveWalletRuntimePaths: overrides.resolveWalletRuntimePaths ?? (() =>
      resolveWalletRuntimePathsForTesting()),
  };
}
