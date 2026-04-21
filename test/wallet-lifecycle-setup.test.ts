import test from "node:test";
import assert from "node:assert/strict";

import { deriveWalletMaterialFromMnemonic } from "../src/wallet/material.js";
import { loadWalletPendingInitializationStateOrNull } from "../src/wallet/state/pending-init.js";
import { loadWalletState } from "../src/wallet/state/storage.js";
import { initializeWallet, showWalletMnemonic } from "../src/wallet/lifecycle/setup.js";
import type { WalletPrompter } from "../src/wallet/lifecycle/types.js";
import {
  createDerivedWalletState,
  createManagedCoreRpcHarness,
  createWalletLifecycleFixture,
  DEFAULT_TEST_MNEMONIC,
} from "./wallet-lifecycle-test-helpers.js";

function resolvePendingPaths(paths: { walletInitPendingPath: string; walletInitPendingBackupPath: string }) {
  return {
    primaryPath: paths.walletInitPendingPath,
    backupPath: paths.walletInitPendingBackupPath,
  };
}

function createLifecyclePrompter(options: {
  selection?: "generated" | "restored";
  restoreMnemonic?: string;
  confirmMnemonic?: "correct" | "wrong";
  typedAck?: string;
  onRevealPhrase?: (phrase: string) => void;
} = {}) {
  const writes: string[] = [];
  const prompts: string[] = [];
  const clearedScopes: Array<"mnemonic-reveal" | "restore-mnemonic-entry"> = [];
  const restoreWords = (options.restoreMnemonic ?? DEFAULT_TEST_MNEMONIC).split(/\s+/);
  let restoreIndex = 0;
  let revealPhrase: string | null = null;
  let sawSingleLineCopy = false;
  let selectionCalls = 0;

  const prompter: WalletPrompter = {
    isInteractive: true,
    writeLine(message: string) {
      writes.push(message);

      if (message === "Single-line copy:") {
        sawSingleLineCopy = true;
        return;
      }

      if (sawSingleLineCopy) {
        sawSingleLineCopy = false;
        revealPhrase = message;
        options.onRevealPhrase?.(message);
      }
    },
    async prompt(message: string): Promise<string> {
      prompts.push(message);

      if (message.startsWith("Choice [1-2]: ")) {
        return options.selection === "restored" ? "2" : "1";
      }

      if (message.startsWith("Word ")) {
        return restoreWords[restoreIndex++] ?? "";
      }

      if (message.startsWith("Confirm word #")) {
        const match = message.match(/#(\d+)/);
        const wordIndex = Number(match?.[1] ?? "1") - 1;
        const revealedWords = revealPhrase?.split(/\s+/) ?? [];

        if (options.confirmMnemonic === "wrong") {
          return "wrong";
        }

        return revealedWords[wordIndex] ?? "";
      }

      if (message.startsWith("Type \"show mnemonic\"")) {
        return options.typedAck ?? "show mnemonic";
      }

      if (message.startsWith("Press Enter to clear")) {
        return "";
      }

      return "";
    },
    async selectOption() {
      selectionCalls += 1;
      return options.selection ?? "generated";
    },
    async clearSensitiveDisplay(scope) {
      clearedScopes.push(scope);
    },
  };

  return {
    prompter,
    writes,
    prompts,
    clearedScopes,
    getRevealPhrase() {
      return revealPhrase;
    },
    getSelectionCalls() {
      return selectionCalls;
    },
  };
}

test("initializeWallet generated branch persists a new wallet and clears pending init state", async (t) => {
  const fixture = await createWalletLifecycleFixture(t, { state: null });
  const harness = createManagedCoreRpcHarness();
  const prompter = createLifecyclePrompter({
    selection: "generated",
    confirmMnemonic: "correct",
    onRevealPhrase(phrase) {
      harness.setExpectedMnemonic(phrase);
    },
  });

  const result = await initializeWallet({
    dataDir: fixture.dataDir,
    provider: fixture.provider,
    paths: fixture.paths,
    prompter: prompter.prompter,
    ...harness.dependencies,
  });

  assert.equal(result.setupMode, "generated");
  assert.equal(result.walletAction, "initialized");
  assert.equal(result.state.walletRootId, result.walletRootId);
  assert.ok(prompter.writes.includes("Cogcoin Wallet Initialization"));
  assert.deepEqual(prompter.clearedScopes, ["mnemonic-reveal"]);

  const pending = await loadWalletPendingInitializationStateOrNull(
    resolvePendingPaths(fixture.paths),
    {
      provider: fixture.provider,
    },
  );
  assert.equal(pending, null);

  const saved = await loadWalletState(
    {
      primaryPath: fixture.paths.walletStatePath,
      backupPath: fixture.paths.walletStateBackupPath,
    },
    {
      provider: fixture.provider,
    },
  );
  assert.equal(saved.state.walletRootId, result.walletRootId);
  assert.equal(saved.state.funding.address, result.fundingAddress);
});

test("initializeWallet reuses pending generated material after confirmation failure and clears it after success", async (t) => {
  const fixture = await createWalletLifecycleFixture(t, { state: null });
  const firstHarness = createManagedCoreRpcHarness();
  const firstPrompter = createLifecyclePrompter({
    selection: "generated",
    confirmMnemonic: "wrong",
    onRevealPhrase(phrase) {
      firstHarness.setExpectedMnemonic(phrase);
    },
  });

  await assert.rejects(
    initializeWallet({
      dataDir: fixture.dataDir,
      provider: fixture.provider,
      paths: fixture.paths,
      prompter: firstPrompter.prompter,
      ...firstHarness.dependencies,
    }),
    /wallet_init_confirmation_failed_word_/,
  );

  const pendingAfterFailure = await loadWalletPendingInitializationStateOrNull(
    resolvePendingPaths(fixture.paths),
    {
      provider: fixture.provider,
    },
  );
  assert.ok(pendingAfterFailure !== null);
  assert.equal(firstPrompter.getRevealPhrase(), pendingAfterFailure.state.mnemonic.phrase);

  const secondHarness = createManagedCoreRpcHarness();
  const secondPrompter = createLifecyclePrompter({
    selection: "generated",
    confirmMnemonic: "correct",
    onRevealPhrase(phrase) {
      secondHarness.setExpectedMnemonic(phrase);
    },
  });

  const result = await initializeWallet({
    dataDir: fixture.dataDir,
    provider: fixture.provider,
    paths: fixture.paths,
    prompter: secondPrompter.prompter,
    ...secondHarness.dependencies,
  });

  assert.equal(result.setupMode, "generated");
  assert.equal(secondPrompter.getRevealPhrase(), firstPrompter.getRevealPhrase());
  const pendingAfterSuccess = await loadWalletPendingInitializationStateOrNull(
    resolvePendingPaths(fixture.paths),
    {
      provider: fixture.provider,
    },
  );
  assert.equal(pendingAfterSuccess, null);
});

test("initializeWallet restore branch imports the provided mnemonic and clears restore entry display", async (t) => {
  const fixture = await createWalletLifecycleFixture(t, { state: null });
  const restoreMnemonic = DEFAULT_TEST_MNEMONIC;
  const material = deriveWalletMaterialFromMnemonic(restoreMnemonic);
  const harness = createManagedCoreRpcHarness({
    mnemonic: restoreMnemonic,
  });
  const prompter = createLifecyclePrompter({
    selection: "restored",
    restoreMnemonic,
  });

  const result = await initializeWallet({
    dataDir: fixture.dataDir,
    provider: fixture.provider,
    paths: fixture.paths,
    prompter: prompter.prompter,
    ...harness.dependencies,
  });

  assert.equal(result.setupMode, "restored");
  assert.equal(result.fundingAddress, material.funding.address);
  assert.deepEqual(prompter.clearedScopes, ["restore-mnemonic-entry"]);
});

test("initializeWallet existing-wallet fast path skips setup prompting", async (t) => {
  const state = createDerivedWalletState({
    descriptorChecksum: "abcd1234",
  });
  const fixture = await createWalletLifecycleFixture(t, { state });
  const harness = createManagedCoreRpcHarness({
    mnemonic: state.mnemonic.phrase,
    loadedWallets: [state.managedCoreWallet.walletName],
  });
  const prompter = createLifecyclePrompter();

  const result = await initializeWallet({
    dataDir: fixture.dataDir,
    provider: fixture.provider,
    paths: fixture.paths,
    prompter: prompter.prompter,
    ...harness.dependencies,
  });

  assert.equal(result.setupMode, "existing");
  assert.equal(result.walletAction, "already-initialized");
  assert.equal(result.walletRootId, state.walletRootId);
  assert.equal(prompter.getSelectionCalls(), 0);
});

test("showWalletMnemonic requires typed acknowledgement and clears the reveal from the display", async (t) => {
  const state = createDerivedWalletState();
  const fixture = await createWalletLifecycleFixture(t, { state });
  const prompter = createLifecyclePrompter({
    typedAck: "show mnemonic",
  });

  await showWalletMnemonic({
    provider: fixture.provider,
    paths: fixture.paths,
    prompter: prompter.prompter,
  });

  assert.ok(prompter.writes.includes("Cogcoin Wallet Recovery Phrase"));
  assert.ok(prompter.writes.includes(state.mnemonic.phrase));
  assert.deepEqual(prompter.clearedScopes, ["mnemonic-reveal"]);
});
