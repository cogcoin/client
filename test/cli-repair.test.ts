import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runCli } from "../src/cli-runner.js";
import type { WalletRepairResult } from "../src/wallet/lifecycle.js";

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

function createRepairResult(overrides: Partial<WalletRepairResult> = {}): WalletRepairResult {
  return {
    walletRootId: "wallet-root-repair",
    recoveredFromBackup: false,
    recreatedManagedCoreWallet: false,
    resetIndexerDatabase: false,
    bitcoindServiceAction: "none",
    bitcoindCompatibilityIssue: "none",
    managedCoreReplicaAction: "none",
    bitcoindPostRepairHealth: "ready",
    indexerDaemonAction: "none",
    indexerCompatibilityIssue: "none",
    indexerPostRepairHealth: "synced",
    miningPreRepairRunMode: "stopped",
    miningResumeAction: "none",
    miningPostRepairRunMode: "stopped",
    miningResumeError: null,
    note: null,
    ...overrides,
  };
}

test("repair text output uses the sectioned checkmarked layout for a healthy result", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();

  const code = await runCli(["repair"], {
    stdout,
    stderr,
    stdin: new FakeInput(true) as never,
    repairWallet: async () => createRepairResult({
      walletRootId: "wallet-root-healthy",
      recreatedManagedCoreWallet: true,
      resetIndexerDatabase: true,
      managedCoreReplicaAction: "recreated",
      miningPreRepairRunMode: "background",
      miningResumeAction: "resumed-background",
      miningPostRepairRunMode: "background",
    }),
  });

  assert.equal(code, 0);
  const output = stdout.toString();
  assert.match(output, /^\n⛭ Cogcoin Repair ⛭\n\nWallet\n✓ Wallet root: wallet-root-healthy\n✓ Recovered from backup: no\n✓ Managed Core wallet recreated: yes/u);
  assert.match(output, /\n\nManaged Bitcoind\n✓ Managed bitcoind action: none\n✓ Managed bitcoind compatibility issue: none\n✓ Managed Core replica action: recreated\n✓ Managed bitcoind post-repair health: ready/u);
  assert.match(output, /\n\nIndexer\n✓ Indexer database reset: yes\n✓ Indexer daemon action: none\n✓ Indexer compatibility issue: none\n✓ Indexer post-repair health: synced/u);
  assert.match(output, /\n\nMining\n✓ Mining mode before repair: background\n✓ Mining resume action: resumed-background\n✓ Mining mode after repair: background/u);
  assert.doesNotMatch(output, /\n\nNotes\n/u);
  assert.doesNotMatch(output, /\n\nWarnings\n/u);
  assert.match(output, /\n\nNext step: Run `cogcoin status` to review the repaired local state\.\n$/u);
  assert.doesNotMatch(output, /Wallet repair completed\./u);
  assert.equal(stderr.toString(), "");
});

test("repair text output marks degraded repair states with sectioned warnings and notes", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();

  const code = await runCli(["repair"], {
    stdout,
    stderr,
    stdin: new FakeInput(true) as never,
    repairWallet: async () => createRepairResult({
      walletRootId: "wallet-root-degraded",
      recoveredFromBackup: true,
      bitcoindServiceAction: "restarted-compatible-service",
      bitcoindCompatibilityIssue: "runtime-mismatch",
      managedCoreReplicaAction: "recreated",
      bitcoindPostRepairHealth: "catching-up",
      resetIndexerDatabase: true,
      indexerDaemonAction: "restarted-compatible-daemon",
      indexerCompatibilityIssue: "schema-mismatch",
      indexerPostRepairHealth: "failed",
      miningPreRepairRunMode: "background",
      miningResumeAction: "resume-failed",
      miningPostRepairRunMode: "stopped",
      miningResumeError: "background worker exited unexpectedly",
      note: "Repair preserved the existing wallet root.",
    }),
  });

  assert.equal(code, 0);
  const output = stdout.toString();
  assert.match(output, /^\n⛭ Cogcoin Repair ⛭/u);
  assert.match(output, /Wallet\n[\s\S]*\n\nManaged Bitcoind\n[\s\S]*\n\nIndexer\n[\s\S]*\n\nMining\n[\s\S]*\n\nNotes\n[\s\S]*\n\nWarnings\n/u);
  assert.match(output, /✓ Wallet root: wallet-root-degraded/u);
  assert.match(output, /✓ Recovered from backup: yes/u);
  assert.match(output, /✗ Managed bitcoind compatibility issue: runtime-mismatch/u);
  assert.match(output, /✗ Managed bitcoind post-repair health: catching-up/u);
  assert.match(output, /✗ Indexer compatibility issue: schema-mismatch/u);
  assert.match(output, /✗ Indexer post-repair health: failed/u);
  assert.match(output, /✗ Mining resume action: resume-failed/u);
  assert.match(output, /✓ Note: Repair preserved the existing wallet root\./u);
  assert.match(output, /✗ Mining resume error: background worker exited unexpectedly/u);
  assert.match(output, /\n\nNext step: Run `cogcoin status` to review the repaired local state\.\n$/u);
  assert.equal(stderr.toString(), "");
});
