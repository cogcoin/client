import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { deserializeIndexerState, serializeIndexerState } from "@cogcoin/indexer";

import {
  INDEXER_DAEMON_SCHEMA_VERSION,
  INDEXER_DAEMON_SERVICE_API_VERSION,
} from "../src/bitcoind/types.js";
import type { IndexerSnapshotHandle } from "../src/bitcoind/indexer-daemon.js";
import { inspectWalletLocalState, readSnapshotWithRetry } from "../src/wallet/read/context.js";
import {
  createWalletReadModel,
  findDomainField,
  listDomainFields,
  listWalletLocks,
} from "../src/wallet/read/project.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import { createMemoryWalletSecretProviderForTesting, createWalletSecretReference } from "../src/wallet/state/provider.js";
import { saveWalletExplicitLock } from "../src/wallet/state/explicit-lock.js";
import { loadUnlockSession, saveUnlockSession } from "../src/wallet/state/session.js";
import { saveWalletState } from "../src/wallet/state/storage.js";
import type { WalletReadContext } from "../src/wallet/read/types.js";
import type { WalletStateV1 } from "../src/wallet/types.js";
import { replayBlocks } from "./bitcoind-helpers.js";
import { loadHistoryVector, materializeBlock } from "./helpers.js";

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

async function createSnapshotState() {
  const vector = loadHistoryVector();
  return replayBlocks([
    ...vector.setupBlocks.map(materializeBlock),
    ...vector.testBlocks.map(materializeBlock),
  ]);
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

function createSnapshotHandle(overrides: Partial<{
  token: string;
  expiresAtUnixMs: number;
  serviceApiVersion: string;
  binaryVersion: string;
  buildId: string | null;
  walletRootId: string;
  daemonInstanceId: string;
  schemaVersion: string;
  processId: number | null;
  startedAtUnixMs: number;
  state: "starting" | "catching-up" | "reorging" | "synced" | "stopping" | "failed" | "schema-mismatch" | "service-version-mismatch";
  heartbeatAtUnixMs: number;
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
  tipHeight: number | null;
  tipHash: string | null;
  openedAtUnixMs: number;
}> = {}): IndexerSnapshotHandle {
  return {
    token: "snapshot-token",
    expiresAtUnixMs: 1_700_000_030_000,
    serviceApiVersion: INDEXER_DAEMON_SERVICE_API_VERSION,
    binaryVersion: "0.0.0-test",
    buildId: null,
    walletRootId: "wallet-root-test",
    daemonInstanceId: "daemon-1",
    schemaVersion: INDEXER_DAEMON_SCHEMA_VERSION,
    processId: 1234,
    startedAtUnixMs: 1_700_000_000_000,
    state: "synced",
    heartbeatAtUnixMs: 1_700_000_000_000,
    rpcReachable: true,
    coreBestHeight: 0,
    coreBestHash: "03".repeat(32),
    appliedTipHeight: 0,
    appliedTipHash: "03".repeat(32),
    snapshotSeq: "1",
    backlogBlocks: 0,
    reorgDepth: null,
    lastAppliedAtUnixMs: 1_700_000_000_000,
    activeSnapshotCount: 1,
    lastError: null,
    tipHeight: 0,
    tipHash: "03".repeat(32),
    openedAtUnixMs: 1_700_000_000_000,
    ...overrides,
  };
}

test("wallet read model reconciles chain-owned domains and keeps balances per identity", async () => {
  const state = await createSnapshotState();
  const walletState = createWalletState();
  const model = createWalletReadModel(walletState, {
    state,
    tip: {
      height: state.history.currentHeight ?? 0,
      blockHashHex: "03".repeat(32),
      previousHashHex: "02".repeat(32),
      stateHashHex: "aa".repeat(32),
    },
  });

  const alphaIdentity = model.identities.find((identity) => identity.index === 1);
  const betaIdentity = model.identities.find((identity) => identity.index === 2);
  const alphaDomain = model.domains.find((domain) => domain.name === "alpha");

  assert.ok(alphaIdentity);
  assert.ok(betaIdentity);
  assert.ok(alphaDomain);
  assert.equal(alphaIdentity?.ownedDomainNames.join(","), "alpha");
  assert.equal(betaIdentity?.ownedDomainNames.join(","), "beta");
  assert.notEqual(alphaIdentity?.observedCogBalance?.toString(), betaIdentity?.observedCogBalance?.toString());
  assert.equal(alphaDomain?.anchored, true);
  assert.equal(alphaDomain?.ownerLocalIndex, 1);
  assert.equal(alphaDomain?.localRelationship, "owned");
  assert.deepEqual(alphaIdentity?.selectors.slice(0, 3), [
    "id:1",
    "domain:alpha",
    "bc1qalphaowner0000000000000000000000000000",
  ]);
});

test("shared-script anchored histories are projected as read-only", async () => {
  const state = structuredClone(await createSnapshotState());
  const alpha = state.consensus.domainsById.get(1)!;
  const beta = state.consensus.domainsById.get(2)!;
  const alphaHex = Buffer.from(alpha.ownerScriptPubKey).toString("hex");
  const betaHex = Buffer.from(beta.ownerScriptPubKey).toString("hex");

  state.consensus.domainsById.set(2, {
    ...beta,
    ownerScriptPubKey: alpha.ownerScriptPubKey,
  });
  state.consensus.domainIdsByOwner.delete(betaHex);
  state.consensus.domainIdsByOwner.set(alphaHex, new Set([1, 2]));
  state.consensus.canonicalDomainByAddress.set(alphaHex, 1);

  const model = createWalletReadModel(createWalletState(), {
    state,
    tip: {
      height: state.history.currentHeight ?? 0,
      blockHashHex: "03".repeat(32),
      previousHashHex: "02".repeat(32),
      stateHashHex: "aa".repeat(32),
    },
  });

  const sharedIdentity = model.identities.find((identity) => identity.index === 1);
  const betaDomain = model.domains.find((domain) => domain.name === "beta");

  assert.equal(sharedIdentity?.readOnly, true);
  assert.equal(sharedIdentity?.effectiveStatus, "read-only");
  assert.equal(betaDomain?.readOnly, true);
  assert.equal(betaDomain?.localRelationship, "read-only");
});

test("wallet read model projects chain-authoritative reputation totals", async () => {
  const state = structuredClone(await createSnapshotState());
  const alpha = state.consensus.domainsById.get(1)!;

  state.consensus.domainsById.set(1, {
    ...alpha,
    selfStake: 100n,
    supportedStake: 25n,
    totalSupported: 125n,
    totalRevoked: 5n,
  });
  state.consensus.supportByPair.set("2:1", 25n);

  const model = createWalletReadModel(createWalletState(), {
    state,
    tip: {
      height: state.history.currentHeight ?? 0,
      blockHashHex: "03".repeat(32),
      previousHashHex: "02".repeat(32),
      stateHashHex: "aa".repeat(32),
    },
  });

  const alphaDomain = model.domains.find((domain) => domain.name === "alpha");
  assert.ok(alphaDomain);
  assert.equal(alphaDomain?.selfStakeCogtoshi, 100n);
  assert.equal(alphaDomain?.supportedStakeCogtoshi, 25n);
  assert.equal(alphaDomain?.totalSupportedCogtoshi, 125n);
  assert.equal(alphaDomain?.totalRevokedCogtoshi, 5n);
});

test("field queries read current snapshot data without inventing empty values", async () => {
  const state = await createSnapshotState();
  const context = {
    dataDir: "/tmp/bitcoin",
    databasePath: "/tmp/client.sqlite",
    localState: {
      availability: "ready",
      walletRootId: "wallet-root-test",
      state: createWalletState(),
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
    nodeStatus: null,
    nodeHealth: "synced",
    nodeMessage: null,
    indexer: {
      health: "synced",
      status: null,
      message: null,
      snapshotTip: null,
    },
    snapshot: {
      state,
      tip: {
        height: state.history.currentHeight ?? 0,
        blockHashHex: "03".repeat(32),
        previousHashHex: "02".repeat(32),
        stateHashHex: "aa".repeat(32),
      },
    },
    model: createWalletReadModel(createWalletState(), {
      state,
      tip: {
        height: state.history.currentHeight ?? 0,
        blockHashHex: "03".repeat(32),
        previousHashHex: "02".repeat(32),
        stateHashHex: "aa".repeat(32),
      },
    }),
    async close() {},
  } satisfies WalletReadContext;

  const fields = listDomainFields(context, "alpha");
  const field = findDomainField(context, "alpha", "bio");

  assert.equal(fields?.length, 1);
  assert.equal(fields?.[0]?.name, "bio");
  assert.equal(field?.hasValue, false);
  assert.equal(field?.preview, null);
});

test("wallet lock listing exposes claimable and reclaimable local actions", async () => {
  const state = await createSnapshotState();
  const currentHeight = state.history.currentHeight ?? 0;
  state.consensus.locks.set(77, {
    lockId: 77,
    lockerScriptPubKey: Buffer.from("0014ed495c1face9da3c7028519dbb36576c37f90e56", "hex"),
    amount: 50n,
    condition: Buffer.alloc(32, 7),
    timeoutHeight: currentHeight + 12,
    recipientDomainId: 1,
    creationHeight: currentHeight - 1,
  });
  state.consensus.locks.set(78, {
    lockId: 78,
    lockerScriptPubKey: Buffer.from("00145f5a03d6c7c88648b5f947459b769008ced5a020", "hex"),
    amount: 70n,
    condition: Buffer.alloc(32, 9),
    timeoutHeight: currentHeight - 1,
    recipientDomainId: 2,
    creationHeight: currentHeight - 20,
  });

  const walletState = createWalletState({
    domains: [
      {
        ...createWalletState().domains[0]!,
        canonicalChainStatus: "anchored",
      },
      {
        ...createWalletState().domains[1]!,
        canonicalChainStatus: "anchored",
      },
    ],
  });
  const snapshot = {
    state,
    tip: {
      height: currentHeight,
      blockHashHex: "03".repeat(32),
      previousHashHex: "02".repeat(32),
      stateHashHex: "aa".repeat(32),
    },
  };
  const context = {
    dataDir: "/tmp/bitcoin",
    databasePath: "/tmp/client.sqlite",
    localState: {
      availability: "ready",
      walletRootId: "wallet-root-test",
      state: walletState,
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
    nodeStatus: null,
    nodeHealth: "synced",
    nodeMessage: null,
    indexer: {
      health: "synced",
      status: null,
      message: null,
      snapshotTip: snapshot.tip,
    },
    snapshot,
    model: createWalletReadModel(walletState, snapshot),
    async close() {},
  } satisfies WalletReadContext;

  const locks = listWalletLocks(context);
  const claimable = locks?.find((entry) => entry.lockId === 77);
  const reclaimable = locks?.find((entry) => entry.lockId === 78);

  assert.equal(claimable?.claimableNow, true);
  assert.equal(claimable?.reclaimableNow, false);
  assert.equal(reclaimable?.claimableNow, false);
  assert.equal(reclaimable?.reclaimableNow, true);
});

test("stale snapshot tokens are retried by reopening a fresh coherent snapshot", async () => {
  const state = await createSnapshotState();
  const tip = {
    height: state.history.currentHeight ?? 0,
    blockHashHex: "03".repeat(32),
    previousHashHex: "02".repeat(32),
    stateHashHex: "aa".repeat(32),
  };
  const opened: string[] = [];
  const closed: string[] = [];
  let reads = 0;

  const daemon = {
    async getStatus() {
      throw new Error("unreachable");
    },
    async openSnapshot() {
      const token = opened.length === 0 ? "stale" : "fresh";
      opened.push(token);
      return createSnapshotHandle({
        token,
        expiresAtUnixMs: Date.now() + 30_000,
        tipHeight: tip.height,
        tipHash: tip.blockHashHex,
      });
    },
    async readSnapshot(token: string) {
      reads += 1;
      if (token === "stale") {
        throw new Error("indexer_daemon_snapshot_invalid");
      }

      const handle = createSnapshotHandle({
        token,
        expiresAtUnixMs: Date.now() + 30_000,
        tipHeight: tip.height,
        tipHash: tip.blockHashHex,
      });

      return {
        token: handle.token,
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
        expiresAtUnixMs: handle.expiresAtUnixMs,
        tip,
        stateBase64: Buffer.from(serializeIndexerState(state)).toString("base64"),
      };
    },
    async closeSnapshot(token: string) {
      closed.push(token);
    },
    async close() {},
  };

  const lease = await readSnapshotWithRetry(daemon, "wallet-root-test");

  assert.equal(reads, 2);
  assert.deepEqual(opened, ["stale", "fresh"]);
  assert.deepEqual(closed, ["stale", "fresh"]);
  assert.equal(lease.payload.tip?.height, tip.height);
  assert.equal(lease.status.daemonInstanceId, "daemon-1");
  assert.equal(lease.status.snapshotSeq, "1");
  assert.equal(lease.status.state, "synced");
  const decoded = deserializeIndexerState(Buffer.from(lease.payload.stateBase64, "base64"));
  assert.equal(decoded.history.currentHeight, tip.height);
});

test("snapshot retries are not attempted through compatibility mismatches", async () => {
  const opened: string[] = [];
  const closed: string[] = [];
  let reads = 0;

  const daemon = {
    async getStatus() {
      throw new Error("unreachable");
    },
    async openSnapshot() {
      opened.push("bad-version");
      return createSnapshotHandle({
        token: "bad-version",
        serviceApiVersion: "cogcoin/indexer-ipc/v999",
      });
    },
    async readSnapshot() {
      reads += 1;
      throw new Error("should-not-read");
    },
    async closeSnapshot(token: string) {
      closed.push(token);
    },
    async close() {},
  };

  await assert.rejects(
    async () => readSnapshotWithRetry(daemon, "wallet-root-test"),
    /indexer_daemon_service_version_mismatch/,
  );
  assert.equal(reads, 0);
  assert.deepEqual(opened, ["bad-version"]);
  assert.deepEqual(closed, ["bad-version"]);
});

test("inspectWalletLocalState uses a valid provider-backed unlock session to expose ready wallet state", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-read-ready-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  const secretReference = createWalletSecretReference(state.walletRootId);

  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 5));
  await saveWalletState(
    {
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    },
    state,
    {
      provider,
      secretReference,
    },
  );
  await saveUnlockSession(
    paths.walletUnlockSessionPath,
    {
      schemaVersion: 1,
      walletRootId: state.walletRootId,
      sessionId: "session-ready",
      createdAtUnixMs: 1_700_000_000_000,
      unlockUntilUnixMs: 1_700_000_900_000,
      sourceStateRevision: state.stateRevision,
      wrappedSessionKeyMaterial: secretReference.keyId,
    },
    {
      provider,
      secretReference,
    },
  );

  const inspected = await inspectWalletLocalState({
    secretProvider: provider,
    now: 1_700_000_100_000,
    paths,
  });

  assert.equal(inspected.availability, "ready");
  assert.equal(inspected.walletRootId, state.walletRootId);
  assert.equal(inspected.unlockUntilUnixMs, 1_700_000_900_000);
});

test("inspectWalletLocalState auto-unlocks provider-backed wallets when no unlock session exists", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-read-auto-unlock-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  const secretReference = createWalletSecretReference(state.walletRootId);

  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 6));
  await saveWalletState(
    {
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    },
    state,
    {
      provider,
      secretReference,
    },
  );

  const inspected = await inspectWalletLocalState({
    secretProvider: provider,
    now: 1_700_000_100_000,
    paths,
  });
  const session = await loadUnlockSession(paths.walletUnlockSessionPath, {
    provider,
  });

  assert.equal(inspected.availability, "ready");
  assert.equal(inspected.walletRootId, state.walletRootId);
  assert.equal(inspected.unlockUntilUnixMs, 1_700_000_100_000 + (15 * 60 * 1000));
  assert.equal(inspected.hasUnlockSessionFile, true);
  assert.equal(session.walletRootId, state.walletRootId);
  assert.equal(session.unlockUntilUnixMs, 1_700_000_100_000 + (15 * 60 * 1000));
});

test("inspectWalletLocalState respects explicit locks for provider-backed wallets", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-read-explicit-lock-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();
  const state = createWalletState();
  const secretReference = createWalletSecretReference(state.walletRootId);

  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 7));
  await saveWalletState(
    {
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    },
    state,
    {
      provider,
      secretReference,
    },
  );
  await saveWalletExplicitLock(paths.walletExplicitLockPath, {
    schemaVersion: 1,
    walletRootId: state.walletRootId,
    lockedAtUnixMs: 1_700_000_000_000,
  });

  const inspected = await inspectWalletLocalState({
    secretProvider: provider,
    now: 1_700_000_100_000,
    paths,
  });

  assert.equal(inspected.availability, "locked");
  assert.equal(inspected.walletRootId, state.walletRootId);
  assert.equal(inspected.unlockUntilUnixMs, null);
  assert.equal(inspected.hasUnlockSessionFile, false);
  assert.match(inspected.message ?? "", /explicitly locked/i);
});

test("inspectWalletLocalState keeps passphrase-backed wallets locked while exposing the wallet root hint", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-read-passphrase-locked-"));
  const paths = createTempWalletPaths(tempRoot);
  const state = createWalletState();

  await saveWalletState(
    {
      primaryPath: paths.walletStatePath,
      backupPath: paths.walletStateBackupPath,
    },
    state,
    "test-passphrase",
  );

  const inspected = await inspectWalletLocalState({
    secretProvider: createMemoryWalletSecretProviderForTesting(),
    now: 1_700_000_100_000,
    paths,
  });

  assert.equal(inspected.availability, "locked");
  assert.equal(inspected.walletRootId, state.walletRootId);
  assert.equal(inspected.unlockUntilUnixMs, null);
  assert.equal(inspected.hasUnlockSessionFile, false);
  assert.match(inspected.message ?? "", /wallet-state passphrase/i);
});

test("inspectWalletLocalState reports local-state-corrupt when neither primary nor backup is trusted", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "cogcoin-wallet-read-corrupt-"));
  const paths = createTempWalletPaths(tempRoot);
  const provider = createMemoryWalletSecretProviderForTesting();

  await saveUnlockSession(
    paths.walletUnlockSessionPath,
    {
      schemaVersion: 1,
      walletRootId: "wallet-root-test",
      sessionId: "session-stale",
      createdAtUnixMs: 1_700_000_000_000,
      unlockUntilUnixMs: 1_700_000_900_000,
      sourceStateRevision: 1,
      wrappedSessionKeyMaterial: "wallet-state:wallet-root-test",
    },
    "test-passphrase",
  );
  await mkdir(join(tempRoot, "state", "cogcoin"), { recursive: true });
  await writeFile(paths.walletStatePath, "corrupt\n", "utf8");
  await writeFile(paths.walletStateBackupPath, "corrupt\n", "utf8");

  const inspected = await inspectWalletLocalState({
    secretProvider: provider,
    now: 1_700_000_100_000,
    paths,
  });

  assert.equal(inspected.availability, "local-state-corrupt");
  assert.match(inspected.message ?? "", /wallet_secret_missing|Unexpected token|unsupported/i);
});
