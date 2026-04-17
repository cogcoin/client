import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  LEGACY_WALLET_STATE_PASSPHRASE_ERROR,
  extractWalletRootIdHintFromWalletStateEnvelope,
  loadRawWalletStateEnvelope,
  loadWalletState,
  saveWalletState,
} from "../src/wallet/state/storage.js";
import { encryptJsonWithPassphrase } from "../src/wallet/state/crypto.js";
import {
  createMemoryWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { createWalletState } from "./current-model-helpers.js";

test("wallet state storage round-trips schema 4 state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cogcoin-state-"));
  const paths = {
    primaryPath: join(dir, "wallet-state.enc"),
    backupPath: join(dir, "wallet-state.enc.bak"),
  };
  const provider = createMemoryWalletSecretProviderForTesting();
  const secretReference = createWalletSecretReference("wallet-root");

  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 7));
  await saveWalletState(paths, createWalletState(), {
    provider,
    secretReference,
  });
  const loaded = await loadWalletState(paths, { provider });

  assert.equal(loaded.state.schemaVersion, 4);
  assert.equal(loaded.state.managedCoreWallet.walletAddress, "bc1qfunding");
});

test("wallet state envelope exposes the wallet root id hint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cogcoin-state-"));
  const paths = {
    primaryPath: join(dir, "wallet-state.enc"),
    backupPath: join(dir, "wallet-state.enc.bak"),
  };
  const provider = createMemoryWalletSecretProviderForTesting();
  const secretReference = createWalletSecretReference("wallet-root-2");

  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 11));
  await saveWalletState(paths, createWalletState({ walletRootId: "wallet-root-2" }), {
    provider,
    secretReference,
  });
  const raw = await loadRawWalletStateEnvelope(paths);

  assert.equal(extractWalletRootIdHintFromWalletStateEnvelope(raw?.envelope ?? null), "wallet-root-2");
});

test("wallet state storage rejects legacy passphrase-wrapped local envelopes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cogcoin-state-"));
  const paths = {
    primaryPath: join(dir, "wallet-state.enc"),
    backupPath: join(dir, "wallet-state.enc.bak"),
  };
  const provider = createMemoryWalletSecretProviderForTesting();
  const envelope = await encryptJsonWithPassphrase(
    createWalletState({ walletRootId: "wallet-root-legacy" }),
    "passphrase",
    {
      format: "cogcoin-local-wallet-state",
      walletRootIdHint: "wallet-root-legacy",
    },
  );

  await writeFile(paths.primaryPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");

  await assert.rejects(
    () => loadWalletState(paths, { provider }),
    new RegExp(LEGACY_WALLET_STATE_PASSPHRASE_ERROR),
  );
});
