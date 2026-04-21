import test from "node:test";
import assert from "node:assert/strict";

import { loadWalletStateForAccess, mapWalletReadAccessError } from "../src/wallet/lifecycle/access.js";
import { loadWalletState } from "../src/wallet/state/storage.js";
import {
  createDerivedWalletState,
  createManagedCoreRpcHarness,
  createWalletLifecycleFixture,
} from "./wallet-lifecycle-test-helpers.js";

test("mapWalletReadAccessError maps wallet secret access failures to the reveal-friendly error", () => {
  assert.equal(
    mapWalletReadAccessError(new Error("wallet_secret_missing_test")).message,
    "wallet_secret_provider_unavailable",
  );
  assert.equal(
    mapWalletReadAccessError(new Error("anything_else")).message,
    "local-state-corrupt",
  );
});

test("loadWalletStateForAccess normalizes descriptor and coin-control state through the shared access owner", async (t) => {
  const state = createDerivedWalletState({
    descriptorChecksum: "abcd1234",
  });
  state.descriptor.checksum = "stale";
  state.managedCoreWallet.walletScriptPubKeyHex = null;
  const fixture = await createWalletLifecycleFixture(t, { state });
  const harness = createManagedCoreRpcHarness({
    mnemonic: state.mnemonic.phrase,
  });

  const loaded = await loadWalletStateForAccess({
    provider: fixture.provider,
    paths: fixture.paths,
    nowUnixMs: 123,
    dataDir: fixture.dataDir,
    attachService: harness.dependencies.attachService!,
    rpcFactory: harness.dependencies.rpcFactory!,
  });

  assert.equal(loaded.source, "primary");
  assert.equal(loaded.state.descriptor.checksum, "abcd1234");
  assert.equal(
    loaded.state.managedCoreWallet.walletScriptPubKeyHex,
    state.funding.scriptPubKeyHex,
  );

  const saved = await loadWalletState(
    {
      primaryPath: fixture.paths.walletStatePath,
      backupPath: fixture.paths.walletStateBackupPath,
    },
    {
      provider: fixture.provider,
    },
  );
  assert.equal(saved.state.descriptor.checksum, "abcd1234");
  assert.equal(saved.state.managedCoreWallet.walletScriptPubKeyHex, state.funding.scriptPubKeyHex);
});
