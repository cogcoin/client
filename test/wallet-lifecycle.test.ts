import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_UNLOCK_DURATION_MS,
  loadOrAutoUnlockWalletState,
  parseUnlockDurationToMs,
} from "../src/wallet/lifecycle.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createDefaultWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { saveWalletState } from "../src/wallet/state/storage.js";
import { createWalletState } from "./current-model-helpers.js";

test("parseUnlockDurationToMs parses supported explicit unlock durations", () => {
  assert.equal(parseUnlockDurationToMs("15m"), 15 * 60 * 1000);
  assert.equal(parseUnlockDurationToMs("2h"), 2 * 60 * 60 * 1000);
  assert.equal(parseUnlockDurationToMs("1d"), 24 * 60 * 60 * 1000);
});

test("parseUnlockDurationToMs falls back to the default unlock duration", () => {
  assert.equal(parseUnlockDurationToMs(null), DEFAULT_UNLOCK_DURATION_MS);
  assert.equal(parseUnlockDurationToMs(undefined), DEFAULT_UNLOCK_DURATION_MS);
});

test("loadOrAutoUnlockWalletState auto-unlocks Linux local-file provider wallets", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "cogcoin-wallet-lifecycle-linux-"));
  const paths = resolveWalletRuntimePathsForTesting({ homeDirectory, platform: "linux" });
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot: paths.stateRoot,
  });
  const secretReference = createWalletSecretReference("wallet-root");
  const nowUnixMs = 1_000_000;

  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 47));
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

  const unlocked = await loadOrAutoUnlockWalletState({
    provider,
    paths,
    nowUnixMs,
  });

  assert.notEqual(unlocked, null);
  assert.equal(unlocked?.state.walletRootId, "wallet-root");
  assert.equal(unlocked?.source, "primary");
  assert.equal(unlocked?.session.walletRootId, "wallet-root");
  assert.ok((unlocked?.session.unlockUntilUnixMs ?? 0) > nowUnixMs);
});
