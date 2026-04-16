import test from "node:test";
import assert from "node:assert/strict";

import {
  createFundingMutationSender,
  getDecodedInputScriptPubKeyHex,
  isLocalWalletScript,
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
