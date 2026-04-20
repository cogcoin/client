import assert from "node:assert/strict";
import test from "node:test";

import {
  commandMutationNextSteps,
  workflowMutationNextSteps,
  writeMutationCommandSuccess,
} from "../src/cli/mutation-success.js";
import type {
  ParsedCliArgs,
  RequiredCliRunnerContext,
} from "../src/cli/types.js";

class MemoryStream {
  readonly chunks: string[] = [];

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  toString(): string {
    return this.chunks.join("");
  }
}

function createParsed(command: ParsedCliArgs["command"], args: string[]): ParsedCliArgs {
  return {
    command,
    commandFamily: null,
    invokedCommandTokens: null,
    invokedCommandPath: null,
    args,
    help: false,
    version: false,
    dbPath: null,
    dataDir: null,
    progressOutput: "auto",
    unlockFor: null,
    assumeYes: false,
    force: false,
    forceRace: false,
    anchorMessage: null,
    transferTarget: null,
    endpointText: null,
    endpointJson: null,
    endpointBytes: null,
    fieldPermanent: false,
    fieldFormat: null,
    fieldValue: null,
    lockRecipientDomain: null,
    conditionHex: null,
    untilHeight: null,
    preimageHex: null,
    reviewText: null,
    satvb: null,
    locksClaimableOnly: false,
    locksReclaimableOnly: false,
    domainsAnchoredOnly: false,
    domainsListedOnly: false,
    domainsMineableOnly: false,
    listLimit: null,
    listAll: false,
    follow: false,
  };
}

test("commandMutationNextSteps and workflowMutationNextSteps preserve text next-step variants", () => {
  assert.deepEqual(commandMutationNextSteps("cogcoin balance"), {
    text: ["Next step: cogcoin balance"],
  });

  assert.deepEqual(
    workflowMutationNextSteps(["cogcoin show alpha", "cogcoin mine"]),
    {
      text: ["Next step: cogcoin show alpha", "Next step: cogcoin mine"],
    },
  );
});

test("writeMutationCommandSuccess writes text output with shared reuse and next-step handling", () => {
  const stdout = new MemoryStream();
  const parsed = createParsed("transfer", ["alpha"]);
  const context = {
    stdout,
  } as unknown as RequiredCliRunnerContext;

  const code = writeMutationCommandSuccess(parsed, context, {
    data: { domainName: "alpha" },
    reusedExisting: true,
    reusedMessage: "The existing pending transfer was reconciled instead of creating a duplicate.",
    interactive: true,
    explorerTxid: "11".repeat(32),
    nextSteps: commandMutationNextSteps("cogcoin show alpha"),
    text: {
      heading: "Transfer submitted.",
      fields: [
        { label: "Domain", value: "alpha" },
        { label: "Status", value: "pending" },
      ],
    },
  });

  assert.equal(code, 0);
  assert.equal(stdout.toString(), [
    "Transfer submitted.",
    "Domain: alpha",
    "Status: pending",
    "The existing pending transfer was reconciled instead of creating a duplicate.",
    "Next step: cogcoin show alpha",
    "",
    `View at: https://mempool.space/tx/${"11".repeat(32)}`,
    "",
  ].join("\n"));
});

test("writeMutationCommandSuccess skips explorer links for non-interactive text output", () => {
  const stdout = new MemoryStream();
  const parsed = createParsed("transfer", ["alpha"]);
  const context = {
    stdout,
  } as unknown as RequiredCliRunnerContext;

  const code = writeMutationCommandSuccess(parsed, context, {
    data: { domainName: "alpha" },
    reusedExisting: false,
    reusedMessage: "",
    interactive: false,
    explorerTxid: "11".repeat(32),
    nextSteps: commandMutationNextSteps("cogcoin show alpha"),
    text: {
      heading: "Transfer submitted.",
      fields: [{ label: "Domain", value: "alpha" }],
    },
  });

  assert.equal(code, 0);
  assert.equal(stdout.toString(), [
    "Transfer submitted.",
    "Domain: alpha",
    "Next step: cogcoin show alpha",
    "",
  ].join("\n"));
});

test("writeMutationCommandSuccess appends fee summary fields when provided", () => {
  const stdout = new MemoryStream();
  const parsed = createParsed("register", ["alpha"]);
  const context = {
    stdout,
  } as unknown as RequiredCliRunnerContext;

  const code = writeMutationCommandSuccess(parsed, context, {
    data: { domainName: "alpha" },
    reusedExisting: false,
    reusedMessage: "",
    fees: {
      feeRateSatVb: 12.5,
      feeSats: "321",
      source: "custom-satvb",
    },
    interactive: false,
    nextSteps: commandMutationNextSteps("cogcoin show alpha"),
    text: {
      heading: "Register submitted.",
      fields: [{ label: "Domain", value: "alpha" }],
    },
  });

  assert.equal(code, 0);
  assert.equal(stdout.toString(), [
    "Register submitted.",
    "Domain: alpha",
    "Fee rate: 12.5 sat/vB",
    "Fee: 321 sats",
    "Next step: cogcoin show alpha",
    "",
  ].join("\n"));
});
