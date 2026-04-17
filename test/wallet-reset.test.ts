import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { previewResetWallet } from "../src/wallet/reset.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createDefaultWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { saveWalletState } from "../src/wallet/state/storage.js";
import { createWalletState } from "./current-model-helpers.js";

test("previewResetWallet shows no wallet prompt when no wallet state exists", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "cogcoin-reset-home-"));
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });

  const preview = await previewResetWallet({
    dataDir: paths.bitcoinDataDir,
    paths,
  });

  assert.equal(preview.confirmationPhrase, "permanently reset");
  assert.equal(preview.walletPrompt, null);
});

test("previewResetWallet detects an existing wallet state", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "cogcoin-reset-home-"));
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  await saveWalletState(
    {
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    },
    createWalletState(),
    "passphrase",
  );

  const preview = await previewResetWallet({
    dataDir: paths.bitcoinDataDir,
    paths,
  });

  assert.notEqual(preview.walletPrompt, null);
  assert.equal(preview.walletPrompt?.defaultAction, "retain-mnemonic");
});

test("previewResetWallet on Linux local-file wallets does not claim OS secret cleanup", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "cogcoin-reset-home-"));
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot: paths.stateRoot,
  });
  const secretReference = createWalletSecretReference("wallet-root");

  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 43));
  await saveWalletState(
    {
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    },
    createWalletState(),
    {
      provider,
      secretReference,
    },
  );

  const preview = await previewResetWallet({
    dataDir: paths.bitcoinDataDir,
    paths,
    provider,
  });

  assert.equal(preview.willDeleteOsSecrets, false);
  assert.notEqual(preview.walletPrompt, null);
  assert.equal(preview.walletPrompt?.requiresPassphrase, false);
});
