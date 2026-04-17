import { randomBytes } from "node:crypto";
import { access, constants, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { openClient } from "../client.js";
import {
  attachOrStartIndexerDaemon,
  probeIndexerDaemon,
  readSnapshotWithRetry,
} from "../bitcoind/indexer-daemon.js";
import {
  attachOrStartManagedBitcoindService,
  createManagedWalletReplica,
  probeManagedBitcoindService,
  withClaimedUninitializedManagedRuntime,
} from "../bitcoind/service.js";
import { resolveManagedServicePaths } from "../bitcoind/service-paths.js";
import { createRpcClient } from "../bitcoind/node.js";
import type {
  ManagedBitcoindServiceStatus,
  ManagedCoreWalletReplicaStatus,
} from "../bitcoind/types.js";
import { openSqliteStore } from "../sqlite/index.js";
import {
  normalizeWalletStateRecord,
  persistWalletCoinControlStateIfNeeded,
} from "./coin-control.js";
import {
  normalizeWalletDescriptorState,
  persistNormalizedWalletDescriptorStateIfNeeded,
  persistWalletStateUpdate,
  resolveNormalizedWalletDescriptorState,
  stripDescriptorChecksum,
} from "./descriptor-normalization.js";
import { acquireFileLock, clearOrphanedFileLock } from "./fs/lock.js";
import {
  createInternalCoreWalletPassphrase,
  createMnemonicConfirmationChallenge,
  deriveWalletMaterialFromMnemonic,
  generateWalletMaterial,
  isEnglishMnemonicWord,
  validateEnglishMnemonic,
} from "./material.js";
import {
  deriveWalletRuntimePathsForSeed,
  resolveWalletRuntimePathsForTesting,
  type WalletRuntimePaths,
} from "./runtime.js";
import { requestMiningGenerationPreemption, type MiningPreemptionHandle } from "./mining/coordination.js";
import { loadClientConfig } from "./mining/config.js";
import { loadMiningRuntimeStatus, saveMiningRuntimeStatus } from "./mining/runtime-artifacts.js";
import { normalizeMiningStateRecord } from "./mining/state.js";
import type { MiningRuntimeStatusV1 } from "./mining/types.js";
import { renderWalletMnemonicRevealArt } from "./mnemonic-art.js";
import {
  clearWalletPendingInitializationState,
  loadWalletPendingInitializationStateOrNull,
  saveWalletPendingInitializationState,
} from "./state/pending-init.js";
import {
  addImportedWalletSeedRecord,
  assertValidImportedWalletSeedName,
  ensureMainWalletSeedIndexRecord,
  findWalletSeedRecord,
  loadWalletSeedIndex,
  removeWalletSeedRecord,
} from "./state/seed-index.js";
import {
  createDefaultWalletSecretProvider,
  ensureClientPasswordConfigured,
  createWalletPendingInitSecretReference,
  createWalletRootId,
  createWalletSecretReference,
  withInteractiveWalletSecretProvider,
  type WalletSecretProvider,
} from "./state/provider.js";
import {
  clearLegacyWalletLockArtifacts,
  withUnlockedManagedCoreWallet,
} from "./managed-core-wallet.js";
import {
  extractWalletRootIdHintFromWalletStateEnvelope,
  loadRawWalletStateEnvelope,
  loadWalletState,
  saveWalletState,
} from "./state/storage.js";
import type {
  WalletPendingInitializationStateV1,
  WalletStateV1,
} from "./types.js";

export interface WalletPrompter {
  readonly isInteractive: boolean;
  writeLine(message: string): void;
  prompt(message: string): Promise<string>;
  promptHidden?(message: string): Promise<string>;
  clearSensitiveDisplay?(scope: "mnemonic-reveal" | "restore-mnemonic-entry"): void | Promise<void>;
}

export interface WalletInitializationResult {
  passwordAction: "created" | "migrated" | "already-configured";
  walletAction: "initialized" | "already-initialized";
  walletRootId: string;
  fundingAddress: string;
  state: WalletStateV1;
}

export interface WalletRestoreResult {
  seedName?: string | null;
  walletRootId: string;
  fundingAddress: string;
  state: WalletStateV1;
  warnings?: string[];
}

export interface WalletDeleteResult {
  seedName: string;
  walletRootId: string;
  deleted: boolean;
}

export interface WalletRepairResult {
  walletRootId: string;
  recoveredFromBackup: boolean;
  recreatedManagedCoreWallet: boolean;
  resetIndexerDatabase: boolean;
  bitcoindServiceAction: "none" | "cleared-stale-artifacts" | "stopped-incompatible-service" | "restarted-compatible-service";
  bitcoindCompatibilityIssue: "none" | "service-version-mismatch" | "wallet-root-mismatch" | "runtime-mismatch";
  managedCoreReplicaAction: "none" | "recreated";
  bitcoindPostRepairHealth: "ready" | "catching-up" | "starting" | "failed" | "unavailable";
  indexerDaemonAction: "none" | "cleared-stale-artifacts" | "stopped-incompatible-daemon" | "restarted-compatible-daemon";
  indexerCompatibilityIssue: "none" | "service-version-mismatch" | "wallet-root-mismatch" | "schema-mismatch";
  indexerPostRepairHealth: "starting" | "catching-up" | "synced" | "failed";
  miningPreRepairRunMode: "stopped" | "foreground" | "background";
  miningResumeAction: "none" | "skipped-not-resumable" | "skipped-post-repair-blocked" | "resumed-background" | "resume-failed";
  miningPostRepairRunMode: "stopped" | "background";
  miningResumeError: string | null;
  note: string | null;
}

export {
  previewResetWallet,
  resetWallet,
  type WalletResetPreview,
  type WalletResetResult,
} from "./reset.js";

interface WalletLifecycleRpcClient {
  getDescriptorInfo(descriptor: string): Promise<{
    descriptor: string;
    checksum: string;
  }>;
  createWallet(walletName: string, options: {
    blank: boolean;
    descriptors: boolean;
    disablePrivateKeys: boolean;
    loadOnStartup: boolean;
    passphrase: string;
  }): Promise<unknown>;
  walletPassphrase(walletName: string, passphrase: string, timeoutSeconds: number): Promise<null>;
  importDescriptors(walletName: string, requests: Array<{
    desc: string;
    timestamp: string | number;
    active?: boolean;
    internal?: boolean;
    range?: number | [number, number];
  }>): Promise<Array<{ success: boolean }>>;
  walletLock(walletName: string): Promise<null>;
  deriveAddresses(descriptor: string, range?: number | [number, number]): Promise<string[]>;
  listDescriptors(walletName: string, privateOnly?: boolean): Promise<{
    descriptors: Array<{ desc: string }>;
  }>;
  getWalletInfo(walletName: string): Promise<{
    walletname: string;
    private_keys_enabled: boolean;
    descriptors: boolean;
  }>;
  loadWallet(walletName: string, loadOnStartup?: boolean): Promise<{ name: string; warning: string }>;
  unloadWallet?(walletName: string, loadOnStartup?: boolean): Promise<null>;
  listWallets(): Promise<string[]>;
  getBlockchainInfo(): Promise<{
    blocks: number;
    headers: number;
  }>;
}

function sanitizeWalletName(walletRootId: string): string {
  return `cogcoin-${walletRootId}`.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 63);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFileOrNull<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    return null;
  }
}

function resolvePendingInitializationStoragePaths(paths: WalletRuntimePaths): {
  primaryPath: string;
  backupPath: string;
} {
  return {
    primaryPath: paths.walletInitPendingPath,
    backupPath: paths.walletInitPendingBackupPath,
  };
}

async function clearPendingInitialization(
  paths: WalletRuntimePaths,
  provider: WalletSecretProvider,
): Promise<void> {
  await clearWalletPendingInitializationState(
    resolvePendingInitializationStoragePaths(paths),
    {
      provider,
      secretReference: createWalletPendingInitSecretReference(paths.walletStateRoot),
    },
  );
}

async function loadOrCreatePendingInitializationMaterial(options: {
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  nowUnixMs: number;
}): Promise<ReturnType<typeof deriveWalletMaterialFromMnemonic>> {
  try {
    const loaded = await loadWalletPendingInitializationStateOrNull(
      resolvePendingInitializationStoragePaths(options.paths),
      {
        provider: options.provider,
      },
    );

    if (loaded !== null) {
      return deriveWalletMaterialFromMnemonic(loaded.state.mnemonic.phrase);
    }
  } catch {
    await clearPendingInitialization(options.paths, options.provider);
  }

  const material = generateWalletMaterial();
  const secretReference = createWalletPendingInitSecretReference(options.paths.walletStateRoot);
  const pendingState: WalletPendingInitializationStateV1 = {
    schemaVersion: 1,
    createdAtUnixMs: options.nowUnixMs,
    mnemonic: {
      phrase: material.mnemonic.phrase,
      language: material.mnemonic.language,
    },
  };

  await options.provider.storeSecret(secretReference.keyId, randomBytes(32));
  try {
    await saveWalletPendingInitializationState(
      resolvePendingInitializationStoragePaths(options.paths),
      pendingState,
      {
        provider: options.provider,
        secretReference,
      },
    );
  } catch (error) {
    await options.provider.deleteSecret(secretReference.keyId).catch(() => undefined);
    throw error;
  }

  return material;
}

function createInitialWalletState(options: {
  walletRootId: string;
  nowUnixMs: number;
  material: ReturnType<typeof deriveWalletMaterialFromMnemonic>;
  internalCoreWalletPassphrase: string;
}): WalletStateV1 {
  return {
    schemaVersion: 4,
    stateRevision: 1,
    lastWrittenAtUnixMs: options.nowUnixMs,
    walletRootId: options.walletRootId,
    network: "mainnet",
    anchorValueSats: 2_000,
    localScriptPubKeyHexes: [options.material.funding.scriptPubKeyHex],
    mnemonic: {
      phrase: options.material.mnemonic.phrase,
      language: options.material.mnemonic.language,
    },
    keys: {
      masterFingerprintHex: options.material.keys.masterFingerprintHex,
      accountPath: options.material.keys.accountPath,
      accountXprv: options.material.keys.accountXprv,
      accountXpub: options.material.keys.accountXpub,
    },
    descriptor: {
      privateExternal: options.material.descriptor.privateExternal,
      publicExternal: options.material.descriptor.publicExternal,
      checksum: options.material.descriptor.checksum,
      rangeEnd: options.material.descriptor.rangeEnd,
      safetyMargin: options.material.descriptor.safetyMargin,
    },
    funding: {
      address: options.material.funding.address,
      scriptPubKeyHex: options.material.funding.scriptPubKeyHex,
    },
    walletBirthTime: Math.floor(options.nowUnixMs / 1000),
    managedCoreWallet: {
      walletName: sanitizeWalletName(options.walletRootId),
      internalPassphrase: options.internalCoreWalletPassphrase,
      descriptorChecksum: null,
      walletAddress: null,
      walletScriptPubKeyHex: null,
      proofStatus: "not-proven",
      lastImportedAtUnixMs: null,
      lastVerifiedAtUnixMs: null,
    },
    domains: [],
    miningState: {
      runMode: "stopped",
      state: "idle",
      pauseReason: null,
      currentPublishState: "none",
      currentDomain: null,
      currentDomainId: null,
      currentDomainIndex: null,
      currentSenderScriptPubKeyHex: null,
      currentTxid: null,
      currentWtxid: null,
      currentFeeRateSatVb: null,
      currentAbsoluteFeeSats: null,
      currentScore: null,
      currentSentence: null,
      currentEncodedSentenceBytesHex: null,
      currentBip39WordIndices: null,
      currentBlendSeedHex: null,
      currentBlockTargetHeight: null,
      currentReferencedBlockHashDisplay: null,
      currentIntentFingerprintHex: null,
      livePublishInMempool: null,
      currentPublishDecision: null,
      replacementCount: 0,
      currentBlockFeeSpentSats: "0",
      sessionFeeSpentSats: "0",
      lifetimeFeeSpentSats: "0",
      sharedMiningConflictOutpoint: null,
    },
    pendingMutations: [],
  };
}

async function normalizeLoadedWalletStateIfNeeded(options: {
  provider: WalletSecretProvider;
  state: WalletStateV1;
  source: "primary" | "backup";
  nowUnixMs: number;
  paths: WalletRuntimePaths;
  dataDir?: string;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletLifecycleRpcClient;
}): Promise<{ state: WalletStateV1; source: "primary" | "backup" }> {
  let state = options.state;
  let source = options.source;

  if (options.dataDir !== undefined) {
    const node = await (options.attachService ?? attachOrStartManagedBitcoindService)({
      dataDir: options.dataDir,
      chain: "main",
      startHeight: 0,
      walletRootId: state.walletRootId,
    });

    try {
      const normalized = await persistNormalizedWalletDescriptorStateIfNeeded({
        state,
        access: {
          provider: options.provider,
          secretReference: createWalletSecretReference(state.walletRootId),
        },
        paths: options.paths,
        nowUnixMs: options.nowUnixMs,
        replacePrimary: options.source === "backup",
        rpc: (options.rpcFactory ?? createRpcClient)(node.rpc),
      });
      state = normalized.state;
      source = normalized.changed ? "primary" : options.source;
      const coinControl = await persistWalletCoinControlStateIfNeeded({
        state,
        access: {
          provider: options.provider,
          secretReference: createWalletSecretReference(state.walletRootId),
        },
        paths: options.paths,
        nowUnixMs: options.nowUnixMs,
        replacePrimary: source === "backup",
        rpc: createRpcClient(node.rpc),
      });
      state = coinControl.state;
      source = coinControl.changed ? "primary" : source;
    } finally {
      await node.stop?.().catch(() => undefined);
    }
  }

  return {
    state: normalizeWalletStateRecord({
      ...state,
      miningState: normalizeMiningStateRecord(state.miningState),
    }),
    source,
  };
}

async function promptRequiredValue(
  prompter: WalletPrompter,
  message: string,
): Promise<string> {
  const value = (await prompter.prompt(message)).trim();

  if (value === "") {
    throw new Error("wallet_prompt_value_required");
  }

  return value;
}

async function promptHiddenValue(
  prompter: WalletPrompter,
  message: string,
): Promise<string> {
  const value = prompter.promptHidden != null
    ? await prompter.promptHidden(message)
    : await prompter.prompt(message);

  return value.trim();
}

async function promptForRestoreMnemonic(
  prompter: WalletPrompter,
): Promise<string> {
  const words: string[] = [];

  for (let index = 0; index < 24; index += 1) {
    const word = (await promptRequiredValue(prompter, `Word ${index + 1} of 24: `)).toLowerCase();

    if (!isEnglishMnemonicWord(word)) {
      throw new Error("wallet_restore_mnemonic_invalid");
    }

    words.push(word);
  }

  const phrase = words.join(" ");

  if (!validateEnglishMnemonic(phrase)) {
    throw new Error("wallet_restore_mnemonic_invalid");
  }

  return phrase;
}

async function confirmTypedAcknowledgement(
  prompter: WalletPrompter,
  expected: string,
  message: string,
  errorCode = "wallet_typed_confirmation_rejected",
): Promise<void> {
  const answer = (await prompter.prompt(message)).trim();

  if (answer !== expected) {
    throw new Error(errorCode);
  }
}

async function confirmRestoreReplacement(
  prompter: WalletPrompter,
): Promise<void> {
  const answer = (await prompter.prompt(
    "Type \"RESTORE\" to replace the existing local wallet state and managed Core wallet replica: ",
  )).trim();

  if (answer !== "RESTORE") {
    throw new Error("wallet_restore_replace_confirmation_required");
  }
}

async function confirmYesNo(
  prompter: WalletPrompter,
  message: string,
): Promise<void> {
  const answer = (await prompter.prompt(message)).trim().toLowerCase();

  if (answer !== "yes") {
    throw new Error("wallet_delete_confirmation_required");
  }
}

async function recreateManagedCoreWalletReplica(
  state: WalletStateV1,
  provider: WalletSecretProvider,
  paths: WalletRuntimePaths,
  dataDir: string,
  nowUnixMs: number,
  options: {
    attachService?: typeof attachOrStartManagedBitcoindService;
    rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletLifecycleRpcClient;
  } = {},
): Promise<WalletStateV1> {
  const walletName = sanitizeWalletName(state.walletRootId);
  const walletDir = join(dataDir, "wallets", walletName);
  const quarantineDir = `${walletDir}.quarantine-${nowUnixMs}`;
  const node = await (options.attachService ?? attachOrStartManagedBitcoindService)({
    dataDir,
    chain: "main",
    startHeight: 0,
    walletRootId: state.walletRootId,
    managedWalletPassphrase: state.managedCoreWallet.internalPassphrase,
  });
  const rpc = (options.rpcFactory ?? createRpcClient)(node.rpc);

  if (rpc.unloadWallet != null) {
    await rpc.unloadWallet(walletName, false).catch(() => undefined);
  }

  if (await pathExists(walletDir)) {
    await rename(walletDir, quarantineDir).catch(() => undefined);
  }

  return importDescriptorIntoManagedCoreWallet(
    {
      ...state,
      managedCoreWallet: {
        ...state.managedCoreWallet,
        proofStatus: "not-proven",
      },
    },
    provider,
    paths,
    dataDir,
    nowUnixMs,
    options.attachService,
    options.rpcFactory,
  );
}

async function ensureIndexerDatabaseHealthy(options: {
  databasePath: string;
  dataDir: string;
  walletRootId: string;
  resetIfNeeded: boolean;
}): Promise<boolean> {
  try {
    if (await pathExists(options.databasePath)) {
      const header = await readFile(options.databasePath).then((buffer) => buffer.subarray(0, 16).toString("utf8"));

      if (header.length > 0 && header !== "SQLite format 3\u0000") {
        throw new Error("indexer_database_not_sqlite");
      }
    }

    const store = await openSqliteStore({ filename: options.databasePath });

    try {
      const client = await openClient({ store });
      try {
        await client.getTip();
      } finally {
        await client.close();
      }
    } finally {
      await store.close();
    }

    return false;
  } catch {
    if (!options.resetIfNeeded) {
      throw new Error("wallet_repair_indexer_reset_requires_yes");
    }

    await rm(options.databasePath, { force: true }).catch(() => undefined);
    await rm(`${options.databasePath}-wal`, { force: true }).catch(() => undefined);
    await rm(`${options.databasePath}-shm`, { force: true }).catch(() => undefined);
    await mkdir(dirname(options.databasePath), { recursive: true });
    return true;
  }
}

function mapIndexerCompatibilityToRepairIssue(
  compatibility: Awaited<ReturnType<typeof probeIndexerDaemon>>["compatibility"],
): WalletRepairResult["indexerCompatibilityIssue"] {
  switch (compatibility) {
    case "service-version-mismatch":
      return "service-version-mismatch";
    case "wallet-root-mismatch":
      return "wallet-root-mismatch";
    case "schema-mismatch":
      return "schema-mismatch";
    default:
      return "none";
  }
}

function mapBitcoindCompatibilityToRepairIssue(
  compatibility: Awaited<ReturnType<typeof probeManagedBitcoindService>>["compatibility"],
): WalletRepairResult["bitcoindCompatibilityIssue"] {
  switch (compatibility) {
    case "service-version-mismatch":
      return "service-version-mismatch";
    case "wallet-root-mismatch":
      return "wallet-root-mismatch";
    case "runtime-mismatch":
      return "runtime-mismatch";
    default:
      return "none";
  }
}

function mapBitcoindRepairHealth(options: {
  serviceState: ManagedBitcoindServiceStatus["state"] | null;
  catchingUp: boolean;
  replica: ManagedCoreWalletReplicaStatus | null;
}): WalletRepairResult["bitcoindPostRepairHealth"] {
  if (options.serviceState === null) {
    return "unavailable";
  }

  if (options.serviceState === "starting" || options.serviceState === "stopping") {
    return "starting";
  }

  if (options.serviceState !== "ready") {
    return "failed";
  }

  if (options.replica?.proofStatus === "missing" || options.replica?.proofStatus === "mismatch") {
    return "failed";
  }

  if (options.catchingUp) {
    return "catching-up";
  }

  return "ready";
}

function mapLeaseStateToRepairHealth(state: string): WalletRepairResult["indexerPostRepairHealth"] {
  switch (state) {
    case "synced":
      return "synced";
    case "catching-up":
    case "reorging":
      return "catching-up";
    case "starting":
    case "stopping":
      return "starting";
    default:
      return "failed";
  }
}

const INDEXER_DAEMON_HEARTBEAT_STALE_MS = 15_000;

async function verifyIndexerPostRepairHealth(options: {
  daemon: Awaited<ReturnType<typeof attachOrStartIndexerDaemon>>;
  probeIndexerDaemon: typeof probeIndexerDaemon;
  dataDir: string;
  walletRootId: string;
  nowUnixMs: number;
}): Promise<{
  health: WalletRepairResult["indexerPostRepairHealth"];
  daemonInstanceId: string;
}> {
  try {
    const lease = await readSnapshotWithRetry(options.daemon, options.walletRootId);
    return {
      health: mapLeaseStateToRepairHealth(lease.status.state),
      daemonInstanceId: lease.status.daemonInstanceId,
    };
  } catch (leaseError) {
    const probe = await options.probeIndexerDaemon({
      dataDir: options.dataDir,
      walletRootId: options.walletRootId,
    });

    try {
      if (
        probe.compatibility === "compatible"
        && probe.status !== null
        && (options.nowUnixMs - probe.status.heartbeatAtUnixMs) <= INDEXER_DAEMON_HEARTBEAT_STALE_MS
        && (probe.status.state === "starting" || probe.status.state === "catching-up" || probe.status.state === "reorging")
      ) {
        return {
          health: mapLeaseStateToRepairHealth(probe.status.state),
          daemonInstanceId: probe.status.daemonInstanceId,
        };
      }
    } finally {
      await probe.client?.close().catch(() => undefined);
    }

    throw leaseError;
  }
}

async function isProcessAlive(pid: number | null): Promise<boolean> {
  if (pid === null) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }

    return true;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 15_000, errorCode = "indexer_daemon_stop_timeout"): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!await isProcessAlive(pid)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(errorCode);
}

async function clearIndexerDaemonArtifacts(
  servicePaths: ReturnType<typeof resolveManagedServicePaths>,
): Promise<void> {
  await rm(servicePaths.indexerDaemonStatusPath, { force: true }).catch(() => undefined);
  await rm(servicePaths.indexerDaemonSocketPath, { force: true }).catch(() => undefined);
}

async function clearManagedBitcoindArtifacts(
  servicePaths: ReturnType<typeof resolveManagedServicePaths>,
): Promise<void> {
  await rm(servicePaths.bitcoindStatusPath, { force: true }).catch(() => undefined);
  await rm(servicePaths.bitcoindPidPath, { force: true }).catch(() => undefined);
  await rm(servicePaths.bitcoindReadyPath, { force: true }).catch(() => undefined);
  await rm(servicePaths.bitcoindWalletStatusPath, { force: true }).catch(() => undefined);
}

async function detectExistingManagedWalletReplica(dataDir: string): Promise<boolean> {
  try {
    const entries = await readdir(join(dataDir, "wallets"), { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory() && entry.name.startsWith("cogcoin-"));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function stopRecordedManagedProcess(
  pid: number | null,
  errorCode: string,
): Promise<void> {
  if (pid === null || !await isProcessAlive(pid)) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) {
      throw error;
    }
  }

  try {
    await waitForProcessExit(pid, 5_000, errorCode);
    return;
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) {
        throw error;
      }
    }
  }

  await waitForProcessExit(pid, 5_000, errorCode);
}

async function clearOrphanedRepairLocks(lockPaths: readonly string[]): Promise<void> {
  for (const lockPath of lockPaths) {
    await clearOrphanedFileLock(lockPath, isProcessAlive);
  }
}

async function clearPreviousManagedWalletRuntime(options: {
  dataDir: string;
  walletRootId: string | null;
}): Promise<void> {
  if (options.walletRootId === null) {
    return;
  }

  const servicePaths = resolveManagedServicePaths(options.dataDir, options.walletRootId);
  const bitcoindLock = await acquireFileLock(servicePaths.bitcoindLockPath, {
    purpose: "wallet-restore-cleanup",
    walletRootId: options.walletRootId,
  });
  const indexerLock = await acquireFileLock(servicePaths.indexerDaemonLockPath, {
    purpose: "wallet-restore-cleanup",
    walletRootId: options.walletRootId,
  });

  try {
    const bitcoindStatus = await readJsonFileOrNull<{ processId?: number | null }>(servicePaths.bitcoindStatusPath);
    const indexerStatus = await readJsonFileOrNull<{ processId?: number | null }>(servicePaths.indexerDaemonStatusPath);
    await stopRecordedManagedProcess(bitcoindStatus?.processId ?? null, "managed_bitcoind_stop_timeout");
    await stopRecordedManagedProcess(indexerStatus?.processId ?? null, "indexer_daemon_stop_timeout");
    await clearManagedBitcoindArtifacts(servicePaths);
    await clearIndexerDaemonArtifacts(servicePaths);
    await rm(servicePaths.walletRuntimeRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(servicePaths.indexerServiceRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(join(options.dataDir, "wallets", sanitizeWalletName(options.walletRootId)), { recursive: true, force: true }).catch(() => undefined);
  } finally {
    await indexerLock.release();
    await bitcoindLock.release();
  }
}

function formatRestoreCleanupWarning(error: unknown): string {
  const reason = error instanceof Error && error.message.trim().length > 0
    ? ` (${error.message})`
    : "";

  return `Previous managed runtime cleanup did not complete${reason}. Run \`cogcoin repair\` if status shows stale or conflicting managed services.`;
}

function createSilentNonInteractivePrompter(): WalletPrompter {
  return {
    isInteractive: false,
    writeLine() {},
    async prompt(): Promise<string> {
      return "";
    },
  };
}

function resolveMainWalletPaths(paths: WalletRuntimePaths): WalletRuntimePaths {
  return deriveWalletRuntimePathsForSeed(paths, "main");
}

async function loadSharedWalletSeedIndex(
  paths: WalletRuntimePaths,
  nowUnixMs: number,
) {
  const mainPaths = resolveMainWalletPaths(paths);
  return await loadWalletSeedIndex({
    paths: mainPaths,
    nowUnixMs,
  });
}

function applyRepairStoppedMiningState(state: WalletStateV1): WalletStateV1 {
  const miningState = normalizeMiningStateRecord(state.miningState);

  return {
    ...state,
    miningState: {
      ...miningState,
      runMode: "stopped",
      state: miningState.livePublishInMempool
        ? miningState.state === "paused-stale"
          ? "paused-stale"
          : "paused"
        : miningState.state === "repair-required"
          ? "repair-required"
          : "idle",
      pauseReason: miningState.livePublishInMempool
        ? miningState.state === "paused-stale"
          ? "stale-block-context"
          : "wallet-repair"
        : miningState.state === "repair-required"
          ? miningState.pauseReason
          : null,
    },
  };
}

function createStoppedBackgroundRuntimeSnapshot(
  snapshot: MiningRuntimeStatusV1,
  nowUnixMs: number,
): MiningRuntimeStatusV1 {
  return {
    ...snapshot,
    updatedAtUnixMs: nowUnixMs,
    runMode: "stopped",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    backgroundWorkerHeartbeatAtUnixMs: null,
    backgroundWorkerHealth: null,
    currentPhase: "idle",
    note: snapshot.livePublishInMempool
      ? "Background mining stopped for wallet repair. The last mining transaction may still confirm from mempool."
      : "Background mining stopped for wallet repair.",
  };
}

async function persistRepairState(options: {
  state: WalletStateV1;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  nowUnixMs: number;
  replacePrimary?: boolean;
}): Promise<WalletStateV1> {
  return await persistWalletStateUpdate({
    state: options.state,
    access: {
      provider: options.provider,
      secretReference: createWalletSecretReference(options.state.walletRootId),
    },
    paths: options.paths,
    nowUnixMs: options.nowUnixMs,
    replacePrimary: options.replacePrimary,
  });
}

async function stopBackgroundMiningForRepair(options: {
  paths: WalletRuntimePaths;
  snapshot: MiningRuntimeStatusV1;
  nowUnixMs: number;
}): Promise<void> {
  const pid = options.snapshot.backgroundWorkerPid;

  if (pid !== null) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }

    await waitForProcessExit(pid, 15_000, "background_mining_stop_timeout");
  }

  await saveMiningRuntimeStatus(
    options.paths.miningStatusPath,
    createStoppedBackgroundRuntimeSnapshot(options.snapshot, options.nowUnixMs),
  );
}

async function canResumeBackgroundMiningAfterRepair(options: {
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  repairedState: WalletStateV1;
  bitcoindPostRepairHealth: WalletRepairResult["bitcoindPostRepairHealth"];
  indexerPostRepairHealth: WalletRepairResult["indexerPostRepairHealth"];
}): Promise<boolean> {
  if (
    options.bitcoindPostRepairHealth !== "ready"
    || options.indexerPostRepairHealth !== "synced"
    || normalizeMiningStateRecord(options.repairedState.miningState).state === "repair-required"
  ) {
    return false;
  }

  try {
    const config = await loadClientConfig({
      path: options.paths.clientConfigPath,
      provider: options.provider,
    });
    return config?.mining.builtIn != null;
  } catch {
    return false;
  }
}

async function ensureWalletNotInitialized(
  paths: WalletRuntimePaths,
  provider: WalletSecretProvider,
): Promise<void> {
  if (await pathExists(paths.walletStatePath) || await pathExists(paths.walletStateBackupPath)) {
    await clearPendingInitialization(paths, provider);
    throw new Error("wallet_already_initialized");
  }
}

function isWalletSecretAccessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("wallet_secret_missing_")
    || message.startsWith("wallet_secret_provider_");
}

function writeMnemonicReveal(
  prompter: WalletPrompter,
  phrase: string,
  introLines: readonly string[],
): void {
  const words = phrase.trim().split(/\s+/);

  for (const line of introLines) {
    prompter.writeLine(line);
  }

  for (const line of renderWalletMnemonicRevealArt(words)) {
    prompter.writeLine(line);
  }

  prompter.writeLine("Single-line copy:");
  prompter.writeLine(phrase);
}

async function confirmMnemonic(
  prompter: WalletPrompter,
  words: string[],
): Promise<void> {
  const challenge = createMnemonicConfirmationChallenge(words);

  for (const entry of challenge) {
    const answer = (await prompter.prompt(`Confirm word #${entry.index + 1}: `)).trim().toLowerCase();

    if (answer !== entry.word) {
      throw new Error(`wallet_init_confirmation_failed_word_${entry.index + 1}`);
    }
  }
}

async function importDescriptorIntoManagedCoreWallet(
  state: WalletStateV1,
  provider: WalletSecretProvider,
  paths: WalletRuntimePaths,
  dataDir: string,
  nowUnixMs: number,
  attachService: typeof attachOrStartManagedBitcoindService = attachOrStartManagedBitcoindService,
  rpcFactory: (config: Parameters<typeof createRpcClient>[0]) => WalletLifecycleRpcClient = createRpcClient,
): Promise<WalletStateV1> {
  const node = await attachService({
    dataDir,
    chain: "main",
    startHeight: 0,
    walletRootId: state.walletRootId,
    managedWalletPassphrase: state.managedCoreWallet.internalPassphrase,
  });
  const rpc = rpcFactory(node.rpc);
  await createManagedWalletReplica(rpc, state.walletRootId, {
    managedWalletPassphrase: state.managedCoreWallet.internalPassphrase,
  });
  const normalizedDescriptors = await resolveNormalizedWalletDescriptorState(state, rpc);
  const walletName = sanitizeWalletName(state.walletRootId);

  await withUnlockedManagedCoreWallet({
    rpc,
    walletName,
    internalPassphrase: state.managedCoreWallet.internalPassphrase,
    run: async () => {
      const importResults = await rpc.importDescriptors(walletName, [{
        desc: normalizedDescriptors.privateExternal,
        timestamp: state.walletBirthTime,
        active: false,
        internal: false,
        range: [0, state.descriptor.rangeEnd],
      }]);

      if (!importResults.every((result) => result.success)) {
        throw new Error(`wallet_descriptor_import_failed_${JSON.stringify(importResults)}`);
      }
    },
  });

  const derivedFunding = await rpc.deriveAddresses(normalizedDescriptors.publicExternal, [0, 0]);

  if (derivedFunding[0] !== state.funding.address) {
    throw new Error("wallet_funding_address_verification_failed");
  }

  const descriptors = await rpc.listDescriptors(walletName);
  const importedDescriptor = descriptors.descriptors.find((entry) => entry.desc === normalizedDescriptors.publicExternal);

  if (importedDescriptor == null) {
    throw new Error("wallet_descriptor_not_present_after_import");
  }

  const verifiedReplica: ManagedCoreWalletReplicaStatus = {
    walletRootId: state.walletRootId,
    walletName,
    loaded: true,
    descriptors: true,
    privateKeysEnabled: true,
    created: false,
    proofStatus: "ready",
    descriptorChecksum: normalizedDescriptors.checksum,
    fundingAddress0: state.funding.address,
    fundingScriptPubKeyHex0: state.funding.scriptPubKeyHex,
    message: null,
  };

  const nextState: WalletStateV1 = {
    ...state,
    stateRevision: state.stateRevision + 1,
    lastWrittenAtUnixMs: nowUnixMs,
    descriptor: {
      ...state.descriptor,
      privateExternal: normalizedDescriptors.privateExternal,
      publicExternal: normalizedDescriptors.publicExternal,
      checksum: normalizedDescriptors.checksum,
    },
    managedCoreWallet: {
      ...state.managedCoreWallet,
      walletName,
      descriptorChecksum: normalizedDescriptors.checksum,
      walletAddress: verifiedReplica.fundingAddress0 ?? null,
      walletScriptPubKeyHex: verifiedReplica.fundingScriptPubKeyHex0 ?? null,
      proofStatus: "ready",
      lastImportedAtUnixMs: nowUnixMs,
      lastVerifiedAtUnixMs: nowUnixMs,
    },
  };

  await saveWalletState(
    {
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    },
    nextState,
    {
      provider,
      secretReference: createWalletSecretReference(state.walletRootId),
    },
  );

  return nextState;
}

export async function verifyManagedCoreWalletReplica(
  state: WalletStateV1,
  dataDir: string,
  dependencies: {
    nodeHandle?: { rpc: Parameters<typeof createRpcClient>[0] };
    attachService?: typeof attachOrStartManagedBitcoindService;
    rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletLifecycleRpcClient;
  } = {},
): Promise<ManagedCoreWalletReplicaStatus> {
  const walletName = state.managedCoreWallet.walletName;

  try {
    const node = dependencies.nodeHandle ?? await (dependencies.attachService ?? attachOrStartManagedBitcoindService)({
      dataDir,
      chain: "main",
      startHeight: 0,
      walletRootId: state.walletRootId,
    });
    const rpc = (dependencies.rpcFactory ?? createRpcClient)(node.rpc);
    const info = await rpc.getWalletInfo(walletName);
    const descriptors = await rpc.listDescriptors(walletName);
    const matchingDescriptor = state.managedCoreWallet.descriptorChecksum === null
      ? null
      : descriptors.descriptors.find((entry) => entry.desc.endsWith(`#${state.managedCoreWallet.descriptorChecksum}`));

    if (matchingDescriptor == null) {
      return {
        walletRootId: state.walletRootId,
        walletName,
        loaded: true,
        descriptors: info.descriptors,
        privateKeysEnabled: info.private_keys_enabled,
        created: false,
        proofStatus: "missing",
        descriptorChecksum: state.managedCoreWallet.descriptorChecksum,
        fundingAddress0: state.managedCoreWallet.walletAddress,
        fundingScriptPubKeyHex0: state.managedCoreWallet.walletScriptPubKeyHex,
        message: "Expected descriptor is missing from the managed Core wallet.",
      };
    }

    const derived = await rpc.deriveAddresses(state.descriptor.publicExternal, [0, 0]);

    if (derived[0] !== state.funding.address) {
      return {
        walletRootId: state.walletRootId,
        walletName,
        loaded: true,
        descriptors: info.descriptors,
        privateKeysEnabled: info.private_keys_enabled,
        created: false,
        proofStatus: "mismatch",
        descriptorChecksum: state.managedCoreWallet.descriptorChecksum,
        fundingAddress0: derived[0] ?? null,
        fundingScriptPubKeyHex0: null,
        message: "The managed Core wallet funding address does not match the trusted wallet state.",
      };
    }

    return {
      walletRootId: state.walletRootId,
      walletName,
      loaded: true,
      descriptors: info.descriptors,
      privateKeysEnabled: info.private_keys_enabled,
      created: false,
      proofStatus: "ready",
      descriptorChecksum: state.managedCoreWallet.descriptorChecksum,
      fundingAddress0: state.funding.address,
      fundingScriptPubKeyHex0: state.funding.scriptPubKeyHex,
      message: null,
    };
  } catch (error) {
    return {
      walletRootId: state.walletRootId,
      walletName,
      loaded: false,
      descriptors: false,
      privateKeysEnabled: false,
      created: false,
      proofStatus: "not-proven",
      descriptorChecksum: state.managedCoreWallet.descriptorChecksum,
      fundingAddress0: state.managedCoreWallet.walletAddress,
      fundingScriptPubKeyHex0: state.managedCoreWallet.walletScriptPubKeyHex,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function loadWalletStateForAccess(options: {
  provider?: WalletSecretProvider;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  dataDir?: string;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletLifecycleRpcClient;
} = {}): Promise<{ state: WalletStateV1; source: "primary" | "backup" }> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const loaded = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });
  return normalizeLoadedWalletStateIfNeeded({
    provider,
    state: loaded.state,
    source: loaded.source,
    nowUnixMs,
    paths,
    dataDir: options.dataDir,
    attachService: options.attachService,
    rpcFactory: options.rpcFactory,
  });
}

export async function initializeWallet(options: {
  dataDir: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletLifecycleRpcClient;
}): Promise<WalletInitializationResult> {
  if (!options.prompter.isInteractive) {
    throw new Error("wallet_init_requires_tty");
  }

  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const interactiveProvider = withInteractiveWalletSecretProvider(provider, options.prompter);
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();

  if (paths.selectedSeedName !== "main") {
    throw new Error("wallet_init_seed_not_supported");
  }

  const controlLock = await acquireFileLock(paths.walletControlLockPath, {
    purpose: "wallet-init",
    walletRootId: null,
  });

  try {
    const passwordAction = await ensureClientPasswordConfigured(provider, options.prompter);
    const hasWalletState = await pathExists(paths.walletStatePath) || await pathExists(paths.walletStateBackupPath);

    if (hasWalletState) {
      await clearPendingInitialization(paths, interactiveProvider);
      const loaded = await loadWalletStateForAccess({
        provider: interactiveProvider,
        nowUnixMs,
        paths,
        dataDir: options.dataDir,
        attachService: options.attachService,
        rpcFactory: options.rpcFactory,
      });

      return {
        passwordAction,
        walletAction: "already-initialized",
        walletRootId: loaded.state.walletRootId,
        fundingAddress: loaded.state.funding.address,
        state: loaded.state,
      };
    }

    const material = await loadOrCreatePendingInitializationMaterial({
      provider: interactiveProvider,
      paths,
      nowUnixMs,
    });
    let mnemonicRevealed = false;
    writeMnemonicReveal(options.prompter, material.mnemonic.phrase, [
      "Cogcoin Wallet Initialization",
      "Write down this 24-word recovery phrase.",
      "The same phrase will be shown again until confirmation succeeds:",
      "",
    ]);
    mnemonicRevealed = true;
    try {
      await confirmMnemonic(options.prompter, material.mnemonic.words);
    } finally {
      if (mnemonicRevealed) {
        await Promise.resolve()
          .then(() => options.prompter.clearSensitiveDisplay?.("mnemonic-reveal"))
          .catch(() => undefined);
      }
    }

    const walletRootId = createWalletRootId();
    const internalCoreWalletPassphrase = createInternalCoreWalletPassphrase();
    const secretReference = createWalletSecretReference(walletRootId);
    const secret = randomBytes(32);
    await interactiveProvider.storeSecret(secretReference.keyId, secret);

    const initialState = createInitialWalletState({
      walletRootId,
      nowUnixMs,
      material,
      internalCoreWalletPassphrase,
    });
    const verifiedState = await withClaimedUninitializedManagedRuntime({
      dataDir: options.dataDir,
      walletRootId,
    }, async () => {
      await saveWalletState(
        {
          primaryPath: paths.walletStatePath,
          backupPath: paths.walletStateBackupPath,
        },
        initialState,
        {
          provider: interactiveProvider,
          secretReference,
        },
      );

      return importDescriptorIntoManagedCoreWallet(
        initialState,
        interactiveProvider,
        paths,
        options.dataDir,
        nowUnixMs,
        options.attachService,
        options.rpcFactory,
      );
    });
    await clearLegacyWalletLockArtifacts(paths.walletRuntimeRoot);
    await clearPendingInitialization(paths, interactiveProvider);
    await ensureMainWalletSeedIndexRecord({
      paths: resolveMainWalletPaths(paths),
      walletRootId,
      nowUnixMs,
    });

    return {
      passwordAction,
      walletAction: "initialized",
      walletRootId,
      fundingAddress: verifiedState.funding.address,
      state: verifiedState,
    };
  } finally {
    await controlLock.release();
  }
}

export async function showWalletMnemonic(options: {
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
}): Promise<void> {
  if (!options.prompter.isInteractive) {
    throw new Error("wallet_show_mnemonic_requires_tty");
  }

  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const interactiveProvider = withInteractiveWalletSecretProvider(provider, options.prompter);
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const controlLock = await acquireFileLock(paths.walletControlLockPath, {
    purpose: "wallet-show-mnemonic",
    walletRootId: null,
  });

  try {
    const [hasPrimaryStateFile, hasBackupStateFile] = await Promise.all([
      pathExists(paths.walletStatePath),
      pathExists(paths.walletStateBackupPath),
    ]);

    if (!hasPrimaryStateFile && !hasBackupStateFile) {
      throw new Error("wallet_uninitialized");
    }

    const loaded = await loadWalletStateForAccess({
      provider: interactiveProvider,
      nowUnixMs,
      paths,
    }).catch((error) => {
      if (isWalletSecretAccessError(error)) {
        throw new Error("wallet_secret_provider_unavailable");
      }

      throw new Error("local-state-corrupt");
    });

    await confirmTypedAcknowledgement(
      options.prompter,
      "show mnemonic",
      "Type \"show mnemonic\" to continue: ",
      "wallet_show_mnemonic_typed_ack_required",
    );

    let mnemonicRevealed = false;
    writeMnemonicReveal(options.prompter, loaded.state.mnemonic.phrase, [
      "Cogcoin Wallet Recovery Phrase",
      "This 24-word recovery phrase controls the wallet.",
      "",
    ]);
    mnemonicRevealed = true;

    try {
      await options.prompter.prompt("Press Enter to clear the recovery phrase from the screen: ");
    } finally {
      if (mnemonicRevealed) {
        await Promise.resolve()
          .then(() => options.prompter.clearSensitiveDisplay?.("mnemonic-reveal"))
          .catch(() => undefined);
      }
    }
  } finally {
    await controlLock.release();
  }
}

export async function restoreWalletFromMnemonic(options: {
  dataDir: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletLifecycleRpcClient;
}): Promise<WalletRestoreResult> {
  if (!options.prompter.isInteractive) {
    throw new Error("wallet_restore_requires_tty");
  }

  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const interactiveProvider = withInteractiveWalletSecretProvider(provider, options.prompter);
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const seedName = assertValidImportedWalletSeedName(paths.selectedSeedName);
  const controlLock = await acquireFileLock(paths.walletControlLockPath, {
    purpose: "wallet-restore",
    walletRootId: null,
  });

  try {
    const mainPaths = resolveMainWalletPaths(paths);
    const seedIndex = await loadSharedWalletSeedIndex(paths, nowUnixMs);

    if (findWalletSeedRecord(seedIndex, "main") === null) {
      throw new Error("wallet_restore_requires_main_wallet");
    }

    if (findWalletSeedRecord(seedIndex, seedName) !== null) {
      throw new Error("wallet_seed_name_exists");
    }

    await ensureClientPasswordConfigured(provider, options.prompter);
    await ensureWalletNotInitialized(paths, interactiveProvider);
    let promptPhaseStarted = false;
    let mnemonicPhrase: string;

    try {
      promptPhaseStarted = true;
      mnemonicPhrase = await promptForRestoreMnemonic(options.prompter);
    } finally {
      if (promptPhaseStarted) {
        await options.prompter.clearSensitiveDisplay?.("restore-mnemonic-entry");
      }
    }

    await clearPendingInitialization(paths, interactiveProvider);
    const material = deriveWalletMaterialFromMnemonic(mnemonicPhrase);
    const walletRootId = createWalletRootId();
    const internalCoreWalletPassphrase = createInternalCoreWalletPassphrase();
    const secretReference = createWalletSecretReference(walletRootId);
    const secret = randomBytes(32);
    await interactiveProvider.storeSecret(secretReference.keyId, secret);

    const initialState = createInitialWalletState({
      walletRootId,
      nowUnixMs,
      material,
      internalCoreWalletPassphrase,
    });

    await clearLegacyWalletLockArtifacts(paths.walletRuntimeRoot);
    await saveWalletState(
      {
        primaryPath: paths.walletStatePath,
        backupPath: paths.walletStateBackupPath,
      },
      initialState,
      {
        provider: interactiveProvider,
        secretReference,
      },
    );

    const restoredState = await recreateManagedCoreWalletReplica(
      initialState,
      interactiveProvider,
      paths,
      options.dataDir,
      nowUnixMs,
      {
        attachService: options.attachService,
        rpcFactory: options.rpcFactory,
      },
    );
    await clearLegacyWalletLockArtifacts(paths.walletRuntimeRoot);
    await clearPendingInitialization(paths, interactiveProvider);
    await addImportedWalletSeedRecord({
      paths: mainPaths,
      seedName,
      walletRootId,
      nowUnixMs,
    });

    return {
      seedName,
      walletRootId,
      fundingAddress: restoredState.funding.address,
      state: restoredState,
      warnings: [],
    };
  } finally {
    await controlLock.release();
  }
}

export async function deleteImportedWalletSeed(options: {
  dataDir: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  assumeYes?: boolean;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  attachService?: typeof attachOrStartManagedBitcoindService;
  probeBitcoindService?: typeof probeManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletLifecycleRpcClient;
}): Promise<WalletDeleteResult> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  if ((paths.selectedSeedName ?? "main") === "main") {
    throw new Error("wallet_delete_main_not_supported");
  }
  const seedName = assertValidImportedWalletSeedName(paths.selectedSeedName);
  const controlLock = await acquireFileLock(paths.walletControlLockPath, {
    purpose: "wallet-delete",
    walletRootId: null,
  });

  try {
    const mainPaths = resolveMainWalletPaths(paths);
    const seedIndex = await loadSharedWalletSeedIndex(paths, nowUnixMs);
    const seedRecord = findWalletSeedRecord(seedIndex, seedName);

    if (seedRecord === null) {
      throw new Error("wallet_seed_not_found");
    }

    if (seedRecord.kind !== "imported") {
      throw new Error("wallet_delete_main_not_supported");
    }

    if (!options.assumeYes) {
      await confirmYesNo(
        options.prompter,
        `Delete imported seed "${seedName}" and release its local wallet artifacts? Type yes to continue: `,
      );
    }

    const probeManagedBitcoind = options.probeBitcoindService ?? probeManagedBitcoindService;
    const managedBitcoindProbe = await probeManagedBitcoind({
      dataDir: options.dataDir,
      chain: "main",
      startHeight: 0,
    }).catch(() => ({
      compatibility: "unreachable" as const,
      status: null,
      error: null,
    }));

    if (managedBitcoindProbe.compatibility !== "compatible" && managedBitcoindProbe.compatibility !== "unreachable") {
      throw new Error(managedBitcoindProbe.error ?? "managed_bitcoind_protocol_error");
    }

    if (managedBitcoindProbe.compatibility === "compatible") {
      const node = await (options.attachService ?? attachOrStartManagedBitcoindService)({
        dataDir: options.dataDir,
        chain: "main",
        startHeight: 0,
      });
      const rpc = (options.rpcFactory ?? createRpcClient)(node.rpc);
      const walletName = sanitizeWalletName(seedRecord.walletRootId);

      if (rpc.unloadWallet != null) {
        await rpc.unloadWallet(walletName, false).catch(() => undefined);
      }
    }

    await clearLegacyWalletLockArtifacts(paths.walletRuntimeRoot).catch(() => undefined);
    await clearPendingInitialization(paths, provider).catch(() => undefined);
    await provider.deleteSecret(createWalletSecretReference(seedRecord.walletRootId).keyId).catch(() => undefined);
    await rm(paths.walletStateRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(paths.walletRuntimeRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(join(options.dataDir, "wallets", sanitizeWalletName(seedRecord.walletRootId)), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    await removeWalletSeedRecord({
      paths: mainPaths,
      seedName,
      nowUnixMs,
    });

    return {
      seedName,
      walletRootId: seedRecord.walletRootId,
      deleted: true,
    };
  } finally {
    await controlLock.release();
  }
}

export async function repairWallet(options: {
  dataDir: string;
  databasePath: string;
  provider?: WalletSecretProvider;
  assumeYes?: boolean;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  attachService?: typeof attachOrStartManagedBitcoindService;
  probeBitcoindService?: typeof probeManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => WalletLifecycleRpcClient;
  attachIndexerDaemon?: typeof attachOrStartIndexerDaemon;
  probeIndexerDaemon?: typeof probeIndexerDaemon;
  requestMiningPreemption?: typeof requestMiningGenerationPreemption;
  startBackgroundMining?: typeof import("./mining/runner.js").startBackgroundMining;
}): Promise<WalletRepairResult> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const probeManagedBitcoind = options.probeBitcoindService ?? probeManagedBitcoindService;
  const attachManagedBitcoind = options.attachService ?? attachOrStartManagedBitcoindService;
  const probeManagedIndexerDaemon = options.probeIndexerDaemon ?? probeIndexerDaemon;
  const attachManagedIndexerDaemon = options.attachIndexerDaemon ?? attachOrStartIndexerDaemon;
  const requestMiningPreemptionForRepair = options.requestMiningPreemption ?? requestMiningGenerationPreemption;
  await clearOrphanedRepairLocks([
    paths.walletControlLockPath,
    paths.miningControlLockPath,
  ]);
  const controlLock = await acquireFileLock(paths.walletControlLockPath, {
    purpose: "wallet-repair",
    walletRootId: null,
  });

  try {
    let miningPreemption: MiningPreemptionHandle | null = null;
    let loaded;

    try {
      loaded = await loadWalletState({
        primaryPath: paths.walletStatePath,
        backupPath: paths.walletStateBackupPath,
      }, {
        provider,
      });
    } catch (error) {
      throw new Error("local-state-corrupt");
    }

    const recoveredFromBackup = loaded.source === "backup";
    const secretReference = createWalletSecretReference(loaded.state.walletRootId);
    let repairedState = loaded.state;
    let repairStateNeedsPersist = false;
    const servicePaths = resolveManagedServicePaths(options.dataDir, repairedState.walletRootId);
    await clearOrphanedRepairLocks([
      servicePaths.bitcoindLockPath,
      servicePaths.indexerDaemonLockPath,
    ]);
    const preRepairMiningRuntime = await loadMiningRuntimeStatus(paths.miningStatusPath).catch(() => null);
    const backgroundWorkerAlive = preRepairMiningRuntime?.runMode === "background"
      && preRepairMiningRuntime.backgroundWorkerPid !== null
      && await isProcessAlive(preRepairMiningRuntime.backgroundWorkerPid);
    const miningPreRepairRunMode: WalletRepairResult["miningPreRepairRunMode"] = backgroundWorkerAlive
      ? "background"
      : preRepairMiningRuntime?.runMode === "foreground"
        ? "foreground"
        : "stopped";
    const miningWasResumable = miningPreRepairRunMode === "background"
      && normalizeMiningStateRecord(repairedState.miningState).state !== "repair-required";
    let initialBitcoindProbe: Awaited<ReturnType<typeof probeManagedBitcoindService>> = {
      compatibility: "unreachable",
      status: null,
      error: null,
    };
    let bitcoindServiceAction: WalletRepairResult["bitcoindServiceAction"] = "none";
    let bitcoindCompatibilityIssue: WalletRepairResult["bitcoindCompatibilityIssue"] = "none";
    let managedCoreReplicaAction: WalletRepairResult["managedCoreReplicaAction"] = "none";
    let indexerDaemonAction: WalletRepairResult["indexerDaemonAction"] = "none";
    let indexerCompatibilityIssue: WalletRepairResult["indexerCompatibilityIssue"] = "none";
    let miningResumeAction: WalletRepairResult["miningResumeAction"] = miningPreRepairRunMode === "background"
      ? "skipped-not-resumable"
      : "none";
    let miningPostRepairRunMode: WalletRepairResult["miningPostRepairRunMode"] = "stopped";
    let miningResumeError: string | null = null;

    try {
      miningPreemption = await requestMiningPreemptionForRepair({
        paths,
        reason: "wallet-repair",
      });

      if (backgroundWorkerAlive && preRepairMiningRuntime !== null) {
        const miningLock = await acquireFileLock(paths.miningControlLockPath, {
          purpose: "wallet-repair-stop-background",
        });

        try {
          await stopBackgroundMiningForRepair({
            paths,
            snapshot: preRepairMiningRuntime,
            nowUnixMs,
          });
        } finally {
          await miningLock.release();
        }

        repairedState = applyRepairStoppedMiningState(repairedState);
        repairStateNeedsPersist = true;
      }

      if (!(options.assumeYes ?? false)) {
        await ensureIndexerDatabaseHealthy({
          databasePath: options.databasePath,
          dataDir: options.dataDir,
          walletRootId: repairedState.walletRootId,
          resetIfNeeded: false,
        });
      }

      const bitcoindLock = await acquireFileLock(servicePaths.bitcoindLockPath, {
        purpose: "managed-bitcoind-repair",
        walletRootId: repairedState.walletRootId,
        dataDir: options.dataDir,
      });

      let resetIndexerDatabase = false;
      let bitcoindHandle = null as Awaited<ReturnType<typeof attachManagedBitcoind>> | null;
      let bitcoindPostRepairHealth: WalletRepairResult["bitcoindPostRepairHealth"] = "unavailable";

      try {
        initialBitcoindProbe = await probeManagedBitcoind({
          dataDir: options.dataDir,
          chain: "main",
          startHeight: 0,
          walletRootId: repairedState.walletRootId,
        });

        bitcoindCompatibilityIssue = mapBitcoindCompatibilityToRepairIssue(initialBitcoindProbe.compatibility);

        if (
          initialBitcoindProbe.compatibility === "service-version-mismatch"
          || initialBitcoindProbe.compatibility === "wallet-root-mismatch"
          || initialBitcoindProbe.compatibility === "runtime-mismatch"
        ) {
          const processId = initialBitcoindProbe.status?.processId ?? null;

          if (processId === null) {
            throw new Error("managed_bitcoind_process_id_unavailable");
          }

          try {
            process.kill(processId, "SIGTERM");
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ESRCH") {
              throw error;
            }
          }
          await waitForProcessExit(processId, 15_000, "managed_bitcoind_stop_timeout");
          await clearManagedBitcoindArtifacts(servicePaths);
          bitcoindServiceAction = "stopped-incompatible-service";
        } else if (initialBitcoindProbe.compatibility === "unreachable") {
          const hasStaleArtifacts = await pathExists(servicePaths.bitcoindStatusPath)
            || await pathExists(servicePaths.bitcoindPidPath)
            || await pathExists(servicePaths.bitcoindReadyPath)
            || await pathExists(servicePaths.bitcoindWalletStatusPath);

          if (hasStaleArtifacts) {
            await clearManagedBitcoindArtifacts(servicePaths);
            bitcoindServiceAction = "cleared-stale-artifacts";
          }
        } else if (initialBitcoindProbe.compatibility === "protocol-error") {
          throw new Error(initialBitcoindProbe.error ?? "managed_bitcoind_protocol_error");
        }
      } finally {
        await bitcoindLock.release();
      }

      bitcoindHandle = await attachManagedBitcoind({
        dataDir: options.dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: repairedState.walletRootId,
      });
      const bitcoindRpc = (options.rpcFactory ?? createRpcClient)(bitcoindHandle.rpc);
      const normalizedDescriptorState = await normalizeWalletDescriptorState(repairedState, bitcoindRpc);

      if (normalizedDescriptorState.changed) {
        repairedState = normalizedDescriptorState.state;
        repairStateNeedsPersist = true;
      }
      const reconciledCoinControl = await persistWalletCoinControlStateIfNeeded({
        state: repairedState,
        access: {
          provider,
          secretReference,
        },
        paths,
        nowUnixMs,
        replacePrimary: recoveredFromBackup && !repairStateNeedsPersist,
        rpc: createRpcClient(bitcoindHandle.rpc),
      });
      repairedState = reconciledCoinControl.state;
      if (reconciledCoinControl.changed) {
        repairStateNeedsPersist = false;
      }

      let replica = await verifyManagedCoreWalletReplica(repairedState, options.dataDir, {
        nodeHandle: bitcoindHandle,
        attachService: options.attachService,
        rpcFactory: options.rpcFactory,
      });
      let recreatedManagedCoreWallet = false;

      if (replica.proofStatus !== "ready") {
        repairedState = await recreateManagedCoreWalletReplica(
          repairedState,
          provider,
          paths,
          options.dataDir,
          nowUnixMs,
          {
            attachService: options.attachService,
            rpcFactory: options.rpcFactory,
          },
        );
        recreatedManagedCoreWallet = true;
        managedCoreReplicaAction = "recreated";
        repairStateNeedsPersist = false;
        replica = await verifyManagedCoreWalletReplica(repairedState, options.dataDir, {
          nodeHandle: bitcoindHandle,
          attachService: options.attachService,
          rpcFactory: options.rpcFactory,
        });
      }

      const finalBitcoindStatus = await bitcoindHandle.refreshServiceStatus?.() ?? null;
      const chainInfo = await bitcoindRpc.getBlockchainInfo();
      bitcoindPostRepairHealth = mapBitcoindRepairHealth({
        serviceState: finalBitcoindStatus?.state ?? null,
        catchingUp: chainInfo.blocks < chainInfo.headers,
        replica,
      });

      if (bitcoindServiceAction === "none" && initialBitcoindProbe.compatibility === "unreachable") {
        bitcoindServiceAction = "restarted-compatible-service";
      }

      let initialIndexerDaemonInstanceId: string | null = null;
      let preAttachIndexerDaemonInstanceId: string | null = null;

      const indexerLock = await acquireFileLock(servicePaths.indexerDaemonLockPath, {
        purpose: "indexer-daemon-repair",
        walletRootId: repairedState.walletRootId,
        dataDir: options.dataDir,
        databasePath: options.databasePath,
      });

      try {
        const initialProbe = await probeManagedIndexerDaemon({
          dataDir: options.dataDir,
          walletRootId: repairedState.walletRootId,
        });

        indexerCompatibilityIssue = mapIndexerCompatibilityToRepairIssue(initialProbe.compatibility);
        initialIndexerDaemonInstanceId = initialProbe.status?.daemonInstanceId ?? null;

        if (initialProbe.compatibility === "compatible") {
          await initialProbe.client?.close().catch(() => undefined);
        } else if (
          initialProbe.compatibility === "service-version-mismatch"
          || initialProbe.compatibility === "wallet-root-mismatch"
          || initialProbe.compatibility === "schema-mismatch"
        ) {
          const processId = initialProbe.status?.processId ?? null;

          if (processId === null) {
            throw new Error("indexer_daemon_process_id_unavailable");
          }

          try {
            process.kill(processId, "SIGTERM");
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ESRCH") {
              throw error;
            }
          }
          await waitForProcessExit(processId);
          await clearIndexerDaemonArtifacts(servicePaths);
          indexerDaemonAction = "stopped-incompatible-daemon";
        } else if (initialProbe.compatibility === "unreachable") {
          const hasStaleArtifacts = await pathExists(servicePaths.indexerDaemonSocketPath)
            || await pathExists(servicePaths.indexerDaemonStatusPath);

          if (hasStaleArtifacts) {
            await clearIndexerDaemonArtifacts(servicePaths);
            indexerDaemonAction = "cleared-stale-artifacts";
          }
        } else {
          throw new Error(initialProbe.error ?? "indexer_daemon_protocol_error");
        }

        resetIndexerDatabase = await ensureIndexerDatabaseHealthy({
          databasePath: options.databasePath,
          dataDir: options.dataDir,
          walletRootId: repairedState.walletRootId,
          resetIfNeeded: options.assumeYes ?? false,
        });
      } finally {
        await indexerLock.release();
      }

      if (recoveredFromBackup) {
        repairedState = await persistRepairState({
          state: repairedState,
          provider,
          paths,
          nowUnixMs,
          replacePrimary: true,
        });
        repairStateNeedsPersist = false;
      } else if (repairStateNeedsPersist) {
        repairedState = await persistRepairState({
          state: repairedState,
          provider,
          paths,
          nowUnixMs,
        });
        repairStateNeedsPersist = false;
      }

      const preAttachProbe = await probeManagedIndexerDaemon({
        dataDir: options.dataDir,
        walletRootId: repairedState.walletRootId,
      });

      if (preAttachProbe.compatibility === "compatible") {
        preAttachIndexerDaemonInstanceId = preAttachProbe.status?.daemonInstanceId ?? null;
        await preAttachProbe.client?.close().catch(() => undefined);
      } else if (preAttachProbe.compatibility !== "unreachable") {
        throw new Error(preAttachProbe.error ?? "indexer_daemon_protocol_error");
      }

      const daemon = await attachManagedIndexerDaemon({
        dataDir: options.dataDir,
        databasePath: options.databasePath,
        walletRootId: repairedState.walletRootId,
      });

      try {
        const {
          health: indexerPostRepairHealth,
          daemonInstanceId: postRepairDaemonInstanceId,
        } = await verifyIndexerPostRepairHealth({
          daemon,
          probeIndexerDaemon: probeManagedIndexerDaemon,
          dataDir: options.dataDir,
          walletRootId: repairedState.walletRootId,
          nowUnixMs,
        });
        const restartedIndexerDaemon = indexerDaemonAction !== "none" || preAttachProbe.compatibility === "unreachable";

        if (
          restartedIndexerDaemon
          && initialIndexerDaemonInstanceId !== null
          && postRepairDaemonInstanceId === initialIndexerDaemonInstanceId
        ) {
          throw new Error("indexer_daemon_repair_identity_not_rotated");
        }

        if (
          !restartedIndexerDaemon
          && preAttachProbe.compatibility === "compatible"
          && preAttachIndexerDaemonInstanceId !== null
          && postRepairDaemonInstanceId !== preAttachIndexerDaemonInstanceId
        ) {
          throw new Error("indexer_daemon_repair_identity_changed");
        }

        if (indexerDaemonAction === "none" && preAttachProbe.compatibility === "unreachable") {
          indexerDaemonAction = "restarted-compatible-daemon";
        }

        if (miningWasResumable) {
          const postRepairResumeReady = await canResumeBackgroundMiningAfterRepair({
            provider,
            paths,
            repairedState,
            bitcoindPostRepairHealth,
            indexerPostRepairHealth,
          });

          if (!postRepairResumeReady) {
            miningResumeAction = "skipped-post-repair-blocked";
          } else {
            try {
              const startBackgroundMining = options.startBackgroundMining
                ?? (await import("./mining/runner.js")).startBackgroundMining;
              const resumed = await startBackgroundMining({
                dataDir: options.dataDir,
                databasePath: options.databasePath,
                provider,
                paths,
                prompter: createSilentNonInteractivePrompter(),
              });

              if (resumed.snapshot?.runMode === "background") {
                miningResumeAction = "resumed-background";
                miningPostRepairRunMode = "background";
              } else {
                miningResumeAction = "resume-failed";
                miningResumeError = "Background mining did not report a background runtime after repair.";
              }
            } catch (error) {
              miningResumeAction = "resume-failed";
              miningResumeError = error instanceof Error ? error.message : String(error);
            }
          }
        }
        await clearLegacyWalletLockArtifacts(paths.walletRuntimeRoot);

        return {
          walletRootId: repairedState.walletRootId,
          recoveredFromBackup,
          recreatedManagedCoreWallet,
          resetIndexerDatabase,
          bitcoindServiceAction,
          bitcoindCompatibilityIssue,
          managedCoreReplicaAction,
          bitcoindPostRepairHealth,
          indexerDaemonAction,
          indexerCompatibilityIssue,
          indexerPostRepairHealth,
          miningPreRepairRunMode,
          miningResumeAction,
          miningPostRepairRunMode,
          miningResumeError,
          note: resetIndexerDatabase
            ? "Indexer artifacts were reset and may still be catching up."
            : null,
        };
      } finally {
        await daemon.close().catch(() => undefined);
        await bitcoindHandle?.stop?.().catch(() => undefined);
      }
    } finally {
      await miningPreemption?.release().catch(() => undefined);
    }
  } finally {
    await controlLock.release();
  }
}
