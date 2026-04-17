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

  assert.equal(lines.length, BALANCE_ART_TEMPLATE.length + 2);
  assert.ok(rendered.startsWith(`\n${BALANCE_ART_TEMPLATE[0]}\n${BALANCE_ART_TEMPLATE[1]}\n${BALANCE_ART_TEMPLATE[2]}\n`));
  assert.equal(lines[0], "");
  assert.equal(lines[1], BALANCE_ART_TEMPLATE[0]);
  assert.equal(lines[2], BALANCE_ART_TEMPLATE[1]);
  assert.equal(lines[3], BALANCE_ART_TEMPLATE[2]);
  assert.equal(lines[5], BALANCE_ART_TEMPLATE[4]);
  assert.equal(lines[8], BALANCE_ART_TEMPLATE[7]);
  assert.equal(lines[10], BALANCE_ART_TEMPLATE[9]);
  assert.equal(lines[11], "");

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

test("balance ready-state text keeps pending lines below the art card", async () => {
  const context = await createReadyBalanceContext({
    stateOverrides: {
      pendingMutations: [
        createPendingMutation(),
      ],
    },
  });
  const lines = formatBalanceReport(context).split("\n");

  assert.equal(lines.length, BALANCE_ART_TEMPLATE.length + 3);
  assert.equal(lines[10], BALANCE_ART_TEMPLATE[9]);
  assert.equal(lines[11], "");
  assert.equal(lines[12], "Pending: send  broadcasting  0.00000123 COG");
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

  assert.equal(lines[11], "");
  assert.equal(lines[12], `Quickstart: ${getFundingQuickstartGuidance()}`);
});

test("balance ready-state text suppresses quickstart when an anchored or registered-unanchored domain exists", async () => {
  const context = await createReadyBalanceContext({
    fundingSpendableSats: 149_999n,
    stateOverrides: {
      domains: [{
        name: "alpha",
        domainId: 1,
        currentOwnerScriptPubKeyHex: "0014" + "11".repeat(20),
        canonicalChainStatus: "registered-unanchored",
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      }],
    },
  });

  assert.equal(
    formatBalanceReport(context).includes(`Quickstart: ${getFundingQuickstartGuidance()}`),
    false,
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
