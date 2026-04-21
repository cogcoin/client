import { deriveWalletMaterialFromMnemonic } from "../material.js";
import {
  ensureClientPasswordConfigured,
  withInteractiveWalletSecretProvider,
  type WalletSecretProvider,
} from "../state/provider.js";
import { bindClientPasswordPromptSessionPolicy } from "../state/client-password/session-policy.js";
import { loadWalletStateForAccess, mapWalletReadAccessError } from "./access.js";
import {
  acquireWalletControlLock,
  resolveWalletManagedCoreContext,
  resolveWalletSetupContext,
  walletStateExists,
} from "./context.js";
import {
  clearSensitiveDisplay,
  confirmMnemonic,
  confirmTypedAcknowledgement,
  promptForInitializationMode,
  promptForRestoreMnemonic,
  writeMnemonicReveal,
} from "./setup-prompts.js";
import {
  clearPendingInitialization,
  loadOrCreatePendingInitializationMaterial,
  persistInitializedWallet,
} from "./setup-state.js";
import type {
  WalletInitializationResult,
  WalletPrompter,
  WalletSetupDependencies,
} from "./types.js";

export async function initializeWallet(options: {
  dataDir: string;
  provider?: WalletSecretProvider;
  prompter: WalletPrompter;
  nowUnixMs?: number;
  paths?: import("../runtime.js").WalletRuntimePaths;
} & WalletSetupDependencies): Promise<WalletInitializationResult> {
  const context = resolveWalletSetupContext(options);

  if (!context.prompter.isInteractive) {
    throw new Error("wallet_init_requires_tty");
  }

  const initPrompter = bindClientPasswordPromptSessionPolicy(context.prompter, "init-24h");
  const interactiveProvider = withInteractiveWalletSecretProvider(context.provider, initPrompter);
  const controlLock = await acquireWalletControlLock(context.paths, "wallet-init");

  try {
    const passwordAction = await ensureClientPasswordConfigured(context.provider, initPrompter);

    if (await walletStateExists(context.paths)) {
      await clearPendingInitialization(context.paths, interactiveProvider);

      const loaded = await loadWalletStateForAccess({
        ...context,
        provider: interactiveProvider,
        dataDir: context.dataDir,
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

    const setupMode = await promptForInitializationMode(initPrompter);
    let material;

    if (setupMode === "generated") {
      material = await loadOrCreatePendingInitializationMaterial({
        provider: interactiveProvider,
        paths: context.paths,
        nowUnixMs: context.nowUnixMs,
      });
      writeMnemonicReveal(initPrompter, material.mnemonic.phrase, [
        "Cogcoin Wallet Initialization",
        "Write down this 24-word recovery phrase.",
        "The same phrase will be shown again until confirmation succeeds:",
        "",
      ]);

      try {
        await confirmMnemonic(initPrompter, material.mnemonic.words);
      } finally {
        await clearSensitiveDisplay(initPrompter, "mnemonic-reveal");
      }
    } else {
      let mnemonicPhrase: string;

      try {
        mnemonicPhrase = await promptForRestoreMnemonic(initPrompter);
      } finally {
        await clearSensitiveDisplay(initPrompter, "restore-mnemonic-entry");
      }

      await clearPendingInitialization(context.paths, interactiveProvider);
      material = deriveWalletMaterialFromMnemonic(mnemonicPhrase);
    }

    const initialized = await persistInitializedWallet({
      context,
      provider: interactiveProvider,
      material,
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
  paths?: import("../runtime.js").WalletRuntimePaths;
} & WalletSetupDependencies): Promise<void> {
  const context = {
    ...resolveWalletManagedCoreContext({
      provider: options.provider,
      nowUnixMs: options.nowUnixMs,
      paths: options.paths,
      attachService: options.attachService,
      rpcFactory: options.rpcFactory,
    }),
    prompter: options.prompter,
  };

  if (!context.prompter.isInteractive) {
    throw new Error("wallet_show_mnemonic_requires_tty");
  }

  const interactiveProvider = withInteractiveWalletSecretProvider(context.provider, context.prompter);
  const controlLock = await acquireWalletControlLock(context.paths, "wallet-show-mnemonic");

  try {
    if (!await walletStateExists(context.paths)) {
      throw new Error("wallet_uninitialized");
    }

    const loaded = await loadWalletStateForAccess({
      ...context,
      provider: interactiveProvider,
    }).catch((error) => {
      throw mapWalletReadAccessError(error);
    });

    await confirmTypedAcknowledgement(
      context.prompter,
      "show mnemonic",
      "Type \"show mnemonic\" to continue: ",
      "wallet_show_mnemonic_typed_ack_required",
    );

    writeMnemonicReveal(context.prompter, loaded.state.mnemonic.phrase, [
      "Cogcoin Wallet Recovery Phrase",
      "This 24-word recovery phrase controls the wallet.",
      "",
    ]);

    try {
      await context.prompter.prompt("Press Enter to clear the recovery phrase from the screen: ");
    } finally {
      await clearSensitiveDisplay(context.prompter, "mnemonic-reveal");
    }
  } finally {
    await controlLock.release();
  }
}
