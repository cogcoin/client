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

test("commandMutationNextSteps and workflowMutationNextSteps preserve json and text variants", () => {
  assert.deepEqual(commandMutationNextSteps("cogcoin balance"), {
    json: ["Run `cogcoin balance`."],
    text: ["Next step: cogcoin balance"],
  });

  assert.deepEqual(
    workflowMutationNextSteps(["cogcoin show alpha", "cogcoin mine"]),
    {
      json: ["cogcoin show alpha", "cogcoin mine"],
      text: ["Next step: cogcoin show alpha", "Next step: cogcoin mine"],
    },
  );
});

test("writeMutationCommandSuccess writes text output with shared reuse and next-step handling", () => {
  const stdout = new MemoryStream();
  const parsed = {
    command: "transfer",
    args: ["alpha"],
    outputMode: "text",
  } as ParsedCliArgs;
  const context = {
    stdout,
  } as unknown as RequiredCliRunnerContext;

  const code = writeMutationCommandSuccess(parsed, context, {
    data: { domainName: "alpha" },
    reusedExisting: true,
    reusedMessage: "The existing pending transfer was reconciled instead of creating a duplicate.",
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
  ].join("\n"));
});

test("writeMutationCommandSuccess writes mutation json output with shared explanations and next steps", () => {
  const stdout = new MemoryStream();
  const parsed = {
    command: "transfer",
    args: ["alpha"],
    outputMode: "json",
  } as ParsedCliArgs;
  const context = {
    stdout,
  } as unknown as RequiredCliRunnerContext;

  const code = writeMutationCommandSuccess(parsed, context, {
    data: { domainName: "alpha" },
    reusedExisting: true,
    reusedMessage: "The existing pending transfer was reconciled instead of creating a duplicate.",
    nextSteps: commandMutationNextSteps("cogcoin show alpha"),
    text: {
      heading: "Transfer submitted.",
      fields: [{ label: "Domain", value: "alpha" }],
    },
  });

  assert.equal(code, 0);

  const envelope = JSON.parse(stdout.toString());
  assert.equal(envelope.schema, "cogcoin/transfer/v1");
  assert.equal(envelope.command, "cogcoin transfer alpha");
  assert.equal(envelope.outcome, "reconciled");
  assert.deepEqual(envelope.explanations, [
    "The existing pending transfer was reconciled instead of creating a duplicate.",
  ]);
  assert.deepEqual(envelope.nextSteps, ["Run `cogcoin show alpha`."]);
  assert.deepEqual(envelope.data, { domainName: "alpha" });
});
