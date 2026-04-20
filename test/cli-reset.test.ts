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

test("parseCliArgs understands reset, rejects --yes, and treats --output as an unknown flag", () => {
  const parsed = parseCliArgs(["reset"]);
  assert.equal(parsed.command, "reset");

  assert.throws(
    () => parseCliArgs(["reset", "--yes"]),
    /cli_yes_not_supported_for_command/,
  );

  assert.throws(
    () => parseCliArgs(["reset", "--output", "json"]),
    /cli_unknown_flag_output/,
  );
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
      bitcoinDataDir: {
        status: "preserved" as const,
        path: "/tmp/cogcoin/bitcoin",
      },
      removedPaths: ["/tmp/cogcoin/client", "/tmp/cogcoin/indexer"],
    }),
  });

  assert.equal(code, 0);
  const output = stdout.toString();
  assert.match(output, /^\n⛭ Cogcoin Reset ⛭\n\nPaths\n✓ Data root: \/tmp\/cogcoin/u);
  assert.match(output, /\n\nReset Outcome\n✓ Wallet action: retain-mnemonic\n✓ Snapshot: preserved\n✓ Bitcoin datadir: preserved\n✓ Secret cleanup: deleted/u);
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
      bitcoinDataDir: {
        status: "deleted" as const,
        path: "/tmp/cogcoin/bitcoin",
      },
      removedPaths: ["/tmp/cogcoin"],
    }),
  });

  assert.equal(code, 0);
  const output = stdout.toString();
  assert.match(output, /^\n⛭ Cogcoin Reset ⛭/u);
  assert.match(output, /\n\nReset Outcome\n✓ Wallet action: deleted\n✓ Snapshot: deleted\n✓ Bitcoin datadir: deleted\n✗ Secret cleanup: unknown\n✓ Previous wallet root: wallet-root-old/u);
  assert.match(output, /\n\nWarnings\n✗ Warning: Some existing Cogcoin secret-provider entries could not be discovered from the remaining local wallet artifacts and may need manual cleanup\./u);
  assert.match(output, /\n\nNext step: Run `cogcoin init` to create or restore a wallet\.\n$/u);
  assert.equal(stderr.toString(), "");
});

test("reset entropy-reset-unavailable errors are presented clearly in text mode", () => {
  const formatted = formatCliTextError(new Error("reset_wallet_entropy_reset_unavailable"));
  assert.deepEqual(formatted, [
    "What happened: Entropy-retaining wallet reset is unavailable.",
    "Why: Cogcoin found wallet state, but it could not safely load and reconstruct it into a fresh wallet while preserving only the mnemonic-derived continuity data.",
    "Next: Rerun `cogcoin reset` and choose \"skip\" to keep the wallet unchanged, or type \"clear wallet entropy\" to erase it fully.",
  ]);
});
