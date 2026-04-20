import test from "node:test";
import assert from "node:assert/strict";
import { access, constants, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { previewResetWallet, resetWallet } from "../src/wallet/reset.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createDefaultWalletSecretProviderForTesting,
  createWalletSecretReference,
  lockClientPassword,
} from "../src/wallet/state/provider.js";
import { saveWalletState } from "../src/wallet/state/storage.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { configureTestClientPassword } from "./client-password-test-helpers.js";
import { createWalletState } from "./current-model-helpers.js";

test("previewResetWallet shows no wallet prompt when no wallet state exists", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-reset-home");
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });

  const preview = await previewResetWallet({
    dataDir: paths.bitcoinDataDir,
    paths,
  });

  assert.equal(preview.confirmationPhrase, "permanently reset");
  assert.equal(preview.walletPrompt, null);
});

test("previewResetWallet detects an existing wallet state", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-reset-home");
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot: paths.stateRoot,
  });
  const secretReference = createWalletSecretReference("wallet-root");

  await configureTestClientPassword(provider);
  t.after(async () => {
    await lockClientPassword(provider);
  });
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

test("previewResetWallet marks unsupported legacy wallet-state envelopes as non-recoverable by entropy reset", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-reset-home");
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
    acceptedInputs: ["", "skip", "clear wallet entropy"],
    entropyRetainingResetAvailable: false,
    envelopeSource: "primary",
  });
});

test("resetWallet rejects entropy-retaining reset for unsupported legacy wallet-state envelopes", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-reset-home");
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

test("previewResetWallet on Linux local-file wallets does not claim OS secret cleanup", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-reset-home");
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot: paths.stateRoot,
  });
  const secretReference = createWalletSecretReference("wallet-root");

  await configureTestClientPassword(provider);
  t.after(async () => {
    await lockClientPassword(provider);
  });
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
    acceptedInputs: ["", "skip", "clear wallet entropy"],
    entropyRetainingResetAvailable: true,
    envelopeSource: "primary",
  });
});

test("resetWallet deletes legacy imported-seed secrets and artifacts when clearing wallet entropy", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-reset-home");
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot: paths.stateRoot,
  });
  const secretReference = createWalletSecretReference("wallet-root-main");
  const legacySecretKeyIds = [
    "wallet-state:legacy-import-a",
    "wallet-state:legacy-import-b",
  ];
  const responses = ["permanently reset", "clear wallet entropy"];

  await configureTestClientPassword(provider);
  t.after(async () => {
    await lockClientPassword(provider);
  });

  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 51));
  await provider.storeSecret(legacySecretKeyIds[0], Buffer.alloc(32, 52));
  await provider.storeSecret(legacySecretKeyIds[1], Buffer.alloc(32, 53));
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

  await mkdir(join(paths.stateRoot, "seeds", "legacy-a"), { recursive: true });
  await mkdir(join(paths.stateRoot, "seeds", "legacy-b"), { recursive: true });
  await writeFile(
    join(paths.stateRoot, "seeds", "legacy-a", "wallet-state.enc"),
    `${JSON.stringify({ secretProvider: { keyId: legacySecretKeyIds[0] } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(paths.stateRoot, "seeds", "legacy-b", "wallet-init-pending.enc.bak"),
    `${JSON.stringify({ secretProvider: { keyId: legacySecretKeyIds[1] } }, null, 2)}\n`,
    "utf8",
  );

  const result = await resetWallet({
    dataDir: paths.bitcoinDataDir,
    paths,
    provider,
    prompter: {
      isInteractive: true,
      writeLine: () => undefined,
      prompt: async () => responses.shift() ?? "",
    },
  });

  assert.equal(result.walletAction, "deleted");
  assert.equal(result.secretCleanupStatus, "deleted");
  assert.deepEqual(
    result.deletedSecretRefs.sort(),
    [secretReference.keyId, ...legacySecretKeyIds].sort(),
  );
  await assert.rejects(
    access(join(paths.stateRoot, "seeds", "legacy-a"), constants.F_OK),
    /ENOENT/,
  );
  await assert.rejects(
    access(join(paths.stateRoot, "seeds", "legacy-b"), constants.F_OK),
    /ENOENT/,
  );
});
