import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, constants, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bech32 } from "@scure/base";
import { HDKey } from "@scure/bip32";

import { readPortableWalletArchive } from "../src/wallet/archive.js";
import {
  exportWallet,
  importWallet,
  initializeWallet,
  loadUnlockedWalletState,
  lockWallet,
  parseUnlockDurationToMs,
  repairWallet,
  unlockWallet,
  verifyManagedCoreWalletReplica,
  type WalletPrompter,
} from "../src/wallet/lifecycle.js";
import { saveBuiltInMiningProviderConfig } from "../src/wallet/mining/config.js";
import { saveMiningRuntimeStatus } from "../src/wallet/mining/runtime-artifacts.js";
import type { MiningRuntimeStatusV1 } from "../src/wallet/mining/types.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createDefaultWalletSecretProviderForTesting,
  createMemoryWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { loadWalletState } from "../src/wallet/state/storage.js";
import type { WalletStateV1 } from "../src/wallet/types.js";
import {
  INDEXER_DAEMON_SCHEMA_VERSION,
  INDEXER_DAEMON_SERVICE_API_VERSION,
} from "../src/bitcoind/types.js";
import { resolveManagedServicePaths } from "../src/bitcoind/service-paths.js";

function hash160(value: Uint8Array): Uint8Array {
  const sha256 = createHash("sha256").update(value).digest();
  return createHash("ripemd160").update(sha256).digest();
}

function deriveAddressFromDescriptor(descriptor: string): string {
  const match = descriptor.match(/]([A-Za-z0-9]+)\/0\/\*/);

  if (match == null) {
    throw new Error(`cannot_parse_descriptor_${descriptor}`);
  }

  const node = HDKey.fromExtendedKey(match[1]!).derive("m/0/0");

  if (node.publicKey == null) {
    throw new Error("descriptor_missing_public_key");
  }

  return bech32.encode("bc", [0, ...bech32.toWords(hash160(node.publicKey))]);
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

class CapturingPrompter implements WalletPrompter {
  readonly isInteractive = true;
  readonly lines: string[] = [];
  readonly clearedScopes: Array<"mnemonic-reveal"> = [];
  mnemonicWords: string[] = [];
  mode: "correct" | "wrong" = "correct";
  extraPrompts: string[] = [];
  clearError: Error | null = null;

  writeLine(message: string): void {
    this.lines.push(message);
    const words = message.trim().split(/\s+/);

    if (words.length === 24) {
      this.mnemonicWords = words;
    }
  }

  async prompt(message: string): Promise<string> {
    if (!message.includes("Confirm word #")) {
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

  clearSensitiveDisplay(scope: "mnemonic-reveal"): void {
    this.clearedScopes.push(scope);

    if (this.clearError !== null) {
      throw this.clearError;
    }
  }
}

function createRpcHarness() {
  const importedDescriptors: string[] = [];
  const wallets = new Set<string>();
  let walletLocked = false;

  return {
    rpcFactory() {
      return {
        async getDescriptorInfo(descriptor: string) {
          const checksum = descriptor.includes("xprv") ? "privsum" : "pubsum";
          return {
            descriptor: `${descriptor}#${checksum}`,
            checksum,
            isrange: true,
            issolvable: true,
            hasprivatekeys: descriptor.includes("xprv"),
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
          return requests.map(() => ({ success: true }));
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
            descriptors: importedDescriptors.map((desc) => ({ desc })),
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
  assert.equal(result.state.funding.address, result.fundingAddress);
  assert.equal(unlocked?.state.walletRootId, result.walletRootId);
  assert.equal(unlocked?.session.sourceStateRevision, 2);
  assert.equal(harness.importedDescriptors.length, 1);
  assert.equal(harness.walletLocked, true);
  assert.deepEqual(prompter.clearedScopes, ["mnemonic-reveal"]);
});

test("initializeWallet works with the Linux default secret-provider testing seam", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-init-linux-secret-tool-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createDefaultWalletSecretProviderForTesting({
    platform: "linux",
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

test("initializeWallet aborts on confirmation failure without leaving state behind", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-init-fail-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const prompter = new CapturingPrompter();
  prompter.mode = "wrong";

  await assert.rejects(() => initializeWallet({
    dataDir: paths.bitcoinDataDir,
    provider,
    paths,
    prompter,
    attachService: async () => {
      throw new Error("should-not-run");
    },
  }));

  await assert.rejects(() => access(paths.walletStatePath, constants.F_OK));
  assert.deepEqual(prompter.clearedScopes, ["mnemonic-reveal"]);
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

test("unlockWallet and lockWallet rotate the session blob and preserve locked truth", async () => {
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

  const unlocked = await unlockWallet({
    provider,
    paths,
    nowUnixMs: 1_700_000_010_000,
  });

  assert.equal(locked.walletRootId, initialized.walletRootId);
  assert.equal(afterLock, null);
  assert.equal(unlocked.state.walletRootId, initialized.walletRootId);
  assert.equal(unlocked.unlockUntilUnixMs, 1_700_000_010_000 + (15 * 60 * 1000));
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
          descriptors: [{ desc: `${state.descriptor.privateExternal}#wrong` }],
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
