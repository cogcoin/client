import assert from "node:assert/strict";
import test from "node:test";

import {
  isMineableWalletDomain,
  resolveMineableWalletDomain,
} from "../src/wallet/read/index.js";
import {
  createWalletReadContext,
  createWalletState,
} from "./current-model-helpers.js";

const WALLET_SCRIPT = "0014" + "11".repeat(20);
const EXTERNAL_SCRIPT = "0014" + "22".repeat(20);

function scriptBytes(scriptPubKeyHex: string): Buffer {
  return Buffer.from(scriptPubKeyHex, "hex");
}

function createMineabilityContext(options: {
  name?: string;
  domainId?: number | null;
  anchored?: boolean;
  readOnly?: boolean;
  ownerScriptPubKeyHex?: string;
  delegateScriptPubKeyHex?: string | null;
  minerScriptPubKeyHex?: string | null;
  walletAddress?: string | null;
  snapshot?: "present" | "missing";
}) {
  const name = options.name ?? "alpha";
  const domainId = "domainId" in options ? options.domainId! : 7;
  const walletAddress = "walletAddress" in options ? options.walletAddress! : "bc1qfunding";
  const state = createWalletState({
    funding: {
      address: walletAddress ?? "bc1qfunding",
      scriptPubKeyHex: WALLET_SCRIPT,
    },
  });
  const ownerScriptPubKeyHex = options.ownerScriptPubKeyHex ?? WALLET_SCRIPT;
  const domain = {
    name,
    domainId,
    anchored: options.anchored ?? true,
    readOnly: options.readOnly ?? false,
    localRelationship: ownerScriptPubKeyHex === WALLET_SCRIPT ? "local" : "external",
    ownerAddress: ownerScriptPubKeyHex === WALLET_SCRIPT ? walletAddress : null,
    ownerScriptPubKeyHex,
    localTracked: false,
    localRecord: null,
    chainFound: true,
    chainStatus: (options.anchored ?? true) ? "anchored" : "registered-unanchored",
    foundingMessageText: null,
    endpointText: null,
    delegateScriptPubKeyHex: options.delegateScriptPubKeyHex ?? null,
    minerScriptPubKeyHex: options.minerScriptPubKeyHex ?? null,
    fieldCount: 0,
    listingPriceCogtoshi: null,
    activeLockCount: 0,
    selfStakeCogtoshi: null,
    supportedStakeCogtoshi: null,
    totalSupportedCogtoshi: null,
    totalRevokedCogtoshi: null,
  };

  return createWalletReadContext({
    localState: {
      availability: "ready",
      clientPasswordReadiness: "ready",
      unlockRequired: false,
      walletRootId: state.walletRootId,
      state,
      source: "primary",
      hasPrimaryStateFile: true,
      hasBackupStateFile: false,
      message: null,
    },
    model: {
      walletRootId: state.walletRootId,
      walletAddress,
      walletScriptPubKeyHex: WALLET_SCRIPT,
      domains: [domain],
    },
    snapshot: options.snapshot === "missing"
      ? null
      : {
        state: {
          consensus: {
            domainIdsByName: domainId === null ? new Map() : new Map([[name, domainId]]),
            domainsById: domainId === null ? new Map() : new Map([[domainId, {
              domainId,
              name,
              anchored: options.anchored ?? true,
              anchorHeight: 100,
              ownerScriptPubKey: scriptBytes(ownerScriptPubKeyHex),
              endpoint: null,
              delegate: options.delegateScriptPubKeyHex === undefined || options.delegateScriptPubKeyHex === null
                ? null
                : scriptBytes(options.delegateScriptPubKeyHex),
              miner: options.minerScriptPubKeyHex === undefined || options.minerScriptPubKeyHex === null
                ? null
                : scriptBytes(options.minerScriptPubKeyHex),
            }]]),
            balances: new Map(),
          },
          history: {
            foundingMessageByDomain: new Map(),
            blockWinnersByHeight: new Map(),
          },
        },
      },
  }) as any;
}

test("mineable wallet domain resolution accepts owner, delegate, and designated miner authorization", () => {
  for (const context of [
    createMineabilityContext({ ownerScriptPubKeyHex: WALLET_SCRIPT }),
    createMineabilityContext({ ownerScriptPubKeyHex: EXTERNAL_SCRIPT, delegateScriptPubKeyHex: WALLET_SCRIPT }),
    createMineabilityContext({ ownerScriptPubKeyHex: EXTERNAL_SCRIPT, minerScriptPubKeyHex: WALLET_SCRIPT }),
  ]) {
    const domain = context.model.domains[0];
    const resolution = resolveMineableWalletDomain(context, domain);

    assert.equal(isMineableWalletDomain(context, domain), true);
    assert.equal(resolution?.domainId, 7);
    assert.equal(resolution?.domainName, "alpha");
    assert.deepEqual(resolution?.sender, {
      localIndex: 0,
      scriptPubKeyHex: WALLET_SCRIPT,
      address: "bc1qfunding",
    });
  }
});

test("mineable wallet domain resolution rejects non-confirmed or unauthorized domains", () => {
  const rejected = [
    createMineabilityContext({ ownerScriptPubKeyHex: EXTERNAL_SCRIPT }),
    createMineabilityContext({ anchored: false }),
    createMineabilityContext({ name: "alpha-beta" }),
    createMineabilityContext({ readOnly: true }),
    createMineabilityContext({ domainId: null }),
    createMineabilityContext({ snapshot: "missing" }),
    createMineabilityContext({ walletAddress: null }),
  ];

  for (const context of rejected) {
    const domain = context.model.domains[0];
    assert.equal(resolveMineableWalletDomain(context, domain), null);
    assert.equal(isMineableWalletDomain(context, domain), false);
  }
});
