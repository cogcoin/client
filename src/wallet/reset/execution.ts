import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";

import {
  attachOrStartManagedBitcoindService,
  createManagedWalletReplica,
} from "../../bitcoind/service.js";
import { createRpcClient } from "../../bitcoind/node.js";
import { resolveNormalizedWalletDescriptorState } from "../descriptor-normalization.js";
import {
  createInternalCoreWalletPassphrase,
  deriveWalletMaterialFromMnemonic,
} from "../material.js";
import { withUnlockedManagedCoreWallet } from "../managed-core-wallet.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../runtime.js";
import {
  createDefaultWalletSecretProvider,
  createWalletRootId,
  createWalletSecretReference,
  type WalletSecretProvider,
} from "../state/provider.js";
import {
  extractWalletRootIdHintFromWalletStateEnvelope,
  loadWalletState,
  saveWalletState,
  type WalletStateSaveAccess,
} from "../state/storage.js";
import { confirmTypedAcknowledgement } from "../tx/confirm.js";
import type { WalletStateV1 } from "../types.js";

import {
  deleteBootstrapSnapshotArtifacts,
  deleteRemovedRoots,
  isDeletedByRemovalPlan,
  restoreStagedArtifacts,
  resolveRemovedRoots,
  stageArtifact,
} from "./artifacts.js";
import { preflightReset } from "./preflight.js";
import {
  acquireResetLocks,
  terminateTrackedProcesses,
} from "./process-cleanup.js";
import type {
  ResetExecutionDecision,
  ResetWalletRpcClient,
  WalletAccessForReset,
  WalletResetAction,
  WalletResetBitcoinDataDirResultStatus,
  WalletResetExecutionOptions,
  WalletResetPreflight,
  WalletResetResult,
  WalletResetSnapshotResultStatus,
} from "./types.js";

function sanitizeWalletName(walletRootId: string): string {
  return `cogcoin-${walletRootId}`.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 63);
}

export async function loadWalletForEntropyReset(options: {
  wallet: WalletResetPreflight["wallet"];
  paths: WalletRuntimePaths;
  provider: WalletSecretProvider;
}): Promise<WalletAccessForReset> {
  if (options.wallet.rawEnvelope === null) {
    throw new Error("reset_wallet_entropy_reset_unavailable");
  }

  if (options.wallet.mode === "provider-backed") {
    try {
      const loaded = await loadWalletState(
        {
          primaryPath: options.paths.walletStatePath,
          backupPath: options.paths.walletStateBackupPath,
        },
        {
          provider: options.provider,
        },
      );
      return {
        loaded,
        access: {
          kind: "provider",
          provider: options.provider,
        },
      };
    } catch {
      throw new Error("reset_wallet_entropy_reset_unavailable");
    }
  }

  throw new Error("reset_wallet_entropy_reset_unavailable");
}

export function createEntropyRetainedWalletState(
  previousState: WalletStateV1,
  nowUnixMs: number,
): WalletStateV1 {
  const material = deriveWalletMaterialFromMnemonic(previousState.mnemonic.phrase);
  const walletRootId = createWalletRootId();

  return {
    schemaVersion: 5,
    stateRevision: 1,
    lastWrittenAtUnixMs: nowUnixMs,
    walletRootId,
    network: previousState.network,
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
    pendingMutations: [],
  };
}

export async function recreateManagedCoreWalletReplicaForReset(options: {
  state: WalletStateV1;
  access: WalletStateSaveAccess;
  paths: NonNullable<WalletResetExecutionOptions["paths"]>;
  dataDir: string;
  nowUnixMs: number;
  attachService?: WalletResetExecutionOptions["attachService"];
  rpcFactory?: WalletResetExecutionOptions["rpcFactory"];
}): Promise<WalletStateV1> {
  const node = await (options.attachService ?? attachOrStartManagedBitcoindService)({
    dataDir: options.dataDir,
    chain: "main",
    startHeight: 0,
    walletRootId: options.state.walletRootId,
    managedWalletPassphrase: options.state.managedCoreWallet.internalPassphrase,
  });
  const rpc = (options.rpcFactory ?? createRpcClient)(node.rpc) as ResetWalletRpcClient;
  await createManagedWalletReplica(rpc, options.state.walletRootId, {
    managedWalletPassphrase: options.state.managedCoreWallet.internalPassphrase,
  });
  const normalizedDescriptors = await resolveNormalizedWalletDescriptorState(options.state, rpc);
  const walletName = sanitizeWalletName(options.state.walletRootId);

  await withUnlockedManagedCoreWallet({
    rpc,
    walletName,
    internalPassphrase: options.state.managedCoreWallet.internalPassphrase,
    run: async () => {
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
    },
  });

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

export async function resolveResetExecutionDecision(options: {
  preflight: Awaited<ReturnType<typeof preflightReset>>;
  provider: NonNullable<WalletResetExecutionOptions["provider"]>;
  prompter: WalletResetExecutionOptions["prompter"];
  paths: NonNullable<WalletResetExecutionOptions["paths"]>;
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
      "Wallet reset choice ([Enter] retain base entropy, \"skip\", or \"clear wallet entropy\"): ",
    )).trim();

    if (answer !== "" && answer !== "skip" && answer !== "clear wallet entropy") {
      throw new Error("reset_wallet_choice_invalid");
    }

    walletChoice = answer as ResetExecutionDecision["walletChoice"];

    if (walletChoice === "") {
      loadedWalletForEntropyReset = await loadWalletForEntropyReset({
        wallet: options.preflight.wallet,
        paths: options.paths,
        provider: options.provider,
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

export function determineWalletAction(
  walletPresent: boolean,
  walletChoice: ResetExecutionDecision["walletChoice"],
): WalletResetAction {
  if (!walletPresent) {
    return "not-present";
  }

  if (walletChoice === "skip") {
    return "kept-unchanged";
  }

  if (walletChoice === "clear wallet entropy") {
    return "deleted";
  }

  return "retain-mnemonic";
}

export function determineSnapshotResultStatus(options: {
  snapshotStatus: Awaited<ReturnType<typeof preflightReset>>["snapshot"]["status"];
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

export function determineBitcoinDataDirResultStatus(options: {
  bitcoinDataDirStatus: Awaited<ReturnType<typeof preflightReset>>["bitcoinDataDir"]["status"];
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

export async function resetWallet(
  options: WalletResetExecutionOptions,
): Promise<WalletResetResult> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const preflight = await preflightReset({
    ...options,
    provider,
    paths,
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
  const locks = await acquireResetLocks(paths, preflight.serviceLockPaths, options.processCleanupDeps);
  await mkdir(dirname(paths.dataRoot), { recursive: true });
  const stagingRoot = await mkdtemp(join(dirname(paths.dataRoot), ".cogcoin-reset-"));
  const stagedWalletArtifacts = [];
  const stagedSnapshotArtifacts = [];
  let stoppedProcesses: WalletResetResult["stoppedProcesses"] = {
    managedBitcoind: 0,
    indexerDaemon: 0,
    backgroundMining: 0,
    survivors: 0,
  };
  let rootsDeleted = false;
  let committed = false;
  let newProviderKeyId: string | null = null;
  let secretCleanupStatus: WalletResetResult["secretCleanupStatus"] = "not-found";
  const deletedSecretRefs: string[] = [];
  const failedSecretRefs: string[] = [];
  const preservedSecretRefs: string[] = [];
  let walletOldRootId = extractWalletRootIdHintFromWalletStateEnvelope(preflight.wallet.rawEnvelope?.envelope ?? null)
    ?? null;
  let walletNewRootId: string | null = null;

  try {
    stoppedProcesses = await terminateTrackedProcesses(preflight.trackedProcesses, options.processCleanupDeps);

    if (walletAction === "kept-unchanged" || walletAction === "retain-mnemonic") {
      const stagedPrimary = await stageArtifact(
        paths.walletStatePath,
        stagingRoot,
        "wallet/wallet-state.enc",
        options.artifactDeps,
      );
      const stagedBackup = await stageArtifact(
        paths.walletStateBackupPath,
        stagingRoot,
        "wallet/wallet-state.enc.bak",
        options.artifactDeps,
      );

      if (stagedPrimary !== null) {
        stagedWalletArtifacts.push(stagedPrimary);
      }
      if (stagedBackup !== null) {
        stagedWalletArtifacts.push(stagedBackup);
      }
    }

    if (snapshotResultStatus === "preserved" && isDeletedByRemovalPlan(removedPaths, preflight.snapshot.path)) {
      const stagedSnapshot = await stageArtifact(
        preflight.snapshot.path,
        stagingRoot,
        "snapshot/utxo-910000.dat",
        options.artifactDeps,
      );
      if (stagedSnapshot !== null) {
        stagedSnapshotArtifacts.push(stagedSnapshot);
      }
    }

    await deleteRemovedRoots(removedPaths, options.artifactDeps);
    rootsDeleted = true;

    if (
      (snapshotResultStatus === "deleted" || snapshotResultStatus === "invalid-removed")
      && !isDeletedByRemovalPlan(removedPaths, preflight.snapshot.path)
    ) {
      await deleteBootstrapSnapshotArtifacts(options.dataDir, options.artifactDeps);
    }

    if (walletAction === "kept-unchanged") {
      await restoreStagedArtifacts(stagedWalletArtifacts, options.artifactDeps);
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
      const secretReference = createWalletSecretReference(nextState.walletRootId);
      newProviderKeyId = secretReference.keyId;
      await provider.storeSecret(secretReference.keyId, randomBytes(32));
      const nextAccess: WalletStateSaveAccess = {
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
      await restoreStagedArtifacts(stagedSnapshotArtifacts, options.artifactDeps);
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
      provider.kind === "macos-keychain"
      && preflight.wallet.secretProviderKeyId === null
      && preflight.wallet.importedSeedSecretProviderKeyIds.length === 0
      && preflight.wallet.present
      && preflight.wallet.rawEnvelope === null
    ) {
      secretCleanupStatus = "unknown";
    } else if (
      preflight.wallet.secretProviderKeyId === null
      && preflight.wallet.importedSeedSecretProviderKeyIds.length === 0
      && preflight.wallet.present
      && preflight.wallet.rawEnvelope === null
    ) {
      secretCleanupStatus = "not-found";
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
      await restoreStagedArtifacts(stagedWalletArtifacts, options.artifactDeps).catch(() => undefined);
      await restoreStagedArtifacts(stagedSnapshotArtifacts, options.artifactDeps).catch(() => undefined);

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
