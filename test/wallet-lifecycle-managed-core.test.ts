import test from "node:test";
import assert from "node:assert/strict";
import { access, constants, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  importDescriptorIntoManagedCoreWallet,
  recreateManagedCoreWalletReplica,
  verifyManagedCoreWalletReplica,
} from "../src/wallet/lifecycle/managed-core.js";
import { loadWalletState } from "../src/wallet/state/storage.js";
import {
  createDerivedWalletState,
  createManagedCoreRpcHarness,
  createWalletLifecycleFixture,
} from "./wallet-lifecycle-test-helpers.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

test("importDescriptorIntoManagedCoreWallet imports descriptors and persists the verified replica state", async (t) => {
  const state = createDerivedWalletState({
    descriptorChecksum: null,
    proofStatus: "not-proven",
  });
  const fixture = await createWalletLifecycleFixture(t, { state });
  const harness = createManagedCoreRpcHarness({
    mnemonic: state.mnemonic.phrase,
  });

  const nextState = await importDescriptorIntoManagedCoreWallet(
    state,
    fixture.provider,
    fixture.paths,
    fixture.dataDir,
    123,
    harness.dependencies.attachService,
    harness.dependencies.rpcFactory,
  );

  assert.equal(nextState.managedCoreWallet.proofStatus, "ready");
  assert.equal(nextState.managedCoreWallet.descriptorChecksum, "abcd1234");
  assert.equal(harness.createdWallets.length, 1);
  assert.equal(harness.importedDescriptors.length, 1);

  const saved = await loadWalletState(
    {
      primaryPath: fixture.paths.walletStatePath,
      backupPath: fixture.paths.walletStateBackupPath,
    },
    {
      provider: fixture.provider,
    },
  );
  assert.equal(saved.state.managedCoreWallet.proofStatus, "ready");
  assert.equal(saved.state.managedCoreWallet.walletAddress, state.funding.address);
});

test("verifyManagedCoreWalletReplica reports a funding-address mismatch", async (t) => {
  const state = createDerivedWalletState({
    descriptorChecksum: "abcd1234",
  });
  const fixture = await createWalletLifecycleFixture(t, { state });
  const harness = createManagedCoreRpcHarness({
    mnemonic: state.mnemonic.phrase,
    loadedWallets: [state.managedCoreWallet.walletName],
  });
  harness.setDerivedAddress("bc1qotheraddress");

  const replica = await verifyManagedCoreWalletReplica(state, fixture.dataDir, {
    nodeHandle: { rpc: {} as any },
    rpcFactory: harness.dependencies.rpcFactory,
  });

  assert.equal(replica.proofStatus, "mismatch");
  assert.equal(replica.fundingAddress0, "bc1qotheraddress");
  assert.match(replica.message ?? "", /does not match/);
});

test("recreateManagedCoreWalletReplica unloads and quarantines an existing wallet replica before reimporting", async (t) => {
  const state = createDerivedWalletState({
    descriptorChecksum: null,
    proofStatus: "missing",
  });
  const fixture = await createWalletLifecycleFixture(t, { state });
  const walletDir = join(fixture.dataDir, "wallets", state.managedCoreWallet.walletName);
  const quarantineDir = `${walletDir}.quarantine-123`;
  const harness = createManagedCoreRpcHarness({
    mnemonic: state.mnemonic.phrase,
    loadedWallets: [state.managedCoreWallet.walletName],
  });

  await mkdir(walletDir, { recursive: true });

  const repaired = await recreateManagedCoreWalletReplica(
    state,
    fixture.provider,
    fixture.paths,
    fixture.dataDir,
    123,
    harness.dependencies,
  );

  assert.equal(repaired.managedCoreWallet.proofStatus, "ready");
  assert.deepEqual(harness.unloadedWallets, [state.managedCoreWallet.walletName]);
  assert.equal(await pathExists(quarantineDir), true);
});
