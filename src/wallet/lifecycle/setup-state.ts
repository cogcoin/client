import { randomBytes } from "node:crypto";

import { withClaimedUninitializedManagedRuntime } from "../../bitcoind/service.js";
import {
  createInternalCoreWalletPassphrase,
  deriveWalletMaterialFromMnemonic,
  generateWalletMaterial,
} from "../material.js";
import { clearLegacyWalletLockArtifacts } from "../managed-core-wallet.js";
import type { WalletRuntimePaths } from "../runtime.js";
import {
  clearWalletPendingInitializationState,
  loadWalletPendingInitializationStateOrNull,
  saveWalletPendingInitializationState,
} from "../state/pending-init.js";
import {
  createWalletPendingInitSecretReference,
  createWalletRootId,
  createWalletSecretReference,
  type WalletSecretProvider,
} from "../state/provider.js";
import { saveWalletState } from "../state/storage.js";
import type {
  WalletPendingInitializationStateV1,
  WalletStateV1,
} from "../types.js";
import { importDescriptorIntoManagedCoreWallet, sanitizeWalletName } from "./managed-core.js";
import type { WalletSetupContext } from "./types.js";

export type WalletMaterial = ReturnType<typeof deriveWalletMaterialFromMnemonic>;

function resolvePendingInitializationStoragePaths(paths: WalletRuntimePaths): {
  primaryPath: string;
  backupPath: string;
} {
  return {
    primaryPath: paths.walletInitPendingPath,
    backupPath: paths.walletInitPendingBackupPath,
  };
}

export async function clearPendingInitialization(
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

export async function loadOrCreatePendingInitializationMaterial(options: {
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  nowUnixMs: number;
}): Promise<WalletMaterial> {
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

export function createInitialWalletState(options: {
  walletRootId: string;
  nowUnixMs: number;
  material: WalletMaterial;
  internalCoreWalletPassphrase: string;
}): WalletStateV1 {
  return {
    schemaVersion: 5,
    stateRevision: 1,
    lastWrittenAtUnixMs: options.nowUnixMs,
    walletRootId: options.walletRootId,
    network: "mainnet",
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

export async function persistInitializedWallet(options: {
  context: WalletSetupContext;
  provider: WalletSecretProvider;
  material: WalletMaterial;
}): Promise<{ walletRootId: string; state: WalletStateV1 }> {
  const walletRootId = createWalletRootId();
  const internalCoreWalletPassphrase = createInternalCoreWalletPassphrase();
  const secretReference = createWalletSecretReference(walletRootId);
  await options.provider.storeSecret(secretReference.keyId, randomBytes(32));

  const initialState = createInitialWalletState({
    walletRootId,
    nowUnixMs: options.context.nowUnixMs,
    material: options.material,
    internalCoreWalletPassphrase,
  });
  const verifiedState = await withClaimedUninitializedManagedRuntime({
    dataDir: options.context.dataDir,
    walletRootId,
  }, async () => {
    await saveWalletState(
      {
        primaryPath: options.context.paths.walletStatePath,
        backupPath: options.context.paths.walletStateBackupPath,
      },
      initialState,
      {
        provider: options.provider,
        secretReference,
      },
    );

    return await importDescriptorIntoManagedCoreWallet(
      initialState,
      options.provider,
      options.context.paths,
      options.context.dataDir,
      options.context.nowUnixMs,
      options.context.attachService,
      options.context.rpcFactory,
    );
  });

  await clearLegacyWalletLockArtifacts(options.context.paths.walletRuntimeRoot);
  await clearPendingInitialization(options.context.paths, options.provider);

  return {
    walletRootId,
    state: verifiedState,
  };
}
