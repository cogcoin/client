import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { parseCliArgs, runCli } from "../src/cli-runner.js";
import { formatCliTextError } from "../src/cli/output.js";

class MemoryStream {
  readonly chunks: string[] = [];
  isTTY?: boolean;

  constructor(isTTY = false) {
    this.isTTY = isTTY;
  }

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  toString(): string {
    return this.chunks.join("");
  }
}

class FakeInput extends EventEmitter {
  isTTY?: boolean;

  constructor(isTTY = false) {
    super();
    this.isTTY = isTTY;
  }
}

function parseEnvelope(stream: MemoryStream): unknown {
  return JSON.parse(stream.toString());
}

test("parseCliArgs understands reset and still rejects --yes for it", () => {
  const parsed = parseCliArgs(["reset", "--output", "preview-json"]);
  assert.equal(parsed.command, "reset");
  assert.equal(parsed.outputMode, "preview-json");

  assert.throws(
    () => parseCliArgs(["reset", "--yes"]),
    /cli_yes_not_supported_for_command/,
  );
});

test("reset preview-json dispatches through previewResetWallet", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  let called = false;

  const code = await runCli(["reset", "--output", "preview-json"], {
    stdout,
    stderr,
    stdin: new FakeInput(true) as never,
    previewResetWallet: async () => {
      called = true;
      return {
        dataRoot: "/tmp/cogcoin",
        confirmationPhrase: "permanently reset" as const,
        walletPrompt: {
          defaultAction: "reset-base-entropy" as const,
          acceptedInputs: ["", "skip", "delete wallet"] as const,
          entropyRetainingResetAvailable: true,
          requiresPassphrase: false,
          envelopeSource: "primary" as const,
        },
        bootstrapSnapshot: {
          status: "valid" as const,
          path: "/tmp/cogcoin/bitcoin/bootstrap/utxo-910000.dat",
          defaultAction: "preserve" as const,
        },
        trackedProcessKinds: ["managed-bitcoind"] as const,
        willDeleteOsSecrets: true,
        removedPaths: ["/tmp/cogcoin"],
      };
    },
  });

  assert.equal(code, 0);
  assert.equal(called, true);
  const envelope = parseEnvelope(stdout) as {
    schema: string;
    command: string;
    outcome: string;
    data: {
      resultType: string;
      operation: {
        kind: string;
        confirmationPhrase: string;
      };
    };
  };
  assert.equal(envelope.schema, "cogcoin-preview/reset/v1");
  assert.equal(envelope.command, "cogcoin reset");
  assert.equal(envelope.outcome, "planned");
  assert.equal(envelope.data.resultType, "operation");
  assert.equal(envelope.data.operation.kind, "reset");
  assert.equal(envelope.data.operation.confirmationPhrase, "permanently reset");
  assert.equal(stderr.toString(), "");
});

test("reset json emits the stable reset mutation envelope", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  let called = false;

  const code = await runCli(["reset", "--output", "json"], {
    stdout,
    stderr,
    stdin: new FakeInput(true) as never,
    resetWallet: async () => {
      called = true;
      return {
        dataRoot: "/tmp/cogcoin",
        factoryResetReady: true as const,
        stoppedProcesses: {
          managedBitcoind: 1,
          indexerDaemon: 0,
          backgroundMining: 0,
          survivors: 0,
        },
        secretCleanupStatus: "deleted" as const,
        deletedSecretRefs: ["wallet-state:wallet-root-old"],
        failedSecretRefs: [],
        preservedSecretRefs: [],
        walletAction: "deleted" as const,
        walletOldRootId: "wallet-root-old",
        walletNewRootId: null,
        bootstrapSnapshot: {
          status: "deleted" as const,
          path: "/tmp/cogcoin/bitcoin/bootstrap/utxo-910000.dat",
        },
        removedPaths: ["/tmp/cogcoin"],
      };
    },
  });

  assert.equal(code, 0);
  assert.equal(called, true);
  const envelope = parseEnvelope(stdout) as {
    schema: string;
    command: string;
    outcome: string;
    nextSteps: string[];
    data: {
      resultType: string;
      operation: {
        kind: string;
        walletAction: string;
        secretCleanupStatus: string;
      };
    };
  };
  assert.equal(envelope.schema, "cogcoin/reset/v1");
  assert.equal(envelope.command, "cogcoin reset");
  assert.equal(envelope.outcome, "completed");
  assert.deepEqual(envelope.nextSteps, ["Run `cogcoin init` to create a new wallet."]);
  assert.equal(envelope.data.resultType, "operation");
  assert.equal(envelope.data.operation.kind, "reset");
  assert.equal(envelope.data.operation.walletAction, "deleted");
  assert.equal(envelope.data.operation.secretCleanupStatus, "deleted");
  assert.equal(stderr.toString(), "");
});

test("reset entropy-reset-unavailable errors are presented clearly in text mode", () => {
  const formatted = formatCliTextError(new Error("reset_wallet_entropy_reset_unavailable"));
  assert.deepEqual(formatted, [
    "What happened: Entropy-retaining wallet reset is unavailable.",
    "Why: Cogcoin found wallet state, but it could not safely load and reconstruct it into a fresh wallet while preserving only the mnemonic-derived continuity data.",
    "Next: Rerun `cogcoin reset` and choose `skip` to keep the wallet unchanged, or type `delete wallet` to erase it fully.",
  ]);
});
