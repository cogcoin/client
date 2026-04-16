import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  extractWalletRootIdHintFromWalletStateEnvelope,
  loadRawWalletStateEnvelope,
  loadWalletState,
  saveWalletState,
} from "../src/wallet/state/storage.js";
import { createWalletState } from "./current-model-helpers.js";

test("wallet state storage round-trips schema 4 state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cogcoin-state-"));
  const paths = {
    primaryPath: join(dir, "wallet-state.enc"),
    backupPath: join(dir, "wallet-state.enc.bak"),
  };

  await saveWalletState(paths, createWalletState(), "passphrase");
  const loaded = await loadWalletState(paths, "passphrase");

  assert.equal(loaded.state.schemaVersion, 4);
  assert.equal(loaded.state.managedCoreWallet.walletAddress, "bc1qfunding");
});

test("wallet state envelope exposes the wallet root id hint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cogcoin-state-"));
  const paths = {
    primaryPath: join(dir, "wallet-state.enc"),
    backupPath: join(dir, "wallet-state.enc.bak"),
  };

  await saveWalletState(paths, createWalletState({ walletRootId: "wallet-root-2" }), "passphrase");
  const raw = await loadRawWalletStateEnvelope(paths);

  assert.equal(extractWalletRootIdHintFromWalletStateEnvelope(raw?.envelope ?? null), "wallet-root-2");
});
