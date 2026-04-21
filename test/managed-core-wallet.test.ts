import assert from "node:assert/strict";
import test from "node:test";

import { withUnlockedManagedCoreWallet } from "../src/wallet/managed-core-wallet.js";

const LOCKED_WALLET_ERROR =
  "bitcoind_rpc_walletprocesspsbt_-13_Please enter the wallet passphrase with walletpassphrase first.";
const WRONG_PASSPHRASE_ERROR =
  "bitcoind_rpc_walletprocesspsbt_-14_The wallet passphrase entered was incorrect.";

test("withUnlockedManagedCoreWallet retries one locked walletprocesspsbt relock when enabled", async () => {
  let walletPassphraseCalls = 0;
  let walletLockCalls = 0;
  let runCalls = 0;
  const outcomes: string[] = [];

  const result = await withUnlockedManagedCoreWallet({
    rpc: {
      async walletPassphrase() {
        walletPassphraseCalls += 1;
        return null;
      },
      async walletLock() {
        walletLockCalls += 1;
        return null;
      },
    },
    walletName: "wallet.dat",
    internalPassphrase: "passphrase",
    recoverLockedWalletOnce: true,
    onLockedWalletRecoveryOutcome: (outcome) => {
      outcomes.push(outcome);
    },
    run: async () => {
      runCalls += 1;
      if (runCalls === 1) {
        throw new Error(LOCKED_WALLET_ERROR);
      }

      return "ok";
    },
  });

  assert.equal(result, "ok");
  assert.equal(runCalls, 2);
  assert.equal(walletPassphraseCalls, 2);
  assert.equal(walletLockCalls, 1);
  assert.deepEqual(outcomes, ["recovered"]);
});

test("withUnlockedManagedCoreWallet does not retry locked walletprocesspsbt errors unless enabled", async () => {
  let walletPassphraseCalls = 0;
  let walletLockCalls = 0;
  let runCalls = 0;

  await assert.rejects(
    withUnlockedManagedCoreWallet({
      rpc: {
        async walletPassphrase() {
          walletPassphraseCalls += 1;
          return null;
        },
        async walletLock() {
          walletLockCalls += 1;
          return null;
        },
      },
      walletName: "wallet.dat",
      internalPassphrase: "passphrase",
      run: async () => {
        runCalls += 1;
        throw new Error(LOCKED_WALLET_ERROR);
      },
    }),
    /walletpassphrase first/,
  );

  assert.equal(runCalls, 1);
  assert.equal(walletPassphraseCalls, 1);
  assert.equal(walletLockCalls, 1);
});

test("withUnlockedManagedCoreWallet does not retry wrong-passphrase signing failures", async () => {
  let walletPassphraseCalls = 0;
  let walletLockCalls = 0;
  let runCalls = 0;
  const outcomes: string[] = [];

  await assert.rejects(
    withUnlockedManagedCoreWallet({
      rpc: {
        async walletPassphrase() {
          walletPassphraseCalls += 1;
          return null;
        },
        async walletLock() {
          walletLockCalls += 1;
          return null;
        },
      },
      walletName: "wallet.dat",
      internalPassphrase: "passphrase",
      recoverLockedWalletOnce: true,
      onLockedWalletRecoveryOutcome: (outcome) => {
        outcomes.push(outcome);
      },
      run: async () => {
        runCalls += 1;
        throw new Error(WRONG_PASSPHRASE_ERROR);
      },
    }),
    /passphrase entered was incorrect/,
  );

  assert.equal(runCalls, 1);
  assert.equal(walletPassphraseCalls, 1);
  assert.equal(walletLockCalls, 1);
  assert.deepEqual(outcomes, []);
});
