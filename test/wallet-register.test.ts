import test from "node:test";
import assert from "node:assert/strict";

import { buildRegisterMutationData } from "../src/cli/mutation-json.js";
import { extractOpReturnPayloadFromScriptHex } from "../src/wallet/tx/register.js";

test("register mutation JSON stays single-tx", () => {
  const data = buildRegisterMutationData({
    domainName: "alpha",
    registerKind: "root",
    txid: "aa".repeat(32),
    status: "live",
    reusedExisting: false,
    fees: {
      feeRateSatVb: 11,
      feeSats: "200",
      source: "estimated-next-block-plus-one",
    },
    resolved: {
      sender: {
        selector: "wallet",
        localIndex: 0,
        scriptPubKeyHex: "0014" + "11".repeat(20),
        address: "bc1qfunding",
      },
      economicEffect: {
        kind: "burn",
        amount: 100n,
      },
    },
  } as any, {
    forceRace: false,
  });

  assert.equal(data.resultType, "single-tx-mutation");
  assert.equal(data.intent.registerKind, "root");
  assert.equal(data.resolved.sender.address, "bc1qfunding");
});

test("register OP_RETURN payload extraction still decodes payload bytes", () => {
  const payload = Buffer.from("hello");
  const scriptHex = Buffer.concat([Buffer.from([0x6a, payload.length]), payload]).toString("hex");

  const extracted = extractOpReturnPayloadFromScriptHex(scriptHex);

  assert.equal(Buffer.from(extracted ?? []).toString("utf8"), "hello");
});
