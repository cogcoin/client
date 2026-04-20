import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli-runner.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";

class MemoryStream {
  readonly chunks: string[] = [];
  isTTY?: boolean;

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  toString(): string {
    return this.chunks.join("");
  }
}

function createReadContextStub() {
  return {
    model: null,
    snapshot: null,
    localState: {
      availability: "ready",
      walletRootId: null,
      message: null,
      state: null,
    },
    nodeHealth: "synced",
    nodeMessage: null,
    nodeStatus: {
      chain: null,
      walletRootId: null,
      walletReplica: null,
      nodeBestHeight: null,
      nodeBestHashHex: null,
      nodeHeaderHeight: null,
    },
    bitcoind: {
      health: "ready",
      message: null,
      status: null,
    },
    indexer: {
      health: "synced",
      message: null,
      status: null,
      source: null,
      daemonInstanceId: null,
      snapshotSeq: null,
      openedAtUnixMs: null,
      snapshotTip: null,
    },
    mining: undefined,
    async close() {},
  } as never;
}

function createBaseContext(options: {
  stdout: MemoryStream;
  stderr: MemoryStream;
  onOpenWalletReadContext?: () => void;
  inspectMiningDomainPromptState?: () => Promise<{
    fallbackPromptConfigured: boolean;
    prompts: Array<{
      domain: { name: string; domainId: number | null };
      mineable: boolean;
      prompt: string | null;
      effectivePromptSource: "domain" | "global-fallback" | "none";
    }>;
  }>;
}) {
  return {
    stdout: options.stdout,
    stderr: options.stderr,
    ensureDirectory: async () => undefined,
    readPackageVersion: async () => "0.0.0-test",
    resolveWalletRuntimePaths: () => resolveWalletRuntimePathsForTesting(),
    openWalletReadContext: async () => {
      options.onOpenWalletReadContext?.();
      return createReadContextStub();
    },
    inspectMiningDomainPromptState: options.inspectMiningDomainPromptState,
  };
}

test("runCli routes address and wallet address through the same wallet-read path", async () => {
  let canonicalCalls = 0;
  const canonicalStdout = new MemoryStream();
  const canonicalStderr = new MemoryStream();
  const canonicalCode = await runCli(["address", "--output", "json"], createBaseContext({
    stdout: canonicalStdout,
    stderr: canonicalStderr,
    onOpenWalletReadContext: () => {
      canonicalCalls += 1;
    },
  }));

  let aliasCalls = 0;
  const aliasStdout = new MemoryStream();
  const aliasStderr = new MemoryStream();
  const aliasCode = await runCli(["wallet", "address", "--output", "json"], createBaseContext({
    stdout: aliasStdout,
    stderr: aliasStderr,
    onOpenWalletReadContext: () => {
      aliasCalls += 1;
    },
  }));

  assert.equal(canonicalCode, 0);
  assert.equal(aliasCode, 0);
  assert.equal(canonicalCalls, 1);
  assert.equal(aliasCalls, 1);
  assert.equal(canonicalStderr.toString(), "");
  assert.equal(aliasStderr.toString(), "");
  assert.equal(JSON.parse(canonicalStdout.toString()).command, "cogcoin address");
  assert.equal(JSON.parse(aliasStdout.toString()).command, "cogcoin address");
});

test("runCli routes mine prompt and mine prompt list through the same mining-read path", async () => {
  let promptCalls = 0;
  const makeInspectPromptState = async () => {
    promptCalls += 1;
    return {
      fallbackPromptConfigured: false,
      prompts: [],
    };
  };

  const promptStdout = new MemoryStream();
  const promptListStdout = new MemoryStream();
  const promptCode = await runCli(["mine", "prompt", "--output", "json"], createBaseContext({
    stdout: promptStdout,
    stderr: new MemoryStream(),
    inspectMiningDomainPromptState: makeInspectPromptState,
  }));
  const promptListCode = await runCli(["mine", "prompt", "list", "--output", "json"], createBaseContext({
    stdout: promptListStdout,
    stderr: new MemoryStream(),
    inspectMiningDomainPromptState: makeInspectPromptState,
  }));

  assert.equal(promptCode, 0);
  assert.equal(promptListCode, 0);
  assert.equal(promptCalls, 2);
  assert.equal(JSON.parse(promptStdout.toString()).command, "cogcoin mine prompt");
  assert.equal(JSON.parse(promptListStdout.toString()).command, "cogcoin mine prompt");
});
