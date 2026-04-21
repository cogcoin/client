import { randomBytes } from "node:crypto";
import { access, constants } from "node:fs/promises";

import { withClaimedUninitializedManagedRuntime } from "../../bitcoind/service.js";
import { acquireFileLock } from "../fs/lock.js";
import {
  createInternalCoreWalletPassphrase,
  createMnemonicConfirmationChallenge,
  deriveWalletMaterialFromMnemonic,
  generateWalletMaterial,
  isEnglishMnemonicWord,
  validateEnglishMnemonic,
} from "../material.js";
import { renderWalletMnemonicRevealArt } from "../mnemonic-art.js";
import { resolveWalletRuntimePathsForTesting, type WalletRuntimePaths } from "../runtime.js";
import {
  clearWalletPendingInitializationState,
  loadWalletPendingInitializationStateOrNull,
  saveWalletPendingInitializationState,
} from "../state/pending-init.js";
import {
  createDefaultWalletSecretProvider,
  createWalletPendingInitSecretReference,
  createWalletRootId,
  createWalletSecretReference,
  ensureClientPasswordConfigured,
  withInteractiveWalletSecretProvider,
  type WalletSecretProvider,
} from "../state/provider.js";
import {
  clearLegacyWalletLockArtifacts,
} from "../managed-core-wallet.js";
import { loadWalletState, saveWalletState } from "../state/storage.js";
import type { WalletPendingInitializationStateV1, WalletStateV1 } from "../types.js";
import {
  importDescriptorIntoManagedCoreWallet,
  normalizeLoadedWalletStateIfNeeded,
  sanitizeWalletName,
} from "./managed-core.js";
import type {
  WalletInitializationResult,
  WalletPrompter,
  WalletSetupDependencies,
} from "./types.js";

function resolvePendingInitializationStoragePaths(paths: WalletRuntimePaths): {
  primaryPath: string;
  backupPath: string;
} {
  return {
    primaryPath: paths.walletInitPendingPath,
    backupPath: paths.walletInitPendingBackupPath,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
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

async function promptForInitializationMode(
  prompter: WalletPrompter,
): Promise<Exclude<WalletInitializationResult["setupMode"], "existing">> {
  if (prompter.selectOption != null) {
    return await prompter.selectOption({
      message: "How should Cogcoin set up this wallet?",
      options: [
        {
          label: "Create new wallet",
          description: "Generate a fresh 24-word recovery phrase.",
          value: "generated",
        },
        {
          label: "Restore existing wallet",
          description: "Enter an existing 24-word recovery phrase.",
          value: "restored",
        },
      ],
      initialValue: "generated",
    }) as Exclude<WalletInitializationResult["setupMode"], "existing">;
  }

  prompter.writeLine("How should Cogcoin set up this wallet?");
  prompter.writeLine("1. Create new wallet");
  prompter.writeLine("2. Restore existing wallet");

  while (true) {
    const answer = (await prompter.prompt("Choice [1-2]: ")).trim();

    if (answer === "1") {
      return "generated";
    }

    if (answer === "2") {
      return "restored";
    }

    prompter.writeLine("Enter 1 or 2.");
  }
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

function isWalletSecretAccessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("wallet_secret_missing_")
    || message.startsWith("wallet_secret_provider_");
}

async function persistInitializedWallet(options: {
  dataDir: string;
  provider: WalletSecretProvider;
  material: ReturnType<typeof deriveWalletMaterialFromMnemonic>;
  nowUnixMs: number;
  paths: WalletRuntimePaths;
} & WalletSetupDependencies): Promise<{ walletRootId: string; state: WalletStateV1 }> {
  const walletRootId = createWalletRootId();
  const internalCoreWalletPassphrase = createInternalCoreWalletPassphrase();
  const secretReference = createWalletSecretReference(walletRootId);
  await options.provider.storeSecret(secretReference.keyId, randomBytes(32));

  const initialState = createInitialWalletState({
    walletRootId,
    nowUnixMs: options.nowUnixMs,
    material: options.material,
    internalCoreWalletPassphrase,
  });
  const verifiedState = await withClaimedUninitializedManagedRuntime({
    dataDir: options.dataDir,
    walletRootId,
  }, async () => {
    await saveWalletState(
      {
        primaryPath: options.paths.walletStatePath,
        backupPath: options.paths.walletStateBackupPath,
      },
      initialState,
      {
        provider: options.provider,
        secretReference,
      },
    );

    return importDescriptorIntoManagedCoreWallet(
      initialState,
      options.provider,
      options.paths,
      options.dataDir,
      options.nowUnixMs,
      options.attachService,
      options.rpcFactory,
    );
  });
  await clearLegacyWalletLockArtifacts(options.paths.walletRuntimeRoot);
  await clearPendingInitialization(options.paths, options.provider);

  return {
    walletRootId,
    state: verifiedState,
  };
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

async function loadWalletStateForAccess(options: {
  provider?: WalletSecretProvider;
  nowUnixMs?: number;
  paths?: WalletRuntimePaths;
  dataDir?: string;
} & WalletSetupDependencies = {}): Promise<{ state: WalletStateV1; source: "primary" | "backup" }> {
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
} & WalletSetupDependencies): Promise<WalletInitializationResult> {
  if (!options.prompter.isInteractive) {
    throw new Error("wallet_init_requires_tty");
  }

  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const interactiveProvider = withInteractiveWalletSecretProvider(provider, options.prompter);
  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();

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
        setupMode: "existing",
        passwordAction,
        walletAction: "already-initialized",
        walletRootId: loaded.state.walletRootId,
        fundingAddress: loaded.state.funding.address,
        state: loaded.state,
      };
    }

    const setupMode = await promptForInitializationMode(options.prompter);
    let material: ReturnType<typeof deriveWalletMaterialFromMnemonic>;

    if (setupMode === "generated") {
      material = await loadOrCreatePendingInitializationMaterial({
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
    } else {
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
      material = deriveWalletMaterialFromMnemonic(mnemonicPhrase);
    }

    const initialized = await persistInitializedWallet({
      dataDir: options.dataDir,
      provider: interactiveProvider,
      material,
      nowUnixMs,
      paths,
      attachService: options.attachService,
      rpcFactory: options.rpcFactory,
    });

    return {
      setupMode,
      passwordAction,
      walletAction: "initialized",
      walletRootId: initialized.walletRootId,
      fundingAddress: initialized.state.funding.address,
      state: initialized.state,
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
