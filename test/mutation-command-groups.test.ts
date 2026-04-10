import assert from "node:assert/strict";
import test from "node:test";

import {
  isAnchorMutationCommand,
  isBuyMutationCommand,
  isClaimMutationCommand,
  isReclaimMutationCommand,
  isRegisterMutationCommand,
  isReputationMutationCommand,
  isSellMutationCommand,
  isSellOrUnsellMutationCommand,
  isSendMutationCommand,
  isTransferMutationCommand,
  isUnsellMutationCommand,
  isWalletMutationCommand,
  walletMutationCommands,
} from "../src/cli/mutation-command-groups.js";

test("isWalletMutationCommand accepts the supported mutation command set and rejects non-mutations", () => {
  for (const command of walletMutationCommands) {
    assert.equal(isWalletMutationCommand(command), true, command);
  }

  assert.equal(isWalletMutationCommand("status"), false);
  assert.equal(isWalletMutationCommand("wallet-status"), false);
  assert.equal(isWalletMutationCommand(null), false);
});

test("mutation alias helpers group the expected command pairs without bleeding into neighbors", () => {
  assert.equal(isAnchorMutationCommand("anchor"), true);
  assert.equal(isAnchorMutationCommand("domain-anchor"), true);
  assert.equal(isAnchorMutationCommand("register"), false);

  assert.equal(isRegisterMutationCommand("register"), true);
  assert.equal(isRegisterMutationCommand("domain-register"), true);
  assert.equal(isRegisterMutationCommand("domain-anchor"), false);

  assert.equal(isTransferMutationCommand("transfer"), true);
  assert.equal(isTransferMutationCommand("domain-transfer"), true);
  assert.equal(isTransferMutationCommand("buy"), false);

  assert.equal(isSellMutationCommand("sell"), true);
  assert.equal(isSellMutationCommand("domain-sell"), true);
  assert.equal(isSellMutationCommand("unsell"), false);

  assert.equal(isUnsellMutationCommand("unsell"), true);
  assert.equal(isUnsellMutationCommand("domain-unsell"), true);
  assert.equal(isUnsellMutationCommand("sell"), false);
  assert.equal(isSellOrUnsellMutationCommand("domain-sell"), true);
  assert.equal(isSellOrUnsellMutationCommand("domain-unsell"), true);
  assert.equal(isSellOrUnsellMutationCommand("domain-buy"), false);

  assert.equal(isBuyMutationCommand("buy"), true);
  assert.equal(isBuyMutationCommand("domain-buy"), true);
  assert.equal(isBuyMutationCommand("transfer"), false);

  assert.equal(isSendMutationCommand("send"), true);
  assert.equal(isSendMutationCommand("cog-send"), true);
  assert.equal(isSendMutationCommand("claim"), false);

  assert.equal(isClaimMutationCommand("claim"), true);
  assert.equal(isClaimMutationCommand("cog-claim"), true);
  assert.equal(isClaimMutationCommand("reclaim"), false);

  assert.equal(isReclaimMutationCommand("reclaim"), true);
  assert.equal(isReclaimMutationCommand("cog-reclaim"), true);
  assert.equal(isReclaimMutationCommand("claim"), false);

  assert.equal(isReputationMutationCommand("rep-give"), true);
  assert.equal(isReputationMutationCommand("rep-revoke"), true);
  assert.equal(isReputationMutationCommand("field-set"), false);
});
