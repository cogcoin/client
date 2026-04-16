import assert from "node:assert/strict";
import test from "node:test";

import type {
  RpcDecodedPsbt,
  RpcListUnspentEntry,
  RpcLockedUnspent,
  RpcTransaction,
  RpcWalletTransaction,
} from "../src/bitcoind/types.js";
import {
  assertFundingInputsAfterFixedPrefix,
  buildWalletMutationTransactionWithReserveFallback,
  getDecodedInputScriptPubKeyHex,
} from "../src/wallet/tx/common.js";
import type { WalletStateV1 } from "../src/wallet/types.js";

const RESERVE_OUTPOINT = { txid: "11".repeat(32), vout: 0 };
const RESERVE_ENTRY: RpcListUnspentEntry = {
  ...RESERVE_OUTPOINT,
  address: "bc1qfundingidentity0000000000000000000000000",
  scriptPubKey: "fund-script",
  amount: 0.00025,
  confirmations: 12,
  spendable: true,
  safe: true,
};
const TEMP_LOCK_OUTPOINT = { txid: "ff".repeat(32), vout: 1 };

function createWalletState(partial: Partial<WalletStateV1> = {}): WalletStateV1 {
  return {
    schemaVersion: 1,
    stateRevision: 1,
    lastWrittenAtUnixMs: 1_700_000_000_000,
    walletRootId: "wallet-root-test",
    network: "mainnet",
    anchorValueSats: 2_000,
    proactiveReserveSats: 1_000,
    proactiveReserveOutpoints: [RESERVE_OUTPOINT],
    nextDedicatedIndex: 1,
    fundingIndex: 0,
    mnemonic: {
      phrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
      language: "english",
    },
    keys: {
      masterFingerprintHex: "1234abcd",
      accountPath: "m/84'/0'/0'",
      accountXprv: "xprv-test",
      accountXpub: "xpub-test",
    },
    descriptor: {
      privateExternal: "wpkh([1234abcd/84h/0h/0h]xprv-test/0/*)#priv",
      publicExternal: "wpkh([1234abcd/84h/0h/0h]xpub-test/0/*)#pub",
      checksum: "priv",
      rangeEnd: 4095,
      safetyMargin: 128,
    },
    funding: {
      address: "bc1qfundingidentity0000000000000000000000000",
      scriptPubKeyHex: "fund-script",
    },
    walletBirthTime: 1_700_000_000,
    managedCoreWallet: {
      walletName: "cogcoin-wallet-root-test",
      internalPassphrase: "core-passphrase",
      descriptorChecksum: "priv",
      fundingAddress0: "bc1qfundingidentity0000000000000000000000000",
      fundingScriptPubKeyHex0: "fund-script",
      proofStatus: "ready",
      lastImportedAtUnixMs: 1_700_000_000_000,
      lastVerifiedAtUnixMs: 1_700_000_000_000,
    },
    identities: [{
      index: 0,
      scriptPubKeyHex: "fund-script",
      address: "bc1qfundingidentity0000000000000000000000000",
      status: "funding",
      assignedDomainNames: [],
    }],
    domains: [],
    miningState: {
      runMode: "stopped",
      state: "idle",
      pauseReason: null,
      currentPublishState: "none",
      currentDomain: null,
      currentDomainId: null,
      currentDomainIndex: null,
      currentSenderScriptPubKeyHex: null,
      currentTxid: null,
      currentWtxid: null,
      currentFeeRateSatVb: null,
      currentAbsoluteFeeSats: null,
      currentScore: null,
      currentSentence: null,
      currentEncodedSentenceBytesHex: null,
      currentBip39WordIndices: null,
      currentBlendSeedHex: null,
      currentBlockTargetHeight: null,
      currentReferencedBlockHashDisplay: null,
      currentIntentFingerprintHex: null,
      liveMiningFamilyInMempool: false,
      currentPublishDecision: null,
      replacementCount: 0,
      currentBlockFeeSpentSats: "0",
      sessionFeeSpentSats: "0",
      lifetimeFeeSpentSats: "0",
      sharedMiningConflictOutpoint: null,
    },
    hookClientState: {
      mining: {
        mode: "builtin",
        validationState: "never",
        lastValidationAtUnixMs: null,
        lastValidationError: null,
        validatedLaunchFingerprint: null,
        validatedFullFingerprint: null,
        fullTrustWarningAcknowledgedAtUnixMs: null,
        consecutiveFailureCount: 0,
        cooldownUntilUnixMs: null,
      },
    },
    proactiveFamilies: [],
    pendingMutations: [],
    ...partial,
  };
}

type DecodedInputScriptSource = "prevout" | "witness_utxo" | "non_witness_utxo";

function createDecodedTransaction(changeValueSats: number, includePrevout = true): RpcTransaction {
  return {
    txid: "44".repeat(32),
    hash: "55".repeat(32),
    vin: [{
      txid: RESERVE_OUTPOINT.txid,
      vout: RESERVE_OUTPOINT.vout,
      ...(includePrevout
        ? {
          prevout: {
            scriptPubKey: {
              hex: "fund-script",
            },
          },
        }
        : {}),
    }],
    vout: [
      {
        n: 0,
        value: 0,
        scriptPubKey: {
          hex: "6a00",
        },
      },
      {
        n: 1,
        value: changeValueSats / 100_000_000,
        scriptPubKey: {
          hex: "fund-script",
        },
      },
    ],
  } as unknown as RpcTransaction;
}

function createDecodedPsbt(changeValueSats: number, inputScriptSource: DecodedInputScriptSource): RpcDecodedPsbt {
  return {
    tx: createDecodedTransaction(changeValueSats, inputScriptSource === "prevout"),
    inputs: [{
      ...(inputScriptSource === "witness_utxo"
        ? {
          witness_utxo: {
            value: RESERVE_ENTRY.amount,
            n: RESERVE_OUTPOINT.vout,
            scriptPubKey: {
              hex: RESERVE_ENTRY.scriptPubKey,
            },
          },
        }
        : {}),
      ...(inputScriptSource === "non_witness_utxo"
        ? {
          non_witness_utxo: {
            txid: RESERVE_OUTPOINT.txid,
            vin: [],
            vout: [{
              n: RESERVE_OUTPOINT.vout,
              value: RESERVE_ENTRY.amount,
              scriptPubKey: {
                hex: RESERVE_ENTRY.scriptPubKey,
              },
            }],
          },
        }
        : {}),
    }],
  };
}

function createReserveHarness(changeValueSats: number, inputScriptSource: DecodedInputScriptSource = "prevout") {
  let locked: RpcLockedUnspent[] = [RESERVE_OUTPOINT];
  const calls = {
    unlockCalls: [] as RpcLockedUnspent[][],
    lockCalls: [] as RpcLockedUnspent[][],
  };

  return {
    calls,
    rpc: {
      async listUnspent(_walletName: string, minConf = 1): Promise<RpcListUnspentEntry[]> {
        if (minConf > RESERVE_ENTRY.confirmations) {
          return [];
        }

        return locked.some((entry) => entry.txid === RESERVE_OUTPOINT.txid && entry.vout === RESERVE_OUTPOINT.vout)
          ? []
          : [{ ...RESERVE_ENTRY }];
      },
      async listLockUnspent(): Promise<RpcLockedUnspent[]> {
        return locked.map((entry) => ({ ...entry }));
      },
      async lockUnspent(_walletName: string, unlock: boolean, outputs: RpcLockedUnspent[]): Promise<boolean> {
        const snapshot = outputs.map((entry) => ({ ...entry }));
        if (unlock) {
          calls.unlockCalls.push(snapshot);
          const unlockedKeys = new Set(snapshot.map((entry) => `${entry.txid}:${entry.vout}`));
          locked = locked.filter((entry) => !unlockedKeys.has(`${entry.txid}:${entry.vout}`));
          return true;
        }

        calls.lockCalls.push(snapshot);
        const existing = new Set(locked.map((entry) => `${entry.txid}:${entry.vout}`));
        for (const output of snapshot) {
          const key = `${output.txid}:${output.vout}`;
          if (!existing.has(key)) {
            existing.add(key);
            locked.push({ ...output });
          }
        }
        return true;
      },
      async getTransaction(_walletName: string, txid: string): Promise<RpcWalletTransaction> {
        if (txid !== RESERVE_OUTPOINT.txid) {
          throw new Error("transaction_not_found");
        }
        return {
          txid,
          confirmations: RESERVE_ENTRY.confirmations,
          decoded: {
            txid,
            vin: [],
            vout: [{
              n: RESERVE_OUTPOINT.vout,
              value: RESERVE_ENTRY.amount,
              scriptPubKey: {
                hex: RESERVE_ENTRY.scriptPubKey,
              },
            }],
          },
        };
      },
      async walletCreateFundedPsbt(): Promise<{ psbt: string; fee: number; changepos: number }> {
        const reserveUnlocked = !locked.some((entry) => entry.txid === RESERVE_OUTPOINT.txid && entry.vout === RESERVE_OUTPOINT.vout);
        if (!reserveUnlocked) {
          throw new Error("Insufficient funds");
        }

        locked.push({ ...TEMP_LOCK_OUTPOINT });
        return {
          psbt: "funded-psbt",
          fee: 0.00001,
          changepos: 1,
        };
      },
      async decodePsbt(): Promise<RpcDecodedPsbt> {
        return createDecodedPsbt(changeValueSats, inputScriptSource);
      },
      async walletProcessPsbt(): Promise<{ psbt: string; complete: boolean }> {
        return {
          psbt: "signed-psbt",
          complete: true,
        };
      },
      async finalizePsbt(): Promise<{ complete: boolean; hex: string }> {
        return {
          complete: true,
          hex: "deadbeef",
        };
      },
      async decodeRawTransaction(): Promise<RpcTransaction> {
        return {
          ...createDecodedTransaction(changeValueSats),
          txid: "66".repeat(32),
          hash: "77".repeat(32),
        };
      },
      async testMempoolAccept(): Promise<Array<{ allowed: boolean }>> {
        return [{ allowed: true }];
      },
    },
  };
}

test("getDecodedInputScriptPubKeyHex prefers prevout and falls back to witness_utxo and non_witness_utxo", () => {
  const prevoutDecoded = createDecodedPsbt(2_000, "prevout");
  const witnessDecoded = createDecodedPsbt(2_000, "witness_utxo");
  const nonWitnessDecoded = createDecodedPsbt(2_000, "non_witness_utxo");

  assert.equal(getDecodedInputScriptPubKeyHex(prevoutDecoded, 0), "fund-script");
  assert.equal(getDecodedInputScriptPubKeyHex(witnessDecoded, 0), "fund-script");
  assert.equal(getDecodedInputScriptPubKeyHex(nonWitnessDecoded, 0), "fund-script");
  assert.equal(getDecodedInputScriptPubKeyHex({ tx: { txid: "00", vin: [{}], vout: [] } }, 0), null);
});

test("assertFundingInputsAfterFixedPrefix accepts witness_utxo-backed funding inputs when tx vin prevout is absent", () => {
  const decoded: RpcDecodedPsbt = {
    tx: {
      txid: "44".repeat(32),
      vin: [{
        txid: RESERVE_OUTPOINT.txid,
        vout: RESERVE_OUTPOINT.vout,
      }],
      vout: [],
    },
    inputs: [{
      witness_utxo: {
        n: RESERVE_OUTPOINT.vout,
        value: RESERVE_ENTRY.amount,
        scriptPubKey: {
          hex: RESERVE_ENTRY.scriptPubKey,
        },
      },
    }],
  };

  assert.doesNotThrow(() => assertFundingInputsAfterFixedPrefix({
    decoded,
    fixedInputs: [],
    allowedFundingScriptPubKeyHex: RESERVE_ENTRY.scriptPubKey,
    eligibleFundingOutpointKeys: new Set([`${RESERVE_OUTPOINT.txid}:${RESERVE_OUTPOINT.vout}`]),
    errorCode: "wallet_test_unexpected_funding_input",
  }));
});

test("buildWalletMutationTransactionWithReserveFallback unlocks a locked reserve outpoint, preserves the floor, and re-locks it", async () => {
  const state = createWalletState();
  const harness = createReserveHarness(2_000);

  const built = await buildWalletMutationTransactionWithReserveFallback({
    rpc: harness.rpc,
    walletName: state.managedCoreWallet.walletName,
    state,
    plan: {
      fixedInputs: [],
      outputs: [{ data: "00" }],
      changeAddress: state.funding.address,
      changePosition: 1,
      allowedFundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
      eligibleFundingOutpointKeys: new Set<string>(),
    },
    validateFundedDraft() {},
    finalizeErrorCode: "wallet_test_finalize_failed",
    mempoolRejectPrefix: "wallet_test_mempool_rejected",
    reserveCandidates: state.proactiveReserveOutpoints,
  });

  assert.equal(built.txid, "66".repeat(32));
  assert.deepEqual(harness.calls.unlockCalls, [
    [RESERVE_OUTPOINT],
    [RESERVE_OUTPOINT],
  ]);
  assert.deepEqual(harness.calls.lockCalls, [
    [RESERVE_OUTPOINT],
    [RESERVE_OUTPOINT],
  ]);
  assert.deepEqual(built.temporaryBuilderLockedOutpoints, [TEMP_LOCK_OUTPOINT]);
});

test("buildWalletMutationTransactionWithReserveFallback rejects drafts that would leave less than the reserve floor and re-locks the reserve outpoint", async () => {
  const state = createWalletState();
  const harness = createReserveHarness(500);

  await assert.rejects(() => buildWalletMutationTransactionWithReserveFallback({
    rpc: harness.rpc,
    walletName: state.managedCoreWallet.walletName,
    state,
    plan: {
      fixedInputs: [],
      outputs: [{ data: "00" }],
      changeAddress: state.funding.address,
      changePosition: 1,
      allowedFundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
      eligibleFundingOutpointKeys: new Set<string>(),
    },
    validateFundedDraft() {},
    finalizeErrorCode: "wallet_test_finalize_failed",
    mempoolRejectPrefix: "wallet_test_mempool_rejected",
    reserveCandidates: state.proactiveReserveOutpoints,
  }), /wallet_mutation_insufficient_funding_after_reserve/);

  assert.deepEqual(harness.calls.unlockCalls, [
    [RESERVE_OUTPOINT],
    [RESERVE_OUTPOINT],
    [TEMP_LOCK_OUTPOINT],
  ]);
  assert.deepEqual(harness.calls.lockCalls, [
    [RESERVE_OUTPOINT],
    [RESERVE_OUTPOINT],
  ]);
});

test("buildWalletMutationTransactionWithReserveFallback still enforces the reserve floor when decodepsbt only exposes witness_utxo input scripts", async () => {
  const state = createWalletState();
  const harness = createReserveHarness(500, "witness_utxo");

  await assert.rejects(() => buildWalletMutationTransactionWithReserveFallback({
    rpc: harness.rpc,
    walletName: state.managedCoreWallet.walletName,
    state,
    plan: {
      fixedInputs: [],
      outputs: [{ data: "00" }],
      changeAddress: state.funding.address,
      changePosition: 1,
      allowedFundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
      eligibleFundingOutpointKeys: new Set<string>(),
    },
    validateFundedDraft() {},
    finalizeErrorCode: "wallet_test_finalize_failed",
    mempoolRejectPrefix: "wallet_test_mempool_rejected",
    reserveCandidates: state.proactiveReserveOutpoints,
  }), /wallet_mutation_insufficient_funding_after_reserve/);
});

test("buildWalletMutationTransactionWithReserveFallback discovers reserve candidates from reconciled state when the persisted reserve set is empty", async () => {
  const state = createWalletState({
    proactiveReserveOutpoints: [],
  });
  const harness = createReserveHarness(2_000);

  const built = await buildWalletMutationTransactionWithReserveFallback({
    rpc: harness.rpc,
    walletName: state.managedCoreWallet.walletName,
    state,
    plan: {
      fixedInputs: [],
      outputs: [{ data: "00" }],
      changeAddress: state.funding.address,
      changePosition: 1,
      allowedFundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
      eligibleFundingOutpointKeys: new Set<string>(),
    },
    validateFundedDraft() {},
    finalizeErrorCode: "wallet_test_finalize_failed",
    mempoolRejectPrefix: "wallet_test_mempool_rejected",
    reserveCandidates: state.proactiveReserveOutpoints,
  });

  assert.equal(built.txid, "66".repeat(32));
  assert.deepEqual(harness.calls.unlockCalls, [
    [RESERVE_OUTPOINT],
    [RESERVE_OUTPOINT],
    [RESERVE_OUTPOINT],
  ]);
  assert.deepEqual(harness.calls.lockCalls, [
    [RESERVE_OUTPOINT],
    [RESERVE_OUTPOINT],
    [RESERVE_OUTPOINT],
  ]);
});
