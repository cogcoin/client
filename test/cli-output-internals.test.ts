import assert from "node:assert/strict";
import test from "node:test";

import { FileLockBusyError } from "../src/wallet/fs/lock.js";
import {
  classifyCliError,
  isBlockedError,
} from "../src/cli/output/classify.js";
import { createCliErrorPresentation } from "../src/cli/output/rules/index.js";

test("classifyCliError preserves blocked and destructive exit-code behavior", () => {
  assert.deepEqual(classifyCliError(new Error("wallet_client_password_locked")), {
    exitCode: 4,
    errorCode: "wallet_client_password_locked",
    message: "wallet_client_password_locked",
  });

  assert.deepEqual(classifyCliError(new Error("reset_secret_cleanup_failed")), {
    exitCode: 5,
    errorCode: "reset_secret_cleanup_failed",
    message: "reset_secret_cleanup_failed",
  });
});

test("isBlockedError still recognizes lock and service gating errors", () => {
  assert.equal(isBlockedError("wallet_control_lock_busy"), true);
  assert.equal(isBlockedError("indexer_daemon_schema_mismatch"), true);
  assert.equal(isBlockedError("wallet_buy_insufficient_cog_balance"), true);
  assert.equal(isBlockedError("cli_wallet_export_removed"), false);
});

test("createCliErrorPresentation preserves specific rule precedence ahead of generic fallback", () => {
  const legacyEnvelope = createCliErrorPresentation(
    "wallet_state_legacy_envelope_unsupported",
    "wallet_state_legacy_envelope_unsupported",
  );
  assert.deepEqual(legacyEnvelope, {
    what: "Legacy wallet state is no longer supported.",
    why: "This wallet state was created by an older Cogcoin format that this version no longer loads directly.",
    next: "Restore or otherwise recover the wallet into the current format, then retry the command.",
  });

  const busyLock = createCliErrorPresentation(
    "file_lock_busy_/tmp/example.wallet-control.lock",
    "file_lock_busy_/tmp/example.wallet-control.lock",
    new FileLockBusyError("/tmp/example.wallet-control.lock", {
      processId: 123,
      acquiredAtUnixMs: 1,
      purpose: "sync",
      walletRootId: "wallet-root",
    }),
  );
  assert.deepEqual(busyLock, {
    what: "Wallet control lock is busy (purpose: sync).",
    why: "Another Cogcoin command currently holds the exclusive wallet control lock for this wallet.",
    next: "Run `cogcoin repair` to reset the local lock state, then retry.",
  });
});

test("representative rule modules still produce the expected presentation text", () => {
  const surface = createCliErrorPresentation("cli_wallet_export_removed", "cli_wallet_export_removed");
  const wallet = createCliErrorPresentation("wallet_client_password_locked", "wallet_client_password_locked");
  const services = createCliErrorPresentation("managed_bitcoind_runtime_mismatch", "managed_bitcoind_runtime_mismatch");
  const mutation = createCliErrorPresentation("wallet_transfer_owner_not_locally_controlled", "wallet_transfer_owner_not_locally_controlled");
  const update = createCliErrorPresentation("cli_update_npm_not_found", "cli_update_npm_not_found");

  assert.equal(surface?.what, "`wallet export` is no longer available.");
  assert.equal(wallet?.what, "Client password is locked.");
  assert.equal(services?.what, "The live managed bitcoind service runtime does not match this wallet.");
  assert.equal(mutation?.what, "Domain owner is not locally controlled.");
  assert.equal(update?.what, "Cogcoin could not find npm to install the update.");
});
