import type { PortableWalletArchivePayloadV1, WalletStateV1 } from "../src/wallet/types.js";
import type { MiningRuntimeStatusV1 } from "../src/wallet/mining/types.js";
import type { MiningControlPlaneView } from "../src/wallet/mining/types.js";
import { createWalletReadModel } from "../src/wallet/read/project.js";

export function createMiningState(overrides: Partial<WalletStateV1["miningState"]> = {}): WalletStateV1["miningState"] {
  return {
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
    livePublishInMempool: null,
    currentPublishDecision: null,
    replacementCount: 0,
    currentBlockFeeSpentSats: "0",
    sessionFeeSpentSats: "0",
    lifetimeFeeSpentSats: "0",
    sharedMiningConflictOutpoint: null,
    ...overrides,
  };
}

export function createHookClientState(): WalletStateV1["hookClientState"] {
  return {
    mining: {
      mode: "builtin",
      validationState: "current",
      lastValidationAtUnixMs: null,
      lastValidationError: null,
      validatedLaunchFingerprint: null,
      validatedFullFingerprint: null,
      fullTrustWarningAcknowledgedAtUnixMs: null,
      consecutiveFailureCount: 0,
      cooldownUntilUnixMs: null,
    },
  };
}

export function createWalletState(overrides: Partial<WalletStateV1> = {}): WalletStateV1 {
  return {
    schemaVersion: 4,
    stateRevision: 1,
    lastWrittenAtUnixMs: 1,
    walletRootId: "wallet-root",
    network: "mainnet",
    anchorValueSats: 2_000,
    localScriptPubKeyHexes: [],
    mnemonic: {
      phrase: `${"abandon ".repeat(23)}art`,
      language: "english",
    },
    keys: {
      masterFingerprintHex: "11".repeat(4),
      accountPath: "m/84'/0'/0'",
      accountXprv: "xprv-test",
      accountXpub: "xpub-test",
    },
    descriptor: {
      privateExternal: "wpkh(xprv-test/0/*)",
      publicExternal: "wpkh(xpub-test/0/*)",
      checksum: "abcd1234",
      rangeEnd: 10,
      safetyMargin: 5,
    },
    funding: {
      address: "bc1qfunding",
      scriptPubKeyHex: "0014" + "11".repeat(20),
    },
    walletBirthTime: 123,
    managedCoreWallet: {
      walletName: "wallet.dat",
      internalPassphrase: "passphrase",
      descriptorChecksum: "abcd1234",
      walletAddress: "bc1qfunding",
      walletScriptPubKeyHex: "0014" + "11".repeat(20),
      proofStatus: "ready",
      lastImportedAtUnixMs: null,
      lastVerifiedAtUnixMs: null,
    },
    domains: [],
    miningState: createMiningState(),
    hookClientState: createHookClientState(),
    pendingMutations: [],
    ...overrides,
  };
}

export function createPortableArchivePayload(
  overrides: Partial<PortableWalletArchivePayloadV1> = {},
): PortableWalletArchivePayloadV1 {
  return {
    schemaVersion: 4,
    exportedAtUnixMs: 1,
    walletRootId: "wallet-root",
    network: "mainnet",
    anchorValueSats: 2_000,
    localScriptPubKeyHexes: [],
    mnemonic: {
      phrase: `${"abandon ".repeat(23)}art`,
      language: "english",
    },
    expected: {
      masterFingerprintHex: "11".repeat(4),
      accountPath: "m/84'/0'/0'",
      accountXpub: "xpub-test",
      publicExternalDescriptor: "wpkh(xpub-test/0/*)",
      descriptorChecksum: "abcd1234",
      rangeEnd: 10,
      safetyMargin: 5,
      walletAddress: "bc1qfunding",
      walletScriptPubKeyHex: "0014" + "11".repeat(20),
      walletBirthTime: 123,
    },
    domains: [],
    miningState: createMiningState(),
    hookClientState: createHookClientState(),
    ...overrides,
  };
}

export function createMiningRuntimeStatus(
  overrides: Partial<MiningRuntimeStatusV1> = {},
): MiningRuntimeStatusV1 {
  return {
    schemaVersion: 1,
    walletRootId: "wallet-root",
    workerApiVersion: "cogcoin/mining-worker/v1",
    workerBinaryVersion: "1.0.0",
    workerBuildId: "build-1",
    updatedAtUnixMs: 1,
    runMode: "stopped",
    backgroundWorkerPid: null,
    backgroundWorkerRunId: null,
    backgroundWorkerHeartbeatAtUnixMs: null,
    backgroundWorkerHealth: null,
    indexerDaemonState: "synced",
    indexerDaemonInstanceId: null,
    indexerSnapshotSeq: null,
    indexerSnapshotOpenedAtUnixMs: null,
    indexerTruthSource: undefined,
    indexerHeartbeatAtUnixMs: null,
    coreBestHeight: null,
    coreBestHash: null,
    indexerTipHeight: null,
    indexerTipHash: null,
    indexerReorgDepth: null,
    indexerTipAligned: null,
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
    livePublishInMempool: null,
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
    ...overrides,
  };
}

export function createMiningControlPlaneView(
  overrides: Partial<MiningControlPlaneView> = {},
): MiningControlPlaneView {
  return {
    runtime: createMiningRuntimeStatus(),
    hook: {
      mode: "builtin",
      entrypointPath: "/tmp/hook.js",
      packagePath: "/tmp/package.json",
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
    },
    provider: {
      configured: true,
      provider: "openai",
      status: "ready",
      message: null,
      modelOverride: null,
      extraPromptConfigured: false,
    },
    lastEventAtUnixMs: null,
    ...overrides,
  };
}

export function createWalletReadContext(overrides: Record<string, unknown> = {}) {
  const state = createWalletState();
  const model = createWalletReadModel(state, null);
  return {
    databasePath: "/tmp/test.db",
    dataDir: "/tmp",
    localState: {
      availability: "ready",
      state,
      unlockUntilUnixMs: 1_000,
      message: null,
    },
    snapshot: null,
    model,
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
    nodeHealth: "synced",
    nodeMessage: null,
    nodeStatus: {
      chain: "mainnet",
      nodeBestHeight: null,
      nodeBestHashHex: null,
      walletReplica: {
        proofStatus: "ready",
      },
    },
    mining: undefined,
    ...overrides,
  } as any;
}
