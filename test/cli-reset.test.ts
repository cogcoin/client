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
          defaultAction: "retain-mnemonic" as const,
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

test("reset json recommends sync when the mnemonic is retained", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();

  const code = await runCli(["reset", "--output", "json"], {
    stdout,
    stderr,
    stdin: new FakeInput(true) as never,
    resetWallet: async () => ({
      dataRoot: "/tmp/cogcoin",
      factoryResetReady: true as const,
      stoppedProcesses: {
        managedBitcoind: 1,
        indexerDaemon: 1,
        backgroundMining: 0,
        survivors: 0,
      },
      secretCleanupStatus: "deleted" as const,
      deletedSecretRefs: ["wallet-state:wallet-root-old"],
      failedSecretRefs: [],
      preservedSecretRefs: [],
      walletAction: "retain-mnemonic" as const,
      walletOldRootId: "wallet-root-old",
      walletNewRootId: "wallet-root-new",
      bootstrapSnapshot: {
        status: "preserved" as const,
        path: "/tmp/cogcoin/bitcoin/bootstrap/utxo-910000.dat",
      },
      removedPaths: ["/tmp/cogcoin"],
    }),
  });

  assert.equal(code, 0);
  const envelope = parseEnvelope(stdout) as {
    nextSteps: string[];
    data: {
      operation: {
        walletAction: string;
      };
    };
  };
  assert.deepEqual(envelope.nextSteps, ["Run `cogcoin sync` to bootstrap assumeutxo and the managed Bitcoin/indexer state."]);
  assert.equal(envelope.data.operation.walletAction, "retain-mnemonic");
  assert.equal(stderr.toString(), "");
});

test("reset text renders sectioned output and omits wallet root lines when the mnemonic is retained", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();

  const code = await runCli(["reset"], {
    stdout,
    stderr,
    stdin: new FakeInput(true) as never,
    resetWallet: async () => ({
      dataRoot: "/tmp/cogcoin",
      factoryResetReady: true as const,
      stoppedProcesses: {
        managedBitcoind: 1,
        indexerDaemon: 1,
        backgroundMining: 0,
        survivors: 0,
      },
      secretCleanupStatus: "deleted" as const,
      deletedSecretRefs: ["wallet-state:wallet-root-old"],
      failedSecretRefs: [],
      preservedSecretRefs: [],
      walletAction: "retain-mnemonic" as const,
      walletOldRootId: "wallet-root-old",
      walletNewRootId: "wallet-root-new",
      bootstrapSnapshot: {
        status: "preserved" as const,
        path: "/tmp/cogcoin/bitcoin/bootstrap/utxo-910000.dat",
      },
      removedPaths: ["/tmp/cogcoin"],
    }),
  });

  assert.equal(code, 0);
  const output = stdout.toString();
  assert.match(output, /^\n⛭ Cogcoin Reset ⛭\n\nPaths\n✓ Data root: \/tmp\/cogcoin/u);
  assert.match(output, /\n\nReset Outcome\n✓ Wallet action: retain-mnemonic\n✓ Snapshot: preserved\n✓ Secret cleanup: deleted/u);
  assert.match(output, /\n\nManaged Cleanup\n✓ Managed bitcoind processes stopped: 1\n✓ Indexer daemons stopped: 1\n✓ Background miners stopped: 0/u);
  assert.match(output, /\n\nNext step: Run `cogcoin sync` to bootstrap assumeutxo and the managed Bitcoin\/indexer state\.\n$/u);
  assert.doesNotMatch(output, /Previous wallet root:/);
  assert.doesNotMatch(output, /New wallet root:/);
  assert.doesNotMatch(output, /\n\nWarnings\n/u);
  assert.equal(stderr.toString(), "");
});

test("reset text renders warnings in a separate section and keeps the next step at the bottom", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();

  const code = await runCli(["reset"], {
    stdout,
    stderr,
    stdin: new FakeInput(true) as never,
    resetWallet: async () => ({
      dataRoot: "/tmp/cogcoin",
      factoryResetReady: true as const,
      stoppedProcesses: {
        managedBitcoind: 0,
        indexerDaemon: 0,
        backgroundMining: 0,
        survivors: 0,
      },
      secretCleanupStatus: "unknown" as const,
      deletedSecretRefs: [],
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
    }),
  });

  assert.equal(code, 0);
  const output = stdout.toString();
  assert.match(output, /^\n⛭ Cogcoin Reset ⛭/u);
  assert.match(output, /\n\nReset Outcome\n✓ Wallet action: deleted\n✓ Snapshot: deleted\n✗ Secret cleanup: unknown\n✓ Previous wallet root: wallet-root-old/u);
  assert.match(output, /\n\nWarnings\n✗ Warning: Some existing Cogcoin secret-provider entries could not be discovered from the remaining local wallet artifacts and may need manual cleanup\./u);
  assert.match(output, /\n\nNext step: Run `cogcoin init` to create a new wallet\.\n$/u);
  assert.equal(stderr.toString(), "");
});

test("reset entropy-reset-unavailable errors are presented clearly in text mode", () => {
  const formatted = formatCliTextError(new Error("reset_wallet_entropy_reset_unavailable"));
  assert.deepEqual(formatted, [
    "What happened: Entropy-retaining wallet reset is unavailable.",
    "Why: Cogcoin found wallet state, but it could not safely load and reconstruct it into a fresh wallet while preserving only the mnemonic-derived continuity data.",
    "Next: Rerun `cogcoin reset` and choose \"skip\" to keep the wallet unchanged, or type \"delete wallet\" to erase it fully.",
  ]);
});
