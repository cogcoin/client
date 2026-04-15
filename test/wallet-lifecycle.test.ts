import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, constants, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bech32 } from "@scure/base";
import { HDKey } from "@scure/bip32";

import { readPortableWalletArchive } from "../src/wallet/archive.js";
import {
  deleteImportedWalletSeed,
  exportWallet,
  importWallet,
  initializeWallet,
  loadOrAutoUnlockWalletState,
  loadUnlockedWalletState,
  lockWallet,
  parseUnlockDurationToMs,
  repairWallet,
  restoreWalletFromMnemonic,
  showWalletMnemonic,
  unlockWallet,
  verifyManagedCoreWalletReplica,
  type WalletPrompter,
} from "../src/wallet/lifecycle.js";
import { deriveWalletMaterialFromMnemonic } from "../src/wallet/material.js";
import { saveBuiltInMiningProviderConfig } from "../src/wallet/mining/config.js";
import { saveMiningRuntimeStatus } from "../src/wallet/mining/runtime-artifacts.js";
import type { MiningRuntimeStatusV1 } from "../src/wallet/mining/types.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  loadWalletPendingInitializationState,
  saveWalletPendingInitializationState,
} from "../src/wallet/state/pending-init.js";
import {
  createDefaultWalletSecretProviderForTesting,
  createMemoryWalletSecretProviderForTesting,
  createWalletPendingInitSecretReference,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { loadWalletSeedIndex } from "../src/wallet/state/seed-index.js";
import { acquireFileLock } from "../src/wallet/fs/lock.js";
import { loadWalletExplicitLock } from "../src/wallet/state/explicit-lock.js";
import { clearUnlockSession, loadUnlockSession } from "../src/wallet/state/session.js";
import { loadWalletState, saveWalletState } from "../src/wallet/state/storage.js";
import type { WalletPendingInitializationStateV1, WalletStateV1 } from "../src/wallet/types.js";
import {
  INDEXER_DAEMON_SCHEMA_VERSION,
  INDEXER_DAEMON_SERVICE_API_VERSION,
  MANAGED_BITCOIND_SERVICE_API_VERSION,
  type ManagedBitcoindServiceStatus,
} from "../src/bitcoind/types.js";
import { resolveManagedServicePaths } from "../src/bitcoind/service-paths.js";

const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

function hash160(value: Uint8Array): Uint8Array {
  const sha256 = createHash("sha256").update(value).digest();
  return createHash("ripemd160").update(sha256).digest();
}

function deriveAddressFromDescriptor(descriptor: string): string {
  const match = stripDescriptorChecksum(descriptor).match(/]([A-Za-z0-9]+)\/0\/\*/);

  if (match == null) {
    throw new Error(`cannot_parse_descriptor_${descriptor}`);
  }

  const node = HDKey.fromExtendedKey(match[1]!).derive("m/0/0");

  if (node.publicKey == null) {
    throw new Error("descriptor_missing_public_key");
  }

  return bech32.encode("bc", [0, ...bech32.toWords(hash160(node.publicKey))]);
}

function stripDescriptorChecksum(descriptor: string): string {
  return descriptor.replace(/#[A-Za-z0-9]+$/, "");
}

function mockDescriptorChecksum(descriptor: string): string {
  return createHash("sha256").update(stripDescriptorChecksum(descriptor)).digest("hex").slice(0, 8);
}

function toPublicDescriptor(descriptor: string): string {
  const stripped = stripDescriptorChecksum(descriptor);
  const match = /^wpkh\((\[[^\]]+\])([A-Za-z0-9]+)(\/0\/\*)\)$/.exec(stripped);

  if (match == null) {
    throw new Error(`cannot_convert_descriptor_${descriptor}`);
  }

  const node = HDKey.fromExtendedKey(match[2]!);
  const publicExtendedKey = node.publicExtendedKey;

  if (publicExtendedKey == null) {
    throw new Error("descriptor_missing_public_extended_key");
  }

  return `wpkh(${match[1]}${publicExtendedKey}${match[3]})`;
}

function createTempWalletPaths(root: string, seedName?: string | null) {
  return resolveWalletRuntimePathsForTesting({
    platform: "linux",
    homeDirectory: root,
    env: {
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
    },
    seedName,
  });
}

function createPendingInitializationStoragePaths(
  paths: ReturnType<typeof createTempWalletPaths>,
) {
  return {
    primaryPath: paths.walletInitPendingPath,
    backupPath: paths.walletInitPendingBackupPath,
  };
}

async function savePendingInitializationFixture(options: {
  paths: ReturnType<typeof createTempWalletPaths>;
  provider: ReturnType<typeof createMemoryWalletSecretProviderForTesting>;
  phrase: string;
  createdAtUnixMs?: number;
}) {
  const secretReference = createWalletPendingInitSecretReference(options.paths.walletStateRoot);
  const state: WalletPendingInitializationStateV1 = {
    schemaVersion: 1,
    createdAtUnixMs: options.createdAtUnixMs ?? 1_700_000_000_000,
    mnemonic: {
      phrase: options.phrase,
      language: "english",
    },
  };

  await options.provider.storeSecret(secretReference.keyId, new Uint8Array(32).fill(7));
  await saveWalletPendingInitializationState(
    createPendingInitializationStoragePaths(options.paths),
    state,
    {
      provider: options.provider,
      secretReference,
    },
  );
}

function isPidRunning(pid: number | null | undefined): boolean {
  if (pid == null) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }

    return true;
  }
}

function formatMnemonicArtSlot(index: number, word: string): string {
  return `${index}.${word.padEnd(8, " ")}`;
}

function assertFragmentsAppearInOrder(line: string, fragments: readonly string[]): void {
  let cursor = -1;

  for (const fragment of fragments) {
    const next = line.indexOf(fragment, cursor + 1);
    assert.notEqual(next, -1, `missing_fragment_${fragment}`);
    assert.ok(next > cursor, `fragment_out_of_order_${fragment}`);
    cursor = next;
  }
}

class CapturingPrompter implements WalletPrompter {
  readonly isInteractive = true;
  readonly lines: string[] = [];
  readonly prompts: string[] = [];
  readonly clearedScopes: Array<"mnemonic-reveal" | "restore-mnemonic-entry"> = [];
  mnemonicWords: string[] = [];
  mode: "correct" | "wrong" = "correct";
  extraPrompts: string[] = [];
  promptReplies: string[] = [];
  hiddenPrompts: string[] = [];
  clearError: Error | null = null;

  writeLine(message: string): void {
    this.lines.push(message);
    const words = message.trim().split(/\s+/);

    if (words.length === 24) {
      this.mnemonicWords = words;
    }
  }

  async prompt(message: string): Promise<string> {
    this.prompts.push(message);

    if (!message.includes("Confirm word #")) {
      const visibleReply = this.promptReplies.shift();

      if (visibleReply !== undefined) {
        return visibleReply;
      }

      const next = this.extraPrompts.shift();

      if (next === undefined) {
        throw new Error(`unexpected_prompt_${message}`);
      }

      return next;
    }

    const index = Number.parseInt(message.match(/#(\d+)/)?.[1] ?? "0", 10) - 1;

    if (this.mode === "wrong") {
      return "wrong";
    }

    return this.mnemonicWords[index] ?? "wrong";
  }

  async promptHidden(message: string): Promise<string> {
    const next = this.hiddenPrompts.shift();

    if (next === undefined) {
      throw new Error(`unexpected_hidden_prompt_${message}`);
    }

    return next;
  }

  clearSensitiveDisplay(scope: "mnemonic-reveal" | "restore-mnemonic-entry"): void {
    this.clearedScopes.push(scope);

    if (this.clearError !== null) {
      throw this.clearError;
    }
  }
}

function createRpcHarness() {
  const importedDescriptors: string[] = [];
  const listedDescriptors: string[] = [];
  const wallets = new Set<string>();
  let walletLocked = false;

  return {
    rpcFactory() {
      return {
        async getDescriptorInfo(descriptor: string) {
          const checksum = mockDescriptorChecksum(descriptor);
          return {
            descriptor: toPublicDescriptor(descriptor),
            checksum,
            isrange: true,
            issolvable: true,
            hasprivatekeys: stripDescriptorChecksum(descriptor).includes("xprv"),
          };
        },
        async walletPassphrase() {
          walletLocked = false;
          return null;
        },
        async createWallet(walletName: string) {
          wallets.add(walletName);
          return {
            name: walletName,
            warning: "",
          };
        },
        async importDescriptors(_walletName: string, requests: Array<{ desc: string }>) {
          importedDescriptors.push(...requests.map((request) => request.desc));
          return requests.map((request) => {
            if (!stripDescriptorChecksum(request.desc).includes("xprv")) {
              return {
                success: false,
                error: {
                  code: -4,
                  message: "Cannot import descriptor without private keys to a wallet with private keys enabled",
                },
              };
            }

            const publicDescriptor = toPublicDescriptor(request.desc);
            listedDescriptors.push(`${publicDescriptor}#${mockDescriptorChecksum(publicDescriptor)}`);
            return { success: true };
          });
        },
        async walletLock() {
          walletLocked = true;
          return null;
        },
        async loadWallet(walletName: string) {
          if (!wallets.has(walletName)) {
            throw new Error("bitcoind_rpc_loadwallet_-18_wallet_not_found");
          }

          return {
            name: walletName,
            warning: "",
          };
        },
        async listWallets() {
          return [...wallets];
        },
        async deriveAddresses(descriptor: string) {
          return [deriveAddressFromDescriptor(descriptor)];
        },
        async listDescriptors() {
          return {
            descriptors: listedDescriptors.map((desc) => ({ desc })),
          };
        },
        async getWalletInfo(walletName: string) {
          return {
            walletname: walletName,
            private_keys_enabled: true,
            descriptors: true,
          };
        },
        async getBlockchainInfo() {
          return {
            blocks: 123,
            headers: 123,
          };
        },
      };
    },
    get importedDescriptors() {
      return importedDescriptors.slice();
    },
    get listedDescriptors() {
      return listedDescriptors.slice();
    },
    get walletLocked() {
      return walletLocked;
    },
  };
}

const healthySnapshotTip = async () => ({
  nodeBestHeight: 123,
  snapshotHeight: 123,
});

function createRepairIndexerDaemonStub(options: {
  walletRootId: string;
  state?: "starting" | "catching-up" | "synced" | "failed";
  coreBestHeight?: number | null;
  snapshotHeight?: number | null;
}) {
  const state = options.state ?? "synced";
  const coreBestHeight = options.coreBestHeight ?? 123;
  const snapshotHeight = options.snapshotHeight ?? coreBestHeight;
  const createHandle = () => ({
    token: "repair-snapshot",
    expiresAtUnixMs: 1_700_000_030_000,
    serviceApiVersion: INDEXER_DAEMON_SERVICE_API_VERSION,
    binaryVersion: "0.0.0-test",
    buildId: null,
    walletRootId: options.walletRootId,
    daemonInstanceId: "daemon-repair",
    schemaVersion: INDEXER_DAEMON_SCHEMA_VERSION,
    processId: 4321,
    startedAtUnixMs: 1_700_000_000_000,
    state,
    heartbeatAtUnixMs: 1_700_000_000_000,
    rpcReachable: true,
    coreBestHeight,
    coreBestHash: coreBestHeight === null ? null : "aa".repeat(32),
    appliedTipHeight: snapshotHeight,
    appliedTipHash: snapshotHeight === null ? null : "bb".repeat(32),
    snapshotSeq: "9",
    backlogBlocks: coreBestHeight === null || snapshotHeight === null ? null : Math.max(coreBestHeight - snapshotHeight, 0),
    reorgDepth: null,
    lastAppliedAtUnixMs: 1_700_000_000_000,
    activeSnapshotCount: 1,
    lastError: state === "failed" ? "refresh failed" : null,
    tipHeight: snapshotHeight,
    tipHash: snapshotHeight === null ? null : "bb".repeat(32),
    openedAtUnixMs: 1_700_000_000_000,
  });

  return {
    async getStatus() {
      throw new Error("unused");
    },
    async openSnapshot() {
      return createHandle();
    },
    async readSnapshot(token: string) {
      const handle = createHandle();
      return {
        token,
        serviceApiVersion: handle.serviceApiVersion,
        schemaVersion: handle.schemaVersion,
        walletRootId: handle.walletRootId,
        daemonInstanceId: handle.daemonInstanceId,
        processId: handle.processId,
        startedAtUnixMs: handle.startedAtUnixMs,
        snapshotSeq: handle.snapshotSeq,
        tipHeight: handle.tipHeight,
        tipHash: handle.tipHash,
        openedAtUnixMs: handle.openedAtUnixMs,
        stateBase64: "",
        tip: snapshotHeight === null
          ? null
          : {
            height: snapshotHeight,
            blockHashHex: "bb".repeat(32),
            previousHashHex: "aa".repeat(32),
            stateHashHex: "cc".repeat(32),
          },
        expiresAtUnixMs: handle.expiresAtUnixMs,
      };
    },
    async closeSnapshot() {
      return;
    },
    async close() {
      return;
    },
  };
}

function createInMemoryLinuxSecretToolRunner() {
  const secrets = new Map<string, string>();

  return async (
    args: readonly string[],
    options: { stdin?: string } = {},
  ) => {
    const [command, ...rest] = args;

    if (command === "store") {
      const keyId = rest[rest.length - 1] ?? null;
      if (keyId !== null) {
        secrets.set(keyId, options.stdin ?? "");
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
      };
    }

    const keyId = rest[rest.length - 1] ?? null;

    if (command === "lookup") {
      const stored = keyId === null ? undefined : secrets.get(keyId);
      return stored === undefined
        ? {
          stdout: "",
          stderr: "",
          exitCode: 1,
          signal: null,
        }
        : {
          stdout: stored,
          stderr: "",
          exitCode: 0,
          signal: null,
        };
    }

    if (command === "clear") {
      if (keyId !== null) {
        secrets.delete(keyId);
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
      };
    }

    throw new Error(`unexpected_secret_tool_command_${command}`);
  };
}

async function initializeRepairWalletFixture(prefix: string) {
  const tempRoot = await mkdtemp(join(tmpdir(), prefix));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = new CapturingPrompter();
  const harness = createRpcHarness();
  const databasePath = join(tempRoot, "client.sqlite");
  const initialized = await initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });

  return {
    tempRoot,
    paths,
    provider,
    harness,
    initialized,
    databasePath,
  };
}

function createMiningRuntimeSnapshot(
  walletRootId: string,
  partial: Partial<MiningRuntimeStatusV1> = {},
): MiningRuntimeStatusV1 {
  return {
    schemaVersion: 1,
    walletRootId,
    workerApiVersion: "cogcoin/mining-worker/v1",
    workerBinaryVersion: "0.0.0-test",
    workerBuildId: null,
    updatedAtUnixMs: 1_700_000_000_000,
    runMode: "stopped",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    backgroundWorkerHeartbeatAtUnixMs: null,
    backgroundWorkerHealth: null,
    indexerDaemonState: "synced",
    indexerDaemonInstanceId: "daemon-repair",
    indexerHeartbeatAtUnixMs: 1_700_000_000_000,
    coreBestHeight: 123,
    coreBestHash: "aa".repeat(32),
    indexerTipHeight: 123,
    indexerTipHash: "bb".repeat(32),
    indexerReorgDepth: null,
    indexerTipAligned: true,
    corePublishState: "healthy",
    providerState: "ready",
    lastSuspendDetectedAtUnixMs: null,
    reconnectSettledUntilUnixMs: null,
    tipSettledUntilUnixMs: null,
    miningState: "idle",
    currentPhase: "idle",
    currentPublishState: "none",
    targetBlockHeight: null,
    referencedBlockHashDisplay: null,
    currentDomainId: null,
    currentDomainName: null,
    currentSentenceDisplay: null,
    currentCanonicalBlend: null,
    currentTxid: null,
    currentWtxid: null,
    liveMiningFamilyInMempool: false,
    currentFeeRateSatVb: null,
    currentAbsoluteFeeSats: null,
    currentBlockFeeSpentSats: "0",
    sessionFeeSpentSats: "0",
    lifetimeFeeSpentSats: "0",
    sameDomainCompetitorSuppressed: null,
    higherRankedCompetitorDomainCount: null,
    dedupedCompetitorDomainCount: null,
    competitivenessGateIndeterminate: null,
    mempoolSequenceCacheStatus: null,
    currentPublishDecision: null,
    lastMempoolSequence: null,
    lastCompetitivenessGateAtUnixMs: null,
    pauseReason: null,
    hookMode: "builtin",
    providerConfigured: true,
    providerKind: "openai",
    bitcoindHealth: "ready",
    bitcoindServiceState: "ready",
    bitcoindReplicaStatus: "ready",
    nodeHealth: "synced",
    indexerHealth: "synced",
    tipsAligned: true,
    lastValidationState: "unknown",
    lastOperatorValidationState: "never",
    lastValidationAtUnixMs: null,
    lastEventAtUnixMs: null,
    lastError: null,
    note: null,
    ...partial,
  };
}

async function configureBuiltInMiningProvider(options: {
  paths: ReturnType<typeof createTempWalletPaths>;
  provider: ReturnType<typeof createMemoryWalletSecretProviderForTesting>;
  walletRootId: string;
  nowUnixMs: number;
}) {
  await saveBuiltInMiningProviderConfig({
    path: options.paths.clientConfigPath,
    provider: options.provider,
    secretReference: createWalletSecretReference(options.walletRootId),
    config: {
      provider: "openai",
      apiKey: "test-api-key",
      extraPrompt: null,
      modelOverride: null,
      updatedAtUnixMs: options.nowUnixMs,
    },
  });
}

test("parseUnlockDurationToMs defaults to 15m and rejects invalid values", () => {
  assert.equal(parseUnlockDurationToMs(undefined), 15 * 60 * 1000);
  assert.equal(parseUnlockDurationToMs("32m"), 32 * 60 * 1000);
  assert.equal(parseUnlockDurationToMs("2h"), 2 * 60 * 60 * 1000);
  assert.equal(parseUnlockDurationToMs("1d"), 24 * 60 * 60 * 1000);
  assert.throws(() => parseUnlockDurationToMs("0m"));
  assert.throws(() => parseUnlockDurationToMs("-5m"));
  assert.throws(() => parseUnlockDurationToMs("abc"));
});

test("initializeWallet writes provider-backed state, creates an unlock session, and bootstraps the managed descriptor wallet", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-init-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = new CapturingPrompter();
  const harness = createRpcHarness();

  const result = await initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });

  const unlocked = await loadUnlockedWalletState({
    provider,
    paths,
    nowUnixMs: 1_700_000_000_100,
  });

  assert.ok(result.walletRootId.startsWith("wallet-"));
  assert.equal(result.state.stateRevision, 2);
  assert.equal(result.state.managedCoreWallet.proofStatus, "ready");
  assert.match(result.state.descriptor.privateExternal, /xprv/);
  assert.match(result.state.descriptor.publicExternal, /xpub/);
  assert.equal(result.state.descriptor.checksum, mockDescriptorChecksum(result.state.descriptor.publicExternal));
  assert.equal(
    result.state.managedCoreWallet.descriptorChecksum,
    mockDescriptorChecksum(result.state.descriptor.publicExternal),
  );
  assert.equal(result.state.funding.address, result.fundingAddress);
  assert.equal(unlocked?.state.walletRootId, result.walletRootId);
  assert.equal(unlocked?.session.sourceStateRevision, 2);
  assert.equal(harness.importedDescriptors.length, 1);
  assert.equal(harness.importedDescriptors[0], result.state.descriptor.privateExternal);
  assert.equal(harness.listedDescriptors[0], result.state.descriptor.publicExternal);
  assert.equal(harness.walletLocked, true);
  assert.deepEqual(prompter.clearedScopes, ["mnemonic-reveal"]);
  const mnemonicWords = result.state.mnemonic.phrase.split(" ");
  const artRow1 = prompter.lines.find((line) => line.includes(formatMnemonicArtSlot(1, mnemonicWords[0]!)));
  const artRow5 = prompter.lines.find((line) => line.includes(formatMnemonicArtSlot(5, mnemonicWords[4]!)));
  assert.ok(artRow1);
  assert.ok(artRow5);
  assertFragmentsAppearInOrder(artRow1, [
    formatMnemonicArtSlot(1, mnemonicWords[0]!),
    formatMnemonicArtSlot(6, mnemonicWords[5]!),
    formatMnemonicArtSlot(11, mnemonicWords[10]!),
    formatMnemonicArtSlot(16, mnemonicWords[15]!),
    formatMnemonicArtSlot(21, mnemonicWords[20]!),
  ]);
  assertFragmentsAppearInOrder(artRow5, [
    formatMnemonicArtSlot(5, mnemonicWords[4]!),
    formatMnemonicArtSlot(10, mnemonicWords[9]!),
    formatMnemonicArtSlot(15, mnemonicWords[14]!),
    formatMnemonicArtSlot(20, mnemonicWords[19]!),
  ]);
  const trailingAfterTwenty = artRow5.slice(
    artRow5.indexOf(formatMnemonicArtSlot(20, mnemonicWords[19]!)) + formatMnemonicArtSlot(20, mnemonicWords[19]!).length,
  );
  assert.equal(trailingAfterTwenty, "               │");
  const singleLineCopyIndex = prompter.lines.indexOf("Single-line copy:");
  const phraseIndex = prompter.lines.indexOf(result.state.mnemonic.phrase);
  assert.ok(singleLineCopyIndex > -1);
  assert.equal(phraseIndex, singleLineCopyIndex + 1);
  assert.ok(prompter.lines.indexOf(artRow1) < singleLineCopyIndex);
  assert.equal(
    prompter.lines.includes("The same phrase will be shown again until confirmation succeeds:"),
    true,
  );
  await assert.rejects(() => access(paths.walletInitPendingPath, constants.F_OK));
  await assert.rejects(() => access(paths.walletInitPendingBackupPath, constants.F_OK));
  await assert.rejects(() => provider.loadSecret(createWalletPendingInitSecretReference(paths.walletStateRoot).keyId));
});

test("initializeWallet succeeds even when a shared managed runtime already exists", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-init-claim-uninitialized-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = new CapturingPrompter();
  const harness = createRpcHarness();
  const uninitializedPaths = resolveManagedServicePaths(paths.bitcoinDataDir, "wallet-root-uninitialized");
  const oldBitcoind = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const oldIndexer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });

  try {
    oldBitcoind.unref();
    oldIndexer.unref();
    await mkdir(uninitializedPaths.walletRuntimeRoot, { recursive: true });
    await mkdir(uninitializedPaths.indexerServiceRoot, { recursive: true });

    const oldBitcoindStatus: ManagedBitcoindServiceStatus = {
      serviceApiVersion: MANAGED_BITCOIND_SERVICE_API_VERSION,
      binaryVersion: "0.0.0-test",
      buildId: null,
      serviceInstanceId: "bitcoind-uninitialized",
      state: "ready",
      processId: oldBitcoind.pid ?? null,
      walletRootId: "wallet-root-uninitialized",
      chain: "main",
      dataDir: paths.bitcoinDataDir,
      runtimeRoot: uninitializedPaths.walletRuntimeRoot,
      startHeight: 0,
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: join(paths.bitcoinDataDir, ".cookie"),
        port: 18_443,
      },
      zmq: {
        endpoint: "tcp://127.0.0.1:28332",
        topic: "hashblock",
        port: 28_332,
        pollIntervalMs: 15_000,
      },
      p2pPort: 18_444,
      getblockArchiveEndHeight: null,
      getblockArchiveSha256: null,
      walletReplica: null,
      startedAtUnixMs: 1_700_000_000_000,
      heartbeatAtUnixMs: 1_700_000_000_000,
      updatedAtUnixMs: 1_700_000_000_000,
      lastError: null,
    };

    await writeFile(uninitializedPaths.bitcoindStatusPath, JSON.stringify(oldBitcoindStatus), "utf8");
    await writeFile(uninitializedPaths.indexerDaemonStatusPath, JSON.stringify({
      processId: oldIndexer.pid ?? null,
    }), "utf8");

    const result = await initializeWallet({
      dataDir: paths.bitcoinDataDir,
      provider,
      paths,
      prompter,
      nowUnixMs: 1_700_000_000_000,
      attachService: async () => ({
        rpc: {
          url: "http://127.0.0.1:18443",
          cookieFile: "/tmp/does-not-matter",
          port: 18_443,
        },
      } as never),
      rpcFactory: harness.rpcFactory,
    });

    assert.ok(result.walletRootId.startsWith("wallet-"));
    assert.equal(isPidRunning(oldBitcoind.pid), true);
    assert.equal(isPidRunning(oldIndexer.pid), true);
    await access(uninitializedPaths.bitcoindStatusPath, constants.F_OK);
    await access(uninitializedPaths.indexerDaemonStatusPath, constants.F_OK);
    const loaded = await loadWalletState({
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    }, {
      provider,
    });
    assert.equal(loaded.state.walletRootId, result.walletRootId);
  } finally {
    if (isPidRunning(oldBitcoind.pid)) {
      oldBitcoind.kill("SIGKILL");
    }
    if (isPidRunning(oldIndexer.pid)) {
      oldIndexer.kill("SIGKILL");
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("initializeWallet works with the Linux default secret-provider testing seam", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-init-linux-secret-tool-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot: paths.stateRoot,
    linuxSecretToolRunner: createInMemoryLinuxSecretToolRunner(),
  });
  const prompter = new CapturingPrompter();
  const harness = createRpcHarness();

  const result = await initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });

  const unlocked = await loadUnlockedWalletState({
    provider,
    paths,
    nowUnixMs: 1_700_000_000_500,
  });

  assert.equal(result.walletRootId.startsWith("wallet-"), true);
  assert.equal(unlocked?.state.walletRootId, result.walletRootId);
  assert.equal(harness.walletLocked, true);
  assert.deepEqual(prompter.clearedScopes, ["mnemonic-reveal"]);
});

test("initializeWallet falls back to local Linux secret files when Secret Service is unavailable", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-init-linux-fallback-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
    stateRoot: paths.stateRoot,
    linuxSecretToolRunner: async () => ({
      stdout: "",
      stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY",
      exitCode: 1,
      signal: null,
    }),
  });
  const prompter = new CapturingPrompter();
  const harness = createRpcHarness();

  const result = await initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });

  await clearUnlockSession(paths.walletUnlockSessionPath);
  const unlocked = await unlockWallet({
    provider,
    paths,
    nowUnixMs: 1_700_000_000_500,
  });

  assert.equal(result.walletRootId.startsWith("wallet-"), true);
  assert.equal(unlocked.state.walletRootId, result.walletRootId);
  assert.equal(harness.walletLocked, true);
  assert.deepEqual(prompter.clearedScopes, ["mnemonic-reveal"]);
});

test("initializeWallet stores pending init state on confirmation failure without creating final wallet state", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-init-fail-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = new CapturingPrompter();
  const harness = createRpcHarness();
  prompter.mode = "wrong";

  await assert.rejects(() => initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  }));

  await assert.rejects(() => access(paths.walletStatePath, constants.F_OK));
  await assert.rejects(() => access(paths.walletUnlockSessionPath, constants.F_OK));
  await access(paths.walletInitPendingPath, constants.F_OK);
  await access(paths.walletInitPendingBackupPath, constants.F_OK);
  const pending = await loadWalletPendingInitializationState(
    createPendingInitializationStoragePaths(paths),
    {
      provider,
    },
  );
  assert.deepEqual(pending.state.mnemonic.phrase.split(" "), prompter.mnemonicWords);
  assert.equal(harness.importedDescriptors.length, 0);
  assert.deepEqual(prompter.clearedScopes, ["mnemonic-reveal"]);
});

test("initializeWallet reuses the same pending mnemonic across retries and clears it after success", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-init-retry-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const firstPrompter = new CapturingPrompter();
  const secondPrompter = new CapturingPrompter();
  const thirdPrompter = new CapturingPrompter();
  const harness = createRpcHarness();
  firstPrompter.mode = "wrong";
  secondPrompter.mode = "wrong";

  const attachService = async () => ({
    rpc: {
      url: "http://127.0.0.1:18443",
      cookieFile: "/tmp/does-not-matter",
      port: 18_443,
    },
  } as never);

  await assert.rejects(() => initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter: firstPrompter,
    nowUnixMs: 1_700_000_000_000,
    attachService,
    rpcFactory: harness.rpcFactory,
  }));
  await assert.rejects(() => initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter: secondPrompter,
    nowUnixMs: 1_700_000_100_000,
    attachService,
    rpcFactory: harness.rpcFactory,
  }));

  const result = await initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter: thirdPrompter,
    nowUnixMs: 1_700_000_200_000,
    attachService,
    rpcFactory: harness.rpcFactory,
  });

  assert.deepEqual(firstPrompter.mnemonicWords, secondPrompter.mnemonicWords);
  assert.deepEqual(secondPrompter.mnemonicWords, thirdPrompter.mnemonicWords);
  assert.equal(result.state.mnemonic.phrase, firstPrompter.mnemonicWords.join(" "));
  assert.equal(harness.importedDescriptors.length, 1);
  await assert.rejects(() => access(paths.walletInitPendingPath, constants.F_OK));
  await assert.rejects(() => access(paths.walletInitPendingBackupPath, constants.F_OK));
  await assert.rejects(() => provider.loadSecret(createWalletPendingInitSecretReference(paths.walletStateRoot).keyId));
});

test("initializeWallet falls back to the pending-init backup when the primary file is corrupt", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-init-pending-backup-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const firstPrompter = new CapturingPrompter();
  const secondPrompter = new CapturingPrompter();
  firstPrompter.mode = "wrong";
  secondPrompter.mode = "wrong";

  await assert.rejects(() => initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter: firstPrompter,
    attachService: async () => {
      throw new Error("should-not-run");
    },
  }));

  await writeFile(paths.walletInitPendingPath, "{corrupt\n", "utf8");

  await assert.rejects(() => initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter: secondPrompter,
    attachService: async () => {
      throw new Error("should-not-run");
    },
  }));

  assert.deepEqual(firstPrompter.mnemonicWords, secondPrompter.mnemonicWords);
});

test("initializeWallet regenerates the pending mnemonic when both pending-init copies are corrupt", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-init-pending-reset-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const firstPrompter = new CapturingPrompter();
  const secondPrompter = new CapturingPrompter();
  firstPrompter.mode = "wrong";
  secondPrompter.mode = "wrong";

  await assert.rejects(() => initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter: firstPrompter,
    attachService: async () => {
      throw new Error("should-not-run");
    },
  }));

  await writeFile(paths.walletInitPendingPath, "{corrupt\n", "utf8");
  await writeFile(paths.walletInitPendingBackupPath, "{corrupt\n", "utf8");

  await assert.rejects(() => initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter: secondPrompter,
    attachService: async () => {
      throw new Error("should-not-run");
    },
  }));

  assert.notDeepEqual(firstPrompter.mnemonicWords, secondPrompter.mnemonicWords);
});

test("initializeWallet ignores cleanup-hook errors after mnemonic confirmation", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-init-clear-fail-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = new CapturingPrompter();
  prompter.clearError = new Error("clear_failed");
  const harness = createRpcHarness();

  const result = await initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });

  assert.ok(result.walletRootId.startsWith("wallet-"));
  assert.deepEqual(prompter.clearedScopes, ["mnemonic-reveal"]);
});

test("initializeWallet rejects non-interactive prompters before revealing the mnemonic", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-init-noninteractive-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const calls: string[] = [];
  const prompter: WalletPrompter = {
    isInteractive: false,
    writeLine() {
      calls.push("writeLine");
    },
    async prompt() {
      calls.push("prompt");
      return "";
    },
    clearSensitiveDisplay() {
      calls.push("clearSensitiveDisplay");
    },
  };

  await assert.rejects(() => initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter,
  }), /wallet_init_requires_tty/);

  assert.deepEqual(calls, []);
});

test("showWalletMnemonic rejects non-interactive prompters before accessing wallet state", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-show-mnemonic-noninteractive-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const calls: string[] = [];
  const prompter: WalletPrompter = {
    isInteractive: false,
    writeLine() {
      calls.push("writeLine");
    },
    async prompt() {
      calls.push("prompt");
      return "";
    },
    clearSensitiveDisplay() {
      calls.push("clearSensitiveDisplay");
    },
  };

  await assert.rejects(() => showWalletMnemonic({
    provider,
    paths,
    prompter,
  }), /wallet_show_mnemonic_requires_tty/);

  assert.deepEqual(calls, []);
});

test("showWalletMnemonic requires initialized final wallet state and ignores pending-init-only state", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-show-mnemonic-uninitialized-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = new CapturingPrompter();

  await assert.rejects(() => showWalletMnemonic({
    provider,
    paths,
    prompter,
  }), /wallet_uninitialized/);

  await savePendingInitializationFixture({
    paths,
    provider,
    phrase: TEST_MNEMONIC,
  });

  await assert.rejects(() => showWalletMnemonic({
    provider,
    paths,
    prompter,
  }), /wallet_uninitialized/);
});

test("showWalletMnemonic auto-unlocks, reveals the stored phrase, and clears it after Enter", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-show-mnemonic-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const initPrompter = new CapturingPrompter();
  const revealPrompter = new CapturingPrompter();
  const harness = createRpcHarness();

  const initialized = await initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter: initPrompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });

  await clearUnlockSession(paths.walletUnlockSessionPath);
  revealPrompter.extraPrompts.push("show mnemonic", "");

  await showWalletMnemonic({
    provider,
    paths,
    prompter: revealPrompter,
    nowUnixMs: 1_700_000_100_000,
  });

  const unlocked = await loadUnlockedWalletState({
    provider,
    paths,
    nowUnixMs: 1_700_000_100_100,
  });
  const mnemonicWords = initialized.state.mnemonic.phrase.split(" ");
  const artRow1 = revealPrompter.lines.find((line) => line.includes(formatMnemonicArtSlot(1, mnemonicWords[0]!)));
  const artRow5 = revealPrompter.lines.find((line) => line.includes(formatMnemonicArtSlot(5, mnemonicWords[4]!)));

  assert.equal(unlocked?.state.walletRootId, initialized.walletRootId);
  assert.ok(artRow1);
  assert.ok(artRow5);
  assert.equal(revealPrompter.lines.includes("Cogcoin Wallet Recovery Phrase"), true);
  assert.equal(revealPrompter.lines.includes("This 24-word recovery phrase controls the wallet."), true);
  assert.ok(revealPrompter.lines.includes(initialized.state.mnemonic.phrase));
  assert.deepEqual(revealPrompter.prompts, [
    "Type \"show mnemonic\" to continue: ",
    "Press Enter to clear the recovery phrase from the screen: ",
  ]);
  assert.deepEqual(revealPrompter.clearedScopes, ["mnemonic-reveal"]);
});

test("showWalletMnemonic rejects the wrong typed acknowledgement without revealing the phrase", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-show-mnemonic-typed-ack-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const initPrompter = new CapturingPrompter();
  const revealPrompter = new CapturingPrompter();
  const harness = createRpcHarness();

  const initialized = await initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter: initPrompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });

  revealPrompter.extraPrompts.push("SHOW MNEMONIC");

  await assert.rejects(() => showWalletMnemonic({
    provider,
    paths,
    prompter: revealPrompter,
    nowUnixMs: 1_700_000_100_000,
  }), /wallet_show_mnemonic_typed_ack_required/);

  assert.equal(revealPrompter.lines.includes(initialized.state.mnemonic.phrase), false);
  assert.deepEqual(revealPrompter.clearedScopes, []);
});

test("showWalletMnemonic respects explicit wallet locks and ignores cleanup-hook errors after reveal", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-show-mnemonic-locked-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const initPrompter = new CapturingPrompter();
  const lockedPrompter = new CapturingPrompter();
  const revealPrompter = new CapturingPrompter();
  const harness = createRpcHarness();

  await initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter: initPrompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });

  await lockWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    nowUnixMs: 1_700_000_100_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });

  lockedPrompter.extraPrompts.push("show mnemonic");
  await assert.rejects(() => showWalletMnemonic({
    provider,
    paths,
    prompter: lockedPrompter,
    nowUnixMs: 1_700_000_100_100,
  }), /wallet_locked/);

  await unlockWallet({
    provider,
    paths,
    nowUnixMs: 1_700_000_100_200,
  });

  revealPrompter.extraPrompts.push("show mnemonic", "");
  revealPrompter.clearError = new Error("clear_failed");

  await showWalletMnemonic({
    provider,
    paths,
    prompter: revealPrompter,
    nowUnixMs: 1_700_000_100_300,
  });

  assert.deepEqual(revealPrompter.clearedScopes, ["mnemonic-reveal"]);
});

test("unlockWallet and lockWallet rotate the session blob, persist explicit lock state, and gate auto-unlock", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-lock-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = new CapturingPrompter();
  const harness = createRpcHarness();

  const initialized = await initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });

  const locked = await lockWallet({
    dataDir: paths.bitcoinDataDir,
    nowUnixMs: 1_700_000_005_000,
    provider,
    paths,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });
  const afterLock = await loadUnlockedWalletState({
    provider,
    paths,
    nowUnixMs: 1_700_000_000_100,
  });
  const blockedAutoUnlock = await loadOrAutoUnlockWalletState({
    provider,
    paths,
    nowUnixMs: 1_700_000_006_000,
  });
  const explicitLock = await loadWalletExplicitLock(paths.walletExplicitLockPath);

  const unlocked = await unlockWallet({
    provider,
    paths,
    nowUnixMs: 1_700_000_010_000,
  });
  const reopened = await loadOrAutoUnlockWalletState({
    provider,
    paths,
    nowUnixMs: 1_700_000_010_100,
  });

  assert.equal(locked.walletRootId, initialized.walletRootId);
  assert.equal(afterLock, null);
  assert.equal(blockedAutoUnlock, null);
  assert.deepEqual(explicitLock, {
    schemaVersion: 1,
    walletRootId: initialized.walletRootId,
    lockedAtUnixMs: 1_700_000_005_000,
  });
  assert.equal(unlocked.state.walletRootId, initialized.walletRootId);
  assert.equal(unlocked.unlockUntilUnixMs, 1_700_000_010_000 + (15 * 60 * 1000));
  assert.equal(reopened?.state.walletRootId, initialized.walletRootId);
  assert.equal(await loadWalletExplicitLock(paths.walletExplicitLockPath), null);
});

test("loadOrAutoUnlockWalletState reuses a valid session and auto-unlocks provider-backed state when the session is missing", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-auto-unlock-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = new CapturingPrompter();
  const harness = createRpcHarness();

  const initialized = await initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });

  const existingSession = await loadUnlockSession(paths.walletUnlockSessionPath, {
    provider,
  });
  const reused = await loadOrAutoUnlockWalletState({
    provider,
    paths,
    nowUnixMs: 1_700_000_000_100,
  });
  const sessionAfterReuse = await loadUnlockSession(paths.walletUnlockSessionPath, {
    provider,
  });

  await clearUnlockSession(paths.walletUnlockSessionPath);

  const autoUnlocked = await loadOrAutoUnlockWalletState({
    provider,
    paths,
    nowUnixMs: 1_700_000_020_000,
  });
  const recreatedSession = await loadUnlockSession(paths.walletUnlockSessionPath, {
    provider,
  });

  assert.equal(reused?.state.walletRootId, initialized.walletRootId);
  assert.equal(reused?.session.sessionId, existingSession.sessionId);
  assert.deepEqual(sessionAfterReuse, existingSession);
  assert.equal(await loadWalletExplicitLock(paths.walletExplicitLockPath), null);
  assert.equal(autoUnlocked?.state.walletRootId, initialized.walletRootId);
  assert.equal(autoUnlocked?.session.walletRootId, initialized.walletRootId);
  assert.equal(recreatedSession.walletRootId, initialized.walletRootId);
  assert.equal(recreatedSession.unlockUntilUnixMs, 1_700_000_020_000 + (15 * 60 * 1000));
  assert.equal(autoUnlocked?.session.unlockUntilUnixMs, recreatedSession.unlockUntilUnixMs);
  assert.notEqual(recreatedSession.sessionId, existingSession.sessionId);
});

test("loadUnlockedWalletState auto-repairs descriptor state during read flows", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-read-repair-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = new CapturingPrompter();
  const harness = createRpcHarness();

  const initialized = await initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });

  const secretReference = createWalletSecretReference(initialized.walletRootId);
  const corruptedState: WalletStateV1 = {
    ...initialized.state,
    descriptor: {
      ...initialized.state.descriptor,
      privateExternal: initialized.state.descriptor.publicExternal,
      checksum: mockDescriptorChecksum(initialized.state.descriptor.privateExternal),
    },
    managedCoreWallet: {
      ...initialized.state.managedCoreWallet,
      descriptorChecksum: mockDescriptorChecksum(initialized.state.descriptor.privateExternal),
    },
  };

  await saveWalletState(
    {
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    },
    corruptedState,
    {
      provider,
      secretReference,
    },
  );

  const repaired = await loadUnlockedWalletState({
    provider,
    paths,
    dataDir: paths.bitcoinDataDir,
    nowUnixMs: 1_700_000_000_100,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });
  const persisted = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(repaired?.state.stateRevision, initialized.state.stateRevision + 1);
  assert.equal(repaired?.session.sourceStateRevision, initialized.state.stateRevision + 1);
  assert.equal(repaired?.state.descriptor.privateExternal, initialized.state.descriptor.privateExternal);
  assert.equal(repaired?.state.descriptor.publicExternal, initialized.state.descriptor.publicExternal);
  assert.equal(repaired?.state.descriptor.checksum, initialized.state.descriptor.checksum);
  assert.equal(
    repaired?.state.managedCoreWallet.descriptorChecksum,
    initialized.state.managedCoreWallet.descriptorChecksum,
  );
  assert.equal(persisted.state.stateRevision, initialized.state.stateRevision + 1);
  assert.equal(persisted.state.descriptor.privateExternal, initialized.state.descriptor.privateExternal);
  assert.equal(persisted.state.descriptor.publicExternal, initialized.state.descriptor.publicExternal);
});

test("exportWallet writes a portable archive only when the wallet is unlocked and quiescent", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-export-"));
  const paths = createTempWalletPaths(tempRoot);
  const archivePath = join(tempRoot, "wallet.cogwallet");
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = new CapturingPrompter();
  const exportPrompter = new CapturingPrompter();
  exportPrompter.extraPrompts.push("archive-passphrase", "archive-passphrase");
  const harness = createRpcHarness();

  const initialized = await initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });

  const exported = await exportWallet({
    archivePath,
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    prompter: exportPrompter,
    nowUnixMs: 1_700_000_100_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
    readSnapshotTip: healthySnapshotTip,
  });

  const archive = await readPortableWalletArchive(archivePath, "archive-passphrase");
  const rawArchive = JSON.parse(await readFile(archivePath, "utf8")) as Record<string, unknown>;

  assert.equal(exported.walletRootId, initialized.walletRootId);
  assert.equal(archive.walletRootId, initialized.walletRootId);
  assert.equal(archive.expected.fundingAddress0, initialized.fundingAddress);
  assert.equal(archive.mnemonic.phrase, initialized.state.mnemonic.phrase);
  assert.equal(rawArchive.format, "cogcoin-portable-wallet-archive");
  assert.equal(rawArchive.wrappedBy, "passphrase");
  assert.equal("secretProvider" in rawArchive, true);
  assert.equal(rawArchive.secretProvider, null);
  assert.equal("wrappedSessionKeyMaterial" in archive, false);
});

test("importWallet restores portable state, recreates the managed Core replica, and unlocks the wallet", async () => {
  const exportRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-import-export-"));
  const importRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-import-target-"));
  const exportPaths = createTempWalletPaths(exportRoot);
  const importPaths = createTempWalletPaths(importRoot);
  const archivePath = join(importRoot, "wallet.cogwallet");
  const provider = createMemoryWalletSecretProviderForTesting();
  const exportPrompter = new CapturingPrompter();
  const archivePrompter = new CapturingPrompter();
  archivePrompter.extraPrompts.push("archive-passphrase", "archive-passphrase");
  const importPrompter = new CapturingPrompter();
  importPrompter.extraPrompts.push("archive-passphrase");
  const exportHarness = createRpcHarness();
  const importHarness = createRpcHarness();

  const initialized = await initializeWallet({
    dataDir: exportPaths.bitcoinDataDir,
    provider,
    paths: exportPaths,
    prompter: exportPrompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: exportHarness.rpcFactory,
  });

  await exportWallet({
    archivePath,
    dataDir: exportPaths.bitcoinDataDir,
    databasePath: join(exportRoot, "client.sqlite"),
    provider,
    paths: exportPaths,
    prompter: archivePrompter,
    nowUnixMs: 1_700_000_100_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: exportHarness.rpcFactory,
    readSnapshotTip: healthySnapshotTip,
  });

  const imported = await importWallet({
    archivePath,
    dataDir: importPaths.bitcoinDataDir,
    databasePath: join(importRoot, "client.sqlite"),
    provider,
    paths: importPaths,
    prompter: importPrompter,
    nowUnixMs: 1_700_000_200_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    attachIndexerDaemon: async () => createRepairIndexerDaemonStub({
      walletRootId: initialized.walletRootId,
      state: "synced",
      coreBestHeight: 123,
      snapshotHeight: 123,
    }) as never,
    rpcFactory: importHarness.rpcFactory,
  });

  const unlocked = await loadUnlockedWalletState({
    provider,
    paths: importPaths,
    nowUnixMs: 1_700_000_200_100,
  });

  assert.equal(imported.walletRootId, initialized.walletRootId);
  assert.equal(imported.fundingAddress, initialized.fundingAddress);
  assert.equal(imported.state.managedCoreWallet.proofStatus, "ready");
  assert.equal(unlocked?.state.walletRootId, initialized.walletRootId);
  assert.equal(importHarness.importedDescriptors.length, 1);
  assert.equal(importHarness.walletLocked, true);
});

test("importWallet clears pending init state without requiring replacement acknowledgement when no wallet exists", async () => {
  const exportRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-import-pending-export-"));
  const importRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-import-pending-target-"));
  const exportPaths = createTempWalletPaths(exportRoot);
  const importPaths = createTempWalletPaths(importRoot);
  const archivePath = join(importRoot, "wallet.cogwallet");
  const provider = createMemoryWalletSecretProviderForTesting();
  const exportPrompter = new CapturingPrompter();
  const archivePrompter = new CapturingPrompter();
  archivePrompter.extraPrompts.push("archive-passphrase", "archive-passphrase");
  const importPrompter = new CapturingPrompter();
  importPrompter.extraPrompts.push("archive-passphrase");
  const exportHarness = createRpcHarness();
  const importHarness = createRpcHarness();

  const initialized = await initializeWallet({
    dataDir: exportPaths.bitcoinDataDir,
    provider,
    paths: exportPaths,
    prompter: exportPrompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: exportHarness.rpcFactory,
  });

  await exportWallet({
    archivePath,
    dataDir: exportPaths.bitcoinDataDir,
    databasePath: join(exportRoot, "client.sqlite"),
    provider,
    paths: exportPaths,
    prompter: archivePrompter,
    nowUnixMs: 1_700_000_100_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: exportHarness.rpcFactory,
    readSnapshotTip: healthySnapshotTip,
  });

  await savePendingInitializationFixture({
    paths: importPaths,
    provider,
    phrase: TEST_MNEMONIC,
  });

  const imported = await importWallet({
    archivePath,
    dataDir: importPaths.bitcoinDataDir,
    databasePath: join(importRoot, "client.sqlite"),
    provider,
    paths: importPaths,
    prompter: importPrompter,
    nowUnixMs: 1_700_000_200_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    attachIndexerDaemon: async () => createRepairIndexerDaemonStub({
      walletRootId: initialized.walletRootId,
      state: "synced",
      coreBestHeight: 123,
      snapshotHeight: 123,
    }) as never,
    rpcFactory: importHarness.rpcFactory,
  });

  assert.equal(imported.walletRootId, initialized.walletRootId);
  await assert.rejects(() => access(importPaths.walletInitPendingPath, constants.F_OK));
  await assert.rejects(() => access(importPaths.walletInitPendingBackupPath, constants.F_OK));
  await assert.rejects(() => provider.loadSecret(createWalletPendingInitSecretReference(importPaths.walletStateRoot).keyId));
});

test("restoreWalletFromMnemonic creates a named imported seed without modifying main", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-restore-"));
  const mainPaths = createTempWalletPaths(tempRoot);
  const importedPaths = createTempWalletPaths(tempRoot, "trading");
  const provider = createMemoryWalletSecretProviderForTesting();
  const initPrompter = new CapturingPrompter();
  const restorePrompter = new CapturingPrompter();
  const initHarness = createRpcHarness();
  const restoreHarness = createRpcHarness();
  const expectedMaterial = deriveWalletMaterialFromMnemonic(TEST_MNEMONIC);
  const databasePath = join(tempRoot, "client.sqlite");

  const initialized = await initializeWallet({
    dataDir: mainPaths.bitcoinDataDir,
    provider,
    paths: mainPaths,
    prompter: initPrompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: initHarness.rpcFactory,
  });

  restorePrompter.promptReplies.push(...TEST_MNEMONIC.split(" "));

  const restored = await restoreWalletFromMnemonic({
    dataDir: importedPaths.bitcoinDataDir,
    provider,
    paths: importedPaths,
    prompter: restorePrompter,
    nowUnixMs: 1_700_000_010_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: restoreHarness.rpcFactory,
  });

  const loadedImported = await loadWalletState({
    primaryPath: importedPaths.walletStatePath,
    backupPath: importedPaths.walletStateBackupPath,
  }, {
    provider,
  });
  const loadedMain = await loadWalletState({
    primaryPath: mainPaths.walletStatePath,
    backupPath: mainPaths.walletStateBackupPath,
  }, {
    provider,
  });
  const unlockedImported = await loadUnlockedWalletState({
    provider,
    paths: importedPaths,
    nowUnixMs: 1_700_000_010_001,
  });
  const seedIndex = await loadWalletSeedIndex({
    paths: mainPaths,
    nowUnixMs: 1_700_000_010_000,
  });

  assert.equal(restored.seedName, "trading");
  assert.equal(restored.fundingAddress, expectedMaterial.funding.address);
  assert.equal(restored.state.walletRootId, loadedImported.state.walletRootId);
  assert.equal(loadedImported.state.mnemonic.phrase, TEST_MNEMONIC);
  assert.equal(loadedImported.state.walletBirthTime, 1_700_000_010);
  assert.equal(loadedImported.state.nextDedicatedIndex, 1);
  assert.equal(loadedImported.state.identities.length, 1);
  assert.deepEqual(loadedImported.state.domains, []);
  assert.equal(loadedImported.state.managedCoreWallet.proofStatus, "ready");
  assert.equal(loadedMain.state.walletRootId, initialized.walletRootId);
  await assert.rejects(() => access(databasePath, constants.F_OK));
  assert.equal(unlockedImported?.state.walletRootId, restored.walletRootId);
  assert.equal(restoreHarness.importedDescriptors.length, 1);
  assert.deepEqual(restored.warnings, []);
  assert.deepEqual(seedIndex.seeds.map((seed) => [seed.name, seed.kind]), [
    ["main", "main"],
    ["trading", "imported"],
  ]);
  assert.equal(seedIndex.seeds.find((seed) => seed.name === "trading")?.walletRootId, restored.walletRootId);
  assert.equal(restorePrompter.prompts[0], "Word 1 of 24: ");
  assert.equal(restorePrompter.prompts[23], "Word 24 of 24: ");
  assert.deepEqual(restorePrompter.clearedScopes, ["restore-mnemonic-entry"]);
});

test("restoreWalletFromMnemonic clears pending init state in the imported seed root", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-restore-pending-"));
  const mainPaths = createTempWalletPaths(tempRoot);
  const importedPaths = createTempWalletPaths(tempRoot, "trading");
  const provider = createMemoryWalletSecretProviderForTesting();
  const initPrompter = new CapturingPrompter();
  const restorePrompter = new CapturingPrompter();
  const initHarness = createRpcHarness();
  const restoreHarness = createRpcHarness();

  await initializeWallet({
    dataDir: mainPaths.bitcoinDataDir,
    provider,
    paths: mainPaths,
    prompter: initPrompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: initHarness.rpcFactory,
  });

  await savePendingInitializationFixture({
    paths: importedPaths,
    provider,
    phrase: TEST_MNEMONIC,
  });
  restorePrompter.promptReplies.push(...TEST_MNEMONIC.split(" "));

  const restored = await restoreWalletFromMnemonic({
    dataDir: importedPaths.bitcoinDataDir,
    provider,
    paths: importedPaths,
    prompter: restorePrompter,
    nowUnixMs: 1_700_000_010_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: restoreHarness.rpcFactory,
  });

  assert.equal(restored.seedName, "trading");
  assert.equal(restored.state.mnemonic.phrase, TEST_MNEMONIC);
  await assert.rejects(() => access(importedPaths.walletInitPendingPath, constants.F_OK));
  await assert.rejects(() => access(importedPaths.walletInitPendingBackupPath, constants.F_OK));
  await assert.rejects(() => provider.loadSecret(createWalletPendingInitSecretReference(importedPaths.walletStateRoot).keyId));
  assert.deepEqual(restorePrompter.clearedScopes, ["restore-mnemonic-entry"]);
});

test("restoreWalletFromMnemonic requires the main wallet before creating imported seeds", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-restore-main-required-"));
  const importedPaths = createTempWalletPaths(tempRoot, "trading");
  const prompter = new CapturingPrompter();

  await assert.rejects(() => restoreWalletFromMnemonic({
    dataDir: importedPaths.bitcoinDataDir,
    provider: createMemoryWalletSecretProviderForTesting(),
    paths: importedPaths,
    prompter,
  }), /wallet_restore_requires_main_wallet/);
  assert.deepEqual(prompter.prompts, []);
});

test("restoreWalletFromMnemonic rejects non-interactive execution before collecting mnemonic words", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-restore-noninteractive-"));
  const mainPaths = createTempWalletPaths(tempRoot);
  const importedPaths = createTempWalletPaths(tempRoot, "trading");
  const provider = createMemoryWalletSecretProviderForTesting();
  const initHarness = createRpcHarness();

  await initializeWallet({
    dataDir: mainPaths.bitcoinDataDir,
    provider,
    paths: mainPaths,
    prompter: new CapturingPrompter(),
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: initHarness.rpcFactory,
  });

  await assert.rejects(() => restoreWalletFromMnemonic({
    dataDir: importedPaths.bitcoinDataDir,
    provider,
    paths: importedPaths,
    prompter: {
      isInteractive: false,
      writeLine() {},
      async prompt() {
        return "";
      },
    },
  }), /wallet_restore_requires_tty/);
});

test("restoreWalletFromMnemonic rejects invalid mnemonic words and invalid checksum phrases", async () => {
  const invalidWordRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-restore-invalid-word-"));
  const invalidWordMainPaths = createTempWalletPaths(invalidWordRoot);
  const invalidWordPaths = createTempWalletPaths(invalidWordRoot, "trading");
  const invalidWordProvider = createMemoryWalletSecretProviderForTesting();
  const invalidWordHarness = createRpcHarness();
  const invalidWordPrompter = new CapturingPrompter();
  invalidWordPrompter.promptReplies.push("notaword");

  await initializeWallet({
    dataDir: invalidWordMainPaths.bitcoinDataDir,
    provider: invalidWordProvider,
    paths: invalidWordMainPaths,
    prompter: new CapturingPrompter(),
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: invalidWordHarness.rpcFactory,
  });

  await assert.rejects(() => restoreWalletFromMnemonic({
    dataDir: invalidWordPaths.bitcoinDataDir,
    provider: invalidWordProvider,
    paths: invalidWordPaths,
    prompter: invalidWordPrompter,
  }), /wallet_restore_mnemonic_invalid/);
  await assert.rejects(() => access(invalidWordPaths.walletStatePath, constants.F_OK));
  assert.deepEqual(invalidWordPrompter.clearedScopes, ["restore-mnemonic-entry"]);

  const invalidChecksumRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-restore-invalid-checksum-"));
  const invalidChecksumMainPaths = createTempWalletPaths(invalidChecksumRoot);
  const invalidChecksumPaths = createTempWalletPaths(invalidChecksumRoot, "trading");
  const invalidChecksumProvider = createMemoryWalletSecretProviderForTesting();
  const invalidChecksumHarness = createRpcHarness();
  const invalidChecksumPrompter = new CapturingPrompter();
  const invalidChecksumWords = TEST_MNEMONIC.split(" ");
  invalidChecksumWords[23] = "abandon";
  invalidChecksumPrompter.promptReplies.push(...invalidChecksumWords);

  await initializeWallet({
    dataDir: invalidChecksumMainPaths.bitcoinDataDir,
    provider: invalidChecksumProvider,
    paths: invalidChecksumMainPaths,
    prompter: new CapturingPrompter(),
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: invalidChecksumHarness.rpcFactory,
  });

  await assert.rejects(() => restoreWalletFromMnemonic({
    dataDir: invalidChecksumPaths.bitcoinDataDir,
    provider: invalidChecksumProvider,
    paths: invalidChecksumPaths,
    prompter: invalidChecksumPrompter,
  }), /wallet_restore_mnemonic_invalid/);
  await assert.rejects(() => access(invalidChecksumPaths.walletStatePath, constants.F_OK));
  assert.deepEqual(invalidChecksumPrompter.clearedScopes, ["restore-mnemonic-entry"]);
});

test("restoreWalletFromMnemonic refuses duplicate imported seed names and leaves the existing imported wallet untouched", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-restore-duplicate-seed-"));
  const mainPaths = createTempWalletPaths(tempRoot);
  const importedPaths = createTempWalletPaths(tempRoot, "trading");
  const provider = createMemoryWalletSecretProviderForTesting();
  const initHarness = createRpcHarness();
  const firstRestoreHarness = createRpcHarness();
  const secondRestorePrompter = new CapturingPrompter();

  await initializeWallet({
    dataDir: mainPaths.bitcoinDataDir,
    provider,
    paths: mainPaths,
    prompter: new CapturingPrompter(),
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: initHarness.rpcFactory,
  });

  const firstRestorePrompter = new CapturingPrompter();
  firstRestorePrompter.promptReplies.push(...TEST_MNEMONIC.split(" "));

  const firstRestore = await restoreWalletFromMnemonic({
    dataDir: importedPaths.bitcoinDataDir,
    provider,
    paths: importedPaths,
    prompter: firstRestorePrompter,
    nowUnixMs: 1_700_000_010_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: firstRestoreHarness.rpcFactory,
  });

  await assert.rejects(() => restoreWalletFromMnemonic({
    dataDir: importedPaths.bitcoinDataDir,
    provider,
    paths: importedPaths,
    prompter: secondRestorePrompter,
  }), /wallet_seed_name_exists/);

  const loadedImported = await loadWalletState({
    primaryPath: importedPaths.walletStatePath,
    backupPath: importedPaths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(loadedImported.state.walletRootId, firstRestore.walletRootId);
  assert.deepEqual(secondRestorePrompter.prompts, []);
});

test("deleteImportedWalletSeed removes imported seed artifacts, secrets, and registry entries", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-delete-seed-"));
  const mainPaths = createTempWalletPaths(tempRoot);
  const importedPaths = createTempWalletPaths(tempRoot, "trading");
  const provider = createMemoryWalletSecretProviderForTesting();
  const initHarness = createRpcHarness();
  const restoreHarness = createRpcHarness();

  await initializeWallet({
    dataDir: mainPaths.bitcoinDataDir,
    provider,
    paths: mainPaths,
    prompter: new CapturingPrompter(),
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: initHarness.rpcFactory,
  });

  const restorePrompter = new CapturingPrompter();
  restorePrompter.promptReplies.push(...TEST_MNEMONIC.split(" "));
  const restored = await restoreWalletFromMnemonic({
    dataDir: importedPaths.bitcoinDataDir,
    provider,
    paths: importedPaths,
    prompter: restorePrompter,
    nowUnixMs: 1_700_000_010_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: restoreHarness.rpcFactory,
  });
  const importedWalletDir = join(importedPaths.bitcoinDataDir, "wallets", restored.state.managedCoreWallet.walletName);
  await mkdir(importedPaths.walletRuntimeRoot, { recursive: true });
  await mkdir(importedWalletDir, { recursive: true });
  await writeFile(join(importedPaths.walletRuntimeRoot, "scratch.txt"), "temp", "utf8");

  const deletePrompter = new CapturingPrompter();
  deletePrompter.promptReplies.push("yes");
  const unloadedWallets: string[] = [];
  const deleted = await deleteImportedWalletSeed({
    dataDir: importedPaths.bitcoinDataDir,
    provider,
    paths: importedPaths,
    prompter: deletePrompter,
    nowUnixMs: 1_700_000_020_000,
    probeBitcoindService: async () => ({
      compatibility: "compatible",
      status: null,
      error: null,
    }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: () => ({
      async unloadWallet(walletName: string) {
        unloadedWallets.push(walletName);
        return null;
      },
    } as never),
  });

  const seedIndex = await loadWalletSeedIndex({
    paths: mainPaths,
    nowUnixMs: 1_700_000_020_000,
  });

  assert.equal(deleted.seedName, "trading");
  assert.equal(deleted.walletRootId, restored.walletRootId);
  assert.equal(deleted.deleted, true);
  assert.deepEqual(unloadedWallets, [restored.state.managedCoreWallet.walletName]);
  await assert.rejects(() => access(importedPaths.walletStateRoot, constants.F_OK));
  await assert.rejects(() => access(importedPaths.walletRuntimeRoot, constants.F_OK));
  await assert.rejects(() => access(importedWalletDir, constants.F_OK));
  await assert.rejects(() => provider.loadSecret(createWalletSecretReference(restored.walletRootId).keyId));
  assert.deepEqual(seedIndex.seeds.map((seed) => seed.name), ["main"]);
  assert.equal(deletePrompter.prompts[0], 'Delete imported seed "trading" and release its local wallet artifacts? Type yes to continue: ');
});

test("deleteImportedWalletSeed refuses deleting the main wallet", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-delete-main-"));
  const mainPaths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const harness = createRpcHarness();

  await initializeWallet({
    dataDir: mainPaths.bitcoinDataDir,
    provider,
    paths: mainPaths,
    prompter: new CapturingPrompter(),
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });

  await assert.rejects(() => deleteImportedWalletSeed({
    dataDir: mainPaths.bitcoinDataDir,
    provider,
    paths: mainPaths,
    prompter: new CapturingPrompter(),
  }), /wallet_delete_main_not_supported/);
});

test("deleteImportedWalletSeed refuses cleanup when a live managed bitcoind is incompatible", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-delete-seed-mismatch-"));
  const mainPaths = createTempWalletPaths(tempRoot);
  const importedPaths = createTempWalletPaths(tempRoot, "trading");
  const provider = createMemoryWalletSecretProviderForTesting();
  const initHarness = createRpcHarness();
  const restoreHarness = createRpcHarness();

  await initializeWallet({
    dataDir: mainPaths.bitcoinDataDir,
    provider,
    paths: mainPaths,
    prompter: new CapturingPrompter(),
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: initHarness.rpcFactory,
  });

  const restorePrompter = new CapturingPrompter();
  restorePrompter.promptReplies.push(...TEST_MNEMONIC.split(" "));
  const restored = await restoreWalletFromMnemonic({
    dataDir: importedPaths.bitcoinDataDir,
    provider,
    paths: importedPaths,
    prompter: restorePrompter,
    nowUnixMs: 1_700_000_010_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: restoreHarness.rpcFactory,
  });
  const importedWalletDir = join(importedPaths.bitcoinDataDir, "wallets", restored.state.managedCoreWallet.walletName);
  await mkdir(importedWalletDir, { recursive: true });

  const deletePrompter = new CapturingPrompter();
  deletePrompter.promptReplies.push("yes");
  await assert.rejects(() => deleteImportedWalletSeed({
    dataDir: importedPaths.bitcoinDataDir,
    provider,
    paths: importedPaths,
    prompter: deletePrompter,
    nowUnixMs: 1_700_000_020_000,
    probeBitcoindService: async () => ({
      compatibility: "service-version-mismatch",
      status: null,
      error: "managed_bitcoind_service_version_mismatch",
    }),
  }), /managed_bitcoind_service_version_mismatch/);

  await access(importedWalletDir, constants.F_OK);
  await access(importedPaths.walletStatePath, constants.F_OK);
});

test("repairWallet restores provider-backed state from backup and resets an unhealthy indexer database only with --yes", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-repair-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = new CapturingPrompter();
  const harness = createRpcHarness();
  const databasePath = join(tempRoot, "client.sqlite");

  const initialized = await initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });

  await writeFile(paths.walletStatePath, "corrupt\n", "utf8");
  await writeFile(databasePath, "corrupt\n", "utf8");

  await assert.rejects(() => repairWallet({
    dataDir: paths.bitcoinDataDir,
    databasePath,
    provider,
    paths,
    nowUnixMs: 1_700_000_300_000,
    requestMiningPreemption: async () => ({
      requestId: "repair-request",
      async release() {},
    }),
    probeIndexerDaemon: async () => ({
      compatibility: "unreachable",
      status: null,
      client: null,
      error: null,
    }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    attachIndexerDaemon: async () => createRepairIndexerDaemonStub({
      walletRootId: initialized.walletRootId,
      state: "catching-up",
      coreBestHeight: 123,
      snapshotHeight: 122,
    }) as never,
    rpcFactory: harness.rpcFactory,
  }), /wallet_repair_indexer_reset_requires_yes/);

  const repaired = await repairWallet({
    dataDir: paths.bitcoinDataDir,
    databasePath,
    provider,
    paths,
    nowUnixMs: 1_700_000_300_000,
    assumeYes: true,
    requestMiningPreemption: async () => ({
      requestId: "repair-request",
      async release() {},
    }),
    probeIndexerDaemon: async () => ({
      compatibility: "unreachable",
      status: null,
      client: null,
      error: null,
    }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    attachIndexerDaemon: async () => createRepairIndexerDaemonStub({
      walletRootId: initialized.walletRootId,
      state: "catching-up",
      coreBestHeight: 123,
      snapshotHeight: 122,
    }) as never,
    rpcFactory: harness.rpcFactory,
  });

  const loaded = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  await assert.rejects(() => access(databasePath, constants.F_OK));
  assert.equal(repaired.walletRootId, initialized.walletRootId);
  assert.equal(repaired.recoveredFromBackup, true);
  assert.equal(repaired.resetIndexerDatabase, true);
  assert.equal(repaired.indexerDaemonAction, "restarted-compatible-daemon");
  assert.equal(repaired.indexerCompatibilityIssue, "none");
  assert.equal(repaired.indexerPostRepairHealth, "catching-up");
  assert.equal(loaded.state.walletRootId, initialized.walletRootId);
});

test("repairWallet clears orphaned control locks before acquiring the repair lock", async () => {
  const fixture = await initializeRepairWalletFixture("cogcoin-wallet-repair-orphaned-control-");

  await writeFile(fixture.paths.walletControlLockPath, `${JSON.stringify({
    processId: null,
    acquiredAtUnixMs: 1_700_000_100_000,
    purpose: "orphaned-wallet-control",
    walletRootId: fixture.initialized.walletRootId,
  }, null, 2)}\n`, "utf8");
  await writeFile(fixture.paths.miningControlLockPath, "not-json\n", "utf8");

  const repaired = await repairWallet({
    dataDir: fixture.paths.bitcoinDataDir,
    databasePath: fixture.databasePath,
    provider: fixture.provider,
    paths: fixture.paths,
    nowUnixMs: 1_700_000_300_000,
    assumeYes: true,
    requestMiningPreemption: async () => ({
      requestId: "repair-request",
      async release() {},
    }),
    probeIndexerDaemon: async () => ({
      compatibility: "unreachable",
      status: null,
      client: null,
      error: null,
    }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    attachIndexerDaemon: async () => createRepairIndexerDaemonStub({
      walletRootId: fixture.initialized.walletRootId,
      state: "synced",
      coreBestHeight: 123,
      snapshotHeight: 123,
    }) as never,
    rpcFactory: fixture.harness.rpcFactory,
  });

  await assert.rejects(() => access(fixture.paths.walletControlLockPath, constants.F_OK));
  await assert.rejects(() => access(fixture.paths.miningControlLockPath, constants.F_OK));
  assert.equal(repaired.walletRootId, fixture.initialized.walletRootId);
  assert.equal(repaired.indexerPostRepairHealth, "synced");
});

test("repairWallet clears orphaned managed service locks for the current wallet root", async () => {
  const fixture = await initializeRepairWalletFixture("cogcoin-wallet-repair-orphaned-services-");
  const servicePaths = resolveManagedServicePaths(fixture.paths.bitcoinDataDir, fixture.initialized.walletRootId);

  await mkdir(servicePaths.walletRuntimeRoot, { recursive: true });
  await writeFile(servicePaths.bitcoindLockPath, `${JSON.stringify({
    processId: null,
    acquiredAtUnixMs: 1_700_000_100_000,
    purpose: "orphaned-bitcoind-lock",
    walletRootId: fixture.initialized.walletRootId,
  }, null, 2)}\n`, "utf8");
  await writeFile(servicePaths.indexerDaemonLockPath, "not-json\n", "utf8");

  const repaired = await repairWallet({
    dataDir: fixture.paths.bitcoinDataDir,
    databasePath: fixture.databasePath,
    provider: fixture.provider,
    paths: fixture.paths,
    nowUnixMs: 1_700_000_300_000,
    assumeYes: true,
    requestMiningPreemption: async () => ({
      requestId: "repair-request",
      async release() {},
    }),
    probeIndexerDaemon: async () => ({
      compatibility: "unreachable",
      status: null,
      client: null,
      error: null,
    }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    attachIndexerDaemon: async () => createRepairIndexerDaemonStub({
      walletRootId: fixture.initialized.walletRootId,
      state: "synced",
      coreBestHeight: 123,
      snapshotHeight: 123,
    }) as never,
    rpcFactory: fixture.harness.rpcFactory,
  });

  await assert.rejects(() => access(servicePaths.bitcoindLockPath, constants.F_OK));
  await assert.rejects(() => access(servicePaths.indexerDaemonLockPath, constants.F_OK));
  assert.equal(repaired.walletRootId, fixture.initialized.walletRootId);
  assert.equal(repaired.indexerPostRepairHealth, "synced");
});

test("repairWallet still respects a live wallet-control lock", async () => {
  const fixture = await initializeRepairWalletFixture("cogcoin-wallet-repair-live-lock-");
  const heldLock = await acquireFileLock(fixture.paths.walletControlLockPath, {
    purpose: "test-live-wallet-control-lock",
    walletRootId: fixture.initialized.walletRootId,
  });

  try {
    await assert.rejects(() => repairWallet({
      dataDir: fixture.paths.bitcoinDataDir,
      databasePath: fixture.databasePath,
      provider: fixture.provider,
      paths: fixture.paths,
      nowUnixMs: 1_700_000_300_000,
      assumeYes: true,
      requestMiningPreemption: async () => ({
        requestId: "repair-request",
        async release() {},
      }),
      probeIndexerDaemon: async () => ({
        compatibility: "unreachable",
        status: null,
        client: null,
        error: null,
      }),
      attachService: async () => ({
        rpc: {
          url: "http://127.0.0.1:18443",
          cookieFile: "/tmp/does-not-matter",
          port: 18_443,
        },
      } as never),
      attachIndexerDaemon: async () => createRepairIndexerDaemonStub({
        walletRootId: fixture.initialized.walletRootId,
        state: "synced",
        coreBestHeight: 123,
        snapshotHeight: 123,
      }) as never,
      rpcFactory: fixture.harness.rpcFactory,
    }), /file_lock_busy_.*wallet-control\.lock/);
  } finally {
    await heldLock.release();
  }
});

test("repairWallet normalizes descriptor state introduced by the old managed import path", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-repair-descriptor-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = new CapturingPrompter();
  const harness = createRpcHarness();
  const databasePath = join(tempRoot, "client.sqlite");

  const initialized = await initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });
  const secretReference = createWalletSecretReference(initialized.walletRootId);
  const corruptedState: WalletStateV1 = {
    ...initialized.state,
    descriptor: {
      ...initialized.state.descriptor,
      privateExternal: initialized.state.descriptor.publicExternal,
      checksum: mockDescriptorChecksum(initialized.state.descriptor.privateExternal),
    },
    managedCoreWallet: {
      ...initialized.state.managedCoreWallet,
      descriptorChecksum: mockDescriptorChecksum(initialized.state.descriptor.privateExternal),
    },
  };

  await saveWalletState(
    {
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    },
    corruptedState,
    {
      provider,
      secretReference,
    },
  );

  const repaired = await repairWallet({
    dataDir: paths.bitcoinDataDir,
    databasePath,
    provider,
    paths,
    nowUnixMs: 1_700_000_300_000,
    assumeYes: true,
    requestMiningPreemption: async () => ({
      requestId: "repair-request",
      async release() {},
    }),
    probeIndexerDaemon: async () => ({
      compatibility: "unreachable",
      status: null,
      client: null,
      error: null,
    }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    attachIndexerDaemon: async () => createRepairIndexerDaemonStub({
      walletRootId: initialized.walletRootId,
      state: "synced",
      coreBestHeight: 123,
      snapshotHeight: 123,
    }) as never,
    rpcFactory: harness.rpcFactory,
  });
  const loaded = await loadWalletState({
    primaryPath: paths.walletStatePath,
    backupPath: paths.walletStateBackupPath,
  }, {
    provider,
  });

  assert.equal(repaired.recreatedManagedCoreWallet, false);
  assert.equal(repaired.indexerPostRepairHealth, "synced");
  assert.equal(loaded.state.descriptor.privateExternal, initialized.state.descriptor.privateExternal);
  assert.equal(loaded.state.descriptor.publicExternal, initialized.state.descriptor.publicExternal);
  assert.equal(loaded.state.descriptor.checksum, initialized.state.descriptor.checksum);
  assert.equal(
    loaded.state.managedCoreWallet.descriptorChecksum,
    initialized.state.managedCoreWallet.descriptorChecksum,
  );
});

test("repairWallet stops an incompatible managed indexer daemon and clears stale artifacts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-repair-daemon-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = new CapturingPrompter();
  const harness = createRpcHarness();

  const initialized = await initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });

  const servicePaths = resolveManagedServicePaths(paths.bitcoinDataDir, initialized.walletRootId);
  await mkdir(servicePaths.indexerServiceRoot, { recursive: true });
  await writeFile(servicePaths.indexerDaemonStatusPath, "{\"stale\":true}\n", "utf8");
  await writeFile(servicePaths.indexerDaemonSocketPath, "", "utf8");

  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const childPid = child.pid;
  let probeCount = 0;

  try {
    const repaired = await repairWallet({
      dataDir: paths.bitcoinDataDir,
      databasePath: join(tempRoot, "client.sqlite"),
      provider,
      paths,
      nowUnixMs: 1_700_000_400_000,
      requestMiningPreemption: async () => ({
        requestId: "repair-request",
        async release() {},
      }),
      probeIndexerDaemon: async () => {
        probeCount += 1;
        if (probeCount === 1) {
          return {
            compatibility: "service-version-mismatch",
            status: {
              serviceApiVersion: "cogcoin/indexer-ipc/v999",
              binaryVersion: "0.0.0-test",
              buildId: null,
              updatedAtUnixMs: 1_700_000_000_000,
              walletRootId: initialized.walletRootId,
              daemonInstanceId: "daemon-conflict",
              schemaVersion: INDEXER_DAEMON_SCHEMA_VERSION,
              state: "synced",
              processId: childPid ?? null,
              startedAtUnixMs: 1_700_000_000_000,
              heartbeatAtUnixMs: 1_700_000_000_000,
              ipcReady: true,
              rpcReachable: true,
              coreBestHeight: 123,
              coreBestHash: "aa".repeat(32),
              appliedTipHeight: 123,
              appliedTipHash: "bb".repeat(32),
              snapshotSeq: "1",
              backlogBlocks: 0,
              reorgDepth: null,
              lastAppliedAtUnixMs: 1_700_000_000_000,
              activeSnapshotCount: 0,
              lastError: null,
            },
            client: null,
            error: "indexer_daemon_service_version_mismatch",
          };
        }

        return {
          compatibility: "unreachable",
          status: null,
          client: null,
          error: null,
        };
      },
      attachService: async () => ({
        rpc: {
          url: "http://127.0.0.1:18443",
          cookieFile: "/tmp/does-not-matter",
          port: 18_443,
        },
      } as never),
      attachIndexerDaemon: async () => createRepairIndexerDaemonStub({
        walletRootId: initialized.walletRootId,
        state: "synced",
        coreBestHeight: 123,
        snapshotHeight: 123,
      }) as never,
      rpcFactory: harness.rpcFactory,
    });

    assert.equal(repaired.indexerDaemonAction, "stopped-incompatible-daemon");
    assert.equal(repaired.indexerCompatibilityIssue, "service-version-mismatch");
    assert.equal(repaired.indexerPostRepairHealth, "synced");
    await assert.rejects(() => access(servicePaths.indexerDaemonStatusPath, constants.F_OK));
    await assert.rejects(() => access(servicePaths.indexerDaemonSocketPath, constants.F_OK));
  } finally {
    if (childPid !== undefined) {
      child.kill("SIGTERM");
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
  }
});

test("repairWallet resumes background mining after a clean repair when the remaining unlock session is still valid", async () => {
  const fixture = await initializeRepairWalletFixture("cogcoin-wallet-repair-resume-");
  const {
    paths,
    provider,
    harness,
    initialized,
    databasePath,
  } = fixture;
  const repairNowUnixMs = 1_700_000_300_000;
  const backgroundWorker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  let startCallCount = 0;

  await configureBuiltInMiningProvider({
    paths,
    provider,
    walletRootId: initialized.walletRootId,
    nowUnixMs: repairNowUnixMs,
  });
  await saveMiningRuntimeStatus(paths.miningStatusPath, createMiningRuntimeSnapshot(
    initialized.walletRootId,
    {
      updatedAtUnixMs: repairNowUnixMs - 1_000,
      runMode: "background",
      backgroundWorkerPid: backgroundWorker.pid ?? null,
      backgroundWorkerRunId: "worker-repair-before",
      backgroundWorkerHeartbeatAtUnixMs: repairNowUnixMs - 500,
      backgroundWorkerHealth: "healthy",
      currentPhase: "waiting",
      note: "Background mining active before repair.",
    },
  ));

  try {
    const repaired = await repairWallet({
      dataDir: paths.bitcoinDataDir,
      databasePath,
      provider,
      paths,
      nowUnixMs: repairNowUnixMs,
      requestMiningPreemption: async () => ({
        requestId: "repair-request",
        async release() {},
      }),
      probeBitcoindService: async () => ({
        compatibility: "unreachable",
        status: null,
        error: null,
      }),
      attachService: async () => ({
        rpc: {
          url: "http://127.0.0.1:18443",
          cookieFile: "/tmp/does-not-matter",
          port: 18_443,
        },
        async refreshServiceStatus() {
          return { state: "ready" } as never;
        },
      } as never),
      probeIndexerDaemon: async () => ({
        compatibility: "unreachable",
        status: null,
        client: null,
        error: null,
      }),
      attachIndexerDaemon: async () => createRepairIndexerDaemonStub({
        walletRootId: initialized.walletRootId,
        state: "synced",
        coreBestHeight: 123,
        snapshotHeight: 123,
      }) as never,
      rpcFactory: harness.rpcFactory,
      startBackgroundMining: async (startOptions) => {
        startCallCount += 1;
        assert.equal(startOptions.prompter.isInteractive, false);
        return {
          started: true,
          snapshot: createMiningRuntimeSnapshot(initialized.walletRootId, {
            updatedAtUnixMs: repairNowUnixMs,
            runMode: "background",
            backgroundWorkerPid: 9_876,
            backgroundWorkerRunId: "worker-repair-after",
            backgroundWorkerHeartbeatAtUnixMs: repairNowUnixMs,
            backgroundWorkerHealth: "healthy",
            currentPhase: "waiting",
            note: "Background mining resumed after repair.",
          }),
        };
      },
    });

    const unlocked = await loadUnlockedWalletState({
      provider,
      paths,
      nowUnixMs: repairNowUnixMs + 1,
    });

    assert.equal(repaired.miningPreRepairRunMode, "background");
    assert.equal(repaired.miningResumeAction, "resumed-background");
    assert.equal(repaired.miningPostRepairRunMode, "background");
    assert.equal(repaired.miningResumeError, null);
    assert.equal(startCallCount, 1);
    assert.equal(unlocked?.state.walletRootId, initialized.walletRootId);
  } finally {
    if (backgroundWorker.pid !== undefined) {
      backgroundWorker.kill("SIGKILL");
      if (backgroundWorker.exitCode === null && backgroundWorker.signalCode === null) {
        await new Promise((resolve) => backgroundWorker.once("exit", resolve));
      }
    }
  }
});

test("repairWallet skips background mining resume when post-repair launch gates remain blocked", async () => {
  const fixture = await initializeRepairWalletFixture("cogcoin-wallet-repair-blocked-");
  const {
    paths,
    provider,
    harness,
    initialized,
    databasePath,
  } = fixture;
  const repairNowUnixMs = 1_700_000_300_000;
  const backgroundWorker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  let startCallCount = 0;

  await saveMiningRuntimeStatus(paths.miningStatusPath, createMiningRuntimeSnapshot(
    initialized.walletRootId,
    {
      updatedAtUnixMs: repairNowUnixMs - 1_000,
      runMode: "background",
      backgroundWorkerPid: backgroundWorker.pid ?? null,
      backgroundWorkerRunId: "worker-repair-before",
      backgroundWorkerHeartbeatAtUnixMs: repairNowUnixMs - 500,
      backgroundWorkerHealth: "healthy",
      currentPhase: "waiting",
    },
  ));

  try {
    const repaired = await repairWallet({
      dataDir: paths.bitcoinDataDir,
      databasePath,
      provider,
      paths,
      nowUnixMs: repairNowUnixMs,
      requestMiningPreemption: async () => ({
        requestId: "repair-request",
        async release() {},
      }),
      probeBitcoindService: async () => ({
        compatibility: "unreachable",
        status: null,
        error: null,
      }),
      attachService: async () => ({
        rpc: {
          url: "http://127.0.0.1:18443",
          cookieFile: "/tmp/does-not-matter",
          port: 18_443,
        },
        async refreshServiceStatus() {
          return { state: "ready" } as never;
        },
      } as never),
      probeIndexerDaemon: async () => ({
        compatibility: "unreachable",
        status: null,
        client: null,
        error: null,
      }),
      attachIndexerDaemon: async () => createRepairIndexerDaemonStub({
        walletRootId: initialized.walletRootId,
        state: "synced",
        coreBestHeight: 123,
        snapshotHeight: 123,
      }) as never,
      rpcFactory: harness.rpcFactory,
      startBackgroundMining: async () => {
        startCallCount += 1;
        throw new Error("startBackgroundMining should not run when resume is blocked");
      },
    });

    const unlocked = await loadUnlockedWalletState({
      provider,
      paths,
      nowUnixMs: repairNowUnixMs + 1,
    });

    assert.equal(repaired.miningPreRepairRunMode, "background");
    assert.equal(repaired.miningResumeAction, "skipped-post-repair-blocked");
    assert.equal(repaired.miningPostRepairRunMode, "stopped");
    assert.equal(repaired.miningResumeError, null);
    assert.equal(startCallCount, 0);
    assert.equal(unlocked, null);
  } finally {
    if (backgroundWorker.pid !== undefined) {
      backgroundWorker.kill("SIGKILL");
      if (backgroundWorker.exitCode === null && backgroundWorker.signalCode === null) {
        await new Promise((resolve) => backgroundWorker.once("exit", resolve));
      }
    }
  }
});

test("repairWallet does not auto-resume foreground mining", async () => {
  const fixture = await initializeRepairWalletFixture("cogcoin-wallet-repair-foreground-");
  const {
    paths,
    provider,
    harness,
    initialized,
    databasePath,
  } = fixture;
  const repairNowUnixMs = 1_700_000_300_000;
  let startCallCount = 0;

  await configureBuiltInMiningProvider({
    paths,
    provider,
    walletRootId: initialized.walletRootId,
    nowUnixMs: repairNowUnixMs,
  });
  await saveMiningRuntimeStatus(paths.miningStatusPath, createMiningRuntimeSnapshot(
    initialized.walletRootId,
    {
      updatedAtUnixMs: repairNowUnixMs - 1_000,
      runMode: "foreground",
      currentPhase: "generating",
      note: "Foreground mining active before repair.",
    },
  ));

  const repaired = await repairWallet({
    dataDir: paths.bitcoinDataDir,
    databasePath,
    provider,
    paths,
    nowUnixMs: repairNowUnixMs,
    requestMiningPreemption: async () => ({
      requestId: "repair-request",
      async release() {},
    }),
    probeBitcoindService: async () => ({
      compatibility: "unreachable",
      status: null,
      error: null,
    }),
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
      async refreshServiceStatus() {
        return { state: "ready" } as never;
      },
    } as never),
    probeIndexerDaemon: async () => ({
      compatibility: "unreachable",
      status: null,
      client: null,
      error: null,
    }),
    attachIndexerDaemon: async () => createRepairIndexerDaemonStub({
      walletRootId: initialized.walletRootId,
      state: "synced",
      coreBestHeight: 123,
      snapshotHeight: 123,
    }) as never,
    rpcFactory: harness.rpcFactory,
    startBackgroundMining: async () => {
      startCallCount += 1;
      throw new Error("startBackgroundMining should not run for foreground mining");
    },
  });

  const unlocked = await loadUnlockedWalletState({
    provider,
    paths,
    nowUnixMs: repairNowUnixMs + 1,
  });

  assert.equal(repaired.miningPreRepairRunMode, "foreground");
  assert.equal(repaired.miningResumeAction, "none");
  assert.equal(repaired.miningPostRepairRunMode, "stopped");
  assert.equal(repaired.miningResumeError, null);
  assert.equal(startCallCount, 0);
  assert.equal(unlocked, null);
});

test("repairWallet reports resume failure but preserves the recreated unlock session for a manual retry", async () => {
  const fixture = await initializeRepairWalletFixture("cogcoin-wallet-repair-resume-fail-");
  const {
    paths,
    provider,
    harness,
    initialized,
    databasePath,
  } = fixture;
  const repairNowUnixMs = 1_700_000_300_000;
  const backgroundWorker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  let startCallCount = 0;

  await configureBuiltInMiningProvider({
    paths,
    provider,
    walletRootId: initialized.walletRootId,
    nowUnixMs: repairNowUnixMs,
  });
  await saveMiningRuntimeStatus(paths.miningStatusPath, createMiningRuntimeSnapshot(
    initialized.walletRootId,
    {
      updatedAtUnixMs: repairNowUnixMs - 1_000,
      runMode: "background",
      backgroundWorkerPid: backgroundWorker.pid ?? null,
      backgroundWorkerRunId: "worker-repair-before",
      backgroundWorkerHeartbeatAtUnixMs: repairNowUnixMs - 500,
      backgroundWorkerHealth: "healthy",
      currentPhase: "waiting",
    },
  ));

  try {
    const repaired = await repairWallet({
      dataDir: paths.bitcoinDataDir,
      databasePath,
      provider,
      paths,
      nowUnixMs: repairNowUnixMs,
      requestMiningPreemption: async () => ({
        requestId: "repair-request",
        async release() {},
      }),
      probeBitcoindService: async () => ({
        compatibility: "unreachable",
        status: null,
        error: null,
      }),
      attachService: async () => ({
        rpc: {
          url: "http://127.0.0.1:18443",
          cookieFile: "/tmp/does-not-matter",
          port: 18_443,
        },
        async refreshServiceStatus() {
          return { state: "ready" } as never;
        },
      } as never),
      probeIndexerDaemon: async () => ({
        compatibility: "unreachable",
        status: null,
        client: null,
        error: null,
      }),
      attachIndexerDaemon: async () => createRepairIndexerDaemonStub({
        walletRootId: initialized.walletRootId,
        state: "synced",
        coreBestHeight: 123,
        snapshotHeight: 123,
      }) as never,
      rpcFactory: harness.rpcFactory,
      startBackgroundMining: async (startOptions) => {
        startCallCount += 1;
        assert.equal(startOptions.prompter.isInteractive, false);
        throw new Error("built_in_provider_launch_failed");
      },
    });

    const unlocked = await loadUnlockedWalletState({
      provider,
      paths,
      nowUnixMs: repairNowUnixMs + 1,
    });

    assert.equal(repaired.miningPreRepairRunMode, "background");
    assert.equal(repaired.miningResumeAction, "resume-failed");
    assert.equal(repaired.miningPostRepairRunMode, "stopped");
    assert.equal(repaired.miningResumeError, "built_in_provider_launch_failed");
    assert.equal(startCallCount, 1);
    assert.equal(unlocked?.state.walletRootId, initialized.walletRootId);
  } finally {
    if (backgroundWorker.pid !== undefined) {
      backgroundWorker.kill("SIGKILL");
      if (backgroundWorker.exitCode === null && backgroundWorker.signalCode === null) {
        await new Promise((resolve) => backgroundWorker.once("exit", resolve));
      }
    }
  }
});

test("repairWallet fails before touching runtime artifacts when mining preemption cannot be obtained", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-repair-preempt-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = new CapturingPrompter();
  const harness = createRpcHarness();

  const initialized = await initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter,
    nowUnixMs: 1_700_000_000_000,
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  });

  const servicePaths = resolveManagedServicePaths(paths.bitcoinDataDir, initialized.walletRootId);
  await mkdir(servicePaths.indexerServiceRoot, { recursive: true });
  await writeFile(servicePaths.indexerDaemonStatusPath, "{\"stale\":true}\n", "utf8");

  await assert.rejects(() => repairWallet({
    dataDir: paths.bitcoinDataDir,
    databasePath: join(tempRoot, "client.sqlite"),
    provider,
    paths,
    nowUnixMs: 1_700_000_500_000,
    requestMiningPreemption: async () => {
      throw new Error("mining_preemption_timeout");
    },
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: harness.rpcFactory,
  }), /mining_preemption_timeout/);

  await access(servicePaths.indexerDaemonStatusPath, constants.F_OK);
});

test("verifyManagedCoreWalletReplica surfaces descriptor mismatches cleanly", async () => {
  const state = {
    ...(await (async (): Promise<WalletStateV1> => {
      const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-verify-"));
      const paths = createTempWalletPaths(tempRoot);
      const provider = createMemoryWalletSecretProviderForTesting();
      const prompter = new CapturingPrompter();
      const harness = createRpcHarness();
      const initialized = await initializeWallet({
        dataDir: paths.bitcoinDataDir,
        provider,
        paths,
        prompter,
        nowUnixMs: 1_700_000_000_000,
        attachService: async () => ({
          rpc: {
            url: "http://127.0.0.1:18443",
            cookieFile: "/tmp/does-not-matter",
            port: 18_443,
          },
        } as never),
        rpcFactory: harness.rpcFactory,
      });
      return initialized.state;
    })()),
  };

  const mismatch = await verifyManagedCoreWalletReplica(state, "/tmp/bitcoin", {
    attachService: async () => ({
      rpc: {
        url: "http://127.0.0.1:18443",
        cookieFile: "/tmp/does-not-matter",
        port: 18_443,
      },
    } as never),
    rpcFactory: () => ({
      async getWalletInfo(walletName: string) {
        return {
          walletname: walletName,
          private_keys_enabled: true,
          descriptors: true,
        };
      },
      async listDescriptors() {
        return {
          descriptors: [{ desc: `${stripDescriptorChecksum(state.descriptor.publicExternal)}#wrong` }],
        };
      },
      async deriveAddresses() {
        return ["bc1qwrong0000000000000000000000000000000000"];
      },
    } as never),
  });

  assert.equal(mismatch.proofStatus, "missing");
  assert.match(mismatch.message ?? "", /missing/i);
});
