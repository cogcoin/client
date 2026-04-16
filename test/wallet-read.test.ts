import test from "node:test";
import assert from "node:assert/strict";

import { buildAddressJson, buildIdsJson } from "../src/cli/read-json.js";
import { normalizeListPage } from "../src/cli/output.js";
import { createWalletReadContext } from "./current-model-helpers.js";

test("address JSON reports the single wallet address", () => {
  const context = createWalletReadContext();
  const result = buildAddressJson(context);

  assert.equal(result.data.address, "bc1qfunding");
  assert.equal(result.data.scriptPubKeyHex, "0014" + "11".repeat(20));
});

test("ids JSON exposes a single wallet-address entry", () => {
  const context = createWalletReadContext();
  const { page } = normalizeListPage([1], { limit: null, all: true, defaultLimit: 50 });
  const result = buildIdsJson(context, page);

  assert.equal(result.data.addresses?.length, 1);
  assert.equal(result.data.addresses?.[0]?.address, "bc1qfunding");
  assert.deepEqual(result.data.addresses?.[0]?.localDomains, []);
});
