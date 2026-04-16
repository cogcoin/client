import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { previewResetWallet } from "../src/wallet/reset.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
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
