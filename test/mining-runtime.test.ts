import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatMineStatusReport } from "../src/cli/mining-format.js";
import { buildMineStatusJson } from "../src/cli/read-json.js";
import {
  loadMiningRuntimeStatus,
  readMiningEvents,
  type MiningControlPlaneView,
} from "../src/wallet/mining/index.js";
import {
  handleDetectedMiningRuntimeResumeForTesting,
  performMiningCycleForTesting,
  shouldTreatCandidateAsFeeBumpForTesting,
} from "../src/wallet/mining/runner.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createMemoryWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import type { WalletReadContext } from "../src/wallet/read/index.js";
import type { WalletStateV1 } from "../src/wallet/types.js";

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

function createWalletState(partial: Partial<WalletStateV1> = {}): WalletStateV1 {
  return {
    schemaVersion: 1,
    stateRevision: 1,
    lastWrittenAtUnixMs: 1_700_000_000_000,
    walletRootId: "wallet-root-test",
    network: "mainnet",
    anchorValueSats: 2_000,
    proactiveReserveSats: 50_000,
    proactiveReserveOutpoints: [],
    nextDedicatedIndex: 1,
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
    identities: [],
    domains: [],
    miningState: {
      runMode: "background",
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

function createReadContext(state: WalletStateV1): WalletReadContext {
  return {
    dataDir: "/tmp/bitcoind",
    databasePath: "/tmp/cogcoin.sqlite",
    localState: {
      availability: "ready",
      walletRootId: state.walletRootId,
      state,
      source: "primary",
      unlockUntilUnixMs: 1_900_000_000_000,
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
      pid: 321,
      walletRootId: state.walletRootId,
      nodeBestHeight: 100,
      nodeBestHashHex: "00".repeat(32),
      nodeHeaderHeight: 100,
      serviceUpdatedAtUnixMs: 1_700_000_000_000,
      serviceStatus: null,
      walletReplica: {
        walletRootId: state.walletRootId,
        walletName: state.managedCoreWallet.walletName,
        loaded: true,
        descriptors: true,
        privateKeysEnabled: true,
        created: true,
        proofStatus: "ready",
      },
      walletReplicaMessage: null,
    },
    nodeHealth: "synced",
    nodeMessage: null,
    indexer: {
      health: "synced",
      status: null,
      message: null,
      snapshotTip: null,
      source: "lease",
      daemonInstanceId: "daemon-1",
      snapshotSeq: "seq-1",
      openedAtUnixMs: 1_700_000_000_000,
    },
    snapshot: null,
    model: null,
    close: async () => undefined,
  };
}

function createMiningView(partial: {
  runtime?: Partial<MiningControlPlaneView["runtime"]>;
  hook?: Partial<MiningControlPlaneView["hook"]>;
  provider?: Partial<MiningControlPlaneView["provider"]>;
} = {}): MiningControlPlaneView {
  return {
    runtime: {
      schemaVersion: 1,
      walletRootId: "wallet-root-test",
      workerApiVersion: null,
      workerBinaryVersion: null,
      workerBuildId: null,
      updatedAtUnixMs: 1_700_000_000_000,
      runMode: "background",
      backgroundWorkerPid: 999,
      backgroundWorkerRunId: "run-1",
      backgroundWorkerHeartbeatAtUnixMs: 1_700_000_000_000,
      backgroundWorkerHealth: "healthy",
      indexerDaemonState: "synced",
      indexerDaemonInstanceId: "daemon-1",
      indexerSnapshotSeq: "seq-1",
      indexerSnapshotOpenedAtUnixMs: 1_700_000_000_000,
      indexerTruthSource: "lease",
      indexerHeartbeatAtUnixMs: 1_700_000_000_000,
      coreBestHeight: 100,
      coreBestHash: "00".repeat(32),
      indexerTipHeight: 100,
      indexerTipHash: "11".repeat(32),
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
      lastValidationState: "validated",
      lastOperatorValidationState: "current",
      lastValidationAtUnixMs: null,
      lastEventAtUnixMs: null,
      lastError: null,
      note: null,
      ...(partial.runtime ?? {}),
    },
    hook: {
      mode: "builtin",
      entrypointPath: "/tmp/hooks/mining/generate-sentences.js",
      packagePath: "/tmp/hooks/mining/package.json",
      entrypointExists: true,
      packageStatus: "valid",
      packageMessage: null,
      trustStatus: "trusted",
      trustMessage: null,
      validationState: "validated",
      operatorValidationState: "current",
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
      configured: true,
      provider: "openai",
      status: "ready",
      message: null,
      modelOverride: null,
      extraPromptConfigured: false,
      ...(partial.provider ?? {}),
    },
    lastEventAtUnixMs: null,
  };
}

test("same-payload fee maintenance only applies to a live in-mempool family", () => {
  const candidate = {
    domainId: 7,
    sender: {
      localIndex: 2,
      scriptPubKeyHex: "0014ed495c1face9da3c7028519dbb36576c37f90e56",
      address: "bc1qsender000000000000000000000000000000000",
    },
    encodedSentenceBytes: Buffer.from("same sentence", "utf8"),
    referencedBlockHashDisplay: "11".repeat(32),
    targetBlockHeight: 101,
  };

  const liveInMempool = {
    runMode: "background" as const,
    state: "live" as const,
    pauseReason: null,
    currentPublishState: "in-mempool" as const,
    currentDomain: "alpha",
    currentDomainId: 7,
    currentDomainIndex: 0,
    currentSenderScriptPubKeyHex: candidate.sender.scriptPubKeyHex,
    currentTxid: "aa".repeat(32),
    currentWtxid: "bb".repeat(32),
    currentFeeRateSatVb: 12,
    currentAbsoluteFeeSats: 500,
    currentScore: "1",
    currentSentence: "same sentence",
    currentEncodedSentenceBytesHex: Buffer.from(candidate.encodedSentenceBytes).toString("hex"),
    currentBip39WordIndices: [1, 2, 3, 4, 5],
    currentBlendSeedHex: "cc".repeat(32),
    currentBlockTargetHeight: 101,
    currentReferencedBlockHashDisplay: candidate.referencedBlockHashDisplay,
    currentIntentFingerprintHex: "dd".repeat(32),
    liveMiningFamilyInMempool: true,
    currentPublishDecision: "broadcast",
    replacementCount: 1,
    currentBlockFeeSpentSats: "500",
    sessionFeeSpentSats: "500",
    lifetimeFeeSpentSats: "500",
    sharedMiningConflictOutpoint: null,
  };

  assert.equal(shouldTreatCandidateAsFeeBumpForTesting({
    liveState: liveInMempool,
    candidate,
  }), true);
  assert.equal(shouldTreatCandidateAsFeeBumpForTesting({
    liveState: {
      ...liveInMempool,
      liveMiningFamilyInMempool: false,
      currentPublishState: "broadcast-unknown",
    },
    candidate,
  }), false);
  assert.equal(shouldTreatCandidateAsFeeBumpForTesting({
    liveState: {
      ...liveInMempool,
      currentEncodedSentenceBytesHex: Buffer.from("different sentence", "utf8").toString("hex"),
    },
    candidate,
  }), false);
});

test("handleDetectedMiningRuntimeResumeForTesting persists resuming runtime state", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-mining-runtime-"));
  const paths = createTempWalletPaths(root);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  const secretReference = createWalletSecretReference(state.walletRootId);
  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 7));

  await handleDetectedMiningRuntimeResumeForTesting({
    dataDir: "/tmp/bitcoind",
    databasePath: "/tmp/cogcoin.sqlite",
    provider,
    paths,
    runMode: "background",
    backgroundWorkerPid: 4321,
    backgroundWorkerRunId: "run-resume",
    detectedAtUnixMs: 1_800_000_000_000,
    openReadContext: async () => createReadContext(state),
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  const events = await readMiningEvents({
    eventsPath: paths.miningEventsPath,
    all: true,
  });

  assert.equal(snapshot?.currentPhase, "resuming");
  assert.equal(snapshot?.lastSuspendDetectedAtUnixMs, 1_800_000_000_000);
  assert.equal(snapshot?.backgroundWorkerPid, 4321);
  assert.match(snapshot?.note ?? "", /discarded stale in-flight work/i);
  assert.equal(events.at(-1)?.kind, "system-resumed");
  assert.match(events.at(-1)?.message ?? "", /discarded stale in-flight mining work/i);
});

test("performMiningCycleForTesting marks zero reward as an explicit paused runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-mining-zero-reward-"));
  const paths = createTempWalletPaths(root);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  const secretReference = createWalletSecretReference(state.walletRootId);
  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 9));

  const zeroRewardContext = createReadContext(state);
  zeroRewardContext.nodeStatus = {
    ...zeroRewardContext.nodeStatus!,
    nodeBestHeight: 6_929_999,
    nodeBestHashHex: "22".repeat(32),
  };

  await performMiningCycleForTesting({
    dataDir: "/tmp/bitcoind",
    databasePath: "/tmp/cogcoin.sqlite",
    provider,
    paths,
    runMode: "background",
    backgroundWorkerPid: 9876,
    backgroundWorkerRunId: "run-zero-reward",
    openReadContext: async () => zeroRewardContext,
    attachService: async () => ({ rpc: {} } as Awaited<ReturnType<typeof import("../src/bitcoind/service.js").attachOrStartManagedBitcoindService>>),
    rpcFactory: () => ({
      listUnspent: async () => [],
      listLockUnspent: async () => [],
      getBlockchainInfo: async () => ({ initialblockdownload: false }),
      getNetworkInfo: async () => ({ networkactive: true, connections_out: 1 }),
      getMempoolInfo: async () => ({ loaded: true }),
    }) as never,
  });

  const snapshot = await loadMiningRuntimeStatus(paths.miningStatusPath);
  const events = await readMiningEvents({
    eventsPath: paths.miningEventsPath,
    all: true,
  });

  assert.equal(snapshot?.currentPhase, "idle");
  assert.equal(snapshot?.pauseReason, "zero-reward");
  assert.equal(snapshot?.currentPublishDecision, "publish-skipped-zero-reward");
  assert.match(snapshot?.note ?? "", /target block reward is zero/i);
  assert.equal(events.at(-1)?.kind, "publish-skipped-zero-reward");
});

test("mine status text and json surface resuming and zero-reward states honestly", () => {
  const resumingView = createMiningView({
    runtime: {
      miningState: "paused",
      currentPhase: "resuming",
      lastSuspendDetectedAtUnixMs: 1_800_000_000_000,
      note: "Mining discarded stale in-flight work after a large local runtime gap and is rechecking health.",
    },
  });
  const zeroRewardView = createMiningView({
    runtime: {
      miningState: "paused",
      currentPhase: "idle",
      pauseReason: "zero-reward",
      currentPublishDecision: "publish-skipped-zero-reward",
      note: "Mining is disabled because the target block reward is zero.",
    },
  });

  const text = formatMineStatusReport(resumingView);
  const zeroRewardJson = buildMineStatusJson(zeroRewardView);

  assert.match(text, /Current phase: resuming/);
  assert.match(text, /Last suspend detected: 2027-01-15T08:00:00.000Z/);
  assert.match(text, /Next: wait for mining to finish rechecking health after the local runtime resumed\./);
  assert.equal(zeroRewardJson.data.phase, "idle");
  assert.equal(zeroRewardJson.data.pauseReason, "zero-reward");
  assert.equal(zeroRewardJson.data.lastSuspendDetectedAtUnixMs, null);
  assert.ok(zeroRewardJson.nextSteps.includes("Wait for the next positive-reward target height; mining resumes automatically."));
});
