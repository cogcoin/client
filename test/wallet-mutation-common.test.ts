import test from "node:test";
import assert from "node:assert/strict";

import {
  createFundingMutationSender,
  getDecodedInputScriptPubKeyHex,
  isLocalWalletScript,
  resolvePendingMutationReuseDecision,
  resolveWalletMutationFeeSelection,
} from "../src/wallet/tx/common.js";
import { createWalletState } from "./current-model-helpers.js";

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
