import test from "node:test";
import assert from "node:assert/strict";

import { HELP_TEXT, parseCliArgs } from "../src/cli/parse.js";
import { formatCliTextError } from "../src/cli/output.js";

test("help text reflects the one-address model", () => {
  assert.match(HELP_TEXT, /anchor <domain>\s+Anchor an owned unanchored domain with the wallet address/);
  assert.match(HELP_TEXT, /balance\s+Show local wallet COG balances/);
  assert.doesNotMatch(HELP_TEXT, /--from/);
  assert.doesNotMatch(HELP_TEXT, /per-identity/);
  assert.doesNotMatch(HELP_TEXT, /wallet export <path>/);
  assert.doesNotMatch(HELP_TEXT, /wallet import <path>/);
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
  assert.throws(
    () => parseCliArgs(["wallet", "export", "wallet.cogcoin"]),
    /cli_wallet_export_removed/,
  );
  assert.throws(
    () => parseCliArgs(["wallet", "import", "wallet.cogcoin"]),
    /cli_wallet_import_removed/,
  );
  assert.throws(
    () => parseCliArgs(["unlock"]),
    /cli_unknown_command_unlock/,
  );
  assert.throws(
    () => parseCliArgs(["wallet", "unlock"]),
    /cli_unknown_command_wallet_unlock/,
  );
  assert.throws(
    () => parseCliArgs(["wallet", "lock"]),
    /cli_unknown_command_wallet_lock/,
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

test("CLI error text describes Windows local-file secret failures", () => {
  const formatted = formatCliTextError(new Error("wallet_secret_provider_windows_runtime_error")) ?? [];
  const rendered = formatted.join("\n");

  assert.match(rendered, /Windows local wallet-secret access failed/);
  assert.match(rendered, /state directory/i);
});

test("CLI error text explains removed wallet archive export", () => {
  const formatted = formatCliTextError(new Error("cli_wallet_export_removed")) ?? [];
  const rendered = formatted.join("\n");

  assert.match(rendered, /wallet export/i);
  assert.match(rendered, /no longer available|removed/i);
  assert.match(rendered, /mnemonic|recovery/i);
});

test("CLI error text explains removed wallet archive import", () => {
  const formatted = formatCliTextError(new Error("cli_wallet_import_removed")) ?? [];
  const rendered = formatted.join("\n");

  assert.match(rendered, /wallet import/i);
  assert.match(rendered, /no longer available|removed/i);
  assert.match(rendered, /restore/i);
});

test("CLI error text explains unsupported legacy wallet state", () => {
  const formatted = formatCliTextError(new Error("wallet_state_legacy_envelope_unsupported")) ?? [];
  const rendered = formatted.join("\n");

  assert.match(rendered, /legacy wallet state/i);
  assert.match(rendered, /older Cogcoin format/i);
  assert.match(rendered, /restore|recover/i);
  assert.doesNotMatch(rendered, /passphrase/i);
});

test("CLI error text describes Linux local-file secret failures", () => {
  const formatted = formatCliTextError(new Error("wallet_secret_provider_linux_runtime_error")) ?? [];
  const rendered = formatted.join("\n");

  assert.match(rendered, /Linux local wallet-secret access failed/);
  assert.match(rendered, /state directory/i);
});
