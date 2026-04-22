import test from "node:test";
import assert from "node:assert/strict";

import { normalizeListPage } from "../src/cli/pagination.js";
import {
  getClientUnlockRecommendation,
  getMutationRecommendation,
  getRepairRecommendation,
} from "../src/cli/recommendations.js";
import {
  listVisibleDomainFields,
  listVisibleWalletLocks,
} from "../src/cli/wallet-read-helpers.js";
import { createWalletReadContext } from "./current-model-helpers.js";

const WALLET_SCRIPT_PUB_KEY_HEX = `0014${"11".repeat(20)}`;
const EXTERNAL_SCRIPT_PUB_KEY_HEX = `0014${"22".repeat(20)}`;

function hexBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "hex"));
}

test("normalizeListPage preserves the existing truncation and count semantics", () => {
  const normalized = normalizeListPage([1, 2, 3], {
    limit: 2,
    all: false,
    defaultLimit: 50,
  });

  assert.deepEqual(normalized.items, [1, 2]);
  assert.deepEqual(normalized.page, {
    limit: 2,
    returned: 2,
    truncated: true,
    moreAvailable: true,
    totalKnown: 3,
  });
});

test("listVisibleWalletLocks keeps claimable and reclaimable filtering behavior", () => {
  const context = {
    snapshot: {
      state: {
        history: {
          currentHeight: 100,
        },
        consensus: {
          locks: new Map([
            [7, {
              lockId: 7,
              amount: 50n,
              timeoutHeight: 120,
              lockerScriptPubKey: hexBytes(WALLET_SCRIPT_PUB_KEY_HEX),
              recipientDomainId: 1,
            }],
            [8, {
              lockId: 8,
              amount: 75n,
              timeoutHeight: 90,
              lockerScriptPubKey: hexBytes(WALLET_SCRIPT_PUB_KEY_HEX),
              recipientDomainId: 1,
            }],
          ]),
          domainsById: new Map([
            [1, {
              ownerScriptPubKey: hexBytes(WALLET_SCRIPT_PUB_KEY_HEX),
            }],
          ]),
        },
      },
    },
    model: {
      walletScriptPubKeyHex: WALLET_SCRIPT_PUB_KEY_HEX,
      domains: [
        { domainId: 1, name: "alpha" },
      ],
    },
  } as any;

  assert.deepEqual(
    listVisibleWalletLocks(context, {
      claimableOnly: true,
      reclaimableOnly: false,
    })?.map((lock) => lock.lockId),
    [7],
  );
  assert.deepEqual(
    listVisibleWalletLocks(context, {
      claimableOnly: false,
      reclaimableOnly: true,
    })?.map((lock) => lock.lockId),
    [8],
  );
});

test("listVisibleDomainFields preserves existing field enumeration and previews", () => {
  const context = {
    snapshot: {
      state: {
        consensus: {
          domainIdsByName: new Map([["alpha", 1]]),
          domainsById: new Map([
            [1, {
              domainId: 1,
              name: "alpha",
              anchored: true,
              anchorHeight: 99,
              endpoint: null,
            }],
          ]),
          fields: new Map([
            [3, {
              domainId: 1,
              fieldId: 3,
              name: "bio",
              permanent: false,
            }],
          ]),
          fieldIdsByName: new Map([["1:bio", 3]]),
          domainData: new Map([
            ["1:3", {
              format: 0x02,
              value: Buffer.from("hello", "utf8"),
            }],
          ]),
        },
        history: {
          foundingMessageByDomain: new Map(),
        },
      },
    },
  } as any;

  assert.deepEqual(listVisibleDomainFields(context, "alpha"), [
    {
      domainName: "alpha",
      domainId: 1,
      fieldId: 3,
      name: "bio",
      permanent: false,
      hasValue: true,
      format: 0x02,
      preview: "hello",
      rawValueHex: Buffer.from("hello", "utf8").toString("hex"),
    },
  ]);
});

test("recommendation helpers preserve repair, unlock, and mutation guidance", () => {
  const repairContext = createWalletReadContext({
    localState: {
      availability: "ready",
      clientPasswordReadiness: "migration-required",
      unlockRequired: false,
      walletRootId: "wallet-root",
      state: createWalletReadContext().localState.state,
      source: "primary",
      hasPrimaryStateFile: true,
      hasBackupStateFile: false,
      message: null,
    },
  });
  assert.equal(
    getRepairRecommendation(repairContext),
    "Run `cogcoin init` to configure the client password and migrate local wallet secrets.",
  );

  const unlockContext = createWalletReadContext({
    localState: {
      ...createWalletReadContext().localState,
      unlockRequired: true,
    },
  });
  assert.equal(
    getClientUnlockRecommendation(unlockContext),
    "Rerun this command in an interactive terminal so Cogcoin can prompt for the client password.",
  );

  const mutationContext = createWalletReadContext({
    localState: {
      ...createWalletReadContext().localState,
      state: {
        ...createWalletReadContext().localState.state,
        pendingMutations: [{
          mutationId: "pending",
          kind: "transfer",
          domainName: "alpha",
          parentDomainName: null,
          senderLocalIndex: 0,
          senderScriptPubKeyHex: WALLET_SCRIPT_PUB_KEY_HEX,
          intentFingerprintHex: "aa".repeat(32),
          status: "broadcast-unknown",
          createdAtUnixMs: 1,
          lastUpdatedAtUnixMs: 2,
          attemptedTxid: null,
          attemptedWtxid: null,
          temporaryBuilderLockedOutpoints: [],
        }],
      },
    },
  });
  assert.equal(
    getMutationRecommendation(mutationContext),
    "Rerun `cogcoin transfer alpha` with the same target to reconcile the pending transfer, or run `cogcoin repair` if it remains unresolved.",
  );
});

test("lock helper ignores external lockers and future domain owners stay local-only", () => {
  const context = {
    snapshot: {
      state: {
        history: {
          currentHeight: 100,
        },
        consensus: {
          locks: new Map([
            [9, {
              lockId: 9,
              amount: 12n,
              timeoutHeight: 101,
              lockerScriptPubKey: hexBytes(EXTERNAL_SCRIPT_PUB_KEY_HEX),
              recipientDomainId: 1,
            }],
          ]),
          domainsById: new Map([
            [1, {
              ownerScriptPubKey: hexBytes(EXTERNAL_SCRIPT_PUB_KEY_HEX),
            }],
          ]),
        },
      },
    },
    model: {
      walletScriptPubKeyHex: WALLET_SCRIPT_PUB_KEY_HEX,
      domains: [
        { domainId: 1, name: "alpha" },
      ],
    },
  } as any;

  assert.deepEqual(
    listVisibleWalletLocks(context, {
      claimableOnly: false,
      reclaimableOnly: false,
    })?.map((lock) => lock.lockId),
    [9],
  );
  assert.equal(
    listVisibleWalletLocks(context, {
      claimableOnly: true,
      reclaimableOnly: false,
    })?.length,
    0,
  );
});
