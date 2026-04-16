import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { WalletReadContext } from "../src/wallet/read/index.js";
import { createWalletReadModel } from "../src/wallet/read/index.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import { createMemoryWalletSecretProviderForTesting, createWalletSecretReference } from "../src/wallet/state/provider.js";
import { loadWalletState } from "../src/wallet/state/storage.js";
import { claimCogLock, lockCogToDomain, reclaimCogLock, sendCog } from "../src/wallet/tx/index.js";
import type { WalletPrompter } from "../src/wallet/lifecycle.js";
import type { WalletStateV1 } from "../src/wallet/types.js";
import { replayBlocks } from "./bitcoind-helpers.js";
import { loadHistoryVector, materializeBlock } from "./helpers.js";

function encodeOpReturnScript(payloadHex: string): string {
  const payload = Buffer.from(payloadHex, "hex");
  return Buffer.concat([Buffer.from([0x6a, payload.length]), payload]).toString("hex");
}

function createWalletState(partial: Partial<WalletStateV1> = {}): WalletStateV1 {
  return {
    schemaVersion: 1,
    stateRevision: 1,
    lastWrittenAtUnixMs: 1_700_000_000_000,
    walletRootId: "wallet-root-test",
    network: "mainnet",
    anchorValueSats: 2_000,
    nextDedicatedIndex: 3,
    fundingIndex: 0,
    mnemonic: {
      phrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
      language: "english",
    },
    keys: {
      masterFingerprintHex: "1234abcd",
      accountPath: "m/84'/0'/0'",
      accountXprv: "xprv-test",
      accountXpub: "xpub-test",
    },
    descriptor: {
      privateExternal: "wpkh([1234abcd/84h/0h/0h]xprv-test/0/*)#priv",
      publicExternal: "wpkh([1234abcd/84h/0h/0h]xpub-test/0/*)#pub",
      checksum: "priv",
      rangeEnd: 4095,
      safetyMargin: 128,
    },
    funding: {
      address: "bc1qfundingidentity0000000000000000000000000",
      scriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    },
    walletBirthTime: 1_700_000_000,
    managedCoreWallet: {
      walletName: "cogcoin-wallet-root-test",
      internalPassphrase: "core-passphrase",
      descriptorChecksum: "priv",
      fundingAddress0: "bc1qfundingidentity0000000000000000000000000",
      fundingScriptPubKeyHex0: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
      proofStatus: "ready",
      lastImportedAtUnixMs: 1_700_000_000_000,
      lastVerifiedAtUnixMs: 1_700_000_000_000,
    },
    identities: [
      {
        index: 0,
        scriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
        address: "bc1qfundingidentity0000000000000000000000000",
        status: "funding",
        assignedDomainNames: [],
      },
      {
        index: 1,
        scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
        address: "bc1qalphaowner0000000000000000000000000000",
        status: "dedicated",
        assignedDomainNames: ["alpha"],
      },
      {
        index: 2,
        scriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
        address: "bc1qbetaowner00000000000000000000000000000",
        status: "dedicated",
        assignedDomainNames: ["beta"],
      },
    ],
    domains: [
      {
        name: "alpha",
        domainId: 1,
        dedicatedIndex: 1,
        currentOwnerScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
        currentOwnerLocalIndex: 1,
        canonicalChainStatus: "anchored",
        localAnchorIntent: "none",
        currentCanonicalAnchorOutpoint: {
          txid: "aa".repeat(32),
          vout: 1,
          valueSats: 2_000,
        },
        foundingMessageText: "alpha founded",
        birthTime: 1_700_000_000,
      },
      {
        name: "beta",
        domainId: 2,
        dedicatedIndex: 2,
        currentOwnerScriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
        currentOwnerLocalIndex: 2,
        canonicalChainStatus: "anchored",
        localAnchorIntent: "none",
        currentCanonicalAnchorOutpoint: {
          txid: "bb".repeat(32),
          vout: 1,
          valueSats: 2_000,
        },
        foundingMessageText: "beta founded",
        birthTime: 1_700_000_001,
      },
    ],
    miningState: {
      runMode: "stopped",
      state: "idle",
      pauseReason: null,
      currentPublishState: "none",
      currentDomain: null,
      currentDomainId: null,
      currentDomainIndex: null,
      currentSenderScriptPubKeyHex: null,
      currentTxid: null,
      currentWtxid: null,
      currentFeeRateSatVb: null,
      currentAbsoluteFeeSats: null,
      currentScore: null,
      currentSentence: null,
      currentEncodedSentenceBytesHex: null,
      currentBip39WordIndices: null,
      currentBlendSeedHex: null,
      currentBlockTargetHeight: null,
      currentReferencedBlockHashDisplay: null,
      currentIntentFingerprintHex: null,
      liveMiningFamilyInMempool: false,
      currentPublishDecision: null,
      replacementCount: 0,
      currentBlockFeeSpentSats: "0",
      sessionFeeSpentSats: "0",
      lifetimeFeeSpentSats: "0",
      sharedMiningConflictOutpoint: null,
    },
    hookClientState: {
      mining: {
        mode: "builtin",
        validationState: "unknown",
        lastValidationAtUnixMs: null,
        lastValidationError: null,
        validatedLaunchFingerprint: null,
        validatedFullFingerprint: null,
        fullTrustWarningAcknowledgedAtUnixMs: null,
        consecutiveFailureCount: 0,
        cooldownUntilUnixMs: null,
      },
    },
    proactiveFamilies: [],
    pendingMutations: [],
    ...partial,
  };
}

async function createSnapshotState() {
  const vector = loadHistoryVector();
  const state = await replayBlocks([
    ...vector.setupBlocks.map(materializeBlock),
    ...vector.testBlocks.map(materializeBlock),
  ]);
  state.consensus.balances.set("0014ed495c1face9da3c7028519dbb36576c37f90e56", 1_000n);
  state.consensus.balances.set("001400a654e135b542d1a605d607c08e2218a178788d", 500n);
  state.consensus.balances.set("00145f5a03d6c7c88648b5f947459b769008ced5a020", 700n);
  return state;
}

function createTempWalletPaths(root: string) {
  return resolveWalletRuntimePathsForTesting({
    platform: "linux",
    homeDirectory: root,
    env: {
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
    },
  });
}

class ScriptedPrompter implements WalletPrompter {
  readonly isInteractive = true;
  readonly lines: string[] = [];

  constructor(private readonly answers: string[]) {}

  writeLine(message: string): void {
    this.lines.push(message);
  }

  async prompt(): Promise<string> {
    return this.answers.shift() ?? "yes";
  }
}

function createReadContext(
  state: WalletStateV1,
  snapshotState: Awaited<ReturnType<typeof createSnapshotState>>,
): WalletReadContext {
  const snapshot = {
    state: snapshotState,
    tip: {
      height: snapshotState.history.currentHeight ?? 0,
      blockHashHex: "03".repeat(32),
      previousHashHex: "02".repeat(32),
      stateHashHex: "aa".repeat(32),
    },
  };
  return {
    dataDir: "/tmp/bitcoin",
    databasePath: "/tmp/client.sqlite",
    localState: {
      availability: "ready",
      walletRootId: state.walletRootId,
      state,
      source: "primary",
      unlockUntilUnixMs: 1_700_000_900_000,
      hasPrimaryStateFile: true,
      hasBackupStateFile: false,
      hasUnlockSessionFile: true,
      message: null,
    },
    bitcoind: {
      health: "ready",
      status: null,
      message: null,
    },
    nodeStatus: {
      ready: true,
      chain: "main",
      pid: 123,
      walletRootId: state.walletRootId,
      nodeBestHeight: snapshot.tip.height,
      nodeBestHashHex: snapshot.tip.blockHashHex,
      nodeHeaderHeight: snapshot.tip.height,
      serviceUpdatedAtUnixMs: 1_700_000_000_000,
      serviceStatus: null,
      walletReplica: {
        walletRootId: state.walletRootId,
        walletName: state.managedCoreWallet.walletName,
        loaded: true,
        descriptors: true,
        privateKeysEnabled: true,
        created: false,
        proofStatus: "ready",
        descriptorChecksum: state.managedCoreWallet.descriptorChecksum,
        fundingAddress0: state.managedCoreWallet.fundingAddress0,
        fundingScriptPubKeyHex0: state.managedCoreWallet.fundingScriptPubKeyHex0,
        message: null,
      },
      walletReplicaMessage: null,
    },
    nodeHealth: "synced",
    nodeMessage: null,
    indexer: {
      health: "synced",
      status: null,
      message: null,
      snapshotTip: snapshot.tip,
    },
    snapshot,
    model: createWalletReadModel(state, snapshot),
    async close() {},
  };
}

function createCogRpcHarness(options: {
  snapshotHeight: number;
  fundingScriptPubKeyHex: string;
  fundingAddress: string;
  senderScriptPubKeyHex: string;
  senderAddress: string;
  anchorOutpoint?: { txid: string; vout: number } | null;
  additionalKnownTxids?: string[];
}) {
  const captured: {
    inputs?: Array<{ txid: string; vout: number }>;
    outputs?: unknown[];
    options?: Record<string, unknown>;
    decoded?: { vin: Array<{ prevout: { scriptPubKey: { hex: string } } }>; vout: Array<{ n: number; value: number; scriptPubKey: { hex: string } }> };
    sentRawHex?: string;
  } = {};
  const locked: Array<{ txid: string; vout: number }> = [];
  const knownTxids = new Set(options.additionalKnownTxids ?? []);

  function renderOutput(output: unknown): { value: number; scriptPubKey: { hex: string } } {
    if (typeof output === "object" && output !== null && "data" in output) {
      const payloadHex = String((output as { data: string }).data);
      return {
        value: 0,
        scriptPubKey: {
          hex: encodeOpReturnScript(payloadHex),
        },
      };
    }

    const [address, value] = Object.entries(output as Record<string, number>)[0]!;
    return {
      value,
      scriptPubKey: {
        hex: address === options.senderAddress ? options.senderScriptPubKeyHex : options.fundingScriptPubKeyHex,
      },
    };
  }

  function buildDecoded() {
    const fixedInputs = captured.inputs ?? [];
    const supplementalFundingInputs = [
      { txid: "11".repeat(32), vout: 0 },
      { txid: "22".repeat(32), vout: 0 },
    ].filter((input) => !fixedInputs.some((entry) => entry.txid === input.txid && entry.vout === input.vout));
    const inputs = fixedInputs.concat(supplementalFundingInputs.slice(0, 1));
    const outputs = (captured.outputs ?? []).map((output) => renderOutput(output));
    const changePosition = Number(captured.options?.changePosition ?? 0);
    const withChange = outputs.slice();
    withChange.splice(changePosition, 0, {
      value: 0.00001,
      scriptPubKey: {
        hex: options.fundingScriptPubKeyHex,
      },
    });
    const vin = inputs.map((input) => ({
      txid: input.txid,
      vout: input.vout,
      prevout: {
        scriptPubKey: {
          hex: input.txid === options.anchorOutpoint?.txid && input.vout === options.anchorOutpoint.vout
            ? options.senderScriptPubKeyHex
            : input.txid === "33".repeat(32)
              ? options.senderScriptPubKeyHex
              : options.fundingScriptPubKeyHex,
        },
      },
    }));
    captured.decoded = {
      vin,
      vout: withChange.map((output, index) => ({
        n: index,
        ...output,
      })),
    };
    return captured.decoded;
  }

  return {
    captured,
    rpcFactory() {
      return {
        async getBlockchainInfo() {
          return { blocks: options.snapshotHeight };
        },
        async listUnspent() {
          const entries = [
            {
              txid: "11".repeat(32),
              vout: 0,
              scriptPubKey: options.fundingScriptPubKeyHex,
              amount: 0.02,
              confirmations: 12,
              spendable: true,
              safe: true,
              address: options.fundingAddress,
            },
            {
              txid: "22".repeat(32),
              vout: 0,
              scriptPubKey: options.fundingScriptPubKeyHex,
              amount: 0.01,
              confirmations: 8,
              spendable: true,
              safe: true,
              address: options.fundingAddress,
            },
          ];

          if (options.anchorOutpoint !== undefined && options.anchorOutpoint !== null) {
            entries.push({
              txid: options.anchorOutpoint.txid,
              vout: options.anchorOutpoint.vout,
              scriptPubKey: options.senderScriptPubKeyHex,
              amount: 0.00002,
              confirmations: 9,
              spendable: true,
              safe: true,
              address: options.senderAddress,
            });
          } else if (options.senderScriptPubKeyHex !== options.fundingScriptPubKeyHex) {
            entries.push({
              txid: "33".repeat(32),
              vout: 0,
              scriptPubKey: options.senderScriptPubKeyHex,
              amount: 0.00002,
              confirmations: 9,
              spendable: true,
              safe: true,
              address: options.senderAddress,
            });
          }

          return entries;
        },
        async listLockUnspent() {
          return locked.slice();
        },
        async lockUnspent(_walletName: string, unlock: boolean, outputs: Array<{ txid: string; vout: number }>) {
          if (unlock) {
            for (const output of outputs) {
              const index = locked.findIndex((entry) => entry.txid === output.txid && entry.vout === output.vout);
              if (index >= 0) {
                locked.splice(index, 1);
              }
            }
          } else {
            locked.push(...outputs);
          }
          return true;
        },
        async walletCreateFundedPsbt(_walletName: string, inputs: Array<{ txid: string; vout: number }>, outputs: unknown[], _locktime: number, builderOptions: Record<string, unknown>) {
          captured.inputs = inputs;
          captured.outputs = outputs;
          captured.options = builderOptions;
          locked.push({ txid: "ff".repeat(32), vout: 1 });
          return {
            psbt: "psbt",
            fee: 0.00001,
            changepos: Number(builderOptions.changePosition ?? 0),
          };
        },
        async decodePsbt() {
          const decoded = buildDecoded();
          return {
            tx: {
              txid: "44".repeat(32),
              vin: decoded.vin,
              vout: decoded.vout,
            },
          };
        },
        async walletProcessPsbt() {
          return { psbt: "signed", complete: true };
        },
        async finalizePsbt() {
          return { complete: true, hex: "deadbeef" };
        },
        async decodeRawTransaction() {
          return {
            txid: "55".repeat(32),
            hash: "66".repeat(32),
            vin: buildDecoded().vin,
            vout: buildDecoded().vout,
          };
        },
        async testMempoolAccept() {
          return [{ allowed: true, txid: "55".repeat(32), wtxid: "66".repeat(32) }];
        },
        async sendRawTransaction(hex: string) {
          captured.sentRawHex = hex;
          knownTxids.add("55".repeat(32));
          return "55".repeat(32);
        },
        async getRawTransaction(txid: string) {
          if (!knownTxids.has(txid)) {
            throw new Error("not_found");
          }
          return {
            txid,
            hash: "66".repeat(32),
            vin: buildDecoded().vin,
            vout: buildDecoded().vout,
          };
        },
      };
    },
  };
}

test("sendCog preserves anchored sender vin[0] and anchor output", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-cog-send-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  const snapshotState = await createSnapshotState();
  const context = createReadContext(state, snapshotState);
  const harness = createCogRpcHarness({
    snapshotHeight: snapshotState.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
    senderAddress: state.identities[1]!.address!,
    anchorOutpoint: state.domains[0]!.currentCanonicalAnchorOutpoint!,
  });
  const secretReference = createWalletSecretReference(state.walletRootId);
  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 5));
  const prompter = new ScriptedPrompter(["yes"]);

  const result = await sendCog({
    amountCogtoshi: 25n,
    target: "spk:00141111111111111111111111111111111111111111",
    fromIdentity: "id:1",
    dataDir: "/tmp/bitcoin",
    databasePath: "/tmp/client.sqlite",
    provider,
    prompter,
    paths,
    openReadContext: async () => context,
    attachService: async () => ({ rpc: {} } as never),
    rpcFactory: harness.rpcFactory,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.status, "live");
  assert.equal(result.kind, "send");
  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
      address: state.identities[1]!.address!,
    },
    claimPath: null,
  });
  assert.equal(saved.state.pendingMutations?.[0]?.kind, "send");
  assert.equal(saved.state.pendingMutations?.[0]?.amountCogtoshi, 25n);
  assert.equal(harness.captured.decoded?.vin[0]?.prevout.scriptPubKey.hex, state.identities[1]!.scriptPubKeyHex);
  assert.equal(harness.captured.decoded?.vout[1]?.scriptPubKey.hex, state.identities[1]!.scriptPubKeyHex);
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
});

test("sendCog requires explicit --from when multiple local identities are eligible", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-cog-send-ambiguous-"));
  const paths = createTempWalletPaths(tempRoot);
  const state = createWalletState();
  const snapshotState = await createSnapshotState();
  const context = createReadContext(state, snapshotState);
  let observedWalletControlLockHeld: boolean | undefined;

  await assert.rejects(() => sendCog({
    amountCogtoshi: 25n,
    target: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
    dataDir: "/tmp/bitcoin",
    databasePath: "/tmp/client.sqlite",
    paths,
    provider: createMemoryWalletSecretProviderForTesting(),
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async (options) => {
      observedWalletControlLockHeld = options.walletControlLockHeld;
      return context;
    },
  }), /wallet_send_ambiguous_sender/);

  assert.equal(observedWalletControlLockHeld, true);
});

test("sendCog auto-selects the only eligible sender and surfaces the resolved sender", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-cog-send-autoselect-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  state.identities = state.identities.map((identity) =>
    identity.index === 2 ? { ...identity, status: "read-only" } : identity
  );
  const snapshotState = await createSnapshotState();
  snapshotState.consensus.balances.set(state.identities[0]!.scriptPubKeyHex, 0n);
  const context = createReadContext(state, snapshotState);
  const harness = createCogRpcHarness({
    snapshotHeight: snapshotState.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
    senderAddress: state.identities[1]!.address!,
    anchorOutpoint: state.domains[0]!.currentCanonicalAnchorOutpoint!,
  });
  const secretReference = createWalletSecretReference(state.walletRootId);
  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 5));

  const result = await sendCog({
    amountCogtoshi: 25n,
    target: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
    dataDir: "/tmp/bitcoin",
    databasePath: "/tmp/client.sqlite",
    provider,
    prompter: new ScriptedPrompter(["yes"]),
    paths,
    openReadContext: async () => context,
    attachService: async () => ({ rpc: {} } as never),
    rpcFactory: harness.rpcFactory,
  });

  assert.equal(result.resolved.sender.selector, "id:1");
});

test("lockCogToDomain converts relative timeout to absolute height and stores the lock mutation", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-cog-lock-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  const snapshotState = await createSnapshotState();
  const context = createReadContext(state, snapshotState);
  const harness = createCogRpcHarness({
    snapshotHeight: snapshotState.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
    senderAddress: state.identities[1]!.address!,
    anchorOutpoint: state.domains[0]!.currentCanonicalAnchorOutpoint!,
  });
  const secretReference = createWalletSecretReference(state.walletRootId);
  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 5));
  const prompter = new ScriptedPrompter(["yes"]);

  const currentHeight = snapshotState.history.currentHeight ?? 0;
  const result = await lockCogToDomain({
    amountCogtoshi: 75n,
    recipientDomainName: "beta",
    fromIdentity: "domain:alpha",
    timeoutBlocksOrDuration: "6h",
    conditionHex: "22".repeat(32),
    dataDir: "/tmp/bitcoin",
    databasePath: "/tmp/client.sqlite",
    provider,
    prompter,
    paths,
    openReadContext: async () => context,
    attachService: async () => ({ rpc: {} } as never),
    rpcFactory: harness.rpcFactory,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
      address: state.identities[1]!.address!,
    },
    claimPath: null,
  });
  assert.equal(saved.state.pendingMutations?.[0]?.kind, "lock");
  assert.equal(saved.state.pendingMutations?.[0]?.recipientDomainName, "beta");
  assert.equal(saved.state.pendingMutations?.[0]?.timeoutHeight, currentHeight + 36);
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Resolved timeout height: /);
});

test("lockCogToDomain auto-selects the only eligible sender and surfaces the resolved sender", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-cog-lock-autoselect-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  state.identities = state.identities.map((identity) =>
    identity.index === 2 ? { ...identity, status: "read-only" } : identity
  );
  const snapshotState = await createSnapshotState();
  snapshotState.consensus.balances.set(state.identities[0]!.scriptPubKeyHex, 0n);
  const context = createReadContext(state, snapshotState);
  const harness = createCogRpcHarness({
    snapshotHeight: snapshotState.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
    senderAddress: state.identities[1]!.address!,
    anchorOutpoint: state.domains[0]!.currentCanonicalAnchorOutpoint!,
  });
  const secretReference = createWalletSecretReference(state.walletRootId);
  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 5));

  const result = await lockCogToDomain({
    amountCogtoshi: 75n,
    recipientDomainName: "beta",
    timeoutBlocksOrDuration: "6h",
    conditionHex: "22".repeat(32),
    dataDir: "/tmp/bitcoin",
    databasePath: "/tmp/client.sqlite",
    provider,
    prompter: new ScriptedPrompter(["yes"]),
    paths,
    openReadContext: async () => context,
    attachService: async () => ({ rpc: {} } as never),
    rpcFactory: harness.rpcFactory,
  });

  assert.equal(result.resolved.sender.selector, "id:1");
});

test("claimCogLock resolves the recipient-owner path, surfaces the sender, and keeps the preimage warning", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-cog-claim-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  const snapshotState = await createSnapshotState();
  const currentHeight = snapshotState.history.currentHeight ?? 0;
  const correctPreimage = Buffer.alloc(32, 7);
  snapshotState.consensus.locks.set(91, {
    lockId: 91,
    lockerScriptPubKey: Buffer.from(state.identities[0]!.scriptPubKeyHex, "hex"),
    amount: 100n,
    condition: createHash("sha256").update(correctPreimage).digest(),
    timeoutHeight: currentHeight + 20,
    recipientDomainId: 1,
    creationHeight: currentHeight - 1,
  });
  const context = createReadContext(state, snapshotState);
  const harness = createCogRpcHarness({
    snapshotHeight: snapshotState.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
    senderAddress: state.identities[1]!.address!,
    anchorOutpoint: state.domains[0]!.currentCanonicalAnchorOutpoint!,
  });
  const secretReference = createWalletSecretReference(state.walletRootId);
  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 5));
  const prompter = new ScriptedPrompter(["yes"]);

  const result = await claimCogLock({
    lockId: 91,
    preimageHex: correctPreimage.toString("hex"),
    dataDir: "/tmp/bitcoin",
    databasePath: "/tmp/client.sqlite",
    provider,
    prompter,
    paths,
    openReadContext: async () => context,
    attachService: async () => ({ rpc: {} } as never),
    rpcFactory: harness.rpcFactory,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
      address: state.identities[1]!.address!,
    },
    claimPath: "recipient-claim",
  });
  assert.equal(saved.state.pendingMutations?.[0]?.kind, "claim");
  assert.equal(saved.state.pendingMutations?.[0]?.lockId, 91);
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Resolved path: recipient-claim\./);
  assert.match(prompter.lines.join("\n"), /Warning: the claim preimage becomes public in the mempool and on-chain\./);
});

test("claimCogLock rejects a wrong preimage before attempting any broadcast", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-cog-claim-mismatch-"));
  const paths = createTempWalletPaths(tempRoot);
  const state = createWalletState();
  const snapshotState = await createSnapshotState();
  const currentHeight = snapshotState.history.currentHeight ?? 0;
  const correctPreimage = Buffer.alloc(32, 7);
  snapshotState.consensus.locks.set(91, {
    lockId: 91,
    lockerScriptPubKey: Buffer.from(state.identities[0]!.scriptPubKeyHex, "hex"),
    amount: 100n,
    condition: createHash("sha256").update(correctPreimage).digest(),
    timeoutHeight: currentHeight + 20,
    recipientDomainId: 1,
    creationHeight: currentHeight - 1,
  });
  const context = createReadContext(state, snapshotState);

  await assert.rejects(() => claimCogLock({
    lockId: 91,
    preimageHex: "33".repeat(32),
    dataDir: "/tmp/bitcoin",
    databasePath: "/tmp/client.sqlite",
    paths,
    provider: createMemoryWalletSecretProviderForTesting(),
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => context,
  }), /wallet_claim_preimage_mismatch/);
});

test("reclaimCogLock uses the canonical all-zero preimage", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-cog-reclaim-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  const snapshotState = await createSnapshotState();
  const currentHeight = snapshotState.history.currentHeight ?? 0;
  snapshotState.consensus.locks.set(92, {
    lockId: 92,
    lockerScriptPubKey: Buffer.from(state.identities[1]!.scriptPubKeyHex, "hex"),
    amount: 125n,
    condition: Buffer.alloc(32, 9),
    timeoutHeight: currentHeight - 1,
    recipientDomainId: 2,
    creationHeight: currentHeight - 20,
  });
  const context = createReadContext(state, snapshotState);
  const harness = createCogRpcHarness({
    snapshotHeight: snapshotState.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
    senderAddress: state.identities[1]!.address!,
    anchorOutpoint: state.domains[0]!.currentCanonicalAnchorOutpoint!,
  });
  const secretReference = createWalletSecretReference(state.walletRootId);
  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 5));
  const prompter = new ScriptedPrompter(["yes"]);

  const result = await reclaimCogLock({
    lockId: 92,
    dataDir: "/tmp/bitcoin",
    databasePath: "/tmp/client.sqlite",
    provider,
    prompter,
    paths,
    openReadContext: async () => context,
    attachService: async () => ({ rpc: {} } as never),
    rpcFactory: harness.rpcFactory,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
      address: state.identities[1]!.address!,
    },
    claimPath: "timeout-reclaim",
  });
  assert.equal(saved.state.pendingMutations?.[0]?.kind, "claim");
  assert.equal(saved.state.pendingMutations?.[0]?.preimageHex, "00".repeat(32));
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Resolved path: timeout-reclaim\./);
});
