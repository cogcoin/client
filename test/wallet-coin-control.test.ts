import assert from "node:assert/strict";
import test from "node:test";

import type { RpcListUnspentEntry, RpcLockedUnspent } from "../src/bitcoind/types.js";
import {
  DEFAULT_PROACTIVE_RESERVE_SATS,
  computeDesignatedProactiveReserveOutpoints,
  normalizeWalletStateRecord,
  reconcilePersistentPolicyLocks,
} from "../src/wallet/coin-control.js";
import type { WalletStateV1 } from "../src/wallet/types.js";

function createWalletState(partial: Partial<WalletStateV1> = {}): WalletStateV1 {
  return {
    schemaVersion: 1,
    stateRevision: 1,
    lastWrittenAtUnixMs: 1_700_000_000_000,
    walletRootId: "wallet-root-test",
    network: "mainnet",
    anchorValueSats: 2_000,
    proactiveReserveSats: 50_000,
    proactiveReserveOutpoints: [],
    nextDedicatedIndex: 3,
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
    identities: [
      {
        index: 0,
        scriptPubKeyHex: "fund-script",
        address: "bc1qfundingidentity0000000000000000000000000",
        status: "funding",
        assignedDomainNames: [],
      },
      {
        index: 1,
        scriptPubKeyHex: "ded-script",
        address: "bc1qdomaindedicated000000000000000000000000",
        status: "dedicated",
        assignedDomainNames: ["alpha"],
      },
    ],
    domains: [
      {
        name: "alpha",
        domainId: 1,
        dedicatedIndex: 1,
        currentOwnerScriptPubKeyHex: "ded-script",
        currentOwnerLocalIndex: 1,
        canonicalChainStatus: "anchored",
        localAnchorIntent: "none",
        currentCanonicalAnchorOutpoint: {
          txid: "aa".repeat(32),
          vout: 1,
          valueSats: 2_000,
        },
        foundingMessageText: "alpha founded",
        birthTime: 1_700_000_000,
      },
    ],
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
      sharedMiningConflictOutpoint: {
        txid: "cc".repeat(32),
        vout: 0,
      },
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

function createFundingUtxo(txidHex: string, amount: number, confirmations = 1): RpcListUnspentEntry {
  return {
    txid: txidHex.repeat(32),
    vout: 0,
    scriptPubKey: "fund-script",
    amount,
    confirmations,
    spendable: true,
    safe: true,
  };
}

function outpointStrings(groups: readonly RpcLockedUnspent[][]): string[][] {
  return groups.map((group) => group.map((outpoint) => `${outpoint.txid}:${outpoint.vout}`).sort());
}

function createMockRpc(options: {
  spendable: RpcListUnspentEntry[];
  locked?: RpcLockedUnspent[];
}) {
  let locked = [...(options.locked ?? [])];
  const unlockCalls: RpcLockedUnspent[][] = [];
  const lockCalls: RpcLockedUnspent[][] = [];

  return {
    calls: {
      unlockCalls,
      lockCalls,
    },
    async listUnspent(): Promise<RpcListUnspentEntry[]> {
      return options.spendable.map((entry) => ({ ...entry }));
    },
    async listLockUnspent(): Promise<RpcLockedUnspent[]> {
      return locked.map((entry) => ({ ...entry }));
    },
    async lockUnspent(_walletName: string, unlock: boolean, outputs: RpcLockedUnspent[]): Promise<boolean> {
      const snapshot = outputs.map((entry) => ({ ...entry }));
      if (unlock) {
        unlockCalls.push(snapshot);
        const unlockedKeys = new Set(snapshot.map((entry) => `${entry.txid}:${entry.vout}`));
        locked = locked.filter((entry) => !unlockedKeys.has(`${entry.txid}:${entry.vout}`));
      } else {
        lockCalls.push(snapshot);
        const existing = new Set(locked.map((entry) => `${entry.txid}:${entry.vout}`));
        for (const output of snapshot) {
          const key = `${output.txid}:${output.vout}`;
          if (!existing.has(key)) {
            existing.add(key);
            locked.push(output);
          }
        }
      }
      return true;
    },
  };
}

test("normalizeWalletStateRecord adds the reserve defaults", () => {
  const raw: Partial<WalletStateV1> = { ...createWalletState() };
  delete raw.proactiveReserveSats;
  delete raw.proactiveReserveOutpoints;

  const normalized = normalizeWalletStateRecord(raw as WalletStateV1);
  assert.equal(normalized.proactiveReserveSats, DEFAULT_PROACTIVE_RESERVE_SATS);
  assert.deepEqual(normalized.proactiveReserveOutpoints, []);
});

test("computeDesignatedProactiveReserveOutpoints uses confirmed index-0 funding and excludes mining conflict", () => {
  const state = createWalletState();
  const reserve = computeDesignatedProactiveReserveOutpoints(state, [
    createFundingUtxo("cc", 0.0006, 1),
    createFundingUtxo("dd", 0.0003, 1),
    createFundingUtxo("ee", 0.00025, 1),
    createFundingUtxo("ff", 1, 0),
    {
      txid: "11".repeat(32),
      vout: 2,
      scriptPubKey: "ded-script",
      amount: 0.5,
      confirmations: 12,
      spendable: true,
      safe: true,
    },
  ]);

  assert.deepEqual(reserve, [
    { txid: "dd".repeat(32), vout: 0 },
    { txid: "ee".repeat(32), vout: 0 },
  ]);
});

test("reconcilePersistentPolicyLocks locks canonical anchors, auxiliary dedicated utxos, reserve utxos, and idle mining conflict without touching unrelated locks", async () => {
  const state = createWalletState();
  const rpc = createMockRpc({
    spendable: [
      {
        txid: "aa".repeat(32),
        vout: 1,
        scriptPubKey: "ded-script",
        amount: 0.00002,
        confirmations: 5,
        spendable: true,
        safe: true,
      },
      {
        txid: "bb".repeat(32),
        vout: 9,
        scriptPubKey: "ded-script",
        amount: 0.0005,
        confirmations: 6,
        spendable: true,
        safe: true,
      },
      createFundingUtxo("cc", 0.0006, 1),
      createFundingUtxo("dd", 0.0003, 1),
      createFundingUtxo("ee", 0.00025, 1),
    ],
    locked: [{ txid: "ff".repeat(32), vout: 4 }],
  });

  await reconcilePersistentPolicyLocks({
    rpc,
    walletName: state.managedCoreWallet.walletName,
    state,
  });

  assert.deepEqual(outpointStrings(rpc.calls.unlockCalls), []);
  assert.deepEqual(outpointStrings(rpc.calls.lockCalls), [[
    `${"aa".repeat(32)}:1`,
    `${"bb".repeat(32)}:9`,
    `${"cc".repeat(32)}:0`,
    `${"dd".repeat(32)}:0`,
    `${"ee".repeat(32)}:0`,
  ].sort()]);
});

test("fixed inputs are exempt for the active build and restored by the next reconciliation", async () => {
  const state = createWalletState();
  const rpc = createMockRpc({
    spendable: [
      {
        txid: "aa".repeat(32),
        vout: 1,
        scriptPubKey: "ded-script",
        amount: 0.00002,
        confirmations: 5,
        spendable: true,
        safe: true,
      },
      createFundingUtxo("dd", 0.0003, 1),
      createFundingUtxo("ee", 0.00025, 1),
    ],
  });

  await reconcilePersistentPolicyLocks({
    rpc,
    walletName: state.managedCoreWallet.walletName,
    state,
    fixedInputs: [{ txid: "aa".repeat(32), vout: 1 }],
  });
  assert.deepEqual(outpointStrings(rpc.calls.lockCalls), [[
    `${"dd".repeat(32)}:0`,
    `${"ee".repeat(32)}:0`,
  ].sort()]);

  await reconcilePersistentPolicyLocks({
    rpc,
    walletName: state.managedCoreWallet.walletName,
    state,
  });
  assert.deepEqual(outpointStrings(rpc.calls.lockCalls).at(-1), [
    `${"aa".repeat(32)}:1`,
  ]);
});

test("cleanupInactiveTemporaryBuilderLocks clears stale tracked locks and preserves active family locks", async () => {
  const state = createWalletState({
    pendingMutations: [
      {
        mutationId: "draft",
        kind: "send",
        domainName: "alpha",
        parentDomainName: null,
        senderScriptPubKeyHex: "fund-script",
        senderLocalIndex: 0,
        intentFingerprintHex: "11".repeat(32),
        status: "draft",
        createdAtUnixMs: 1,
        lastUpdatedAtUnixMs: 1,
        attemptedTxid: null,
        attemptedWtxid: null,
        temporaryBuilderLockedOutpoints: [{ txid: "dd".repeat(32), vout: 7 }],
      },
      {
        mutationId: "live",
        kind: "send",
        domainName: "alpha",
        parentDomainName: null,
        senderScriptPubKeyHex: "fund-script",
        senderLocalIndex: 0,
        intentFingerprintHex: "22".repeat(32),
        status: "live",
        createdAtUnixMs: 1,
        lastUpdatedAtUnixMs: 1,
        attemptedTxid: "33".repeat(32),
        attemptedWtxid: "44".repeat(32),
        temporaryBuilderLockedOutpoints: [{ txid: "ee".repeat(32), vout: 8 }],
      },
    ],
    proactiveFamilies: [
      {
        familyId: "anchor-stale",
        type: "anchor",
        status: "canceled",
        intentFingerprintHex: "55".repeat(32),
        createdAtUnixMs: 1,
        tx1: {
          status: "canceled",
          attemptedTxid: "66".repeat(32),
          attemptedWtxid: "77".repeat(32),
          temporaryBuilderLockedOutpoints: [{ txid: "aa".repeat(32), vout: 2 }],
          rawHex: null,
        },
      },
      {
        familyId: "field-live",
        type: "field",
        status: "live",
        intentFingerprintHex: "88".repeat(32),
        createdAtUnixMs: 1,
        tx2: {
          status: "live",
          attemptedTxid: "99".repeat(32),
          attemptedWtxid: "00".repeat(32),
          temporaryBuilderLockedOutpoints: [{ txid: "bb".repeat(32), vout: 3 }],
          rawHex: null,
        },
      },
    ],
  });
  const rpc = createMockRpc({
    spendable: [],
    locked: [
      { txid: "dd".repeat(32), vout: 7 },
      { txid: "aa".repeat(32), vout: 2 },
      { txid: "ee".repeat(32), vout: 8 },
      { txid: "bb".repeat(32), vout: 3 },
    ],
  });

  const reconciled = await reconcilePersistentPolicyLocks({
    rpc,
    walletName: state.managedCoreWallet.walletName,
    state,
    cleanupInactiveTemporaryBuilderLocks: true,
  });

  assert.deepEqual(outpointStrings(rpc.calls.unlockCalls), [[
    `${"aa".repeat(32)}:2`,
    `${"dd".repeat(32)}:7`,
  ].sort()]);
  assert.deepEqual(reconciled.state.pendingMutations?.[0]?.temporaryBuilderLockedOutpoints, []);
  assert.deepEqual(reconciled.state.pendingMutations?.[1]?.temporaryBuilderLockedOutpoints, [{ txid: "ee".repeat(32), vout: 8 }]);
  assert.deepEqual(reconciled.state.proactiveFamilies[0]?.tx1?.temporaryBuilderLockedOutpoints, []);
  assert.deepEqual(reconciled.state.proactiveFamilies[1]?.tx2?.temporaryBuilderLockedOutpoints, [{ txid: "bb".repeat(32), vout: 3 }]);
});

test("live mining families do not re-lock the active conflict outpoint as an idle reservation", async () => {
  const state = createWalletState({
    proactiveReserveSats: 0,
    domains: [],
    identities: [{
      index: 0,
      scriptPubKeyHex: "fund-script",
      address: "bc1qfundingidentity0000000000000000000000000",
      status: "funding",
      assignedDomainNames: [],
    }],
    miningState: {
      ...createWalletState().miningState,
      state: "live",
      currentPublishState: "in-mempool",
      currentTxid: "ab".repeat(32),
      liveMiningFamilyInMempool: true,
    },
  });
  const rpc = createMockRpc({
    spendable: [createFundingUtxo("cc", 0.0006, 1)],
  });

  await reconcilePersistentPolicyLocks({
    rpc,
    walletName: state.managedCoreWallet.walletName,
    state,
  });

  assert.deepEqual(outpointStrings(rpc.calls.lockCalls), []);
});
