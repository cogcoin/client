import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MemoryWalletSecretProvider,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  executeWalletMutationOperation,
  publishWalletMutation,
  resolveExistingWalletMutation,
} from "../src/wallet/tx/executor.js";
import type { PendingMutationRecord } from "../src/wallet/types.js";
import { createWalletReadContext, createWalletState } from "./current-model-helpers.js";

async function createTestRuntimePaths() {
  const homeDirectory = await mkdtemp(join(tmpdir(), "cogcoin-wallet-mutation-"));
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    env: {},
    platform: process.platform,
  });
  await mkdir(paths.walletStateDirectory, { recursive: true });
  await mkdir(paths.runtimeRoot, { recursive: true });
  return paths;
}

async function seedWalletSecret(
  provider: MemoryWalletSecretProvider,
  walletRootId: string,
): Promise<void> {
  const secretReference = createWalletSecretReference(walletRootId);
  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 7));
}

function createMutation(overrides: Partial<PendingMutationRecord> = {}): PendingMutationRecord {
  return {
    mutationId: "mutation-1",
    kind: "register",
    domainName: "alpha",
    parentDomainName: null,
    senderScriptPubKeyHex: "0014" + "11".repeat(20),
    senderLocalIndex: 0,
    intentFingerprintHex: "aa".repeat(32),
    status: "draft",
    createdAtUnixMs: 1,
    lastUpdatedAtUnixMs: 1,
    attemptedTxid: null,
    attemptedWtxid: null,
    selectedFeeRateSatVb: 5,
    feeSelectionSource: "fallback-default",
    temporaryBuilderLockedOutpoints: [],
    ...overrides,
  };
}

test("executeWalletMutationOperation preserves the shared mutation stage order", async () => {
  const state = createWalletState();
  const paths = await createTestRuntimePaths();
  const provider = new MemoryWalletSecretProvider();
  await seedWalletSecret(provider, state.walletRootId);
  const order: string[] = [];
  const readContext = createWalletReadContext({
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
    close: async () => {
      order.push("close");
    },
  });

  const execution = await executeWalletMutationOperation<
    { state: ReturnType<typeof createWalletState> },
    any,
    string,
    any,
    { txid: string | null; fees: { feeRateSatVb: number; feeSats: string | null; source: string } }
  >({
    dataDir: "/tmp",
    databasePath: "/tmp/client.sqlite",
    provider,
    nowUnixMs: 123,
    paths,
    feeRateSatVb: 7,
    controlLockPurpose: "wallet-test",
    preemptionReason: "wallet-test",
    openReadContext: async () => {
      order.push("open");
      return readContext;
    },
    attachService: async () => {
      order.push("attach");
      return {
        rpc: {
          url: "http://127.0.0.1:8332",
          username: "rpc",
          password: "rpc",
        },
      } as any;
    },
    rpcFactory: () => {
      order.push("rpc");
      return {
        listUnspent: async () => [],
        walletCreateFundedPsbt: async () => ({ psbt: "psbt", fee: 0.00000011, changepos: 1 }),
        decodePsbt: async () => ({ tx: { txid: "aa".repeat(32), hash: "bb".repeat(32), vin: [], vout: [] }, inputs: [] }),
        walletPassphrase: async () => null,
        walletProcessPsbt: async () => ({ psbt: "signed", complete: true }),
        walletLock: async () => null,
        finalizePsbt: async () => ({ complete: true, hex: "raw" }),
        decodeRawTransaction: async () => ({ txid: "bb".repeat(32), hash: "cc".repeat(32), vin: [], vout: [] }),
        testMempoolAccept: async () => [{ allowed: true }],
        getBlockchainInfo: async () => ({ blocks: 100 }),
        sendRawTransaction: async () => "bb".repeat(32),
      } as any;
    },
    resolveOperation() {
      order.push("resolve");
      return { state };
    },
    createIntentFingerprint() {
      order.push("intent");
      return "intent-1";
    },
    async resolveExistingMutation({ operation }) {
      order.push("existing");
      return {
        state: operation.state,
        replacementFixedInputs: null,
        result: null,
      };
    },
    async confirm() {
      order.push("confirm");
    },
    createDraftMutation({ execution, intentFingerprintHex }) {
      order.push("draft");
      return {
        mutation: createMutation({
          intentFingerprintHex,
          selectedFeeRateSatVb: execution.feeSelection.feeRateSatVb,
          feeSelectionSource: execution.feeSelection.source,
        }),
        prepared: "prepared",
      };
    },
    async build({ prepared }) {
      order.push(`build:${prepared}`);
      return {
        funded: { psbt: "psbt", fee: 0.00000011, changepos: 1 },
        decoded: { tx: { vin: [], vout: [] }, inputs: [] },
        psbt: "psbt",
        rawHex: "raw",
        txid: "bb".repeat(32),
        wtxid: "cc".repeat(32),
        temporaryBuilderLockedOutpoints: [],
      };
    },
    async publish({ state, mutation, built, prepared }) {
      order.push(`publish:${prepared}`);
      return {
        state,
        mutation: {
          ...mutation,
          status: "live",
          attemptedTxid: built.txid,
          attemptedWtxid: built.wtxid,
        },
        status: "live",
      };
    },
    createResult({ mutation, prepared, fees }) {
      order.push(`result:${prepared}`);
      return {
        txid: mutation.attemptedTxid,
        fees,
      };
    },
  });

  assert.deepEqual(order, [
    "open",
    "resolve",
    "attach",
    "rpc",
    "intent",
    "existing",
    "confirm",
    "draft",
    "build:prepared",
    "publish:prepared",
    "result:prepared",
    "close",
  ]);
  assert.equal(execution.reusedExisting, false);
  assert.equal(execution.result.txid, "bb".repeat(32));
});

test("resolveExistingWalletMutation returns a reuse result when the prior mutation can be kept", async () => {
  const state = createWalletState();
  const mutation = createMutation({
    status: "confirmed",
    attemptedTxid: "bb".repeat(32),
  });

  const resolved = await resolveExistingWalletMutation({
    existingMutation: mutation,
    execution: {
      rpc: {
        getTransaction: async () => ({
          txid: mutation.attemptedTxid!,
          confirmations: 1,
          decoded: {
            txid: mutation.attemptedTxid!,
            vin: [],
            vout: [],
          },
        }),
      } as any,
      walletName: "wallet.dat",
      feeSelection: {
        feeRateSatVb: 12,
        source: "custom-satvb",
      },
    },
    repairRequiredErrorCode: "wallet_test_repair_required",
    reconcileExistingMutation: async () => ({
      state,
      mutation,
      resolution: "confirmed",
    }),
    createReuseResult: ({ mutation, resolution, fees }) => ({
      txid: mutation.attemptedTxid,
      resolution,
      fees,
    }),
  });

  assert.deepEqual(resolved.result, {
    txid: "bb".repeat(32),
    resolution: "confirmed",
    fees: {
      feeRateSatVb: 5,
      feeSats: null,
      source: "fallback-default",
    },
  });
  assert.equal(resolved.replacementFixedInputs, null);
});

test("resolveExistingWalletMutation requests replacement fixed inputs when the fee needs to increase", async () => {
  const mutation = createMutation({
    status: "live",
    attemptedTxid: "bb".repeat(32),
  });

  const resolved = await resolveExistingWalletMutation({
    existingMutation: mutation,
    execution: {
      rpc: {
        getTransaction: async () => ({
          txid: mutation.attemptedTxid!,
          confirmations: 0,
          decoded: {
            txid: mutation.attemptedTxid!,
            vin: [{ txid: "cc".repeat(32), vout: 2 }],
            vout: [],
          },
        }),
      } as any,
      walletName: "wallet.dat",
      feeSelection: {
        feeRateSatVb: 9,
        source: "custom-satvb",
      },
    },
    repairRequiredErrorCode: "wallet_test_repair_required",
    reconcileExistingMutation: async () => ({
      state: createWalletState(),
      mutation,
      resolution: "live",
    }),
    createReuseResult: () => {
      throw new Error("should_not_reuse");
    },
  });

  assert.equal(resolved.result, null);
  assert.deepEqual(resolved.replacementFixedInputs, [
    { txid: "cc".repeat(32), vout: 2 },
  ]);
});

test("publishWalletMutation maps network timeouts to broadcast-unknown errors", async () => {
  const provider = new MemoryWalletSecretProvider();
  const paths = await createTestRuntimePaths();
  const state = createWalletState({
    pendingMutations: [createMutation()],
  });
  await seedWalletSecret(provider, state.walletRootId);
  const mutation = state.pendingMutations![0]!;
  let unlockCalls = 0;

  await assert.rejects(
    publishWalletMutation({
      rpc: {
        getBlockchainInfo: async () => ({ blocks: 100 }),
        sendRawTransaction: async () => {
          throw new Error("socket hang up");
        },
        lockUnspent: async () => {
          unlockCalls += 1;
          return true;
        },
      },
      walletName: state.managedCoreWallet.walletName,
      snapshotHeight: 100,
      built: {
        funded: { psbt: "psbt", fee: 0.00000011, changepos: 1 },
        decoded: { tx: { txid: "aa".repeat(32), hash: "bb".repeat(32), vin: [], vout: [] }, inputs: [] },
        psbt: "psbt",
        rawHex: "raw",
        txid: "dd".repeat(32),
        wtxid: "ee".repeat(32),
        temporaryBuilderLockedOutpoints: [{ txid: "ff".repeat(32), vout: 0 }],
      },
      mutation,
      state,
      provider,
      nowUnixMs: 321,
      paths,
      errorPrefix: "wallet_test",
    }),
    /wallet_test_broadcast_unknown/,
  );

  assert.equal(unlockCalls, 0);
});
