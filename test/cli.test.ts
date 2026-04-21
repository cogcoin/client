import test from "node:test";
import assert from "node:assert/strict";

import { HELP_TEXT, parseCliArgs } from "../src/cli/parse.js";
import { formatCliTextError } from "../src/cli/output.js";
import { FileLockBusyError } from "../src/wallet/fs/lock.js";

test("help text reflects the one-address model", () => {
  assert.match(HELP_TEXT, /anchor <domain>\s+Anchor an owned unanchored domain with the wallet address/);
  assert.match(HELP_TEXT, /balance\s+Show local wallet COG balances/);
  assert.match(HELP_TEXT, /bitcoin transfer <sats> --to <address>\s+Send plain BTC from the wallet address/i);
  assert.match(HELP_TEXT, /--satvb <n>\s+Override the mutation fee rate in sat\/vB/);
  assert.match(HELP_TEXT, /cogcoin register alpha --satvb 12\.5/);
  assert.match(HELP_TEXT, /update\s+Show the current and latest client versions and install updates/i);
  assert.match(HELP_TEXT, /mine prompt\s+Show per-domain mining prompt state/i);
  assert.match(HELP_TEXT, /mine prompt <domain>\s+Configure a per-domain mining prompt override/i);
  assert.match(HELP_TEXT, /mine prompt list\s+Alias for mine prompt/i);
  assert.match(HELP_TEXT, /client change-password\s+Rotate the client password that protects local wallet secrets/i);
  assert.match(HELP_TEXT, /init\s+Initialize a new wallet or restore an existing wallet/i);
  assert.match(HELP_TEXT, /Run `cogcoin init` to create or restore a wallet\./);
  assert.doesNotMatch(HELP_TEXT, /--from/);
  assert.doesNotMatch(HELP_TEXT, /per-identity/);
  assert.doesNotMatch(HELP_TEXT, /^\s*restore\b/m);
  assert.doesNotMatch(HELP_TEXT, /wallet restore/i);
  assert.doesNotMatch(HELP_TEXT, /wallet delete/i);
  assert.doesNotMatch(HELP_TEXT, /wallet export <path>/);
  assert.doesNotMatch(HELP_TEXT, /wallet import <path>/);
  assert.doesNotMatch(HELP_TEXT, /--seed/);
  assert.doesNotMatch(HELP_TEXT, /mine start/i);
  assert.doesNotMatch(HELP_TEXT, /mine stop/i);
  assert.doesNotMatch(HELP_TEXT, /client unlock/i);
  assert.doesNotMatch(HELP_TEXT, /client lock/i);
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

test("parser rejects removed client unlock and lock commands and keeps client change-password", () => {
  assert.throws(
    () => parseCliArgs(["client", "unlock"]),
    /cli_client_unlock_removed/,
  );
  assert.throws(
    () => parseCliArgs(["client", "lock"]),
    /cli_client_lock_removed/,
  );
  assert.equal(parseCliArgs(["client", "change-password"]).command, "client-change-password");
});

test("parser canonicalizes representative aliases and preserves invoked path metadata", () => {
  const walletInit = parseCliArgs(["wallet", "init"]);
  assert.equal(walletInit.command, "init");
  assert.equal(walletInit.commandFamily, "wallet-admin");
  assert.deepEqual(walletInit.invokedCommandTokens, ["wallet", "init"]);
  assert.equal(walletInit.invokedCommandPath, "wallet init");

  const walletAddress = parseCliArgs(["wallet", "address"]);
  assert.equal(walletAddress.command, "address");
  assert.equal(walletAddress.commandFamily, "wallet-read");
  assert.deepEqual(walletAddress.invokedCommandTokens, ["wallet", "address"]);
  assert.equal(walletAddress.invokedCommandPath, "wallet address");

  const domainShow = parseCliArgs(["domain", "show", "alpha"]);
  assert.equal(domainShow.command, "show");
  assert.equal(domainShow.commandFamily, "wallet-read");
  assert.deepEqual(domainShow.invokedCommandTokens, ["domain", "show"]);
  assert.equal(domainShow.invokedCommandPath, "domain show");

  const cogSend = parseCliArgs(["cog", "send", "10", "--to", "bc1qrecipient"]);
  assert.equal(cogSend.command, "send");
  assert.equal(cogSend.commandFamily, "wallet-mutation");
  assert.deepEqual(cogSend.invokedCommandTokens, ["cog", "send"]);
  assert.equal(cogSend.invokedCommandPath, "cog send");

  const fieldShow = parseCliArgs(["field", "show", "alpha", "bio"]);
  assert.equal(fieldShow.command, "field");
  assert.equal(fieldShow.commandFamily, "wallet-read");
  assert.deepEqual(fieldShow.invokedCommandTokens, ["field", "show"]);
  assert.equal(fieldShow.invokedCommandPath, "field show");
});

test("parser accepts update with --yes", () => {
  const parsed = parseCliArgs(["update", "--yes"]);

  assert.equal(parsed.command, "update");
  assert.equal(parsed.assumeYes, true);
});

test("parser accepts mine prompt and mine prompt list", () => {
  assert.equal(parseCliArgs(["mine", "prompt"]).command, "mine-prompt-list");
  assert.equal(parseCliArgs(["mine", "prompt", "alpha"]).command, "mine-prompt");
  assert.equal(parseCliArgs(["mine", "prompt", "list"]).command, "mine-prompt-list");
});

test("parser routes removed mining background commands through generic unknown-command handling", () => {
  assert.throws(
    () => parseCliArgs(["mine", "start"]),
    /cli_unknown_command_mine_start/,
  );
  assert.throws(
    () => parseCliArgs(["mine", "stop"]),
    /cli_unknown_command_mine_stop/,
  );
});

test("parser still routes bare field to the canonical field command before arity validation", () => {
  assert.throws(
    () => parseCliArgs(["field"]),
    /cli_missing_field_arguments/,
  );
});

test("parser accepts bitcoin transfer with --yes", () => {
  const parsed = parseCliArgs(["bitcoin", "transfer", "1200", "--to", "bc1qrecipient", "--yes"]);

  assert.equal(parsed.command, "bitcoin-transfer");
  assert.equal(parsed.args[0], "1200");
  assert.equal(parsed.transferTarget, "bc1qrecipient");
  assert.equal(parsed.assumeYes, true);
});

test("parser rejects removed wallet seed and restore surfaces", () => {
  assert.throws(
    () => parseCliArgs(["bitcoin", "transfer", "1200", "--to", "bc1qrecipient", "--seed", "spend"]),
    /cli_seed_removed/,
  );
  assert.throws(
    () => parseCliArgs(["restore"]),
    /cli_restore_removed/,
  );
  assert.throws(
    () => parseCliArgs(["wallet", "restore"]),
    /cli_wallet_restore_removed/,
  );
  assert.throws(
    () => parseCliArgs(["wallet", "delete"]),
    /cli_wallet_delete_removed/,
  );
});

test("parser accepts --satvb for wallet mutation commands", () => {
  const parsed = parseCliArgs(["register", "alpha", "--satvb", "12.5"]);

  assert.equal(parsed.command, "register");
  assert.equal(parsed.satvb, 12.5);
});

test("parser rejects invalid --satvb values", () => {
  assert.throws(
    () => parseCliArgs(["register", "alpha", "--satvb"]),
    /cli_missing_satvb/,
  );
  assert.throws(
    () => parseCliArgs(["register", "alpha", "--satvb", "0"]),
    /cli_invalid_satvb/,
  );
  assert.throws(
    () => parseCliArgs(["register", "alpha", "--satvb", "-1"]),
    /cli_invalid_satvb/,
  );
  assert.throws(
    () => parseCliArgs(["register", "alpha", "--satvb", "nope"]),
    /cli_invalid_satvb/,
  );
});

test("parser rejects --satvb for non-mutation commands", () => {
  assert.throws(
    () => parseCliArgs(["status", "--satvb", "12.5"]),
    /cli_satvb_not_supported_for_command/,
  );
  assert.throws(
    () => parseCliArgs(["bitcoin", "transfer", "1200", "--to", "bc1qrecipient", "--satvb", "12.5"]),
    /cli_satvb_not_supported_for_command/,
  );
});

test("parser rejects the removed --output flag for bitcoin transfer", () => {
  assert.throws(
    () => parseCliArgs(["bitcoin", "transfer", "1200", "--to", "bc1qrecipient", "--output", "preview-json"]),
    /cli_unknown_flag_output/,
  );
});

test("parser rejects the removed --output flag for mine prompt commands", () => {
  assert.throws(
    () => parseCliArgs(["mine", "prompt", "alpha", "--output", "preview-json"]),
    /cli_unknown_flag_output/,
  );
  assert.throws(
    () => parseCliArgs(["mine", "prompt", "list", "--output", "preview-json"]),
    /cli_unknown_flag_output/,
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

test("CLI error text explains client password setup, lock guidance, and removed unlock commands", () => {
  const setup = (formatCliTextError(new Error("wallet_client_password_setup_required")) ?? []).join("\n");
  const locked = (formatCliTextError(new Error("wallet_client_password_locked")) ?? []).join("\n");
  const changeRequiresTty = (formatCliTextError(new Error("wallet_client_password_change_requires_tty")) ?? []).join("\n");
  const unlockRemoved = (formatCliTextError(new Error("cli_client_unlock_removed")) ?? []).join("\n");
  const lockRemoved = (formatCliTextError(new Error("cli_client_lock_removed")) ?? []).join("\n");

  assert.match(setup, /client password setup/i);
  assert.match(setup, /cogcoin init/i);
  assert.match(locked, /client password is locked/i);
  assert.match(locked, /interactive terminal/i);
  assert.doesNotMatch(locked, /client unlock/i);
  assert.match(changeRequiresTty, /interactive terminal/i);
  assert.match(changeRequiresTty, /client change-password/i);
  assert.match(unlockRemoved, /client unlock/i);
  assert.match(unlockRemoved, /no longer share/i);
  assert.match(lockRemoved, /client lock/i);
  assert.match(lockRemoved, /fresh cli invocations start locked automatically/i);
});

test("CLI error text explains bitcoin transfer validation and confirmation failures", () => {
  const invalidAmount = (formatCliTextError(new Error("wallet_bitcoin_transfer_invalid_amount")) ?? []).join("\n");
  const addressRequired = (formatCliTextError(new Error("wallet_bitcoin_transfer_address_required")) ?? []).join("\n");
  const selfTransfer = (formatCliTextError(new Error("wallet_bitcoin_transfer_self_transfer")) ?? []).join("\n");
  const insufficient = (formatCliTextError(new Error("wallet_bitcoin_transfer_insufficient_funds")) ?? []).join("\n");
  const requiresTty = (formatCliTextError(new Error("wallet_bitcoin_transfer_requires_tty")) ?? []).join("\n");

  assert.match(invalidAmount, /positive whole-number satoshi amount/i);
  assert.match(addressRequired, /standard btc address/i);
  assert.match(selfTransfer, /self-transfers/i);
  assert.match(insufficient, /enough btc/i);
  assert.match(requiresTty, /interactive terminal/i);
});

test("CLI error text describes Linux local-file secret failures", () => {
  const formatted = formatCliTextError(new Error("wallet_secret_provider_linux_runtime_error")) ?? [];
  const rendered = formatted.join("\n");

  assert.match(rendered, /Linux local wallet-secret access failed/);
  assert.match(rendered, /state directory/i);
});

test("CLI error text explains sat/vB parsing and command support", () => {
  const missing = (formatCliTextError(new Error("cli_missing_satvb")) ?? []).join("\n");
  const invalid = (formatCliTextError(new Error("cli_invalid_satvb")) ?? []).join("\n");
  const unsupported = (formatCliTextError(new Error("cli_satvb_not_supported_for_command")) ?? []).join("\n");

  assert.match(missing, /--satvb/);
  assert.match(missing, /sat\/vB/i);
  assert.match(invalid, /positive finite decimal number/i);
  assert.match(unsupported, /does not support `--satvb`/i);
  assert.match(unsupported, /register|send/i);
});

test("CLI lock errors recommend cogcoin repair to reset the local lock state", () => {
  const walletControl = (formatCliTextError(new Error("wallet_control_lock_busy")) ?? []).join("\n");
  const miningLock = (formatCliTextError(
    new FileLockBusyError(
      "/Users/example/Library/Application Support/Cogcoin/runtime/mining-control.lock",
      { processId: 1234, acquiredAtUnixMs: Date.now(), purpose: "mining", walletRootId: null },
    ),
  ) ?? []).join("\n");
  const genericLock = (formatCliTextError(new Error("file_lock_busy_/tmp/example.lock")) ?? []).join("\n");

  assert.match(walletControl, /Next: Run `cogcoin repair` to reset the local lock state, then retry\./);
  assert.match(miningLock, /What happened: Lock file is busy: .*mining-control\.lock \(purpose: mining\)\./);
  assert.match(miningLock, /Next: Run `cogcoin repair` to reset the local lock state, then retry\./);
  assert.match(genericLock, /Next: Run `cogcoin repair` to reset the local lock state, then retry\./);
});
