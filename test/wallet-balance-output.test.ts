import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createInitialState, loadBundledGenesisParameters } from "@cogcoin/indexer";

import { formatBalanceReport } from "../src/cli/wallet-format.js";
import { getFundingQuickstartGuidance } from "../src/cli/workflow-hints.js";
import { createWalletReadModel } from "../src/wallet/read/project.js";
import type { WalletSnapshotView } from "../src/wallet/read/index.js";
import type { PendingMutationRecord, WalletStateV1 } from "../src/wallet/types.js";
import { createWalletReadContext, createWalletState } from "./current-model-helpers.js";

const BALANCE_ART_TEMPLATE = readFileSync(new URL("../src/art/balance.txt", import.meta.url), "utf8")
  .replaceAll("\r\n", "\n")
  .trimEnd()
  .split("\n");

let readySnapshotPromise: Promise<WalletSnapshotView> | null = null;

function createLocalDomain(overrides: Partial<WalletStateV1["domains"][number]> = {}): WalletStateV1["domains"][number] {
  return {
    name: "alpha",
    domainId: 1,
    currentOwnerScriptPubKeyHex: "0014" + "11".repeat(20),
    canonicalChainStatus: "registered-unanchored",
    currentCanonicalAnchorOutpoint: null,
    foundingMessageText: null,
    birthTime: null,
    ...overrides,
  };
}

function createPendingMutation(overrides: Partial<PendingMutationRecord> = {}): PendingMutationRecord {
  return {
    mutationId: "mutation-1",
    kind: "send",
    domainName: "",
    parentDomainName: null,
    senderScriptPubKeyHex: "0014" + "11".repeat(20),
    senderLocalIndex: 0,
    intentFingerprintHex: "11".repeat(32),
    status: "broadcasting",
    createdAtUnixMs: 1,
    lastUpdatedAtUnixMs: 1,
    attemptedTxid: null,
    attemptedWtxid: null,
    temporaryBuilderLockedOutpoints: [],
    amountCogtoshi: 123n,
    ...overrides,
  };
}

async function createReadySnapshot(): Promise<WalletSnapshotView> {
  if (readySnapshotPromise === null) {
    readySnapshotPromise = loadBundledGenesisParameters().then((genesis) => ({
      state: createInitialState(genesis),
      tip: null,
    }));
  }

  return readySnapshotPromise;
}

async function createReadyBalanceContext(options: {
  stateOverrides?: Partial<WalletStateV1>;
  fundingSpendableSats?: bigint | null;
} = {}) {
  const state = createWalletState(options.stateOverrides);
  const snapshot = await createReadySnapshot();

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
    snapshot,
    model: createWalletReadModel(state, snapshot),
    fundingSpendableSats: "fundingSpendableSats" in options
      ? (options.fundingSpendableSats ?? null)
      : 123_456_789n,
  });
}

function assertSingleSpaceValue(line: string, label: string, value: string): void {
  const labelIndex = line.indexOf(label);
  assert.notEqual(labelIndex, -1, `missing label: ${label}`);

  const spaceIndex = labelIndex + label.length;
  assert.equal(line[spaceIndex], " ");
  assert.equal(line.slice(spaceIndex + 1, spaceIndex + 1 + value.length), value);
}

test("balance ready-state text renders the 80-column balance card", async () => {
  const context = await createReadyBalanceContext();
  const rendered = formatBalanceReport(context);
  const lines = rendered.split("\n");

  assert.ok(rendered.startsWith(`\n${BALANCE_ART_TEMPLATE[0]}\n${BALANCE_ART_TEMPLATE[1]}\n${BALANCE_ART_TEMPLATE[2]}\n`));
  assert.equal(lines[0], "");
  assert.equal(lines[1], BALANCE_ART_TEMPLATE[0]);
  assert.equal(lines[2], BALANCE_ART_TEMPLATE[1]);
  assert.equal(lines[3], BALANCE_ART_TEMPLATE[2]);
  assert.equal(lines[5], BALANCE_ART_TEMPLATE[4]);
  assert.equal(lines[8], BALANCE_ART_TEMPLATE[7]);
  assert.equal(lines[10], BALANCE_ART_TEMPLATE[9]);
  assert.equal(lines[11], "");
  assert.equal(lines[12], "Anchored Domains");
  assert.equal(lines[13], "--- No anchored domains ---");
  assert.equal(lines[14], "");
  assert.equal(lines[15], "Unanchored Domains");
  assert.equal(lines[16], "--- No unanchored domains ---");
  assert.equal(lines[17], "");
  assert.equal(lines[18], "Next step: Buy a 6+ character root domain with `cogcoin register <root>`.");

  for (const [index, line] of BALANCE_ART_TEMPLATE.entries()) {
    const renderedLine = lines[index + 1]!;
    assert.equal(renderedLine.length, 80, `line ${index + 2} width`);
    assert.equal(renderedLine[renderedLine.length - 1], line[line.length - 1]);
  }

  assertSingleSpaceValue(lines[4]!, "Funding address:", "bc1qfunding");
  assertSingleSpaceValue(lines[6]!, "Bitcoin Balance:", "1.23456789 BTC");
  assertSingleSpaceValue(lines[7]!, "Cogcoin Balance:", "0.00000000 COG");

  const urlLabel = "mempool.space/address/";
  const urlLabelIndex = lines[9]!.indexOf(urlLabel);
  assert.notEqual(urlLabelIndex, -1);
  assert.equal(
    lines[9]!.slice(urlLabelIndex + urlLabel.length, urlLabelIndex + urlLabel.length + "bc1qfunding".length),
    "bc1qfunding",
  );
});

test("balance ready-state text clips long inserted values inside the art frame", async () => {
  const longAddress = `bc1q${"z".repeat(80)}`;
  const context = await createReadyBalanceContext({
    stateOverrides: {
      funding: {
        address: longAddress,
        scriptPubKeyHex: "0014" + "11".repeat(20),
      },
      managedCoreWallet: {
        ...createWalletState().managedCoreWallet,
        walletAddress: longAddress,
        walletScriptPubKeyHex: "0014" + "11".repeat(20),
      },
    },
  });
  const lines = formatBalanceReport(context).split("\n");

  assert.equal(lines[0], "");
  assert.equal(lines[11], "");

  for (const [index, line] of BALANCE_ART_TEMPLATE.entries()) {
    const renderedLine = lines[index + 1]!;
    assert.equal(renderedLine.length, 80, `line ${index + 2} width`);
    assert.equal(renderedLine[renderedLine.length - 1], line[line.length - 1]);
  }

  assert.ok(lines[4]!.includes("Funding address: "));
  assert.ok(lines[9]!.includes("mempool.space/address/"));
});

test("balance ready-state text lists anchored and unanchored domains in separate sections", async () => {
  const context = await createReadyBalanceContext({
    stateOverrides: {
      domains: [
        createLocalDomain({
          name: "mitdog",
          canonicalChainStatus: "registered-unanchored",
        }),
        createLocalDomain({
          name: "mitsnake",
          domainId: 2,
          canonicalChainStatus: "anchored",
          currentCanonicalAnchorOutpoint: { txid: "11".repeat(32), vout: 0, valueSats: 2_000 },
        }),
        createLocalDomain({
          name: "mitcat",
          domainId: 3,
          canonicalChainStatus: "anchored",
          currentCanonicalAnchorOutpoint: { txid: "22".repeat(32), vout: 1, valueSats: 2_000 },
        }),
      ],
    },
  });
  const lines = formatBalanceReport(context).split("\n");

  assert.deepEqual(
    lines.slice(12, 17),
    [
      "Anchored Domains",
      "⌂ mitcat, ⌂ mitsnake",
      "",
      "Unanchored Domains",
      "~ mitdog",
    ],
  );
});

test("balance ready-state text wraps anchored and unanchored domain lists to 80 columns", async () => {
  const context = await createReadyBalanceContext({
    stateOverrides: {
      domains: [
        createLocalDomain({
          name: "mitanchoredcat",
          canonicalChainStatus: "anchored",
          currentCanonicalAnchorOutpoint: { txid: "11".repeat(32), vout: 0, valueSats: 2_000 },
        }),
        createLocalDomain({
          name: "mitanchoreddog",
          domainId: 2,
          canonicalChainStatus: "anchored",
          currentCanonicalAnchorOutpoint: { txid: "22".repeat(32), vout: 1, valueSats: 2_000 },
        }),
        createLocalDomain({
          name: "mitanchoredfrog",
          domainId: 3,
          canonicalChainStatus: "anchored",
          currentCanonicalAnchorOutpoint: { txid: "33".repeat(32), vout: 2, valueSats: 2_000 },
        }),
        createLocalDomain({
          name: "mitanchoredgoat",
          domainId: 4,
          canonicalChainStatus: "anchored",
          currentCanonicalAnchorOutpoint: { txid: "44".repeat(32), vout: 3, valueSats: 2_000 },
        }),
        createLocalDomain({
          name: "mitanchoredlion",
          domainId: 5,
          canonicalChainStatus: "anchored",
          currentCanonicalAnchorOutpoint: { txid: "55".repeat(32), vout: 4, valueSats: 2_000 },
        }),
        createLocalDomain({
          name: "mitunanchoredalpha",
          domainId: 6,
          canonicalChainStatus: "registered-unanchored",
        }),
        createLocalDomain({
          name: "mitunanchoredbeta",
          domainId: 7,
          canonicalChainStatus: "registered-unanchored",
        }),
        createLocalDomain({
          name: "mitunanchoredgamma",
          domainId: 8,
          canonicalChainStatus: "registered-unanchored",
        }),
        createLocalDomain({
          name: "mitunanchoreddelta",
          domainId: 9,
          canonicalChainStatus: "registered-unanchored",
        }),
        createLocalDomain({
          name: "mitunanchoredepsilon",
          domainId: 10,
          canonicalChainStatus: "registered-unanchored",
        }),
        createLocalDomain({
          name: "mitunanchoredzeta",
          domainId: 11,
          canonicalChainStatus: "registered-unanchored",
        }),
      ],
    },
  });
  const lines = formatBalanceReport(context).split("\n");
  const anchoredHeaderIndex = lines.indexOf("Anchored Domains");
  const unanchoredHeaderIndex = lines.indexOf("Unanchored Domains");

  assert.notEqual(anchoredHeaderIndex, -1);
  assert.notEqual(unanchoredHeaderIndex, -1);

  const anchoredLines = lines.slice(anchoredHeaderIndex + 1, unanchoredHeaderIndex - 1);
  assert.ok(anchoredLines.length > 1);

  for (const line of anchoredLines) {
    assert.ok(line.startsWith("⌂ "));
    assert.ok(line.length <= 80);
  }

  const unanchoredLines: string[] = [];
  for (const line of lines.slice(unanchoredHeaderIndex + 1)) {
    if (!line.startsWith("~ ")) {
      break;
    }
    unanchoredLines.push(line);
    assert.ok(line.length <= 80);
  }
  assert.ok(unanchoredLines.length > 1);

  assert.ok(anchoredLines[0]!.startsWith("⌂ mitanchoredcat, ⌂ mitanchoreddog"));
  assert.ok(unanchoredLines[0]!.startsWith("~ mitunanchoredalpha, ~ mitunanchoredbeta"));
});

test("balance ready-state text keeps pending lines below the domain sections and next steps", async () => {
  const context = await createReadyBalanceContext({
    stateOverrides: {
      pendingMutations: [
        createPendingMutation(),
      ],
    },
  });
  const lines = formatBalanceReport(context).split("\n");

  assert.equal(lines.at(-1), "Pending: send  broadcasting  0.00000123 COG");
  assert.ok(lines.includes("Anchored Domains"));
  assert.ok(lines.includes("Unanchored Domains"));
});

test("balance ready-state text renders unavailable BTC inside the art card", async () => {
  const context = await createReadyBalanceContext({
    fundingSpendableSats: null,
  });
  const lines = formatBalanceReport(context).split("\n");

  assertSingleSpaceValue(lines[6]!, "Bitcoin Balance:", "unavailable BTC");
});

test("balance ready-state text adds quickstart below the art when BTC is below the funding threshold and no domain exists", async () => {
  const context = await createReadyBalanceContext({
    fundingSpendableSats: 149_999n,
  });
  const lines = formatBalanceReport(context).split("\n");

  assert.equal(lines[17], "");
  assert.equal(lines[18], `Quickstart: ${getFundingQuickstartGuidance()}`);
});

test("balance ready-state text suppresses quickstart when an anchored or registered-unanchored domain exists", async () => {
  const context = await createReadyBalanceContext({
    fundingSpendableSats: 149_999n,
    stateOverrides: {
      domains: [createLocalDomain()],
    },
  });

  assert.equal(
    formatBalanceReport(context).includes(`Quickstart: ${getFundingQuickstartGuidance()}`),
    false,
  );
});

test("balance ready-state text suggests anchoring when an unanchored domain exists and no root domain is anchored", async () => {
  const context = await createReadyBalanceContext({
    stateOverrides: {
      domains: [
        createLocalDomain({
          name: "mitdog",
          canonicalChainStatus: "registered-unanchored",
        }),
      ],
    },
  });

  assert.ok(
    formatBalanceReport(context).includes("Next step: Run `cogcoin anchor mitdog` to anchor your unanchored domain."),
  );
});

test("balance ready-state text suggests buying a root domain when funded but no anchored or unanchored domains exist", async () => {
  const context = await createReadyBalanceContext({
    fundingSpendableSats: 100_001n,
  });

  assert.ok(
    formatBalanceReport(context).includes("Next step: Buy a 6+ character root domain with `cogcoin register <root>`."),
  );
});

test("balance ready-state text suggests mining when an anchored root domain exists and BTC is above the mining threshold", async () => {
  const context = await createReadyBalanceContext({
    fundingSpendableSats: 10_001n,
    stateOverrides: {
      domains: [
        createLocalDomain({
          name: "mitcat",
          canonicalChainStatus: "anchored",
          currentCanonicalAnchorOutpoint: { txid: "11".repeat(32), vout: 0, valueSats: 2_000 },
        }),
      ],
    },
  });

  assert.ok(
    formatBalanceReport(context).includes("Next step: Run `cogcoin mine` to start mining with your anchored root domain."),
  );
});

test("balance ready-state text suggests transferring BTC when an anchored root domain exists and BTC is below the mining threshold", async () => {
  const context = await createReadyBalanceContext({
    fundingSpendableSats: 9_999n,
    stateOverrides: {
      domains: [
        createLocalDomain({
          name: "mitcat",
          canonicalChainStatus: "anchored",
          currentCanonicalAnchorOutpoint: { txid: "11".repeat(32), vout: 0, valueSats: 2_000 },
        }),
      ],
    },
  });

  assert.ok(
    formatBalanceReport(context).includes("Next step: Transfer BTC to bc1qfunding so your anchored root domain can keep mining."),
  );
});

test("balance fallback text remains unchanged when wallet state is unavailable", () => {
  const rendered = formatBalanceReport(createWalletReadContext({
    localState: {
      availability: "uninitialized",
      clientPasswordReadiness: "ready",
      unlockRequired: false,
      walletRootId: null,
      state: null,
      source: null,
      hasPrimaryStateFile: false,
      hasBackupStateFile: false,
      message: "Wallet state has not been initialized yet.",
    },
    model: null,
    bitcoind: {
      health: "unavailable",
      message: "Managed bitcoind service is unavailable.",
      status: null,
    },
    indexer: {
      health: "unavailable",
      message: "Indexer daemon is unavailable.",
      status: null,
      source: "none",
      daemonInstanceId: null,
      snapshotSeq: null,
      openedAtUnixMs: null,
      snapshotTip: null,
    },
    nodeStatus: null,
    nodeHealth: "unavailable",
    nodeMessage: "Bitcoin service is unavailable.",
  }));

  assert.equal(
    rendered,
    "COG Balance\n"
      + "Wallet state: uninitialized\n"
      + "Wallet root: none\n"
      + "Wallet note: Wallet state has not been initialized yet.\n"
      + "Recommended next step: Run `cogcoin init` to create a new local wallet root.",
  );
});

test("balance fallback text remains unchanged when the indexer snapshot is unavailable", () => {
  const rendered = formatBalanceReport(createWalletReadContext({
    snapshot: null,
    indexer: {
      health: "starting",
      message: "Indexer snapshot is not ready yet.",
      status: null,
      source: "probe",
      daemonInstanceId: null,
      snapshotSeq: null,
      openedAtUnixMs: null,
      snapshotTip: null,
    },
  }));

  assert.equal(
    rendered,
    "COG Balance\nIndexer-backed balances are unavailable while the indexer is starting.",
  );
});
