import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { serializeIndexerState } from "@cogcoin/indexer";
import { encodeSentence } from "@cogcoin/scoring";
import {
  INDEXER_DAEMON_SCHEMA_VERSION,
  INDEXER_DAEMON_SERVICE_API_VERSION,
} from "../src/bitcoind/types.js";

import {
  FIELD_FORMAT_BYTES,
  serializeDataUpdate,
  serializeFieldReg,
  serializeRepCommit,
  serializeRepRevoke,
  serializeSetCanonical,
  serializeSetDelegate,
  serializeSetEndpoint,
  serializeSetMiner,
} from "../src/wallet/cogop/index.js";
import { createWalletReadModel, type WalletReadContext } from "../src/wallet/read/index.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import { createMemoryWalletSecretProviderForTesting, createWalletSecretReference } from "../src/wallet/state/provider.js";
import { saveUnlockSession } from "../src/wallet/state/session.js";
import { loadWalletState, saveWalletState } from "../src/wallet/state/storage.js";
import {
  deriveWalletIdentityMaterial,
  deriveWalletMaterialFromMnemonic,
} from "../src/wallet/material.js";
import {
  anchorDomain,
  buyDomain,
  clearPendingAnchor,
  clearDomainDelegate,
  clearDomainEndpoint,
  clearDomainMiner,
  clearField,
  createField,
  giveReputation,
  registerDomain,
  revokeReputation,
  setField,
  setDomainCanonical,
  setDomainDelegate,
  setDomainEndpoint,
  setDomainMiner,
  sellDomain,
  transferDomain,
} from "../src/wallet/tx/index.js";
import type { WalletPrompter } from "../src/wallet/lifecycle.js";
import type { WalletStateV1 } from "../src/wallet/types.js";
import { replayBlocks } from "./bitcoind-helpers.js";
import { loadHistoryVector, materializeBlock } from "./helpers.js";

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

function encodeOpReturnScript(payloadHex: string): string {
  const payload = Buffer.from(payloadHex, "hex");
  if (payload.length <= 75) {
    return Buffer.concat([Buffer.from([0x6a, payload.length]), payload]).toString("hex");
  }

  return Buffer.concat([Buffer.from([0x6a, 0x4c, payload.length]), payload]).toString("hex");
}

function sameOutpoint(
  left: { txid: string; vout: number },
  right: { txid: string; vout: number },
): boolean {
  return left.txid === right.txid && left.vout === right.vout;
}

function appendSupplementalFundingInputs(
  fixedInputs: Array<{ txid: string; vout: number }>,
  supplementalCandidates: Array<{ txid: string; vout: number }>,
  maxSupplemental = 1,
): Array<{ txid: string; vout: number }> {
  const finalInputs = fixedInputs.slice();

  for (const candidate of supplementalCandidates) {
    if (finalInputs.some((input) => sameOutpoint(input, candidate))) {
      continue;
    }
    finalInputs.push(candidate);
    if (finalInputs.length >= fixedInputs.length + maxSupplemental) {
      break;
    }
  }

  return finalInputs;
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
  return replayBlocks([
    ...vector.setupBlocks.map(materializeBlock),
    ...vector.testBlocks.map(materializeBlock),
  ]);
}

class ScriptedPrompter implements WalletPrompter {
  readonly isInteractive = true;
  readonly prompts: string[] = [];
  readonly lines: string[] = [];

  constructor(
    readonly answers: string[],
  ) {}

  writeLine(message: string): void {
    this.lines.push(message);
  }

  async prompt(message: string): Promise<string> {
    this.prompts.push(message);
    const answer = this.answers.shift();

    if (answer === undefined) {
      throw new Error(`unexpected_prompt_${message}`);
    }

    return answer;
  }
}

class NonInteractivePrompter implements WalletPrompter {
  readonly isInteractive = false;
  readonly lines: string[] = [];
  readonly prompts: string[] = [];

  writeLine(message: string): void {
    this.lines.push(message);
  }

  async prompt(message: string): Promise<string> {
    this.prompts.push(message);
    throw new Error(`unexpected_prompt_${message}`);
  }
}

function createAnchorCapableWalletState(partial: Partial<WalletStateV1> = {}): WalletStateV1 {
  const base = createWalletState(partial);
  const material = deriveWalletMaterialFromMnemonic(base.mnemonic.phrase);

  return {
    ...base,
    keys: material.keys,
    descriptor: material.descriptor,
    funding: material.funding,
    managedCoreWallet: {
      ...base.managedCoreWallet,
      descriptorChecksum: material.descriptor.checksum,
      fundingAddress0: material.funding.address,
      fundingScriptPubKeyHex0: material.funding.scriptPubKeyHex,
    },
    identities: base.identities.map((identity) =>
      identity.index === 0
        ? {
          ...identity,
          address: material.funding.address,
          scriptPubKeyHex: material.funding.scriptPubKeyHex,
        }
        : identity
    ),
  };
}

function addUnanchoredDomainToSnapshot(options: {
  snapshot: Awaited<ReturnType<typeof createSnapshotState>>;
  domainId: number;
  domainName: string;
  ownerScriptPubKeyHex: string;
  listedPriceCogtoshi?: bigint;
}) {
  const template = options.snapshot.consensus.domainsById.get(1)!;
  const ownerScriptPubKey = Buffer.from(options.ownerScriptPubKeyHex, "hex");
  options.snapshot.consensus.domainsById.set(options.domainId, {
    ...template,
    domainId: options.domainId,
    name: options.domainName,
    ownerScriptPubKey,
    anchored: false,
    anchorHeight: 0,
    regHeight: options.snapshot.history.currentHeight ?? template.regHeight,
  });
  options.snapshot.consensus.domainIdsByName.set(options.domainName, options.domainId);
  const ownerDomainIds = new Set(options.snapshot.consensus.domainIdsByOwner.get(options.ownerScriptPubKeyHex) ?? []);
  ownerDomainIds.add(options.domainId);
  options.snapshot.consensus.domainIdsByOwner.set(options.ownerScriptPubKeyHex, ownerDomainIds);
  options.snapshot.consensus.nextDomainId = Math.max(options.snapshot.consensus.nextDomainId, options.domainId + 1);

  if (options.listedPriceCogtoshi === undefined) {
    options.snapshot.consensus.listings.delete(options.domainId);
    return;
  }

  options.snapshot.consensus.listings.set(options.domainId, {
    domainId: options.domainId,
    priceCogtoshi: options.listedPriceCogtoshi,
    sellerScriptPubKey: ownerScriptPubKey,
  });
}

function addAnchoredDomainToSnapshot(options: {
  snapshot: Awaited<ReturnType<typeof createSnapshotState>>;
  domainId: number;
  domainName: string;
  ownerScriptPubKeyHex: string;
}) {
  const template = options.snapshot.consensus.domainsById.get(1)!;
  const ownerScriptPubKey = Buffer.from(options.ownerScriptPubKeyHex, "hex");
  options.snapshot.consensus.domainsById.set(options.domainId, {
    ...template,
    domainId: options.domainId,
    name: options.domainName,
    ownerScriptPubKey,
    anchored: true,
    anchorHeight: 200,
    endpoint: null,
    delegate: null,
    miner: null,
  });
  options.snapshot.consensus.domainIdsByName.set(options.domainName, options.domainId);
  const ownerDomainIds = new Set(options.snapshot.consensus.domainIdsByOwner.get(options.ownerScriptPubKeyHex) ?? []);
  ownerDomainIds.add(options.domainId);
  options.snapshot.consensus.domainIdsByOwner.set(options.ownerScriptPubKeyHex, ownerDomainIds);
  options.snapshot.consensus.nextDomainId = Math.max(options.snapshot.consensus.nextDomainId, options.domainId + 1);
}

function createRegisterRpcHarness(options: {
  snapshotHeight: number;
  fundingScriptPubKeyHex: string;
  fundingAddress: string;
  senderScriptPubKeyHex?: string;
  senderAddress?: string;
  rootSenderKind?: "funding" | "anchored";
  treasuryScriptPubKeyHex: string;
  treasuryAddress: string;
  registerKind: "root" | "subdomain";
  domainName: string;
  mempoolTxids?: string[];
  sendError?: Error;
}) {
  const captured: {
    inputs?: Array<{ txid: string; vout: number }>;
    outputs?: unknown[];
    options?: Record<string, unknown>;
    unlockCalls: Array<Array<{ txid: string; vout: number }>>;
  } = {
    unlockCalls: [],
  };
  const locked: Array<{ txid: string; vout: number }> = [];

  return {
    rpcFactory() {
      return {
        async getBlockchainInfo() {
          return { blocks: options.snapshotHeight };
        },
        async listUnspent() {
          const anchoredSender = options.registerKind === "subdomain" || options.rootSenderKind === "anchored";
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

          if (anchoredSender) {
            entries.push({
              txid: "aa".repeat(32),
              vout: 1,
              scriptPubKey: options.senderScriptPubKeyHex!,
              amount: 0.00002,
              confirmations: 9,
              spendable: true,
              safe: true,
              address: options.senderAddress!,
            });
          }

          return entries;
        },
        async listLockUnspent() {
          return locked.slice();
        },
        async lockUnspent(_walletName: string, unlock: boolean, outputs: Array<{ txid: string; vout: number }>) {
          if (unlock) {
            captured.unlockCalls.push(outputs.slice());
            for (const output of outputs) {
              const index = locked.findIndex((entry) => entry.txid === output.txid && entry.vout === output.vout);
              if (index >= 0) {
                locked.splice(index, 1);
              }
            }
          }
          return true;
        },
        async walletCreateFundedPsbt(
          _walletName: string,
          inputs: Array<{ txid: string; vout: number }>,
          outputs: unknown[],
          _locktime: number,
          walletOptions: Record<string, unknown>,
        ) {
          captured.inputs = inputs;
          captured.outputs = outputs;
          captured.options = walletOptions;
          locked.push({ txid: "33".repeat(32), vout: 1 });
          return {
            psbt: "funded-psbt",
            fee: 0.00001,
            changepos: options.registerKind === "root" && options.rootSenderKind === "anchored" ? 3 : 2,
          };
        },
        async decodePsbt() {
          const opReturnHex = String((captured.outputs?.[0] as { data: string }).data);
          const anchoredSender = options.registerKind === "subdomain" || options.rootSenderKind === "anchored";
          const fixedInputs = captured.inputs ?? [];
          const vinInputs = appendSupplementalFundingInputs(
            fixedInputs,
            [
              { txid: "11".repeat(32), vout: 0 },
              { txid: "22".repeat(32), vout: 0 },
            ],
          );
          const vin = vinInputs.map((input) => ({
            txid: input.txid,
            vout: input.vout,
            prevout: {
              scriptPubKey: {
                hex: anchoredSender && input.txid === "aa".repeat(32) && input.vout === 1
                  ? options.senderScriptPubKeyHex!
                  : options.fundingScriptPubKeyHex,
              },
            },
          }));
          const vout = options.registerKind === "root" && options.rootSenderKind === "anchored"
            ? [
              { n: 0, value: 0, scriptPubKey: { hex: encodeOpReturnScript(opReturnHex) } },
              { n: 1, value: 0.001, scriptPubKey: { hex: options.treasuryScriptPubKeyHex } },
              { n: 2, value: 0.00002, scriptPubKey: { hex: options.senderScriptPubKeyHex! } },
              { n: 3, value: 0.01899, scriptPubKey: { hex: options.fundingScriptPubKeyHex } },
            ]
            : [
              { n: 0, value: 0, scriptPubKey: { hex: encodeOpReturnScript(opReturnHex) } },
              {
                n: 1,
                value: options.registerKind === "root" ? 0.001 : 0.00002,
                scriptPubKey: {
                  hex: options.registerKind === "root"
                    ? options.treasuryScriptPubKeyHex
                    : options.senderScriptPubKeyHex!,
                },
              },
              { n: 2, value: 0.01899, scriptPubKey: { hex: options.fundingScriptPubKeyHex } },
            ];
          return {
            tx: {
              txid: "44".repeat(32),
              vin,
              vout,
            },
          };
        },
        async walletProcessPsbt() {
          return {
            psbt: "signed-psbt",
            complete: false,
          };
        },
        async finalizePsbt() {
          return {
            complete: true,
            hex: "deadbeef",
          };
        },
        async decodeRawTransaction() {
          return {
            txid: "55".repeat(32),
            hash: "66".repeat(32),
            vin: [],
            vout: [],
          };
        },
        async testMempoolAccept() {
          return [{ allowed: true }];
        },
        async sendRawTransaction() {
          if (options.sendError !== undefined) {
            throw options.sendError;
          }

          return "55".repeat(32);
        },
        async getRawMempool() {
          return options.mempoolTxids ?? [];
        },
        async getRawTransaction(txid: string) {
          if (!(options.mempoolTxids ?? []).includes(txid)) {
            throw new Error("missing_tx");
          }

          return {
            txid,
            vin: [],
            vout: [
              {
                n: 0,
                value: 0,
                scriptPubKey: {
                  hex: encodeOpReturnScript(Buffer.from(`434f4705${options.domainName.length.toString(16).padStart(2, "0")}${Buffer.from(options.domainName).toString("hex")}`, "hex").toString("hex")),
                },
              },
            ],
          };
        },
      };
    },
    captured,
  };
}

function createAnchorRpcHarness(options: {
  snapshotHeight: number;
  fundingScriptPubKeyHex: string;
  fundingAddress: string;
  senderScriptPubKeyHex: string;
  senderAddress: string;
  targetScriptPubKeyHex: string;
  targetAddress: string;
  sourceAnchorOutpoint?: { txid: string; vout: number } | null;
  tx1MempoolVisible?: boolean;
  sendErrors?: [Error | undefined, Error | undefined];
  decodedVinOverrides?: Partial<Record<"tx1" | "tx2", Array<{
    txid: string;
    vout: number;
    scriptPubKeyHex: string;
  }>>>;
}) {
  const tx1Txid = "55".repeat(32);
  const tx2Txid = "77".repeat(32);
  const temporaryLockTxids = ["aa".repeat(32), "bb".repeat(32)];
  const captured: {
    calls: Array<{
      inputs: Array<{ txid: string; vout: number }>;
      outputs: unknown[];
      options: Record<string, unknown>;
      phase: "tx1" | "tx2";
    }>;
    unlockCalls: Array<Array<{ txid: string; vout: number }>>;
    relockCalls: Array<Array<{ txid: string; vout: number }>>;
  } = {
    calls: [],
    unlockCalls: [],
    relockCalls: [],
  };
  const locked: Array<{ txid: string; vout: number }> = [];
  let sendCount = 0;

  function scriptForAddress(address: string): string {
    if (address === options.fundingAddress) {
      return options.fundingScriptPubKeyHex;
    }
    if (address === options.senderAddress) {
      return options.senderScriptPubKeyHex;
    }
    if (address === options.targetAddress) {
      return options.targetScriptPubKeyHex;
    }
    throw new Error(`unknown_address_${address}`);
  }

  function buildDecoded(callIndex: number) {
    const call = captured.calls[callIndex]!;
    const isTx2 = call.phase === "tx2";
    const changePos = Number(call.options.changePosition);
    const vin = options.decodedVinOverrides?.[call.phase]?.map((input) => ({
      txid: input.txid,
      vout: input.vout,
      prevout: {
        scriptPubKey: {
          hex: input.scriptPubKeyHex,
        },
      },
    })) ?? appendSupplementalFundingInputs(
      call.inputs,
      [
        { txid: "11".repeat(32), vout: 0 },
        { txid: "22".repeat(32), vout: 0 },
      ],
    ).map((input) => ({
      txid: input.txid,
      vout: input.vout,
      prevout: {
        scriptPubKey: {
          hex: isTx2 && input.txid === tx1Txid && input.vout === 1
            ? options.targetScriptPubKeyHex
            : !isTx2 && options.sourceAnchorOutpoint !== undefined && options.sourceAnchorOutpoint !== null && sameOutpoint(input, options.sourceAnchorOutpoint)
              ? options.senderScriptPubKeyHex
              : options.fundingScriptPubKeyHex,
        },
      },
    }));
    const baseOutputs = call.outputs.map((output, index) => {
      if ("data" in (output as Record<string, unknown>)) {
        const hex = String((output as { data: string }).data);
        return { n: index, value: 0, scriptPubKey: { hex: encodeOpReturnScript(hex) } };
      }

      const [address, value] = Object.entries(output as Record<string, number>)[0]!;
      return {
        n: index,
        value,
        scriptPubKey: { hex: scriptForAddress(address) },
      };
    });

    if (changePos >= 0) {
      baseOutputs.splice(changePos, 0, {
        n: changePos,
        value: 0.01899,
        scriptPubKey: { hex: options.fundingScriptPubKeyHex },
      });
    }

    return {
      vin,
      vout: baseOutputs.map((output, index) => ({
        ...output,
        n: index,
      })),
    };
  }

  return {
    rpcFactory() {
      return {
        async getBlockchainInfo() {
          return { blocks: options.snapshotHeight };
        },
        async listUnspent(_walletName: string, minConf = 1) {
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

          if (options.sourceAnchorOutpoint !== undefined && options.sourceAnchorOutpoint !== null) {
            entries.push({
              txid: options.sourceAnchorOutpoint.txid,
              vout: options.sourceAnchorOutpoint.vout,
              scriptPubKey: options.senderScriptPubKeyHex,
              amount: 0.00002,
              confirmations: 9,
              spendable: true,
              safe: true,
              address: options.senderAddress,
            });
          }

          if (minConf === 0) {
            entries.push({
              txid: tx1Txid,
              vout: 1,
              scriptPubKey: options.targetScriptPubKeyHex,
              amount: 0.00002,
              confirmations: 0,
              spendable: true,
              safe: true,
              address: options.targetAddress,
            });
          }

          return entries;
        },
        async listLockUnspent() {
          return locked.slice();
        },
        async lockUnspent(_walletName: string, unlock: boolean, outputs: Array<{ txid: string; vout: number }>) {
          if (unlock) {
            captured.unlockCalls.push(outputs.slice());
            for (const output of outputs) {
              const index = locked.findIndex((entry) => entry.txid === output.txid && entry.vout === output.vout);
              if (index >= 0) {
                locked.splice(index, 1);
              }
            }
          } else {
            captured.relockCalls.push(outputs.slice());
          }
          return true;
        },
        async walletCreateFundedPsbt(
          _walletName: string,
          inputs: Array<{ txid: string; vout: number }>,
          outputs: unknown[],
          _locktime: number,
          walletOptions: Record<string, unknown>,
        ) {
          const callIndex = captured.calls.length;
          const phase = inputs[0]?.txid === tx1Txid ? "tx2" : "tx1";
          captured.calls.push({
            inputs,
            outputs,
            options: walletOptions,
            phase,
          });
          locked.push({ txid: temporaryLockTxids[callIndex]!, vout: 1 });
          return {
            psbt: `funded-psbt-${callIndex + 1}`,
            fee: 0.00001,
            changepos: Number(walletOptions.changePosition),
          };
        },
        async decodePsbt(psbt: string) {
          const callIndex = Math.max(0, Number(psbt.match(/-(\d+)$/)?.[1] ?? "1") - 1);
          const phase = captured.calls[callIndex]?.phase ?? "tx1";
          return {
            tx: {
              txid: phase === "tx2" ? tx2Txid : tx1Txid,
              ...buildDecoded(callIndex),
            },
          };
        },
        async walletProcessPsbt(_walletName: string, psbt: string) {
          const callIndex = Math.max(0, Number(psbt.match(/-(\d+)$/)?.[1] ?? "1") - 1);
          const phase = captured.calls[callIndex]?.phase ?? "tx1";
          return {
            psbt: phase === "tx2" ? "signed-psbt-2" : "signed-psbt-1",
            complete: false,
          };
        },
        async finalizePsbt(psbt: string) {
          return {
            complete: true,
            hex: psbt.endsWith("-2") ? "feedface" : "deadbeef",
          };
        },
        async decodeRawTransaction(hex: string) {
          const phase = hex === "feedface" ? "tx2" : "tx1";
          const callIndex = Math.max(0, captured.calls.findIndex((call) => call.phase === phase));
          return {
            txid: phase === "tx2" ? tx2Txid : tx1Txid,
            hash: (phase === "tx2" ? "88" : "66").repeat(32),
            ...buildDecoded(callIndex),
          };
        },
        async testMempoolAccept() {
          return [{ allowed: true }];
        },
        async sendRawTransaction(hex: string) {
          const callIndex = hex === "feedface" ? 1 : 0;
          const error = options.sendErrors?.[callIndex];
          sendCount += 1;

          if (error !== undefined) {
            throw error;
          }

          return callIndex === 0 ? tx1Txid : tx2Txid;
        },
        async getRawMempool() {
          return options.tx1MempoolVisible ? [tx1Txid] : [];
        },
        async getRawTransaction(txid: string) {
          if (options.tx1MempoolVisible && txid === tx1Txid) {
            return {
              txid,
              vin: buildDecoded(0).vin,
              vout: buildDecoded(0).vout,
            };
          }

          throw new Error("missing_tx");
        },
      };
    },
    captured,
    tx1Txid,
    tx2Txid,
    get sendCount() {
      return sendCount;
    },
  };
}

function createDomainMarketRpcHarness(options: {
  snapshotHeight: number;
  fundingScriptPubKeyHex: string;
  fundingAddress: string;
  senderScriptPubKeyHex: string;
  senderAddress: string;
  includeAnchorUtxo?: boolean;
  mempoolTxids?: string[];
  sendError?: Error;
}) {
  const captured: {
    inputs?: Array<{ txid: string; vout: number }>;
    outputs?: unknown[];
    options?: Record<string, unknown>;
    unlockCalls: Array<Array<{ txid: string; vout: number }>>;
  } = {
    unlockCalls: [],
  };
  const locked: Array<{ txid: string; vout: number }> = [];

  return {
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

          if (options.includeAnchorUtxo) {
            entries.push({
              txid: "aa".repeat(32),
              vout: 1,
              scriptPubKey: options.senderScriptPubKeyHex,
              amount: 0.00002,
              confirmations: 9,
              spendable: true,
              safe: true,
              address: options.senderAddress,
            });
          } else if (options.senderScriptPubKeyHex !== options.fundingScriptPubKeyHex) {
            entries.push({
              txid: "44".repeat(32),
              vout: 0,
              scriptPubKey: options.senderScriptPubKeyHex,
              amount: 0.00003,
              confirmations: 10,
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
            captured.unlockCalls.push(outputs.slice());
            for (const output of outputs) {
              const index = locked.findIndex((entry) => entry.txid === output.txid && entry.vout === output.vout);
              if (index >= 0) {
                locked.splice(index, 1);
              }
            }
          }
          return true;
        },
        async walletCreateFundedPsbt(
          _walletName: string,
          inputs: Array<{ txid: string; vout: number }>,
          outputs: unknown[],
          _locktime: number,
          walletOptions: Record<string, unknown>,
        ) {
          captured.inputs = inputs;
          captured.outputs = outputs;
          captured.options = walletOptions;
          locked.push({ txid: "33".repeat(32), vout: 1 });
          return {
            psbt: "funded-psbt",
            fee: 0.00001,
            changepos: options.includeAnchorUtxo ? 2 : 1,
          };
        },
        async decodePsbt() {
          const opReturnHex = String((captured.outputs?.[0] as { data: string }).data);
          const vinInputs = appendSupplementalFundingInputs(
            captured.inputs ?? [],
            [
              { txid: "11".repeat(32), vout: 0 },
              { txid: "22".repeat(32), vout: 0 },
              { txid: "44".repeat(32), vout: 0 },
            ],
          );
          const vin = vinInputs.map((input) => ({
            txid: input.txid,
            vout: input.vout,
            prevout: {
              scriptPubKey: {
                hex: options.includeAnchorUtxo && input.txid === "aa".repeat(32) && input.vout === 1
                  ? options.senderScriptPubKeyHex
                  : !options.includeAnchorUtxo && input.txid === "44".repeat(32) && input.vout === 0
                    ? options.senderScriptPubKeyHex
                    : options.fundingScriptPubKeyHex,
              },
            },
          }));
          const vout = [
            { n: 0, value: 0, scriptPubKey: { hex: encodeOpReturnScript(opReturnHex) } },
          ];

          if (options.includeAnchorUtxo) {
            vout.push(
              { n: 1, value: 0.00002, scriptPubKey: { hex: options.senderScriptPubKeyHex } },
              { n: 2, value: 0.01899, scriptPubKey: { hex: options.fundingScriptPubKeyHex } },
            );
          } else {
            vout.push({ n: 1, value: 0.02999, scriptPubKey: { hex: options.fundingScriptPubKeyHex } });
          }

          return {
            tx: {
              txid: "44".repeat(32),
              vin,
              vout,
            },
          };
        },
        async walletProcessPsbt() {
          return {
            psbt: "signed-psbt",
            complete: false,
          };
        },
        async finalizePsbt() {
          return {
            complete: true,
            hex: "deadbeef",
          };
        },
        async decodeRawTransaction() {
          return {
            txid: "55".repeat(32),
            hash: "66".repeat(32),
            vin: [],
            vout: [],
          };
        },
        async testMempoolAccept() {
          return [{ allowed: true }];
        },
        async sendRawTransaction() {
          if (options.sendError !== undefined) {
            throw options.sendError;
          }

          return "55".repeat(32);
        },
        async getRawMempool() {
          return options.mempoolTxids ?? [];
        },
        async getRawTransaction(txid: string) {
          if (!(options.mempoolTxids ?? []).includes(txid)) {
            throw new Error("missing_tx");
          }

          return {
            txid,
            vin: [],
            vout: [],
          };
        },
      };
    },
    captured,
  };
}

function createReputationRpcHarness(options: {
  snapshotHeight: number;
  fundingScriptPubKeyHex: string;
  fundingAddress: string;
  senderScriptPubKeyHex: string;
  senderAddress: string;
  walletTx?: { confirmations: number } | null;
  sendError?: Error;
}) {
  const captured: {
    inputs?: Array<{ txid: string; vout: number }>;
    outputs?: unknown[];
    options?: Record<string, unknown>;
    unlockCalls: Array<Array<{ txid: string; vout: number }>>;
  } = {
    unlockCalls: [],
  };
  const locked: Array<{ txid: string; vout: number }> = [];

  return {
    rpcFactory() {
      return {
        async getBlockchainInfo() {
          return { blocks: options.snapshotHeight };
        },
        async listUnspent() {
          return [
            {
              txid: "aa".repeat(32),
              vout: 1,
              scriptPubKey: options.senderScriptPubKeyHex,
              amount: 0.00002,
              confirmations: 9,
              spendable: true,
              safe: true,
              address: options.senderAddress,
            },
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
        },
        async listLockUnspent() {
          return locked.slice();
        },
        async lockUnspent(_walletName: string, unlock: boolean, outputs: Array<{ txid: string; vout: number }>) {
          if (unlock) {
            captured.unlockCalls.push(outputs.slice());
            for (const output of outputs) {
              const index = locked.findIndex((entry) => entry.txid === output.txid && entry.vout === output.vout);
              if (index >= 0) {
                locked.splice(index, 1);
              }
            }
          }
          return true;
        },
        async walletCreateFundedPsbt(
          _walletName: string,
          inputs: Array<{ txid: string; vout: number }>,
          outputs: unknown[],
          _locktime: number,
          walletOptions: Record<string, unknown>,
        ) {
          captured.inputs = inputs;
          captured.outputs = outputs;
          captured.options = walletOptions;
          locked.push({ txid: "33".repeat(32), vout: 1 });
          return {
            psbt: "funded-psbt",
            fee: 0.00001,
            changepos: 2,
          };
        },
        async decodePsbt() {
          const opReturnHex = String((captured.outputs?.[0] as { data: string }).data);
          const vinInputs = appendSupplementalFundingInputs(
            captured.inputs ?? [],
            [
              { txid: "11".repeat(32), vout: 0 },
              { txid: "22".repeat(32), vout: 0 },
            ],
          );
          return {
            tx: {
              txid: "44".repeat(32),
              vin: vinInputs.map((input) => ({
                txid: input.txid,
                vout: input.vout,
                prevout: {
                  scriptPubKey: {
                    hex: input.txid === "aa".repeat(32) && input.vout === 1
                      ? options.senderScriptPubKeyHex
                      : options.fundingScriptPubKeyHex,
                  },
                },
              })),
              vout: [
                { n: 0, value: 0, scriptPubKey: { hex: encodeOpReturnScript(opReturnHex) } },
                { n: 1, value: 0.00002, scriptPubKey: { hex: options.senderScriptPubKeyHex } },
                { n: 2, value: 0.02999, scriptPubKey: { hex: options.fundingScriptPubKeyHex } },
              ],
            },
          };
        },
        async walletProcessPsbt() {
          return {
            psbt: "signed-psbt",
            complete: false,
          };
        },
        async finalizePsbt() {
          return {
            complete: true,
            hex: "deadbeef",
          };
        },
        async decodeRawTransaction() {
          return {
            txid: "55".repeat(32),
            hash: "66".repeat(32),
            vin: [],
            vout: [],
          };
        },
        async testMempoolAccept() {
          return [{ allowed: true }];
        },
        async sendRawTransaction() {
          if (options.sendError !== undefined) {
            throw options.sendError;
          }

          return "55".repeat(32);
        },
        async getTransaction(_walletName: string, txid: string) {
          if (options.walletTx === null || options.walletTx === undefined || txid !== "55".repeat(32)) {
            throw new Error("missing_wallet_tx");
          }

          return {
            txid,
            confirmations: options.walletTx.confirmations,
          };
        },
      };
    },
    captured,
  };
}

async function createDynamicReadContext(options: {
  paths: ReturnType<typeof createTempWalletPaths>;
  provider: ReturnType<typeof createMemoryWalletSecretProviderForTesting>;
  snapshot: Awaited<ReturnType<typeof createSnapshotState>>;
}) {
  const state = await loadWalletState({
    primaryPath: options.paths.walletStatePath,
    backupPath: options.paths.walletStateBackupPath,
  }, {
    provider: options.provider,
  });
  const tip = {
    height: options.snapshot.history.currentHeight ?? 0,
    blockHashHex: "03".repeat(32),
    previousHashHex: "02".repeat(32),
    stateHashHex: "aa".repeat(32),
  };
  const model = createWalletReadModel(state.state, {
    state: options.snapshot,
    tip,
  });

  return {
    dataDir: options.paths.bitcoinDataDir,
    databasePath: join(options.paths.dataRoot, "client.sqlite"),
    localState: {
      availability: "ready" as const,
      walletRootId: state.state.walletRootId,
      state: state.state,
      source: state.source,
      unlockUntilUnixMs: 1_700_000_900_000,
      hasPrimaryStateFile: true,
      hasBackupStateFile: false,
      hasUnlockSessionFile: true,
      message: null,
    },
    bitcoind: {
      health: "ready" as const,
      status: null,
      message: null,
    },
    nodeStatus: {
      ready: true,
      chain: "main",
      pid: 1234,
      walletRootId: state.state.walletRootId,
      nodeBestHeight: tip.height,
      nodeBestHashHex: tip.blockHashHex,
      nodeHeaderHeight: tip.height,
      serviceUpdatedAtUnixMs: 1_700_000_000_000,
      serviceStatus: null,
      walletReplica: {
        walletRootId: state.state.walletRootId,
        walletName: state.state.managedCoreWallet.walletName,
        loaded: true,
        descriptors: true,
        privateKeysEnabled: true,
        created: false,
        proofStatus: "ready" as const,
        descriptorChecksum: state.state.managedCoreWallet.descriptorChecksum,
        fundingAddress0: state.state.funding.address,
        fundingScriptPubKeyHex0: state.state.funding.scriptPubKeyHex,
        message: null,
      },
      walletReplicaMessage: null,
    },
    nodeHealth: "synced" as const,
    nodeMessage: null,
    indexer: {
      health: "synced" as const,
      status: {
        serviceApiVersion: INDEXER_DAEMON_SERVICE_API_VERSION,
        binaryVersion: "0.0.0-test",
        buildId: null,
        updatedAtUnixMs: 1_700_000_000_000,
        walletRootId: state.state.walletRootId,
        daemonInstanceId: "daemon-1",
        schemaVersion: INDEXER_DAEMON_SCHEMA_VERSION,
        state: "synced",
        processId: 4321,
        startedAtUnixMs: 1_700_000_000_000,
        heartbeatAtUnixMs: 1_700_000_000_000,
        ipcReady: true,
        rpcReachable: true,
        coreBestHeight: tip.height,
        coreBestHash: tip.blockHashHex,
        appliedTipHeight: tip.height,
        appliedTipHash: tip.blockHashHex,
        snapshotSeq: "1",
        backlogBlocks: 0,
        reorgDepth: null,
        lastAppliedAtUnixMs: 1_700_000_000_000,
        activeSnapshotCount: 0,
        lastError: null,
      },
      message: null,
      snapshotTip: tip,
    },
    snapshot: {
      state: options.snapshot,
      tip,
    },
    model,
    async close() {},
  } satisfies WalletReadContext;
}

async function writeInitialUnlockedState(options: {
  paths: ReturnType<typeof createTempWalletPaths>;
  provider: ReturnType<typeof createMemoryWalletSecretProviderForTesting>;
  state: WalletStateV1;
}) {
  const secretReference = createWalletSecretReference(options.state.walletRootId);
  await options.provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 9));
  await saveWalletState(
    {
      primaryPath: options.paths.walletStatePath,
      backupPath: options.paths.walletStateBackupPath,
    },
    options.state,
    {
      provider: options.provider,
      secretReference,
    },
  );
  await saveUnlockSession(
    options.paths.walletUnlockSessionPath,
    {
      schemaVersion: 1,
      walletRootId: options.state.walletRootId,
      sessionId: "session-1",
      createdAtUnixMs: 1_700_000_000_000,
      unlockUntilUnixMs: 1_700_000_900_000,
      sourceStateRevision: options.state.stateRevision,
      wrappedSessionKeyMaterial: secretReference.keyId,
    },
    {
      provider: options.provider,
      secretReference,
    },
  );
}

test("registerDomain builds a root registration, persists a live mutation, and reserves the local domain", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-register-root-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createRegisterRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    treasuryScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    treasuryAddress: "bc1qa4y4c8ava8drcupg2xwmkdjhdsmljrjk5ejp0t",
    registerKind: "root",
    domainName: "weatherbot",
  });
  const prompter = new ScriptedPrompter(["weatherbot"]);

  const result = await registerDomain({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_100_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.registerKind, "root");
  assert.equal(result.resolved.sender.selector, "id:0");
  assert.equal(result.resolved.economicEffect.kind, "treasury-payment");
  assert.equal(result.status, "live");
  assert.equal(harness.captured.inputs?.[0]?.txid, "11".repeat(32));
  assert.equal((harness.captured.outputs?.[1] as Record<string, number>)["bc1qa4y4c8ava8drcupg2xwmkdjhdsmljrjk5ejp0t"], 0.001);
  assert.equal(harness.captured.options?.changePosition, 2);
  assert.deepEqual(harness.captured.unlockCalls, [[{ txid: "33".repeat(32), vout: 1 }]]);
  assert.equal(saved.state.pendingMutations?.[0]?.status, "live");
  assert.equal(saved.state.pendingMutations?.[0]?.attemptedTxid, "55".repeat(32));
  assert.equal(saved.state.domains.some((domain) => domain.name === "weatherbot"), true);
  assert.equal(saved.state.identities[0]?.assignedDomainNames.includes("weatherbot"), true);
  assert.deepEqual(prompter.lines.slice(0, 3), [
    "Resolved path: root registration.",
    "Resolved sender: id:0 (bc1qfundingidentity0000000000000000000000000)",
    "Economic effect: send 100000 sats to the Cogcoin treasury.",
  ]);
});

test("registerDomain preserves the plain root builder shape when --from id:0 is selected", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-register-root-id0-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createRegisterRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    treasuryScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    treasuryAddress: "bc1qa4y4c8ava8drcupg2xwmkdjhdsmljrjk5ejp0t",
    registerKind: "root",
    domainName: "weatherbot",
  });

  const result = await registerDomain({
    domainName: "weatherbot",
    fromIdentity: "id:0",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_100_000,
  });

  assert.equal(result.senderSelector, "id:0");
  assert.equal(result.resolved.sender.selector, "id:0");
  assert.equal(harness.captured.inputs?.[0]?.txid, "11".repeat(32));
  assert.equal(harness.captured.options?.changePosition, 2);
  assert.equal(harness.captured.outputs?.length, 2);
});

test("registerDomain refuses a visible root race unless --force-race is set", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-register-race-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createRegisterRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    treasuryScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    treasuryAddress: "bc1qa4y4c8ava8drcupg2xwmkdjhdsmljrjk5ejp0t",
    registerKind: "root",
    domainName: "weatherbot",
    mempoolTxids: ["77".repeat(32)],
  });

  await assert.rejects(() => registerDomain({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  }), /wallet_register_root_race_detected/);

  assert.equal(harness.captured.inputs, undefined);
});

test("registerDomain builds a subdomain registration from the anchored parent owner and confirms with Class B", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-register-subdomain-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createRegisterRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    treasuryScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    treasuryAddress: "bc1qa4y4c8ava8drcupg2xwmkdjhdsmljrjk5ejp0t",
    registerKind: "subdomain",
    domainName: "alpha-child",
  });

  const prompter = new ScriptedPrompter(["yes"]);
  const result = await registerDomain({
    domainName: "alpha-child",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_100_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.registerKind, "subdomain");
  assert.equal(result.resolved.parentDomainName, "alpha");
  assert.equal(harness.captured.inputs?.[0]?.txid, "aa".repeat(32));
  assert.equal((harness.captured.outputs?.[1] as Record<string, number>)["bc1qalphaowner0000000000000000000000000000"], 0.00002);
  assert.equal(saved.state.pendingMutations?.[0]?.status, "live");
  assert.equal(saved.state.domains.some((domain) => domain.name === "alpha-child"), true);
  assert.equal(saved.state.domains.find((domain) => domain.name === "alpha-child")?.currentOwnerLocalIndex, 1);
  assert.deepEqual(prompter.lines.slice(0, 4), [
    "Resolved path: subdomain registration.",
    "Resolved parent: alpha.",
    "Resolved sender: id:1 (bc1qalphaowner0000000000000000000000000000)",
    "Economic effect: burn 0.00000100 COG from the parent-owner identity.",
  ]);
});

test("registerDomain builds an anchored-owner root registration when --from selects a local anchored identity", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-register-root-anchored-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createRegisterRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    rootSenderKind: "anchored",
    treasuryScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    treasuryAddress: "bc1qa4y4c8ava8drcupg2xwmkdjhdsmljrjk5ejp0t",
    registerKind: "root",
    domainName: "weatherbot",
  });

  const result = await registerDomain({
    domainName: "weatherbot",
    fromIdentity: "domain:alpha",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_100_000,
  });

  assert.equal(result.senderSelector, "id:1");
  assert.equal(result.resolved.sender.selector, "id:1");
  assert.equal(result.senderLocalIndex, 1);
  assert.equal(harness.captured.inputs?.[0]?.txid, "aa".repeat(32));
  assert.equal((harness.captured.outputs?.[2] as Record<string, number>)["bc1qalphaowner0000000000000000000000000000"], 0.00002);
  assert.equal(harness.captured.options?.changePosition, 3);
});

test("registerDomain rejects --from on subdomain registration instead of ignoring it", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-register-subdomain-from-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });

  await assert.rejects(() => registerDomain({
    domainName: "alpha-child",
    fromIdentity: "id:1",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
  }), /wallet_register_from_not_supported_for_subdomain/);
});

test("registerDomain reconciles a broadcast-unknown retry instead of creating a duplicate mutation", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-register-retry-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const firstHarness = createRegisterRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    treasuryScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    treasuryAddress: "bc1qa4y4c8ava8drcupg2xwmkdjhdsmljrjk5ejp0t",
    registerKind: "root",
    domainName: "weatherbot",
    sendError: new Error("The managed Bitcoin RPC request timed out."),
  });

  await assert.rejects(() => registerDomain({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: firstHarness.rpcFactory,
    nowUnixMs: 1_700_000_100_000,
  }), /wallet_register_broadcast_unknown/);

  let saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });
  assert.equal(saved.state.pendingMutations?.[0]?.status, "broadcast-unknown");

  const retryHarness = createRegisterRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    treasuryScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    treasuryAddress: "bc1qa4y4c8ava8drcupg2xwmkdjhdsmljrjk5ejp0t",
    registerKind: "root",
    domainName: "weatherbot",
    mempoolTxids: ["55".repeat(32)],
  });

  const retried = await registerDomain({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: retryHarness.rpcFactory,
    nowUnixMs: 1_700_000_200_000,
  });

  saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(retried.reusedExisting, true);
  assert.equal(retried.status, "live");
  assert.equal(saved.state.pendingMutations?.length, 1);
  assert.equal(saved.state.pendingMutations?.[0]?.status, "live");
});

test("registerDomain keeps root intents distinct when the same domain is retried with a different sender", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-register-root-sender-distinct-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });

  const firstHarness = createRegisterRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    treasuryScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    treasuryAddress: "bc1qa4y4c8ava8drcupg2xwmkdjhdsmljrjk5ejp0t",
    registerKind: "root",
    domainName: "weatherbot",
  });

  const firstResult = await registerDomain({
    domainName: "weatherbot",
    fromIdentity: "id:0",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: firstHarness.rpcFactory,
    nowUnixMs: 1_700_000_100_000,
  });

  const secondHarness = createRegisterRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    rootSenderKind: "anchored",
    treasuryScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    treasuryAddress: "bc1qa4y4c8ava8drcupg2xwmkdjhdsmljrjk5ejp0t",
    registerKind: "root",
    domainName: "weatherbot",
  });

  const secondResult = await registerDomain({
    domainName: "weatherbot",
    fromIdentity: "domain:alpha",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: secondHarness.rpcFactory,
    nowUnixMs: 1_700_000_200_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(firstResult.reusedExisting, false);
  assert.equal(secondResult.reusedExisting, false);
  assert.equal(saved.state.pendingMutations?.length, 2);
  assert.notEqual(saved.state.pendingMutations?.[0]?.intentFingerprintHex, saved.state.pendingMutations?.[1]?.intentFingerprintHex);
});

test("transferDomain builds an unanchored transfer from the current local owner and reserves the recipient", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-transfer-domain-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "alpha-child",
    ownerScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    listedPriceCogtoshi: 250n,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
  });

  const prompter = new ScriptedPrompter(["yes"]);

  const result = await transferDomain({
    domainName: "alpha-child",
    target: "spk:00141111111111111111111111111111111111111111",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.kind, "transfer");
  assert.equal(result.status, "live");
  assert.equal(result.recipientScriptPubKeyHex, "00141111111111111111111111111111111111111111");
  assert.equal(result.resolved?.sender.selector, "id:1");
  assert.equal(result.resolved?.sender.localIndex, 1);
  assert.equal(result.resolved?.sender.scriptPubKeyHex, "001400a654e135b542d1a605d607c08e2218a178788d");
  assert.equal(result.resolved?.sender.address, "bc1qalphaowner0000000000000000000000000000");
  assert.equal(result.resolved?.recipient?.scriptPubKeyHex, "00141111111111111111111111111111111111111111");
  assert.equal(result.resolved?.recipient?.opaque, false);
  assert.deepEqual(result.resolved?.economicEffect, {
    kind: "ownership-transfer",
    clearsListing: true,
  });
  assert.equal(harness.captured.inputs?.[0]?.txid, "aa".repeat(32));
  assert.equal((harness.captured.outputs?.[1] as Record<string, number>)["bc1qalphaowner0000000000000000000000000000"], 0.00002);
  assert.deepEqual(harness.captured.unlockCalls, [[{ txid: "33".repeat(32), vout: 1 }]]);
  assert.equal(saved.state.pendingMutations?.[0]?.kind, "transfer");
  assert.equal(saved.state.pendingMutations?.[0]?.status, "live");
  assert.equal(saved.state.domains.find((domain) => domain.name === "alpha-child")?.currentOwnerScriptPubKeyHex, "00141111111111111111111111111111111111111111");
  assert.notEqual(result.resolved?.recipient?.address, null);
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Resolved recipient: /);
  assert.match(prompter.lines.join("\n"), /Economic effect: transfer domain ownership and clear any active listing\./);
});

test("transferDomain allows non-interactive approval with assumeYes on the plain yes/no path", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-transfer-domain-yes-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "alpha-child",
    ownerScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
  });
  const prompter = new NonInteractivePrompter();

  const result = await transferDomain({
    domainName: "alpha-child",
    target: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    assumeYes: true,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  assert.equal(result.status, "live");
  assert.deepEqual(prompter.prompts, []);
  assert.match(prompter.lines.join("\n"), /You are transferring "alpha-child"\./);
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Economic effect: transfer domain ownership\./);
});

test("transferDomain rejects self-transfer", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-transfer-self-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "alpha-child",
    ownerScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });

  await assert.rejects(() => transferDomain({
    domainName: "alpha-child",
    target: "spk:001400a654e135b542d1a605d607c08e2218a178788d",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
  }), /wallet_transfer_self_transfer/);
});

test("transferDomain reconciles a broadcast-unknown retry instead of creating a duplicate mutation", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-transfer-retry-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "alpha-child",
    ownerScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const firstHarness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
    sendError: new Error("The managed Bitcoin RPC request timed out."),
  });

  await assert.rejects(() => transferDomain({
    domainName: "alpha-child",
    target: "spk:00141111111111111111111111111111111111111111",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: firstHarness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  }), /wallet_transfer_broadcast_unknown/);

  let saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });
  assert.equal(saved.state.pendingMutations?.[0]?.status, "broadcast-unknown");

  const retryHarness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
    mempoolTxids: ["55".repeat(32)],
  });

  const retried = await transferDomain({
    domainName: "alpha-child",
    target: "spk:00141111111111111111111111111111111111111111",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: retryHarness.rpcFactory,
    nowUnixMs: 1_700_000_400_000,
  });

  saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(retried.reusedExisting, true);
  assert.equal(retried.status, "live");
  assert.equal(retried.resolved?.sender.selector, "id:1");
  assert.deepEqual(retried.resolved?.economicEffect, {
    kind: "ownership-transfer",
    clearsListing: false,
  });
  assert.equal(saved.state.pendingMutations?.length, 1);
  assert.equal(saved.state.pendingMutations?.[0]?.status, "live");
});

test("sellDomain builds an unanchored listing without BTC settlement outputs", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-sell-domain-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "alpha-child",
    ownerScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
  });

  const prompter = new ScriptedPrompter(["yes"]);

  const result = await sellDomain({
    domainName: "alpha-child",
    listedPriceCogtoshi: 250n,
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.kind, "sell");
  assert.equal(result.status, "live");
  assert.equal(result.listedPriceCogtoshi, 250n);
  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    economicEffect: {
      kind: "listing-set",
      listedPriceCogtoshi: "250",
    },
  });
  assert.equal(harness.captured.inputs?.[0]?.txid, "aa".repeat(32));
  assert.equal(harness.captured.outputs?.length, 2);
  assert.equal((harness.captured.outputs?.[1] as Record<string, number>)["bc1qalphaowner0000000000000000000000000000"], 0.00002);
  assert.equal(saved.state.pendingMutations?.[0]?.kind, "sell");
  assert.equal(saved.state.pendingMutations?.[0]?.priceCogtoshi, 250n);
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Exact listing price: 250 cogtoshi\./);
  assert.match(prompter.lines.join("\n"), /Economic effect: set the listing price to 250 cogtoshi in COG state\./);
  assert.match(prompter.lines.join("\n"), /Settlement: entirely in COG state\. No BTC payment output will be added\./);
});

test("sellDomain supports unsell without an interactive confirmation prompt", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-unsell-domain-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "alpha-child",
    ownerScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    listedPriceCogtoshi: 250n,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
  });

  const prompter = new NonInteractivePrompter();

  const result = await sellDomain({
    domainName: "alpha-child",
    listedPriceCogtoshi: 0n,
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.kind, "sell");
  assert.equal(result.listedPriceCogtoshi, 0n);
  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    economicEffect: {
      kind: "listing-clear",
      listedPriceCogtoshi: "0",
    },
  });
  assert.deepEqual(prompter.prompts, []);
  assert.deepEqual(prompter.lines, []);
  assert.equal(saved.state.pendingMutations?.[0]?.priceCogtoshi, 0n);
});

test("buyDomain buys a listed unanchored domain from funding identity zero without BTC seller outputs", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-buy-domain-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 11,
    domainName: "market",
    ownerScriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
    listedPriceCogtoshi: 250n,
  });
  snapshot.consensus.balances.set("0014ed495c1face9da3c7028519dbb36576c37f90e56", 1_000n);
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    senderAddress: "bc1qfundingidentity0000000000000000000000000",
  });
  const prompter = new ScriptedPrompter(["yes"]);

  const result = await buyDomain({
    domainName: "market",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.kind, "buy");
  assert.equal(result.status, "live");
  assert.equal(result.listedPriceCogtoshi, 250n);
  assert.deepEqual(result.resolvedBuyer, {
    selector: "id:0",
    localIndex: 0,
    scriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    address: "bc1qfundingidentity0000000000000000000000000",
  });
  assert.deepEqual(result.resolvedSeller, {
    scriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
    address: "bc1qbetaowner00000000000000000000000000000",
  });
  assert.equal(harness.captured.inputs?.[0]?.txid, "11".repeat(32));
  assert.equal(harness.captured.outputs?.length, 1);
  assert.equal(saved.state.pendingMutations?.[0]?.kind, "buy");
  assert.equal(saved.state.pendingMutations?.[0]?.priceCogtoshi, 250n);
  assert.equal(saved.state.domains.find((domain) => domain.name === "market")?.currentOwnerLocalIndex, 0);
  assert.match(prompter.lines.join("\n"), /Exact listing price: 250 cogtoshi\./);
  assert.match(prompter.lines.join("\n"), /Resolved buyer: id:0 \(bc1qfundingidentity0000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Resolved seller: bc1qbetaowner00000000000000000000000000000/);
  assert.match(prompter.lines.join("\n"), /Settlement: entirely in COG state\. No BTC payment output will be added\./);
});

test("buyDomain preserves the plain buyer path for explicit --from id:0", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-buy-domain-id0-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 11,
    domainName: "market",
    ownerScriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
    listedPriceCogtoshi: 250n,
  });
  snapshot.consensus.balances.set("0014ed495c1face9da3c7028519dbb36576c37f90e56", 1_000n);
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    senderAddress: "bc1qfundingidentity0000000000000000000000000",
  });

  const result = await buyDomain({
    domainName: "market",
    fromIdentity: "id:0",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  assert.equal(result.resolvedBuyer?.selector, "id:0");
  assert.equal(harness.captured.inputs?.[0]?.txid, "11".repeat(32));
  assert.equal(harness.captured.outputs?.length, 1);
});

test("buyDomain uses the anchored buyer path for an anchored local explicit sender", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-buy-domain-anchored-buyer-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 11,
    domainName: "market",
    ownerScriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
    listedPriceCogtoshi: 250n,
  });
  snapshot.consensus.balances.set("001400a654e135b542d1a605d607c08e2218a178788d", 1_000n);
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
  });

  const result = await buyDomain({
    domainName: "market",
    fromIdentity: "id:1",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.resolvedBuyer?.selector, "id:1");
  assert.equal(harness.captured.inputs?.[0]?.txid, "aa".repeat(32));
  assert.equal(harness.captured.outputs?.length, 2);
  assert.equal((harness.captured.outputs?.[1] as Record<string, number>)["bc1qalphaowner0000000000000000000000000000"], 0.00002);
  assert.equal(saved.state.pendingMutations?.[0]?.senderLocalIndex, 1);
  assert.equal(saved.state.domains.find((domain) => domain.name === "market")?.currentOwnerLocalIndex, 1);
});

test("buyDomain rejects explicit buyers that are missing, read-only, already the owner, or underfunded", async () => {
  const cases = [
    {
      name: "missing",
      fromIdentity: "id:9",
      mutateState: (_state: WalletStateV1) => {},
      mutateSnapshot: (_snapshot: Awaited<ReturnType<typeof createSnapshotState>>) => {},
      expected: /wallet_buy_sender_not_found/,
    },
    {
      name: "read-only",
      fromIdentity: "id:1",
      mutateState: (state: WalletStateV1) => {
        state.identities = state.identities.map((identity) =>
          identity.index === 1 ? { ...identity, status: "read-only" } : identity
        );
      },
      mutateSnapshot: (snapshot: Awaited<ReturnType<typeof createSnapshotState>>) => {
        snapshot.consensus.balances.set("001400a654e135b542d1a605d607c08e2218a178788d", 1_000n);
      },
      expected: /wallet_buy_sender_read_only/,
    },
    {
      name: "already-owner",
      fromIdentity: "id:2",
      mutateState: (_state: WalletStateV1) => {},
      mutateSnapshot: (snapshot: Awaited<ReturnType<typeof createSnapshotState>>) => {
        snapshot.consensus.balances.set("00145f5a03d6c7c88648b5f947459b769008ced5a020", 1_000n);
      },
      expected: /wallet_buy_already_owner/,
    },
    {
      name: "underfunded",
      fromIdentity: "id:1",
      mutateState: (_state: WalletStateV1) => {},
      mutateSnapshot: (snapshot: Awaited<ReturnType<typeof createSnapshotState>>) => {
        snapshot.consensus.balances.set("001400a654e135b542d1a605d607c08e2218a178788d", 10n);
      },
      expected: /wallet_buy_insufficient_cog_balance/,
    },
  ] as const;

  for (const testCase of cases) {
    const tempRoot = await mkdtemp(join(tmpdir(), `cogcoin-buy-buyer-reject-${testCase.name}-`));
    const paths = createTempWalletPaths(tempRoot);
    const provider = createMemoryWalletSecretProviderForTesting();
    const snapshot = structuredClone(await createSnapshotState());
    addUnanchoredDomainToSnapshot({
      snapshot,
      domainId: 11,
      domainName: "market",
      ownerScriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
      listedPriceCogtoshi: 250n,
    });
    const state = createWalletState();
    testCase.mutateState(state);
    testCase.mutateSnapshot(snapshot);
    await writeInitialUnlockedState({
      paths,
      provider,
      state,
    });

    await assert.rejects(() => buyDomain({
      domainName: "market",
      fromIdentity: testCase.fromIdentity,
      dataDir: paths.bitcoinDataDir,
      databasePath: join(tempRoot, "client.sqlite"),
      provider,
      paths,
      prompter: new ScriptedPrompter(["yes"]),
      openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    }), testCase.expected);
  }
});

test("buyDomain reuses the same buyer intent but keeps a different buyer as a distinct pending mutation", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-buy-retry-distinct-buyer-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 11,
    domainName: "market",
    ownerScriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
    listedPriceCogtoshi: 250n,
  });
  snapshot.consensus.balances.set("0014ed495c1face9da3c7028519dbb36576c37f90e56", 1_000n);
  snapshot.consensus.balances.set("001400a654e135b542d1a605d607c08e2218a178788d", 1_000n);
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });

  const firstHarness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    senderAddress: "bc1qfundingidentity0000000000000000000000000",
  });

  const first = await buyDomain({
    domainName: "market",
    fromIdentity: "id:0",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: firstHarness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  let saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(first.reusedExisting, false);
  assert.equal(saved.state.pendingMutations?.length, 1);

  const retryHarness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    senderAddress: "bc1qfundingidentity0000000000000000000000000",
    mempoolTxids: ["55".repeat(32)],
  });

  const retried = await buyDomain({
    domainName: "market",
    fromIdentity: "id:0",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: retryHarness.rpcFactory,
    nowUnixMs: 1_700_000_400_000,
  });

  saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(retried.reusedExisting, true);
  assert.equal(retried.status, "live");
  assert.equal(saved.state.pendingMutations?.length, 1);

  const secondBuyerHarness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
  });

  const secondBuyer = await buyDomain({
    domainName: "market",
    fromIdentity: "id:1",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: secondBuyerHarness.rpcFactory,
    nowUnixMs: 1_700_000_500_000,
  });

  saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(secondBuyer.reusedExisting, false);
  assert.equal(saved.state.pendingMutations?.length, 2);
  assert.notEqual(
    saved.state.pendingMutations?.[0]?.intentFingerprintHex,
    saved.state.pendingMutations?.[1]?.intentFingerprintHex,
  );
});

test("buyDomain rejects anchored domains", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-buy-anchored-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });

  await assert.rejects(() => buyDomain({
    domainName: "alpha",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
  }), /wallet_buy_domain_anchored/);
});

test("createField builds a standalone FIELD_REG and persists a live field mutation", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-field-create-standalone-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
  });
  const prompter = new ScriptedPrompter(["yes"]);

  const result = await createField({
    domainName: "alpha",
    fieldName: "tagline",
    permanent: true,
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.kind, "field-create");
  assert.equal(result.family, false);
  assert.equal(result.fieldId, 2);
  assert.equal(result.permanent, true);
  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    path: "standalone-field-reg",
    value: null,
    effect: {
      kind: "create-empty-field",
      burnCogtoshi: "100",
    },
  });
  assert.equal(harness.captured.inputs?.[0]?.txid, "aa".repeat(32));
  assert.equal(
    String((harness.captured.outputs?.[0] as { data: string }).data),
    Buffer.from(serializeFieldReg(1, true, "tagline").opReturnData).toString("hex"),
  );
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Path: standalone-field-reg/);
  assert.match(prompter.lines.join("\n"), /Effect: burn 100 cogtoshi to create an empty field\./);
  assert.equal(saved.state.pendingMutations?.[0]?.kind, "field-create");
  assert.equal(saved.state.pendingMutations?.[0]?.fieldName, "tagline");
  assert.equal(saved.state.pendingMutations?.[0]?.fieldPermanent, true);
});

test("createField with an initial value builds the FIELD_REG -> DATA_UPDATE family", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-field-create-family-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    targetScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    targetAddress: "bc1qalphaowner0000000000000000000000000000",
    sourceAnchorOutpoint: {
      txid: "aa".repeat(32),
      vout: 1,
    },
    tx1MempoolVisible: true,
  });
  const prompter = new ScriptedPrompter(["alpha:tagline"]);

  const result = await createField({
    domainName: "alpha",
    fieldName: "tagline",
    permanent: true,
    source: {
      kind: "text",
      value: "hello",
    },
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.kind, "field-create");
  assert.equal(result.family, true);
  assert.equal(result.fieldId, 2);
  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    path: "field-reg-plus-data-update-family",
    value: {
      format: 0x02,
      byteLength: 5,
    },
    effect: {
      kind: "create-and-initialize-field",
      tx1BurnCogtoshi: "100",
      tx2AdditionalBurnCogtoshi: "1",
    },
  });
  assert.equal(harness.captured.calls.length, 2);
  assert.equal(harness.captured.calls[0]?.inputs[0]?.txid, "aa".repeat(32));
  assert.equal(harness.captured.calls[1]?.inputs[0]?.txid, harness.tx1Txid);
  assert.equal(
    String((harness.captured.calls[0]?.outputs[0] as { data: string }).data),
    Buffer.from(serializeFieldReg(1, true, "tagline").opReturnData).toString("hex"),
  );
  assert.equal(
    String((harness.captured.calls[1]?.outputs[0] as { data: string }).data),
    Buffer.from(serializeDataUpdate(1, 2, 0x02, new TextEncoder().encode("hello")).opReturnData).toString("hex"),
  );
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Path: field-reg-plus-data-update-family/);
  assert.match(prompter.lines.join("\n"), /Effect: burn 100 cogtoshi in Tx1 and 1 additional cogtoshi in Tx2\./);
  assert.match(prompter.lines.join("\n"), /Value: format 2, 5 bytes/);
  assert.match(prompter.lines.join("\n"), /Warning: non-clear field values are public in the mempool and on-chain\./);
  assert.match(prompter.lines.join("\n"), /Tx1 may confirm even if Tx2 later fails, is canceled, or needs repair\./);
  assert.equal(saved.state.proactiveFamilies?.[0]?.type, "field");
  assert.equal(saved.state.proactiveFamilies?.[0]?.fieldName, "tagline");
  assert.equal(saved.state.proactiveFamilies?.[0]?.status, "live");
});

test("setField builds a standalone DATA_UPDATE and persists the pending field mutation", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-field-set-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
  });
  const lines: string[] = [];
  const prompter: WalletPrompter = {
    isInteractive: true,
    writeLine(message: string) {
      lines.push(message);
    },
    async prompt(message: string) {
      return message.startsWith("Type ") ? "alpha:bio" : "yes";
    },
  };

  const result = await setField({
    domainName: "alpha",
    fieldName: "bio",
    source: {
      kind: "text",
      value: "hello",
    },
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.kind, "field-set");
  assert.equal(result.family, false);
  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    path: "standalone-data-update",
    value: {
      format: 0x02,
      byteLength: 5,
    },
    effect: {
      kind: "write-field-value",
      burnCogtoshi: "1",
    },
  });
  assert.equal(harness.captured.inputs?.[0]?.txid, "aa".repeat(32));
  assert.equal(
    String((harness.captured.outputs?.[0] as { data: string }).data),
    Buffer.from(serializeDataUpdate(1, 1, 0x02, new TextEncoder().encode("hello")).opReturnData).toString("hex"),
  );
  assert.match(lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(lines.join("\n"), /Path: standalone-data-update/);
  assert.match(lines.join("\n"), /Effect: burn 1 cogtoshi to write the field value\./);
  assert.equal(saved.state.pendingMutations?.[0]?.kind, "field-set");
  assert.equal(saved.state.pendingMutations?.[0]?.fieldName, "bio");
  assert.equal(saved.state.pendingMutations?.[0]?.fieldFormat, 0x02);
});

test("clearField emits a standalone DATA_UPDATE clear and surfaces the resolved clear path", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-field-clear-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
  });
  const prompter = new ScriptedPrompter([]);

  const result = await clearField({
    domainName: "alpha",
    fieldName: "bio",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.kind, "field-clear");
  assert.equal(result.family, false);
  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    path: "standalone-data-clear",
    value: null,
    effect: {
      kind: "clear-field-value",
      burnCogtoshi: "0",
    },
  });
  assert.equal(
    String((harness.captured.outputs?.[0] as { data: string }).data),
    Buffer.from(serializeDataUpdate(1, 1, FIELD_FORMAT_BYTES.clear).opReturnData).toString("hex"),
  );
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Path: standalone-data-clear/);
  assert.match(prompter.lines.join("\n"), /Effect: clear the field value with no additional COG burn\./);
  assert.equal(saved.state.pendingMutations?.[0]?.kind, "field-clear");
  assert.equal(saved.state.pendingMutations?.[0]?.fieldName, "bio");
});

test("setDomainEndpoint builds an anchored endpoint update from the local owner", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-domain-endpoint-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
  });
  const prompter = new ScriptedPrompter(["yes"]);

  const result = await setDomainEndpoint({
    domainName: "alpha",
    source: {
      kind: "text",
      value: "https://alpha.example",
    },
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.kind, "endpoint");
  assert.equal(result.status, "live");
  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    target: null,
    effect: {
      kind: "endpoint-set",
      byteLength: new TextEncoder().encode("https://alpha.example").length,
    },
  });
  assert.equal(harness.captured.inputs?.[0]?.txid, "aa".repeat(32));
  assert.equal((harness.captured.outputs?.[1] as Record<string, number>)["bc1qalphaowner0000000000000000000000000000"], 0.00002);
  assert.equal(
    String((harness.captured.outputs?.[0] as { data: string }).data),
    Buffer.from(serializeSetEndpoint(1, new TextEncoder().encode("https://alpha.example")).opReturnData).toString("hex"),
  );
  assert.equal(saved.state.pendingMutations?.[0]?.kind, "endpoint");
  assert.equal(saved.state.pendingMutations?.[0]?.endpointValueHex, Buffer.from("https://alpha.example").toString("hex"));
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Effect: set the endpoint payload to 21 bytes\./);
  assert.match(prompter.lines.join("\n"), /Warning: endpoint data is public in the mempool and on-chain\./);
});

test("clearDomainDelegate emits the canonical short clear payload", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-domain-delegate-clear-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
  });
  const prompter = new ScriptedPrompter(["yes"]);

  const result = await clearDomainDelegate({
    domainName: "alpha",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.kind, "delegate");
  assert.equal(result.status, "live");
  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    target: null,
    effect: { kind: "delegate-clear" },
  });
  assert.equal(
    String((harness.captured.outputs?.[0] as { data: string }).data),
    Buffer.from(serializeSetDelegate(1).opReturnData).toString("hex"),
  );
  assert.equal(saved.state.pendingMutations?.[0]?.kind, "delegate");
  assert.equal(saved.state.pendingMutations?.[0]?.recipientScriptPubKeyHex, null);
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Effect: clear the delegate target\./);
});

test("clearDomainEndpoint emits the canonical short clear payload", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-domain-endpoint-clear-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
  });
  const prompter = new ScriptedPrompter(["yes"]);

  const result = await clearDomainEndpoint({
    domainName: "alpha",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  assert.equal(result.kind, "endpoint");
  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    target: null,
    effect: { kind: "endpoint-clear" },
  });
  assert.equal(
    String((harness.captured.outputs?.[0] as { data: string }).data),
    Buffer.from(serializeSetEndpoint(1).opReturnData).toString("hex"),
  );
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Effect: clear the endpoint payload\./);
});

test("setDomainDelegate rejects exact self-delegation", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-domain-delegate-self-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });

  await assert.rejects(() => setDomainDelegate({
    domainName: "alpha",
    target: "spk:001400a654e135b542d1a605d607c08e2218a178788d",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
  }), /wallet_domain_delegate_self_target/);
});

test("setDomainEndpoint rejects oversize endpoint payloads", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-domain-endpoint-oversize-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });

  await assert.rejects(() => setDomainEndpoint({
    domainName: "alpha",
    source: {
      kind: "text",
      value: "x".repeat(200),
    },
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
  }), /wallet_cogop_payload_out_of_range/);
});

test("setDomainDelegate reconciles a broadcast-unknown retry instead of creating a duplicate mutation", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-domain-delegate-retry-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const firstHarness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
    sendError: new Error("The managed Bitcoin RPC request timed out."),
  });

  await assert.rejects(() => setDomainDelegate({
    domainName: "alpha",
    target: "spk:00141111111111111111111111111111111111111111",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: firstHarness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  }), /wallet_domain_delegate_broadcast_unknown/);

  let saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });
  assert.equal(saved.state.pendingMutations?.[0]?.status, "broadcast-unknown");

  const retryHarness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
    mempoolTxids: ["55".repeat(32)],
  });

  const retried = await setDomainDelegate({
    domainName: "alpha",
    target: "spk:00141111111111111111111111111111111111111111",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: retryHarness.rpcFactory,
    nowUnixMs: 1_700_000_400_000,
  });

  saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(retried.reusedExisting, true);
  assert.equal(retried.status, "live");
  assert.equal(retried.resolved?.sender.selector, "id:1");
  assert.equal(retried.resolved?.target?.scriptPubKeyHex, "00141111111111111111111111111111111111111111");
  assert.deepEqual(retried.resolved?.effect, { kind: "delegate-set" });
  assert.equal(saved.state.pendingMutations?.length, 1);
  assert.equal(saved.state.pendingMutations?.[0]?.status, "live");
});

test("setDomainMiner builds an anchored miner update and preserves the redundant-owner warning", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-domain-miner-set-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
  });
  const prompter = new ScriptedPrompter(["yes"]);

  const result = await setDomainMiner({
    domainName: "alpha",
    target: "spk:001400a654e135b542d1a605d607c08e2218a178788d",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  assert.equal(result.kind, "miner");
  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    target: {
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qqzn9fcf4k4pdrfs96crupr3zrzshs7yd02xcmr",
      opaque: false,
    },
    effect: { kind: "miner-set" },
  });
  assert.equal(
    String((harness.captured.outputs?.[0] as { data: string }).data),
    Buffer.from(serializeSetMiner(1, Buffer.from("001400a654e135b542d1a605d607c08e2218a178788d", "hex")).opReturnData).toString("hex"),
  );
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Resolved target: bc1qqzn9fcf4k4pdrfs96crupr3zrzshs7yd02xcmr/);
  assert.match(prompter.lines.join("\n"), /Effect: set the designated miner target\./);
  assert.match(prompter.lines.join("\n"), /Warning: setting the designated miner to the current owner is usually redundant\./);
});

test("clearDomainMiner emits the canonical short clear payload", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-domain-miner-clear-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
  });
  const prompter = new ScriptedPrompter(["yes"]);

  const result = await clearDomainMiner({
    domainName: "alpha",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  assert.equal(result.kind, "miner");
  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    target: null,
    effect: { kind: "miner-clear" },
  });
  assert.equal(
    String((harness.captured.outputs?.[0] as { data: string }).data),
    Buffer.from(serializeSetMiner(1).opReturnData).toString("hex"),
  );
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Effect: clear the designated miner target\./);
});

test("setDomainMiner rejects non-root anchored domains", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-domain-miner-subdomain-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  addAnchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "alpha-child",
    ownerScriptPubKeyHex: "00141111111111111111111111111111111111111111",
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState({
      identities: [
        ...createWalletState().identities,
        {
          index: 3,
          scriptPubKeyHex: "00141111111111111111111111111111111111111111",
          address: "bc1qchildowner0000000000000000000000000000",
          status: "dedicated",
          assignedDomainNames: ["alpha-child"],
        },
      ],
      domains: [
        ...createWalletState().domains,
        {
          name: "alpha-child",
          domainId: 10,
          dedicatedIndex: 3,
          currentOwnerScriptPubKeyHex: "00141111111111111111111111111111111111111111",
          currentOwnerLocalIndex: 3,
          canonicalChainStatus: "anchored",
          localAnchorIntent: "none",
          currentCanonicalAnchorOutpoint: {
            txid: "cc".repeat(32),
            vout: 1,
            valueSats: 2_000,
          },
          foundingMessageText: null,
          birthTime: 1_700_000_010,
        },
      ],
    }),
  });

  await assert.rejects(() => setDomainMiner({
    domainName: "alpha-child",
    target: "spk:00142222222222222222222222222222222222222222",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
  }), /wallet_domain_miner_root_domain_required/);
});

test("setDomainCanonical rejects read-only anchored identities", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-domain-canonical-read-only-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  addAnchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "gamma",
    ownerScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
  });
  const baseState = createWalletState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: {
      ...baseState,
      identities: baseState.identities.map((identity) =>
        identity.index === 1
          ? {
            ...identity,
            assignedDomainNames: ["alpha", "gamma"],
          }
          : identity
      ),
      domains: [
        ...baseState.domains,
        {
          name: "gamma",
          domainId: 10,
          dedicatedIndex: 1,
          currentOwnerScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          currentOwnerLocalIndex: 1,
          canonicalChainStatus: "anchored",
          localAnchorIntent: "none",
          currentCanonicalAnchorOutpoint: {
            txid: "dd".repeat(32),
            vout: 1,
            valueSats: 2_000,
          },
          foundingMessageText: null,
          birthTime: 1_700_000_020,
        },
      ],
    },
  });

  await assert.rejects(() => setDomainCanonical({
    domainName: "alpha",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
  }), /wallet_domain_canonical_owner_read_only/);
});

test("setDomainCanonical emits the canonical short payload", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-domain-canonical-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = await createSnapshotState();
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createDomainMarketRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    includeAnchorUtxo: true,
  });
  const prompter = new ScriptedPrompter(["yes"]);

  const result = await setDomainCanonical({
    domainName: "alpha",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  assert.equal(result.kind, "canonical");
  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    target: null,
    effect: { kind: "canonicalize-owner" },
  });
  assert.equal(
    String((harness.captured.outputs?.[0] as { data: string }).data),
    Buffer.from(serializeSetCanonical(1).opReturnData).toString("hex"),
  );
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Effect: canonicalize the current anchored owner\./);
});

test("giveReputation builds an anchored reputation commit from the local owner and persists a live mutation", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-reputation-give-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  snapshot.consensus.balances.set("001400a654e135b542d1a605d607c08e2218a178788d", 1_000n);
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createReputationRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
  });
  const prompter = new ScriptedPrompter(["yes"]);

  const reviewPayload = await encodeSentence("solid operator");
  const result = await giveReputation({
    sourceDomainName: "alpha",
    targetDomainName: "beta",
    amountCogtoshi: 100n,
    reviewText: "solid operator",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.kind, "give");
  assert.equal(result.status, "live");
  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    effect: {
      kind: "give-support",
      burnCogtoshi: "100",
    },
    review: {
      included: true,
      byteLength: reviewPayload.length,
    },
    selfStake: false,
  });
  assert.deepEqual(harness.captured.inputs?.[0], {
    txid: "aa".repeat(32),
    vout: 1,
  });
  assert.equal(
    String((harness.captured.outputs?.[0] as { data: string }).data),
    Buffer.from(serializeRepCommit(1, 2, 100n, reviewPayload).opReturnData).toString("hex"),
  );
  assert.deepEqual(harness.captured.unlockCalls, [[{ txid: "33".repeat(32), vout: 1 }]]);
  assert.equal(saved.state.pendingMutations?.[0]?.kind, "rep-give");
  assert.equal(saved.state.pendingMutations?.[0]?.recipientDomainName, "beta");
  assert.equal(saved.state.pendingMutations?.[0]?.amountCogtoshi, 100n);
  assert.equal(saved.state.pendingMutations?.[0]?.status, "live");
  assert.equal(saved.state.pendingMutations?.[0]?.reviewPayloadHex, Buffer.from(reviewPayload).toString("hex"));
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Effect: burn 100 cogtoshi to publish support\./);
  assert.match(prompter.lines.join("\n"), new RegExp(`Review: included \\(${reviewPayload.length} bytes\\)\\.`));
});

test("giveReputation self-stake requires typed acknowledgement", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-reputation-self-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  snapshot.consensus.balances.set("001400a654e135b542d1a605d607c08e2218a178788d", 1_000n);
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createReputationRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
  });
  const prompter = new ScriptedPrompter(["wrong-domain"]);

  await assert.rejects(() => giveReputation({
    sourceDomainName: "alpha",
    targetDomainName: "alpha",
    amountCogtoshi: 25n,
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  }), /wallet_rep_give_confirmation_rejected/);

  assert.deepEqual(prompter.prompts, ["Type alpha to continue: "]);
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Effect: burn 25 cogtoshi to publish support\./);
  assert.match(prompter.lines.join("\n"), /Review: none\./);
  assert.match(prompter.lines.join("\n"), /Self-stake: yes\./);
  assert.match(prompter.lines.join("\n"), /Self-stake is irrevocable/);
});

test("giveReputation self-stake does not let assumeYes bypass typed acknowledgement", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-reputation-self-yes-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  snapshot.consensus.balances.set("001400a654e135b542d1a605d607c08e2218a178788d", 1_000n);
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createReputationRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
  });
  const prompter = new NonInteractivePrompter();

  await assert.rejects(() => giveReputation({
    sourceDomainName: "alpha",
    targetDomainName: "alpha",
    amountCogtoshi: 25n,
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    assumeYes: true,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  }), /wallet_rep_give_typed_ack_required/);

  assert.deepEqual(prompter.prompts, []);
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Effect: burn 25 cogtoshi to publish support\./);
  assert.match(prompter.lines.join("\n"), /Review: none\./);
  assert.match(prompter.lines.join("\n"), /Self-stake: yes\./);
  assert.match(prompter.lines.join("\n"), /Self-stake is irrevocable/);
});

test("revokeReputation builds an anchored reputation revoke from the local owner and returns resolved parity details", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-reputation-revoke-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  snapshot.consensus.balances.set("001400a654e135b542d1a605d607c08e2218a178788d", 1_000n);
  snapshot.consensus.supportByPair.set("1:2", 250n);
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const harness = createReputationRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
  });
  const prompter = new ScriptedPrompter(["yes"]);

  const result = await revokeReputation({
    sourceDomainName: "alpha",
    targetDomainName: "beta",
    amountCogtoshi: 100n,
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.kind, "revoke");
  assert.equal(result.status, "live");
  assert.deepEqual(result.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    effect: {
      kind: "revoke-support",
      burnCogtoshi: "100",
    },
    review: {
      included: false,
      byteLength: null,
    },
    selfStake: false,
  });
  assert.equal(
    String((harness.captured.outputs?.[0] as { data: string }).data),
    Buffer.from(serializeRepRevoke(1, 2, 100n).opReturnData).toString("hex"),
  );
  assert.equal(saved.state.pendingMutations?.[0]?.kind, "rep-revoke");
  assert.match(prompter.lines.join("\n"), /Resolved sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(prompter.lines.join("\n"), /Effect: revoke visible support with no refund of the previously burned 100 cogtoshi\./);
  assert.match(prompter.lines.join("\n"), /Review: none\./);
});

test("revokeReputation rejects source equals target", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-reputation-revoke-self-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  snapshot.consensus.balances.set("001400a654e135b542d1a605d607c08e2218a178788d", 1_000n);
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });

  await assert.rejects(() => revokeReputation({
    sourceDomainName: "alpha",
    targetDomainName: "alpha",
    amountCogtoshi: 10n,
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
  }), /wallet_rep_revoke_self_revoke_not_allowed/);
});

test("revokeReputation rejects amount above current net support", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-reputation-revoke-support-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  snapshot.consensus.balances.set("001400a654e135b542d1a605d607c08e2218a178788d", 1_000n);
  snapshot.consensus.supportByPair.set("1:2", 40n);
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });

  await assert.rejects(() => revokeReputation({
    sourceDomainName: "alpha",
    targetDomainName: "beta",
    amountCogtoshi: 50n,
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
  }), /wallet_rep_revoke_amount_exceeds_net_support/);
});

test("giveReputation reconciles a broadcast-unknown retry instead of creating a duplicate mutation", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-reputation-retry-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  snapshot.consensus.balances.set("001400a654e135b542d1a605d607c08e2218a178788d", 1_000n);
  await writeInitialUnlockedState({
    paths,
    provider,
    state: createWalletState(),
  });
  const firstHarness = createReputationRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    sendError: new Error("The managed Bitcoin RPC request timed out."),
  });

  await assert.rejects(() => giveReputation({
    sourceDomainName: "alpha",
    targetDomainName: "beta",
    amountCogtoshi: 75n,
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["yes"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: firstHarness.rpcFactory,
    nowUnixMs: 1_700_000_300_000,
  }), /wallet_rep_give_broadcast_unknown/);

  let saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });
  assert.equal(saved.state.pendingMutations?.[0]?.status, "broadcast-unknown");

  const retryHarness = createReputationRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
    fundingAddress: "bc1qfundingidentity0000000000000000000000000",
    senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
    senderAddress: "bc1qalphaowner0000000000000000000000000000",
    walletTx: { confirmations: 0 },
  });
  const retryPrompter = new ScriptedPrompter(["yes"]);

  const retried = await giveReputation({
    sourceDomainName: "alpha",
    targetDomainName: "beta",
    amountCogtoshi: 75n,
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: retryPrompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: retryHarness.rpcFactory,
    nowUnixMs: 1_700_000_400_000,
  });

  saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(retried.status, "live");
  assert.equal(retried.reusedExisting, true);
  assert.deepEqual(retried.resolved, {
    sender: {
      selector: "id:1",
      localIndex: 1,
      scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      address: "bc1qalphaowner0000000000000000000000000000",
    },
    effect: {
      kind: "give-support",
      burnCogtoshi: "75",
    },
    review: {
      included: false,
      byteLength: null,
    },
    selfStake: false,
  });
  assert.equal(retryPrompter.prompts.length, 0);
  assert.equal(saved.state.pendingMutations?.length, 1);
  assert.equal(saved.state.pendingMutations?.[0]?.status, "live");
});

test("anchorDomain builds Case A from funding identity zero and persists a live anchor family", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-case-a-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  const baseState = createAnchorCapableWalletState();
  const weatherbotState = {
    ...baseState,
    identities: baseState.identities.map((identity) =>
      identity.index === 0
        ? {
          ...identity,
          assignedDomainNames: ["weatherbot"],
        }
        : identity
    ),
    domains: [
      ...baseState.domains,
      {
        name: "weatherbot",
        domainId: 10,
        dedicatedIndex: 0,
        currentOwnerScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
        currentOwnerLocalIndex: 0,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "none" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
    ],
  } satisfies WalletStateV1;
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "weatherbot",
    ownerScriptPubKeyHex: weatherbotState.funding.scriptPubKeyHex,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state: weatherbotState,
  });

  const targetIdentity = deriveWalletIdentityMaterial(weatherbotState.keys.accountXprv, 3);
  const harness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: weatherbotState.funding.scriptPubKeyHex,
    fundingAddress: weatherbotState.funding.address,
    senderScriptPubKeyHex: weatherbotState.funding.scriptPubKeyHex,
    senderAddress: weatherbotState.funding.address,
    targetScriptPubKeyHex: targetIdentity.scriptPubKeyHex,
    targetAddress: targetIdentity.address,
  });
  const prompter = new ScriptedPrompter(["weatherbot"]);

  const result = await anchorDomain({
    domainName: "weatherbot",
    foundingMessageText: "The elephant moved with a curious grace, as if no label had ever touched it, as if the pull of the earth itself had taught its talent for gentleness.",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_400_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.status, "live");
  assert.equal(result.dedicatedIndex, 3);
  assert.equal(harness.captured.calls.length, 2);
  assert.equal(harness.captured.calls[0]?.options.add_inputs, true);
  assert.equal(harness.captured.calls[1]?.options.add_inputs, true);
  assert.equal(harness.captured.calls[0]?.inputs[0]?.txid, "11".repeat(32));
  assert.equal(
    (harness.captured.calls[0]?.outputs[1] as Record<string, number>)[targetIdentity.address],
    0.00002,
  );
  assert.equal(harness.captured.calls[1]?.inputs[0]?.txid, harness.tx1Txid);
  assert.equal(harness.captured.calls[1]?.inputs[0]?.vout, 1);
  assert.deepEqual(harness.captured.relockCalls, [[{ txid: harness.tx2Txid, vout: 1 }]]);
  assert.match(prompter.lines.join("\n"), /Dedicated Ethereum address:/);
  assert.match(prompter.lines.join("\n"), /Founding message:/);
  assert.equal(saved.state.proactiveFamilies[0]?.type, "anchor");
  assert.equal(saved.state.proactiveFamilies[0]?.status, "live");
  assert.equal(saved.state.proactiveFamilies[0]?.currentStep, "tx2");
  assert.notEqual(saved.state.proactiveFamilies[0]?.foundingMessagePayloadHex, null);
  assert.equal(saved.state.domains.find((domain) => domain.name === "weatherbot")?.localAnchorIntent, "tx2-live");
  assert.equal(saved.state.domains.find((domain) => domain.name === "weatherbot")?.currentOwnerLocalIndex, 3);
  assert.equal(saved.state.nextDedicatedIndex, 4);
});

test("anchorDomain treats a funding-owned Tx1 as funding-sent even if fundingIndex is stale", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-case-a-stale-funding-index-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  const baseState = createAnchorCapableWalletState();
  const state = {
    ...baseState,
    fundingIndex: 1 as unknown as 0,
    identities: baseState.identities.map((identity) =>
      identity.index === 0
        ? {
          ...identity,
          assignedDomainNames: ["weatherbot"],
        }
        : identity
    ),
    domains: [
      ...baseState.domains,
      {
        name: "weatherbot",
        domainId: 10,
        dedicatedIndex: 0,
        currentOwnerScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
        currentOwnerLocalIndex: 0,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "none" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
    ],
  } satisfies WalletStateV1;
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "weatherbot",
    ownerScriptPubKeyHex: state.funding.scriptPubKeyHex,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state,
  });

  const targetIdentity = deriveWalletIdentityMaterial(state.keys.accountXprv, 3);
  const harness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.funding.scriptPubKeyHex,
    senderAddress: state.funding.address,
    targetScriptPubKeyHex: targetIdentity.scriptPubKeyHex,
    targetAddress: targetIdentity.address,
  });

  const result = await anchorDomain({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_404_000,
  });

  assert.equal(result.status, "live");
  assert.equal(harness.captured.calls[0]?.options.add_inputs, true);
  assert.equal(harness.captured.calls[0]?.inputs[0]?.txid, "11".repeat(32));
});

test("anchorDomain rejects a funding-owner Tx1 decode when vin[0] no longer matches the fixed sender prefix", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-case-a-reordered-funding-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  const baseState = createAnchorCapableWalletState();
  const state = {
    ...baseState,
    identities: baseState.identities.map((identity) =>
      identity.index === 0
        ? {
          ...identity,
          assignedDomainNames: ["weatherbot"],
        }
        : identity
    ),
    domains: [
      ...baseState.domains,
      {
        name: "weatherbot",
        domainId: 10,
        dedicatedIndex: 0,
        currentOwnerScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
        currentOwnerLocalIndex: 0,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "none" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
    ],
  } satisfies WalletStateV1;
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "weatherbot",
    ownerScriptPubKeyHex: state.funding.scriptPubKeyHex,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state,
  });

  const targetIdentity = deriveWalletIdentityMaterial(state.keys.accountXprv, 3);
  const harness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.funding.scriptPubKeyHex,
    senderAddress: state.funding.address,
    targetScriptPubKeyHex: targetIdentity.scriptPubKeyHex,
    targetAddress: targetIdentity.address,
    decodedVinOverrides: {
      tx1: [
        {
          txid: "22".repeat(32),
          vout: 0,
          scriptPubKeyHex: state.funding.scriptPubKeyHex,
        },
        {
          txid: "11".repeat(32),
          vout: 0,
          scriptPubKeyHex: state.funding.scriptPubKeyHex,
        },
      ],
    },
  });

  await assert.rejects(() => anchorDomain({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_405_000,
  }), /wallet_anchor_tx1_sender_input_mismatch/);

  assert.equal(harness.captured.calls[0]?.options.add_inputs, true);
});

test("anchorDomain rejects a Tx1 draft with an unexpected foreign input script", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-case-a-foreign-input-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  const baseState = createAnchorCapableWalletState();
  const state = {
    ...baseState,
    identities: baseState.identities.map((identity) =>
      identity.index === 0
        ? {
          ...identity,
          assignedDomainNames: ["weatherbot"],
        }
        : identity
    ),
    domains: [
      ...baseState.domains,
      {
        name: "weatherbot",
        domainId: 10,
        dedicatedIndex: 0,
        currentOwnerScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
        currentOwnerLocalIndex: 0,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "none" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
    ],
  } satisfies WalletStateV1;
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "weatherbot",
    ownerScriptPubKeyHex: state.funding.scriptPubKeyHex,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state,
  });

  const targetIdentity = deriveWalletIdentityMaterial(state.keys.accountXprv, 3);
  const harness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.funding.scriptPubKeyHex,
    senderAddress: state.funding.address,
    targetScriptPubKeyHex: targetIdentity.scriptPubKeyHex,
    targetAddress: targetIdentity.address,
    decodedVinOverrides: {
      tx1: [
        {
          txid: "11".repeat(32),
          vout: 0,
          scriptPubKeyHex: state.funding.scriptPubKeyHex,
        },
        {
          txid: "99".repeat(32),
          vout: 7,
          scriptPubKeyHex: "0014ffffffffffffffffffffffffffffffffffffffff",
        },
      ],
    },
  });

  await assert.rejects(() => anchorDomain({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_406_000,
  }), /wallet_anchor_tx1_unexpected_funding_input/);
});

test("anchorDomain reuses the lowest empty dedicated identity before allocating a fresh one", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-reuse-empty-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  const baseState = createAnchorCapableWalletState();
  const reusableIdentity = deriveWalletIdentityMaterial(baseState.keys.accountXprv, 1);
  const state = {
    ...baseState,
    nextDedicatedIndex: 3,
    identities: [
      baseState.identities[0]!,
      {
        index: 1,
        scriptPubKeyHex: reusableIdentity.scriptPubKeyHex,
        address: reusableIdentity.address,
        status: "dedicated" as const,
        assignedDomainNames: [],
      },
      baseState.identities[2]!,
    ],
    domains: [
      {
        name: "beta",
        domainId: 2,
        dedicatedIndex: 2,
        currentOwnerScriptPubKeyHex: baseState.identities[2]!.scriptPubKeyHex,
        currentOwnerLocalIndex: 2,
        canonicalChainStatus: "anchored" as const,
        localAnchorIntent: "none" as const,
        currentCanonicalAnchorOutpoint: {
          txid: "bb".repeat(32),
          vout: 1,
          valueSats: 2_000,
        },
        foundingMessageText: "beta founded",
        birthTime: 1_700_000_001,
      },
      {
        name: "weatherbot",
        domainId: 10,
        dedicatedIndex: 0,
        currentOwnerScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
        currentOwnerLocalIndex: 0,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "none" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
    ],
  } satisfies WalletStateV1;
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "weatherbot",
    ownerScriptPubKeyHex: state.funding.scriptPubKeyHex,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state,
  });

  const harness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.funding.scriptPubKeyHex,
    senderAddress: state.funding.address,
    targetScriptPubKeyHex: reusableIdentity.scriptPubKeyHex,
    targetAddress: reusableIdentity.address,
  });

  const result = await anchorDomain({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_450_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.dedicatedIndex, 1);
  assert.equal(saved.state.domains.find((domain) => domain.name === "weatherbot")?.currentOwnerLocalIndex, 1);
  assert.equal(saved.state.nextDedicatedIndex, 3);
  assert.equal(
    (harness.captured.calls[0]?.outputs[1] as Record<string, number>)[reusableIdentity.address],
    0.00002,
  );
});

test("anchorDomain skips dedicated identities that already own domains and falls back to the next empty one", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-skip-owned-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  const baseState = createAnchorCapableWalletState();
  const reusableIdentity = deriveWalletIdentityMaterial(baseState.keys.accountXprv, 2);
  const occupiedIdentity = deriveWalletIdentityMaterial(baseState.keys.accountXprv, 1);
  const state = {
    ...baseState,
    nextDedicatedIndex: 3,
    identities: [
      baseState.identities[0]!,
      {
        index: 1,
        scriptPubKeyHex: occupiedIdentity.scriptPubKeyHex,
        address: occupiedIdentity.address,
        status: "dedicated" as const,
        assignedDomainNames: ["holding"],
      },
      {
        index: 2,
        scriptPubKeyHex: reusableIdentity.scriptPubKeyHex,
        address: reusableIdentity.address,
        status: "dedicated" as const,
        assignedDomainNames: [],
      },
    ],
    domains: [
      {
        name: "holding",
        domainId: 2,
        dedicatedIndex: 1,
        currentOwnerScriptPubKeyHex: occupiedIdentity.scriptPubKeyHex,
        currentOwnerLocalIndex: 1,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "none" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
      {
        name: "weatherbot",
        domainId: 10,
        dedicatedIndex: 0,
        currentOwnerScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
        currentOwnerLocalIndex: 0,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "none" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
    ],
  } satisfies WalletStateV1;
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 2,
    domainName: "holding",
    ownerScriptPubKeyHex: occupiedIdentity.scriptPubKeyHex,
  });
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "weatherbot",
    ownerScriptPubKeyHex: state.funding.scriptPubKeyHex,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state,
  });

  const harness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.funding.scriptPubKeyHex,
    senderAddress: state.funding.address,
    targetScriptPubKeyHex: reusableIdentity.scriptPubKeyHex,
    targetAddress: reusableIdentity.address,
  });

  const result = await anchorDomain({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_460_000,
  });

  assert.equal(result.dedicatedIndex, 2);
});

test("anchorDomain does not reuse an empty dedicated identity that is still locally reserved", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-skip-reserved-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  const baseState = createAnchorCapableWalletState();
  const reservedIdentity = deriveWalletIdentityMaterial(baseState.keys.accountXprv, 1);
  const freshIdentity = deriveWalletIdentityMaterial(baseState.keys.accountXprv, 3);
  const state = {
    ...baseState,
    nextDedicatedIndex: 3,
    identities: [
      baseState.identities[0]!,
      {
        index: 1,
        scriptPubKeyHex: reservedIdentity.scriptPubKeyHex,
        address: reservedIdentity.address,
        status: "dedicated" as const,
        assignedDomainNames: [],
      },
    ],
    domains: [
      {
        name: "reserved-target",
        domainId: 2,
        dedicatedIndex: 1,
        currentOwnerScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
        currentOwnerLocalIndex: 0,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "reserved" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
      {
        name: "weatherbot",
        domainId: 10,
        dedicatedIndex: 0,
        currentOwnerScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
        currentOwnerLocalIndex: 0,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "none" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
    ],
    proactiveFamilies: [
      {
        familyId: "anchor-family-reserved",
        type: "anchor",
        status: "broadcasting" as const,
        intentFingerprintHex: "cc".repeat(32),
        createdAtUnixMs: 1_700_000_000_000,
        lastUpdatedAtUnixMs: 1_700_000_000_000,
        domainName: "reserved-target",
        domainId: 2,
        sourceSenderLocalIndex: 0,
        sourceSenderScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
        reservedDedicatedIndex: 1,
        reservedScriptPubKeyHex: reservedIdentity.scriptPubKeyHex,
        foundingMessageText: null,
        foundingMessagePayloadHex: null,
        listingCancelCommitted: false,
        currentStep: "tx1",
        tx1: {
          status: "broadcasting",
          attemptedTxid: "44".repeat(32),
          attemptedWtxid: "55".repeat(32),
          temporaryBuilderLockedOutpoints: [],
          rawHex: "deadbeef",
        },
        tx2: {
          status: "draft",
          attemptedTxid: null,
          attemptedWtxid: null,
          temporaryBuilderLockedOutpoints: [],
          rawHex: null,
        },
      },
    ],
  } satisfies WalletStateV1;
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 2,
    domainName: "reserved-target",
    ownerScriptPubKeyHex: state.funding.scriptPubKeyHex,
  });
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "weatherbot",
    ownerScriptPubKeyHex: state.funding.scriptPubKeyHex,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state,
  });

  const harness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.funding.scriptPubKeyHex,
    senderAddress: state.funding.address,
    targetScriptPubKeyHex: freshIdentity.scriptPubKeyHex,
    targetAddress: freshIdentity.address,
  });

  const result = await anchorDomain({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_470_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.dedicatedIndex, 3);
  assert.equal(saved.state.nextDedicatedIndex, 4);
});

test("clearPendingAnchor cancels a reserved draft family and releases its dedicated index for reuse", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-clear-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  const baseState = createAnchorCapableWalletState();
  const reservedIdentity = deriveWalletIdentityMaterial(baseState.keys.accountXprv, 3);
  const state = {
    ...baseState,
    nextDedicatedIndex: 4,
    identities: [
      ...baseState.identities,
      {
        index: 3,
        scriptPubKeyHex: reservedIdentity.scriptPubKeyHex,
        address: reservedIdentity.address,
        status: "dedicated" as const,
        assignedDomainNames: [],
      },
    ],
    domains: [
      {
        name: "weatherbot",
        domainId: 10,
        dedicatedIndex: 3,
        currentOwnerScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
        currentOwnerLocalIndex: 0,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "reserved" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
    ],
    proactiveFamilies: [
      {
        familyId: "anchor-family-clear",
        type: "anchor",
        status: "draft" as const,
        intentFingerprintHex: "cc".repeat(32),
        createdAtUnixMs: 1_700_000_000_000,
        lastUpdatedAtUnixMs: 1_700_000_000_000,
        domainName: "weatherbot",
        domainId: 10,
        sourceSenderLocalIndex: 0,
        sourceSenderScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
        reservedDedicatedIndex: 3,
        reservedScriptPubKeyHex: reservedIdentity.scriptPubKeyHex,
        foundingMessageText: null,
        foundingMessagePayloadHex: null,
        listingCancelCommitted: false,
        currentStep: "reserved",
        tx1: {
          status: "draft",
          attemptedTxid: null,
          attemptedWtxid: null,
          temporaryBuilderLockedOutpoints: [],
          rawHex: null,
        },
        tx2: {
          status: "draft",
          attemptedTxid: null,
          attemptedWtxid: null,
          temporaryBuilderLockedOutpoints: [],
          rawHex: null,
        },
      },
    ],
  } satisfies WalletStateV1;
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "weatherbot",
    ownerScriptPubKeyHex: state.funding.scriptPubKeyHex,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state,
  });

  const clearHarness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.funding.scriptPubKeyHex,
    senderAddress: state.funding.address,
    targetScriptPubKeyHex: reservedIdentity.scriptPubKeyHex,
    targetAddress: reservedIdentity.address,
  });
  const clearPrompter = new ScriptedPrompter(["y"]);

  const cleared = await clearPendingAnchor({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: clearPrompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: clearHarness.rpcFactory,
    nowUnixMs: 1_700_000_480_000,
  });

  let saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.deepEqual(cleared, {
    domainName: "weatherbot",
    cleared: true,
    previousFamilyStatus: "draft",
    previousFamilyStep: "reserved",
    releasedDedicatedIndex: 3,
  });
  assert.deepEqual(clearPrompter.prompts, ['Clear pending anchor for "weatherbot"? [y/N]: ']);
  assert.equal(clearHarness.sendCount, 0);
  assert.equal(saved.state.proactiveFamilies[0]?.status, "canceled");
  assert.equal(saved.state.domains.find((domain) => domain.name === "weatherbot")?.localAnchorIntent, "none");
  assert.equal(saved.state.domains.find((domain) => domain.name === "weatherbot")?.dedicatedIndex, null);
  assert.equal(saved.state.identities.find((identity) => identity.index === 3)?.assignedDomainNames.length, 0);
  assert.equal(saved.state.nextDedicatedIndex, 4);

  const anchorHarness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.funding.scriptPubKeyHex,
    senderAddress: state.funding.address,
    targetScriptPubKeyHex: reservedIdentity.scriptPubKeyHex,
    targetAddress: reservedIdentity.address,
  });

  const anchored = await anchorDomain({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: anchorHarness.rpcFactory,
    nowUnixMs: 1_700_000_490_000,
  });

  saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(anchored.dedicatedIndex, 3);
  assert.equal(anchorHarness.captured.calls[0]?.options.add_inputs, true);
  assert.equal(anchorHarness.captured.calls[1]?.options.add_inputs, true);
  assert.equal(saved.state.domains.find((domain) => domain.name === "weatherbot")?.currentOwnerLocalIndex, 3);
});

test("clearPendingAnchor cancels a reserved draft family even when the local domain record is missing", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-clear-missing-domain-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  const baseState = createAnchorCapableWalletState();
  const reservedIdentity = deriveWalletIdentityMaterial(baseState.keys.accountXprv, 3);
  const state = {
    ...baseState,
    nextDedicatedIndex: 4,
    identities: [
      ...baseState.identities,
      {
        index: 3,
        scriptPubKeyHex: reservedIdentity.scriptPubKeyHex,
        address: reservedIdentity.address,
        status: "dedicated" as const,
        assignedDomainNames: [],
      },
    ],
    domains: [],
    proactiveFamilies: [
      {
        familyId: "anchor-family-clear-missing-domain",
        type: "anchor",
        status: "draft" as const,
        intentFingerprintHex: "cd".repeat(32),
        createdAtUnixMs: 1_700_000_000_000,
        lastUpdatedAtUnixMs: 1_700_000_000_000,
        domainName: "weatherbot",
        domainId: 10,
        sourceSenderLocalIndex: 0,
        sourceSenderScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
        reservedDedicatedIndex: 3,
        reservedScriptPubKeyHex: reservedIdentity.scriptPubKeyHex,
        foundingMessageText: null,
        foundingMessagePayloadHex: null,
        listingCancelCommitted: false,
        currentStep: "reserved",
        tx1: {
          status: "draft",
          attemptedTxid: null,
          attemptedWtxid: null,
          temporaryBuilderLockedOutpoints: [],
          rawHex: null,
        },
        tx2: {
          status: "draft",
          attemptedTxid: null,
          attemptedWtxid: null,
          temporaryBuilderLockedOutpoints: [],
          rawHex: null,
        },
      },
    ],
  } satisfies WalletStateV1;
  await writeInitialUnlockedState({
    paths,
    provider,
    state,
  });

  const clearPrompter = new ScriptedPrompter(["y"]);

  const cleared = await clearPendingAnchor({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: clearPrompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => {
      throw new Error("should_not_attach_service_for_reserved_clear");
    },
    rpcFactory: () => {
      throw new Error("should_not_create_rpc_for_reserved_clear");
    },
    nowUnixMs: 1_700_000_485_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.deepEqual(cleared, {
    domainName: "weatherbot",
    cleared: true,
    previousFamilyStatus: "draft",
    previousFamilyStep: "reserved",
    releasedDedicatedIndex: 3,
  });
  assert.deepEqual(clearPrompter.prompts, ['Clear pending anchor for "weatherbot"? [y/N]: ']);
  assert.equal(saved.state.proactiveFamilies[0]?.status, "canceled");
  assert.deepEqual(saved.state.domains, []);
  assert.equal(saved.state.nextDedicatedIndex, 4);
});

test("clearPendingAnchor returns a no-op result when the domain has no pending anchor family", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-clear-noop-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  const baseState = createAnchorCapableWalletState();
  const state = {
    ...baseState,
    domains: [
      {
        name: "weatherbot",
        domainId: 10,
        dedicatedIndex: null,
        currentOwnerScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
        currentOwnerLocalIndex: 0,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "none" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
    ],
  } satisfies WalletStateV1;
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "weatherbot",
    ownerScriptPubKeyHex: state.funding.scriptPubKeyHex,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state,
  });

  const prompter = new NonInteractivePrompter();
  const result = await clearPendingAnchor({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    nowUnixMs: 1_700_000_500_000,
  });

  assert.deepEqual(result, {
    domainName: "weatherbot",
    cleared: false,
    previousFamilyStatus: null,
    previousFamilyStep: null,
    releasedDedicatedIndex: null,
  });
  assert.deepEqual(prompter.prompts, []);
});

test("clearPendingAnchor refuses non-reserved or already-live anchor families without changing state", async () => {
  for (const [status, localAnchorIntent, currentStep] of [
    ["broadcasting", "reserved", "tx1"],
    ["broadcast-unknown", "reserved", "tx1"],
    ["live", "tx1-live", "tx1"],
    ["repair-required", "repair-required", "tx2"],
  ] as const) {
    const tempRoot = await mkdtemp(join(tmpdir(), `cogcoin-anchor-clear-refuse-${status}-`));
    const paths = createTempWalletPaths(tempRoot);
    const provider = createMemoryWalletSecretProviderForTesting();
    const snapshot = structuredClone(await createSnapshotState());
    const baseState = createAnchorCapableWalletState();
    const reservedIdentity = deriveWalletIdentityMaterial(baseState.keys.accountXprv, 3);
    const state = {
      ...baseState,
      nextDedicatedIndex: 4,
      identities: [
        ...baseState.identities,
        {
          index: 3,
          scriptPubKeyHex: reservedIdentity.scriptPubKeyHex,
          address: reservedIdentity.address,
          status: "dedicated" as const,
          assignedDomainNames: [],
        },
      ],
      domains: [
        {
          name: "weatherbot",
          domainId: 10,
          dedicatedIndex: 3,
          currentOwnerScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
          currentOwnerLocalIndex: 0,
          canonicalChainStatus: "registered-unanchored" as const,
          localAnchorIntent,
          currentCanonicalAnchorOutpoint: null,
          foundingMessageText: null,
          birthTime: null,
        },
      ],
      proactiveFamilies: [
        {
          familyId: `anchor-family-${status}`,
          type: "anchor",
          status,
          intentFingerprintHex: "dd".repeat(32),
          createdAtUnixMs: 1_700_000_000_000,
          lastUpdatedAtUnixMs: 1_700_000_000_000,
          domainName: "weatherbot",
          domainId: 10,
          sourceSenderLocalIndex: 0,
          sourceSenderScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
          reservedDedicatedIndex: 3,
          reservedScriptPubKeyHex: reservedIdentity.scriptPubKeyHex,
          foundingMessageText: null,
          foundingMessagePayloadHex: null,
          listingCancelCommitted: false,
          currentStep,
          tx1: {
            status,
            attemptedTxid: status === "repair-required" ? "44".repeat(32) : null,
            attemptedWtxid: null,
            temporaryBuilderLockedOutpoints: [],
            rawHex: null,
          },
          tx2: {
            status: "draft",
            attemptedTxid: null,
            attemptedWtxid: null,
            temporaryBuilderLockedOutpoints: [],
            rawHex: null,
          },
        },
      ],
    } satisfies WalletStateV1;
    addUnanchoredDomainToSnapshot({
      snapshot,
      domainId: 10,
      domainName: "weatherbot",
      ownerScriptPubKeyHex: state.funding.scriptPubKeyHex,
    });
    await writeInitialUnlockedState({
      paths,
      provider,
      state,
    });

    await assert.rejects(() => clearPendingAnchor({
      domainName: "weatherbot",
      dataDir: paths.bitcoinDataDir,
      databasePath: join(tempRoot, "client.sqlite"),
      provider,
      paths,
      prompter: new NonInteractivePrompter(),
      openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
      nowUnixMs: 1_700_000_510_000,
    }), new RegExp(`wallet_anchor_clear_not_clearable_${status.replaceAll("-", "\\-")}`));

    const saved = await loadWalletState({
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    }, {
      provider,
    });

    assert.equal(saved.state.proactiveFamilies[0]?.status, status);
    assert.equal(saved.state.domains.find((domain) => domain.name === "weatherbot")?.localAnchorIntent, localAnchorIntent);
    assert.equal(saved.state.domains.find((domain) => domain.name === "weatherbot")?.dedicatedIndex, 3);
  }
});

test("anchorDomain builds Case B from an anchored local owner and relocks both replacement anchors", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-case-b-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  const baseState = createAnchorCapableWalletState();
  const state = {
    ...baseState,
    identities: baseState.identities.map((identity) =>
      identity.index === 1
        ? {
          ...identity,
          assignedDomainNames: ["alpha", "alpha-child"],
        }
        : identity
    ),
    domains: [
      ...baseState.domains,
      {
        name: "alpha-child",
        domainId: 10,
        dedicatedIndex: null,
        currentOwnerScriptPubKeyHex: baseState.identities[1]!.scriptPubKeyHex,
        currentOwnerLocalIndex: 1,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "none" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
    ],
  } satisfies WalletStateV1;
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "alpha-child",
    ownerScriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
    listedPriceCogtoshi: 250n,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state,
  });

  const targetIdentity = deriveWalletIdentityMaterial(state.keys.accountXprv, 3);
  const harness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
    senderAddress: state.identities[1]!.address!,
    targetScriptPubKeyHex: targetIdentity.scriptPubKeyHex,
    targetAddress: targetIdentity.address,
    sourceAnchorOutpoint: {
      txid: "aa".repeat(32),
      vout: 1,
    },
  });
  const prompter = new ScriptedPrompter(["alpha-child"]);

  const result = await anchorDomain({
    domainName: "alpha-child",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter,
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_500_000,
  });

  const saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(result.status, "live");
  assert.equal(harness.captured.calls[0]?.options.add_inputs, true);
  assert.equal(harness.captured.calls[1]?.options.add_inputs, true);
  assert.equal(harness.captured.calls[0]?.inputs[0]?.txid, "aa".repeat(32));
  assert.equal(
    (harness.captured.calls[0]?.outputs[2] as Record<string, number>)[state.identities[1]!.address!],
    0.00002,
  );
  assert.equal(harness.captured.calls[1]?.inputs[0]?.txid, harness.tx1Txid);
  assert.deepEqual(harness.captured.relockCalls, [
    [{ txid: harness.tx1Txid, vout: 2 }],
    [{ txid: "aa".repeat(32), vout: 1, valueSats: 2_000 }],
    [{ txid: harness.tx2Txid, vout: 1 }],
  ]);
  assert.match(prompter.lines.join("\n"), /Warning: Tx1 will cancel the current listing/);
  assert.equal(saved.state.proactiveFamilies[0]?.listingCancelCommitted, true);
  assert.equal(saved.state.domains.find((domain) => domain.name === "alpha-child")?.currentOwnerLocalIndex, 3);
  assert.equal(saved.state.domains.find((domain) => domain.name === "alpha-child")?.localAnchorIntent, "tx2-live");
});

test("anchorDomain rejects an anchored-owner Tx1 decode when the source anchor sender is not vin[0]", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-case-b-reordered-source-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  const baseState = createAnchorCapableWalletState();
  const state = {
    ...baseState,
    identities: baseState.identities.map((identity) =>
      identity.index === 1
        ? {
          ...identity,
          assignedDomainNames: ["alpha", "alpha-child"],
        }
        : identity
    ),
    domains: [
      ...baseState.domains,
      {
        name: "alpha-child",
        domainId: 10,
        dedicatedIndex: null,
        currentOwnerScriptPubKeyHex: baseState.identities[1]!.scriptPubKeyHex,
        currentOwnerLocalIndex: 1,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "none" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
    ],
  } satisfies WalletStateV1;
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "alpha-child",
    ownerScriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state,
  });

  const targetIdentity = deriveWalletIdentityMaterial(state.keys.accountXprv, 3);
  const harness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
    senderAddress: state.identities[1]!.address!,
    targetScriptPubKeyHex: targetIdentity.scriptPubKeyHex,
    targetAddress: targetIdentity.address,
    sourceAnchorOutpoint: {
      txid: "aa".repeat(32),
      vout: 1,
    },
    decodedVinOverrides: {
      tx1: [
        {
          txid: "11".repeat(32),
          vout: 0,
          scriptPubKeyHex: state.funding.scriptPubKeyHex,
        },
        {
          txid: "aa".repeat(32),
          vout: 1,
          scriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
        },
        {
          txid: "22".repeat(32),
          vout: 0,
          scriptPubKeyHex: state.funding.scriptPubKeyHex,
        },
      ],
    },
  });

  await assert.rejects(() => anchorDomain({
    domainName: "alpha-child",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["alpha-child"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_505_000,
  }), /wallet_anchor_tx1_sender_input_mismatch/);

  assert.equal(harness.captured.calls[0]?.options.add_inputs, true);
});

test("anchorDomain accepts an anchored-owner Tx1 decode with no optional funding inputs after vin[0]", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-case-b-no-extra-funding-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  const baseState = createAnchorCapableWalletState();
  const state = {
    ...baseState,
    identities: baseState.identities.map((identity) =>
      identity.index === 1
        ? {
          ...identity,
          assignedDomainNames: ["alpha", "alpha-child"],
        }
        : identity
    ),
    domains: [
      ...baseState.domains,
      {
        name: "alpha-child",
        domainId: 10,
        dedicatedIndex: null,
        currentOwnerScriptPubKeyHex: baseState.identities[1]!.scriptPubKeyHex,
        currentOwnerLocalIndex: 1,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "none" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
    ],
  } satisfies WalletStateV1;
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "alpha-child",
    ownerScriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state,
  });

  const targetIdentity = deriveWalletIdentityMaterial(state.keys.accountXprv, 3);
  const harness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
    senderAddress: state.identities[1]!.address!,
    targetScriptPubKeyHex: targetIdentity.scriptPubKeyHex,
    targetAddress: targetIdentity.address,
    sourceAnchorOutpoint: {
      txid: "aa".repeat(32),
      vout: 1,
    },
    decodedVinOverrides: {
      tx1: [
        {
          txid: "aa".repeat(32),
          vout: 1,
          scriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
        },
      ],
    },
  });

  const result = await anchorDomain({
    domainName: "alpha-child",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["alpha-child"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_505_250,
  });

  assert.equal(result.status, "live");
});

for (const [label, tx1Vin] of [
  [
    "non-funding vin[1] support",
    [
      {
        txid: "aa".repeat(32),
        vout: 1,
        scriptPubKeyHex: createAnchorCapableWalletState().identities[1]!.scriptPubKeyHex,
      },
      {
        txid: "99".repeat(32),
        vout: 7,
        scriptPubKeyHex: "0014ffffffffffffffffffffffffffffffffffffffff",
      },
    ],
  ],
] as const) {
  test(`anchorDomain rejects an anchored-owner Tx1 decode with ${label}`, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-case-b-bad-funding-slot-"));
    const paths = createTempWalletPaths(tempRoot);
    const provider = createMemoryWalletSecretProviderForTesting();
    const snapshot = structuredClone(await createSnapshotState());
    const baseState = createAnchorCapableWalletState();
    const state = {
      ...baseState,
      identities: baseState.identities.map((identity) =>
        identity.index === 1
          ? {
            ...identity,
            assignedDomainNames: ["alpha", "alpha-child"],
          }
          : identity
      ),
      domains: [
        ...baseState.domains,
        {
          name: "alpha-child",
          domainId: 10,
          dedicatedIndex: null,
          currentOwnerScriptPubKeyHex: baseState.identities[1]!.scriptPubKeyHex,
          currentOwnerLocalIndex: 1,
          canonicalChainStatus: "registered-unanchored" as const,
          localAnchorIntent: "none" as const,
          currentCanonicalAnchorOutpoint: null,
          foundingMessageText: null,
          birthTime: null,
        },
      ],
    } satisfies WalletStateV1;
    addUnanchoredDomainToSnapshot({
      snapshot,
      domainId: 10,
      domainName: "alpha-child",
      ownerScriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
    });
    await writeInitialUnlockedState({
      paths,
      provider,
      state,
    });

    const targetIdentity = deriveWalletIdentityMaterial(state.keys.accountXprv, 3);
    const harness = createAnchorRpcHarness({
      snapshotHeight: snapshot.history.currentHeight ?? 0,
      fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
      fundingAddress: state.funding.address,
      senderScriptPubKeyHex: state.identities[1]!.scriptPubKeyHex,
      senderAddress: state.identities[1]!.address!,
      targetScriptPubKeyHex: targetIdentity.scriptPubKeyHex,
      targetAddress: targetIdentity.address,
      sourceAnchorOutpoint: {
        txid: "aa".repeat(32),
        vout: 1,
      },
      decodedVinOverrides: {
        tx1: tx1Vin.map((input) => ({ ...input })),
      },
    });

    await assert.rejects(() => anchorDomain({
      domainName: "alpha-child",
      dataDir: paths.bitcoinDataDir,
      databasePath: join(tempRoot, "client.sqlite"),
      provider,
      paths,
      prompter: new ScriptedPrompter(["alpha-child"]),
      openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
      attachService: async () => ({
        rpc: {
          url: "http://127.0.0.1:18443",
          cookieFile: "/tmp/does-not-matter",
          port: 18_443,
        },
      } as never),
      rpcFactory: harness.rpcFactory,
      nowUnixMs: 1_700_000_505_500,
    }), /wallet_anchor_tx1_unexpected_funding_input/);
  });
}

test("anchorDomain rejects a Tx2 decode when the provisional sender is not vin[0]", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-tx2-reordered-provisional-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  const baseState = createAnchorCapableWalletState();
  const state = {
    ...baseState,
    identities: baseState.identities.map((identity) =>
      identity.index === 0
        ? {
          ...identity,
          assignedDomainNames: ["weatherbot"],
        }
        : identity
    ),
    domains: [
      ...baseState.domains,
      {
        name: "weatherbot",
        domainId: 10,
        dedicatedIndex: 0,
        currentOwnerScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
        currentOwnerLocalIndex: 0,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "none" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
    ],
  } satisfies WalletStateV1;
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "weatherbot",
    ownerScriptPubKeyHex: state.funding.scriptPubKeyHex,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state,
  });

  const targetIdentity = deriveWalletIdentityMaterial(state.keys.accountXprv, 3);
  const harness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.funding.scriptPubKeyHex,
    senderAddress: state.funding.address,
    targetScriptPubKeyHex: targetIdentity.scriptPubKeyHex,
    targetAddress: targetIdentity.address,
    decodedVinOverrides: {
      tx2: [
        {
          txid: "11".repeat(32),
          vout: 0,
          scriptPubKeyHex: state.funding.scriptPubKeyHex,
        },
        {
          txid: "55".repeat(32),
          vout: 1,
          scriptPubKeyHex: targetIdentity.scriptPubKeyHex,
        },
        {
          txid: "22".repeat(32),
          vout: 0,
          scriptPubKeyHex: state.funding.scriptPubKeyHex,
        },
      ],
    },
  });

  await assert.rejects(() => anchorDomain({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_506_000,
  }), /wallet_anchor_tx2_provisional_input_mismatch/);

  assert.equal(harness.captured.calls[1]?.options.add_inputs, true);
});

test("anchorDomain accepts a Tx2 decode with no optional funding inputs after the provisional vin[0]", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-tx2-no-extra-funding-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  const baseState = createAnchorCapableWalletState();
  const state = {
    ...baseState,
    identities: baseState.identities.map((identity) =>
      identity.index === 0
        ? {
          ...identity,
          assignedDomainNames: ["weatherbot"],
        }
        : identity
    ),
    domains: [
      ...baseState.domains,
      {
        name: "weatherbot",
        domainId: 10,
        dedicatedIndex: 0,
        currentOwnerScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
        currentOwnerLocalIndex: 0,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "none" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
    ],
  } satisfies WalletStateV1;
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "weatherbot",
    ownerScriptPubKeyHex: state.funding.scriptPubKeyHex,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state,
  });

  const targetIdentity = deriveWalletIdentityMaterial(state.keys.accountXprv, 3);
  const harness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.funding.scriptPubKeyHex,
    senderAddress: state.funding.address,
    targetScriptPubKeyHex: targetIdentity.scriptPubKeyHex,
    targetAddress: targetIdentity.address,
    decodedVinOverrides: {
      tx2: [
        {
          txid: "55".repeat(32),
          vout: 1,
          scriptPubKeyHex: targetIdentity.scriptPubKeyHex,
        },
      ],
    },
  });

  const result = await anchorDomain({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_506_250,
  });

  assert.equal(result.status, "live");
});

for (const [label, tx2Vin] of [
  [
    "non-funding vin[1] support",
    [
      {
        txid: "55".repeat(32),
        vout: 1,
        scriptPubKeyHex: deriveWalletIdentityMaterial(createAnchorCapableWalletState().keys.accountXprv, 3).scriptPubKeyHex,
      },
      {
        txid: "99".repeat(32),
        vout: 7,
        scriptPubKeyHex: "0014ffffffffffffffffffffffffffffffffffffffff",
      },
    ],
  ],
] as const) {
  test(`anchorDomain rejects a Tx2 decode with ${label}`, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-tx2-bad-funding-slot-"));
    const paths = createTempWalletPaths(tempRoot);
    const provider = createMemoryWalletSecretProviderForTesting();
    const snapshot = structuredClone(await createSnapshotState());
    const baseState = createAnchorCapableWalletState();
    const state = {
      ...baseState,
      identities: baseState.identities.map((identity) =>
        identity.index === 0
          ? {
            ...identity,
            assignedDomainNames: ["weatherbot"],
          }
          : identity
      ),
      domains: [
        ...baseState.domains,
        {
          name: "weatherbot",
          domainId: 10,
          dedicatedIndex: 0,
          currentOwnerScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
          currentOwnerLocalIndex: 0,
          canonicalChainStatus: "registered-unanchored" as const,
          localAnchorIntent: "none" as const,
          currentCanonicalAnchorOutpoint: null,
          foundingMessageText: null,
          birthTime: null,
        },
      ],
    } satisfies WalletStateV1;
    addUnanchoredDomainToSnapshot({
      snapshot,
      domainId: 10,
      domainName: "weatherbot",
      ownerScriptPubKeyHex: state.funding.scriptPubKeyHex,
    });
    await writeInitialUnlockedState({
      paths,
      provider,
      state,
    });

    const targetIdentity = deriveWalletIdentityMaterial(state.keys.accountXprv, 3);
    const harness = createAnchorRpcHarness({
      snapshotHeight: snapshot.history.currentHeight ?? 0,
      fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
      fundingAddress: state.funding.address,
      senderScriptPubKeyHex: state.funding.scriptPubKeyHex,
      senderAddress: state.funding.address,
      targetScriptPubKeyHex: targetIdentity.scriptPubKeyHex,
      targetAddress: targetIdentity.address,
      decodedVinOverrides: {
        tx2: tx2Vin.map((input) => ({ ...input })),
      },
    });

    await assert.rejects(() => anchorDomain({
      domainName: "weatherbot",
      dataDir: paths.bitcoinDataDir,
      databasePath: join(tempRoot, "client.sqlite"),
      provider,
      paths,
      prompter: new ScriptedPrompter(["weatherbot"]),
      openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
      attachService: async () => ({
        rpc: {
          url: "http://127.0.0.1:18443",
          cookieFile: "/tmp/does-not-matter",
          port: 18_443,
        },
      } as never),
      rpcFactory: harness.rpcFactory,
      nowUnixMs: 1_700_000_506_500,
    }), /wallet_anchor_tx2_unexpected_funding_input/);
  });
}

test("anchorDomain rejects a Tx2 decode with a foreign later input after the required prefix", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-tx2-foreign-later-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  const baseState = createAnchorCapableWalletState();
  const state = {
    ...baseState,
    identities: baseState.identities.map((identity) =>
      identity.index === 0
        ? {
          ...identity,
          assignedDomainNames: ["weatherbot"],
        }
        : identity
    ),
    domains: [
      ...baseState.domains,
      {
        name: "weatherbot",
        domainId: 10,
        dedicatedIndex: 0,
        currentOwnerScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
        currentOwnerLocalIndex: 0,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "none" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
    ],
  } satisfies WalletStateV1;
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "weatherbot",
    ownerScriptPubKeyHex: state.funding.scriptPubKeyHex,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state,
  });

  const targetIdentity = deriveWalletIdentityMaterial(state.keys.accountXprv, 3);
  const harness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.funding.scriptPubKeyHex,
    senderAddress: state.funding.address,
    targetScriptPubKeyHex: targetIdentity.scriptPubKeyHex,
    targetAddress: targetIdentity.address,
    decodedVinOverrides: {
      tx2: [
        {
          txid: "55".repeat(32),
          vout: 1,
          scriptPubKeyHex: targetIdentity.scriptPubKeyHex,
        },
        {
          txid: "11".repeat(32),
          vout: 0,
          scriptPubKeyHex: state.funding.scriptPubKeyHex,
        },
        {
          txid: "99".repeat(32),
          vout: 7,
          scriptPubKeyHex: "0014ffffffffffffffffffffffffffffffffffffffff",
        },
      ],
    },
  });

  await assert.rejects(() => anchorDomain({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    nowUnixMs: 1_700_000_506_750,
  }), /wallet_anchor_tx2_unexpected_funding_input/);
});

test("anchorDomain continues into Tx2 when a prior Tx1 becomes visible on retry", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-anchor-retry-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const snapshot = structuredClone(await createSnapshotState());
  const baseState = createAnchorCapableWalletState();
  const state = {
    ...baseState,
    identities: baseState.identities.map((identity) =>
      identity.index === 0
        ? {
          ...identity,
          assignedDomainNames: ["weatherbot"],
        }
        : identity
    ),
    domains: [
      ...baseState.domains,
      {
        name: "weatherbot",
        domainId: 10,
        dedicatedIndex: 0,
        currentOwnerScriptPubKeyHex: baseState.funding.scriptPubKeyHex,
        currentOwnerLocalIndex: 0,
        canonicalChainStatus: "registered-unanchored" as const,
        localAnchorIntent: "none" as const,
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
    ],
  } satisfies WalletStateV1;
  addUnanchoredDomainToSnapshot({
    snapshot,
    domainId: 10,
    domainName: "weatherbot",
    ownerScriptPubKeyHex: state.funding.scriptPubKeyHex,
  });
  await writeInitialUnlockedState({
    paths,
    provider,
    state,
  });

  const targetIdentity = deriveWalletIdentityMaterial(state.keys.accountXprv, 3);
  const firstHarness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.funding.scriptPubKeyHex,
    senderAddress: state.funding.address,
    targetScriptPubKeyHex: targetIdentity.scriptPubKeyHex,
    targetAddress: targetIdentity.address,
    sendErrors: [new Error("The managed Bitcoin RPC request timed out."), undefined],
  });

  await assert.rejects(() => anchorDomain({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: firstHarness.rpcFactory,
    nowUnixMs: 1_700_000_600_000,
  }), /wallet_anchor_tx1_broadcast_unknown/);

  let saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });
  assert.equal(saved.state.proactiveFamilies[0]?.status, "broadcast-unknown");
  assert.equal(saved.state.proactiveFamilies[0]?.currentStep, "tx1");

  const retryHarness = createAnchorRpcHarness({
    snapshotHeight: snapshot.history.currentHeight ?? 0,
    fundingScriptPubKeyHex: state.funding.scriptPubKeyHex,
    fundingAddress: state.funding.address,
    senderScriptPubKeyHex: state.funding.scriptPubKeyHex,
    senderAddress: state.funding.address,
    targetScriptPubKeyHex: targetIdentity.scriptPubKeyHex,
    targetAddress: targetIdentity.address,
    tx1MempoolVisible: true,
  });

  const retried = await anchorDomain({
    domainName: "weatherbot",
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: new ScriptedPrompter(["weatherbot"]),
    openReadContext: async () => createDynamicReadContext({ paths, provider, snapshot }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: retryHarness.rpcFactory,
    nowUnixMs: 1_700_000_700_000,
  });

  saved = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(retried.reusedExisting, true);
  assert.equal(retried.status, "live");
  assert.equal(retried.dedicatedIndex, saved.state.proactiveFamilies[0]?.reservedDedicatedIndex);
  assert.equal(retryHarness.sendCount, 1);
  assert.equal(retryHarness.captured.calls.length, 1);
  assert.equal(retryHarness.captured.calls[0]?.inputs[0]?.txid, retryHarness.tx1Txid);
  assert.equal(saved.state.proactiveFamilies.length, 1);
  assert.equal(saved.state.proactiveFamilies[0]?.status, "live");
  assert.equal(saved.state.proactiveFamilies[0]?.currentStep, "tx2");
  assert.equal(saved.state.domains.find((domain) => domain.name === "weatherbot")?.localAnchorIntent, "tx2-live");
});
