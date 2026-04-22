import assert from "node:assert/strict";
import test from "node:test";

import { MemoryWalletSecretProvider } from "../src/wallet/state/provider.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  runWalletMutationCommand,
} from "../src/cli/commands/wallet-mutation.js";
import { getWalletMutationCommandSpec } from "../src/cli/commands/wallet-mutation/registry.js";
import type {
  ParsedCliArgs,
  RequiredCliRunnerContext,
  SignalSource,
  WritableLike,
} from "../src/cli/types.js";

class MemoryStream implements WritableLike {
  readonly chunks: string[] = [];
  isTTY = true;

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  toString(): string {
    return this.chunks.join("");
  }
}

class TestSignalSource implements SignalSource {
  on(_event: "SIGINT" | "SIGTERM", _listener: () => void): void {}
  off(_event: "SIGINT" | "SIGTERM", _listener: () => void): void {}
}

function createParsed(command: ParsedCliArgs["command"], args: string[]): ParsedCliArgs {
  return {
    command,
    commandFamily: "wallet-mutation",
    invokedCommandTokens: command === null ? null : [command],
    invokedCommandPath: command,
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

test("wallet mutation spec registry maps representative commands to the correct family owners", () => {
  assert.equal(getWalletMutationCommandSpec("bitcoin-transfer")?.id, "bitcoin-transfer");
  assert.equal(getWalletMutationCommandSpec("anchor")?.id, "anchor");
  assert.equal(getWalletMutationCommandSpec("register")?.id, "register");
  assert.equal(getWalletMutationCommandSpec("sell")?.id, "domain-market");
  assert.equal(getWalletMutationCommandSpec("domain-endpoint-set")?.id, "domain-admin");
  assert.equal(getWalletMutationCommandSpec("field-set")?.id, "field");
  assert.equal(getWalletMutationCommandSpec("claim")?.id, "cog");
  assert.equal(getWalletMutationCommandSpec("rep-give")?.id, "reputation");
});

test("runWalletMutationCommand resolves shared context once and writes success text", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const runtimePaths = resolveWalletRuntimePathsForTesting();
  const provider = new MemoryWalletSecretProvider();
  const prompter = { isInteractive: true } as RequiredCliRunnerContext["createPrompter"] extends () => infer T ? T : never;
  const parsed = createParsed("bitcoin-transfer", ["1200"]);
  parsed.transferTarget = "bc1qrecipient";

  let receivedDataDir: string | null = null;
  let receivedDatabasePath: string | null = null;
  let receivedPaths: unknown = null;
  let receivedPrompter: unknown = null;
  let receivedProviderHasLoadSecret = false;

  const context = {
    stdout,
    stderr,
    signalSource: new TestSignalSource(),
    forceExit: () => undefined,
    walletSecretProvider: provider,
    createPrompter: () => prompter,
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoin",
    resolveDefaultClientDatabasePath: () => "/tmp/client.sqlite",
    resolveWalletRuntimePaths: () => runtimePaths,
    transferBitcoin: async (options: {
      dataDir: string;
      databasePath: string;
      paths: unknown;
      prompter: unknown;
      provider: {
        loadSecret(keyId: string): Promise<Uint8Array>;
      };
    }) => {
      receivedDataDir = options.dataDir;
      receivedDatabasePath = options.databasePath;
      receivedPaths = options.paths;
      receivedPrompter = options.prompter;
      receivedProviderHasLoadSecret = typeof options.provider.loadSecret === "function";
      return {
        senderAddress: "bc1qsender",
        recipientAddress: "bc1qrecipient",
        amountSats: 1200n,
        feeSats: 321n,
        txid: "11".repeat(32),
      };
    },
  } as unknown as RequiredCliRunnerContext;

  const code = await runWalletMutationCommand(parsed, context);

  assert.equal(code, 0);
  assert.equal(receivedDataDir, "/tmp/bitcoin");
  assert.equal(receivedDatabasePath, "/tmp/client.sqlite");
  assert.equal(receivedPaths, runtimePaths);
  assert.equal(receivedPrompter, prompter);
  assert.equal(receivedProviderHasLoadSecret, true);
  assert.match(stdout.toString(), /Bitcoin transfer submitted\./);
  assert.match(stdout.toString(), /Recipient: bc1qrecipient/);
  assert.equal(stderr.toString(), "");
});

test("runWalletMutationCommand keeps handled-error presentation on failures", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const parsed = createParsed("bitcoin-transfer", ["1200"]);
  parsed.transferTarget = "bc1qrecipient";

  const context = {
    stdout,
    stderr,
    signalSource: new TestSignalSource(),
    forceExit: () => undefined,
    walletSecretProvider: new MemoryWalletSecretProvider(),
    createPrompter: () => ({ isInteractive: true }),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoin",
    resolveDefaultClientDatabasePath: () => "/tmp/client.sqlite",
    resolveWalletRuntimePaths: () => resolveWalletRuntimePathsForTesting(),
    transferBitcoin: async () => {
      throw new Error("wallet_bitcoin_transfer_invalid_amount");
    },
  } as unknown as RequiredCliRunnerContext;

  const code = await runWalletMutationCommand(parsed, context);

  assert.equal(code, 5);
  assert.match(stderr.toString(), /What happened: Bitcoin transfer amount is invalid\./);
  assert.match(stderr.toString(), /Next: Rerun `cogcoin bitcoin transfer <sats> --to <address>` with a positive integer satoshi amount\./);
});
