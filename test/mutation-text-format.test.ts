import assert from "node:assert/strict";
import test from "node:test";

import {
  formatBuyBuyerSummary,
  formatBuySellerSummary,
  formatBuySettlementSummary,
  formatCogClaimPath,
  formatCogSenderSummary,
  formatDomainAdminEffect,
  formatDomainAdminPayloadSummary,
  formatDomainAdminSenderSummary,
  formatDomainAdminTargetSummary,
  formatDomainMarketEconomicEffect,
  formatDomainMarketRecipientSummary,
  formatDomainMarketSenderSummary,
  formatFieldEffect,
  formatFieldPath,
  formatFieldSenderSummary,
  formatFieldValueSummary,
  formatRegisterEconomicEffect,
  formatRegisterSenderSummary,
  formatReputationEffect,
  formatReputationReviewSummary,
  formatReputationSenderSummary,
} from "../src/cli/mutation-text-format.js";

test("mutation text formatters preserve register and domain-market wording", () => {
  const registerResult = {
    resolved: {
      sender: {
        selector: "id:1",
        address: "bc1qalphaowner0000000000000000000000000000",
      },
      economicEffect: {
        kind: "treasury-payment" as const,
        amount: 100000n,
      },
    },
  } as Parameters<typeof formatRegisterSenderSummary>[0];

  assert.equal(
    formatRegisterSenderSummary(registerResult),
    "id:1 (bc1qalphaowner0000000000000000000000000000)",
  );
  assert.equal(
    formatRegisterEconomicEffect(registerResult),
    "send 100000 sats to the Cogcoin treasury",
  );

  const transferResult = {
    recipientScriptPubKeyHex: "00141111111111111111111111111111111111111111",
    resolved: {
      sender: {
        selector: "id:1",
        address: "bc1qalphaowner0000000000000000000000000000",
      },
      recipient: {
        scriptPubKeyHex: "00141111111111111111111111111111111111111111",
        address: "bc1qrecipient00000000000000000000000000000",
      },
      economicEffect: {
        kind: "ownership-transfer" as const,
        clearsListing: true,
      },
    },
  } as Parameters<typeof formatDomainMarketSenderSummary>[0];

  assert.equal(
    formatDomainMarketSenderSummary(transferResult),
    "id:1 (bc1qalphaowner0000000000000000000000000000)",
  );
  assert.equal(
    formatDomainMarketRecipientSummary(transferResult),
    "bc1qrecipient00000000000000000000000000000",
  );
  assert.equal(
    formatDomainMarketEconomicEffect(transferResult),
    "transfer domain ownership and clear any active listing",
  );

  const buyResult = {
    resolvedBuyer: {
      selector: "id:1",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    resolvedSeller: {
      scriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
      address: "bc1qseller0000000000000000000000000000000",
    },
  } as Parameters<typeof formatBuyBuyerSummary>[0];

  assert.equal(
    formatBuyBuyerSummary(buyResult),
    "id:1 (bc1qalphaowner0000000000000000000000000000)",
  );
  assert.equal(
    formatBuySellerSummary(buyResult),
    "bc1qseller0000000000000000000000000000000",
  );
  assert.equal(
    formatBuySettlementSummary(),
    "entirely in COG state; no BTC seller output",
  );
});

test("mutation text formatters preserve domain-admin, field, cog, and reputation wording", () => {
  const domainAdminResult = {
    endpointValueHex: "00",
    recipientScriptPubKeyHex: "00141111111111111111111111111111111111111111",
    resolved: {
      sender: {
        selector: "id:1",
        address: "bc1qalphaowner0000000000000000000000000000",
      },
      target: {
        scriptPubKeyHex: "00141111111111111111111111111111111111111111",
        address: "bc1qdelegate0000000000000000000000000000",
      },
      effect: {
        kind: "endpoint-set" as const,
        byteLength: 1,
      },
    },
  } as Parameters<typeof formatDomainAdminSenderSummary>[0];

  assert.equal(
    formatDomainAdminSenderSummary(domainAdminResult),
    "id:1 (bc1qalphaowner0000000000000000000000000000)",
  );
  assert.equal(
    formatDomainAdminTargetSummary(domainAdminResult),
    "bc1qdelegate0000000000000000000000000000",
  );
  assert.equal(
    formatDomainAdminEffect(domainAdminResult),
    "set the endpoint payload to 1 bytes",
  );
  assert.equal(
    formatDomainAdminPayloadSummary(domainAdminResult),
    "1 bytes",
  );

  const fieldResult = {
    resolved: {
      sender: {
        selector: "id:1",
        address: "bc1qalphaowner0000000000000000000000000000",
      },
      path: "field-reg-plus-data-update-family",
      value: {
        format: 1,
        byteLength: 5,
      },
      effect: {
        kind: "create-and-initialize-field" as const,
        tx1BurnCogtoshi: "100",
        tx2AdditionalBurnCogtoshi: "1",
      },
    },
  } as Parameters<typeof formatFieldSenderSummary>[0];

  assert.equal(
    formatFieldSenderSummary(fieldResult),
    "id:1 (bc1qalphaowner0000000000000000000000000000)",
  );
  assert.equal(
    formatFieldPath(fieldResult),
    "field-reg-plus-data-update-family",
  );
  assert.equal(
    formatFieldValueSummary(fieldResult),
    "format 1, 5 bytes",
  );
  assert.equal(
    formatFieldEffect(fieldResult),
    "burn 100 cogtoshi in Tx1 and 1 additional cogtoshi in Tx2",
  );

  const claimResult = {
    resolved: {
      sender: {
        selector: "id:1",
        address: "bc1qalphaowner0000000000000000000000000000",
      },
      claimPath: "recipient-claim",
    },
  } as Parameters<typeof formatCogSenderSummary>[0];

  assert.equal(
    formatCogSenderSummary(claimResult),
    "id:1 (bc1qalphaowner0000000000000000000000000000)",
  );
  assert.equal(
    formatCogClaimPath(claimResult),
    "recipient-claim",
  );

  const reputationResult = {
    reviewIncluded: true,
    resolved: {
      sender: {
        selector: "id:1",
        address: "bc1qalphaowner0000000000000000000000000000",
      },
      effect: {
        kind: "give-support" as const,
        burnCogtoshi: "250",
      },
      review: {
        included: true,
        byteLength: 12,
      },
    },
  } as Parameters<typeof formatReputationSenderSummary>[0];

  assert.equal(
    formatReputationSenderSummary(reputationResult),
    "id:1 (bc1qalphaowner0000000000000000000000000000)",
  );
  assert.equal(
    formatReputationReviewSummary(reputationResult),
    "included (12 bytes)",
  );
  assert.equal(
    formatReputationEffect(reputationResult),
    "burn 250 cogtoshi to publish support",
  );
});
