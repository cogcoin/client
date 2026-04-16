import { randomBytes } from "node:crypto";
import { access, constants, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { DEFAULT_SNAPSHOT_METADATA } from "../bitcoind/bootstrap/constants.js";
import { createRpcClient } from "../bitcoind/node.js";
import { resolveBootstrapPathsForTesting } from "../bitcoind/bootstrap/paths.js";
import { validateSnapshotFileForTesting } from "../bitcoind/bootstrap/snapshot-file.js";
import {
  attachOrStartManagedBitcoindService,
  createManagedWalletReplica,
} from "../bitcoind/service.js";
import type {
  ManagedBitcoindObservedStatus,
  ManagedIndexerDaemonObservedStatus,
} from "../bitcoind/types.js";
import { resolveNormalizedWalletDescriptorState } from "./descriptor-normalization.js";
import { acquireFileLock, type FileLockHandle } from "./fs/lock.js";
import {
  createInternalCoreWalletPassphrase,
  deriveWalletIdentityMaterial,
  deriveWalletMaterialFromMnemonic,
} from "./material.js";
import { loadMiningRuntimeStatus } from "./mining/runtime-artifacts.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "./runtime.js";
import { loadWalletExplicitLock } from "./state/explicit-lock.js";
import {
  createDefaultWalletSecretProvider,
  createWalletRootId,
  createWalletSecretReference,
  type WalletSecretProvider,
} from "./state/provider.js";
import { loadWalletSeedIndex } from "./state/seed-index.js";
import {
  extractWalletRootIdHintFromWalletStateEnvelope,
  loadRawWalletStateEnvelope,
  loadWalletState,
  saveWalletState,
  type RawWalletStateEnvelope,
  type WalletStateSaveAccess,
} from "./state/storage.js";
import { confirmTypedAcknowledgement } from "./tx/confirm.js";
import type { WalletExplicitLockStateV1, WalletStateV1 } from "./types.js";
import type { WalletPrompter } from "./lifecycle.js";

export type WalletResetAction =
  | "not-present"
  | "kept-unchanged"
  | "retain-mnemonic"
  | "deleted";

export type WalletResetSecretCleanupStatus =
  | "deleted"
  | "not-found"
  | "failed"
  | "unknown";

export type WalletResetSnapshotResultStatus =
  | "not-present"
  | "invalid-removed"
  | "deleted"
  | "preserved";

export type WalletResetBitcoinDataDirResultStatus =
  | "not-present"
  | "preserved"
  | "deleted"
  | "outside-reset-scope";

export interface WalletResetResult {
  dataRoot: string;
  factoryResetReady: true;
  stoppedProcesses: {
    managedBitcoind: number;
    indexerDaemon: number;
    backgroundMining: number;
    survivors: number;
  };
  secretCleanupStatus: WalletResetSecretCleanupStatus;
  deletedSecretRefs: string[];
  failedSecretRefs: string[];
  preservedSecretRefs: string[];
  walletAction: WalletResetAction;
  walletOldRootId: string | null;
  walletNewRootId: string | null;
  bootstrapSnapshot: {
    status: WalletResetSnapshotResultStatus;
    path: string;
  };
  bitcoinDataDir: {
    status: WalletResetBitcoinDataDirResultStatus;
    path: string;
  };
  removedPaths: string[];
}

export interface WalletResetPreview {
  dataRoot: string;
  confirmationPhrase: "permanently reset";
  walletPrompt: null | {
    defaultAction: "retain-mnemonic";
    acceptedInputs: ["", "skip", "delete wallet"];
    entropyRetainingResetAvailable: boolean;
    requiresPassphrase: boolean;
    envelopeSource: "primary" | "backup" | null;
  };
  bootstrapSnapshot: {
    status: "not-present" | "invalid" | "valid";
    path: string;
    defaultAction: "preserve" | "delete";
  };
  bitcoinDataDir: {
    status: "not-present" | "within-reset-scope" | "outside-reset-scope";
    path: string;
    conditionalPrompt: null | {
      prompt: "Delete managed Bitcoin datadir too? [y/N]: ";
      defaultAction: "preserve";
      acceptedInputs: ["", "n", "no", "y", "yes"];
    };
  };
  trackedProcessKinds: Array<"managed-bitcoind" | "indexer-daemon" | "background-mining">;
  willDeleteOsSecrets: boolean;
  removedPaths: string[];
}

type WalletEnvelopeMode = "provider-backed" | "passphrase-wrapped" | "unknown";

interface WalletResetPreflight {
  dataRoot: string;
  removedRoots: string[];
  wallet: {
    present: boolean;
    mode: WalletEnvelopeMode;
    envelopeSource: "primary" | "backup" | null;
    secretProviderKeyId: string | null;
    importedSeedSecretProviderKeyIds: string[];
    explicitLock: WalletExplicitLockStateV1 | null;
    rawEnvelope: RawWalletStateEnvelope | null;
  };
  snapshot: {
    status: "not-present" | "invalid" | "valid";
    path: string;
    shouldPrompt: boolean;
    withinResetScope: boolean;
  };
  bitcoinDataDir: {
    status: "not-present" | "within-reset-scope" | "outside-reset-scope";
    path: string;
    shouldPrompt: boolean;
  };
  trackedProcesses: TrackedManagedProcess[];
  trackedProcessKinds: Array<TrackedManagedProcess["kind"]>;
  serviceLockPaths: string[];
}

interface TrackedManagedProcess {
  kind: "managed-bitcoind" | "indexer-daemon" | "background-mining";
  pid: number;
}

interface StagedArtifact {
  originalPath: string;
  stagedPath: string;
  restorePath: string;
}

interface WalletAccessForReset {
  loaded: {
    source: "primary" | "backup";
    state: WalletStateV1;
  };
  access:
    | { kind: "provider"; provider: WalletSecretProvider }
    | { kind: "passphrase"; passphrase: string };
}

interface ResetWalletRpcClient {
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
  listWallets(): Promise<string[]>;
}

interface ResetExecutionDecision {
  walletChoice: "" | "skip" | "delete wallet";
  deleteSnapshot: boolean;
  deleteBitcoinDataDir: boolean;
  loadedWalletForEntropyReset: WalletAccessForReset | null;
}

function sanitizeWalletName(walletRootId: string): string {
  return `cogcoin-${walletRootId}`.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 63);
}

function isPathWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && rel !== ".");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
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

async function waitForProcessExit(pid: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!await isProcessAlive(pid)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return !await isProcessAlive(pid);
}

async function terminateTrackedProcesses(
  trackedProcesses: readonly TrackedManagedProcess[],
): Promise<WalletResetResult["stoppedProcesses"]> {
  const survivors = new Set<number>();

  for (const processInfo of trackedProcesses) {
    try {
      process.kill(processInfo.pid, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }

  for (const processInfo of trackedProcesses) {
    if (!await waitForProcessExit(processInfo.pid, 5_000)) {
      survivors.add(processInfo.pid);
    }
  }

  for (const pid of survivors) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }

  const remaining = new Set<number>();
  for (const pid of survivors) {
    if (!await waitForProcessExit(pid, 5_000)) {
      remaining.add(pid);
    }
  }

  if (remaining.size > 0) {
    throw new Error("reset_process_shutdown_failed");
  }

  return {
    managedBitcoind: trackedProcesses.filter((processInfo) => processInfo.kind === "managed-bitcoind").length,
    indexerDaemon: trackedProcesses.filter((processInfo) => processInfo.kind === "indexer-daemon").length,
    backgroundMining: trackedProcesses.filter((processInfo) => processInfo.kind === "background-mining").length,
    survivors: 0,
  };
}

async function moveFile(sourcePath: string, destinationPath: string): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });

  try {
    await rename(sourcePath, destinationPath);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }

    await copyFile(sourcePath, destinationPath);
    await rm(sourcePath, { force: true });
  }
}

async function stageArtifact(
  sourcePath: string,
  stagingRoot: string,
  label: string,
): Promise<StagedArtifact | null> {
  if (!await pathExists(sourcePath)) {
    return null;
  }

  const stagedPath = join(stagingRoot, label);
  await moveFile(sourcePath, stagedPath);
  return {
    originalPath: sourcePath,
    stagedPath,
    restorePath: sourcePath,
  };
}

async function restoreStagedArtifacts(
  artifacts: readonly StagedArtifact[],
): Promise<void> {
  for (const artifact of artifacts) {
    if (!await pathExists(artifact.stagedPath)) {
      continue;
    }

    await moveFile(artifact.stagedPath, artifact.restorePath);
  }
}

function createEntropyRetainedWalletState(
  previousState: WalletStateV1,
  nowUnixMs: number,
): WalletStateV1 {
  const material = deriveWalletMaterialFromMnemonic(previousState.mnemonic.phrase);
  const walletRootId = createWalletRootId();
  void deriveWalletIdentityMaterial;

  return {
    schemaVersion: 4,
    stateRevision: 1,
    lastWrittenAtUnixMs: nowUnixMs,
    walletRootId,
    network: previousState.network,
    anchorValueSats: previousState.anchorValueSats,
    localScriptPubKeyHexes: [material.funding.scriptPubKeyHex],
    mnemonic: {
      phrase: previousState.mnemonic.phrase,
      language: previousState.mnemonic.language,
    },
    keys: {
      masterFingerprintHex: material.keys.masterFingerprintHex,
      accountPath: material.keys.accountPath,
      accountXprv: material.keys.accountXprv,
      accountXpub: material.keys.accountXpub,
    },
    descriptor: {
      privateExternal: material.descriptor.privateExternal,
      publicExternal: material.descriptor.publicExternal,
      checksum: null,
      rangeEnd: previousState.descriptor.rangeEnd,
      safetyMargin: previousState.descriptor.safetyMargin,
    },
    funding: {
      address: material.funding.address,
      scriptPubKeyHex: material.funding.scriptPubKeyHex,
    },
    walletBirthTime: previousState.walletBirthTime,
    managedCoreWallet: {
      walletName: sanitizeWalletName(walletRootId),
      internalPassphrase: createInternalCoreWalletPassphrase(),
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
    hookClientState: {
      mining: {
        mode: "builtin",
        validationState: "never",
        lastValidationAtUnixMs: null,
        lastValidationError: null,
        validatedLaunchFingerprint: null,
        validatedFullFingerprint: null,
        fullTrustWarningAcknowledgedAtUnixMs: null,
        consecutiveFailureCount: 0,
        cooldownUntilUnixMs: null,
      },
    },
    pendingMutations: [],
  };
}

async function recreateManagedCoreWalletReplicaForReset(options: {
  state: WalletStateV1;
  access: WalletStateSaveAccess;
  paths: WalletRuntimePaths;
  dataDir: string;
  nowUnixMs: number;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => ResetWalletRpcClient;
}): Promise<WalletStateV1> {
  const node = await (options.attachService ?? attachOrStartManagedBitcoindService)({
    dataDir: options.dataDir,
    chain: "main",
    startHeight: 0,
    walletRootId: options.state.walletRootId,
    managedWalletPassphrase: options.state.managedCoreWallet.internalPassphrase,
  });
  const rpc = (options.rpcFactory ?? createRpcClient)(node.rpc);
  await createManagedWalletReplica(rpc, options.state.walletRootId, {
    managedWalletPassphrase: options.state.managedCoreWallet.internalPassphrase,
  });
  const normalizedDescriptors = await resolveNormalizedWalletDescriptorState(options.state, rpc);
  const walletName = sanitizeWalletName(options.state.walletRootId);

  await rpc.walletPassphrase(walletName, options.state.managedCoreWallet.internalPassphrase, 10);
  try {
    const importResults = await rpc.importDescriptors(walletName, [{
      desc: normalizedDescriptors.privateExternal,
      timestamp: options.state.walletBirthTime,
      active: false,
      internal: false,
      range: [0, options.state.descriptor.rangeEnd],
    }]);

    if (!importResults.every((result) => result.success)) {
      throw new Error(`wallet_descriptor_import_failed_${JSON.stringify(importResults)}`);
    }
  } finally {
    await rpc.walletLock(walletName).catch(() => undefined);
  }

  const derivedFunding = await rpc.deriveAddresses(normalizedDescriptors.publicExternal, [0, 0]);

  if (derivedFunding[0] !== options.state.funding.address) {
    throw new Error("wallet_funding_address_verification_failed");
  }

  const descriptors = await rpc.listDescriptors(walletName);
  const importedDescriptor = descriptors.descriptors.find((entry) => entry.desc === normalizedDescriptors.publicExternal);

  if (importedDescriptor == null) {
    throw new Error("wallet_descriptor_not_present_after_import");
  }

  const nextState: WalletStateV1 = {
    ...options.state,
    stateRevision: options.state.stateRevision + 1,
    lastWrittenAtUnixMs: options.nowUnixMs,
    descriptor: {
      ...options.state.descriptor,
      privateExternal: normalizedDescriptors.privateExternal,
      publicExternal: normalizedDescriptors.publicExternal,
      checksum: normalizedDescriptors.checksum,
    },
    managedCoreWallet: {
      ...options.state.managedCoreWallet,
      walletName,
      descriptorChecksum: normalizedDescriptors.checksum,
      walletAddress: options.state.funding.address,
      walletScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
      proofStatus: "ready",
      lastImportedAtUnixMs: options.nowUnixMs,
      lastVerifiedAtUnixMs: options.nowUnixMs,
    },
  };

  await saveWalletState(
    {
      primaryPath: options.paths.walletStatePath,
      backupPath: options.paths.walletStateBackupPath,
    },
    nextState,
    options.access,
  );

  return nextState;
}

async function promptHiddenOrVisible(
  prompter: WalletPrompter,
  message: string,
): Promise<string> {
  if (typeof prompter.promptHidden === "function") {
    return await prompter.promptHidden(message);
  }

  return await prompter.prompt(message);
}

async function loadWalletForEntropyReset(options: {
  wallet: WalletResetPreflight["wallet"];
  paths: WalletRuntimePaths;
  provider: WalletSecretProvider;
  prompter: WalletPrompter;
}): Promise<WalletAccessForReset> {
  if (options.wallet.rawEnvelope === null) {
    throw new Error("reset_wallet_entropy_reset_unavailable");
  }

  if (options.wallet.mode === "provider-backed") {
    try {
      return {
        loaded: await loadWalletState(
          {
            primaryPath: options.paths.walletStatePath,
            backupPath: options.paths.walletStateBackupPath,
          },
          {
            provider: options.provider,
          },
        ),
        access: {
          kind: "provider",
          provider: options.provider,
        },
      };
    } catch {
      throw new Error("reset_wallet_entropy_reset_unavailable");
    }
  }

  if (options.wallet.mode !== "passphrase-wrapped") {
    throw new Error("reset_wallet_entropy_reset_unavailable");
  }

  const passphrase = (await promptHiddenOrVisible(
    options.prompter,
    "Wallet-state passphrase: ",
  )).trim();

  if (passphrase === "") {
    throw new Error("reset_wallet_passphrase_required");
  }

  try {
    return {
      loaded: await loadWalletState(
        {
          primaryPath: options.paths.walletStatePath,
          backupPath: options.paths.walletStateBackupPath,
        },
        passphrase,
      ),
      access: {
        kind: "passphrase",
        passphrase,
      },
    };
  } catch {
    throw new Error("reset_wallet_access_failed");
  }
}

async function collectTrackedManagedProcesses(
  paths: WalletRuntimePaths,
): Promise<{
  trackedProcesses: TrackedManagedProcess[];
  trackedProcessKinds: Array<TrackedManagedProcess["kind"]>;
  serviceLockPaths: string[];
}> {
  const trackedProcesses: TrackedManagedProcess[] = [];
  const trackedProcessKinds = new Set<TrackedManagedProcess["kind"]>();
  const serviceLockPaths = new Set<string>();

  const runtimeEntries = await readdir(paths.runtimeRoot, { withFileTypes: true }).catch((error) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  });

  for (const entry of runtimeEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const serviceRoot = join(paths.runtimeRoot, entry.name);
    const bitcoindStatus = await readJsonFileOrNull<ManagedBitcoindObservedStatus>(join(serviceRoot, "bitcoind-status.json"));

    if (bitcoindStatus?.processId != null && await isProcessAlive(bitcoindStatus.processId)) {
      trackedProcesses.push({
        kind: "managed-bitcoind",
        pid: bitcoindStatus.processId,
      });
      trackedProcessKinds.add("managed-bitcoind");
      serviceLockPaths.add(join(serviceRoot, "bitcoind.lock"));
    }
  }

  const indexerEntries = await readdir(paths.indexerRoot, { withFileTypes: true }).catch((error) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  });

  for (const entry of indexerEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const status = await readJsonFileOrNull<ManagedIndexerDaemonObservedStatus>(join(paths.indexerRoot, entry.name, "status.json"));
    if (status?.processId != null && await isProcessAlive(status.processId)) {
      trackedProcesses.push({
        kind: "indexer-daemon",
        pid: status.processId,
      });
      trackedProcessKinds.add("indexer-daemon");
      serviceLockPaths.add(join(paths.runtimeRoot, entry.name, "indexer-daemon.lock"));
    }
  }

  const miningRuntime = await loadMiningRuntimeStatus(paths.miningStatusPath).catch(() => null);
  if (
    miningRuntime?.backgroundWorkerPid != null
    && await isProcessAlive(miningRuntime.backgroundWorkerPid)
  ) {
    trackedProcesses.push({
      kind: "background-mining",
      pid: miningRuntime.backgroundWorkerPid,
    });
    trackedProcessKinds.add("background-mining");
  }

  const seen = new Set<string>();
  const deduped = trackedProcesses.filter((processInfo) => {
    const key = `${processInfo.kind}:${processInfo.pid}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  return {
    trackedProcesses: deduped,
    trackedProcessKinds: [...trackedProcessKinds],
    serviceLockPaths: [...serviceLockPaths].sort(),
  };
}

function dedupeSortedPaths(candidates: readonly string[]): string[] {
  return [...new Set(candidates)].sort((left, right) => right.length - left.length);
}

function resolveDefaultRemovedRoots(paths: WalletRuntimePaths): string[] {
  const configRoot = dirname(paths.clientConfigPath);
  return dedupeSortedPaths([
    paths.dataRoot,
    paths.stateRoot,
    paths.runtimeRoot,
    configRoot,
  ]);
}

function resolveBitcoindPreservingRemovedRoots(paths: WalletRuntimePaths): string[] {
  const configRoot = dirname(paths.clientConfigPath);
  return dedupeSortedPaths([
    paths.clientDataDir,
    paths.indexerRoot,
    paths.stateRoot,
    paths.runtimeRoot,
    configRoot,
    paths.hooksRoot,
  ]);
}

function resolveRemovedRoots(
  paths: WalletRuntimePaths,
  options: {
    preserveBitcoinDataDir: boolean;
  } = {
    preserveBitcoinDataDir: false,
  },
): string[] {
  return options.preserveBitcoinDataDir
    ? resolveBitcoindPreservingRemovedRoots(paths)
    : resolveDefaultRemovedRoots(paths);
}

function isDeletedByRemovalPlan(removedRoots: readonly string[], targetPath: string): boolean {
  return removedRoots.some((root) => isPathWithin(root, targetPath));
}

async function preflightReset(options: {
  dataDir: string;
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  validateSnapshotFile?: (path: string) => Promise<void>;
}): Promise<WalletResetPreflight> {
  const removedRoots = resolveRemovedRoots(options.paths);
  const rawEnvelope = await loadRawWalletStateEnvelope({
    primaryPath: options.paths.walletStatePath,
    backupPath: options.paths.walletStateBackupPath,
  });
  const explicitLock = await loadWalletExplicitLock(options.paths.walletExplicitLockPath).catch(() => null);
  const snapshotPaths = resolveBootstrapPathsForTesting(options.dataDir, DEFAULT_SNAPSHOT_METADATA);
  const validateSnapshot = options.validateSnapshotFile
    ?? ((path: string) => validateSnapshotFileForTesting(path, DEFAULT_SNAPSHOT_METADATA));
  const hasWalletState = await pathExists(options.paths.walletStatePath) || await pathExists(options.paths.walletStateBackupPath);
  const hasBitcoinDataDir = await pathExists(options.dataDir);
  const bitcoinDataDirWithinResetScope = hasBitcoinDataDir
    && isDeletedByRemovalPlan(removedRoots, options.dataDir);
  const hasSnapshot = await pathExists(snapshotPaths.snapshotPath);
  const hasPartialSnapshot = await pathExists(snapshotPaths.partialSnapshotPath);

  let snapshotStatus: WalletResetPreflight["snapshot"]["status"] = "not-present";
  if (hasSnapshot) {
    try {
      await validateSnapshot(snapshotPaths.snapshotPath);
      snapshotStatus = "valid";
    } catch {
      snapshotStatus = "invalid";
    }
  } else if (hasPartialSnapshot) {
    snapshotStatus = "invalid";
  }

  const tracked = await collectTrackedManagedProcesses(options.paths);
  const secretProviderKeyId = rawEnvelope?.envelope.secretProvider?.keyId ?? null;
  const seedIndex = await loadWalletSeedIndex({
    paths: options.paths,
  }).catch(() => null);
  const importedSeedSecretProviderKeyIds = [...new Set((seedIndex?.seeds ?? [])
    .filter((seed) => seed.kind === "imported")
    .map((seed) => createWalletSecretReference(seed.walletRootId).keyId))];

  return {
    dataRoot: options.paths.dataRoot,
    removedRoots,
    wallet: {
      present: hasWalletState,
      mode: rawEnvelope == null
        ? (hasWalletState ? "unknown" : "unknown")
        : rawEnvelope.envelope.secretProvider != null
          ? "provider-backed"
          : "passphrase-wrapped",
      envelopeSource: rawEnvelope?.source ?? null,
      secretProviderKeyId,
      importedSeedSecretProviderKeyIds,
      explicitLock,
      rawEnvelope,
    },
    snapshot: {
      status: snapshotStatus,
      path: snapshotPaths.snapshotPath,
      shouldPrompt: snapshotStatus === "valid",
      withinResetScope: isDeletedByRemovalPlan(removedRoots, snapshotPaths.snapshotPath),
    },
    bitcoinDataDir: {
      status: !hasBitcoinDataDir
        ? "not-present"
        : bitcoinDataDirWithinResetScope
          ? "within-reset-scope"
          : "outside-reset-scope",
      path: options.dataDir,
      shouldPrompt: bitcoinDataDirWithinResetScope,
    },
    trackedProcesses: tracked.trackedProcesses,
    trackedProcessKinds: tracked.trackedProcessKinds,
    serviceLockPaths: tracked.serviceLockPaths,
  };
}

async function acquireResetLocks(
  paths: WalletRuntimePaths,
  serviceLockPaths: readonly string[],
): Promise<FileLockHandle[]> {
  const lockPaths = [
    paths.walletControlLockPath,
    paths.miningControlLockPath,
    ...serviceLockPaths,
  ];
  const handles: FileLockHandle[] = [];

  try {
    for (const lockPath of lockPaths) {
      handles.push(await acquireFileLock(lockPath, {
        purpose: "wallet-reset",
        walletRootId: null,
      }));
    }
    return handles;
  } catch (error) {
    await Promise.all(handles.map(async (handle) => handle.release().catch(() => undefined)));
    throw error;
  }
}

async function deleteRemovedRoots(roots: readonly string[]): Promise<void> {
  try {
    for (const root of roots) {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  } catch {
    throw new Error("reset_data_root_delete_failed");
  }
}

async function deleteBootstrapSnapshotArtifacts(dataDir: string): Promise<void> {
  const snapshotPaths = resolveBootstrapPathsForTesting(dataDir, DEFAULT_SNAPSHOT_METADATA);
  await Promise.all([
    snapshotPaths.snapshotPath,
    snapshotPaths.partialSnapshotPath,
    snapshotPaths.statePath,
    snapshotPaths.quoteStatePath,
  ].map(async (path) => rm(path, {
    recursive: false,
    force: true,
  })));
}

async function resolveResetExecutionDecision(options: {
  preflight: WalletResetPreflight;
  provider: WalletSecretProvider;
  prompter: WalletPrompter;
  paths: WalletRuntimePaths;
}): Promise<ResetExecutionDecision> {
  if (!options.prompter.isInteractive) {
    throw new Error("reset_requires_tty");
  }

  await confirmTypedAcknowledgement(options.prompter, {
    expected: "permanently reset",
    prompt: "Type \"permanently reset\" to continue: ",
    errorCode: "reset_typed_ack_required",
    requiresTtyErrorCode: "reset_requires_tty",
    typedAckRequiredErrorCode: "reset_typed_ack_required",
  });

  let walletChoice: ResetExecutionDecision["walletChoice"] = "";
  let loadedWalletForEntropyReset: WalletAccessForReset | null = null;

  if (options.preflight.wallet.present) {
    const answer = (await options.prompter.prompt(
      "Wallet reset choice ([Enter] retain base entropy, \"skip\", or \"delete wallet\"): ",
    )).trim();

    if (answer !== "" && answer !== "skip" && answer !== "delete wallet") {
      throw new Error("reset_wallet_choice_invalid");
    }

    walletChoice = answer as ResetExecutionDecision["walletChoice"];

    if (walletChoice === "") {
      loadedWalletForEntropyReset = await loadWalletForEntropyReset({
        wallet: options.preflight.wallet,
        paths: options.paths,
        provider: options.provider,
        prompter: options.prompter,
      });
    }
  }

  let deleteSnapshot = false;
  let deleteBitcoinDataDir = false;
  if (options.preflight.snapshot.shouldPrompt) {
    const answer = (await options.prompter.prompt(
      "Delete downloaded 910000 UTXO snapshot too? [y/N]: ",
    )).trim().toLowerCase();
    deleteSnapshot = answer === "y" || answer === "yes";

    if (!deleteSnapshot && options.preflight.bitcoinDataDir.shouldPrompt) {
      const bitcoindAnswer = (await options.prompter.prompt(
        "Delete managed Bitcoin datadir too? [y/N]: ",
      )).trim().toLowerCase();
      deleteBitcoinDataDir = bitcoindAnswer === "y" || bitcoindAnswer === "yes";
    }
  }

  return {
    walletChoice,
    deleteSnapshot,
    deleteBitcoinDataDir,
    loadedWalletForEntropyReset,
  };
}

function determineWalletAction(
  walletPresent: boolean,
  walletChoice: ResetExecutionDecision["walletChoice"],
): WalletResetAction {
  if (!walletPresent) {
    return "not-present";
  }

  if (walletChoice === "skip") {
    return "kept-unchanged";
  }

  if (walletChoice === "delete wallet") {
    return "deleted";
  }

  return "retain-mnemonic";
}

function determineSnapshotResultStatus(options: {
  snapshotStatus: WalletResetPreflight["snapshot"]["status"];
  deleteSnapshot: boolean;
}): WalletResetSnapshotResultStatus {
  if (options.snapshotStatus === "not-present") {
    return "not-present";
  }

  if (options.snapshotStatus === "invalid") {
    return "invalid-removed";
  }

  return options.deleteSnapshot ? "deleted" : "preserved";
}

function determineBitcoinDataDirResultStatus(options: {
  bitcoinDataDirStatus: WalletResetPreflight["bitcoinDataDir"]["status"];
  deleteSnapshot: boolean;
  deleteBitcoinDataDir: boolean;
}): WalletResetBitcoinDataDirResultStatus {
  if (options.bitcoinDataDirStatus === "not-present") {
    return "not-present";
  }

  if (options.bitcoinDataDirStatus === "outside-reset-scope") {
    return "outside-reset-scope";
  }

  if (options.deleteSnapshot || options.deleteBitcoinDataDir) {
    return "deleted";
  }

  return "preserved";
}

export async function previewResetWallet(options: {
  dataDir: string;
  provider?: WalletSecretProvider;
  paths?: WalletRuntimePaths;
  validateSnapshotFile?: (path: string) => Promise<void>;
}): Promise<WalletResetPreview> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const preflight = await preflightReset({
    dataDir: options.dataDir,
    provider,
    paths,
    validateSnapshotFile: options.validateSnapshotFile,
  });
  const removedPaths = resolveRemovedRoots(paths, {
    preserveBitcoinDataDir: preflight.snapshot.status === "valid" && preflight.bitcoinDataDir.shouldPrompt,
  });

  return {
    dataRoot: preflight.dataRoot,
    confirmationPhrase: "permanently reset",
    walletPrompt: preflight.wallet.present
      ? {
        defaultAction: "retain-mnemonic",
        acceptedInputs: ["", "skip", "delete wallet"],
        entropyRetainingResetAvailable: preflight.wallet.mode !== "unknown",
        requiresPassphrase: preflight.wallet.mode === "passphrase-wrapped",
        envelopeSource: preflight.wallet.envelopeSource,
      }
      : null,
    bootstrapSnapshot: {
      status: preflight.snapshot.status,
      path: preflight.snapshot.path,
      defaultAction: preflight.snapshot.status === "valid" ? "preserve" : "delete",
    },
    bitcoinDataDir: {
      status: preflight.bitcoinDataDir.status,
      path: preflight.bitcoinDataDir.path,
      conditionalPrompt: preflight.bitcoinDataDir.shouldPrompt
        ? {
          prompt: "Delete managed Bitcoin datadir too? [y/N]: ",
          defaultAction: "preserve",
          acceptedInputs: ["", "n", "no", "y", "yes"],
        }
        : null,
    },
    trackedProcessKinds: preflight.trackedProcessKinds,
    willDeleteOsSecrets: preflight.wallet.secretProviderKeyId !== null
      || preflight.wallet.importedSeedSecretProviderKeyIds.length > 0,
    removedPaths,
  };
}

export async function resetWallet(options: {
  dataDir: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  validateSnapshotFile?: (path: string) => Promise<void>;
  attachService?: typeof attachOrStartManagedBitcoindService;
  rpcFactory?: (config: Parameters<typeof createRpcClient>[0]) => ResetWalletRpcClient;
}): Promise<WalletResetResult> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const preflight = await preflightReset({
    dataDir: options.dataDir,
    provider,
    paths,
    validateSnapshotFile: options.validateSnapshotFile,
  });
  const decision = await resolveResetExecutionDecision({
    preflight,
    provider,
    prompter: options.prompter,
    paths,
  });
  const walletAction = determineWalletAction(preflight.wallet.present, decision.walletChoice);
  const snapshotResultStatus = determineSnapshotResultStatus({
    snapshotStatus: preflight.snapshot.status,
    deleteSnapshot: decision.deleteSnapshot,
  });
  const bitcoinDataDirResultStatus = determineBitcoinDataDirResultStatus({
    bitcoinDataDirStatus: preflight.bitcoinDataDir.status,
    deleteSnapshot: decision.deleteSnapshot,
    deleteBitcoinDataDir: decision.deleteBitcoinDataDir,
  });
  const removedPaths = resolveRemovedRoots(paths, {
    preserveBitcoinDataDir: bitcoinDataDirResultStatus === "preserved",
  });
  const locks = await acquireResetLocks(paths, preflight.serviceLockPaths);
  await mkdir(dirname(paths.dataRoot), { recursive: true });
  const stagingRoot = await mkdtemp(join(dirname(paths.dataRoot), ".cogcoin-reset-"));
  const stagedWalletArtifacts: StagedArtifact[] = [];
  const stagedSnapshotArtifacts: StagedArtifact[] = [];
  let stoppedProcesses: WalletResetResult["stoppedProcesses"] = {
    managedBitcoind: 0,
    indexerDaemon: 0,
    backgroundMining: 0,
    survivors: 0,
  };
  let rootsDeleted = false;
  let committed = false;
  let newProviderKeyId: string | null = null;
  let secretCleanupStatus: WalletResetSecretCleanupStatus = "not-found";
  const deletedSecretRefs: string[] = [];
  const failedSecretRefs: string[] = [];
  const preservedSecretRefs: string[] = [];
  let walletOldRootId = extractWalletRootIdHintFromWalletStateEnvelope(preflight.wallet.rawEnvelope?.envelope ?? null)
    ?? preflight.wallet.explicitLock?.walletRootId
    ?? null;
  let walletNewRootId: string | null = null;

  try {
    stoppedProcesses = await terminateTrackedProcesses(preflight.trackedProcesses);

    if (walletAction === "kept-unchanged" || walletAction === "retain-mnemonic") {
      const stagedPrimary = await stageArtifact(
        paths.walletStatePath,
        stagingRoot,
        "wallet/wallet-state.enc",
      );
      const stagedBackup = await stageArtifact(
        paths.walletStateBackupPath,
        stagingRoot,
        "wallet/wallet-state.enc.bak",
      );
      const stagedExplicitLock = await stageArtifact(
        paths.walletExplicitLockPath,
        stagingRoot,
        "wallet/wallet-explicit-lock.json",
      );

      if (stagedPrimary !== null) {
        stagedWalletArtifacts.push(stagedPrimary);
      }
      if (stagedBackup !== null) {
        stagedWalletArtifacts.push(stagedBackup);
      }
      if (walletAction === "kept-unchanged" && stagedExplicitLock !== null) {
        stagedWalletArtifacts.push(stagedExplicitLock);
      }
    }

    if (snapshotResultStatus === "preserved" && isDeletedByRemovalPlan(removedPaths, preflight.snapshot.path)) {
      const stagedSnapshot = await stageArtifact(
        preflight.snapshot.path,
        stagingRoot,
        "snapshot/utxo-910000.dat",
      );
      if (stagedSnapshot !== null) {
        stagedSnapshotArtifacts.push(stagedSnapshot);
      }
    }

    await deleteRemovedRoots(removedPaths);
    rootsDeleted = true;

    if (
      (snapshotResultStatus === "deleted" || snapshotResultStatus === "invalid-removed")
      && !isDeletedByRemovalPlan(removedPaths, preflight.snapshot.path)
    ) {
      await deleteBootstrapSnapshotArtifacts(options.dataDir);
    }

    if (walletAction === "kept-unchanged") {
      await restoreStagedArtifacts(stagedWalletArtifacts);
    } else if (walletAction === "retain-mnemonic") {
      if (decision.loadedWalletForEntropyReset === null) {
        throw new Error("reset_wallet_entropy_reset_unavailable");
      }

      let nextState = createEntropyRetainedWalletState(
        decision.loadedWalletForEntropyReset.loaded.state,
        nowUnixMs,
      );
      walletOldRootId = decision.loadedWalletForEntropyReset.loaded.state.walletRootId;
      walletNewRootId = nextState.walletRootId;
      let nextAccess: WalletStateSaveAccess;

      if (decision.loadedWalletForEntropyReset.access.kind === "provider") {
        const secretReference = createWalletSecretReference(nextState.walletRootId);
        newProviderKeyId = secretReference.keyId;
        await provider.storeSecret(secretReference.keyId, randomBytes(32));
        nextAccess = {
          provider,
          secretReference,
        };
        await saveWalletState(
          {
            primaryPath: paths.walletStatePath,
            backupPath: paths.walletStateBackupPath,
          },
          nextState,
          nextAccess,
        );
        preservedSecretRefs.push(secretReference.keyId);
      } else {
        nextAccess = decision.loadedWalletForEntropyReset.access.passphrase;
        await saveWalletState(
          {
            primaryPath: paths.walletStatePath,
            backupPath: paths.walletStateBackupPath,
          },
          nextState,
          nextAccess,
        );
      }

      nextState = await recreateManagedCoreWalletReplicaForReset({
        state: nextState,
        access: nextAccess,
        paths,
        dataDir: options.dataDir,
        nowUnixMs,
        attachService: options.attachService,
        rpcFactory: options.rpcFactory,
      });
    }

    if (snapshotResultStatus === "preserved") {
      await restoreStagedArtifacts(stagedSnapshotArtifacts);
    }

    committed = true;

    const deleteTrackedSecretReference = async (keyId: string): Promise<void> => {
      try {
        await provider.deleteSecret(keyId);
        deletedSecretRefs.push(keyId);
      } catch {
        failedSecretRefs.push(keyId);
        secretCleanupStatus = "failed";
        throw new Error("reset_secret_cleanup_failed");
      }
    };

    for (const importedSecretKeyId of preflight.wallet.importedSeedSecretProviderKeyIds) {
      await deleteTrackedSecretReference(importedSecretKeyId);
    }

    if (walletAction === "deleted") {
      if (preflight.wallet.secretProviderKeyId !== null) {
        await deleteTrackedSecretReference(preflight.wallet.secretProviderKeyId);
      }
    } else if (walletAction === "retain-mnemonic" && preflight.wallet.secretProviderKeyId !== null) {
      if (preflight.wallet.secretProviderKeyId !== newProviderKeyId) {
        await deleteTrackedSecretReference(preflight.wallet.secretProviderKeyId);
      }
    } else if (preflight.wallet.secretProviderKeyId !== null) {
      preservedSecretRefs.push(preflight.wallet.secretProviderKeyId);
    }

    if (failedSecretRefs.length > 0) {
      secretCleanupStatus = "failed";
    } else if (deletedSecretRefs.length > 0) {
      secretCleanupStatus = "deleted";
    } else if (
      preflight.wallet.secretProviderKeyId === null
      && preflight.wallet.importedSeedSecretProviderKeyIds.length === 0
      && preflight.wallet.present
      && preflight.wallet.rawEnvelope === null
    ) {
      secretCleanupStatus = "unknown";
    } else if (deletedSecretRefs.length === 0) {
      secretCleanupStatus = "not-found";
    }

    return {
      dataRoot: preflight.dataRoot,
      factoryResetReady: true,
      stoppedProcesses,
      secretCleanupStatus,
      deletedSecretRefs,
      failedSecretRefs,
      preservedSecretRefs,
      walletAction,
      walletOldRootId,
      walletNewRootId,
      bootstrapSnapshot: {
        status: snapshotResultStatus,
        path: preflight.snapshot.path,
      },
      bitcoinDataDir: {
        status: bitcoinDataDirResultStatus,
        path: preflight.bitcoinDataDir.path,
      },
      removedPaths,
    };
  } catch (error) {
    if (!committed && rootsDeleted) {
      await restoreStagedArtifacts(stagedWalletArtifacts).catch(() => undefined);
      await restoreStagedArtifacts(stagedSnapshotArtifacts).catch(() => undefined);

      if (newProviderKeyId !== null) {
        await provider.deleteSecret(newProviderKeyId).catch(() => undefined);
      }
    }

    throw error;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    await Promise.all(locks.reverse().map(async (lock) => lock.release().catch(() => undefined)));
  }
}
