import test from "node:test";
import assert from "node:assert/strict";

import {
  assertWalletBitcoinTransferContextReady,
  assertWalletMutationContextReady,
  buildWalletMutationTransaction,
  createFundingMutationSender,
  getDecodedInputScriptPubKeyHex,
  isLocalWalletScript,
  resolvePendingMutationReuseDecision,
  resolveWalletMutationFeeSelection,
} from "../src/wallet/tx/common.js";
import { createWalletReadContext, createWalletState } from "./current-model-helpers.js";

test("funding mutation sender always resolves to the wallet address", () => {
  const state = createWalletState();
  const sender = createFundingMutationSender(state);

  assert.equal(sender.address, state.funding.address);
  assert.equal(sender.scriptPubKeyHex, state.funding.scriptPubKeyHex);
  assert.equal(sender.localIndex, 0);
  assert.equal(isLocalWalletScript(state, state.funding.scriptPubKeyHex), true);
});

test("decoded input script lookup falls back through PSBT metadata", () => {
  const witnessDecoded = {
    tx: {
      vin: [{ txid: "aa".repeat(32), vout: 1 }],
      vout: [],
    },
    inputs: [{
      witness_utxo: {
        scriptPubKey: {
          hex: "0014" + "11".repeat(20),
        },
      },
    }],
  };
  const nonWitnessDecoded = {
    tx: {
      vin: [{ txid: "bb".repeat(32), vout: 2 }],
      vout: [],
    },
    inputs: [{
      non_witness_utxo: {
        vout: [
          { n: 2, scriptPubKey: { hex: "0014" + "22".repeat(20) } },
        ],
      },
    }],
  };

  assert.equal(getDecodedInputScriptPubKeyHex(witnessDecoded as any, 0), "0014" + "11".repeat(20));
  assert.equal(getDecodedInputScriptPubKeyHex(nonWitnessDecoded as any, 0), "0014" + "22".repeat(20));
});

test("wallet mutation fee selection uses explicit sat/vB overrides without smart-fee RPC", async () => {
  let called = false;

  const selection = await resolveWalletMutationFeeSelection({
    rpc: {
      estimateSmartFee: async () => {
        called = true;
        return { feerate: 0.00011 };
      },
    },
    feeRateSatVb: 12.5,
  });

  assert.deepEqual(selection, {
    feeRateSatVb: 12.5,
    source: "custom-satvb",
  });
  assert.equal(called, false);
});

test("wallet mutation fee selection uses next-block smart fee plus one sat/vB", async () => {
  const selection = await resolveWalletMutationFeeSelection({
    rpc: {
      estimateSmartFee: async (confirmTarget, mode) => {
        assert.equal(confirmTarget, 1);
        assert.equal(mode, "conservative");
        return { feerate: 0.00011 };
      },
    },
  });

  assert.deepEqual(selection, {
    feeRateSatVb: 12,
    source: "estimated-next-block-plus-one",
  });
});

test("wallet mutation fee selection falls back when smart fee is unavailable", async () => {
  const selection = await resolveWalletMutationFeeSelection({
    rpc: {
      estimateSmartFee: async () => {
        throw new Error("rpc unavailable");
      },
    },
  });

  assert.deepEqual(selection, {
    feeRateSatVb: 10,
    source: "fallback-default",
  });
});

test("wallet mutation builder forwards availableFundingMinConf to PSBT funding and safe UTXO discovery", async () => {
  const state = createWalletState();
  const observedListUnspentMinConfs: Array<number | undefined> = [];
  let fundedOptions: Record<string, unknown> | null = null;

  const built = await buildWalletMutationTransaction({
    rpc: {
      async listUnspent(_walletName, minConf) {
        observedListUnspentMinConfs.push(minConf);
        return [{
          txid: "aa".repeat(32),
          vout: 0,
          scriptPubKey: state.funding.scriptPubKeyHex,
          amount: 0.0001,
          confirmations: 0,
          spendable: true,
          safe: true,
        }];
      },
      async walletCreateFundedPsbt(_walletName, _inputs, _outputs, _locktime, options) {
        fundedOptions = options;
        return {
          psbt: "funded-psbt",
          fee: 0.00000011,
          changepos: 1,
        };
      },
      async decodePsbt() {
        return {
          tx: {
            vin: [{ txid: "aa".repeat(32), vout: 0 }],
            vout: [
              {
                value: 0.00005,
                scriptPubKey: { hex: "6a01ff" },
              },
              {
                value: 0.0000489,
                scriptPubKey: { hex: state.funding.scriptPubKeyHex },
              },
            ],
          },
          inputs: [],
        } as never;
      },
      async walletPassphrase() {
        return null;
      },
      async walletProcessPsbt() {
        return {
          psbt: "signed-psbt",
          complete: true,
        };
      },
      async walletLock() {
        return null;
      },
      async finalizePsbt() {
        return {
          complete: true,
          hex: "raw-hex",
        };
      },
      async decodeRawTransaction() {
        return {
          txid: "bb".repeat(32),
          hash: "cc".repeat(32),
        } as never;
      },
      async testMempoolAccept() {
        return [{ allowed: true }];
      },
    },
    walletName: state.managedCoreWallet.walletName,
    state,
    plan: {
      fixedInputs: [],
      outputs: [{ data: "ff" }],
      changeAddress: state.funding.address,
      changePosition: 1,
      allowedFundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
      eligibleFundingOutpointKeys: new Set<string>(),
    },
    validateFundedDraft(_decoded, _funded, plan) {
      assert.deepEqual(observedListUnspentMinConfs, [0]);
      assert.equal(fundedOptions?.["include_unsafe"], false);
      assert.equal(fundedOptions?.["minconf"], 0);
      assert.equal(plan.eligibleFundingOutpointKeys.has(`${"aa".repeat(32)}:0`), true);
    },
    finalizeErrorCode: "wallet_mutation_finalize_failed",
    mempoolRejectPrefix: "wallet_mutation_mempool_rejected",
    availableFundingMinConf: 0,
  });

  assert.equal(built.txid, "bb".repeat(32));
  assert.equal(built.wtxid, "cc".repeat(32));
});

test("wallet mutation readiness tolerates a 1-2 block header lead when nodeHealth stays synced", () => {
  const context = createWalletReadContext({
    localState: {
      availability: "ready",
      clientPasswordReadiness: "ready",
      unlockRequired: false,
      walletRootId: "wallet-root",
      state: createWalletState(),
      source: "primary",
      hasPrimaryStateFile: true,
      hasBackupStateFile: false,
      message: null,
    },
    bitcoind: {
      health: "ready",
      message: null,
      status: null,
    },
    nodeHealth: "synced",
    nodeMessage: "Bitcoin headers can briefly lead validated blocks; a short 1-2 block lead is normal and is being tolerated.",
    nodeStatus: {
      chain: "mainnet",
      nodeBestHeight: 100,
      nodeBestHashHex: "11".repeat(32),
      nodeHeaderHeight: 102,
      walletReplica: {
        proofStatus: "ready",
      },
    },
    snapshot: {
      state: {
        consensus: {
          domainIdsByName: new Map(),
          domainsById: new Map(),
          balances: new Map(),
        },
        history: {
          foundingMessageByDomain: new Map(),
          blockWinnersByHeight: new Map(),
        },
      },
      tip: {
        height: 100,
        blockHashHex: "11".repeat(32),
        previousHashHex: "22".repeat(32),
        stateHashHex: "33".repeat(32),
      },
    },
    model: {
      walletRootId: "wallet-root",
      walletAddress: "bc1qfunding",
      walletScriptPubKeyHex: "0014" + "11".repeat(20),
      domains: [],
    },
  });

  assert.doesNotThrow(() => {
    assertWalletMutationContextReady(context as any, "wallet_register");
    assertWalletBitcoinTransferContextReady(context as any, "wallet_bitcoin_transfer");
  });
});

test("wallet mutation readiness still rejects a 3-block header lead", () => {
  const context = createWalletReadContext({
    localState: {
      availability: "ready",
      clientPasswordReadiness: "ready",
      unlockRequired: false,
      walletRootId: "wallet-root",
      state: createWalletState(),
      source: "primary",
      hasPrimaryStateFile: true,
      hasBackupStateFile: false,
      message: null,
    },
    bitcoind: {
      health: "ready",
      message: null,
      status: null,
    },
    nodeHealth: "catching-up",
    nodeMessage: "Bitcoin Core is still catching up to headers.",
    nodeStatus: {
      chain: "mainnet",
      nodeBestHeight: 100,
      nodeBestHashHex: "11".repeat(32),
      nodeHeaderHeight: 103,
      walletReplica: {
        proofStatus: "ready",
      },
    },
  });

  assert.throws(
    () => assertWalletMutationContextReady(context as any, "wallet_register"),
    /wallet_register_node_catching_up/,
  );
  assert.throws(
    () => assertWalletBitcoinTransferContextReady(context as any, "wallet_bitcoin_transfer"),
    /wallet_bitcoin_transfer_node_catching_up/,
  );
});

test("pending mutation reuse switches to replacement when the new fee rate is higher", async () => {
  const decision = await resolvePendingMutationReuseDecision({
    rpc: {
      getTransaction: async () => ({
        txid: "aa".repeat(32),
        confirmations: 0,
        decoded: {
          txid: "aa".repeat(32),
          vin: [{ txid: "bb".repeat(32), vout: 1 }],
          vout: [],
        },
      }),
    },
    walletName: "wallet",
    mutation: {
      mutationId: "mutation-1",
      kind: "register",
      domainName: "alpha",
      parentDomainName: null,
      senderScriptPubKeyHex: "0014" + "11".repeat(20),
      senderLocalIndex: 0,
      intentFingerprintHex: "cc".repeat(32),
      status: "live",
      createdAtUnixMs: 1,
      lastUpdatedAtUnixMs: 1,
      attemptedTxid: "aa".repeat(32),
      attemptedWtxid: null,
      selectedFeeRateSatVb: 5,
      feeSelectionSource: "fallback-default",
      temporaryBuilderLockedOutpoints: [],
    },
    nextFeeSelection: {
      feeRateSatVb: 8,
      source: "custom-satvb",
    },
  });

  assert.equal(decision.reuseExisting, false);
  assert.deepEqual(decision.fees, {
    feeRateSatVb: 5,
    feeSats: null,
    source: "fallback-default",
  });
  assert.deepEqual(decision.replacementFixedInputs, [
    { txid: "bb".repeat(32), vout: 1 },
  ]);
});
