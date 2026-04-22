import test from "node:test";
import assert from "node:assert/strict";

import { extractOpReturnPayloadFromScriptHex } from "../src/wallet/tx/register.js";

test("register OP_RETURN payload extraction still decodes payload bytes", () => {
  const payload = Buffer.from("hello");
  const scriptHex = Buffer.concat([Buffer.from([0x6a, payload.length]), payload]).toString("hex");

  const extracted = extractOpReturnPayloadFromScriptHex(scriptHex);

  assert.equal(Buffer.from(extracted ?? []).toString("utf8"), "hello");
});
