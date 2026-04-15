import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { openClient } from "../src/client.js";
import {
  formatStatusReport,
  parseCliArgs,
  runCli,
} from "../src/cli-runner.js";
import { formatWalletOverviewReport } from "../src/cli/wallet-format.js";
import { createTerminalPrompter } from "../src/cli/prompt.js";
import { describeCanonicalCommand, formatCliTextError } from "../src/cli/output.js";
import { getLocksNextSteps } from "../src/cli/workflow-hints.js";
import {
  resolveCogcoinPathsForTesting,
  resolveCogcoinAppRootForTesting,
  resolveDefaultClientDatabasePathForTesting,
} from "../src/app-paths.js";
import {
  MANAGED_BITCOIND_SERVICE_API_VERSION,
  INDEXER_DAEMON_SCHEMA_VERSION,
  INDEXER_DAEMON_SERVICE_API_VERSION,
  type ManagedBitcoindServiceStatus,
} from "../src/bitcoind/types.js";
import { inspectPassiveClientStatus } from "../src/passive-status.js";
import { openSqliteStore } from "../src/sqlite/index.js";
import { acquireFileLock } from "../src/wallet/fs/lock.js";
import type { MiningControlPlaneView } from "../src/wallet/mining/index.js";
import { createWalletReadModel } from "../src/wallet/read/index.js";
import type { WalletReadContext } from "../src/wallet/read/index.js";
import type { WalletLockView } from "../src/wallet/read/index.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import type { WalletStateV1 } from "../src/wallet/types.js";
import { createTempDatabasePath, loadHistoryVector, materializeBlock } from "./helpers.js";
import { createTempDirectory, removeTempDirectory, replayBlocks } from "./bitcoind-helpers.js";

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

class FakeSignalSource extends EventEmitter {
  override on(event: "SIGINT" | "SIGTERM", listener: () => void): this {
    return super.on(event, listener);
  }

  override off(event: "SIGINT" | "SIGTERM", listener: () => void): this {
    return super.off(event, listener);
  }
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

function createWalletStateEnvelopeStub(walletRootId: string) {
  return {
    source: "primary" as const,
    envelope: {
      format: "cogcoin-local-wallet-state",
      version: 1 as const,
      wrappedBy: "secret-provider",
      cipher: "aes-256-gcm" as const,
      walletRootIdHint: walletRootId,
      nonce: "nonce",
      tag: "tag",
      ciphertext: "ciphertext",
    },
  };
}

async function waitForMissingPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    try {
      await stat(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }

      throw error;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  throw new Error(`timed_out_waiting_for_missing_path:${path}`);
}

function createInteractivePrompter() {
  return {
    isInteractive: true,
    writeLine() {},
    async prompt() {
      return "";
    },
    async promptHidden() {
      return "";
    },
  };
}

function parseJsonEnvelope(stream: MemoryStream): unknown {
  return JSON.parse(stream.toString());
}

function createNoopStore() {
  return {
    async loadTip() {
      return null;
    },
    async loadLatestSnapshot() {
      return null;
    },
    async loadBlockRecordsAfter() {
      return [];
    },
    async writeAppliedBlock() {},
    async deleteBlockRecordsAbove() {},
    async loadBlockRecord() {
      return null;
    },
    async close() {},
  };
}

function createIndexerDaemonStatus(walletRootId: string, overrides: Partial<{
  daemonInstanceId: string;
  state: "starting" | "catching-up" | "reorging" | "synced" | "stopping" | "failed" | "schema-mismatch" | "service-version-mismatch";
  heartbeatAtUnixMs: number;
  updatedAtUnixMs: number;
  rpcReachable: boolean;
  coreBestHeight: number | null;
  coreBestHash: string | null;
  appliedTipHeight: number | null;
  appliedTipHash: string | null;
  snapshotSeq: string | null;
  backlogBlocks: number | null;
  reorgDepth: number | null;
  lastAppliedAtUnixMs: number | null;
  activeSnapshotCount: number;
  lastError: string | null;
}> = {}): NonNullable<WalletReadContext["indexer"]["status"]> {
  return {
    serviceApiVersion: INDEXER_DAEMON_SERVICE_API_VERSION,
    binaryVersion: "0.0.0-test",
    buildId: null,
    updatedAtUnixMs: overrides.updatedAtUnixMs ?? 1_700_000_000_000,
    walletRootId,
    daemonInstanceId: overrides.daemonInstanceId ?? "daemon-1",
    schemaVersion: INDEXER_DAEMON_SCHEMA_VERSION,
    state: overrides.state ?? "synced",
    processId: 4321,
    startedAtUnixMs: 1_700_000_000_000,
    heartbeatAtUnixMs: overrides.heartbeatAtUnixMs ?? 1_700_000_000_000,
    ipcReady: true,
    rpcReachable: overrides.rpcReachable ?? true,
    coreBestHeight: overrides.coreBestHeight ?? 123,
    coreBestHash: overrides.coreBestHash ?? "03".repeat(32),
    appliedTipHeight: overrides.appliedTipHeight ?? 123,
    appliedTipHash: overrides.appliedTipHash ?? "03".repeat(32),
    snapshotSeq: overrides.snapshotSeq ?? "1",
    backlogBlocks: overrides.backlogBlocks ?? 0,
    reorgDepth: overrides.reorgDepth ?? null,
    lastAppliedAtUnixMs: overrides.lastAppliedAtUnixMs ?? 1_700_000_000_000,
    activeSnapshotCount: overrides.activeSnapshotCount ?? 0,
    lastError: overrides.lastError ?? null,
  };
}

function createBitcoindServiceStatus(walletRootId: string, overrides: Partial<{
  serviceInstanceId: string;
  state: "starting" | "ready" | "stopping" | "failed";
  processId: number | null;
  dataDir: string;
  runtimeRoot: string;
  startedAtUnixMs: number;
  heartbeatAtUnixMs: number;
  updatedAtUnixMs: number;
  lastError: string | null;
  walletReplicaProofStatus: "not-proven" | "ready" | "missing" | "mismatch";
}> = {}): ManagedBitcoindServiceStatus {
  return {
    serviceApiVersion: MANAGED_BITCOIND_SERVICE_API_VERSION,
    binaryVersion: "0.0.0-test",
    buildId: null,
    serviceInstanceId: overrides.serviceInstanceId ?? "bitcoind-1",
    state: overrides.state ?? "ready",
    processId: overrides.processId ?? 1234,
    walletRootId,
    chain: "main" as const,
    dataDir: overrides.dataDir ?? "/tmp/cogcoin-bitcoin",
    runtimeRoot: overrides.runtimeRoot ?? `/tmp/runtime/${walletRootId}`,
    startHeight: 0,
    rpc: {
      url: "http://127.0.0.1:8332",
      cookieFile: "/tmp/cogcoin-bitcoin/.cookie",
      port: 8332,
    },
    zmq: {
      endpoint: "tcp://127.0.0.1:28332",
      topic: "hashblock" as const,
      port: 28332,
      pollIntervalMs: 15_000,
    },
    p2pPort: 8333,
    walletReplica: {
      walletRootId,
      walletName: `cogcoin-${walletRootId}`,
      loaded: true,
      descriptors: true,
      privateKeysEnabled: true,
      created: false,
      proofStatus: overrides.walletReplicaProofStatus ?? "ready",
      descriptorChecksum: "priv",
      fundingAddress0: "bc1qfundingidentity0000000000000000000000000",
      fundingScriptPubKeyHex0: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
      message: null,
    },
    startedAtUnixMs: overrides.startedAtUnixMs ?? 1_700_000_000_000,
    heartbeatAtUnixMs: overrides.heartbeatAtUnixMs ?? 1_700_000_000_100,
    updatedAtUnixMs: overrides.updatedAtUnixMs ?? 1_700_000_000_200,
    lastError: overrides.lastError ?? null,
  };
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
        canonicalChainStatus: "unknown",
        localAnchorIntent: "none",
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
      {
        name: "beta",
        domainId: 2,
        dedicatedIndex: 2,
        currentOwnerScriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
        currentOwnerLocalIndex: 2,
        canonicalChainStatus: "unknown",
        localAnchorIntent: "none",
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
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
    ...partial,
  };
}

function createMiningView(partial: {
  runtime?: Partial<MiningControlPlaneView["runtime"]>;
  hook?: Partial<MiningControlPlaneView["hook"]>;
  provider?: Partial<MiningControlPlaneView["provider"]>;
  lastEventAtUnixMs?: number | null;
} = {}): MiningControlPlaneView {
  const hookValidationState = partial.hook?.validationState ?? "unknown";
  const operatorValidationState = partial.hook?.operatorValidationState
    ?? (hookValidationState === "validated"
      ? "current"
      : hookValidationState === "stale"
        ? "stale"
        : hookValidationState === "failed"
          ? "failed"
          : "never");
  const runtimeValidationState = partial.runtime?.lastValidationState
    ?? (hookValidationState === "unavailable" ? null : hookValidationState);
  const runtimeOperatorValidationState = partial.runtime?.lastOperatorValidationState
    ?? operatorValidationState;

  return {
    runtime: {
      schemaVersion: 1,
      walletRootId: "wallet-root-test",
      workerApiVersion: null,
      workerBinaryVersion: null,
      workerBuildId: null,
      updatedAtUnixMs: 1_700_000_000_000,
      runMode: "stopped",
      backgroundWorkerPid: null,
      backgroundWorkerRunId: null,
      backgroundWorkerHeartbeatAtUnixMs: null,
      backgroundWorkerHealth: null,
      indexerDaemonState: "synced",
      indexerDaemonInstanceId: null,
      indexerHeartbeatAtUnixMs: null,
      coreBestHeight: null,
      coreBestHash: null,
      indexerTipHeight: null,
      indexerTipHash: null,
      indexerReorgDepth: null,
      indexerTipAligned: true,
      corePublishState: "healthy",
      providerState: "unavailable",
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
      providerConfigured: false,
      providerKind: null,
      bitcoindHealth: "ready",
      bitcoindServiceState: "ready",
      bitcoindReplicaStatus: "ready",
      nodeHealth: "synced",
      indexerHealth: "synced",
      tipsAligned: true,
      lastValidationState: runtimeValidationState,
      lastOperatorValidationState: runtimeOperatorValidationState,
      lastValidationAtUnixMs: null,
      lastEventAtUnixMs: null,
      lastError: null,
      note: "Run `cogcoin mine setup` to configure the built-in mining provider.",
      ...(partial.runtime ?? {}),
    },
    hook: {
      mode: "builtin",
      entrypointPath: "/tmp/hooks/mining/generate-sentences.js",
      packagePath: "/tmp/hooks/mining/package.json",
      entrypointExists: false,
      packageStatus: "missing",
      packageMessage: "package.json is missing for the custom mining hook.",
      trustStatus: "missing",
      trustMessage: "Hook path /tmp/hooks/mining does not exist yet.",
      validationState: hookValidationState,
      operatorValidationState,
      validationError: null,
      validatedAtUnixMs: null,
      validatedLaunchFingerprint: null,
      validatedFullFingerprint: null,
      currentLaunchFingerprint: null,
      currentFullFingerprint: null,
      verifyUsed: false,
      cooldownUntilUnixMs: null,
      cooldownActive: false,
      consecutiveFailureCount: 0,
      ...(partial.hook ?? {}),
    },
    provider: {
      configured: false,
      provider: null,
      status: "missing",
      message: "Built-in mining provider is not configured yet.",
      modelOverride: null,
      extraPromptConfigured: false,
      ...(partial.provider ?? {}),
    },
    lastEventAtUnixMs: partial.lastEventAtUnixMs ?? null,
  };
}

async function createReadyWalletReadContext(localState = createWalletState()): Promise<WalletReadContext> {
  const vector = loadHistoryVector();
  const state = await replayBlocks([
    ...vector.setupBlocks.map(materializeBlock),
    ...vector.testBlocks.map(materializeBlock),
  ]);
  const snapshot = {
    state,
    tip: {
      height: state.history.currentHeight ?? 0,
      blockHashHex: "0303030303030303030303030303030303030303030303030303030303030303",
      previousHashHex: "0202020202020202020202020202020202020202020202020202020202020202",
      stateHashHex: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  };
  const model = createWalletReadModel(localState, snapshot);

  return {
    dataDir: "/tmp/cogcoin-bitcoin",
    databasePath: "/tmp/cogcoin-client.sqlite",
    localState: {
      availability: "ready",
      walletRootId: localState.walletRootId,
      state: localState,
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
      pid: 1234,
      walletRootId: localState.walletRootId,
      nodeBestHeight: snapshot.tip.height,
      nodeBestHashHex: snapshot.tip.blockHashHex,
      nodeHeaderHeight: snapshot.tip.height,
      serviceUpdatedAtUnixMs: 1_700_000_000_000,
      serviceStatus: null,
      walletReplica: {
        walletRootId: localState.walletRootId,
        walletName: "cogcoin-wallet-root-test",
        loaded: true,
        descriptors: true,
        privateKeysEnabled: true,
        created: false,
        proofStatus: "ready",
        descriptorChecksum: "priv",
        fundingAddress0: "bc1qfundingidentity0000000000000000000000000",
        fundingScriptPubKeyHex0: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
        message: null,
      },
      walletReplicaMessage: null,
    },
    nodeHealth: "synced",
    nodeMessage: null,
    indexer: {
      health: "synced",
      status: createIndexerDaemonStatus(localState.walletRootId),
      message: null,
      snapshotTip: snapshot.tip,
    },
    snapshot,
    model,
    mining: createMiningView(),
    async close() {},
  };
}

async function createDomainFilterReadContext(): Promise<WalletReadContext> {
  const defaults = createWalletState().domains;
  const walletState = createWalletState({
    domains: [
      {
        ...defaults[0]!,
        canonicalChainStatus: "anchored",
        currentCanonicalAnchorOutpoint: {
          txid: "11".repeat(32),
          vout: 0,
          valueSats: 2_000,
        },
      },
      {
        ...defaults[1]!,
        canonicalChainStatus: "anchored",
      },
      {
        name: "weatherbot",
        domainId: 99,
        dedicatedIndex: null,
        currentOwnerScriptPubKeyHex: null,
        currentOwnerLocalIndex: null,
        canonicalChainStatus: "registered-unanchored",
        localAnchorIntent: "none",
        currentCanonicalAnchorOutpoint: null,
        foundingMessageText: null,
        birthTime: null,
      },
    ],
  });
  const readyContext = await createReadyWalletReadContext(walletState);
  assert.ok(readyContext.snapshot !== null);

  const snapshotState = structuredClone(readyContext.snapshot.state);
  snapshotState.consensus.listings.set(2, {
    domainId: 2,
    priceCogtoshi: 250n,
    sellerScriptPubKey: Buffer.from("00145f5a03d6c7c88648b5f947459b769008ced5a020", "hex"),
  });

  const snapshot = {
    ...readyContext.snapshot,
    state: snapshotState,
  };

  return {
    ...readyContext,
    snapshot,
    model: createWalletReadModel(walletState, snapshot),
  };
}

test("lock workflow hints pick the first actionable displayed lock for each action type", () => {
  const locks: WalletLockView[] = [
    {
      lockId: 12,
      status: "active",
      amountCogtoshi: 5n,
      timeoutHeight: 100,
      lockerScriptPubKeyHex: "00",
      lockerLocalIndex: 1,
      recipientDomainId: 1,
      recipientDomainName: "alpha",
      recipientLocal: true,
      claimableNow: false,
      reclaimableNow: false,
    },
    {
      lockId: 15,
      status: "active",
      amountCogtoshi: 7n,
      timeoutHeight: 101,
      lockerScriptPubKeyHex: "11",
      lockerLocalIndex: 1,
      recipientDomainId: 1,
      recipientDomainName: "alpha",
      recipientLocal: true,
      claimableNow: true,
      reclaimableNow: false,
    },
    {
      lockId: 18,
      status: "active",
      amountCogtoshi: 9n,
      timeoutHeight: 102,
      lockerScriptPubKeyHex: "22",
      lockerLocalIndex: 2,
      recipientDomainId: 2,
      recipientDomainName: "beta",
      recipientLocal: true,
      claimableNow: true,
      reclaimableNow: false,
    },
    {
      lockId: 21,
      status: "active",
      amountCogtoshi: 11n,
      timeoutHeight: 103,
      lockerScriptPubKeyHex: "33",
      lockerLocalIndex: 2,
      recipientDomainId: 2,
      recipientDomainName: "beta",
      recipientLocal: true,
      claimableNow: false,
      reclaimableNow: true,
    },
    {
      lockId: 24,
      status: "active",
      amountCogtoshi: 13n,
      timeoutHeight: 104,
      lockerScriptPubKeyHex: "44",
      lockerLocalIndex: 2,
      recipientDomainId: 2,
      recipientDomainName: "beta",
      recipientLocal: true,
      claimableNow: false,
      reclaimableNow: true,
    },
  ];

  assert.deepEqual(getLocksNextSteps(locks), [
    "cogcoin claim 15 --preimage <32-byte-hex>",
    "cogcoin reclaim 21",
  ]);
  assert.deepEqual(getLocksNextSteps(locks.filter((lock) => lock.claimableNow)), [
    "cogcoin claim 15 --preimage <32-byte-hex>",
  ]);
  assert.deepEqual(getLocksNextSteps(locks.filter((lock) => lock.reclaimableNow)), [
    "cogcoin reclaim 21",
  ]);
  assert.deepEqual(getLocksNextSteps(locks.filter((lock) => !lock.claimableNow && !lock.reclaimableNow)), []);
});

test("parseCliArgs handles commands and common flags", () => {
  const parsed = parseCliArgs([
    "sync",
    "--db",
    "/tmp/client.sqlite",
    "--data-dir",
    "/tmp/bitcoin",
    "--progress",
    "tty",
  ]);

  assert.deepEqual(parsed, {
    command: "sync",
    args: [],
    help: false,
    version: false,
    outputMode: "text",
    dbPath: "/tmp/client.sqlite",
    dataDir: "/tmp/bitcoin",
    progressOutput: "tty",
    unlockFor: null,
    assumeYes: false,
    forceRace: false,
    anchorMessage: null,
    transferTarget: null,
    endpointText: null,
    endpointJson: null,
    endpointBytes: null,
    reviewText: null,
    fieldPermanent: false,
    fieldFormat: null,
    fieldValue: null,
    fromIdentity: null,
    lockRecipientDomain: null,
    conditionHex: null,
    untilHeight: null,
    preimageHex: null,
    locksClaimableOnly: false,
    locksReclaimableOnly: false,
    domainsAnchoredOnly: false,
    domainsListedOnly: false,
    domainsMineableOnly: false,
    listLimit: null,
    listAll: false,
    verify: false,
    follow: false,
  });
});

test("parseCliArgs handles wallet status and field inspection commands", () => {
  const walletStatus = parseCliArgs(["wallet", "status"]);
  assert.equal(walletStatus.command, "wallet-status");
  assert.deepEqual(walletStatus.args, []);
  assert.equal(walletStatus.unlockFor, null);
  assert.equal(walletStatus.assumeYes, false);
  assert.equal(walletStatus.outputMode, "text");

  const walletAddress = parseCliArgs(["wallet", "address"]);
  assert.equal(walletAddress.command, "wallet-address");
  assert.deepEqual(walletAddress.args, []);

  const walletIds = parseCliArgs(["wallet", "ids", "--limit", "2"]);
  assert.equal(walletIds.command, "wallet-ids");
  assert.deepEqual(walletIds.args, []);
  assert.equal(walletIds.listLimit, 2);

  const field = parseCliArgs(["field", "alpha", "bio"]);
  assert.equal(field.command, "field");
  assert.deepEqual(field.args, ["alpha", "bio"]);

  const fieldList = parseCliArgs(["field", "list", "alpha"]);
  assert.equal(fieldList.command, "field-list");
  assert.deepEqual(fieldList.args, ["alpha"]);

  const fieldShow = parseCliArgs(["field", "show", "alpha", "bio"]);
  assert.equal(fieldShow.command, "field-show");
  assert.deepEqual(fieldShow.args, ["alpha", "bio"]);

  const fieldCreate = parseCliArgs(["field", "create", "alpha", "tagline", "--permanent", "--text", "hello"]);
  assert.equal(fieldCreate.command, "field-create");
  assert.deepEqual(fieldCreate.args, ["alpha", "tagline"]);
  assert.equal(fieldCreate.fieldPermanent, true);
  assert.equal(fieldCreate.endpointText, "hello");

  const fieldSet = parseCliArgs(["field", "set", "alpha", "bio", "--format", "raw:7", "--value", "utf8:hello"]);
  assert.equal(fieldSet.command, "field-set");
  assert.deepEqual(fieldSet.args, ["alpha", "bio"]);
  assert.equal(fieldSet.fieldFormat, "raw:7");
  assert.equal(fieldSet.fieldValue, "utf8:hello");

  const fieldClear = parseCliArgs(["field", "clear", "alpha", "bio"]);
  assert.equal(fieldClear.command, "field-clear");
  assert.deepEqual(fieldClear.args, ["alpha", "bio"]);

  const register = parseCliArgs(["register", "weatherbot", "--force-race"]);
  assert.equal(register.command, "register");
  assert.deepEqual(register.args, ["weatherbot"]);
  assert.equal(register.forceRace, true);

  const registerFrom = parseCliArgs(["register", "weatherbot", "--from", "id:1"]);
  assert.equal(registerFrom.command, "register");
  assert.deepEqual(registerFrom.args, ["weatherbot"]);
  assert.equal(registerFrom.fromIdentity, "id:1");

  const domainRegister = parseCliArgs(["domain", "register", "alpha-child"]);
  assert.equal(domainRegister.command, "domain-register");
  assert.deepEqual(domainRegister.args, ["alpha-child"]);

  const domainRegisterFrom = parseCliArgs(["domain", "register", "weatherbot", "--from", "domain:alpha"]);
  assert.equal(domainRegisterFrom.command, "domain-register");
  assert.deepEqual(domainRegisterFrom.args, ["weatherbot"]);
  assert.equal(domainRegisterFrom.fromIdentity, "domain:alpha");

  const anchor = parseCliArgs(["anchor", "weatherbot", "--message", "hello"]);
  assert.equal(anchor.command, "anchor");
  assert.deepEqual(anchor.args, ["weatherbot"]);
  assert.equal(anchor.anchorMessage, "hello");

  const domainAnchor = parseCliArgs(["domain", "anchor", "alpha-child"]);
  assert.equal(domainAnchor.command, "domain-anchor");
  assert.deepEqual(domainAnchor.args, ["alpha-child"]);

  const transfer = parseCliArgs(["transfer", "alpha", "--to", "spk:00141111111111111111111111111111111111111111"]);
  assert.equal(transfer.command, "transfer");
  assert.deepEqual(transfer.args, ["alpha"]);
  assert.equal(transfer.transferTarget, "spk:00141111111111111111111111111111111111111111");

  const domainTransfer = parseCliArgs(["domain", "transfer", "beta", "--to", "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"]);
  assert.equal(domainTransfer.command, "domain-transfer");
  assert.deepEqual(domainTransfer.args, ["beta"]);
  assert.equal(domainTransfer.transferTarget, "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh");

  const sell = parseCliArgs(["sell", "alpha", "12.5"]);
  assert.equal(sell.command, "sell");
  assert.deepEqual(sell.args, ["alpha", "12.5"]);

  const sellYes = parseCliArgs(["sell", "alpha", "12.5", "--yes"]);
  assert.equal(sellYes.command, "sell");
  assert.equal(sellYes.assumeYes, true);

  const unsell = parseCliArgs(["unsell", "alpha"]);
  assert.equal(unsell.command, "unsell");
  assert.deepEqual(unsell.args, ["alpha"]);

  const buy = parseCliArgs(["buy", "alpha"]);
  assert.equal(buy.command, "buy");
  assert.deepEqual(buy.args, ["alpha"]);

  const buyFrom = parseCliArgs(["buy", "alpha", "--from", "id:1"]);
  assert.equal(buyFrom.command, "buy");
  assert.deepEqual(buyFrom.args, ["alpha"]);
  assert.equal(buyFrom.fromIdentity, "id:1");

  const domainBuyFrom = parseCliArgs(["domain", "buy", "alpha", "--from", "domain:beta"]);
  assert.equal(domainBuyFrom.command, "domain-buy");
  assert.deepEqual(domainBuyFrom.args, ["alpha"]);
  assert.equal(domainBuyFrom.fromIdentity, "domain:beta");

  const subdomainRegisterYes = parseCliArgs(["register", "alpha-child", "--yes"]);
  assert.equal(subdomainRegisterYes.command, "register");
  assert.equal(subdomainRegisterYes.assumeYes, true);

  const repGive = parseCliArgs(["rep", "give", "alpha", "beta", "1.5", "--review", "solid operator"]);
  assert.equal(repGive.command, "rep-give");
  assert.deepEqual(repGive.args, ["alpha", "beta", "1.5"]);
  assert.equal(repGive.reviewText, "solid operator");

  const repRevoke = parseCliArgs(["rep", "revoke", "alpha", "beta", "0.5"]);
  assert.equal(repRevoke.command, "rep-revoke");
  assert.deepEqual(repRevoke.args, ["alpha", "beta", "0.5"]);
  assert.equal(repRevoke.reviewText, null);

  const send = parseCliArgs(["send", "1.25", "--to", "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", "--from", "id:1"]);
  assert.equal(send.command, "send");
  assert.deepEqual(send.args, ["1.25"]);
  assert.equal(send.transferTarget, "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh");
  assert.equal(send.fromIdentity, "id:1");

  const cogSend = parseCliArgs(["cog", "send", "0.5", "--to", "spk:00141111111111111111111111111111111111111111"]);
  assert.equal(cogSend.command, "cog-send");
  assert.deepEqual(cogSend.args, ["0.5"]);

  const claim = parseCliArgs(["claim", "7", "--preimage", "11".repeat(32)]);
  assert.equal(claim.command, "claim");
  assert.deepEqual(claim.args, ["7"]);
  assert.equal(claim.preimageHex, "11".repeat(32));

  const reclaim = parseCliArgs(["cog", "reclaim", "9"]);
  assert.equal(reclaim.command, "cog-reclaim");
  assert.deepEqual(reclaim.args, ["9"]);

  const lock = parseCliArgs(["cog", "lock", "12", "--to-domain", "alpha", "--for", "6h", "--condition", "22".repeat(32), "--from", "domain:alpha"]);
  assert.equal(lock.command, "cog-lock");
  assert.deepEqual(lock.args, ["12"]);
  assert.equal(lock.lockRecipientDomain, "alpha");
  assert.equal(lock.unlockFor, "6h");
  assert.equal(lock.conditionHex, "22".repeat(32));
  assert.equal(lock.fromIdentity, "domain:alpha");

  const endpointSet = parseCliArgs(["domain", "endpoint", "set", "alpha", "--text", "hello"]);
  assert.equal(endpointSet.command, "domain-endpoint-set");
  assert.deepEqual(endpointSet.args, ["alpha"]);
  assert.equal(endpointSet.endpointText, "hello");

  const endpointClear = parseCliArgs(["domain", "endpoint", "clear", "alpha"]);
  assert.equal(endpointClear.command, "domain-endpoint-clear");

  const delegateSet = parseCliArgs(["domain", "delegate", "set", "alpha", "spk:00141111111111111111111111111111111111111111"]);
  assert.equal(delegateSet.command, "domain-delegate-set");
  assert.deepEqual(delegateSet.args, ["alpha", "spk:00141111111111111111111111111111111111111111"]);

  const minerSet = parseCliArgs(["domain", "miner", "set", "alpha", "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"]);
  assert.equal(minerSet.command, "domain-miner-set");

  const canonical = parseCliArgs(["domain", "canonical", "alpha"]);
  assert.equal(canonical.command, "domain-canonical");

  const filteredLocks = parseCliArgs(["cog", "locks", "--claimable", "--limit", "5"]);
  assert.equal(filteredLocks.command, "cog-locks");
  assert.equal(filteredLocks.locksClaimableOnly, true);
  assert.equal(filteredLocks.listLimit, 5);
  assert.equal(filteredLocks.outputMode, "text");

  const domainList = parseCliArgs(["domain", "list", "--all"]);
  assert.equal(domainList.command, "domain-list");
  assert.equal(domainList.listAll, true);

  const filteredDomains = parseCliArgs(["domains", "--anchored", "--listed", "--mineable", "--limit", "2"]);
  assert.equal(filteredDomains.command, "domains");
  assert.equal(filteredDomains.domainsAnchoredOnly, true);
  assert.equal(filteredDomains.domainsListedOnly, true);
  assert.equal(filteredDomains.domainsMineableOnly, true);
  assert.equal(filteredDomains.listLimit, 2);

  const domainShow = parseCliArgs(["domain", "show", "alpha"]);
  assert.equal(domainShow.command, "domain-show");
  assert.deepEqual(domainShow.args, ["alpha"]);

  const idsJson = parseCliArgs(["ids", "--output", "json", "--limit", "2"]);
  assert.equal(idsJson.command, "ids");
  assert.equal(idsJson.outputMode, "json");
  assert.equal(idsJson.listLimit, 2);

  const domainsAll = parseCliArgs(["domains", "--all"]);
  assert.equal(domainsAll.command, "domains");
  assert.equal(domainsAll.listAll, true);

  const hooksEnable = parseCliArgs(["hooks", "enable", "mining"]);
  assert.equal(hooksEnable.command, "hooks-mining-enable");

  const hooksStatus = parseCliArgs(["hooks", "status", "--verify"]);
  assert.equal(hooksStatus.command, "hooks-mining-status");
  assert.equal(hooksStatus.verify, true);

  const bitcoinStart = parseCliArgs(["bitcoin", "start"]);
  assert.equal(bitcoinStart.command, "bitcoin-start");

  const bitcoinStop = parseCliArgs(["bitcoin", "stop"]);
  assert.equal(bitcoinStop.command, "bitcoin-stop");

  const bitcoinStatus = parseCliArgs(["bitcoin", "status", "--output", "json"]);
  assert.equal(bitcoinStatus.command, "bitcoin-status");
  assert.equal(bitcoinStatus.outputMode, "json");

  const indexerStart = parseCliArgs(["indexer", "start"]);
  assert.equal(indexerStart.command, "indexer-start");

  const indexerStop = parseCliArgs(["indexer", "stop"]);
  assert.equal(indexerStop.command, "indexer-stop");

  const indexerStatus = parseCliArgs(["indexer", "status"]);
  assert.equal(indexerStatus.command, "indexer-status");

  const mineSetup = parseCliArgs(["mine", "setup"]);
  assert.equal(mineSetup.command, "mine-setup");

  const mineStatus = parseCliArgs(["mine", "status"]);
  assert.equal(mineStatus.command, "mine-status");

  const mineLog = parseCliArgs(["mine", "log", "--all"]);
  assert.equal(mineLog.command, "mine-log");
  assert.equal(mineLog.follow, false);
  assert.equal(mineLog.listAll, true);

  assert.throws(() => parseCliArgs(["mine", "log", "--follow", "--all"]), /cli_follow_limit_not_supported/);
  assert.throws(() => parseCliArgs(["mine", "log", "--follow", "--output", "json"]), /cli_follow_json_not_supported/);
  assert.throws(() => parseCliArgs(["ids", "--limit", "1001"]), /cli_invalid_limit/);
  assert.throws(() => parseCliArgs(["show", "alpha", "--mineable"]), /cli_domain_filters_not_supported_for_command/);
  assert.throws(() => parseCliArgs(["anchor", "alpha", "--yes"]), /cli_yes_not_supported_for_command/);
});

test("parseCliArgs handles mining runtime commands", () => {
  const foreground = parseCliArgs(["mine"]);
  assert.equal(foreground.command, "mine");
  assert.deepEqual(foreground.args, []);

  const start = parseCliArgs(["mine", "start"]);
  assert.equal(start.command, "mine-start");
  assert.deepEqual(start.args, []);

  const stop = parseCliArgs(["mine", "stop"]);
  assert.equal(stop.command, "mine-stop");
  assert.deepEqual(stop.args, []);
});

test("parseCliArgs handles wallet init/restore/unlock/lock/export/import and repair commands", () => {
  const init = parseCliArgs(["init"]);
  assert.equal(init.command, "init");

  const walletInit = parseCliArgs(["wallet", "init"]);
  assert.equal(walletInit.command, "wallet-init");

  const restore = parseCliArgs(["restore"]);
  assert.equal(restore.command, "restore");

  const walletRestore = parseCliArgs(["wallet", "restore"]);
  assert.equal(walletRestore.command, "wallet-restore");

  const walletShowMnemonic = parseCliArgs(["wallet", "show-mnemonic"]);
  assert.equal(walletShowMnemonic.command, "wallet-show-mnemonic");
  assert.deepEqual(walletShowMnemonic.args, []);

  const unlock = parseCliArgs(["unlock", "--for", "2h"]);
  assert.equal(unlock.command, "unlock");
  assert.equal(unlock.unlockFor, "2h");

  const walletLock = parseCliArgs(["wallet", "lock"]);
  assert.equal(walletLock.command, "wallet-lock");

  const walletExport = parseCliArgs(["wallet", "export", "/tmp/archive.cogwallet"]);
  assert.equal(walletExport.command, "wallet-export");
  assert.deepEqual(walletExport.args, ["/tmp/archive.cogwallet"]);

  const walletImport = parseCliArgs(["wallet", "import", "/tmp/archive.cogwallet"]);
  assert.equal(walletImport.command, "wallet-import");
  assert.deepEqual(walletImport.args, ["/tmp/archive.cogwallet"]);

  const repair = parseCliArgs(["repair", "--yes"]);
  assert.equal(repair.command, "repair");
  assert.equal(repair.assumeYes, true);

  assert.equal(
    describeCanonicalCommand(walletShowMnemonic),
    "cogcoin wallet show-mnemonic",
  );
});

test("parseCliArgs allows json on covered action commands and rejects excluded commands", () => {
  const supportedArgv = [
    ["init", "--output", "json"],
    ["wallet", "init", "--output", "json"],
    ["restore", "--output", "json"],
    ["wallet", "restore", "--output", "json"],
    ["unlock", "--output", "json"],
    ["wallet", "unlock", "--output", "json"],
    ["wallet", "export", "/tmp/archive.cogwallet", "--output", "json"],
    ["wallet", "import", "/tmp/archive.cogwallet", "--output", "json"],
    ["wallet", "lock", "--output", "json"],
    ["repair", "--output", "json"],
    ["bitcoin", "start", "--output", "json"],
    ["bitcoin", "stop", "--output", "json"],
    ["bitcoin", "status", "--output", "json"],
    ["indexer", "start", "--output", "json"],
    ["indexer", "stop", "--output", "json"],
    ["indexer", "status", "--output", "json"],
    ["register", "alpha-child", "--output", "json"],
    ["domain", "buy", "alpha", "--output", "json"],
    ["send", "1", "--to", "spk:00141111111111111111111111111111111111111111", "--output", "json"],
    ["cog", "lock", "2", "--to-domain", "alpha", "--until-height", "500", "--condition", "22".repeat(32), "--output", "json"],
    ["domain", "endpoint", "clear", "alpha", "--output", "json"],
    ["field", "clear", "alpha", "bio", "--output", "json"],
    ["rep", "revoke", "alpha", "beta", "1", "--output", "json"],
    ["hooks", "enable", "mining", "--output", "json"],
    ["hooks", "disable", "mining", "--output", "json"],
    ["mine", "setup", "--output", "json"],
    ["mine", "start", "--output", "json"],
    ["mine", "stop", "--output", "json"],
  ];

  for (const argv of supportedArgv) {
    const parsed = parseCliArgs(argv);
    assert.equal(parsed.outputMode, "json");
  }

  assert.throws(() => parseCliArgs(["mine", "--output", "json"]), /cli_output_not_supported_for_command/);
  assert.throws(() => parseCliArgs(["restore", "--output", "preview-json"]), /cli_output_not_supported_for_command/);
  assert.throws(() => parseCliArgs(["wallet", "show-mnemonic", "--output", "json"]), /cli_output_not_supported_for_command/);
  assert.throws(() => parseCliArgs(["wallet", "show-mnemonic", "--output", "preview-json"]), /cli_output_not_supported_for_command/);
});

test("help output lists wallet show-mnemonic", async () => {
  const stdout = new MemoryStream();
  const code = await runCli(["--help"], {
    stdout,
    stderr: new MemoryStream(),
  });

  assert.equal(code, 0);
  assert.match(stdout.toString(), /wallet show-mnemonic/);
});

test("wallet show-mnemonic dispatches through wallet admin without resolving db or data paths", async () => {
  const stdout = new MemoryStream();
  const prompter = {
    isInteractive: true,
    writeLine() {},
    async prompt() {
      return "";
    },
    clearSensitiveDisplay() {},
  };
  let called = false;

  const code = await runCli(["wallet", "show-mnemonic"], {
    stdout,
    stderr: new MemoryStream(),
    createPrompter: () => prompter,
    showWalletMnemonic: async (options) => {
      called = true;
      assert.equal(options.prompter, prompter);
    },
    resolveDefaultBitcoindDataDir: () => {
      throw new Error("should_not_resolve_data_dir");
    },
    resolveDefaultClientDatabasePath: () => {
      throw new Error("should_not_resolve_db_path");
    },
  });

  assert.equal(code, 0);
  assert.equal(called, true);
  assert.equal(stdout.toString(), "");
});

test("parseCliArgs allows preview-json on covered preview commands and rejects unsupported commands", () => {
  const supportedArgv = [
    ["register", "alpha-child", "--output", "preview-json"],
    ["domain", "buy", "alpha", "--output", "preview-json"],
    ["wallet", "lock", "--output", "preview-json"],
    ["repair", "--output", "preview-json"],
    ["hooks", "enable", "mining", "--output", "preview-json"],
    ["hooks", "disable", "mining", "--output", "preview-json"],
    ["mine", "setup", "--output", "preview-json"],
    ["mine", "start", "--output", "preview-json"],
    ["mine", "stop", "--output", "preview-json"],
  ];

  for (const argv of supportedArgv) {
    const parsed = parseCliArgs(argv);
    assert.equal(parsed.outputMode, "preview-json");
  }

  assert.throws(() => parseCliArgs(["init", "--output", "preview-json"]), /cli_output_not_supported_for_command/);
  assert.throws(() => parseCliArgs(["status", "--output", "preview-json"]), /cli_output_not_supported_for_command/);
  assert.throws(() => parseCliArgs(["mine", "--output", "preview-json"]), /cli_output_not_supported_for_command/);
});

test("default client database path resolves beside Cogcoin bitcoin data", () => {
  assert.equal(
    resolveCogcoinAppRootForTesting({
      platform: "darwin",
      homeDirectory: "/Users/cogtoshi",
      env: {},
    }),
    "/Users/cogtoshi/Library/Application Support/Cogcoin",
  );

  assert.equal(
    resolveDefaultClientDatabasePathForTesting({
      platform: "darwin",
      homeDirectory: "/Users/cogtoshi",
      env: {},
    }),
    "/Users/cogtoshi/Library/Application Support/Cogcoin/client/client.sqlite",
  );

  assert.equal(
    resolveDefaultClientDatabasePathForTesting({
      platform: "linux",
      homeDirectory: "/home/cogtoshi",
      env: {},
    }),
    "/home/cogtoshi/.local/share/cogcoin/client/client.sqlite",
  );

  assert.equal(
    resolveDefaultClientDatabasePathForTesting({
      platform: "win32",
      homeDirectory: "C:\\Users\\Cogtoshi",
      env: {
        LOCALAPPDATA: "C:\\Users\\Cogtoshi\\AppData\\Local",
      },
    }),
    "C:\\Users\\Cogtoshi\\AppData\\Local\\Cogcoin\\client\\client.sqlite",
  );
});

test("hooks status renders mining hook inspection output", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  let verifyRequested = false;

  const code = await runCli(["hooks", "status", "--verify"], {
    stdout,
    stderr,
    inspectMiningControlPlane: async (options) => {
      verifyRequested = options.verify ?? false;
      return createMiningView({
        hook: {
          mode: "custom",
          entrypointPath: "/tmp/hooks/mining/generate-sentences.js",
          packagePath: "/tmp/hooks/mining/package.json",
          validationState: "validated",
          entrypointExists: true,
          packageStatus: "valid",
          packageMessage: null,
          trustStatus: "trusted",
          trustMessage: null,
          validationError: null,
          validatedAtUnixMs: null,
          validatedLaunchFingerprint: null,
          validatedFullFingerprint: null,
          currentLaunchFingerprint: "aa".repeat(32),
          currentFullFingerprint: "bb".repeat(32),
          cooldownUntilUnixMs: null,
          consecutiveFailureCount: 0,
          verifyUsed: true,
        },
      });
    },
  });

  assert.equal(code, 0);
  assert.equal(verifyRequested, true);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /Mining Hook Status/);
  assert.match(stdout.toString(), /Mode: custom/);
  assert.match(stdout.toString(), /Full fingerprint: bb/);
});

test("mine status renders the mining control-plane summary", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const readyContext = await createReadyWalletReadContext();
  readyContext.mining = createMiningView({
    runtime: {
      schemaVersion: 1,
      hookMode: "custom",
      providerConfigured: true,
      providerKind: "openai",
      providerState: "ready",
      lastValidationState: "validated",
      note: null,
    },
    hook: {
      mode: "custom",
      entrypointPath: "/tmp/hooks/mining/generate-sentences.js",
      packagePath: "/tmp/hooks/mining/package.json",
      validationState: "validated",
      entrypointExists: true,
      packageStatus: "valid",
      packageMessage: null,
      trustStatus: "trusted",
      trustMessage: null,
      validationError: null,
      validatedAtUnixMs: null,
      validatedLaunchFingerprint: null,
      validatedFullFingerprint: null,
      currentLaunchFingerprint: null,
      currentFullFingerprint: null,
      verifyUsed: false,
      cooldownUntilUnixMs: null,
      consecutiveFailureCount: 0,
    },
    provider: {
      configured: true,
      provider: "openai",
      status: "ready",
      message: null,
      modelOverride: "gpt-5.4",
      extraPromptConfigured: true,
    },
  });

  const code = await runCli(["mine", "status"], {
    stdout,
    stderr,
    openWalletReadContext: async () => readyContext,
  });

  assert.equal(code, 0);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /Mining Status/);
  assert.match(stdout.toString(), /Hook mode: custom/);
  assert.match(stdout.toString(), /Provider: openai configured/);
});

test("mine status json surfaces service-version-mismatch indexer availability", async () => {
  const stdout = new MemoryStream();
  const readyContext = await createReadyWalletReadContext();
  readyContext.mining = createMiningView({
    runtime: {
      indexerHealth: "service-version-mismatch",
      indexerDaemonState: "service-version-mismatch",
      note: "Indexer compatibility mismatch.",
    },
  });

  const code = await runCli(["mine", "status", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    openWalletReadContext: async () => readyContext,
  });

  assert.equal(code, 0);
  const envelope = parseJsonEnvelope(stdout) as {
    schema: string;
    data: {
      availability: {
        indexer: {
          available: boolean;
          state: string | null;
        };
      };
    };
  };
  assert.equal(envelope.schema, "cogcoin/mine-status/v1");
  assert.equal(envelope.data.availability.indexer.available, false);
  assert.equal(envelope.data.availability.indexer.state, "service-version-mismatch");
});

test("mine status json surfaces wallet-root-mismatch indexer availability", async () => {
  const stdout = new MemoryStream();
  const readyContext = await createReadyWalletReadContext();
  readyContext.mining = createMiningView({
    runtime: {
      indexerHealth: "wallet-root-mismatch",
      indexerDaemonState: "wallet-root-mismatch",
      note: "Indexer wallet root mismatch.",
    },
  });

  const code = await runCli(["mine", "status", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    openWalletReadContext: async () => readyContext,
  });

  assert.equal(code, 0);
  const envelope = parseJsonEnvelope(stdout) as {
    data: {
      availability: {
        indexer: {
          available: boolean;
          state: string | null;
        };
      };
    };
  };
  assert.equal(envelope.data.availability.indexer.available, false);
  assert.equal(envelope.data.availability.indexer.state, "wallet-root-mismatch");
});

test("mine status surfaces explicit reorging output", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const readyContext = await createReadyWalletReadContext();
  readyContext.mining = createMiningView({
    runtime: {
      indexerHealth: "reorging",
      indexerDaemonState: "reorging",
      indexerReorgDepth: 4,
      note: "Mining remains stopped while the indexer replays a reorg and refreshes the coherent snapshot.",
    },
  });

  const code = await runCli(["mine", "status"], {
    stdout,
    stderr,
    openWalletReadContext: async () => readyContext,
  });

  assert.equal(code, 0);
  assert.equal(stderr.toString(), "");
  assert.match(stdout.toString(), /Indexer service: reorging/);
  assert.match(stdout.toString(), /Indexer reorg depth: 4/);
});

test("mine status json surfaces reorging indexer availability", async () => {
  const stdout = new MemoryStream();
  const readyContext = await createReadyWalletReadContext();
  readyContext.mining = createMiningView({
    runtime: {
      indexerHealth: "reorging",
      indexerDaemonState: "reorging",
      indexerReorgDepth: 4,
      note: "Mining remains stopped while the indexer replays a reorg and refreshes the coherent snapshot.",
    },
  });

  const code = await runCli(["mine", "status", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    openWalletReadContext: async () => readyContext,
  });

  assert.equal(code, 0);
  const envelope = parseJsonEnvelope(stdout) as {
    data: {
      indexerHealth: string;
      indexerDaemonState: string | null;
      indexerReorgDepth: number | null;
      availability: {
        indexer: {
          available: boolean;
          stale: boolean;
          state: string | null;
          reorgDepth: number | null;
        };
      };
    };
  };
  assert.equal(envelope.data.indexerHealth, "reorging");
  assert.equal(envelope.data.indexerDaemonState, "reorging");
  assert.equal(envelope.data.indexerReorgDepth, 4);
  assert.equal(envelope.data.availability.indexer.available, true);
  assert.equal(envelope.data.availability.indexer.stale, true);
  assert.equal(envelope.data.availability.indexer.state, "reorging");
  assert.equal(envelope.data.availability.indexer.reorgDepth, 4);
});

test("mine log prints recent events and supports follow mode", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const followOutput = new MemoryStream();

  const listCode = await runCli(["mine", "log", "--all"], {
    stdout,
    stderr,
    readMiningLog: async () => [
      {
        schemaVersion: 1,
        timestampUnixMs: 1_700_000_000_000,
        level: "info",
        kind: "mine-setup-completed",
        message: "Configured the built-in openai mining provider.",
      },
    ],
  });

  const followCode = await runCli(["mine", "log", "--follow"], {
    stdout: followOutput,
    stderr,
    followMiningLog: async ({ onEvent }) => {
      onEvent({
        schemaVersion: 1,
        timestampUnixMs: 1_700_000_000_001,
        level: "info",
        kind: "custom-hook-enabled",
        message: "Custom mining hook enabled after validation.",
      });
    },
  });

  assert.equal(listCode, 0);
  assert.equal(followCode, 0);
  assert.match(stdout.toString(), /mine-setup-completed/);
  assert.match(followOutput.toString(), /custom-hook-enabled/);
});

test("mine log json uses the stable envelope and rejects follow mode", async () => {
  const invalidStdout = new MemoryStream();
  const invalidCode = await runCli(["mine", "log", "--follow", "--output", "json"], {
    stdout: invalidStdout,
    stderr: new MemoryStream(),
  });

  assert.equal(invalidCode, 2);
  const invalidEnvelope = parseJsonEnvelope(invalidStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string };
  };
  assert.equal(invalidEnvelope.schema, "cogcoin/cli/v1");
  assert.equal(invalidEnvelope.ok, false);
  assert.equal(invalidEnvelope.error.code, "cli_follow_json_not_supported");

  const stdout = new MemoryStream();
  const code = await runCli(["mine", "log", "--output", "json", "--limit", "1"], {
    stdout,
    stderr: new MemoryStream(),
    readMiningLog: async () => [
      {
        schemaVersion: 1,
        timestampUnixMs: 1_700_000_000_000,
        level: "info",
        kind: "runner-started",
        message: "Started runner.",
      },
      {
        schemaVersion: 1,
        timestampUnixMs: 1_700_000_100_000,
        level: "warn",
        kind: "candidate-skipped",
        message: "Skipped publish.",
      },
    ],
  });

  assert.equal(code, 0);
  const envelope = parseJsonEnvelope(stdout) as {
    schema: string;
    ok: boolean;
    data: {
      events: Array<{ kind: string }>;
      truncated: boolean;
      page: { limit: number | null; returned: number; totalKnown: number | null };
    };
  };
  assert.equal(envelope.schema, "cogcoin/mine-log/v1");
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.events.length, 1);
  assert.equal(envelope.data.events[0]?.kind, "candidate-skipped");
  assert.equal(envelope.data.truncated, true);
  assert.equal(envelope.data.page.limit, 1);
  assert.equal(envelope.data.page.returned, 1);
  assert.equal(envelope.data.page.totalKnown, 2);
});

test("expanded Cogcoin path resolution exposes config, state, runtime, and hooks roots", () => {
  const linuxPaths = resolveCogcoinPathsForTesting({
    platform: "linux",
    homeDirectory: "/home/cogtoshi",
    env: {
      XDG_CONFIG_HOME: "/home/cogtoshi/.config",
      XDG_DATA_HOME: "/home/cogtoshi/.local/share",
      XDG_STATE_HOME: "/home/cogtoshi/.local/state",
      XDG_RUNTIME_DIR: "/run/user/1000",
    },
  });

  assert.equal(linuxPaths.configRoot, "/home/cogtoshi/.config/cogcoin");
  assert.equal(linuxPaths.stateRoot, "/home/cogtoshi/.local/state/cogcoin");
  assert.equal(linuxPaths.runtimeRoot, "/run/user/1000/cogcoin");
  assert.equal(linuxPaths.hooksRoot, "/home/cogtoshi/.config/cogcoin/hooks");
  assert.equal(linuxPaths.walletStatePath, "/home/cogtoshi/.local/state/cogcoin/wallet-state.enc");
  assert.equal(linuxPaths.walletUnlockSessionPath, "/run/user/1000/cogcoin/wallet-unlock-session.enc");
});

test("runCli shows help and rejects unknown commands", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();

  const helpCode = await runCli(["--help"], { stdout, stderr });
  assert.equal(helpCode, 0);
  assert.match(stdout.toString(), /Usage: cogcoin/);
  assert.match(stdout.toString(), /Quickstart:/);
  assert.match(stdout.toString(), /fund the wallet with about 0\.0015 BTC/);
  assert.match(stdout.toString(), /wallet address/);
  assert.match(stdout.toString(), /domain list/);
  assert.match(stdout.toString(), /status --output json/);
  assert.match(stdout.toString(), /bitcoin start/);
  assert.match(stdout.toString(), /indexer status/);

  const badStdout = new MemoryStream();
  const badStderr = new MemoryStream();
  const badCode = await runCli(["wat"], { stdout: badStdout, stderr: badStderr });
  assert.equal(badCode, 2);
  assert.match(badStderr.toString(), /cli_unknown_command_wat/);
});

test("bitcoin status json reports live node data without resolving the client db path", async () => {
  const stdout = new MemoryStream();
  const walletRootId = "wallet-root-services";

  const code = await runCli(["bitcoin", "status", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    resolveDefaultBitcoindDataDir: () => "/tmp/cogcoin-bitcoin",
    resolveDefaultClientDatabasePath: () => {
      throw new Error("client db path should not be resolved");
    },
    resolveWalletRuntimePaths: () => createTempWalletPaths("/tmp/cogcoin-cli-service"),
    loadRawWalletStateEnvelope: async () => createWalletStateEnvelopeStub(walletRootId),
    probeManagedBitcoindService: async () => ({
      compatibility: "compatible",
      status: createBitcoindServiceStatus(walletRootId, {
        dataDir: "/tmp/cogcoin-bitcoin",
      }),
      error: null,
    }),
    createBitcoinRpcClient: () => ({
      async getBlockchainInfo() {
        return {
          chain: "main",
          blocks: 910_000,
          headers: 910_005,
          bestblockhash: "aa".repeat(32),
          pruned: false,
          verificationprogress: 0.9999,
          initialblockdownload: false,
        };
      },
      async getNetworkInfo() {
        return {
          networkactive: true,
          connections: 8,
          connections_in: 3,
          connections_out: 5,
        };
      },
    }) as never,
  });

  assert.equal(code, 0);
  const envelope = parseJsonEnvelope(stdout) as {
    schema: string;
    ok: boolean;
    command: string;
    warnings: string[];
    explanations: string[];
    nextSteps: string[];
    data: {
      walletRootId: string;
      walletRootSource: string;
      compatibility: string;
      service: { serviceInstanceId: string; runtimeRoot: string };
      node: { bestHeight: number; headerHeight: number; connections: number };
    };
  };
  assert.equal(envelope.schema, "cogcoin/bitcoin-status/v1");
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "cogcoin bitcoin status");
  assert.deepEqual(envelope.warnings, []);
  assert.deepEqual(envelope.explanations, []);
  assert.deepEqual(envelope.nextSteps, []);
  assert.equal(envelope.data.walletRootId, walletRootId);
  assert.equal(envelope.data.walletRootSource, "wallet-state");
  assert.equal(envelope.data.compatibility, "compatible");
  assert.equal(envelope.data.service.serviceInstanceId, "bitcoind-1");
  assert.equal(envelope.data.service.runtimeRoot, `/tmp/runtime/${walletRootId}`);
  assert.equal(envelope.data.node.bestHeight, 910_000);
  assert.equal(envelope.data.node.headerHeight, 910_005);
  assert.equal(envelope.data.node.connections, 8);
});

test("bitcoin status renders sectioned healthy text output without a next step", async () => {
  const stdout = new MemoryStream();
  const walletRootId = "wallet-root-services";

  const code = await runCli(["bitcoin", "status"], {
    stdout,
    stderr: new MemoryStream(),
    resolveDefaultBitcoindDataDir: () => "/tmp/cogcoin-bitcoin",
    resolveDefaultClientDatabasePath: () => {
      throw new Error("client db path should not be resolved");
    },
    resolveWalletRuntimePaths: () => createTempWalletPaths("/tmp/cogcoin-cli-service"),
    loadRawWalletStateEnvelope: async () => createWalletStateEnvelopeStub(walletRootId),
    probeManagedBitcoindService: async () => ({
      compatibility: "compatible",
      status: createBitcoindServiceStatus(walletRootId, {
        dataDir: "/tmp/cogcoin-bitcoin",
      }),
      error: null,
    }),
    createBitcoinRpcClient: () => ({
      async getBlockchainInfo() {
        return {
          chain: "main",
          blocks: 910_000,
          headers: 910_005,
          bestblockhash: "aa".repeat(32),
          pruned: false,
          verificationprogress: 0.9999,
          initialblockdownload: false,
        };
      },
      async getNetworkInfo() {
        return {
          networkactive: true,
          connections: 8,
          connections_in: 3,
          connections_out: 5,
        };
      },
    }) as never,
  });

  assert.equal(code, 0);
  const output = stdout.toString();
  assert.match(output, /^\n⛭ Bitcoin Status ⛭\n\nPaths\n✓ Bitcoin datadir: \/tmp\/cogcoin-bitcoin\n✓ Wallet root: wallet-root-services\n✓ Wallet root source: wallet-state/u);
  assert.match(output, /\n\nManaged Service\n✓ Compatibility: compatible\n✓ Service state: ready/u);
  assert.match(output, /\n\nBitcoin Node\n✓ Best height: 910000\n✓ Headers: 910005\n✓ Best hash: a{64}/u);
  assert.doesNotMatch(output, /\n\nNext step:/u);
  assert.doesNotMatch(output, /Recommended next step:/u);
});

test("bitcoin status places unreachable recommendation only at the bottom", async () => {
  const stdout = new MemoryStream();

  const code = await runCli(["bitcoin", "status"], {
    stdout,
    stderr: new MemoryStream(),
    resolveDefaultBitcoindDataDir: () => "/tmp/cogcoin-bitcoin",
    resolveDefaultClientDatabasePath: () => {
      throw new Error("client db path should not be resolved");
    },
    resolveWalletRuntimePaths: () => createTempWalletPaths("/tmp/cogcoin-cli-service"),
    loadRawWalletStateEnvelope: async () => createWalletStateEnvelopeStub("wallet-root-services"),
    probeManagedBitcoindService: async () => ({
      compatibility: "unreachable",
      status: null,
      error: null,
    }),
    createBitcoinRpcClient: () => {
      throw new Error("rpc should not be created when the service is unreachable");
    },
  });

  assert.equal(code, 0);
  const output = stdout.toString();
  assert.match(output, /^\n⛭ Bitcoin Status ⛭/u);
  assert.match(output, /\n\nManaged Service\n✗ Compatibility: unreachable\n✗ Service state: unavailable/u);
  assert.match(output, /\n\nBitcoin Node\n✗ Node state: unavailable/u);
  assert.match(output, /\n\nNext step: Run `cogcoin bitcoin start` to start the managed Bitcoin service\.$/u);
  assert.doesNotMatch(output, /Recommended next step:/u);
});

test("indexer status reads stale status files without resolving the client db path", async () => {
  const stdout = new MemoryStream();

  const code = await runCli(["indexer", "status"], {
    stdout,
    stderr: new MemoryStream(),
    resolveDefaultBitcoindDataDir: () => "/tmp/cogcoin-bitcoin",
    resolveDefaultClientDatabasePath: () => {
      throw new Error("client db path should not be resolved");
    },
    resolveWalletRuntimePaths: () => createTempWalletPaths("/tmp/cogcoin-cli-service"),
    loadWalletState: async () => {
      throw new Error("wallet state unavailable");
    },
    loadUnlockSession: async () => {
      throw new Error("unlock session unavailable");
    },
    loadWalletExplicitLock: async () => null,
    probeManagedBitcoindService: async () => ({
      compatibility: "unreachable",
      status: null,
      error: null,
    }),
    probeIndexerDaemon: async () => ({
      compatibility: "unreachable",
      status: null,
      client: null,
      error: null,
    }),
    readObservedIndexerDaemonStatus: async () => createIndexerDaemonStatus("wallet-root-uninitialized", {
      state: "failed",
      lastError: "stale_status_file",
    }),
  });

  assert.equal(code, 0);
  const output = stdout.toString();
  assert.match(output, /^\n⛭ Indexer Status ⛭\n\nPaths\n✓ Bitcoin datadir: \/tmp\/cogcoin-bitcoin\n✓ Wallet root: wallet-root-uninitialized\n✓ Wallet root source: default-uninitialized/u);
  assert.match(output, /\n\nManaged Service\n✗ Compatibility: unreachable\n✗ Observed source: status-file\n✗ Daemon state: failed/u);
  assert.match(output, /\n\nIndexer State\n✗ Core best height: 123\n✗ Core best hash: (?:03){32}\n✗ Applied tip height: 123/u);
  assert.match(output, /\n\nNext step: Run `cogcoin indexer start` to start the managed Cogcoin indexer\.$/u);
  assert.doesNotMatch(output, /Recommended next step:/u);
});

test("indexer status renders sectioned healthy text output without a next step", async () => {
  const stdout = new MemoryStream();
  const walletRootId = "wallet-root-services";

  const code = await runCli(["indexer", "status"], {
    stdout,
    stderr: new MemoryStream(),
    resolveDefaultBitcoindDataDir: () => "/tmp/cogcoin-bitcoin",
    resolveDefaultClientDatabasePath: () => {
      throw new Error("client db path should not be resolved");
    },
    resolveWalletRuntimePaths: () => createTempWalletPaths("/tmp/cogcoin-cli-service"),
    loadRawWalletStateEnvelope: async () => createWalletStateEnvelopeStub(walletRootId),
    probeIndexerDaemon: async () => ({
      compatibility: "compatible",
      status: createIndexerDaemonStatus(walletRootId, {
        coreBestHeight: 910_000,
        appliedTipHeight: 910_000,
        snapshotSeq: "77",
      }),
      client: null,
      error: null,
    }),
    readObservedIndexerDaemonStatus: async () => {
      throw new Error("stale status file should not be consulted when probe succeeds");
    },
  });

  assert.equal(code, 0);
  const output = stdout.toString();
  assert.match(output, /^\n⛭ Indexer Status ⛭\n\nPaths\n✓ Bitcoin datadir: \/tmp\/cogcoin-bitcoin\n✓ Wallet root: wallet-root-services\n✓ Wallet root source: wallet-state/u);
  assert.match(output, /\n\nManaged Service\n✓ Compatibility: compatible\n✓ Observed source: probe\n✓ Daemon state: synced/u);
  assert.match(output, /\n\nIndexer State\n✓ Core best height: 910000\n✓ Core best hash: (?:03){32}\n✓ Applied tip height: 910000/u);
  assert.doesNotMatch(output, /\n\nNext step:/u);
  assert.doesNotMatch(output, /Recommended next step:/u);
});

test("bitcoin start only starts bitcoind and does not resolve the client db path", async () => {
  const stdout = new MemoryStream();
  let attached = false;

  const code = await runCli(["bitcoin", "start", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    resolveDefaultBitcoindDataDir: () => "/tmp/cogcoin-bitcoin",
    resolveDefaultClientDatabasePath: () => {
      throw new Error("client db path should not be resolved");
    },
    resolveWalletRuntimePaths: () => createTempWalletPaths("/tmp/cogcoin-cli-service"),
    loadRawWalletStateEnvelope: async () => createWalletStateEnvelopeStub("wallet-root-services"),
    probeManagedBitcoindService: async () => ({
      compatibility: "unreachable",
      status: null,
      error: null,
    }),
    attachManagedBitcoindService: async () => {
      attached = true;
      return {
        rpc: { url: "http://127.0.0.1:8332", cookieFile: "/tmp/.cookie", port: 8332 },
        zmq: { endpoint: "tcp://127.0.0.1:28332", topic: "hashblock", port: 28332, pollIntervalMs: 15_000 },
        pid: 4321,
        expectedChain: "main",
        startHeight: 0,
        dataDir: "/tmp/cogcoin-bitcoin",
        walletRootId: "wallet-root-services",
        runtimeRoot: "/tmp/runtime/wallet-root-services",
        async validate() {},
        async refreshServiceStatus() {
          return createBitcoindServiceStatus("wallet-root-services");
        },
        async stop() {},
      };
    },
    attachIndexerDaemon: async () => {
      throw new Error("indexer should not start during bitcoin start");
    },
  });

  assert.equal(code, 0);
  assert.equal(attached, true);
  const envelope = parseJsonEnvelope(stdout) as { schema: string; data: { bitcoind: { status: string } } };
  assert.equal(envelope.schema, "cogcoin/bitcoin-start/v1");
  assert.equal(envelope.data.bitcoind.status, "started");
});

test("indexer start resolves the client db path and auto-starts bitcoind", async () => {
  const stdout = new MemoryStream();
  let ensuredPath: string | null = null;
  let attachedBitcoind = false;
  let attachedIndexer = false;

  const code = await runCli(["indexer", "start", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    resolveDefaultBitcoindDataDir: () => "/tmp/cogcoin-bitcoin",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin-client/client.sqlite",
    ensureDirectory: async (path) => {
      ensuredPath = path;
    },
    resolveWalletRuntimePaths: () => createTempWalletPaths("/tmp/cogcoin-cli-service"),
    loadRawWalletStateEnvelope: async () => createWalletStateEnvelopeStub("wallet-root-services"),
    probeManagedBitcoindService: async () => ({
      compatibility: "unreachable",
      status: null,
      error: null,
    }),
    attachManagedBitcoindService: async () => {
      attachedBitcoind = true;
      return {
        rpc: { url: "http://127.0.0.1:8332", cookieFile: "/tmp/.cookie", port: 8332 },
        zmq: { endpoint: "tcp://127.0.0.1:28332", topic: "hashblock", port: 28332, pollIntervalMs: 15_000 },
        pid: 4321,
        expectedChain: "main",
        startHeight: 0,
        dataDir: "/tmp/cogcoin-bitcoin",
        walletRootId: "wallet-root-services",
        runtimeRoot: "/tmp/runtime/wallet-root-services",
        async validate() {},
        async refreshServiceStatus() {
          return createBitcoindServiceStatus("wallet-root-services");
        },
        async stop() {},
      };
    },
    probeIndexerDaemon: async () => ({
      compatibility: "unreachable",
      status: null,
      client: null,
      error: null,
    }),
    attachIndexerDaemon: async ({ databasePath }) => {
      attachedIndexer = true;
      assert.equal(databasePath, "/tmp/cogcoin-client/client.sqlite");
      return {
        async getStatus() {
          return createIndexerDaemonStatus("wallet-root-services");
        },
        async openSnapshot() {
          throw new Error("not used");
        },
        async readSnapshot() {
          throw new Error("not used");
        },
        async closeSnapshot() {},
        async close() {},
      };
    },
  });

  assert.equal(code, 0);
  assert.equal(ensuredPath, "/tmp/cogcoin-client");
  assert.equal(attachedBitcoind, true);
  assert.equal(attachedIndexer, true);
  const envelope = parseJsonEnvelope(stdout) as {
    schema: string;
    data: { bitcoind: { status: string }; indexer: { status: string } };
  };
  assert.equal(envelope.schema, "cogcoin/indexer-start/v1");
  assert.equal(envelope.data.bitcoind.status, "started");
  assert.equal(envelope.data.indexer.status, "started");
});

test("bitcoin stop stops the paired indexer and managed bitcoind", async () => {
  const stdout = new MemoryStream();
  const calls: string[] = [];

  const code = await runCli(["bitcoin", "stop", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    resolveDefaultBitcoindDataDir: () => "/tmp/cogcoin-bitcoin",
    resolveWalletRuntimePaths: () => createTempWalletPaths("/tmp/cogcoin-cli-service"),
    loadRawWalletStateEnvelope: async () => createWalletStateEnvelopeStub("wallet-root-services"),
    stopIndexerDaemonService: async () => {
      calls.push("indexer");
      return {
        status: "stopped",
        walletRootId: "wallet-root-services",
      };
    },
    stopManagedBitcoindService: async () => {
      calls.push("bitcoind");
      return {
        status: "stopped",
        walletRootId: "wallet-root-services",
      };
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, ["indexer", "bitcoind"]);
  const envelope = parseJsonEnvelope(stdout) as {
    schema: string;
    data: { bitcoind: { status: string }; indexer: { status: string } };
  };
  assert.equal(envelope.schema, "cogcoin/bitcoin-stop/v1");
  assert.equal(envelope.data.indexer.status, "stopped");
  assert.equal(envelope.data.bitcoind.status, "stopped");
});

test("indexer stop only stops the managed indexer", async () => {
  const stdout = new MemoryStream();
  let indexerStopped = false;

  const code = await runCli(["indexer", "stop", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    resolveDefaultBitcoindDataDir: () => "/tmp/cogcoin-bitcoin",
    resolveWalletRuntimePaths: () => createTempWalletPaths("/tmp/cogcoin-cli-service"),
    loadRawWalletStateEnvelope: async () => createWalletStateEnvelopeStub("wallet-root-services"),
    stopIndexerDaemonService: async () => {
      indexerStopped = true;
      return {
        status: "stopped",
        walletRootId: "wallet-root-services",
      };
    },
    stopManagedBitcoindService: async () => {
      throw new Error("bitcoind should not stop during indexer stop");
    },
  });

  assert.equal(code, 0);
  assert.equal(indexerStopped, true);
  const envelope = parseJsonEnvelope(stdout) as { schema: string; data: { indexer: { status: string } } };
  assert.equal(envelope.schema, "cogcoin/indexer-stop/v1");
  assert.equal(envelope.data.indexer.status, "stopped");
});

test("wallet admin commands dispatch through the lifecycle hooks", async () => {
  const stdout = new MemoryStream();
  const calls: string[] = [];
  const createPrompter = () => ({
    isInteractive: true,
    writeLine() {},
    async prompt() {
      return "";
    },
    async promptHidden() {
      return "";
    },
  });

  const initCode = await runCli(["init"], {
    stdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    initializeWallet: async () => {
      calls.push("init");
      return {
        walletRootId: "wallet-root-test",
        fundingAddress: "bc1qfundingidentity0000000000000000000000000",
        unlockUntilUnixMs: 1_700_000_900_000,
        state: createWalletState(),
      };
    },
    restoreWalletFromMnemonic: async () => {
      throw new Error("unreachable");
    },
    exportWallet: async () => {
      throw new Error("unreachable");
    },
    importWallet: async () => {
      throw new Error("unreachable");
    },
    unlockWallet: async () => {
      throw new Error("unreachable");
    },
    lockWallet: async () => {
      throw new Error("unreachable");
    },
    repairWallet: async () => {
      throw new Error("unreachable");
    },
  });

  const restoreCode = await runCli(["restore"], {
    stdout: new MemoryStream(),
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    initializeWallet: async () => {
      throw new Error("unreachable");
    },
    restoreWalletFromMnemonic: async () => {
      calls.push("restore");
      return {
        walletRootId: "wallet-root-restored",
        fundingAddress: "bc1qfundingidentity0000000000000000000000000",
        unlockUntilUnixMs: 1_700_000_900_000,
        state: createWalletState({
          walletRootId: "wallet-root-restored",
        }),
      };
    },
    exportWallet: async () => {
      throw new Error("unreachable");
    },
    importWallet: async () => {
      throw new Error("unreachable");
    },
    unlockWallet: async () => {
      throw new Error("unreachable");
    },
    lockWallet: async () => {
      throw new Error("unreachable");
    },
    repairWallet: async () => {
      throw new Error("unreachable");
    },
  });

  const unlockCode = await runCli(["unlock", "--for", "2h"], {
    stdout: new MemoryStream(),
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    initializeWallet: async () => {
      throw new Error("unreachable");
    },
    restoreWalletFromMnemonic: async () => {
      throw new Error("unreachable");
    },
    exportWallet: async () => {
      throw new Error("unreachable");
    },
    importWallet: async () => {
      throw new Error("unreachable");
    },
    unlockWallet: async () => {
      calls.push("unlock");
      return {
        unlockUntilUnixMs: 1_700_001_800_000,
        state: createWalletState(),
        source: "primary",
      };
    },
    lockWallet: async () => {
      throw new Error("unreachable");
    },
    repairWallet: async () => {
      throw new Error("unreachable");
    },
  });

  const lockCode = await runCli(["wallet", "lock"], {
    stdout: new MemoryStream(),
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    initializeWallet: async () => {
      throw new Error("unreachable");
    },
    restoreWalletFromMnemonic: async () => {
      throw new Error("unreachable");
    },
    exportWallet: async () => {
      throw new Error("unreachable");
    },
    importWallet: async () => {
      throw new Error("unreachable");
    },
    unlockWallet: async () => {
      throw new Error("unreachable");
    },
    lockWallet: async () => {
      calls.push("lock");
      return {
        walletRootId: "wallet-root-test",
        coreLocked: true,
      };
    },
    repairWallet: async () => {
      throw new Error("unreachable");
    },
  });

  const exportCode = await runCli(["wallet", "export", "/tmp/archive.cogwallet"], {
    stdout: new MemoryStream(),
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    initializeWallet: async () => {
      throw new Error("unreachable");
    },
    restoreWalletFromMnemonic: async () => {
      throw new Error("unreachable");
    },
    exportWallet: async () => {
      calls.push("export");
      return {
        archivePath: "/tmp/archive.cogwallet",
        walletRootId: "wallet-root-test",
      };
    },
    importWallet: async () => {
      throw new Error("unreachable");
    },
    unlockWallet: async () => {
      throw new Error("unreachable");
    },
    lockWallet: async () => {
      throw new Error("unreachable");
    },
    repairWallet: async () => {
      throw new Error("unreachable");
    },
  });

  const importCode = await runCli(["wallet", "import", "/tmp/archive.cogwallet"], {
    stdout: new MemoryStream(),
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    initializeWallet: async () => {
      throw new Error("unreachable");
    },
    restoreWalletFromMnemonic: async () => {
      throw new Error("unreachable");
    },
    exportWallet: async () => {
      throw new Error("unreachable");
    },
    importWallet: async () => {
      calls.push("import");
      return {
        archivePath: "/tmp/archive.cogwallet",
        walletRootId: "wallet-root-test",
        fundingAddress: "bc1qfundingidentity0000000000000000000000000",
        unlockUntilUnixMs: 1_700_000_900_000,
        state: createWalletState(),
      };
    },
    unlockWallet: async () => {
      throw new Error("unreachable");
    },
    lockWallet: async () => {
      throw new Error("unreachable");
    },
    repairWallet: async () => {
      throw new Error("unreachable");
    },
  });

  const repairCode = await runCli(["repair", "--yes"], {
    stdout: new MemoryStream(),
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    initializeWallet: async () => {
      throw new Error("unreachable");
    },
    restoreWalletFromMnemonic: async () => {
      throw new Error("unreachable");
    },
    exportWallet: async () => {
      throw new Error("unreachable");
    },
    importWallet: async () => {
      throw new Error("unreachable");
    },
    unlockWallet: async () => {
      throw new Error("unreachable");
    },
    lockWallet: async () => {
      throw new Error("unreachable");
    },
    repairWallet: async () => {
      calls.push("repair");
      return {
        walletRootId: "wallet-root-test",
        recoveredFromBackup: true,
        recreatedManagedCoreWallet: false,
        bitcoindServiceAction: "none",
        bitcoindCompatibilityIssue: "none",
        managedCoreReplicaAction: "none",
        bitcoindPostRepairHealth: "ready",
        resetIndexerDatabase: true,
        indexerDaemonAction: "restarted-compatible-daemon",
        indexerCompatibilityIssue: "none",
        indexerPostRepairHealth: "catching-up",
        miningPreRepairRunMode: "stopped",
        miningResumeAction: "none",
        miningPostRepairRunMode: "stopped",
        miningResumeError: null,
        note: "Indexer artifacts were reset and may still be catching up.",
      };
    },
  });

  assert.equal(initCode, 0);
  assert.equal(restoreCode, 0);
  assert.equal(unlockCode, 0);
  assert.equal(lockCode, 0);
  assert.equal(exportCode, 0);
  assert.equal(importCode, 0);
  assert.equal(repairCode, 0);
  assert.deepEqual(calls, ["init", "restore", "unlock", "lock", "export", "import", "repair"]);
  assert.match(stdout.toString(), /Wallet initialized/);
  assert.match(stdout.toString(), /Quickstart: Fund this wallet with about 0\.0015 BTC/);
  assert.match(stdout.toString(), /Next step: cogcoin sync/);
  assert.match(stdout.toString(), /Next step: cogcoin address/);
});

test("mine runtime commands dispatch through the mining runner hooks", async () => {
  const calls: string[] = [];
  const foregroundStderr = new MemoryStream();
  const createPrompter = () => ({
    isInteractive: true,
    writeLine() {},
    async prompt() {
      return "";
    },
  });

  const foregroundCode = await runCli(["mine"], {
    stdout: new MemoryStream(),
    stderr: foregroundStderr,
    walletSecretProvider: {} as never,
    createPrompter,
    runForegroundMining: async (options) => {
      calls.push("mine");
      assert.equal(options.prompter.isInteractive, true);
      assert.equal(options.signal?.aborted, false);
      assert.equal(options.progressOutput, "auto");
      assert.equal(options.stderr, foregroundStderr);
    },
    startBackgroundMining: async () => {
      throw new Error("unreachable");
    },
    stopBackgroundMining: async () => {
      throw new Error("unreachable");
    },
  });

  const startStdout = new MemoryStream();
  const startCode = await runCli(["mine", "start"], {
    stdout: startStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    runForegroundMining: async () => {
      throw new Error("unreachable");
    },
    startBackgroundMining: async () => {
      calls.push("mine-start");
      return {
        started: true,
        snapshot: createMiningView({
          runtime: {
            runMode: "background",
            backgroundWorkerPid: 4242,
            backgroundWorkerHealth: "healthy",
          },
        }).runtime,
      };
    },
    stopBackgroundMining: async () => {
      throw new Error("unreachable");
    },
  });

  const stopStdout = new MemoryStream();
  const stopCode = await runCli(["mine", "stop"], {
    stdout: stopStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    runForegroundMining: async () => {
      throw new Error("unreachable");
    },
    startBackgroundMining: async () => {
      throw new Error("unreachable");
    },
    stopBackgroundMining: async () => {
      calls.push("mine-stop");
      return createMiningView({
        runtime: {
          runMode: "stopped",
          note: "Background mining stopped.",
        },
      }).runtime;
    },
  });

  assert.equal(foregroundCode, 0);
  assert.equal(startCode, 0);
  assert.equal(stopCode, 0);
  assert.match(startStdout.toString(), /Started background mining/);
  assert.match(startStdout.toString(), /Worker pid: 4242/);
  assert.match(stopStdout.toString(), /Background mining stopped/);
  assert.match(stopStdout.toString(), /Next step: cogcoin mine log/);
  assert.deepEqual(calls, ["mine", "mine-start", "mine-stop"]);
});

test("register dispatches through the wallet mutation hook", async () => {
  const stdout = new MemoryStream();
  const calls: string[] = [];
  const code = await runCli(["register", "weatherbot", "--force-race", "--from", "domain:alpha"], {
    stdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter: () => ({
      isInteractive: true,
      writeLine() {},
      async prompt() {
        return "weatherbot";
      },
    }),
    registerDomain: async (options) => {
      calls.push(`${options.domainName}:${options.forceRace ? "force" : "safe"}:${options.fromIdentity}`);
      return {
        domainName: options.domainName,
        registerKind: "root",
        parentDomainName: null,
        senderSelector: "id:1",
        senderLocalIndex: 1,
        senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
        senderAddress: "bc1qalphaowner0000000000000000000000000000",
        economicEffectKind: "treasury-payment",
        economicEffectAmount: 100000n,
        resolved: {
          path: "root",
          parentDomainName: null,
          sender: {
            selector: "id:1",
            localIndex: 1,
            scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
            address: "bc1qalphaowner0000000000000000000000000000",
          },
          economicEffect: {
            kind: "treasury-payment",
            amount: 100000n,
          },
        },
        txid: "55".repeat(32),
        status: "live",
        reusedExisting: false,
      };
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, ["weatherbot:force:domain:alpha"]);
  assert.match(stdout.toString(), /Registration submitted/);
  assert.match(stdout.toString(), /Path: root/);
  assert.match(stdout.toString(), /Sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(stdout.toString(), /Economic effect: send 100000 sats to the Cogcoin treasury/);
  assert.match(stdout.toString(), /Next step: cogcoin show weatherbot/);
  assert.match(stdout.toString(), /Next step: cogcoin anchor weatherbot once it confirms/);
});

test("subdomain registration keeps only the show follow-through", async () => {
  const stdout = new MemoryStream();
  const code = await runCli(["register", "alpha-child"], {
    stdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter: () => ({
      isInteractive: true,
      writeLine() {},
      async prompt() {
        return "yes";
      },
    }),
    registerDomain: async () => ({
      domainName: "alpha-child",
      registerKind: "subdomain",
      parentDomainName: "alpha",
      senderSelector: "id:1",
      senderLocalIndex: 1,
      senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      senderAddress: "bc1qalphaowner0000000000000000000000000000",
      economicEffectKind: "cog-burn",
      economicEffectAmount: 100n,
      resolved: {
        path: "subdomain",
        parentDomainName: "alpha",
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        economicEffect: {
          kind: "cog-burn",
          amount: 100n,
        },
      },
      txid: "55".repeat(32),
      status: "live",
      reusedExisting: false,
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.toString(), /Parent: alpha/);
  assert.match(stdout.toString(), /Economic effect: burn 0\.00000100 COG from the parent-owner identity/);
  assert.match(stdout.toString(), /Next step: cogcoin show alpha-child/);
  assert.doesNotMatch(stdout.toString(), /Next step: cogcoin anchor alpha-child/);
});

test("anchor dispatches through the wallet mutation hook", async () => {
  const stdout = new MemoryStream();
  const calls: string[] = [];
  const code = await runCli(["anchor", "weatherbot", "--message", "hello"], {
    stdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter: () => ({
      isInteractive: true,
      writeLine() {},
      async prompt() {
        return "weatherbot";
      },
    }),
    anchorDomain: async (options) => {
      calls.push(`${options.domainName}:${options.foundingMessageText}`);
      return {
        domainName: options.domainName,
        txid: "55".repeat(32),
        tx1Txid: "66".repeat(32),
        tx2Txid: "77".repeat(32),
        dedicatedIndex: 3,
        status: "live",
        reusedExisting: false,
      };
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(calls, ["weatherbot:hello"]);
  assert.match(stdout.toString(), /Anchor family submitted/);
  assert.match(stdout.toString(), /Dedicated index: 3/);
  assert.match(stdout.toString(), /Next step: cogcoin show weatherbot/);
  assert.match(stdout.toString(), /Next step: cogcoin mine$/m);
  assert.match(stdout.toString(), /Next step: cogcoin mine start/);
});

test("subdomain anchors keep the show hint without mining follow-through", async () => {
  const stdout = new MemoryStream();
  const code = await runCli(["anchor", "alpha-child"], {
    stdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter: () => ({
      isInteractive: true,
      writeLine() {},
      async prompt() {
        return "alpha-child";
      },
    }),
    anchorDomain: async (options) => ({
      domainName: options.domainName,
      txid: "55".repeat(32),
      tx1Txid: "66".repeat(32),
      tx2Txid: "77".repeat(32),
      dedicatedIndex: 3,
      status: "live",
      reusedExisting: false,
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.toString(), /Next step: cogcoin show alpha-child/);
  assert.doesNotMatch(stdout.toString(), /Next step: cogcoin mine$/m);
  assert.doesNotMatch(stdout.toString(), /Next step: cogcoin mine start/);
});

test("mining admin text output includes the shared workflow next steps", async () => {
  const hooksStdout = new MemoryStream();
  const hooksCode = await runCli(["hooks", "enable", "mining"], {
    stdout: hooksStdout,
    stderr: new MemoryStream(),
    stdin: new MemoryStream(true) as never,
    walletSecretProvider: {} as never,
    createPrompter: () => ({
      isInteractive: true,
      writeLine() {},
      async prompt() {
        return "TRUST CUSTOM MINING HOOKS";
      },
    }),
    enableMiningHooks: async () => createMiningView({
      hook: {
        mode: "custom",
        validationState: "validated",
        validationError: null,
      },
      provider: {
        configured: true,
        provider: "openai",
        status: "ready",
      },
    }),
  });

  const setupStdout = new MemoryStream();
  const setupCode = await runCli(["mine", "setup"], {
    stdout: setupStdout,
    stderr: new MemoryStream(),
    stdin: new MemoryStream(true) as never,
    walletSecretProvider: {} as never,
    createPrompter: () => ({
      isInteractive: true,
      writeLine() {},
      async prompt() {
        return "openai";
      },
    }),
    setupBuiltInMining: async () => createMiningView({
      provider: {
        configured: true,
        provider: "openai",
        status: "ready",
      },
    }),
  });

  assert.equal(hooksCode, 0);
  assert.equal(setupCode, 0);
  assert.match(hooksStdout.toString(), /Custom mining hook enabled/);
  assert.match(hooksStdout.toString(), /Next step: cogcoin mine$/m);
  assert.match(hooksStdout.toString(), /Next step: cogcoin mine start/);
  assert.match(setupStdout.toString(), /Built-in mining provider configured/);
  assert.match(setupStdout.toString(), /Next step: cogcoin mine$/m);
  assert.match(setupStdout.toString(), /Next step: cogcoin mine start/);
});

test("transfer, sell, unsell, and buy dispatch through the wallet mutation hooks", async () => {
  const calls: string[] = [];
  const createPrompter = () => ({
    isInteractive: true,
    writeLine() {},
    async prompt() {
      return "yes";
    },
  });

  const transferOut = new MemoryStream();
  const transferCode = await runCli(["transfer", "alpha", "--to", "spk:00141111111111111111111111111111111111111111"], {
    stdout: transferOut,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    transferDomain: async (options) => {
      calls.push(`transfer:${options.domainName}:${options.target}`);
      return {
        kind: "transfer",
        domainName: options.domainName,
        txid: "77".repeat(32),
        status: "live",
        reusedExisting: false,
        recipientScriptPubKeyHex: "00141111111111111111111111111111111111111111",
        resolved: {
          sender: {
            selector: "id:1",
            localIndex: 1,
            scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
            address: "bc1qalphaowner0000000000000000000000000000",
          },
          recipient: {
            scriptPubKeyHex: "00141111111111111111111111111111111111111111",
            address: "bc1qtransferrecipient0000000000000000000000",
            opaque: false,
          },
          economicEffect: {
            kind: "ownership-transfer",
            clearsListing: true,
          },
        },
      };
    },
  });

  const sellOut = new MemoryStream();
  const sellCode = await runCli(["sell", "alpha", "12.5"], {
    stdout: sellOut,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    sellDomain: async (options) => {
      calls.push(`sell:${options.domainName}:${options.listedPriceCogtoshi.toString()}`);
      return {
        kind: "sell",
        domainName: options.domainName,
        txid: "88".repeat(32),
        status: "live",
        reusedExisting: false,
        listedPriceCogtoshi: options.listedPriceCogtoshi,
        resolved: {
          sender: {
            selector: "id:1",
            localIndex: 1,
            scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
            address: "bc1qalphaowner0000000000000000000000000000",
          },
          economicEffect: {
            kind: "listing-set",
            listedPriceCogtoshi: options.listedPriceCogtoshi.toString(),
          },
        },
      };
    },
  });

  const unsellOut = new MemoryStream();
  const unsellCode = await runCli(["domain", "unsell", "alpha"], {
    stdout: unsellOut,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    sellDomain: async (options) => {
      calls.push(`unsell:${options.domainName}:${options.listedPriceCogtoshi.toString()}`);
      return {
        kind: "sell",
        domainName: options.domainName,
        txid: "99".repeat(32),
        status: "live",
        reusedExisting: false,
        listedPriceCogtoshi: options.listedPriceCogtoshi,
        resolved: {
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
        },
      };
    },
  });

  const buyOut = new MemoryStream();
  const buyCode = await runCli(["domain", "buy", "alpha", "--from", "id:1"], {
    stdout: buyOut,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    buyDomain: async (options) => {
      calls.push(`buy:${options.domainName}:${options.fromIdentity ?? "none"}`);
      return {
        kind: "buy",
        domainName: options.domainName,
        txid: "aa".repeat(32),
        status: "live",
        reusedExisting: false,
        listedPriceCogtoshi: 1_250_000_000n,
        resolvedBuyer: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        resolvedSeller: {
          scriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
          address: "bc1qbetaowner00000000000000000000000000000",
        },
      };
    },
  });

  assert.equal(transferCode, 0);
  assert.equal(sellCode, 0);
  assert.equal(unsellCode, 0);
  assert.equal(buyCode, 0);
  assert.deepEqual(calls, [
    "transfer:alpha:spk:00141111111111111111111111111111111111111111",
    "sell:alpha:1250000000",
    "unsell:alpha:0",
    "buy:alpha:id:1",
  ]);
  assert.match(transferOut.toString(), /Transfer submitted/);
  assert.match(transferOut.toString(), /Sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(transferOut.toString(), /Recipient: bc1qtransferrecipient0000000000000000000000/);
  assert.match(transferOut.toString(), /Economic effect: transfer domain ownership and clear any active listing/);
  assert.match(sellOut.toString(), /Listing submitted/);
  assert.match(sellOut.toString(), /Sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(sellOut.toString(), /Economic effect: set the listing price to 1250000000 cogtoshi in COG state/);
  assert.match(unsellOut.toString(), /Listing cancellation submitted/);
  assert.match(unsellOut.toString(), /Sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(unsellOut.toString(), /Economic effect: clear the active listing in COG state/);
  assert.match(buyOut.toString(), /Purchase submitted/);
  assert.match(buyOut.toString(), /Buyer: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(buyOut.toString(), /Seller: bc1qbetaowner00000000000000000000000000000/);
  assert.match(buyOut.toString(), /Settlement: entirely in COG state; no BTC seller output/);
});

test("domain endpoint, delegate, miner, and canonical dispatch through the wallet mutation hooks", async () => {
  const calls: string[] = [];
  const createPrompter = () => ({
    isInteractive: true,
    writeLine() {},
    async prompt() {
      return "yes";
    },
  });

  const endpointOut = new MemoryStream();
  const endpointCode = await runCli(["domain", "endpoint", "set", "alpha", "--json", "{\"ok\":true}"], {
    stdout: endpointOut,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    setDomainEndpoint: async (options) => {
      calls.push(`endpoint:${options.domainName}:${options.source.kind}`);
      return {
        kind: "endpoint",
        domainName: options.domainName,
        txid: "11".repeat(32),
        status: "live",
        reusedExisting: false,
        endpointValueHex: "aa",
        resolved: {
          sender: {
            selector: "id:1",
            localIndex: 1,
            scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
            address: "bc1qalphaowner0000000000000000000000000000",
          },
          target: null,
          effect: {
            kind: "endpoint-set",
            byteLength: 1,
          },
        },
      };
    },
  });

  const delegateOut = new MemoryStream();
  const delegateCode = await runCli(["domain", "delegate", "set", "alpha", "spk:00141111111111111111111111111111111111111111"], {
    stdout: delegateOut,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    setDomainDelegate: async (options) => {
      calls.push(`delegate:${options.domainName}:${options.target}`);
      return {
        kind: "delegate",
        domainName: options.domainName,
        txid: "22".repeat(32),
        status: "live",
        reusedExisting: false,
        recipientScriptPubKeyHex: "00141111111111111111111111111111111111111111",
        resolved: {
          sender: {
            selector: "id:1",
            localIndex: 1,
            scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
            address: "bc1qalphaowner0000000000000000000000000000",
          },
          target: {
            scriptPubKeyHex: "00141111111111111111111111111111111111111111",
            address: "bc1qdelegate0000000000000000000000000000000",
            opaque: false,
          },
          effect: {
            kind: "delegate-set",
          },
        },
      };
    },
  });

  const minerOut = new MemoryStream();
  const minerCode = await runCli(["domain", "miner", "clear", "alpha"], {
    stdout: minerOut,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    clearDomainMiner: async (options) => {
      calls.push(`miner-clear:${options.domainName}`);
      return {
        kind: "miner",
        domainName: options.domainName,
        txid: "33".repeat(32),
        status: "live",
        reusedExisting: false,
        recipientScriptPubKeyHex: null,
        resolved: {
          sender: {
            selector: "id:1",
            localIndex: 1,
            scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
            address: "bc1qalphaowner0000000000000000000000000000",
          },
          target: null,
          effect: {
            kind: "miner-clear",
          },
        },
      };
    },
  });

  const canonicalOut = new MemoryStream();
  const canonicalCode = await runCli(["domain", "canonical", "alpha"], {
    stdout: canonicalOut,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    setDomainCanonical: async (options) => {
      calls.push(`canonical:${options.domainName}`);
      return {
        kind: "canonical",
        domainName: options.domainName,
        txid: "44".repeat(32),
        status: "live",
        reusedExisting: false,
        resolved: {
          sender: {
            selector: "id:1",
            localIndex: 1,
            scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
            address: "bc1qalphaowner0000000000000000000000000000",
          },
          target: null,
          effect: {
            kind: "canonicalize-owner",
          },
        },
      };
    },
  });

  assert.equal(endpointCode, 0);
  assert.equal(delegateCode, 0);
  assert.equal(minerCode, 0);
  assert.equal(canonicalCode, 0);
  assert.deepEqual(calls, [
    "endpoint:alpha:json",
    "delegate:alpha:spk:00141111111111111111111111111111111111111111",
    "miner-clear:alpha",
    "canonical:alpha",
  ]);
  assert.match(endpointOut.toString(), /Endpoint update submitted/);
  assert.match(endpointOut.toString(), /Sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(endpointOut.toString(), /Payload: 1 bytes/);
  assert.match(endpointOut.toString(), /Effect: set the endpoint payload to 1 bytes/);
  assert.match(delegateOut.toString(), /Delegate update submitted/);
  assert.match(delegateOut.toString(), /Sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(delegateOut.toString(), /Target: bc1qdelegate0000000000000000000000000000000/);
  assert.match(delegateOut.toString(), /Effect: set the delegate target/);
  assert.match(minerOut.toString(), /Miner clear submitted/);
  assert.match(minerOut.toString(), /Sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(minerOut.toString(), /Target: clear/);
  assert.match(minerOut.toString(), /Effect: clear the designated miner target/);
  assert.match(canonicalOut.toString(), /Canonical update submitted/);
  assert.match(canonicalOut.toString(), /Sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(canonicalOut.toString(), /Effect: canonicalize the current anchored owner/);
});

test("field create, set, and clear dispatch through the wallet mutation hooks", async () => {
  const calls: string[] = [];
  const createPrompter = () => ({
    isInteractive: true,
    writeLine() {},
    async prompt() {
      return "yes";
    },
  });

  const createOut = new MemoryStream();
  const createCode = await runCli(["field", "create", "alpha", "tagline", "--permanent", "--text", "hello"], {
    stdout: createOut,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    createField: async (options) => {
      calls.push(`create:${options.domainName}:${options.fieldName}:${options.permanent === true}:${options.source?.kind ?? "none"}`);
      return {
        kind: "field-create",
        domainName: options.domainName,
        fieldName: options.fieldName,
        fieldId: 7,
        txid: "11".repeat(32),
        tx1Txid: "11".repeat(32),
        tx2Txid: "22".repeat(32),
        family: true,
        permanent: true,
        format: 2,
        status: "live",
        reusedExisting: false,
        resolved: {
          sender: {
            selector: "id:1",
            localIndex: 1,
            scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
            address: "bc1qalphaowner0000000000000000000000000000",
          },
          path: "field-reg-plus-data-update-family",
          value: {
            format: 2,
            byteLength: 5,
          },
          effect: {
            kind: "create-and-initialize-field",
            tx1BurnCogtoshi: "100",
            tx2AdditionalBurnCogtoshi: "1",
          },
        },
      };
    },
  });

  const setOut = new MemoryStream();
  const setCode = await runCli(["field", "set", "alpha", "bio", "--format", "raw:7", "--value", "utf8:hello"], {
    stdout: setOut,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    setField: async (options) => {
      calls.push(`set:${options.domainName}:${options.fieldName}:${options.source.kind}`);
      return {
        kind: "field-set",
        domainName: options.domainName,
        fieldName: options.fieldName,
        fieldId: 3,
        txid: "33".repeat(32),
        family: false,
        permanent: false,
        format: 7,
        status: "live",
        reusedExisting: false,
        resolved: {
          sender: {
            selector: "id:1",
            localIndex: 1,
            scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
            address: "bc1qalphaowner0000000000000000000000000000",
          },
          path: "standalone-data-update",
          value: {
            format: 7,
            byteLength: 5,
          },
          effect: {
            kind: "write-field-value",
            burnCogtoshi: "1",
          },
        },
      };
    },
  });

  const clearOut = new MemoryStream();
  const clearCode = await runCli(["field", "clear", "alpha", "bio"], {
    stdout: clearOut,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    clearField: async (options) => {
      calls.push(`clear:${options.domainName}:${options.fieldName}`);
      return {
        kind: "field-clear",
        domainName: options.domainName,
        fieldName: options.fieldName,
        fieldId: 3,
        txid: "44".repeat(32),
        family: false,
        permanent: false,
        format: 0,
        status: "live",
        reusedExisting: false,
        resolved: {
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
        },
      };
    },
  });

  assert.equal(createCode, 0);
  assert.equal(setCode, 0);
  assert.equal(clearCode, 0);
  assert.deepEqual(calls, [
    "create:alpha:tagline:true:text",
    "set:alpha:bio:raw",
    "clear:alpha:bio",
  ]);
  assert.match(createOut.toString(), /Field create\+write family submitted/);
  assert.match(createOut.toString(), /Sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(createOut.toString(), /Path: field-reg-plus-data-update-family/);
  assert.match(createOut.toString(), /Value: format 2, 5 bytes/);
  assert.match(createOut.toString(), /Effect: burn 100 cogtoshi in Tx1 and 1 additional cogtoshi in Tx2/);
  assert.match(setOut.toString(), /Field update submitted/);
  assert.match(setOut.toString(), /Sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(setOut.toString(), /Value: format 7, 5 bytes/);
  assert.match(setOut.toString(), /Effect: burn 1 cogtoshi to write the field value/);
  assert.match(clearOut.toString(), /Field clear submitted/);
  assert.match(clearOut.toString(), /Sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(clearOut.toString(), /Effect: clear the field value with no additional COG burn/);
});

test("send, claim, reclaim, and cog lock dispatch through the wallet mutation hooks", async () => {
  const calls: string[] = [];
  const createPrompter = () => ({
    isInteractive: true,
    writeLine() {},
    async prompt() {
      return "yes";
    },
  });

  const sendOut = new MemoryStream();
  const sendCode = await runCli(["send", "1.5", "--to", "spk:00141111111111111111111111111111111111111111", "--from", "id:1"], {
    stdout: sendOut,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    sendCog: async (options) => {
      calls.push(`send:${options.amountCogtoshi.toString()}:${options.target}:${options.fromIdentity}`);
      return {
        kind: "send",
        txid: "ab".repeat(32),
        status: "live",
        reusedExisting: false,
        amountCogtoshi: options.amountCogtoshi,
        recipientScriptPubKeyHex: "00141111111111111111111111111111111111111111",
        resolved: {
          sender: {
            selector: "id:1",
            localIndex: 1,
            scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
            address: "bc1qalphaowner0000000000000000000000000000",
          },
          claimPath: null,
        },
      };
    },
  });

  const lockOut = new MemoryStream();
  const lockCode = await runCli(["cog", "lock", "2", "--to-domain", "alpha", "--until-height", "500", "--condition", "22".repeat(32)], {
    stdout: lockOut,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    lockCogToDomain: async (options) => {
      calls.push(`lock:${options.amountCogtoshi.toString()}:${options.recipientDomainName}:${options.timeoutHeight}`);
      return {
        kind: "lock",
        txid: "bc".repeat(32),
        status: "live",
        reusedExisting: false,
        amountCogtoshi: options.amountCogtoshi,
        recipientDomainName: options.recipientDomainName,
        resolved: {
          sender: {
            selector: "id:1",
            localIndex: 1,
            scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
            address: "bc1qalphaowner0000000000000000000000000000",
          },
          claimPath: null,
        },
      };
    },
  });

  const claimOut = new MemoryStream();
  const claimCode = await runCli(["claim", "7", "--preimage", "33".repeat(32)], {
    stdout: claimOut,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    claimCogLock: async (options) => {
      calls.push(`claim:${options.lockId}:${options.preimageHex}`);
      return {
        kind: "claim",
        txid: "cd".repeat(32),
        status: "live",
        reusedExisting: false,
        amountCogtoshi: 12n,
        lockId: options.lockId,
        resolved: {
          sender: {
            selector: "id:1",
            localIndex: 1,
            scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
            address: "bc1qalphaowner0000000000000000000000000000",
          },
          claimPath: "recipient-claim",
        },
      };
    },
  });

  const reclaimOut = new MemoryStream();
  const reclaimCode = await runCli(["cog", "reclaim", "8"], {
    stdout: reclaimOut,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    reclaimCogLock: async (options) => {
      calls.push(`reclaim:${options.lockId}`);
      return {
        kind: "claim",
        txid: "de".repeat(32),
        status: "live",
        reusedExisting: false,
        amountCogtoshi: 10n,
        lockId: options.lockId,
        resolved: {
          sender: {
            selector: "id:1",
            localIndex: 1,
            scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
            address: "bc1qalphaowner0000000000000000000000000000",
          },
          claimPath: "timeout-reclaim",
        },
      };
    },
  });

  assert.equal(sendCode, 0);
  assert.equal(lockCode, 0);
  assert.equal(claimCode, 0);
  assert.equal(reclaimCode, 0);
  assert.deepEqual(calls, [
    "send:150000000:spk:00141111111111111111111111111111111111111111:id:1",
    "lock:200000000:alpha:500",
    `claim:7:${"33".repeat(32)}`,
    "reclaim:8",
  ]);
  assert.match(sendOut.toString(), /COG transfer submitted/);
  assert.match(sendOut.toString(), /Sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(lockOut.toString(), /COG lock submitted/);
  assert.match(lockOut.toString(), /Sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(claimOut.toString(), /Lock claim submitted/);
  assert.match(claimOut.toString(), /Path: recipient-claim/);
  assert.match(claimOut.toString(), /Sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(reclaimOut.toString(), /Lock reclaim submitted/);
  assert.match(reclaimOut.toString(), /Path: timeout-reclaim/);
  assert.match(reclaimOut.toString(), /Sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
});

test("rep give and rep revoke dispatch through the wallet mutation hooks", async () => {
  const calls: string[] = [];
  const createPrompter = () => ({
    isInteractive: true,
    writeLine() {},
    async prompt() {
      return "yes";
    },
  });

  const giveOut = new MemoryStream();
  const giveCode = await runCli(["rep", "give", "alpha", "beta", "1.5", "--review", "solid operator"], {
    stdout: giveOut,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    giveReputation: async (options) => {
      calls.push(`give:${options.sourceDomainName}:${options.targetDomainName}:${options.amountCogtoshi.toString()}:${options.reviewText}`);
      return {
        kind: "give",
        sourceDomainName: options.sourceDomainName,
        targetDomainName: options.targetDomainName,
        amountCogtoshi: options.amountCogtoshi,
        txid: "cd".repeat(32),
        status: "live",
        reusedExisting: false,
        reviewIncluded: true,
        resolved: {
          sender: {
            selector: "id:1",
            localIndex: 1,
            scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
            address: "bc1qalphaowner0000000000000000000000000000",
          },
          effect: {
            kind: "give-support",
            burnCogtoshi: options.amountCogtoshi.toString(),
          },
          review: {
            included: true,
            byteLength: 14,
          },
          selfStake: false,
        },
      };
    },
  });

  const revokeOut = new MemoryStream();
  const revokeCode = await runCli(["rep", "revoke", "alpha", "beta", "0.5"], {
    stdout: revokeOut,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createPrompter,
    revokeReputation: async (options) => {
      calls.push(`revoke:${options.sourceDomainName}:${options.targetDomainName}:${options.amountCogtoshi.toString()}:${options.reviewText ?? "none"}`);
      return {
        kind: "revoke",
        sourceDomainName: options.sourceDomainName,
        targetDomainName: options.targetDomainName,
        amountCogtoshi: options.amountCogtoshi,
        txid: "ef".repeat(32),
        status: "live",
        reusedExisting: false,
        reviewIncluded: false,
        resolved: {
          sender: {
            selector: "id:1",
            localIndex: 1,
            scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
            address: "bc1qalphaowner0000000000000000000000000000",
          },
          effect: {
            kind: "revoke-support",
            burnCogtoshi: options.amountCogtoshi.toString(),
          },
          review: {
            included: false,
            byteLength: null,
          },
          selfStake: false,
        },
      };
    },
  });

  assert.equal(giveCode, 0);
  assert.equal(revokeCode, 0);
  assert.deepEqual(calls, [
    "give:alpha:beta:150000000:solid operator",
    "revoke:alpha:beta:50000000:none",
  ]);
  assert.match(giveOut.toString(), /Reputation support submitted/);
  assert.match(giveOut.toString(), /Sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(giveOut.toString(), /Review: included \(14 bytes\)/);
  assert.match(giveOut.toString(), /Effect: burn 150000000 cogtoshi to publish support/);
  assert.match(revokeOut.toString(), /Reputation revoke submitted/);
  assert.match(revokeOut.toString(), /Sender: id:1 \(bc1qalphaowner0000000000000000000000000000\)/);
  assert.match(revokeOut.toString(), /Review: none/);
  assert.match(revokeOut.toString(), /Effect: revoke visible support with no refund of the previously burned 50000000 cogtoshi/);
});

test("rep give and rep revoke json output include additive resolved parity details", async () => {
  const giveStdout = new MemoryStream();
  const giveCode = await runCli(["rep", "give", "alpha", "beta", "1", "--review", "solid operator", "--output", "json"], {
    stdout: giveStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    giveReputation: async () => ({
      kind: "give",
      sourceDomainName: "alpha",
      targetDomainName: "beta",
      amountCogtoshi: 100000000n,
      txid: "ab".repeat(32),
      status: "live",
      reusedExisting: false,
      reviewIncluded: true,
      resolved: {
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        effect: {
          kind: "give-support",
          burnCogtoshi: "100000000",
        },
        review: {
          included: true,
          byteLength: 14,
        },
        selfStake: false,
      },
    }),
  });

  const revokeStdout = new MemoryStream();
  const revokeCode = await runCli(["rep", "revoke", "alpha", "beta", "0.5", "--output", "json"], {
    stdout: revokeStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    revokeReputation: async () => ({
      kind: "revoke",
      sourceDomainName: "alpha",
      targetDomainName: "beta",
      amountCogtoshi: 50000000n,
      txid: "cd".repeat(32),
      status: "live",
      reusedExisting: false,
      reviewIncluded: false,
      resolved: {
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        effect: {
          kind: "revoke-support",
          burnCogtoshi: "50000000",
        },
        review: {
          included: false,
          byteLength: null,
        },
        selfStake: false,
      },
    }),
  });

  assert.equal(giveCode, 0);
  assert.equal(revokeCode, 0);

  const giveEnvelope = parseJsonEnvelope(giveStdout) as {
    schema: string;
    data: {
      intent: { reviewIncluded: boolean };
      resolved: {
        sender: { selector: string };
        effect: { kind: string; burnCogtoshi: string };
        review: { included: boolean; byteLength: number | null };
        selfStake: boolean;
      } | null;
    };
  };
  assert.equal(giveEnvelope.schema, "cogcoin/rep-give/v1");
  assert.equal(giveEnvelope.data.intent.reviewIncluded, true);
  assert.equal(giveEnvelope.data.resolved?.sender.selector, "id:1");
  assert.equal(giveEnvelope.data.resolved?.effect.kind, "give-support");
  assert.equal(giveEnvelope.data.resolved?.effect.burnCogtoshi, "100000000");
  assert.equal(giveEnvelope.data.resolved?.review.included, true);
  assert.equal(giveEnvelope.data.resolved?.review.byteLength, 14);
  assert.equal(giveEnvelope.data.resolved?.selfStake, false);

  const revokeEnvelope = parseJsonEnvelope(revokeStdout) as {
    schema: string;
    data: {
      intent: { reviewIncluded: boolean };
      resolved: {
        sender: { selector: string };
        effect: { kind: string; burnCogtoshi: string };
        review: { included: boolean; byteLength: number | null };
        selfStake: boolean;
      } | null;
    };
  };
  assert.equal(revokeEnvelope.schema, "cogcoin/rep-revoke/v1");
  assert.equal(revokeEnvelope.data.intent.reviewIncluded, false);
  assert.equal(revokeEnvelope.data.resolved?.sender.selector, "id:1");
  assert.equal(revokeEnvelope.data.resolved?.effect.kind, "revoke-support");
  assert.equal(revokeEnvelope.data.resolved?.effect.burnCogtoshi, "50000000");
  assert.equal(revokeEnvelope.data.resolved?.review.included, false);
  assert.equal(revokeEnvelope.data.resolved?.review.byteLength, null);
  assert.equal(revokeEnvelope.data.resolved?.selfStake, false);
});

test("wallet mutations and terminating mining controls emit stable json while foreground mining stays out of scope", async () => {
  const transferStdout = new MemoryStream();
  const transferCode = await runCli(["transfer", "alpha", "--to", "spk:00141111111111111111111111111111111111111111", "--output", "json"], {
    stdout: transferStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    transferDomain: async () => ({
      kind: "transfer",
      domainName: "alpha",
      txid: "77".repeat(32),
      status: "live",
      reusedExisting: false,
      recipientScriptPubKeyHex: "00141111111111111111111111111111111111111111",
      resolved: {
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        recipient: {
          scriptPubKeyHex: "00141111111111111111111111111111111111111111",
          address: null,
          opaque: true,
        },
        economicEffect: {
          kind: "ownership-transfer",
          clearsListing: true,
        },
      },
    }),
  });
  assert.equal(transferCode, 0);
  const transferEnvelope = parseJsonEnvelope(transferStdout) as {
    schema: string;
    command: string;
    data: {
      intent: {
        domainName: string;
        recipientScriptPubKeyHex: string | null;
      };
      resolved: {
        sender: { selector: string; address: string };
        recipient: { scriptPubKeyHex: string; address: string | null; opaque: boolean };
        economicEffect: { kind: string; clearsListing: boolean };
      };
    };
  };
  assert.equal(transferEnvelope.schema, "cogcoin/transfer/v1");
  assert.equal(transferEnvelope.command, "cogcoin transfer alpha");
  assert.equal(transferEnvelope.data.intent.domainName, "alpha");
  assert.equal(transferEnvelope.data.intent.recipientScriptPubKeyHex, "00141111111111111111111111111111111111111111");
  assert.equal(transferEnvelope.data.resolved.sender.selector, "id:1");
  assert.equal(transferEnvelope.data.resolved.sender.address, "bc1qalphaowner0000000000000000000000000000");
  assert.equal(transferEnvelope.data.resolved.recipient.scriptPubKeyHex, "00141111111111111111111111111111111111111111");
  assert.equal(transferEnvelope.data.resolved.recipient.address, null);
  assert.equal(transferEnvelope.data.resolved.recipient.opaque, true);
  assert.equal(transferEnvelope.data.resolved.economicEffect.kind, "ownership-transfer");
  assert.equal(transferEnvelope.data.resolved.economicEffect.clearsListing, true);

  const sellStdout = new MemoryStream();
  const sellCode = await runCli(["sell", "alpha", "12.5", "--output", "json"], {
    stdout: sellStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    sellDomain: async (options) => ({
      kind: "sell",
      domainName: "alpha",
      txid: "88".repeat(32),
      status: "live",
      reusedExisting: false,
      listedPriceCogtoshi: options.listedPriceCogtoshi,
      resolved: {
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        economicEffect: {
          kind: "listing-set",
          listedPriceCogtoshi: options.listedPriceCogtoshi.toString(),
        },
      },
    }),
  });
  assert.equal(sellCode, 0);
  const sellEnvelope = parseJsonEnvelope(sellStdout) as {
    schema: string;
    command: string;
    data: {
      intent: { domainName: string; listedPriceCogtoshi: string | null };
      resolved: {
        sender: { selector: string; address: string };
        recipient: null;
        economicEffect: { kind: string; listedPriceCogtoshi: string };
      };
    };
  };
  assert.equal(sellEnvelope.schema, "cogcoin/sell/v1");
  assert.equal(sellEnvelope.command, "cogcoin sell alpha 12.5");
  assert.equal(sellEnvelope.data.intent.domainName, "alpha");
  assert.equal(sellEnvelope.data.intent.listedPriceCogtoshi, "1250000000");
  assert.equal(sellEnvelope.data.resolved.sender.selector, "id:1");
  assert.equal(sellEnvelope.data.resolved.recipient, null);
  assert.equal(sellEnvelope.data.resolved.economicEffect.kind, "listing-set");
  assert.equal(sellEnvelope.data.resolved.economicEffect.listedPriceCogtoshi, "1250000000");

  const unsellStdout = new MemoryStream();
  const unsellCode = await runCli(["unsell", "alpha", "--output", "json"], {
    stdout: unsellStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    sellDomain: async (options) => ({
      kind: "sell",
      domainName: "alpha",
      txid: "99".repeat(32),
      status: "live",
      reusedExisting: false,
      listedPriceCogtoshi: options.listedPriceCogtoshi,
      resolved: {
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
      },
    }),
  });
  assert.equal(unsellCode, 0);
  const unsellEnvelope = parseJsonEnvelope(unsellStdout) as {
    schema: string;
    command: string;
    data: {
      intent: { domainName: string; listedPriceCogtoshi: string | null };
      resolved: {
        sender: { selector: string; address: string };
        recipient: null;
        economicEffect: { kind: string; listedPriceCogtoshi: string };
      };
    };
  };
  assert.equal(unsellEnvelope.schema, "cogcoin/unsell/v1");
  assert.equal(unsellEnvelope.command, "cogcoin unsell alpha");
  assert.equal(unsellEnvelope.data.intent.domainName, "alpha");
  assert.equal(unsellEnvelope.data.intent.listedPriceCogtoshi, "0");
  assert.equal(unsellEnvelope.data.resolved.sender.selector, "id:1");
  assert.equal(unsellEnvelope.data.resolved.recipient, null);
  assert.equal(unsellEnvelope.data.resolved.economicEffect.kind, "listing-clear");
  assert.equal(unsellEnvelope.data.resolved.economicEffect.listedPriceCogtoshi, "0");

  const buyStdout = new MemoryStream();
  const buyCode = await runCli(["buy", "alpha", "--from", "domain:beta", "--output", "json"], {
    stdout: buyStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    buyDomain: async () => ({
      kind: "buy",
      domainName: "alpha",
      txid: "aa".repeat(32),
      status: "live",
      reusedExisting: false,
      listedPriceCogtoshi: 150n,
      resolvedBuyer: {
        selector: "id:2",
        localIndex: 2,
        scriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
        address: "bc1qbetaowner00000000000000000000000000000",
      },
      resolvedSeller: {
        scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
        address: "bc1qalphaowner0000000000000000000000000000",
      },
    }),
  });
  assert.equal(buyCode, 0);
  const buyEnvelope = parseJsonEnvelope(buyStdout) as {
    schema: string;
    command: string;
    outcome: string;
    data: {
      resultType: string;
      intent: {
        domainName: string;
        listedPriceCogtoshi: string | null;
        fromIdentitySelector: string | null;
      };
      resolved: {
        buyer: { selector: string; address: string };
        seller: { scriptPubKeyHex: string; address: string | null };
      };
    };
  };
  assert.equal(buyEnvelope.schema, "cogcoin/buy/v1");
  assert.equal(buyEnvelope.command, "cogcoin buy alpha");
  assert.equal(buyEnvelope.outcome, "submitted");
  assert.equal(buyEnvelope.data.resultType, "single-tx-mutation");
  assert.equal(buyEnvelope.data.intent.domainName, "alpha");
  assert.equal(buyEnvelope.data.intent.listedPriceCogtoshi, "150");
  assert.equal(buyEnvelope.data.intent.fromIdentitySelector, "domain:beta");
  assert.equal(buyEnvelope.data.resolved.buyer.selector, "id:2");
  assert.equal(buyEnvelope.data.resolved.buyer.address, "bc1qbetaowner00000000000000000000000000000");
  assert.equal(buyEnvelope.data.resolved.seller.scriptPubKeyHex, "001400a654e135b542d1a605d607c08e2218a178788d");

  const buyAliasStdout = new MemoryStream();
  const buyAliasCode = await runCli(["domain", "buy", "alpha", "--from", "domain:beta", "--output", "json"], {
    stdout: buyAliasStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    buyDomain: async () => ({
      kind: "buy",
      domainName: "alpha",
      txid: "aa".repeat(32),
      status: "live",
      reusedExisting: false,
      listedPriceCogtoshi: 150n,
      resolvedBuyer: {
        selector: "id:2",
        localIndex: 2,
        scriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
        address: "bc1qbetaowner00000000000000000000000000000",
      },
      resolvedSeller: {
        scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
        address: "bc1qalphaowner0000000000000000000000000000",
      },
    }),
  });
  assert.equal(buyAliasCode, 0);
  const buyAliasEnvelope = parseJsonEnvelope(buyAliasStdout) as {
    schema: string;
    command: string;
    data: unknown;
  };
  assert.equal(buyAliasEnvelope.schema, "cogcoin/buy/v1");
  assert.equal(buyAliasEnvelope.command, "cogcoin buy alpha");
  assert.deepEqual(buyAliasEnvelope.data, buyEnvelope.data);

  const sendStdout = new MemoryStream();
  const sendCode = await runCli(["cog", "send", "1.5", "--to", "spk:00141111111111111111111111111111111111111111", "--from", "id:1", "--output", "json"], {
    stdout: sendStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    sendCog: async (options) => ({
      kind: "send",
      txid: "ab".repeat(32),
      status: "live",
      reusedExisting: false,
      amountCogtoshi: options.amountCogtoshi,
      recipientScriptPubKeyHex: "00141111111111111111111111111111111111111111",
      resolved: {
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        claimPath: null,
      },
    }),
  });
  assert.equal(sendCode, 0);
  const sendEnvelope = parseJsonEnvelope(sendStdout) as {
    schema: string;
    command: string;
    data: {
      intent: { amountCogtoshi: string | null; fromIdentitySelector: string | null };
      resolved: { sender: { selector: string; address: string } };
    };
  };
  assert.equal(sendEnvelope.schema, "cogcoin/send/v1");
  assert.equal(sendEnvelope.command, "cogcoin send 1.5");
  assert.equal(sendEnvelope.data.intent.amountCogtoshi, "150000000");
  assert.equal(sendEnvelope.data.intent.fromIdentitySelector, "id:1");
  assert.equal(sendEnvelope.data.resolved.sender.selector, "id:1");
  assert.equal(sendEnvelope.data.resolved.sender.address, "bc1qalphaowner0000000000000000000000000000");

  const lockStdout = new MemoryStream();
  const lockCode = await runCli([
    "cog",
    "lock",
    "2",
    "--to-domain",
    "alpha",
    "--until-height",
    "500",
    "--condition",
    "22".repeat(32),
    "--from",
    "domain:alpha",
    "--output",
    "json",
  ], {
    stdout: lockStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    lockCogToDomain: async (options) => ({
      kind: "lock",
      txid: "bc".repeat(32),
      status: "live",
      reusedExisting: false,
      amountCogtoshi: options.amountCogtoshi,
      recipientDomainName: options.recipientDomainName,
      resolved: {
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        claimPath: null,
      },
    }),
  });
  assert.equal(lockCode, 0);
  const lockEnvelope = parseJsonEnvelope(lockStdout) as {
    schema: string;
    command: string;
    data: {
      intent: {
        amountCogtoshi: string | null;
        recipientDomainName: string | null;
        fromIdentitySelector: string | null;
        timeoutHeight: string | null;
      };
      resolved: { sender: { selector: string; address: string } };
    };
  };
  assert.equal(lockEnvelope.schema, "cogcoin/cog-lock/v1");
  assert.equal(lockEnvelope.command, "cogcoin cog lock 2");
  assert.equal(lockEnvelope.data.intent.amountCogtoshi, "200000000");
  assert.equal(lockEnvelope.data.intent.recipientDomainName, "alpha");
  assert.equal(lockEnvelope.data.intent.fromIdentitySelector, "domain:alpha");
  assert.equal(lockEnvelope.data.intent.timeoutHeight, "500");
  assert.equal(lockEnvelope.data.resolved.sender.selector, "id:1");
  assert.equal(lockEnvelope.data.resolved.sender.address, "bc1qalphaowner0000000000000000000000000000");

  const claimStdout = new MemoryStream();
  const claimCode = await runCli(["claim", "7", "--preimage", "33".repeat(32), "--output", "json"], {
    stdout: claimStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    claimCogLock: async (options) => ({
      kind: "claim",
      txid: "cd".repeat(32),
      status: "live",
      reusedExisting: false,
      amountCogtoshi: 12n,
      recipientDomainName: "alpha",
      lockId: options.lockId,
      resolved: {
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        claimPath: "recipient-claim",
      },
    }),
  });
  assert.equal(claimCode, 0);
  const claimEnvelope = parseJsonEnvelope(claimStdout) as {
    schema: string;
    command: string;
    data: {
      intent: { lockId: number | null; fromIdentitySelector: string | null };
      resolved: { sender: { selector: string }; claimPath: string | null };
    };
  };
  assert.equal(claimEnvelope.schema, "cogcoin/claim/v1");
  assert.equal(claimEnvelope.command, "cogcoin claim 7");
  assert.equal(claimEnvelope.data.intent.lockId, 7);
  assert.equal(claimEnvelope.data.intent.fromIdentitySelector, null);
  assert.equal(claimEnvelope.data.resolved.sender.selector, "id:1");
  assert.equal(claimEnvelope.data.resolved.claimPath, "recipient-claim");

  const reclaimStdout = new MemoryStream();
  const reclaimCode = await runCli(["reclaim", "8", "--output", "json"], {
    stdout: reclaimStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    reclaimCogLock: async (options) => ({
      kind: "claim",
      txid: "de".repeat(32),
      status: "live",
      reusedExisting: false,
      amountCogtoshi: 10n,
      lockId: options.lockId,
      resolved: {
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        claimPath: "timeout-reclaim",
      },
    }),
  });
  assert.equal(reclaimCode, 0);
  const reclaimEnvelope = parseJsonEnvelope(reclaimStdout) as {
    schema: string;
    command: string;
    data: {
      intent: { lockId: number | null; fromIdentitySelector: string | null };
      resolved: { sender: { selector: string }; claimPath: string | null };
    };
  };
  assert.equal(reclaimEnvelope.schema, "cogcoin/reclaim/v1");
  assert.equal(reclaimEnvelope.command, "cogcoin reclaim 8");
  assert.equal(reclaimEnvelope.data.intent.lockId, 8);
  assert.equal(reclaimEnvelope.data.intent.fromIdentitySelector, null);
  assert.equal(reclaimEnvelope.data.resolved.sender.selector, "id:1");
  assert.equal(reclaimEnvelope.data.resolved.claimPath, "timeout-reclaim");

  const fieldStdout = new MemoryStream();
  const fieldCode = await runCli(["field", "create", "alpha", "tagline", "--text", "hello", "--output", "json"], {
    stdout: fieldStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    createField: async () => ({
      kind: "field-create",
      domainName: "alpha",
      fieldName: "tagline",
      fieldId: 7,
      txid: "11".repeat(32),
      tx1Txid: "11".repeat(32),
      tx2Txid: "22".repeat(32),
      family: true,
      permanent: false,
      format: 2,
      status: "live",
      reusedExisting: false,
      resolved: {
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        path: "field-reg-plus-data-update-family",
        value: {
          format: 2,
          byteLength: 5,
        },
        effect: {
          kind: "create-and-initialize-field",
          tx1BurnCogtoshi: "100",
          tx2AdditionalBurnCogtoshi: "1",
        },
      },
    }),
  });
  assert.equal(fieldCode, 0);
  const fieldEnvelope = parseJsonEnvelope(fieldStdout) as {
    schema: string;
    data: {
      resultType: string;
      transactions: { tx1: { txid: string | null }; tx2: { txid: string | null } };
      resolved: {
        sender: { selector: string };
        path: string;
        value: { format: number; byteLength: number } | null;
        effect: { kind: string; tx1BurnCogtoshi: string; tx2AdditionalBurnCogtoshi: string };
      };
    };
  };
  assert.equal(fieldEnvelope.schema, "cogcoin/field-create/v1");
  assert.equal(fieldEnvelope.data.resultType, "family-mutation");
  assert.equal(fieldEnvelope.data.transactions.tx1.txid, "11".repeat(32));
  assert.equal(fieldEnvelope.data.transactions.tx2.txid, "22".repeat(32));
  assert.equal(fieldEnvelope.data.resolved.sender.selector, "id:1");
  assert.equal(fieldEnvelope.data.resolved.path, "field-reg-plus-data-update-family");
  assert.equal(fieldEnvelope.data.resolved.value?.format, 2);
  assert.equal(fieldEnvelope.data.resolved.value?.byteLength, 5);
  assert.equal(fieldEnvelope.data.resolved.effect.kind, "create-and-initialize-field");
  assert.equal(fieldEnvelope.data.resolved.effect.tx1BurnCogtoshi, "100");
  assert.equal(fieldEnvelope.data.resolved.effect.tx2AdditionalBurnCogtoshi, "1");

  const fieldSetStdout = new MemoryStream();
  const fieldSetCode = await runCli(["field", "set", "alpha", "tagline", "--text", "hello", "--output", "json"], {
    stdout: fieldSetStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    setField: async () => ({
      kind: "field-set",
      domainName: "alpha",
      fieldName: "tagline",
      fieldId: 7,
      txid: "33".repeat(32),
      family: false,
      permanent: false,
      format: 2,
      status: "live",
      reusedExisting: false,
      resolved: {
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        path: "standalone-data-update",
        value: {
          format: 2,
          byteLength: 5,
        },
        effect: {
          kind: "write-field-value",
          burnCogtoshi: "1",
        },
      },
    }),
  });
  assert.equal(fieldSetCode, 0);
  const fieldSetEnvelope = parseJsonEnvelope(fieldSetStdout) as {
    schema: string;
    data: {
      resultType: string;
      transaction: { txid: string | null };
      resolved: {
        sender: { selector: string };
        path: string;
        value: { format: number; byteLength: number } | null;
        effect: { kind: string; burnCogtoshi: string };
      };
    };
  };
  assert.equal(fieldSetEnvelope.schema, "cogcoin/field-set/v1");
  assert.equal(fieldSetEnvelope.data.resultType, "single-tx-mutation");
  assert.equal(fieldSetEnvelope.data.transaction.txid, "33".repeat(32));
  assert.equal(fieldSetEnvelope.data.resolved.sender.selector, "id:1");
  assert.equal(fieldSetEnvelope.data.resolved.path, "standalone-data-update");
  assert.equal(fieldSetEnvelope.data.resolved.value?.format, 2);
  assert.equal(fieldSetEnvelope.data.resolved.value?.byteLength, 5);
  assert.equal(fieldSetEnvelope.data.resolved.effect.kind, "write-field-value");
  assert.equal(fieldSetEnvelope.data.resolved.effect.burnCogtoshi, "1");

  const fieldClearStdout = new MemoryStream();
  const fieldClearCode = await runCli(["field", "clear", "alpha", "tagline", "--output", "json"], {
    stdout: fieldClearStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    clearField: async () => ({
      kind: "field-clear",
      domainName: "alpha",
      fieldName: "tagline",
      fieldId: 7,
      txid: "44".repeat(32),
      family: false,
      permanent: false,
      format: 0,
      status: "live",
      reusedExisting: false,
      resolved: {
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
      },
    }),
  });
  assert.equal(fieldClearCode, 0);
  const fieldClearEnvelope = parseJsonEnvelope(fieldClearStdout) as {
    schema: string;
    data: {
      resultType: string;
      transaction: { txid: string | null };
      resolved: {
        sender: { selector: string };
        path: string;
        value: null;
        effect: { kind: string; burnCogtoshi: string };
      };
    };
  };
  assert.equal(fieldClearEnvelope.schema, "cogcoin/field-clear/v1");
  assert.equal(fieldClearEnvelope.data.resultType, "single-tx-mutation");
  assert.equal(fieldClearEnvelope.data.transaction.txid, "44".repeat(32));
  assert.equal(fieldClearEnvelope.data.resolved.sender.selector, "id:1");
  assert.equal(fieldClearEnvelope.data.resolved.path, "standalone-data-clear");
  assert.equal(fieldClearEnvelope.data.resolved.value, null);
  assert.equal(fieldClearEnvelope.data.resolved.effect.kind, "clear-field-value");
  assert.equal(fieldClearEnvelope.data.resolved.effect.burnCogtoshi, "0");

  const hooksStdout = new MemoryStream();
  const hooksStderr = new MemoryStream();
  const hooksCode = await runCli(["hooks", "enable", "mining", "--output", "json"], {
    stdout: hooksStdout,
    stderr: hooksStderr,
    walletSecretProvider: {} as never,
    enableMiningHooks: async (options) => {
      options.prompter.writeLine("Custom hook trust warning");
      return createMiningView({
        hook: {
          mode: "custom",
          validationState: "validated",
          validationError: null,
        },
        provider: {
          configured: true,
          provider: "openai",
          status: "ready",
        },
        runtime: {
          runMode: "stopped",
        },
      });
    },
  });
  assert.equal(hooksCode, 0);
  assert.doesNotMatch(hooksStdout.toString(), /Custom hook trust warning/);
  assert.match(hooksStderr.toString(), /Custom hook trust warning/);
  const hooksEnvelope = parseJsonEnvelope(hooksStdout) as {
    schema: string;
    outcome: string;
    nextSteps: string[];
    data: {
      resultType: string;
      state: { hook: { mode: string } };
      stateChange: { after: { hook: { mode: string } } | null };
    };
  };
  assert.equal(hooksEnvelope.schema, "cogcoin/hooks-enable-mining/v1");
  assert.equal(hooksEnvelope.outcome, "enabled");
  assert.equal(hooksEnvelope.data.resultType, "state-change");
  assert.equal(hooksEnvelope.data.state.hook.mode, "custom");
  assert.equal(hooksEnvelope.data.stateChange.after?.hook.mode, "custom");
  assert.deepEqual(hooksEnvelope.nextSteps, [
    "cogcoin mine",
    "cogcoin mine start",
  ]);

  const hooksDisableStdout = new MemoryStream();
  const hooksDisableCode = await runCli(["hooks", "disable", "mining", "--output", "json"], {
    stdout: hooksDisableStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    disableMiningHooks: async () => createMiningView({
      hook: {
        mode: "builtin",
        validationState: "unknown",
        validationError: null,
      },
      provider: {
        configured: true,
        provider: "openai",
        status: "ready",
      },
      runtime: {
        runMode: "stopped",
      },
    }),
  });
  assert.equal(hooksDisableCode, 0);
  const hooksDisableEnvelope = parseJsonEnvelope(hooksDisableStdout) as {
    schema: string;
    outcome: string;
    data: {
      resultType: string;
      state: { hook: { mode: string } };
      stateChange: { after: { hook: { mode: string } } | null };
    };
  };
  assert.equal(hooksDisableEnvelope.schema, "cogcoin/hooks-disable-mining/v1");
  assert.equal(hooksDisableEnvelope.outcome, "disabled");
  assert.equal(hooksDisableEnvelope.data.resultType, "state-change");
  assert.equal(hooksDisableEnvelope.data.state.hook.mode, "builtin");
  assert.equal(hooksDisableEnvelope.data.stateChange.after?.hook.mode, "builtin");

  const mineSetupStdout = new MemoryStream();
  const mineSetupStderr = new MemoryStream();
  const mineSetupCode = await runCli(["mine", "setup", "--output", "json"], {
    stdout: mineSetupStdout,
    stderr: mineSetupStderr,
    stdin: { isTTY: true },
    walletSecretProvider: {} as never,
    setupBuiltInMining: async (options) => {
      options.prompter.writeLine("Built-in mining provider disclosure");
      return createMiningView({
        hook: {
          mode: "builtin",
          validationState: "unknown",
          validationError: null,
        },
        provider: {
          configured: true,
          provider: "openai",
          status: "ready",
          modelOverride: "gpt-5.4",
          extraPromptConfigured: true,
        },
        runtime: {
          runMode: "stopped",
          note: "Run `cogcoin mine` or `cogcoin mine start` to begin mining.",
        },
      });
    },
  });
  assert.equal(mineSetupCode, 0);
  assert.doesNotMatch(mineSetupStdout.toString(), /Built-in mining provider disclosure/);
  assert.match(mineSetupStderr.toString(), /Built-in mining provider disclosure/);
  const mineSetupEnvelope = parseJsonEnvelope(mineSetupStdout) as {
    schema: string;
    outcome: string;
    nextSteps: string[];
    data: {
      resultType: string;
      state: {
        provider: {
          configured: boolean;
          provider: string | null;
          status: string | null;
          modelOverride: string | null;
          extraPromptConfigured: boolean;
        };
      };
      stateChange: {
        after: {
          provider: {
            modelOverride: string | null;
            extraPromptConfigured: boolean;
          };
        } | null;
      };
    };
  };
  assert.equal(mineSetupEnvelope.schema, "cogcoin/mine-setup/v1");
  assert.equal(mineSetupEnvelope.outcome, "configured");
  assert.equal(mineSetupEnvelope.data.resultType, "state-change");
  assert.equal(mineSetupEnvelope.data.state.provider.configured, true);
  assert.equal(mineSetupEnvelope.data.state.provider.provider, "openai");
  assert.equal(mineSetupEnvelope.data.state.provider.status, "ready");
  assert.equal(mineSetupEnvelope.data.state.provider.modelOverride, "gpt-5.4");
  assert.equal(mineSetupEnvelope.data.state.provider.extraPromptConfigured, true);
  assert.equal(mineSetupEnvelope.data.stateChange.after?.provider.modelOverride, "gpt-5.4");
  assert.equal(mineSetupEnvelope.data.stateChange.after?.provider.extraPromptConfigured, true);
  assert.deepEqual(mineSetupEnvelope.nextSteps, [
    "cogcoin mine",
    "cogcoin mine start",
  ]);

  const mineStartStdout = new MemoryStream();
  const mineStartCode = await runCli(["mine", "start", "--output", "json"], {
    stdout: mineStartStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    startBackgroundMining: async () => ({
      started: true,
      snapshot: createMiningView({
        runtime: {
          runMode: "background",
          backgroundWorkerPid: 4242,
          backgroundWorkerHealth: "healthy",
        },
      }).runtime,
    }),
  });
  assert.equal(mineStartCode, 0);
  const mineStartEnvelope = parseJsonEnvelope(mineStartStdout) as {
    schema: string;
    outcome: string;
    data: {
      state: { started: boolean; runtime: { backgroundWorkerPid: number | null } };
      stateChange: { after: { started: boolean } | null };
    };
  };
  assert.equal(mineStartEnvelope.schema, "cogcoin/mine-start/v1");
  assert.equal(mineStartEnvelope.outcome, "started");
  assert.equal(mineStartEnvelope.data.state.started, true);
  assert.equal(mineStartEnvelope.data.state.runtime.backgroundWorkerPid, 4242);
  assert.equal(mineStartEnvelope.data.stateChange.after?.started, true);

  const mineStopStdout = new MemoryStream();
  const mineStopCode = await runCli(["mine", "stop", "--output", "json"], {
    stdout: mineStopStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    stopBackgroundMining: async () => createMiningView({
      runtime: {
        runMode: "stopped",
        miningState: "paused",
        note: "Background mining stopped. The last mining transaction may still confirm from mempool.",
      },
    }).runtime,
  });
  assert.equal(mineStopCode, 0);
  const mineStopEnvelope = parseJsonEnvelope(mineStopStdout) as {
    schema: string;
    outcome: string;
    nextSteps: string[];
    data: {
      state: { stopped: boolean; note: string; runtime: { runMode: string } | null };
      stateChange: { after: { stopped: boolean; note: string } | null };
    };
  };
  assert.equal(mineStopEnvelope.schema, "cogcoin/mine-stop/v1");
  assert.equal(mineStopEnvelope.outcome, "stopped");
  assert.equal(mineStopEnvelope.data.state.stopped, true);
  assert.match(mineStopEnvelope.data.state.note, /may still confirm from mempool/);
  assert.equal(mineStopEnvelope.data.state.runtime?.runMode, "stopped");
  assert.equal(mineStopEnvelope.data.stateChange.after?.stopped, true);
  assert.deepEqual(mineStopEnvelope.nextSteps, ["cogcoin mine log"]);
});

test("domain admin mutations emit stable json with resolved sender, target, and effect", async () => {
  const endpointSetStdout = new MemoryStream();
  const endpointSetCode = await runCli(["domain", "endpoint", "set", "alpha", "--text", "hello", "--output", "json"], {
    stdout: endpointSetStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    setDomainEndpoint: async () => ({
      kind: "endpoint",
      domainName: "alpha",
      txid: "11".repeat(32),
      status: "live",
      reusedExisting: false,
      endpointValueHex: "68656c6c6f",
      resolved: {
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        target: null,
        effect: {
          kind: "endpoint-set",
          byteLength: 5,
        },
      },
    }),
  });
  assert.equal(endpointSetCode, 0);
  const endpointSetEnvelope = parseJsonEnvelope(endpointSetStdout) as {
    schema: string;
    command: string;
    data: {
      intent: { endpointValueHex: string | null; endpointByteLength: number | null };
      resolved: {
        sender: { selector: string; address: string };
        target: null;
        effect: { kind: string; byteLength: number };
      };
    };
  };
  assert.equal(endpointSetEnvelope.schema, "cogcoin/domain-endpoint-set/v1");
  assert.equal(endpointSetEnvelope.command, "cogcoin domain endpoint set alpha");
  assert.equal(endpointSetEnvelope.data.intent.endpointValueHex, "68656c6c6f");
  assert.equal(endpointSetEnvelope.data.intent.endpointByteLength, 5);
  assert.equal(endpointSetEnvelope.data.resolved.sender.selector, "id:1");
  assert.equal(endpointSetEnvelope.data.resolved.sender.address, "bc1qalphaowner0000000000000000000000000000");
  assert.equal(endpointSetEnvelope.data.resolved.target, null);
  assert.equal(endpointSetEnvelope.data.resolved.effect.kind, "endpoint-set");
  assert.equal(endpointSetEnvelope.data.resolved.effect.byteLength, 5);

  const endpointClearStdout = new MemoryStream();
  const endpointClearCode = await runCli(["domain", "endpoint", "clear", "alpha", "--output", "json"], {
    stdout: endpointClearStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    clearDomainEndpoint: async () => ({
      kind: "endpoint",
      domainName: "alpha",
      txid: "12".repeat(32),
      status: "live",
      reusedExisting: false,
      endpointValueHex: "",
      resolved: {
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        target: null,
        effect: {
          kind: "endpoint-clear",
        },
      },
    }),
  });
  assert.equal(endpointClearCode, 0);
  const endpointClearEnvelope = parseJsonEnvelope(endpointClearStdout) as {
    schema: string;
    command: string;
    data: {
      intent: { endpointValueHex: string | null; endpointByteLength: number | null };
      resolved: { effect: { kind: string } };
    };
  };
  assert.equal(endpointClearEnvelope.schema, "cogcoin/domain-endpoint-clear/v1");
  assert.equal(endpointClearEnvelope.command, "cogcoin domain endpoint clear alpha");
  assert.equal(endpointClearEnvelope.data.intent.endpointValueHex, "");
  assert.equal(endpointClearEnvelope.data.intent.endpointByteLength, 0);
  assert.equal(endpointClearEnvelope.data.resolved.effect.kind, "endpoint-clear");

  const delegateSetStdout = new MemoryStream();
  const delegateSetCode = await runCli(["domain", "delegate", "set", "alpha", "spk:00141111111111111111111111111111111111111111", "--output", "json"], {
    stdout: delegateSetStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    setDomainDelegate: async () => ({
      kind: "delegate",
      domainName: "alpha",
      txid: "13".repeat(32),
      status: "live",
      reusedExisting: false,
      recipientScriptPubKeyHex: "00141111111111111111111111111111111111111111",
      resolved: {
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        target: {
          scriptPubKeyHex: "00141111111111111111111111111111111111111111",
          address: null,
          opaque: true,
        },
        effect: {
          kind: "delegate-set",
        },
      },
    }),
  });
  assert.equal(delegateSetCode, 0);
  const delegateSetEnvelope = parseJsonEnvelope(delegateSetStdout) as {
    schema: string;
    command: string;
    data: {
      intent: { recipientScriptPubKeyHex: string | null };
      resolved: {
        target: { scriptPubKeyHex: string; address: string | null; opaque: boolean };
        effect: { kind: string };
      };
    };
  };
  assert.equal(delegateSetEnvelope.schema, "cogcoin/domain-delegate-set/v1");
  assert.equal(delegateSetEnvelope.command, "cogcoin domain delegate set alpha spk:00141111111111111111111111111111111111111111");
  assert.equal(delegateSetEnvelope.data.intent.recipientScriptPubKeyHex, "00141111111111111111111111111111111111111111");
  assert.equal(delegateSetEnvelope.data.resolved.target.scriptPubKeyHex, "00141111111111111111111111111111111111111111");
  assert.equal(delegateSetEnvelope.data.resolved.target.address, null);
  assert.equal(delegateSetEnvelope.data.resolved.target.opaque, true);
  assert.equal(delegateSetEnvelope.data.resolved.effect.kind, "delegate-set");

  const delegateClearStdout = new MemoryStream();
  const delegateClearCode = await runCli(["domain", "delegate", "clear", "alpha", "--output", "json"], {
    stdout: delegateClearStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    clearDomainDelegate: async () => ({
      kind: "delegate",
      domainName: "alpha",
      txid: "14".repeat(32),
      status: "live",
      reusedExisting: false,
      recipientScriptPubKeyHex: null,
      resolved: {
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        target: null,
        effect: {
          kind: "delegate-clear",
        },
      },
    }),
  });
  assert.equal(delegateClearCode, 0);
  const delegateClearEnvelope = parseJsonEnvelope(delegateClearStdout) as {
    schema: string;
    command: string;
    data: { resolved: { target: null; effect: { kind: string } } };
  };
  assert.equal(delegateClearEnvelope.schema, "cogcoin/domain-delegate-clear/v1");
  assert.equal(delegateClearEnvelope.command, "cogcoin domain delegate clear alpha");
  assert.equal(delegateClearEnvelope.data.resolved.target, null);
  assert.equal(delegateClearEnvelope.data.resolved.effect.kind, "delegate-clear");

  const minerSetStdout = new MemoryStream();
  const minerSetCode = await runCli(["domain", "miner", "set", "alpha", "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", "--output", "json"], {
    stdout: minerSetStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    setDomainMiner: async () => ({
      kind: "miner",
      domainName: "alpha",
      txid: "15".repeat(32),
      status: "live",
      reusedExisting: false,
      recipientScriptPubKeyHex: "001431df1ba1aaf3b6d9d5b6f025f54c7055231d0f27",
      resolved: {
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        target: {
          scriptPubKeyHex: "001431df1ba1aaf3b6d9d5b6f025f54c7055231d0f27",
          address: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
          opaque: false,
        },
        effect: {
          kind: "miner-set",
        },
      },
    }),
  });
  assert.equal(minerSetCode, 0);
  const minerSetEnvelope = parseJsonEnvelope(minerSetStdout) as {
    schema: string;
    command: string;
    data: { resolved: { target: { address: string | null; opaque: boolean }; effect: { kind: string } } };
  };
  assert.equal(minerSetEnvelope.schema, "cogcoin/domain-miner-set/v1");
  assert.equal(minerSetEnvelope.command, "cogcoin domain miner set alpha bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh");
  assert.equal(minerSetEnvelope.data.resolved.target.address, "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh");
  assert.equal(minerSetEnvelope.data.resolved.target.opaque, false);
  assert.equal(minerSetEnvelope.data.resolved.effect.kind, "miner-set");

  const minerClearStdout = new MemoryStream();
  const minerClearCode = await runCli(["domain", "miner", "clear", "alpha", "--output", "json"], {
    stdout: minerClearStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    clearDomainMiner: async () => ({
      kind: "miner",
      domainName: "alpha",
      txid: "16".repeat(32),
      status: "live",
      reusedExisting: false,
      recipientScriptPubKeyHex: null,
      resolved: {
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        target: null,
        effect: {
          kind: "miner-clear",
        },
      },
    }),
  });
  assert.equal(minerClearCode, 0);
  const minerClearEnvelope = parseJsonEnvelope(minerClearStdout) as {
    schema: string;
    command: string;
    data: { resolved: { target: null; effect: { kind: string } } };
  };
  assert.equal(minerClearEnvelope.schema, "cogcoin/domain-miner-clear/v1");
  assert.equal(minerClearEnvelope.command, "cogcoin domain miner clear alpha");
  assert.equal(minerClearEnvelope.data.resolved.target, null);
  assert.equal(minerClearEnvelope.data.resolved.effect.kind, "miner-clear");

  const canonicalStdout = new MemoryStream();
  const canonicalCode = await runCli(["domain", "canonical", "alpha", "--output", "json"], {
    stdout: canonicalStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    setDomainCanonical: async () => ({
      kind: "canonical",
      domainName: "alpha",
      txid: "17".repeat(32),
      status: "live",
      reusedExisting: false,
      resolved: {
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        target: null,
        effect: {
          kind: "canonicalize-owner",
        },
      },
    }),
  });
  assert.equal(canonicalCode, 0);
  const canonicalEnvelope = parseJsonEnvelope(canonicalStdout) as {
    schema: string;
    command: string;
    data: {
      intent: { domainName: string };
      resolved: { sender: { selector: string }; target: null; effect: { kind: string } };
    };
  };
  assert.equal(canonicalEnvelope.schema, "cogcoin/domain-canonical/v1");
  assert.equal(canonicalEnvelope.command, "cogcoin domain canonical alpha");
  assert.equal(canonicalEnvelope.data.intent.domainName, "alpha");
  assert.equal(canonicalEnvelope.data.resolved.sender.selector, "id:1");
  assert.equal(canonicalEnvelope.data.resolved.target, null);
  assert.equal(canonicalEnvelope.data.resolved.effect.kind, "canonicalize-owner");
});

test("hooks enable mining stable json errors use the expected exit codes", async () => {
  const ttyStdout = new MemoryStream();
  const ttyCode = await runCli(["hooks", "enable", "mining", "--output", "json"], {
    stdout: ttyStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    enableMiningHooks: async () => {
      throw new Error("mining_hooks_enable_requires_tty");
    },
  });
  assert.equal(ttyCode, 4);
  const ttyEnvelope = parseJsonEnvelope(ttyStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(ttyEnvelope.schema, "cogcoin/hooks-enable-mining/v1");
  assert.equal(ttyEnvelope.ok, false);
  assert.equal(ttyEnvelope.error.code, "mining_hooks_enable_requires_tty");
  assert.match(ttyEnvelope.error.message, /Interactive terminal input is required/);

  const lockedStdout = new MemoryStream();
  const lockedCode = await runCli(["hooks", "enable", "mining", "--output", "json"], {
    stdout: lockedStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    enableMiningHooks: async () => {
      throw new Error("wallet_locked");
    },
  });
  assert.equal(lockedCode, 4);
  const lockedEnvelope = parseJsonEnvelope(lockedStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(lockedEnvelope.schema, "cogcoin/hooks-enable-mining/v1");
  assert.equal(lockedEnvelope.ok, false);
  assert.equal(lockedEnvelope.error.code, "wallet_locked");
  assert.match(lockedEnvelope.error.message, /Wallet is locked/);

  const trustStdout = new MemoryStream();
  const trustCode = await runCli(["hooks", "enable", "mining", "--output", "json"], {
    stdout: trustStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    enableMiningHooks: async () => {
      throw new Error("mining_hooks_enable_trust_acknowledgement_required");
    },
  });
  assert.equal(trustCode, 2);
  const trustEnvelope = parseJsonEnvelope(trustStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
    nextSteps: string[];
  };
  assert.equal(trustEnvelope.schema, "cogcoin/hooks-enable-mining/v1");
  assert.equal(trustEnvelope.ok, false);
  assert.equal(trustEnvelope.error.code, "mining_hooks_enable_trust_acknowledgement_required");
  assert.match(trustEnvelope.error.message, /Trust acknowledgement is still required/);
  assert.ok(trustEnvelope.nextSteps.some((step) => step.includes("hooks enable mining")));

  const templateStdout = new MemoryStream();
  const templateCode = await runCli(["hooks", "enable", "mining", "--output", "json"], {
    stdout: templateStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    enableMiningHooks: async () => {
      throw new Error("mining_hooks_enable_template_created:/tmp/hooks/mining");
    },
  });
  assert.equal(templateCode, 4);
  const templateEnvelope = parseJsonEnvelope(templateStdout) as {
    schema: string;
    ok: boolean;
    error: {
      code: string;
      message: string;
      details: { hookRootPath?: string; rawMessage?: string };
    };
  };
  assert.equal(templateEnvelope.schema, "cogcoin/hooks-enable-mining/v1");
  assert.equal(templateEnvelope.ok, false);
  assert.equal(templateEnvelope.error.code, "mining_hooks_enable_template_created");
  assert.match(templateEnvelope.error.message, /Default mining hook template was created/);
  assert.equal(templateEnvelope.error.details.hookRootPath, "/tmp/hooks/mining");

  const validationStdout = new MemoryStream();
  const validationCode = await runCli(["hooks", "enable", "mining", "--output", "json"], {
    stdout: validationStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    enableMiningHooks: async () => {
      throw new Error("mining_hooks_enable_validation_failed:Custom mining hook entrypoint is missing.");
    },
  });
  assert.equal(validationCode, 5);
  const validationEnvelope = parseJsonEnvelope(validationStdout) as {
    schema: string;
    ok: boolean;
    error: {
      code: string;
      message: string;
      details: { validationError?: string; rawMessage?: string };
    };
  };
  assert.equal(validationEnvelope.schema, "cogcoin/hooks-enable-mining/v1");
  assert.equal(validationEnvelope.ok, false);
  assert.equal(validationEnvelope.error.code, "mining_hooks_enable_validation_failed");
  assert.match(validationEnvelope.error.message, /Custom mining hook validation failed/);
  assert.equal(validationEnvelope.error.details.validationError, "Custom mining hook entrypoint is missing.");
});

test("mine setup stable json errors use the expected exit codes", async () => {
  const ttyStdout = new MemoryStream();
  const ttyCode = await runCli(["mine", "setup", "--output", "json"], {
    stdout: ttyStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    setupBuiltInMining: async () => {
      throw new Error("mine_setup_requires_tty");
    },
  });
  assert.equal(ttyCode, 4);
  const ttyEnvelope = parseJsonEnvelope(ttyStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(ttyEnvelope.schema, "cogcoin/mine-setup/v1");
  assert.equal(ttyEnvelope.ok, false);
  assert.equal(ttyEnvelope.error.code, "mine_setup_requires_tty");
  assert.match(ttyEnvelope.error.message, /Interactive terminal input is required/);

  const lockedStdout = new MemoryStream();
  const lockedCode = await runCli(["mine", "setup", "--output", "json"], {
    stdout: lockedStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    setupBuiltInMining: async () => {
      throw new Error("wallet_locked");
    },
  });
  assert.equal(lockedCode, 4);
  const lockedEnvelope = parseJsonEnvelope(lockedStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(lockedEnvelope.schema, "cogcoin/mine-setup/v1");
  assert.equal(lockedEnvelope.ok, false);
  assert.equal(lockedEnvelope.error.code, "wallet_locked");
  assert.match(lockedEnvelope.error.message, /Wallet is locked/);

  const providerStdout = new MemoryStream();
  const providerCode = await runCli(["mine", "setup", "--output", "json"], {
    stdout: providerStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    setupBuiltInMining: async () => {
      throw new Error("mining_setup_invalid_provider");
    },
  });
  assert.equal(providerCode, 2);
  const providerEnvelope = parseJsonEnvelope(providerStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(providerEnvelope.schema, "cogcoin/mine-setup/v1");
  assert.equal(providerEnvelope.ok, false);
  assert.equal(providerEnvelope.error.code, "mining_setup_invalid_provider");
  assert.match(providerEnvelope.error.message, /Mining provider choice is invalid/);

  const apiKeyStdout = new MemoryStream();
  const apiKeyCode = await runCli(["mine", "setup", "--output", "json"], {
    stdout: apiKeyStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    setupBuiltInMining: async () => {
      throw new Error("mining_setup_missing_api_key");
    },
  });
  assert.equal(apiKeyCode, 2);
  const apiKeyEnvelope = parseJsonEnvelope(apiKeyStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(apiKeyEnvelope.schema, "cogcoin/mine-setup/v1");
  assert.equal(apiKeyEnvelope.ok, false);
  assert.equal(apiKeyEnvelope.error.code, "mining_setup_missing_api_key");
  assert.match(apiKeyEnvelope.error.message, /Mining provider API key is required/);

  const runtimeStdout = new MemoryStream();
  const runtimeCode = await runCli(["mine", "setup", "--output", "json"], {
    stdout: runtimeStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    setupBuiltInMining: async () => {
      throw new Error("disk write failed");
    },
  });
  assert.equal(runtimeCode, 5);
  const runtimeEnvelope = parseJsonEnvelope(runtimeStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(runtimeEnvelope.schema, "cogcoin/mine-setup/v1");
  assert.equal(runtimeEnvelope.ok, false);
  assert.equal(runtimeEnvelope.error.code, "disk write failed");
});

test("wallet lock and repair emit stable json envelopes", async () => {
  const lockStdout = new MemoryStream();
  const lockCode = await runCli(["wallet", "lock", "--output", "json"], {
    stdout: lockStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    lockWallet: async () => ({
      walletRootId: "wallet-root-test",
      coreLocked: true,
    }),
  });
  assert.equal(lockCode, 0);
  const lockEnvelope = parseJsonEnvelope(lockStdout) as {
    schema: string;
    outcome: string;
    data: {
      state: { walletRootId: string | null; locked: boolean };
      stateChange: { after: { walletRootId: string | null; locked: boolean } | null };
    };
  };
  assert.equal(lockEnvelope.schema, "cogcoin/wallet-lock/v1");
  assert.equal(lockEnvelope.outcome, "locked");
  assert.equal(lockEnvelope.data.state.walletRootId, "wallet-root-test");
  assert.equal(lockEnvelope.data.state.locked, true);
  assert.equal(lockEnvelope.data.stateChange.after?.locked, true);

  const repairStdout = new MemoryStream();
  const repairCode = await runCli(["repair", "--yes", "--output", "json"], {
    stdout: repairStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    repairWallet: async () => ({
      walletRootId: "wallet-root-test",
      recoveredFromBackup: true,
      recreatedManagedCoreWallet: false,
      bitcoindServiceAction: "stopped-incompatible-service",
      bitcoindCompatibilityIssue: "service-version-mismatch",
      managedCoreReplicaAction: "none",
      bitcoindPostRepairHealth: "ready",
      resetIndexerDatabase: true,
      indexerDaemonAction: "stopped-incompatible-daemon",
      indexerCompatibilityIssue: "service-version-mismatch",
      indexerPostRepairHealth: "catching-up",
      miningPreRepairRunMode: "background",
      miningResumeAction: "resume-failed",
      miningPostRepairRunMode: "stopped",
      miningResumeError: "built_in_provider_launch_failed",
      note: "Indexer artifacts were reset and may still be catching up.",
    }),
  });
  assert.equal(repairCode, 0);
  const repairEnvelope = parseJsonEnvelope(repairStdout) as {
    schema: string;
    outcome: string;
    nextSteps: string[];
    warnings: string[];
    data: {
      state: {
        walletRootId: string;
        recoveredFromBackup: boolean;
        resetIndexerDatabase: boolean;
        indexerDaemonAction: string;
        indexerCompatibilityIssue: string;
        indexerPostRepairHealth: string;
        miningPreRepairRunMode: string;
        miningResumeAction: string;
        miningPostRepairRunMode: string;
        miningResumeError: string | null;
      };
      stateChange: {
        after: {
          walletRootId: string;
          recoveredFromBackup: boolean;
          resetIndexerDatabase: boolean;
          indexerDaemonAction: string;
          indexerCompatibilityIssue: string;
          indexerPostRepairHealth: string;
          miningPreRepairRunMode: string;
          miningResumeAction: string;
          miningPostRepairRunMode: string;
          miningResumeError: string | null;
        } | null;
      };
    };
  };
  assert.equal(repairEnvelope.schema, "cogcoin/repair/v1");
  assert.equal(repairEnvelope.outcome, "completed");
  assert.equal(repairEnvelope.data.state.walletRootId, "wallet-root-test");
  assert.equal(repairEnvelope.data.state.recoveredFromBackup, true);
  assert.equal(repairEnvelope.data.state.resetIndexerDatabase, true);
  assert.equal(repairEnvelope.data.state.indexerDaemonAction, "stopped-incompatible-daemon");
  assert.equal(repairEnvelope.data.state.indexerCompatibilityIssue, "service-version-mismatch");
  assert.equal(repairEnvelope.data.state.indexerPostRepairHealth, "catching-up");
  assert.equal(repairEnvelope.data.state.miningPreRepairRunMode, "background");
  assert.equal(repairEnvelope.data.state.miningResumeAction, "resume-failed");
  assert.equal(repairEnvelope.data.state.miningPostRepairRunMode, "stopped");
  assert.equal(repairEnvelope.data.state.miningResumeError, "built_in_provider_launch_failed");
  assert.equal(repairEnvelope.data.stateChange.after?.walletRootId, "wallet-root-test");
  assert.equal(repairEnvelope.data.stateChange.after?.miningResumeAction, "resume-failed");
  assert.ok(repairEnvelope.warnings.some((warning) => warning.includes("background mining did not resume automatically")));
  assert.ok(repairEnvelope.nextSteps.some((step) => step.includes("cogcoin status")));
});

test("init and wallet init emit stable json envelopes without leaking mnemonic prompts to stdout", async () => {
  const initStdout = new MemoryStream();
  const initStderr = new MemoryStream();
  const initCode = await runCli(["init", "--output", "json"], {
    stdout: initStdout,
    stderr: initStderr,
    stdin: new MemoryStream(true) as never,
    walletSecretProvider: {} as never,
    initializeWallet: async (options) => {
      options.prompter.writeLine("Write down this 24-word recovery phrase.");
      options.prompter.writeLine("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon");
      return {
        walletRootId: "wallet-root-test",
        fundingAddress: "bc1qfundingidentity0000000000000000000000000",
        unlockUntilUnixMs: 1_700_000_900_000,
        state: createWalletState(),
      };
    },
  });
  assert.equal(initCode, 0);
  assert.doesNotMatch(initStdout.toString(), /recovery phrase/i);
  assert.doesNotMatch(initStdout.toString(), /abandon abandon/);
  assert.match(initStderr.toString(), /recovery phrase/i);
  const initEnvelope = parseJsonEnvelope(initStdout) as {
    schema: string;
    command: string;
    outcome: string;
    explanations: string[];
    nextSteps: string[];
    data: {
      resultType: string;
      state: {
        walletRootId: string;
        fundingAddress: string;
        unlockUntilUnixMs: number;
        locked: boolean;
      };
      stateChange: {
        before: null;
        after: {
          walletRootId: string;
          fundingAddress: string;
          unlockUntilUnixMs: number;
          locked: boolean;
        } | null;
      };
    };
  };
  assert.equal(initEnvelope.schema, "cogcoin/init/v1");
  assert.equal(initEnvelope.command, "cogcoin init");
  assert.equal(initEnvelope.outcome, "initialized");
  assert.equal(initEnvelope.data.resultType, "state-change");
  assert.equal(initEnvelope.data.state.walletRootId, "wallet-root-test");
  assert.equal(initEnvelope.data.state.fundingAddress, "bc1qfundingidentity0000000000000000000000000");
  assert.equal(initEnvelope.data.state.unlockUntilUnixMs, 1_700_000_900_000);
  assert.equal(initEnvelope.data.state.locked, false);
  assert.equal(initEnvelope.data.stateChange.before, null);
  assert.equal(initEnvelope.data.stateChange.after?.locked, false);
  assert.ok(initEnvelope.explanations.some((line: string) => line.includes("0.0015 BTC")));
  assert.deepEqual(initEnvelope.nextSteps, ["cogcoin sync", "cogcoin address"]);
  assert.doesNotMatch(JSON.stringify(initEnvelope), /abandon abandon/);

  const initAliasStdout = new MemoryStream();
  const initAliasCode = await runCli(["wallet", "init", "--output", "json"], {
    stdout: initAliasStdout,
    stderr: new MemoryStream(),
    stdin: new MemoryStream(true) as never,
    walletSecretProvider: {} as never,
    initializeWallet: async () => ({
      walletRootId: "wallet-root-test",
      fundingAddress: "bc1qfundingidentity0000000000000000000000000",
      unlockUntilUnixMs: 1_700_000_900_000,
      state: createWalletState(),
    }),
  });
  assert.equal(initAliasCode, 0);
  const initAliasEnvelope = parseJsonEnvelope(initAliasStdout) as {
    schema: string;
    command: string;
    nextSteps: string[];
    data: unknown;
  };
  assert.equal(initAliasEnvelope.schema, "cogcoin/init/v1");
  assert.equal(initAliasEnvelope.command, "cogcoin init");
  assert.deepEqual(initAliasEnvelope.nextSteps, ["cogcoin sync", "cogcoin address"]);
  assert.deepEqual(initAliasEnvelope.data, initEnvelope.data);
});

test("terminal prompter clears sensitive displays only on interactive ttys", () => {
  const ttyInput = new MemoryStream(true) as never;
  const ttyOutput = new MemoryStream(true);
  const ttyPrompter = createTerminalPrompter(ttyInput, ttyOutput as never);
  ttyPrompter.clearSensitiveDisplay?.("mnemonic-reveal");

  assert.match(ttyOutput.toString(), /\u001b\[2J/);
  assert.match(ttyOutput.toString(), /\u001b\[3J/);
  assert.match(ttyOutput.toString(), /\u001b\[H/);

  const nonTtyInput = new MemoryStream(false) as never;
  const nonTtyOutput = new MemoryStream(false);
  const nonTtyPrompter = createTerminalPrompter(nonTtyInput, nonTtyOutput as never);
  nonTtyPrompter.clearSensitiveDisplay?.("mnemonic-reveal");

  assert.equal(nonTtyOutput.toString(), "");
});

test("terminal prompter hidden input keeps the prompt visible without echoing the entered value", async () => {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  const output = new PassThrough() as PassThrough & { isTTY?: boolean };
  let rendered = "";

  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    rendered += chunk;
  });

  const prompter = createTerminalPrompter(input as never, output as never);
  setImmediate(() => {
    input.write("super-secret\n");
    input.end();
  });

  const value = await prompter.promptHidden?.("Archive passphrase: ");

  assert.equal(value, "super-secret");
  assert.match(rendered, /Archive passphrase:/);
  assert.doesNotMatch(rendered, /super-secret/);
});

test("json init cleanup output stays on the prompt stream", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream(true);
  const code = await runCli(["init", "--output", "json"], {
    stdout,
    stderr,
    stdin: new MemoryStream(true) as never,
    walletSecretProvider: {} as never,
    initializeWallet: async (options) => {
      options.prompter.writeLine("Write down this 24-word recovery phrase.");
      options.prompter.writeLine("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon");
      await options.prompter.clearSensitiveDisplay?.("mnemonic-reveal");
      return {
        walletRootId: "wallet-root-test",
        fundingAddress: "bc1qfundingidentity0000000000000000000000000",
        unlockUntilUnixMs: 1_700_000_900_000,
        state: createWalletState(),
      };
    },
  });

  assert.equal(code, 0);
  assert.doesNotMatch(stdout.toString(), /\u001b\[/);
  assert.doesNotMatch(stdout.toString(), /recovery phrase/i);
  assert.match(stderr.toString(), /recovery phrase/i);
  assert.match(stderr.toString(), /\u001b\[2J/);
  assert.match(stderr.toString(), /\u001b\[3J/);
  assert.match(stderr.toString(), /\u001b\[H/);
});

test("restore, unlock, wallet export, and wallet import emit stable secure-admin json envelopes", async () => {
  const restoreStdout = new MemoryStream();
  const restoreCode = await runCli(["restore", "--output", "json"], {
    stdout: restoreStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    restoreWalletFromMnemonic: async () => ({
      walletRootId: "wallet-root-restored",
      fundingAddress: "bc1qfundingidentity0000000000000000000000000",
      unlockUntilUnixMs: 1_700_000_900_000,
      state: createWalletState({
        walletRootId: "wallet-root-restored",
      }),
      warnings: ["Previous managed runtime cleanup did not complete. Run `cogcoin repair` if status shows stale or conflicting managed services."],
    }),
  });
  assert.equal(restoreCode, 0);
  const restoreEnvelope = parseJsonEnvelope(restoreStdout) as {
    schema: string;
    command: string;
    outcome: string;
    warnings: string[];
    explanations: string[];
    nextSteps: string[];
    data: {
      resultType: string;
      state: {
        walletRootId: string;
        locked: boolean;
        unlockUntilUnixMs: number;
        fundingAddress: string;
      };
      stateChange: {
        after: {
          walletRootId: string;
          locked: boolean;
          unlockUntilUnixMs: number;
          fundingAddress: string;
        } | null;
      };
    };
  };
  assert.equal(restoreEnvelope.schema, "cogcoin/restore/v1");
  assert.equal(restoreEnvelope.command, "cogcoin restore");
  assert.equal(restoreEnvelope.outcome, "restored");
  assert.equal(restoreEnvelope.data.resultType, "state-change");
  assert.equal(restoreEnvelope.data.state.walletRootId, "wallet-root-restored");
  assert.equal(restoreEnvelope.data.state.locked, false);
  assert.equal(restoreEnvelope.data.state.unlockUntilUnixMs, 1_700_000_900_000);
  assert.equal(restoreEnvelope.data.state.fundingAddress, "bc1qfundingidentity0000000000000000000000000");
  assert.equal(restoreEnvelope.data.stateChange.after?.walletRootId, "wallet-root-restored");
  assert.ok(restoreEnvelope.explanations.some((line) => line.includes("Managed Bitcoin/indexer bootstrap is deferred")));
  assert.ok(restoreEnvelope.nextSteps.some((line) => line.includes("cogcoin sync")));
  assert.ok(restoreEnvelope.warnings.some((line) => line.includes("Previous managed runtime cleanup did not complete")));

  const restoreAliasStdout = new MemoryStream();
  const restoreAliasCode = await runCli(["wallet", "restore", "--output", "json"], {
    stdout: restoreAliasStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    restoreWalletFromMnemonic: async () => ({
      walletRootId: "wallet-root-restored",
      fundingAddress: "bc1qfundingidentity0000000000000000000000000",
      unlockUntilUnixMs: 1_700_000_900_000,
      state: createWalletState({
        walletRootId: "wallet-root-restored",
      }),
      warnings: ["Previous managed runtime cleanup did not complete. Run `cogcoin repair` if status shows stale or conflicting managed services."],
    }),
  });
  assert.equal(restoreAliasCode, 0);
  const restoreAliasEnvelope = parseJsonEnvelope(restoreAliasStdout) as {
    schema: string;
    command: string;
    data: unknown;
  };
  assert.equal(restoreAliasEnvelope.schema, "cogcoin/restore/v1");
  assert.equal(restoreAliasEnvelope.command, "cogcoin restore");
  assert.deepEqual(restoreAliasEnvelope.data, restoreEnvelope.data);

  const unlockStdout = new MemoryStream();
  const unlockCode = await runCli(["unlock", "--for", "2h", "--output", "json"], {
    stdout: unlockStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    unlockWallet: async () => ({
      unlockUntilUnixMs: 1_700_001_800_000,
      state: createWalletState(),
      source: "primary",
    }),
  });
  assert.equal(unlockCode, 0);
  const unlockEnvelope = parseJsonEnvelope(unlockStdout) as {
    schema: string;
    command: string;
    outcome: string;
    data: {
      resultType: string;
      state: {
        walletRootId: string;
        locked: boolean;
        unlockUntilUnixMs: number;
        fundingAddress: string;
        source: string;
      };
      stateChange: {
        after: {
          walletRootId: string;
          locked: boolean;
          unlockUntilUnixMs: number;
          fundingAddress: string;
          source: string;
        } | null;
      };
    };
  };
  assert.equal(unlockEnvelope.schema, "cogcoin/unlock/v1");
  assert.equal(unlockEnvelope.command, "cogcoin unlock");
  assert.equal(unlockEnvelope.outcome, "unlocked");
  assert.equal(unlockEnvelope.data.resultType, "state-change");
  assert.equal(unlockEnvelope.data.state.walletRootId, "wallet-root-test");
  assert.equal(unlockEnvelope.data.state.locked, false);
  assert.equal(unlockEnvelope.data.state.unlockUntilUnixMs, 1_700_001_800_000);
  assert.equal(unlockEnvelope.data.state.fundingAddress, "bc1qfundingidentity0000000000000000000000000");
  assert.equal(unlockEnvelope.data.state.source, "primary");
  assert.equal(unlockEnvelope.data.stateChange.after?.locked, false);

  const unlockAliasStdout = new MemoryStream();
  const unlockAliasCode = await runCli(["wallet", "unlock", "--for", "2h", "--output", "json"], {
    stdout: unlockAliasStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    unlockWallet: async () => ({
      unlockUntilUnixMs: 1_700_001_800_000,
      state: createWalletState(),
      source: "primary",
    }),
  });
  assert.equal(unlockAliasCode, 0);
  const unlockAliasEnvelope = parseJsonEnvelope(unlockAliasStdout) as {
    schema: string;
    command: string;
    data: unknown;
  };
  assert.equal(unlockAliasEnvelope.schema, "cogcoin/unlock/v1");
  assert.equal(unlockAliasEnvelope.command, "cogcoin unlock");
  assert.deepEqual(unlockAliasEnvelope.data, unlockEnvelope.data);

  const exportStdout = new MemoryStream();
  const exportStderr = new MemoryStream();
  const exportCode = await runCli(["wallet", "export", "/tmp/archive.cogwallet", "--output", "json"], {
    stdout: exportStdout,
    stderr: exportStderr,
    walletSecretProvider: {} as never,
    exportWallet: async (options) => {
      options.prompter.writeLine("Archive passphrase prompt");
      return {
        archivePath: "/tmp/archive.cogwallet",
        walletRootId: "wallet-root-test",
      };
    },
  });
  assert.equal(exportCode, 0);
  assert.doesNotMatch(exportStdout.toString(), /Archive passphrase prompt/);
  assert.match(exportStderr.toString(), /Archive passphrase prompt/);
  const exportEnvelope = parseJsonEnvelope(exportStdout) as {
    schema: string;
    outcome: string;
    data: {
      resultType: string;
      operation: {
        kind: string;
        walletRootId: string;
        archivePath: string;
        exportMode: string;
      };
      state: {
        walletRootId: string;
        archivePath: string;
      } | null;
    };
  };
  assert.equal(exportEnvelope.schema, "cogcoin/wallet-export/v1");
  assert.equal(exportEnvelope.outcome, "exported");
  assert.equal(exportEnvelope.data.resultType, "operation");
  assert.equal(exportEnvelope.data.operation.kind, "wallet-export");
  assert.equal(exportEnvelope.data.operation.walletRootId, "wallet-root-test");
  assert.equal(exportEnvelope.data.operation.archivePath, "/tmp/archive.cogwallet");
  assert.equal(exportEnvelope.data.operation.exportMode, "trusted-quiescent");
  assert.equal(exportEnvelope.data.state?.walletRootId, "wallet-root-test");
  assert.equal(exportEnvelope.data.state?.archivePath, "/tmp/archive.cogwallet");

  const importStdout = new MemoryStream();
  const importStderr = new MemoryStream();
  const importCode = await runCli(["wallet", "import", "/tmp/archive.cogwallet", "--output", "json"], {
    stdout: importStdout,
    stderr: importStderr,
    walletSecretProvider: {} as never,
    importWallet: async (options) => {
      options.prompter.writeLine("Archive import prompt");
      return {
        archivePath: "/tmp/archive.cogwallet",
        walletRootId: "wallet-root-test",
        fundingAddress: "bc1qfundingidentity0000000000000000000000000",
        unlockUntilUnixMs: 1_700_000_900_000,
        state: createWalletState(),
      };
    },
  });
  assert.equal(importCode, 0);
  assert.doesNotMatch(importStdout.toString(), /Archive import prompt/);
  assert.match(importStderr.toString(), /Archive import prompt/);
  const importEnvelope = parseJsonEnvelope(importStdout) as {
    schema: string;
    outcome: string;
    data: {
      resultType: string;
      state: {
        walletRootId: string;
        archivePath: string;
        fundingAddress: string;
        unlockUntilUnixMs: number;
      };
      stateChange: {
        after: {
          walletRootId: string;
          archivePath: string;
          fundingAddress: string;
          unlockUntilUnixMs: number;
        } | null;
      };
    };
  };
  assert.equal(importEnvelope.schema, "cogcoin/wallet-import/v1");
  assert.equal(importEnvelope.outcome, "imported");
  assert.equal(importEnvelope.data.resultType, "state-change");
  assert.equal(importEnvelope.data.state.walletRootId, "wallet-root-test");
  assert.equal(importEnvelope.data.state.archivePath, "/tmp/archive.cogwallet");
  assert.equal(importEnvelope.data.state.fundingAddress, "bc1qfundingidentity0000000000000000000000000");
  assert.equal(importEnvelope.data.state.unlockUntilUnixMs, 1_700_000_900_000);
  assert.equal(importEnvelope.data.stateChange.after?.archivePath, "/tmp/archive.cogwallet");
});

test("restore text success defers Bitcoin/indexer bootstrap and does not resolve a default db path", async () => {
  const stdout = new MemoryStream();
  let resolvedDbPath = false;

  const code = await runCli(["restore"], {
    stdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    resolveDefaultBitcoindDataDir: () => "/tmp/cogcoin-bitcoin",
    resolveDefaultClientDatabasePath: () => {
      resolvedDbPath = true;
      throw new Error("restore_should_not_resolve_default_db_path");
    },
    createPrompter: () => ({
      isInteractive: true,
      writeLine() {},
      async prompt() {
        return "";
      },
      async promptHidden() {
        return "";
      },
    }),
    restoreWalletFromMnemonic: async () => ({
      walletRootId: "wallet-root-restored",
      fundingAddress: "bc1qfundingidentity0000000000000000000000000",
      unlockUntilUnixMs: 1_700_000_900_000,
      state: createWalletState({
        walletRootId: "wallet-root-restored",
      }),
      warnings: ["Previous managed runtime cleanup did not complete. Run `cogcoin repair` if status shows stale or conflicting managed services."],
    }),
  });

  assert.equal(code, 0);
  assert.equal(resolvedDbPath, false);
  assert.match(stdout.toString(), /Wallet restored from mnemonic\./);
  assert.match(stdout.toString(), /Managed Bitcoin\/indexer bootstrap is deferred until you run `cogcoin sync`\./);
  assert.match(stdout.toString(), /Warning: Previous managed runtime cleanup did not complete\./);
  assert.match(stdout.toString(), /Next step: cogcoin sync/);
  assert.match(stdout.toString(), /Next step: cogcoin address/);
});

test("preview json keeps prompt chatter off stdout", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();

  const code = await runCli(["register", "weatherbot", "--output", "preview-json"], {
    stdout,
    stderr,
    walletSecretProvider: {} as never,
    registerDomain: async (options) => {
      options.prompter.writeLine("Type weatherbot to continue.");
      return {
        domainName: options.domainName,
        registerKind: "root",
        parentDomainName: null,
        senderSelector: "id:0",
        senderLocalIndex: 0,
        senderScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
        senderAddress: "bc1qfundingidentity0000000000000000000000000",
        economicEffectKind: "treasury-payment",
        economicEffectAmount: 100000n,
        resolved: {
          path: "root",
          parentDomainName: null,
          sender: {
            selector: "id:0",
            localIndex: 0,
            scriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
            address: "bc1qfundingidentity0000000000000000000000000",
          },
          economicEffect: {
            kind: "treasury-payment",
            amount: 100000n,
          },
        },
        txid: "55".repeat(32),
        status: "live",
        reusedExisting: false,
      };
    },
  });

  assert.equal(code, 0);
  assert.doesNotMatch(stdout.toString(), /Type weatherbot to continue/);
  assert.match(stderr.toString(), /Type weatherbot to continue/);
  const envelope = parseJsonEnvelope(stdout) as { schema: string };
  assert.equal(envelope.schema, "cogcoin-preview/register/v1");
});

test("preview json emits state-change envelopes for wallet-admin and mining-control commands", async () => {
  const walletLockStdout = new MemoryStream();
  const walletLockCode = await runCli(["wallet", "lock", "--output", "preview-json"], {
    stdout: walletLockStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    lockWallet: async () => ({
      walletRootId: "wallet-root-test",
      coreLocked: true,
    }),
  });
  assert.equal(walletLockCode, 0);
  const walletLockEnvelope = parseJsonEnvelope(walletLockStdout) as {
    schema: string;
    outcome: string;
    data: {
      resultType: string;
      stateChange: { kind: string };
      state: { walletRootId: string | null; locked: boolean };
    };
  };
  assert.equal(walletLockEnvelope.schema, "cogcoin-preview/wallet-lock/v1");
  assert.equal(walletLockEnvelope.outcome, "locked");
  assert.equal(walletLockEnvelope.data.resultType, "state-change");
  assert.equal(walletLockEnvelope.data.stateChange.kind, "wallet-lock");
  assert.equal(walletLockEnvelope.data.state.locked, true);

  const repairStdout = new MemoryStream();
  const repairCode = await runCli(["repair", "--yes", "--output", "preview-json"], {
    stdout: repairStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    repairWallet: async () => ({
      walletRootId: "wallet-root-test",
      recoveredFromBackup: false,
      recreatedManagedCoreWallet: false,
      bitcoindServiceAction: "none",
      bitcoindCompatibilityIssue: "none",
      managedCoreReplicaAction: "none",
      bitcoindPostRepairHealth: "ready",
      resetIndexerDatabase: false,
      indexerDaemonAction: "none",
      indexerCompatibilityIssue: "none",
      indexerPostRepairHealth: "synced",
      miningPreRepairRunMode: "background",
      miningResumeAction: "resumed-background",
      miningPostRepairRunMode: "background",
      miningResumeError: null,
      note: null,
    }),
  });
  assert.equal(repairCode, 0);
  const repairEnvelope = parseJsonEnvelope(repairStdout) as {
    schema: string;
    outcome: string;
    data: {
      resultType: string;
      stateChange: { kind: string };
      state: {
        miningPreRepairRunMode: string;
        miningResumeAction: string;
        miningPostRepairRunMode: string;
        miningResumeError: string | null;
      };
    };
  };
  assert.equal(repairEnvelope.schema, "cogcoin-preview/repair/v1");
  assert.equal(repairEnvelope.outcome, "completed");
  assert.equal(repairEnvelope.data.resultType, "state-change");
  assert.equal(repairEnvelope.data.stateChange.kind, "repair");
  assert.equal(repairEnvelope.data.state.miningPreRepairRunMode, "background");
  assert.equal(repairEnvelope.data.state.miningResumeAction, "resumed-background");
  assert.equal(repairEnvelope.data.state.miningPostRepairRunMode, "background");
  assert.equal(repairEnvelope.data.state.miningResumeError, null);

  const mineSetupStdout = new MemoryStream();
  const mineSetupCode = await runCli(["mine", "setup", "--output", "preview-json"], {
    stdout: mineSetupStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    setupBuiltInMining: async () => createMiningView({
      provider: {
        configured: true,
        provider: "openai",
        status: "ready",
        message: null,
        modelOverride: "gpt-5.4-mini",
        extraPromptConfigured: false,
      },
    }),
  });
  assert.equal(mineSetupCode, 0);
  const mineSetupEnvelope = parseJsonEnvelope(mineSetupStdout) as {
    schema: string;
    outcome: string;
    data: {
      resultType: string;
      stateChange: { kind: string };
      state: {
        provider: { configured: boolean; provider: string | null };
      };
    };
  };
  assert.equal(mineSetupEnvelope.schema, "cogcoin-preview/mine-setup/v1");
  assert.equal(mineSetupEnvelope.outcome, "configured");
  assert.equal(mineSetupEnvelope.data.resultType, "state-change");
  assert.equal(mineSetupEnvelope.data.stateChange.kind, "mine-setup");
  assert.equal(mineSetupEnvelope.data.state.provider.configured, true);
  assert.equal(mineSetupEnvelope.data.state.provider.provider, "openai");
});

test("register json output includes raw and resolved sender details", async () => {
  const stdout = new MemoryStream();
  const code = await runCli(["register", "weatherbot", "--from", "domain:alpha", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    registerDomain: async () => ({
      domainName: "weatherbot",
      registerKind: "root",
      parentDomainName: null,
      senderSelector: "id:1",
      senderLocalIndex: 1,
      senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      senderAddress: "bc1qalphaowner0000000000000000000000000000",
      economicEffectKind: "treasury-payment",
      economicEffectAmount: 100000n,
      resolved: {
        path: "root",
        parentDomainName: null,
        sender: {
          selector: "id:1",
          localIndex: 1,
          scriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
          address: "bc1qalphaowner0000000000000000000000000000",
        },
        economicEffect: {
          kind: "treasury-payment",
          amount: 100000n,
        },
      },
      txid: "55".repeat(32),
      status: "live",
      reusedExisting: false,
    }),
  });

  assert.equal(code, 0);
  const envelope = parseJsonEnvelope(stdout) as {
    schema: string;
    data: {
      intent: {
        fromIdentitySelector: string | null;
      };
      resolved: {
        sender: { selector: string };
        economicEffect: { kind: string; amount: string | null };
      };
    };
  };
  assert.equal(envelope.schema, "cogcoin/register/v1");
  assert.equal(envelope.data.intent.fromIdentitySelector, "domain:alpha");
  assert.equal(envelope.data.resolved.sender.selector, "id:1");
  assert.equal(envelope.data.resolved.economicEffect.kind, "treasury-payment");
  assert.equal(envelope.data.resolved.economicEffect.amount, "100000");
});

test("register and anchor json output include the shared workflow next steps", async () => {
  const registerStdout = new MemoryStream();
  const registerCode = await runCli(["register", "weatherbot", "--output", "json"], {
    stdout: registerStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    registerDomain: async () => ({
      domainName: "weatherbot",
      registerKind: "root",
      parentDomainName: null,
      senderSelector: "id:0",
      senderLocalIndex: 0,
      senderScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
      senderAddress: "bc1qfundingidentity0000000000000000000000000",
      economicEffectKind: "treasury-payment",
      economicEffectAmount: 100000n,
      resolved: {
        path: "root",
        parentDomainName: null,
        sender: {
          selector: "id:0",
          localIndex: 0,
          scriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
          address: "bc1qfundingidentity0000000000000000000000000",
        },
        economicEffect: {
          kind: "treasury-payment",
          amount: 100000n,
        },
      },
      txid: "55".repeat(32),
      status: "live",
      reusedExisting: false,
    }),
  });
  assert.equal(registerCode, 0);
  const registerEnvelope = parseJsonEnvelope(registerStdout) as {
    schema: string;
    nextSteps: string[];
  };
  assert.equal(registerEnvelope.schema, "cogcoin/register/v1");
  assert.deepEqual(registerEnvelope.nextSteps, [
    "cogcoin show weatherbot",
    "cogcoin anchor weatherbot once it confirms",
  ]);

  const anchorStdout = new MemoryStream();
  const anchorCode = await runCli(["anchor", "weatherbot", "--output", "json"], {
    stdout: anchorStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    anchorDomain: async () => ({
      domainName: "weatherbot",
      txid: "55".repeat(32),
      tx1Txid: "66".repeat(32),
      tx2Txid: "77".repeat(32),
      dedicatedIndex: 4,
      status: "live",
      reusedExisting: false,
    }),
  });
  assert.equal(anchorCode, 0);
  const anchorEnvelope = parseJsonEnvelope(anchorStdout) as {
    schema: string;
    nextSteps: string[];
  };
  assert.equal(anchorEnvelope.schema, "cogcoin/anchor/v1");
  assert.deepEqual(anchorEnvelope.nextSteps, [
    "cogcoin show weatherbot",
    "cogcoin mine",
    "cogcoin mine start",
  ]);
});

test("preview json typed acknowledgement failures return exit code 2", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();

  const code = await runCli(["register", "weatherbot", "--yes", "--output", "preview-json"], {
    stdout,
    stderr,
    walletSecretProvider: {} as never,
    registerDomain: async () => {
      throw new Error("wallet_register_typed_ack_required");
    },
  });

  assert.equal(code, 2);
  assert.equal(stderr.toString(), "");
  const envelope = parseJsonEnvelope(stdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
    nextSteps: string[];
  };
  assert.equal(envelope.schema, "cogcoin-preview/register/v1");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "wallet_register_typed_ack_required");
  assert.match(envelope.error.message, /Typed acknowledgement is still required/);
  assert.ok(envelope.nextSteps.some((step) => step.includes("interactive terminal")));
});

test("secure-admin json failures map to stable schemas and exit codes", async () => {
  const initRequiresTtyStdout = new MemoryStream();
  const initRequiresTtyCode = await runCli(["init", "--output", "json"], {
    stdout: initRequiresTtyStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    initializeWallet: async () => {
      throw new Error("wallet_init_requires_tty");
    },
  });
  assert.equal(initRequiresTtyCode, 4);
  const initRequiresTtyEnvelope = parseJsonEnvelope(initRequiresTtyStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(initRequiresTtyEnvelope.schema, "cogcoin/init/v1");
  assert.equal(initRequiresTtyEnvelope.ok, false);
  assert.equal(initRequiresTtyEnvelope.error.code, "wallet_init_requires_tty");
  assert.match(initRequiresTtyEnvelope.error.message, /Interactive terminal input is required/);

  const initAlreadyStdout = new MemoryStream();
  const initAlreadyCode = await runCli(["init", "--output", "json"], {
    stdout: initAlreadyStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    initializeWallet: async () => {
      throw new Error("wallet_already_initialized");
    },
  });
  assert.equal(initAlreadyCode, 4);
  const initAlreadyEnvelope = parseJsonEnvelope(initAlreadyStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(initAlreadyEnvelope.schema, "cogcoin/init/v1");
  assert.equal(initAlreadyEnvelope.ok, false);
  assert.equal(initAlreadyEnvelope.error.code, "wallet_already_initialized");
  assert.match(initAlreadyEnvelope.error.message, /Wallet is already initialized/);

  const initConfirmStdout = new MemoryStream();
  const initConfirmCode = await runCli(["init", "--output", "json"], {
    stdout: initConfirmStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    initializeWallet: async () => {
      throw new Error("wallet_init_confirmation_failed_word_7");
    },
  });
  assert.equal(initConfirmCode, 2);
  const initConfirmEnvelope = parseJsonEnvelope(initConfirmStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string; details: { wordIndex?: number; rawMessage?: string } };
    nextSteps: string[];
  };
  assert.equal(initConfirmEnvelope.schema, "cogcoin/init/v1");
  assert.equal(initConfirmEnvelope.ok, false);
  assert.equal(initConfirmEnvelope.error.code, "wallet_init_confirmation_failed_word_7");
  assert.match(initConfirmEnvelope.error.message, /Mnemonic confirmation failed/);
  assert.equal(initConfirmEnvelope.error.details.wordIndex, 7);
  assert.equal(initConfirmEnvelope.error.details.rawMessage, "wallet_init_confirmation_failed_word_7");
  assert.ok(initConfirmEnvelope.nextSteps.some((step) => step.includes("cogcoin init")));
  assert.ok(initConfirmEnvelope.nextSteps.some((step) => step.includes("same recovery phrase")));

  const initRuntimeStdout = new MemoryStream();
  const initRuntimeCode = await runCli(["init", "--output", "json"], {
    stdout: initRuntimeStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    initializeWallet: async () => {
      throw new Error("wallet_init_runtime_error");
    },
  });
  assert.equal(initRuntimeCode, 5);
  const initRuntimeEnvelope = parseJsonEnvelope(initRuntimeStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string };
  };
  assert.equal(initRuntimeEnvelope.schema, "cogcoin/init/v1");
  assert.equal(initRuntimeEnvelope.ok, false);
  assert.equal(initRuntimeEnvelope.error.code, "wallet_init_runtime_error");

  const initLinuxSecretStdout = new MemoryStream();
  const initLinuxSecretCode = await runCli(["init", "--output", "json"], {
    stdout: initLinuxSecretStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    initializeWallet: async () => {
      throw new Error("wallet_secret_provider_linux_secret_tool_missing");
    },
  });
  assert.equal(initLinuxSecretCode, 4);
  const initLinuxSecretEnvelope = parseJsonEnvelope(initLinuxSecretStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(initLinuxSecretEnvelope.schema, "cogcoin/init/v1");
  assert.equal(initLinuxSecretEnvelope.ok, false);
  assert.equal(initLinuxSecretEnvelope.error.code, "wallet_secret_provider_linux_secret_tool_missing");
  assert.match(initLinuxSecretEnvelope.error.message, /secret-tool/i);

  const restoreRequiresTtyStdout = new MemoryStream();
  const restoreRequiresTtyCode = await runCli(["restore", "--output", "json"], {
    stdout: restoreRequiresTtyStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    restoreWalletFromMnemonic: async () => {
      throw new Error("wallet_restore_requires_tty");
    },
  });
  assert.equal(restoreRequiresTtyCode, 4);
  const restoreRequiresTtyEnvelope = parseJsonEnvelope(restoreRequiresTtyStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(restoreRequiresTtyEnvelope.schema, "cogcoin/restore/v1");
  assert.equal(restoreRequiresTtyEnvelope.ok, false);
  assert.equal(restoreRequiresTtyEnvelope.error.code, "wallet_restore_requires_tty");
  assert.match(restoreRequiresTtyEnvelope.error.message, /Interactive terminal input is required/);

  const restoreInvalidMnemonicStdout = new MemoryStream();
  const restoreInvalidMnemonicCode = await runCli(["restore", "--output", "json"], {
    stdout: restoreInvalidMnemonicStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    restoreWalletFromMnemonic: async () => {
      throw new Error("wallet_restore_mnemonic_invalid");
    },
  });
  assert.equal(restoreInvalidMnemonicCode, 2);
  const restoreInvalidMnemonicEnvelope = parseJsonEnvelope(restoreInvalidMnemonicStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
    nextSteps: string[];
  };
  assert.equal(restoreInvalidMnemonicEnvelope.schema, "cogcoin/restore/v1");
  assert.equal(restoreInvalidMnemonicEnvelope.ok, false);
  assert.equal(restoreInvalidMnemonicEnvelope.error.code, "wallet_restore_mnemonic_invalid");
  assert.match(restoreInvalidMnemonicEnvelope.error.message, /Recovery phrase is invalid/);
  assert.ok(restoreInvalidMnemonicEnvelope.nextSteps.some((step) => step.includes("cogcoin restore")));

  const unlockStdout = new MemoryStream();
  const unlockCode = await runCli(["unlock", "--output", "json"], {
    stdout: unlockStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    unlockWallet: async () => {
      throw new Error("wallet_locked");
    },
  });
  assert.equal(unlockCode, 4);
  const unlockEnvelope = parseJsonEnvelope(unlockStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
    explanations: string[];
    nextSteps: string[];
  };
  assert.equal(unlockEnvelope.schema, "cogcoin/unlock/v1");
  assert.equal(unlockEnvelope.ok, false);
  assert.equal(unlockEnvelope.error.code, "wallet_locked");
  assert.match(unlockEnvelope.error.message, /Wallet is locked/);
  assert.ok(unlockEnvelope.nextSteps.some((step) => step.includes("cogcoin unlock")));

  const repairBlockedStdout = new MemoryStream();
  const repairBlockedCode = await runCli(["repair", "--output", "json"], {
    stdout: repairBlockedStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    repairWallet: async () => {
      throw new Error("wallet_repair_indexer_reset_requires_yes");
    },
  });
  assert.equal(repairBlockedCode, 4);
  const repairBlockedEnvelope = parseJsonEnvelope(repairBlockedStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
    nextSteps: string[];
  };
  assert.equal(repairBlockedEnvelope.schema, "cogcoin/repair/v1");
  assert.equal(repairBlockedEnvelope.ok, false);
  assert.equal(repairBlockedEnvelope.error.code, "wallet_repair_indexer_reset_requires_yes");
  assert.match(repairBlockedEnvelope.error.message, /Repair needs permission to reset the local indexer database/);
  assert.ok(repairBlockedEnvelope.nextSteps.some((step) => step.includes("cogcoin repair --yes")));

  const exportStdout = new MemoryStream();
  const exportCode = await runCli(["wallet", "export", "/tmp/archive.cogwallet", "--output", "json"], {
    stdout: exportStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    exportWallet: async () => {
      throw new Error("wallet_export_overwrite_declined");
    },
  });
  assert.equal(exportCode, 2);
  const exportEnvelope = parseJsonEnvelope(exportStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(exportEnvelope.schema, "cogcoin/wallet-export/v1");
  assert.equal(exportEnvelope.ok, false);
  assert.equal(exportEnvelope.error.code, "wallet_export_overwrite_declined");
  assert.match(exportEnvelope.error.message, /Archive overwrite was declined/);

  const importStdout = new MemoryStream();
  const importCode = await runCli(["wallet", "import", "/tmp/missing.cogwallet", "--output", "json"], {
    stdout: importStdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    importWallet: async () => {
      throw new Error("wallet_import_archive_not_found");
    },
  });
  assert.equal(importCode, 3);
  const importEnvelope = parseJsonEnvelope(importStdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(importEnvelope.schema, "cogcoin/wallet-import/v1");
  assert.equal(importEnvelope.ok, false);
  assert.equal(importEnvelope.error.code, "wallet_import_archive_not_found");
  assert.match(importEnvelope.error.message, /Wallet archive was not found/);
});

test("excluded commands reject --output json with a CLI envelope", async () => {
  const stdout = new MemoryStream();

  const code = await runCli(["mine", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
  });

  assert.equal(code, 2);
  const envelope = parseJsonEnvelope(stdout) as {
    schema: string;
    ok: boolean;
    error: { code: string };
  };
  assert.equal(envelope.schema, "cogcoin/cli/v1");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "cli_output_not_supported_for_command");
});

test("status renders wallet-aware degraded output for an uninitialized wallet", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();

  const code = await runCli(
    ["status", "--db", "/tmp/client.sqlite", "--data-dir", "/tmp/bitcoin"],
    {
      stdout,
      stderr,
      ensureDirectory: async () => {},
      openWalletReadContext: async () => ({
        dataDir: "/tmp/bitcoin",
        databasePath: "/tmp/client.sqlite",
        localState: {
          availability: "uninitialized",
          walletRootId: null,
          state: null,
          source: null,
          unlockUntilUnixMs: null,
          hasPrimaryStateFile: false,
          hasBackupStateFile: false,
          hasUnlockSessionFile: false,
          message: "Wallet state has not been initialized yet.",
        },
        bitcoind: {
          health: "starting",
          status: null,
          message: "Managed bitcoind service is still starting.",
        },
        nodeStatus: null,
        nodeHealth: "starting",
        nodeMessage: "Bitcoin service is starting.",
        indexer: {
          health: "starting",
          status: null,
          message: "Indexer daemon is still starting.",
          snapshotTip: null,
        },
        snapshot: null,
        model: null,
        async close() {},
      }),
    },
  );

  assert.equal(code, 0);
  const output = stdout.toString();
  assert.match(output, /\n⛭ Cogcoin Status ⛭\n\nPaths\n✓ DB path: \/tmp\/client\.sqlite\n✓ Bitcoin datadir: \/tmp\/bitcoin\n\nWallet\n✗ State: uninitialized\n✗ Root: none\n✗ Unlock: locked\n✗ Note: Wallet state has not been initialized yet\./u);
  assert.match(output, /\n\nServices\n✗ Managed bitcoind: starting\n✗ Managed bitcoind note: Managed bitcoind service is still starting\.\n✗ Bitcoin service: starting\n✗ Bitcoin note: Bitcoin service is starting\.\n✗ Indexer service: starting\n✗ Indexer truth source: none\n✗ Indexer tip height: unavailable\n✗ Indexer note: Indexer daemon is still starting\./u);
  assert.match(output, /\n\nLocal Inventory\n✗ Status: Wallet-derived sections unavailable\n\nPending Work\n✓ Status: none\n\nNext step: Run `cogcoin init` to create a new local wallet root\.\n$/u);
  assert.doesNotMatch(output, /Recommended next step:/);
  assert.doesNotMatch(output, /Mutation note:/);
  assert.doesNotMatch(output, /cogcoin sync/);
});

test("status json recommends init for an uninitialized wallet", async () => {
  const stdout = new MemoryStream();

  const code = await runCli(["status", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => ({
      dataDir: "/tmp/bitcoin",
      databasePath: "/tmp/client.sqlite",
      localState: {
        availability: "uninitialized",
        walletRootId: null,
        state: null,
        source: null,
        unlockUntilUnixMs: null,
        hasPrimaryStateFile: false,
        hasBackupStateFile: false,
        hasUnlockSessionFile: false,
        message: "Wallet state has not been initialized yet.",
      },
      bitcoind: {
        health: "starting",
        status: null,
        message: "Managed bitcoind service is still starting.",
      },
      nodeStatus: null,
      nodeHealth: "starting",
      nodeMessage: "Bitcoin service is starting.",
      indexer: {
        health: "starting",
        status: null,
        message: "Indexer daemon is still starting.",
        snapshotTip: null,
      },
      snapshot: null,
      model: null,
      async close() {},
    }),
  });

  assert.equal(code, 0);
  const envelope = parseJsonEnvelope(stdout) as {
    nextSteps: string[];
    data: {
      wallet: { availability: string };
    };
  };
  assert.equal(envelope.data.wallet.availability, "uninitialized");
  assert.ok(envelope.nextSteps.includes("Run `cogcoin init` to create a new local wallet root."));
  assert.ok(!envelope.nextSteps.some((step) => step.includes("cogcoin sync")));
});

test("status renders explicit reorging output and reorg depth", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const readyContext = await createReadyWalletReadContext();
  readyContext.indexer = {
    health: "reorging",
    status: createIndexerDaemonStatus(readyContext.localState.walletRootId ?? "wallet-root-test", {
      state: "reorging",
      reorgDepth: 6,
      snapshotSeq: "9",
    }),
    message: "Indexer daemon is replaying a reorg and refreshing the coherent snapshot.",
    snapshotTip: readyContext.snapshot?.tip ?? null,
  };
  readyContext.mining = createMiningView({
    runtime: {
      indexerHealth: "reorging",
      indexerDaemonState: "reorging",
      indexerReorgDepth: 6,
      note: "Mining remains stopped while the indexer replays a reorg and refreshes the coherent snapshot.",
    },
  });

  const code = await runCli(["status"], {
    stdout,
    stderr,
    ensureDirectory: async () => {},
    openWalletReadContext: async () => readyContext,
  });

  assert.equal(code, 0);
  assert.equal(stderr.toString(), "");
  const servicesSection = stdout.toString()
    .split("\n\n")
    .find((section) => section.startsWith("Services\n"));
  assert.ok(servicesSection);
  assert.match(servicesSection, /✗ Indexer service: reorging/u);
  assert.match(servicesSection, /✗ Indexer reorg depth: 6/u);
});

test("formatWalletOverviewReport renders sectioned status layout and omits next step when none is needed", async () => {
  const report = formatWalletOverviewReport(await createReadyWalletReadContext());
  const sections = report.split("\n\n");

  assert.deepEqual(
    sections.map((section) => section.split("\n")[0]),
    ["", "Paths", "Wallet", "Services", "Local Inventory", "Pending Work"],
  );
  assert.equal(sections[0], "\n⛭ Cogcoin Status ⛭");
  assert.match(sections[1] ?? "", /^Paths\n✓ DB path: \/tmp\/cogcoin-client\.sqlite\n✓ Bitcoin datadir: \/tmp\/cogcoin-bitcoin$/u);
  assert.match(sections[2] ?? "", /^Wallet\n✓ State: ready\n✓ Root: wallet-root-test\n✓ Unlock: unlocked until /u);
  assert.match(sections[3] ?? "", /^Services\n✓ Managed bitcoind: ready/u);
  assert.match(sections[4] ?? "", /^Local Inventory\n✓ Local identities: 3\n✓ Locally related domains: 2\n✓ Read-only identities: 0$/u);
  assert.equal(sections[5], "Pending Work\n✓ Status: none");
  assert.equal(report.endsWith("\n"), false);
  assert.doesNotMatch(report, /\n\nNext step:/);
  assert.doesNotMatch(report, /Recommended next step:/);
  assert.doesNotMatch(report, /Mutation note:/);
});

test("formatWalletOverviewReport shows only the highest-priority next step at the bottom", async () => {
  const mutationContext = await createReadyWalletReadContext(createWalletState({
    pendingMutations: [{
      mutationId: "mutation-1",
      kind: "register",
      registerKind: "root",
      domainName: "gamma",
      parentDomainName: null,
      senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      senderLocalIndex: 1,
      intentFingerprintHex: "ab".repeat(32),
      status: "broadcast-unknown",
      createdAtUnixMs: 1_700_000_000_000,
      lastUpdatedAtUnixMs: 1_700_000_000_001,
      attemptedTxid: null,
      attemptedWtxid: null,
      temporaryBuilderLockedOutpoints: [],
    }],
  }));
  mutationContext.nodeHealth = "starting";
  mutationContext.nodeMessage = "Bitcoin service is starting.";

  const mutationReport = formatWalletOverviewReport(mutationContext);
  assert.match(
    mutationReport,
    /\n\nNext step: Run `cogcoin sync` to bootstrap assumeutxo and the managed Bitcoin\/indexer state\.$/,
  );
  assert.doesNotMatch(mutationReport, /Rerun `cogcoin register gamma`/);

  const repairContext = await createReadyWalletReadContext(createWalletState({
    pendingMutations: [{
      mutationId: "mutation-2",
      kind: "register",
      registerKind: "root",
      domainName: "delta",
      parentDomainName: null,
      senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      senderLocalIndex: 1,
      intentFingerprintHex: "cd".repeat(32),
      status: "broadcast-unknown",
      createdAtUnixMs: 1_700_000_000_000,
      lastUpdatedAtUnixMs: 1_700_000_000_001,
      attemptedTxid: null,
      attemptedWtxid: null,
      temporaryBuilderLockedOutpoints: [],
    }],
  }));
  repairContext.bitcoind.health = "failed";
  repairContext.bitcoind.message = "Managed bitcoind stopped unexpectedly.";

  const repairReport = formatWalletOverviewReport(repairContext);
  assert.match(
    repairReport,
    /\n\nNext step: Run `cogcoin repair` to recover the managed bitcoind service and Core wallet replica\.$/,
  );
  assert.doesNotMatch(repairReport, /Rerun `cogcoin register delta`/);
});

test("status emits the stable json envelope in degraded mode", async () => {
  const stdout = new MemoryStream();

  const code = await runCli(["status", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => ({
      dataDir: "/tmp/bitcoin",
      databasePath: "/tmp/client.sqlite",
      localState: {
        availability: "locked",
        walletRootId: "wallet-root-test",
        state: null,
        source: "primary",
        unlockUntilUnixMs: null,
        hasPrimaryStateFile: true,
        hasBackupStateFile: false,
        hasUnlockSessionFile: false,
        message: "Wallet state exists but is currently locked.",
      },
      bitcoind: {
        health: "ready",
        status: null,
        message: null,
      },
      nodeStatus: null,
      nodeHealth: "stale-heartbeat",
      nodeMessage: "Bitcoin service heartbeat is stale.",
      indexer: {
        health: "catching-up",
        status: null,
        message: "Indexer is catching up.",
        snapshotTip: null,
      },
      snapshot: null,
      model: null,
      async close() {},
    }),
  });

  assert.equal(code, 0);
  const envelope = parseJsonEnvelope(stdout) as {
    schema: string;
    ok: boolean;
    warnings: string[];
    nextSteps: string[];
    data: {
      wallet: { availability: string };
      btc: { serviceHealth: string };
      availability: { wallet: { available: boolean }; bitcoind: { stale: boolean; publishState?: string | null } };
    };
  };
  assert.equal(envelope.schema, "cogcoin/status/v1");
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.wallet.availability, "locked");
  assert.equal(envelope.data.btc.serviceHealth, "stale-heartbeat");
  assert.equal(envelope.data.availability.wallet.available, false);
  assert.equal(envelope.data.availability.bitcoind.stale, false);
  assert.equal(envelope.data.availability.bitcoind.publishState, "stale-heartbeat");
  assert.ok(envelope.warnings.some((warning) => warning.includes("Wallet state is locked")));
  assert.ok(envelope.nextSteps.includes("cogcoin sync"));
});

test("status json surfaces additive indexer compatibility metadata", async () => {
  const stdout = new MemoryStream();
  const context = await createReadyWalletReadContext();

  const code = await runCli(["status", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => ({
      ...context,
      indexer: {
        health: "service-version-mismatch",
        status: createIndexerDaemonStatus(context.localState.walletRootId ?? "wallet-root-test", {
          state: "synced",
          snapshotSeq: "7",
          activeSnapshotCount: 2,
          backlogBlocks: 4,
          heartbeatAtUnixMs: 1_700_000_123_456,
          lastError: "indexer compatibility mismatch",
        }),
        message: "The live indexer daemon is running an incompatible service API version.",
        snapshotTip: null,
      },
      snapshot: null,
      mining: createMiningView({
        runtime: {
          indexerDaemonState: "service-version-mismatch",
          indexerHealth: "service-version-mismatch",
        },
      }),
    }),
  });

  assert.equal(code, 0);
  const envelope = parseJsonEnvelope(stdout) as {
    data: {
      availability: {
        indexer: {
          state: string;
          serviceApiVersion: string | null;
          schemaVersion: string | null;
          daemonInstanceId: string | null;
          snapshotSeq: string | null;
          heartbeatAtUnixMs: number | null;
          activeSnapshotCount: number | null;
          backlogBlocks: number | null;
          lastError: string | null;
        };
      };
    };
  };
  assert.equal(envelope.data.availability.indexer.state, "service-version-mismatch");
  assert.equal(envelope.data.availability.indexer.serviceApiVersion, INDEXER_DAEMON_SERVICE_API_VERSION);
  assert.equal(envelope.data.availability.indexer.schemaVersion, INDEXER_DAEMON_SCHEMA_VERSION);
  assert.equal(envelope.data.availability.indexer.daemonInstanceId, "daemon-1");
  assert.equal(envelope.data.availability.indexer.snapshotSeq, "7");
  assert.equal(envelope.data.availability.indexer.heartbeatAtUnixMs, 1_700_000_123_456);
  assert.equal(envelope.data.availability.indexer.activeSnapshotCount, 2);
  assert.equal(envelope.data.availability.indexer.backlogBlocks, 4);
  assert.equal(envelope.data.availability.indexer.lastError, "indexer compatibility mismatch");
});

test("wallet status json surfaces additive reorg metadata", async () => {
  const stdout = new MemoryStream();
  const readyContext = await createReadyWalletReadContext();
  readyContext.indexer = {
    health: "reorging",
    status: createIndexerDaemonStatus(readyContext.localState.walletRootId ?? "wallet-root-test", {
      state: "reorging",
      reorgDepth: 5,
    }),
    message: "Indexer daemon is replaying a reorg and refreshing the coherent snapshot.",
    snapshotTip: readyContext.snapshot?.tip ?? null,
  };
  readyContext.mining = createMiningView({
    runtime: {
      indexerHealth: "reorging",
      indexerDaemonState: "reorging",
      indexerReorgDepth: 5,
      note: "Mining remains stopped while the indexer replays a reorg and refreshes the coherent snapshot.",
    },
  });

  const code = await runCli(["wallet", "status", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => readyContext,
  });

  assert.equal(code, 0);
  const envelope = parseJsonEnvelope(stdout) as {
    schema: string;
    data: {
      availability: {
        indexer: {
          available: boolean;
          stale: boolean;
          state: string | null;
          reorgDepth: number | null;
        };
      };
    };
  };
  assert.equal(envelope.schema, "cogcoin/wallet-status/v1");
  assert.equal(envelope.data.availability.indexer.available, true);
  assert.equal(envelope.data.availability.indexer.stale, true);
  assert.equal(envelope.data.availability.indexer.state, "reorging");
  assert.equal(envelope.data.availability.indexer.reorgDepth, 5);
});

test("cli error presentation explains indexer compatibility mismatches clearly", () => {
  const serviceMismatch = formatCliTextError(new Error("indexer_daemon_service_version_mismatch"));
  const rootMismatch = formatCliTextError(new Error("indexer_daemon_wallet_root_mismatch"));
  const schemaMismatch = formatCliTextError(new Error("indexer_daemon_schema_mismatch"));

  assert.ok(serviceMismatch?.some((line) => line.includes("incompatible service API version")));
  assert.ok(serviceMismatch?.some((line) => line.includes("cogcoin repair")));
  assert.ok(rootMismatch?.some((line) => line.includes("different wallet root")));
  assert.ok(rootMismatch?.some((line) => line.includes("cogcoin repair")));
  assert.ok(schemaMismatch?.some((line) => line.includes("incompatible sqlite schema")));
});

test("wallet-aware read commands render coherent snapshot-backed views", async () => {
  const stdout = new MemoryStream();
  const readyContext = await createReadyWalletReadContext();

  const runRead = async (argv: string[]): Promise<string> => {
    const out = new MemoryStream();
    const code = await runCli(argv, {
      stdout: out,
      stderr: new MemoryStream(),
      ensureDirectory: async () => {},
      openWalletReadContext: async () => readyContext,
    });
    assert.equal(code, 0);
    return out.toString();
  };

  assert.match(await runRead(["status"]), /Local identities: 3/);
  assert.match(await runRead(["wallet", "status"]), /Funding identity: id:0/);
  assert.match(await runRead(["address"]), /BTC Funding Address/);
  assert.match(await runRead(["address"]), /Quickstart: Fund this wallet with about 0\.0015 BTC/);
  assert.match(await runRead(["address"]), /Next step: fund this wallet, then run cogcoin status/);
  assert.match(await runRead(["ids"]), /selectors id:1, domain:alpha/);
  assert.match(await runRead(["ids"]), /Next step: cogcoin register <root> --from <selector>/);
  assert.match(await runRead(["ids"]), /Next step: cogcoin send \.\.\. --from <selector>/);
  assert.match(await runRead(["ids"]), /Next step: cogcoin cog lock \.\.\. --from <selector>/);
  assert.match(await runRead(["balance"]), /0\.10000050 COG/);
  assert.match(await runRead(["cog", "balance"]), /Spendable total:/);
  assert.match(await runRead(["domains"]), /alpha  anchored  owned/);
  assert.match(await runRead(["show", "alpha"]), /Founding message:/);
  assert.match(await runRead(["fields", "alpha"]), /bio  id 1/);
  assert.match(await runRead(["field", "alpha", "bio"]), /Field ID: 1/);
});

test("read commands emit stable json, paging, and canonical alias schemas", async () => {
  const readyContext = await createReadyWalletReadContext();

  const idsStdout = new MemoryStream();
  const idsCode = await runCli(["ids", "--output", "json", "--limit", "2"], {
    stdout: idsStdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => readyContext,
  });

  assert.equal(idsCode, 0);
  const idsEnvelope = parseJsonEnvelope(idsStdout) as {
    schema: string;
    nextSteps: string[];
    data: {
      identities: Array<{ index: number }>;
      page: { limit: number | null; returned: number; truncated: boolean; totalKnown: number | null };
    };
  };
  assert.equal(idsEnvelope.schema, "cogcoin/ids/v1");
  assert.equal(idsEnvelope.data.identities.length, 2);
  assert.equal(idsEnvelope.data.page.limit, 2);
  assert.equal(idsEnvelope.data.page.returned, 2);
  assert.equal(idsEnvelope.data.page.truncated, true);
  assert.equal(idsEnvelope.data.page.totalKnown, 3);
  assert.deepEqual(idsEnvelope.nextSteps, [
    "cogcoin register <root> --from <selector>",
    "cogcoin send ... --from <selector>",
    "cogcoin cog lock ... --from <selector>",
  ]);

  const balanceStdout = new MemoryStream();
  const balanceCode = await runCli(["balance", "--output", "json"], {
    stdout: balanceStdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => readyContext,
  });
  assert.equal(balanceCode, 0);

  const aliasStdout = new MemoryStream();
  const aliasCode = await runCli(["cog", "balance", "--output", "json"], {
    stdout: aliasStdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => readyContext,
  });
  assert.equal(aliasCode, 0);

  const balanceEnvelope = parseJsonEnvelope(balanceStdout) as { schema: string; data: { totalCogtoshi: string | null } };
  const aliasEnvelope = parseJsonEnvelope(aliasStdout) as { schema: string; data: { totalCogtoshi: string | null } };
  assert.equal(balanceEnvelope.schema, "cogcoin/balance/v1");
  assert.equal(aliasEnvelope.schema, "cogcoin/balance/v1");
  assert.deepEqual(aliasEnvelope.data, balanceEnvelope.data);

  const walletAddressStdout = new MemoryStream();
  const walletAddressCode = await runCli(["wallet", "address", "--output", "json"], {
    stdout: walletAddressStdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => readyContext,
  });
  assert.equal(walletAddressCode, 0);
  const walletAddressEnvelope = parseJsonEnvelope(walletAddressStdout) as {
    schema: string;
    command: string;
    explanations: string[];
    nextSteps: string[];
  };
  assert.equal(walletAddressEnvelope.schema, "cogcoin/address/v1");
  assert.equal(walletAddressEnvelope.command, "cogcoin address");
  assert.ok(walletAddressEnvelope.explanations.some((line) => line.includes("0.0015 BTC")));
  assert.deepEqual(walletAddressEnvelope.nextSteps, [
    "fund this wallet, then run cogcoin status",
  ]);

  const walletIdsStdout = new MemoryStream();
  const walletIdsCode = await runCli(["wallet", "ids", "--output", "json", "--limit", "1"], {
    stdout: walletIdsStdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => readyContext,
  });
  assert.equal(walletIdsCode, 0);
  const walletIdsEnvelope = parseJsonEnvelope(walletIdsStdout) as {
    schema: string;
    command: string;
    nextSteps: string[];
  };
  assert.equal(walletIdsEnvelope.schema, "cogcoin/ids/v1");
  assert.equal(walletIdsEnvelope.command, "cogcoin ids");
  assert.deepEqual(walletIdsEnvelope.nextSteps, [
    "cogcoin register <root> --from <selector>",
    "cogcoin send ... --from <selector>",
    "cogcoin cog lock ... --from <selector>",
  ]);

  const domainListStdout = new MemoryStream();
  const domainListCode = await runCli(["domain", "list", "--output", "json"], {
    stdout: domainListStdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => readyContext,
  });
  assert.equal(domainListCode, 0);
  const domainListEnvelope = parseJsonEnvelope(domainListStdout) as {
    schema: string;
    command: string;
    data: { page: { limit: number | null } };
  };
  assert.equal(domainListEnvelope.schema, "cogcoin/domains/v1");
  assert.equal(domainListEnvelope.command, "cogcoin domains");
  assert.equal(domainListEnvelope.data.page.limit, 100);

  const domainShowStdout = new MemoryStream();
  const domainShowCode = await runCli(["domain", "show", "alpha", "--output", "json"], {
    stdout: domainShowStdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => readyContext,
  });
  assert.equal(domainShowCode, 0);
  const domainShowEnvelope = parseJsonEnvelope(domainShowStdout) as {
    schema: string;
    command: string;
  };
  assert.equal(domainShowEnvelope.schema, "cogcoin/show/v1");
  assert.equal(domainShowEnvelope.command, "cogcoin show alpha");
});

test("address guidance points first-run users to sync before funding when services still need bootstrap", async () => {
  const readyContext = await createReadyWalletReadContext();
  readyContext.bitcoind = {
    health: "starting",
    status: null,
    message: "Managed bitcoind service is still starting.",
  };
  readyContext.nodeHealth = "starting";
  readyContext.nodeMessage = "Bitcoin service is starting.";
  readyContext.indexer = {
    health: "starting",
    status: null,
    message: "Indexer daemon is still starting.",
    snapshotTip: null,
  };

  const textStdout = new MemoryStream();
  const textCode = await runCli(["address"], {
    stdout: textStdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => readyContext,
  });

  assert.equal(textCode, 0);
  assert.match(textStdout.toString(), /Quickstart: Fund this wallet with about 0\.0015 BTC/);
  assert.match(textStdout.toString(), /Next step: cogcoin sync/);
  assert.match(textStdout.toString(), /Next step: fund this wallet, then run cogcoin status/);

  const jsonStdout = new MemoryStream();
  const jsonCode = await runCli(["address", "--output", "json"], {
    stdout: jsonStdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => readyContext,
  });

  assert.equal(jsonCode, 0);
  const envelope = parseJsonEnvelope(jsonStdout) as {
    explanations: string[];
    nextSteps: string[];
  };
  assert.ok(envelope.explanations.some((line) => line.includes("0.0015 BTC")));
  assert.deepEqual(envelope.nextSteps, [
    "cogcoin sync",
    "fund this wallet, then run cogcoin status",
  ]);
});

test("domains filters apply before paging and stay consistent across text and json", async () => {
  const filteredContext = await createDomainFilterReadContext();

  const runRead = async (argv: string[]): Promise<string> => {
    const out = new MemoryStream();
    const code = await runCli(argv, {
      stdout: out,
      stderr: new MemoryStream(),
      ensureDirectory: async () => {},
      openWalletReadContext: async () => filteredContext,
    });
    assert.equal(code, 0);
    return out.toString();
  };

  const anchoredText = await runRead(["domains", "--anchored"]);
  assert.match(anchoredText, /alpha  anchored/);
  assert.match(anchoredText, /beta  anchored/);
  assert.doesNotMatch(anchoredText, /weatherbot/);

  const listedText = await runRead(["domain", "list", "--listed"]);
  assert.match(listedText, /beta  anchored/);
  assert.doesNotMatch(listedText, /alpha  anchored/);
  assert.doesNotMatch(listedText, /weatherbot/);

  const mineableText = await runRead(["domains", "--mineable"]);
  assert.match(mineableText, /alpha  anchored/);
  assert.doesNotMatch(mineableText, /beta  anchored/);
  assert.doesNotMatch(mineableText, /weatherbot/);

  const emptyText = await runRead(["domains", "--listed", "--mineable"]);
  assert.match(emptyText, /No locally related domains matched the active filters \(\-\-listed, \-\-mineable\)\./);

  const mineableJsonStdout = new MemoryStream();
  const mineableJsonCode = await runCli(["domains", "--mineable", "--output", "json"], {
    stdout: mineableJsonStdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => filteredContext,
  });
  assert.equal(mineableJsonCode, 0);
  const mineableEnvelope = parseJsonEnvelope(mineableJsonStdout) as {
    schema: string;
    data: {
      domains: Array<{ name: string }>;
      page: { returned: number; totalKnown: number | null };
    };
  };
  assert.equal(mineableEnvelope.schema, "cogcoin/domains/v1");
  assert.deepEqual(mineableEnvelope.data.domains.map((domain) => domain.name), ["alpha"]);
  assert.equal(mineableEnvelope.data.page.returned, 1);
  assert.equal(mineableEnvelope.data.page.totalKnown, 1);

  const anchoredPagedStdout = new MemoryStream();
  const anchoredPagedCode = await runCli(["domains", "--anchored", "--limit", "1", "--output", "json"], {
    stdout: anchoredPagedStdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => filteredContext,
  });
  assert.equal(anchoredPagedCode, 0);
  const anchoredPagedEnvelope = parseJsonEnvelope(anchoredPagedStdout) as {
    data: {
      domains: Array<{ name: string }>;
      page: { returned: number; truncated: boolean; totalKnown: number | null };
    };
  };
  assert.deepEqual(anchoredPagedEnvelope.data.domains.map((domain) => domain.name), ["alpha"]);
  assert.equal(anchoredPagedEnvelope.data.page.returned, 1);
  assert.equal(anchoredPagedEnvelope.data.page.truncated, true);
  assert.equal(anchoredPagedEnvelope.data.page.totalKnown, 2);

  const listedAliasStdout = new MemoryStream();
  const listedAliasCode = await runCli(["domain", "list", "--listed", "--output", "json"], {
    stdout: listedAliasStdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => filteredContext,
  });
  assert.equal(listedAliasCode, 0);
  const listedAliasEnvelope = parseJsonEnvelope(listedAliasStdout) as {
    schema: string;
    command: string;
    data: {
      domains: Array<{ name: string }>;
      page: { totalKnown: number | null };
    };
  };
  assert.equal(listedAliasEnvelope.schema, "cogcoin/domains/v1");
  assert.equal(listedAliasEnvelope.command, "cogcoin domains");
  assert.deepEqual(listedAliasEnvelope.data.domains.map((domain) => domain.name), ["beta"]);
  assert.equal(listedAliasEnvelope.data.page.totalKnown, 1);
});

test("locks read output suggests claim and reclaim follow-through from the first actionable displayed locks", async () => {
  const walletState = createWalletState({
    domains: createWalletState().domains.map((domain) => ({
      ...domain,
      canonicalChainStatus: "anchored",
    })),
  });
  const readyContext = await createReadyWalletReadContext(walletState);
  assert.ok(readyContext.snapshot !== null);
  const currentHeight = readyContext.snapshot.state.history.currentHeight ?? 0;
  const snapshotState = structuredClone(readyContext.snapshot.state);

  snapshotState.consensus.locks.set(90, {
    lockId: 90,
    lockerScriptPubKey: Buffer.from("0014ed495c1face9da3c7028519dbb36576c37f90e56", "hex"),
    amount: 50n,
    condition: Buffer.alloc(32, 7),
    timeoutHeight: currentHeight + 12,
    recipientDomainId: 1,
    creationHeight: currentHeight - 1,
  });
  snapshotState.consensus.locks.set(91, {
    lockId: 91,
    lockerScriptPubKey: Buffer.from("00145f5a03d6c7c88648b5f947459b769008ced5a020", "hex"),
    amount: 70n,
    condition: Buffer.alloc(32, 9),
    timeoutHeight: currentHeight - 1,
    recipientDomainId: 2,
    creationHeight: currentHeight - 20,
  });

  const snapshot = {
    ...readyContext.snapshot,
    state: snapshotState,
  };
  const contextWithLocks: WalletReadContext = {
    ...readyContext,
    snapshot,
    model: createWalletReadModel(walletState, snapshot),
  };

  const textStdout = new MemoryStream();
  const textCode = await runCli(["cog", "locks"], {
    stdout: textStdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => contextWithLocks,
  });
  assert.equal(textCode, 0);
  assert.match(textStdout.toString(), /Next step: cogcoin claim 90 --preimage <32-byte-hex>/);
  assert.match(textStdout.toString(), /Next step: cogcoin reclaim 91/);

  const jsonStdout = new MemoryStream();
  const jsonCode = await runCli(["locks", "--output", "json"], {
    stdout: jsonStdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => contextWithLocks,
  });
  assert.equal(jsonCode, 0);
  const jsonEnvelope = parseJsonEnvelope(jsonStdout) as {
    schema: string;
    nextSteps: string[];
  };
  assert.equal(jsonEnvelope.schema, "cogcoin/locks/v1");
  assert.deepEqual(jsonEnvelope.nextSteps, [
    "cogcoin claim 90 --preimage <32-byte-hex>",
    "cogcoin reclaim 91",
  ]);
});

test("wallet mutation commands pass through --yes and blocked errors use shared text sections", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  let observedAssumeYes = false;

  const code = await runCli(["buy", "alpha", "--yes"], {
    stdout,
    stderr,
    buyDomain: async (options) => {
      observedAssumeYes = options.assumeYes ?? false;
      throw new Error("wallet_locked");
    },
  });

  assert.equal(code, 4);
  assert.equal(observedAssumeYes, true);
  assert.match(stderr.toString(), /What happened: Wallet is locked\./);
  assert.match(stderr.toString(), /Why: This command needs access to the unlocked local wallet state/);
  assert.match(stderr.toString(), /Next: Run `cogcoin unlock --for 15m` and retry\./);
});

test("repair indexer reset requirements are presented clearly in text mode", async () => {
  const stderr = new MemoryStream();

  const code = await runCli(["repair"], {
    stdout: new MemoryStream(),
    stderr,
    walletSecretProvider: {} as never,
    repairWallet: async () => {
      throw new Error("wallet_repair_indexer_reset_requires_yes");
    },
  });

  assert.equal(code, 4);
  assert.match(stderr.toString(), /What happened: Repair needs permission to reset the local indexer database\./);
  assert.match(stderr.toString(), /Why: The local indexer database could not be opened as a healthy Cogcoin store/);
  assert.match(stderr.toString(), /Next: Rerun `cogcoin repair --yes` to allow repair to recreate the local indexer database\./);
});

test("show missing domain returns not-found json with exit code 3", async () => {
  const readyContext = await createReadyWalletReadContext();
  const stdout = new MemoryStream();

  const code = await runCli(["show", "missing-domain", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => readyContext,
  });

  assert.equal(code, 3);
  const envelope = parseJsonEnvelope(stdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(envelope.schema, "cogcoin/show/v1");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "not_found");
  assert.equal(envelope.error.message, "Domain not found.");
});

test("transfer owner resolution errors are presented clearly in text mode", async () => {
  const stderr = new MemoryStream();

  const code = await runCli(["transfer", "alpha", "--to", "spk:00141111111111111111111111111111111111111111"], {
    stdout: new MemoryStream(),
    stderr,
    walletSecretProvider: {} as never,
    transferDomain: async () => {
      throw new Error("wallet_transfer_owner_not_locally_controlled");
    },
  });

  assert.equal(code, 5);
  assert.match(stderr.toString(), /What happened: Domain owner is not locally controlled\./);
  assert.match(stderr.toString(), /Why: This command must be authored by the current unanchored domain owner/);
  assert.match(stderr.toString(), /Next: Inspect the current owner with `cogcoin show <domain>`/);
});

test("sell owner resolution errors are presented clearly in stable json", async () => {
  const stdout = new MemoryStream();

  const code = await runCli(["sell", "alpha", "1", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    sellDomain: async () => {
      throw new Error("wallet_sell_owner_read_only");
    },
  });

  assert.equal(code, 5);
  const envelope = parseJsonEnvelope(stdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string; details: { rawMessage?: string } };
    explanations: string[];
    nextSteps: string[];
  };
  assert.equal(envelope.schema, "cogcoin/sell/v1");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "wallet_sell_owner_read_only");
  assert.equal(envelope.error.message, "Domain owner is read-only.");
  assert.equal(envelope.error.details.rawMessage, "wallet_sell_owner_read_only");
  assert.match(envelope.explanations[0] ?? "", /tracked locally for visibility/);
  assert.match(envelope.nextSteps[0] ?? "", /Use the wallet that controls the owner identity/);
});

test("domain endpoint owner resolution errors are presented clearly in text mode", async () => {
  const stderr = new MemoryStream();

  const code = await runCli(["domain", "endpoint", "clear", "alpha"], {
    stdout: new MemoryStream(),
    stderr,
    walletSecretProvider: {} as never,
    clearDomainEndpoint: async () => {
      throw new Error("wallet_domain_endpoint_owner_not_locally_controlled");
    },
  });

  assert.equal(code, 5);
  assert.match(stderr.toString(), /What happened: Anchored domain owner is not locally controlled\./);
  assert.match(stderr.toString(), /Why: This anchored domain-admin command must be authored by the current anchored owner/);
  assert.match(stderr.toString(), /Next: Inspect the current owner with `cogcoin show <domain>`/);
});

test("domain canonical owner read-only errors are presented clearly in stable json", async () => {
  const stdout = new MemoryStream();

  const code = await runCli(["domain", "canonical", "alpha", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    setDomainCanonical: async () => {
      throw new Error("wallet_domain_canonical_owner_read_only");
    },
  });

  assert.equal(code, 5);
  const envelope = parseJsonEnvelope(stdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string; details: { rawMessage?: string } };
    explanations: string[];
    nextSteps: string[];
  };
  assert.equal(envelope.schema, "cogcoin/domain-canonical/v1");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "wallet_domain_canonical_owner_read_only");
  assert.equal(envelope.error.message, "Anchored domain owner is read-only.");
  assert.equal(envelope.error.details.rawMessage, "wallet_domain_canonical_owner_read_only");
  assert.match(envelope.explanations[0] ?? "", /tracked locally for visibility/);
  assert.match(envelope.nextSteps[0] ?? "", /Use the wallet that controls the anchored owner identity/);
});

test("field create owner resolution errors are presented clearly in text mode", async () => {
  const stderr = new MemoryStream();

  const code = await runCli(["field", "create", "alpha", "tagline"], {
    stdout: new MemoryStream(),
    stderr,
    walletSecretProvider: {} as never,
    createField: async () => {
      throw new Error("wallet_field_create_owner_not_locally_controlled");
    },
  });

  assert.equal(code, 5);
  assert.match(stderr.toString(), /What happened: Anchored field owner is not locally controlled\./);
  assert.match(stderr.toString(), /Why: Field mutations must be authored by the current anchored owner of the domain/);
  assert.match(stderr.toString(), /Next: Inspect the current owner with `cogcoin show <domain>`/);
});

test("field set owner read-only errors are presented clearly in stable json", async () => {
  const stdout = new MemoryStream();

  const code = await runCli(["field", "set", "alpha", "tagline", "--text", "hello", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    setField: async () => {
      throw new Error("wallet_field_set_owner_read_only");
    },
  });

  assert.equal(code, 5);
  const envelope = parseJsonEnvelope(stdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string; details: { rawMessage?: string } };
    explanations: string[];
    nextSteps: string[];
  };
  assert.equal(envelope.schema, "cogcoin/field-set/v1");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "wallet_field_set_owner_read_only");
  assert.equal(envelope.error.message, "Anchored field owner is read-only.");
  assert.equal(envelope.error.details.rawMessage, "wallet_field_set_owner_read_only");
  assert.match(envelope.explanations[0] ?? "", /tracked locally for visibility/);
  assert.match(envelope.nextSteps[0] ?? "", /Use the wallet that controls the anchored owner identity/);
});

test("reputation give source owner resolution errors are presented clearly in text mode", async () => {
  const stderr = new MemoryStream();

  const code = await runCli(["rep", "give", "alpha", "beta", "1"], {
    stdout: new MemoryStream(),
    stderr,
    walletSecretProvider: {} as never,
    giveReputation: async () => {
      throw new Error("wallet_rep_give_source_owner_not_locally_controlled");
    },
  });

  assert.equal(code, 5);
  assert.match(stderr.toString(), /What happened: Anchored reputation source owner is not locally controlled\./);
  assert.match(stderr.toString(), /Why: Reputation mutations must be authored by the current anchored owner of the source domain/);
  assert.match(stderr.toString(), /Next: Inspect the current source-domain owner with `cogcoin show <domain>`/);
});

test("reputation revoke source owner read-only errors are presented clearly in stable json", async () => {
  const stdout = new MemoryStream();

  const code = await runCli(["rep", "revoke", "alpha", "beta", "1", "--output", "json"], {
    stdout,
    stderr: new MemoryStream(),
    walletSecretProvider: {} as never,
    revokeReputation: async () => {
      throw new Error("wallet_rep_revoke_source_owner_read_only");
    },
  });

  assert.equal(code, 5);
  const envelope = parseJsonEnvelope(stdout) as {
    schema: string;
    ok: boolean;
    error: { code: string; message: string; details: { rawMessage?: string } };
    explanations: string[];
    nextSteps: string[];
  };
  assert.equal(envelope.schema, "cogcoin/rep-revoke/v1");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "wallet_rep_revoke_source_owner_read_only");
  assert.equal(envelope.error.message, "Anchored reputation source owner is read-only.");
  assert.equal(envelope.error.details.rawMessage, "wallet_rep_revoke_source_owner_read_only");
  assert.match(envelope.explanations[0] ?? "", /tracked locally for visibility/);
  assert.match(envelope.nextSteps[0] ?? "", /Use the wallet that controls the anchored source-domain owner identity/);
});

test("wallet status and domain views surface pending transfer, sell, unsell, and buy intents", async () => {
  const readyContext = await createReadyWalletReadContext();
  readyContext.localState.state!.pendingMutations = [
    {
      mutationId: "mutation-transfer",
      kind: "transfer",
      domainName: "alpha",
      parentDomainName: null,
      senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      senderLocalIndex: 1,
      recipientScriptPubKeyHex: "00141111111111111111111111111111111111111111",
      priceCogtoshi: null,
      intentFingerprintHex: "11".repeat(32),
      status: "live",
      createdAtUnixMs: 1_700_000_000_000,
      lastUpdatedAtUnixMs: 1_700_000_100_000,
      attemptedTxid: "aa".repeat(32),
      attemptedWtxid: "bb".repeat(32),
      temporaryBuilderLockedOutpoints: [],
    },
    {
      mutationId: "mutation-sell",
      kind: "sell",
      domainName: "beta",
      parentDomainName: null,
      senderScriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
      senderLocalIndex: 2,
      recipientScriptPubKeyHex: null,
      priceCogtoshi: 250n,
      intentFingerprintHex: "22".repeat(32),
      status: "broadcast-unknown",
      createdAtUnixMs: 1_700_000_000_000,
      lastUpdatedAtUnixMs: 1_700_000_100_000,
      attemptedTxid: "cc".repeat(32),
      attemptedWtxid: "dd".repeat(32),
      temporaryBuilderLockedOutpoints: [],
    },
    {
      mutationId: "mutation-unsell",
      kind: "sell",
      domainName: "alpha",
      parentDomainName: null,
      senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      senderLocalIndex: 1,
      recipientScriptPubKeyHex: null,
      priceCogtoshi: 0n,
      intentFingerprintHex: "33".repeat(32),
      status: "live",
      createdAtUnixMs: 1_700_000_000_000,
      lastUpdatedAtUnixMs: 1_700_000_100_000,
      attemptedTxid: "ee".repeat(32),
      attemptedWtxid: "ff".repeat(32),
      temporaryBuilderLockedOutpoints: [],
    },
    {
      mutationId: "mutation-buy",
      kind: "buy",
      domainName: "beta",
      parentDomainName: null,
      senderScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
      senderLocalIndex: 0,
      recipientScriptPubKeyHex: null,
      priceCogtoshi: 500n,
      intentFingerprintHex: "44".repeat(32),
      status: "live",
      createdAtUnixMs: 1_700_000_000_000,
      lastUpdatedAtUnixMs: 1_700_000_100_000,
      attemptedTxid: "11".repeat(32),
      attemptedWtxid: "22".repeat(32),
      temporaryBuilderLockedOutpoints: [],
    },
  ];

  const runRead = async (argv: string[]): Promise<string> => {
    const out = new MemoryStream();
    const code = await runCli(argv, {
      stdout: out,
      stderr: new MemoryStream(),
      ensureDirectory: async () => {},
      openWalletReadContext: async () => readyContext,
    });
    assert.equal(code, 0);
    return out.toString();
  };

  assert.match(await runRead(["status"]), /✗ Mutation: transfer alpha  live/u);
  assert.match(await runRead(["status"]), /✗ Mutation: sell beta  broadcast-unknown/u);
  assert.match(await runRead(["status"]), /✗ Mutation: buy beta  live/u);
  assert.match(await runRead(["domains"]), /alpha  anchored  owned.*pending transfer:live,unsell:live/);
  assert.match(await runRead(["domains"]), /beta  anchored  owned.*pending sell:broadcast-unknown,buy:live/);
  assert.match(await runRead(["show", "alpha"]), /Pending mutation: transfer  live/);
  assert.match(await runRead(["show", "alpha"]), /Pending mutation: unsell  live/);
  assert.match(await runRead(["show", "beta"]), /Pending mutation: sell  broadcast-unknown/);
  assert.match(await runRead(["show", "beta"]), /Pending mutation: buy  live/);
});

test("wallet status and domain views surface pending endpoint, delegate, miner, and canonical intents", async () => {
  const readyContext = await createReadyWalletReadContext();
  readyContext.localState.state!.pendingMutations = [
    {
      mutationId: "mutation-endpoint",
      kind: "endpoint",
      domainName: "alpha",
      parentDomainName: null,
      senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      senderLocalIndex: 1,
      recipientScriptPubKeyHex: null,
      endpointValueHex: "68656c6c6f",
      intentFingerprintHex: "55".repeat(32),
      status: "live",
      createdAtUnixMs: 1_700_000_000_000,
      lastUpdatedAtUnixMs: 1_700_000_100_000,
      attemptedTxid: "11".repeat(32),
      attemptedWtxid: "22".repeat(32),
      temporaryBuilderLockedOutpoints: [],
    },
    {
      mutationId: "mutation-delegate",
      kind: "delegate",
      domainName: "alpha",
      parentDomainName: null,
      senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      senderLocalIndex: 1,
      recipientScriptPubKeyHex: "00141111111111111111111111111111111111111111",
      intentFingerprintHex: "66".repeat(32),
      status: "broadcast-unknown",
      createdAtUnixMs: 1_700_000_000_000,
      lastUpdatedAtUnixMs: 1_700_000_100_000,
      attemptedTxid: "33".repeat(32),
      attemptedWtxid: "44".repeat(32),
      temporaryBuilderLockedOutpoints: [],
    },
    {
      mutationId: "mutation-miner",
      kind: "miner",
      domainName: "beta",
      parentDomainName: null,
      senderScriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
      senderLocalIndex: 2,
      recipientScriptPubKeyHex: null,
      intentFingerprintHex: "77".repeat(32),
      status: "live",
      createdAtUnixMs: 1_700_000_000_000,
      lastUpdatedAtUnixMs: 1_700_000_100_000,
      attemptedTxid: "55".repeat(32),
      attemptedWtxid: "66".repeat(32),
      temporaryBuilderLockedOutpoints: [],
    },
    {
      mutationId: "mutation-canonical",
      kind: "canonical",
      domainName: "beta",
      parentDomainName: null,
      senderScriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
      senderLocalIndex: 2,
      recipientScriptPubKeyHex: null,
      intentFingerprintHex: "88".repeat(32),
      status: "live",
      createdAtUnixMs: 1_700_000_000_000,
      lastUpdatedAtUnixMs: 1_700_000_100_000,
      attemptedTxid: "77".repeat(32),
      attemptedWtxid: "88".repeat(32),
      temporaryBuilderLockedOutpoints: [],
    },
  ];

  const runRead = async (argv: string[]): Promise<string> => {
    const out = new MemoryStream();
    const code = await runCli(argv, {
      stdout: out,
      stderr: new MemoryStream(),
      ensureDirectory: async () => {},
      openWalletReadContext: async () => readyContext,
    });
    assert.equal(code, 0);
    return out.toString();
  };

  assert.match(await runRead(["status"]), /✗ Mutation: endpoint alpha  live/u);
  assert.match(await runRead(["status"]), /✗ Mutation: delegate alpha  broadcast-unknown/u);
  assert.match(await runRead(["status"]), /✗ Mutation: miner-clear beta  live/u);
  assert.match(await runRead(["status"]), /✗ Mutation: canonical beta  live/u);
  assert.match(await runRead(["domains"]), /alpha  anchored  owned.*pending endpoint:live,delegate:broadcast-unknown/);
  assert.match(await runRead(["domains"]), /beta  anchored  owned.*pending miner-clear:live,canonical:live/);
  assert.match(await runRead(["show", "alpha"]), /Pending mutation: endpoint  live/);
  assert.match(await runRead(["show", "alpha"]), /Pending mutation: delegate  broadcast-unknown/);
  assert.match(await runRead(["show", "beta"]), /Pending mutation: miner-clear  live/);
  assert.match(await runRead(["show", "beta"]), /Pending mutation: canonical  live/);
});

test("wallet status and show views surface pending reputation intents and chain reputation totals", async () => {
  const readyContext = await createReadyWalletReadContext();
  readyContext.localState.state!.pendingMutations = [
    {
      mutationId: "mutation-rep-give",
      kind: "rep-give",
      domainName: "alpha",
      parentDomainName: null,
      senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      senderLocalIndex: 1,
      recipientDomainName: "beta",
      amountCogtoshi: 200n,
      reviewPayloadHex: "aa".repeat(8),
      intentFingerprintHex: "90".repeat(32),
      status: "live",
      createdAtUnixMs: 1_700_000_000_000,
      lastUpdatedAtUnixMs: 1_700_000_100_000,
      attemptedTxid: "91".repeat(32),
      attemptedWtxid: "92".repeat(32),
      temporaryBuilderLockedOutpoints: [],
    },
    {
      mutationId: "mutation-rep-revoke",
      kind: "rep-revoke",
      domainName: "alpha",
      parentDomainName: null,
      senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      senderLocalIndex: 1,
      recipientDomainName: "beta",
      amountCogtoshi: 50n,
      reviewPayloadHex: null,
      intentFingerprintHex: "93".repeat(32),
      status: "broadcast-unknown",
      createdAtUnixMs: 1_700_000_000_000,
      lastUpdatedAtUnixMs: 1_700_000_100_000,
      attemptedTxid: "94".repeat(32),
      attemptedWtxid: "95".repeat(32),
      temporaryBuilderLockedOutpoints: [],
    },
  ];

  const alphaChain = readyContext.snapshot!.state.consensus.domainsById.get(1)!;
  readyContext.snapshot!.state.consensus.domainsById.set(1, {
    ...alphaChain,
    selfStake: 100n,
    supportedStake: 25n,
    totalSupported: 125n,
    totalRevoked: 5n,
  });
  const betaChain = readyContext.snapshot!.state.consensus.domainsById.get(2)!;
  readyContext.snapshot!.state.consensus.domainsById.set(2, {
    ...betaChain,
    selfStake: 0n,
    supportedStake: 300n,
    totalSupported: 350n,
    totalRevoked: 50n,
  });
  readyContext.snapshot!.state.consensus.supportByPair.set("1:2", 150n);
  readyContext.model = createWalletReadModel(readyContext.localState.state!, readyContext.snapshot!);

  const runRead = async (argv: string[]): Promise<string> => {
    const out = new MemoryStream();
    const code = await runCli(argv, {
      stdout: out,
      stderr: new MemoryStream(),
      ensureDirectory: async () => {},
      openWalletReadContext: async () => readyContext,
    });
    assert.equal(code, 0);
    return out.toString();
  };

  assert.match(await runRead(["status"]), /✗ Mutation: rep-give alpha->beta  live/u);
  assert.match(await runRead(["status"]), /✗ Mutation: rep-revoke alpha->beta  broadcast-unknown/u);
  assert.match(await runRead(["status"]), /Rerun `cogcoin rep revoke alpha beta \.\.\.` to reconcile the pending reputation revoke/);
  assert.match(await runRead(["show", "alpha"]), /Reputation self-stake: 0\.00000100 COG/);
  assert.match(await runRead(["show", "alpha"]), /Reputation total supported: 0\.00000125 COG/);
  assert.match(await runRead(["show", "alpha"]), /Pending mutation: rep-give alpha->beta  live/);
  assert.match(await runRead(["show", "beta"]), /Reputation supported stake: 0\.00000300 COG/);
  assert.match(await runRead(["show", "beta"]), /Reputation total revoked: 0\.00000050 COG/);
  assert.match(await runRead(["show", "beta"]), /Pending mutation: rep-revoke alpha->beta  broadcast-unknown/);
});

test("wallet field views surface pending field mutations and field families honestly", async () => {
  const readyContext = await createReadyWalletReadContext(createWalletState({
    pendingMutations: [{
      mutationId: "mutation-field-set",
      kind: "field-set",
      domainName: "alpha",
      parentDomainName: null,
      senderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      senderLocalIndex: 1,
      fieldName: "bio",
      fieldId: 1,
      fieldPermanent: false,
      fieldFormat: 2,
      fieldValueHex: "68656c6c6f",
      intentFingerprintHex: "99".repeat(32),
      status: "live",
      createdAtUnixMs: 1_700_000_000_000,
      lastUpdatedAtUnixMs: 1_700_000_100_000,
      attemptedTxid: "11".repeat(32),
      attemptedWtxid: "22".repeat(32),
      temporaryBuilderLockedOutpoints: [],
    }],
    proactiveFamilies: [{
      familyId: "family-field-1",
      type: "field",
      status: "broadcast-unknown",
      intentFingerprintHex: "aa".repeat(32),
      createdAtUnixMs: 1_700_000_000_000,
      lastUpdatedAtUnixMs: 1_700_000_100_000,
      domainName: "beta",
      domainId: 2,
      sourceSenderLocalIndex: 2,
      sourceSenderScriptPubKeyHex: "00145f5a03d6c7c88648b5f947459b769008ced5a020",
      fieldName: "tagline",
      expectedFieldId: 2,
      fieldPermanent: true,
      fieldFormat: 2,
      fieldValueHex: "68656c6c6f",
      currentStep: "tx2",
      tx1: {
        status: "live",
        attemptedTxid: "33".repeat(32),
        attemptedWtxid: "44".repeat(32),
        temporaryBuilderLockedOutpoints: [],
        rawHex: "deadbeef",
      },
      tx2: {
        status: "broadcast-unknown",
        attemptedTxid: "55".repeat(32),
        attemptedWtxid: "66".repeat(32),
        temporaryBuilderLockedOutpoints: [],
        rawHex: "feedface",
      },
    }],
  }));

  const runRead = async (argv: string[]): Promise<string> => {
    const out = new MemoryStream();
    const code = await runCli(argv, {
      stdout: out,
      stderr: new MemoryStream(),
      ensureDirectory: async () => {},
      openWalletReadContext: async () => readyContext,
    });
    assert.equal(code, 0);
    return out.toString();
  };

  assert.match(await runRead(["status"]), /✗ Mutation: field-set alpha\.bio  live/u);
  assert.match(await runRead(["status"]), /✗ Field family: beta\.tagline  broadcast-unknown  step tx2/u);
  assert.match(await runRead(["status"]), /Next step: Rerun `cogcoin field create beta tagline \.\.\.`/);
  assert.match(await runRead(["domains"]), /alpha  anchored  owned.*field-pending bio:field-set:live/);
  assert.match(await runRead(["domains"]), /beta  anchored  owned.*field-pending tagline:family:broadcast-unknown:tx2/);
  assert.match(await runRead(["show", "alpha"]), /Pending field mutation: bio  field-set  live/);
  assert.match(await runRead(["show", "beta"]), /Pending field family: tagline  broadcast-unknown  step tx2/);
  assert.match(await runRead(["fields", "alpha"]), /Pending field mutation: bio  field-set  live/);
  assert.match(await runRead(["field", "alpha", "bio"]), /Pending field mutation: field-set  live/);
});

test("wallet read commands explain locked wallets without inventing empty local state", async () => {
  const stdout = new MemoryStream();
  const code = await runCli(["ids"], {
    stdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => ({
      dataDir: "/tmp/bitcoin",
      databasePath: "/tmp/client.sqlite",
      localState: {
        availability: "locked",
        walletRootId: null,
        state: null,
        source: null,
        unlockUntilUnixMs: null,
        hasPrimaryStateFile: true,
        hasBackupStateFile: false,
        hasUnlockSessionFile: true,
        message: "Wallet state exists but is currently locked.",
      },
      bitcoind: {
        health: "ready",
        status: null,
        message: null,
      },
      nodeStatus: null,
      nodeHealth: "synced",
      nodeMessage: null,
      indexer: {
        health: "synced",
        status: null,
        message: null,
        snapshotTip: null,
      },
      snapshot: null,
      model: null,
      async close() {},
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.toString(), /Wallet state: locked/);
});

test("wallet-aware status recommends repair for corrupt local state", async () => {
  const stdout = new MemoryStream();
  const code = await runCli(["status"], {
    stdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => ({
      dataDir: "/tmp/bitcoin",
      databasePath: "/tmp/client.sqlite",
      localState: {
        availability: "local-state-corrupt",
        walletRootId: null,
        state: null,
        source: null,
        unlockUntilUnixMs: null,
        hasPrimaryStateFile: true,
        hasBackupStateFile: true,
        hasUnlockSessionFile: true,
        message: "local-state-corrupt",
      },
      bitcoind: {
        health: "ready",
        status: null,
        message: null,
      },
      nodeStatus: null,
      nodeHealth: "synced",
      nodeMessage: null,
      indexer: {
        health: "synced",
        status: null,
        message: null,
        snapshotTip: null,
      },
      snapshot: null,
      model: null,
      async close() {},
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.toString(), /Wallet\n✗ State: local-state-corrupt/u);
  assert.match(stdout.toString(), /Next step: Run `cogcoin repair`/);
});

test("wallet-aware status surfaces active pending registrations and reconciliation guidance", async () => {
  const stdout = new MemoryStream();
  const code = await runCli(["status"], {
    stdout,
    stderr: new MemoryStream(),
    ensureDirectory: async () => {},
    openWalletReadContext: async () => ({
      ...(await createReadyWalletReadContext()),
      localState: {
        availability: "ready",
        walletRootId: "wallet-root-test",
        state: createWalletState({
          pendingMutations: [{
            mutationId: "mutation-1",
            kind: "register",
            registerKind: "root",
            domainName: "weatherbot",
            parentDomainName: null,
            senderScriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
            senderLocalIndex: 0,
            intentFingerprintHex: "ab".repeat(32),
            status: "broadcast-unknown",
            createdAtUnixMs: 1_700_000_000_000,
            lastUpdatedAtUnixMs: 1_700_000_100_000,
            attemptedTxid: "55".repeat(32),
            attemptedWtxid: "66".repeat(32),
            temporaryBuilderLockedOutpoints: [],
          }],
        }),
        source: "primary",
        unlockUntilUnixMs: 1_700_000_900_000,
        hasPrimaryStateFile: true,
        hasBackupStateFile: false,
        hasUnlockSessionFile: true,
        message: null,
      },
    }),
  });

  assert.equal(code, 0);
  assert.match(stdout.toString(), /✗ Mutation: register weatherbot  broadcast-unknown/u);
  assert.match(stdout.toString(), /Next step: Rerun `cogcoin register weatherbot`/);
});

test("wallet status and domain views surface pending anchor family state and guidance", async () => {
  const readyContext = await createReadyWalletReadContext(createWalletState({
    domains: createWalletState().domains.map((domain) =>
      domain.name === "alpha"
        ? {
          ...domain,
          localAnchorIntent: "tx1-live",
        }
        : domain
    ),
    proactiveFamilies: [{
      familyId: "family-anchor-1",
      type: "anchor",
      status: "broadcast-unknown",
      intentFingerprintHex: "99".repeat(32),
      createdAtUnixMs: 1_700_000_000_000,
      lastUpdatedAtUnixMs: 1_700_000_100_000,
      domainName: "alpha",
      domainId: 1,
      sourceSenderLocalIndex: 1,
      sourceSenderScriptPubKeyHex: "001400a654e135b542d1a605d607c08e2218a178788d",
      reservedDedicatedIndex: 3,
      reservedScriptPubKeyHex: "00141111111111111111111111111111111111111111",
      foundingMessageText: null,
      foundingMessagePayloadHex: null,
      listingCancelCommitted: true,
      currentStep: "tx1",
      tx1: {
        status: "broadcast-unknown",
        attemptedTxid: "55".repeat(32),
        attemptedWtxid: "66".repeat(32),
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
    }],
  }));

  const runRead = async (argv: string[]): Promise<string> => {
    const out = new MemoryStream();
    const code = await runCli(argv, {
      stdout: out,
      stderr: new MemoryStream(),
      ensureDirectory: async () => {},
      openWalletReadContext: async () => readyContext,
    });
    assert.equal(code, 0);
    return out.toString();
  };

  assert.match(await runRead(["status"]), /✗ Anchor family: alpha  broadcast-unknown  step tx1  index 3/u);
  assert.match(await runRead(["status"]), /Rerun `cogcoin anchor alpha`/);
  assert.match(await runRead(["wallet", "status"]), /Pending anchor family: alpha  broadcast-unknown  step tx1  index 3/);
  assert.match(await runRead(["domains"]), /alpha  anchored  owned.*anchor tx1-live/);
  assert.match(await runRead(["show", "alpha"]), /Local anchor intent: tx1-live/);
  assert.match(await runRead(["show", "alpha"]), /Pending anchor family: broadcast-unknown  step tx1  index 3/);
});

test("sync uses resolved defaults and prints a concise summary", async () => {
  const stdout = new MemoryStream();
  const runtimePaths = createTempWalletPaths("/tmp/cogcoin-cli-sync-root");
  const opened: {
    dbPath?: string;
    dataDir?: string;
    ensured?: string;
    progressOutput?: string;
    walletRootId?: string;
    completionScenePlayed?: boolean;
  } = {};

  const code = await runCli(["sync"], {
    stdout,
    stderr: new MemoryStream(),
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin-client.sqlite",
    resolveDefaultBitcoindDataDir: () => "/tmp/cogcoin-bitcoin",
    ensureDirectory: async (path) => {
      opened.ensured = path;
    },
    resolveWalletRuntimePaths: () => runtimePaths,
    loadRawWalletStateEnvelope: async () => ({
      source: "primary",
      envelope: {
        format: "cogcoin-local-wallet-state",
        cipher: "aes-256-gcm",
        nonce: "nonce",
        ciphertext: "ciphertext",
        authTag: "auth-tag",
        walletRootIdHint: "wallet-root-sync",
      } as never,
    }),
    loadUnlockSession: async () => {
      throw new Error("should-not-read-unlock-session");
    },
    loadWalletExplicitLock: async () => {
      throw new Error("should-not-read-explicit-lock");
    },
    openSqliteStore: async ({ filename }) => {
      opened.dbPath = filename;
      return createNoopStore();
    },
    openManagedBitcoindClient: async ({ dataDir, progressOutput, walletRootId }) => {
      opened.dataDir = dataDir;
      opened.progressOutput = progressOutput;
      opened.walletRootId = walletRootId;
      return {
        async syncToTip() {
          return {
            appliedBlocks: 12,
            rewoundBlocks: 3,
            endingHeight: 910005,
            bestHeight: 910010,
          };
        },
        async playSyncCompletionScene() {
          opened.completionScenePlayed = true;
        },
        async startFollowingTip() {
          throw new Error("unreachable");
        },
        async getNodeStatus() {
          return {
            indexedTip: {
              height: 910005,
              blockHashHex: "aa",
              stateHashHex: "bb",
            },
            nodeBestHeight: 910010,
          };
        },
        async close() {},
      };
    },
  });

  assert.equal(code, 0);
  assert.equal(opened.dbPath, "/tmp/cogcoin-client.sqlite");
  assert.equal(opened.dataDir, "/tmp/cogcoin-bitcoin");
  assert.equal(opened.ensured, "/tmp");
  assert.equal(opened.progressOutput, "auto");
  assert.equal(opened.walletRootId, "wallet-root-sync");
  assert.equal(opened.completionScenePlayed, true);
  assert.match(stdout.toString(), /Applied blocks: 12/);
  assert.match(stdout.toString(), /Rewound blocks: 3/);
  assert.match(stdout.toString(), /Node best height: 910010/);
});

test("sync prints next-step instructions for known managed-sync failures", async () => {
  const stderr = new MemoryStream();

  const code = await runCli(["sync"], {
    stdout: new MemoryStream(),
    stderr,
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin-client.sqlite",
    resolveDefaultBitcoindDataDir: () => "/tmp/cogcoin-bitcoin",
    ensureDirectory: async () => {},
    openSqliteStore: async () => createNoopStore(),
    openManagedBitcoindClient: async () => ({
      async syncToTip() {
        throw new Error("bitcoind_no_peers_for_header_sync_check_internet_or_firewall");
      },
      async startFollowingTip() {
        throw new Error("unreachable");
      },
      async getNodeStatus() {
        throw new Error("unreachable");
      },
      async close() {},
    }),
  });

  assert.equal(code, 5);
  assert.match(stderr.toString(), /No Bitcoin peers were available for header sync\./);
  assert.match(stderr.toString(), /Next: Check your internet access and firewall rules for outbound Bitcoin connections, then rerun sync\./);
});

test("sync explains missing RPC cookie files as a stopped managed node", async () => {
  const stderr = new MemoryStream();

  const code = await runCli(["sync"], {
    stdout: new MemoryStream(),
    stderr,
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin-client.sqlite",
    resolveDefaultBitcoindDataDir: () => "/tmp/cogcoin-bitcoin",
    ensureDirectory: async () => {},
    openSqliteStore: async () => createNoopStore(),
    openManagedBitcoindClient: async () => ({
      async syncToTip() {
        throw new Error("The managed Bitcoin RPC cookie file is unavailable at /tmp/cogcoin-bitcoin/.cookie while preparing getblockchaininfo. The managed node is not running or is shutting down.");
      },
      async startFollowingTip() {
        throw new Error("unreachable");
      },
      async getNodeStatus() {
        throw new Error("unreachable");
      },
      async close() {},
    }),
  });

  assert.equal(code, 5);
  assert.match(stderr.toString(), /The managed Bitcoin node is not running or is already shutting down\./);
  assert.match(stderr.toString(), /If you were exiting cleanly, this is safe to ignore\./);
});

test("sync shuts down the managed bitcoind client on SIGTERM", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const signals = new FakeSignalSource();
  let closed = false;

  const syncPromise = runCli(["sync"], {
    stdout,
    stderr,
    signalSource: signals,
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin-client.sqlite",
    resolveDefaultBitcoindDataDir: () => "/tmp/cogcoin-bitcoin",
    ensureDirectory: async () => {},
    openSqliteStore: async () => createNoopStore(),
    openManagedBitcoindClient: async () => ({
      async syncToTip() {
        return await new Promise<{
          appliedBlocks: number;
          rewoundBlocks: number;
          endingHeight: number | null;
          bestHeight: number;
        }>(() => {});
      },
      async startFollowingTip() {
        throw new Error("unreachable");
      },
      async getNodeStatus() {
        throw new Error("unreachable");
      },
      async close() {
        closed = true;
      },
    }),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  signals.emit("SIGTERM");
  const code = await syncPromise;

  assert.equal(code, 0);
  assert.equal(closed, true);
  assert.match(stderr.toString(), /Stopping managed Cogcoin client/);
});

test("restore clears wallet-control.lock on SIGINT", async () => {
  const root = createTempDirectory("cogcoin-cli-restore-lock");
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const signals = new FakeSignalSource();
  const runtimePaths = createTempWalletPaths(root);
  let releaseLockReady!: () => void;
  const lockReady = new Promise<void>((resolve) => {
    releaseLockReady = resolve;
  });

  try {
    const restorePromise = runCli(["restore"], {
      stdout,
      stderr,
      signalSource: signals,
      forceExit: () => undefined,
      walletSecretProvider: {} as never,
      createPrompter: createInteractivePrompter,
      resolveWalletRuntimePaths: () => runtimePaths,
      resolveDefaultBitcoindDataDir: () => runtimePaths.bitcoinDataDir,
      restoreWalletFromMnemonic: async () => {
        await acquireFileLock(runtimePaths.walletControlLockPath, {
          purpose: "wallet-restore",
        });
        releaseLockReady();
        return await new Promise<never>(() => {});
      },
    });

    await lockReady;
    signals.emit("SIGINT");

    const code = await restorePromise;
    assert.equal(code, 130);
    await waitForMissingPath(runtimePaths.walletControlLockPath);
  } finally {
    await removeTempDirectory(root);
  }
});

test("register clears wallet-control.lock on SIGTERM", async () => {
  const root = createTempDirectory("cogcoin-cli-register-lock");
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const signals = new FakeSignalSource();
  const runtimePaths = createTempWalletPaths(root);
  let releaseLockReady!: () => void;
  const lockReady = new Promise<void>((resolve) => {
    releaseLockReady = resolve;
  });

  try {
    const registerPromise = runCli(["register", "weatherbot"], {
      stdout,
      stderr,
      signalSource: signals,
      forceExit: () => undefined,
      walletSecretProvider: {} as never,
      createPrompter: createInteractivePrompter,
      resolveWalletRuntimePaths: () => runtimePaths,
      resolveDefaultBitcoindDataDir: () => runtimePaths.bitcoinDataDir,
      resolveDefaultClientDatabasePath: () => join(root, "client.sqlite"),
      registerDomain: async () => {
        await acquireFileLock(runtimePaths.walletControlLockPath, {
          purpose: "wallet-mutation",
        });
        releaseLockReady();
        return await new Promise<never>(() => {});
      },
    });

    await lockReady;
    signals.emit("SIGTERM");

    const code = await registerPromise;
    assert.equal(code, 130);
    await waitForMissingPath(runtimePaths.walletControlLockPath);
  } finally {
    await removeTempDirectory(root);
  }
});

test("follow stays active until signal and shuts down cleanly", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const signals = new FakeSignalSource();
  const runtimePaths = createTempWalletPaths("/tmp/cogcoin-cli-follow-root");
  let started = false;
  let closed = false;
  let walletRootId: string | undefined;

  const followPromise = runCli(["follow"], {
    stdout,
    stderr,
    signalSource: signals,
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin-follow.sqlite",
    resolveDefaultBitcoindDataDir: () => "/tmp/cogcoin-follow-bitcoin",
    ensureDirectory: async () => {},
    resolveWalletRuntimePaths: () => runtimePaths,
    loadRawWalletStateEnvelope: async () => ({
      source: "primary",
      envelope: {
        format: "cogcoin-local-wallet-state",
        cipher: "aes-256-gcm",
        nonce: "nonce",
        ciphertext: "ciphertext",
        authTag: "auth-tag",
        walletRootIdHint: "wallet-root-follow",
      } as never,
    }),
    loadUnlockSession: async () => {
      throw new Error("should-not-read-unlock-session");
    },
    loadWalletExplicitLock: async () => {
      throw new Error("should-not-read-explicit-lock");
    },
    openSqliteStore: async () => createNoopStore(),
    openManagedBitcoindClient: async ({ walletRootId: resolvedWalletRootId }) => ({
      async syncToTip() {
        return {
          appliedBlocks: 0,
          rewoundBlocks: 0,
          endingHeight: null,
          bestHeight: 0,
        };
      },
      async startFollowingTip() {
        walletRootId = resolvedWalletRootId;
        started = true;
      },
      async getNodeStatus() {
        return {
          indexedTip: null,
          nodeBestHeight: null,
        };
      },
      async close() {
        closed = true;
      },
    }),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  signals.emit("SIGINT");
  const code = await followPromise;

  assert.equal(code, 0);
  assert.equal(started, true);
  assert.equal(closed, true);
  assert.equal(walletRootId, "wallet-root-follow");
  assert.match(stdout.toString(), /Following managed Cogcoin tip/);
  assert.match(stderr.toString(), /Stopping managed Cogcoin client/);
});

test("follow does not print a startup line when tty progress is active", async () => {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream(true);
  const signals = new FakeSignalSource();

  const followPromise = runCli(["follow"], {
    stdout,
    stderr,
    signalSource: signals,
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin-follow-tty.sqlite",
    resolveDefaultBitcoindDataDir: () => "/tmp/cogcoin-follow-tty-bitcoin",
    ensureDirectory: async () => {},
    openSqliteStore: async () => createNoopStore(),
    openManagedBitcoindClient: async () => ({
      async syncToTip() {
        return {
          appliedBlocks: 0,
          rewoundBlocks: 0,
          endingHeight: null,
          bestHeight: 0,
        };
      },
      async startFollowingTip() {},
      async getNodeStatus() {
        return {
          indexedTip: null,
          nodeBestHeight: null,
        };
      },
      async close() {},
    }),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  signals.emit("SIGINT");
  const code = await followPromise;

  assert.equal(code, 0);
  assert.equal(stdout.toString(), "");
  assert.match(stderr.toString(), /Stopping managed Cogcoin client/);
});

test("formatStatusReport keeps live node claims passive", async () => {
  const report = formatStatusReport(await inspectPassiveClientStatus(
    "/tmp/does-not-exist.sqlite",
    "/tmp/does-not-exist-bitcoin",
  ));

  assert.match(report, /Live node: not checked \(passive status\)/);
});
