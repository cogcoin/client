import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli/runner.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import { createMemoryWalletSecretProviderForTesting } from "../src/wallet/state/provider.js";
import { renderScriptPubKeyAsAddress } from "../src/wallet/tx/targets.js";
import { transferBitcoin } from "../src/wallet/tx/index.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { createWalletReadContext, createWalletState } from "./current-model-helpers.js";

type TransferAttachServiceOptions = Parameters<
  NonNullable<Parameters<typeof transferBitcoin>[0]["attachService"]>
>[0];

function createStringWriter() {
  let text = "";

  return {
    stream: {
      isTTY: false,
      write(chunk: string) {
        text += chunk;
      },
    },
    read() {
      return text;
    },
  };
}

function createTestRuntimePaths(homeDirectory: string) {
  return (seedName: string | null = null) => resolveWalletRuntimePathsForTesting({
    platform: "linux",
    homeDirectory,
    seedName,
    env: {
      ...process.env,
      XDG_DATA_HOME: join(homeDirectory, "data-home"),
      XDG_CONFIG_HOME: join(homeDirectory, "config-home"),
      XDG_STATE_HOME: join(homeDirectory, "state-home"),
      XDG_RUNTIME_DIR: join(homeDirectory, "runtime-home"),
    },
  });
}

function createQuietPrompter() {
  return {
    isInteractive: false,
    writeLine() {},
    async prompt() {
      return "";
    },
    async promptHidden() {
      return "";
    },
  };
}

test("transferBitcoin rejects decimal sat amounts", async () => {
  await assert.rejects(
    () => transferBitcoin({
      amountSatsText: "0.001",
      target: "bc1qignored",
      dataDir: "/tmp",
      databasePath: "/tmp/test.db",
      prompter: createQuietPrompter(),
      assumeYes: true,
    }),
    /wallet_bitcoin_transfer_invalid_amount/,
  );
});

test("transferBitcoin rejects opaque script targets", async () => {
  await assert.rejects(
    () => transferBitcoin({
      amountSatsText: "1200",
      target: `spk:${"0014"}${"22".repeat(20)}`,
      dataDir: "/tmp",
      databasePath: "/tmp/test.db",
      prompter: createQuietPrompter(),
      assumeYes: true,
    }),
    /wallet_bitcoin_transfer_address_required/,
  );
});

test("transferBitcoin rejects self-transfers to the wallet funding script", async (t) => {
  const fundingScriptPubKeyHex = `0014${"11".repeat(20)}`;
  const fundingAddress = renderScriptPubKeyAsAddress(fundingScriptPubKeyHex)!;
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-bitcoin-transfer-self");
  const resolvePaths = createTestRuntimePaths(homeDirectory);
  const paths = resolvePaths();
  const state = createWalletState({
    funding: {
      address: fundingAddress,
      scriptPubKeyHex: fundingScriptPubKeyHex,
    },
  });

  await assert.rejects(
    () => transferBitcoin({
      amountSatsText: "1200",
      target: fundingAddress,
      dataDir: "/tmp",
      databasePath: "/tmp/test.db",
      prompter: createQuietPrompter(),
      assumeYes: true,
      paths,
      openReadContext: async () => ({
        ...createWalletReadContext({
          localState: {
            availability: "ready",
            clientPasswordReadiness: "ready",
            unlockRequired: false,
            state,
            message: null,
          },
        }),
        close: async () => {},
      }),
      attachService: async () => ({ rpc: {} } as any),
      rpcFactory: () => {
        throw new Error("rpcFactory should not be called for self-transfer");
      },
    }),
    /wallet_bitcoin_transfer_self_transfer/,
  );
});

test("transferBitcoin succeeds without indexer state when bitcoind and wallet state are ready", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-bitcoin-transfer");
  const resolvePaths = createTestRuntimePaths(homeDirectory);
  const paths = resolvePaths();
  const fundingScriptPubKeyHex = `0014${"11".repeat(20)}`;
  const fundingAddress = renderScriptPubKeyAsAddress(fundingScriptPubKeyHex)!;
  const recipientScriptPubKeyHex = `0014${"22".repeat(20)}`;
  const recipientAddress = renderScriptPubKeyAsAddress(recipientScriptPubKeyHex)!;
  const state = createWalletState({
    funding: {
      address: fundingAddress,
      scriptPubKeyHex: fundingScriptPubKeyHex,
    },
    managedCoreWallet: {
      ...createWalletState().managedCoreWallet,
      walletAddress: fundingAddress,
      walletScriptPubKeyHex: fundingScriptPubKeyHex,
    },
  });
  let sendRawTransactionCalls = 0;
  let attachServiceLifetime: string | null = null;

  const result = await transferBitcoin({
    amountSatsText: "1234",
    target: recipientAddress,
    dataDir: "/tmp",
    databasePath: "/tmp/test.db",
    prompter: createQuietPrompter(),
    assumeYes: true,
    paths,
    openReadContext: async () => ({
      ...createWalletReadContext({
        localState: {
          availability: "ready",
          clientPasswordReadiness: "ready",
          unlockRequired: false,
          state,
          message: null,
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
        snapshot: null,
        model: null,
      }),
      close: async () => {},
    }),
    attachService: async (options: TransferAttachServiceOptions) => {
      attachServiceLifetime = options.serviceLifetime ?? null;
      return { rpc: {} } as any;
    },
    rpcFactory: () => ({
      async listUnspent() {
        return [{
          txid: "utxo-1",
          vout: 0,
          scriptPubKey: fundingScriptPubKeyHex,
          amount: 0.0001,
          confirmations: 6,
          spendable: true,
          safe: true,
        }];
      },
      async walletCreateFundedPsbt() {
        return {
          psbt: "funded-psbt",
          fee: 0.00000055,
          changepos: 1,
        };
      },
      async decodePsbt() {
        return {
          tx: {
            vin: [{ txid: "utxo-1", vout: 0 }],
            vout: [
              {
                value: 0.00001234,
                scriptPubKey: { hex: recipientScriptPubKeyHex },
              },
              {
                value: 0.00008711,
                scriptPubKey: { hex: fundingScriptPubKeyHex },
              },
            ],
          },
          inputs: [],
        } as never;
      },
      async walletPassphrase() {
        return null;
      },
      async walletProcessPsbt() {
        return {
          psbt: "signed-psbt",
          complete: true,
        };
      },
      async walletLock() {
        return null;
      },
      async finalizePsbt() {
        return {
          complete: true,
          hex: "raw-hex",
        };
      },
      async decodeRawTransaction() {
        return {
          txid: "txid-1",
          hash: "wtxid-1",
        } as never;
      },
      async testMempoolAccept() {
        return [{ allowed: true }];
      },
      async sendRawTransaction() {
        sendRawTransactionCalls += 1;
        return "txid-1";
      },
    }),
  });

  assert.equal(result.amountSats, 1234n);
  assert.equal(result.feeSats, 55n);
  assert.equal(result.senderAddress, fundingAddress);
  assert.equal(result.recipientAddress, recipientAddress);
  assert.equal(result.recipientScriptPubKeyHex, recipientScriptPubKeyHex);
  assert.equal(result.changeAddress, fundingAddress);
  assert.equal(result.txid, "txid-1");
  assert.equal(result.wtxid, "wtxid-1");
  assert.equal(sendRawTransactionCalls, 1);
  assert.equal(attachServiceLifetime, "ephemeral");
});

test("runCli routes bitcoin transfer through the wallet mutation path and renders text output", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  let called = false;

  const exitCode = await runCli(
    ["bitcoin", "transfer", "1234", "--to", "bc1qrecipient", "--yes"],
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: {
        ...process.env,
        COGCOIN_DISABLE_UPDATE_CHECK: "1",
      },
      walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
      createPrompter: () => createQuietPrompter(),
      transferBitcoin: async (options) => {
        called = true;
        assert.equal(options.amountSatsText, "1234");
        assert.equal(options.target, "bc1qrecipient");
        return {
          amountSats: 1234n,
          feeSats: 55n,
          senderAddress: "bc1qsender",
          recipientAddress: "bc1qrecipient",
          recipientScriptPubKeyHex: `0014${"22".repeat(20)}`,
          changeAddress: "bc1qsender",
          txid: "txid-1",
          wtxid: "wtxid-1",
        };
      },
    },
  );

  const rendered = stdout.read();
  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.equal(called, true);
  assert.match(rendered, /Bitcoin transfer submitted\./);
  assert.match(rendered, /Sender: bc1qsender/);
  assert.match(rendered, /Recipient: bc1qrecipient/);
  assert.match(rendered, /Amount: 1234 sats/);
  assert.match(rendered, /Fee: 55 sats/);
  assert.match(rendered, /Txid: txid-1/);
});

test("runCli emits the stable bitcoin transfer json envelope", async () => {
  const stdout = createStringWriter();
  const stderr = createStringWriter();

  const exitCode = await runCli(
    ["bitcoin", "transfer", "1234", "--to", "bc1qrecipient", "--output", "json", "--yes"],
    {
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: {
        ...process.env,
        COGCOIN_DISABLE_UPDATE_CHECK: "1",
      },
      walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
      transferBitcoin: async () => ({
        amountSats: 1234n,
        feeSats: 55n,
        senderAddress: "bc1qsender",
        recipientAddress: "bc1qrecipient",
        recipientScriptPubKeyHex: `0014${"22".repeat(20)}`,
        changeAddress: "bc1qsender",
        txid: "txid-1",
        wtxid: "wtxid-1",
      }),
    },
  );

  const rendered = JSON.parse(stdout.read()) as {
    schema: string;
    outcome: string;
    data: {
      resultType: string;
      operation: {
        kind: string;
        amountSats: string;
        feeSats: string;
        senderAddress: string;
        recipientAddress: string;
        recipientScriptPubKeyHex: string;
        changeAddress: string;
        txid: string;
        wtxid: string;
      };
    };
  };

  assert.equal(exitCode, 0);
  assert.equal(stderr.read(), "");
  assert.equal(rendered.schema, "cogcoin/bitcoin-transfer/v1");
  assert.equal(rendered.outcome, "submitted");
  assert.equal(rendered.data.resultType, "operation");
  assert.equal(rendered.data.operation.kind, "bitcoin-transfer");
  assert.equal(rendered.data.operation.amountSats, "1234");
  assert.equal(rendered.data.operation.feeSats, "55");
  assert.equal(rendered.data.operation.senderAddress, "bc1qsender");
  assert.equal(rendered.data.operation.recipientAddress, "bc1qrecipient");
  assert.equal(rendered.data.operation.changeAddress, "bc1qsender");
  assert.equal(rendered.data.operation.txid, "txid-1");
  assert.equal(rendered.data.operation.wtxid, "wtxid-1");
});
