import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { previewResetWallet, resetWallet } from "../src/wallet/reset.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createDefaultWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { saveWalletState } from "../src/wallet/state/storage.js";
import { configureTestClientPassword } from "./client-password-test-helpers.js";
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
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot: paths.stateRoot,
  });
  const secretReference = createWalletSecretReference("wallet-root");

  await configureTestClientPassword(provider);
  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 17));
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

  assert.notEqual(preview.walletPrompt, null);
  assert.equal(preview.walletPrompt?.defaultAction, "retain-mnemonic");
});

test("previewResetWallet marks unsupported legacy wallet-state envelopes as non-recoverable by entropy reset", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "cogcoin-reset-home-"));
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const envelope = {
    format: "cogcoin-local-wallet-state",
    version: 1,
    cipher: "aes-256-gcm" as const,
    wrappedBy: "legacy-envelope",
    walletRootIdHint: "wallet-root-legacy",
    secretProvider: null,
    nonce: "AAAAAAAAAAAAAAAA",
    tag: "AAAAAAAAAAAAAAAAAAAAAA==",
    ciphertext: "AA==",
  };

  await mkdir(paths.walletStateDirectory, { recursive: true });
  await writeFile(paths.walletStatePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");

  const preview = await previewResetWallet({
    dataDir: paths.bitcoinDataDir,
    paths,
  });

  assert.deepEqual(preview.walletPrompt, {
    defaultAction: "retain-mnemonic",
    acceptedInputs: ["", "skip", "delete wallet"],
    entropyRetainingResetAvailable: false,
    envelopeSource: "primary",
  });
});

test("resetWallet rejects entropy-retaining reset for unsupported legacy wallet-state envelopes", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "cogcoin-reset-home-"));
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const envelope = {
    format: "cogcoin-local-wallet-state",
    version: 1,
    cipher: "aes-256-gcm" as const,
    wrappedBy: "legacy-envelope",
    walletRootIdHint: "wallet-root-legacy",
    secretProvider: null,
    nonce: "AAAAAAAAAAAAAAAA",
    tag: "AAAAAAAAAAAAAAAAAAAAAA==",
    ciphertext: "AA==",
  };
  const responses = ["permanently reset", ""];

  await mkdir(paths.walletStateDirectory, { recursive: true });
  await writeFile(paths.walletStatePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");

  await assert.rejects(
    () => resetWallet({
      dataDir: paths.bitcoinDataDir,
      paths,
      prompter: {
        isInteractive: true,
        writeLine: () => undefined,
        prompt: async () => responses.shift() ?? "",
      },
    }),
    /reset_wallet_entropy_reset_unavailable/,
  );
});

test("previewResetWallet on Linux local-file wallets does not claim OS secret cleanup", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "cogcoin-reset-home-"));
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot: paths.stateRoot,
  });
  const secretReference = createWalletSecretReference("wallet-root");

  await configureTestClientPassword(provider);
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
  assert.deepEqual(preview.walletPrompt, {
    defaultAction: "retain-mnemonic",
    acceptedInputs: ["", "skip", "delete wallet"],
    entropyRetainingResetAvailable: true,
    envelopeSource: "primary",
  });
});
