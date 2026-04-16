import test from "node:test";
import assert from "node:assert/strict";

import { HELP_TEXT, parseCliArgs } from "../src/cli/parse.js";
import { formatCliTextError } from "../src/cli/output.js";

test("help text reflects the one-address model", () => {
  assert.match(HELP_TEXT, /anchor <domain>\s+Anchor an owned unanchored domain with the wallet address/);
  assert.match(HELP_TEXT, /balance\s+Show local wallet COG balances/);
  assert.doesNotMatch(HELP_TEXT, /--from/);
  assert.doesNotMatch(HELP_TEXT, /per-identity/);
});

test("parser rejects removed selector-based commands", () => {
  assert.throws(
    () => parseCliArgs(["register", "alpha", "--from", "id:1"]),
    /cli_from_not_supported_for_command/,
  );
  assert.throws(
    () => parseCliArgs(["anchor", "clear", "alpha"]),
    /cli_anchor_clear_removed/,
  );
});

test("CLI error text uses wallet-address wording", () => {
  const insufficient = formatCliTextError(new Error("wallet_buy_insufficient_cog_balance")) ?? [];
  const notLocal = formatCliTextError(new Error("wallet_transfer_owner_not_locally_controlled")) ?? [];

  assert.match(insufficient.join("\n"), /wallet address/);
  assert.match(insufficient.join("\n"), /enough spendable funds/);
  assert.match(insufficient.join("\n"), /wallet address/);
  assert.doesNotMatch(insufficient.join("\n"), /different buyer|--from|identity/);

  assert.match(notLocal.join("\n"), /current owner script\/address/);
  assert.match(notLocal.join("\n"), /wallet that controls the owner/);
  assert.doesNotMatch(notLocal.join("\n"), /owner identity|anchored owner identity/);
});
