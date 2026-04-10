import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureMiningHookTemplate,
  enableMiningHooks,
  markMiningGenerationActive,
  markMiningGenerationInactive,
  loadClientConfig,
  readMiningGenerationActivity,
  readMiningPreemptionRequest,
  readMiningEvents,
  requestMiningGenerationPreemption,
  setupBuiltInMining,
  validateCustomMiningHook,
} from "../src/wallet/mining/index.js";
import type { WalletPrompter } from "../src/wallet/lifecycle.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createMemoryWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { saveUnlockSession } from "../src/wallet/state/session.js";
import { saveWalletState } from "../src/wallet/state/storage.js";
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

class ScriptedPrompter implements WalletPrompter {
  readonly isInteractive = true;
  readonly prompts: string[] = [];
  readonly lines: string[] = [];

  constructor(private readonly answers: string[]) {}

  writeLine(message: string): void {
    this.lines.push(message);
  }

  async prompt(message: string): Promise<string> {
    this.prompts.push(message);
    return this.answers.shift() ?? "";
  }
}

async function createUnlockedWalletHarness() {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-mining-control-"));
  const paths = createTempWalletPaths(root);
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
  await saveUnlockSession(
    paths.walletUnlockSessionPath,
    {
      schemaVersion: 1,
      walletRootId: state.walletRootId,
      sessionId: "session-1",
      createdAtUnixMs: 1_700_000_000_000,
      unlockUntilUnixMs: 1_800_000_000_000,
      sourceStateRevision: state.stateRevision,
      wrappedSessionKeyMaterial: secretReference.keyId,
    },
    {
      provider,
      secretReference,
    },
  );

  return {
    paths,
    provider,
    state,
  };
}

test("ensureMiningHookTemplate creates the default files and validation succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-mining-hook-template-"));
  const paths = createTempWalletPaths(root);

  const created = await ensureMiningHookTemplate({
    hookRootPath: paths.hooksMiningDir,
    entrypointPath: paths.hooksMiningEntrypointPath,
    packagePath: paths.hooksMiningPackageJsonPath,
  });
  const validation = await validateCustomMiningHook({
    hookRootPath: paths.hooksMiningDir,
    entrypointPath: paths.hooksMiningEntrypointPath,
    packagePath: paths.hooksMiningPackageJsonPath,
  });

  assert.equal(created, true);
  assert.match(await readFile(paths.hooksMiningEntrypointPath, "utf8"), /generateSentences/);
  assert.match(await readFile(paths.hooksMiningPackageJsonPath, "utf8"), /"type": "module"/);
  assert.equal(validation.launchFingerprint.length, 64);
  assert.equal(validation.fullFingerprint.length, 64);
});

test("enableMiningHooks creates the template and asks the user to rerun when no custom hook exists", async () => {
  const harness = await createUnlockedWalletHarness();

  await assert.rejects(
    () => enableMiningHooks({
      provider: harness.provider,
      prompter: new ScriptedPrompter(["TRUST CUSTOM MINING HOOKS"]),
      paths: harness.paths,
      nowUnixMs: 1_700_000_000_000,
    }),
    /mining_hooks_enable_template_created:/,
  );

  assert.match(await readFile(harness.paths.hooksMiningEntrypointPath, "utf8"), /generateSentences/);
  const events = await readMiningEvents({
    eventsPath: harness.paths.miningEventsPath,
    all: true,
  });
  assert.deepEqual(events.map((event) => event.kind), ["custom-hook-template-created"]);
});

test("setupBuiltInMining stores encrypted provider config and logs setup events without leaking the API key", async () => {
  const harness = await createUnlockedWalletHarness();
  const prompter = new ScriptedPrompter([
    "openai",
    "sk-test-secret",
    "Prefer vivid imagery.",
    "gpt-5.4",
  ]);

  await setupBuiltInMining({
    provider: harness.provider,
    prompter,
    paths: harness.paths,
    nowUnixMs: 1_700_000_000_000,
  });

  const rawConfig = await readFile(harness.paths.clientConfigPath, "utf8");
  const loaded = await loadClientConfig({
    path: harness.paths.clientConfigPath,
    provider: harness.provider,
  });
  const events = await readMiningEvents({
    eventsPath: harness.paths.miningEventsPath,
    all: true,
  });

  assert.doesNotMatch(rawConfig, /sk-test-secret/);
  assert.equal(loaded?.mining.builtIn?.provider, "openai");
  assert.equal(loaded?.mining.builtIn?.modelOverride, "gpt-5.4");
  assert.equal(loaded?.mining.builtIn?.extraPrompt, "Prefer vivid imagery.");
  assert.ok(prompter.lines.some((line) => line.includes("Built-in mining provider disclosure")));
  assert.ok(prompter.lines.some((line) => line.includes("eligible anchored root domain names")));
  assert.ok(prompter.lines.some((line) => line.includes("required five words")));
  assert.ok(prompter.lines.every((line) => !line.includes("sk-test-secret")));
  assert.deepEqual(events.map((event) => event.kind), [
    "mine-setup-started",
    "mine-setup-completed",
  ]);
  assert.ok(events.every((event) => !event.message.includes("sk-test-secret")));
});

test("readMiningEvents ignores partial final lines and respects limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-mining-events-"));
  const paths = createTempWalletPaths(root);
  await mkdir(dirname(paths.miningEventsPath), { recursive: true });

  await appendFile(
    paths.miningEventsPath,
    `${JSON.stringify({
      schemaVersion: 1,
      timestampUnixMs: 1,
      level: "info",
      kind: "event-1",
      message: "first",
    })}\n`,
    "utf8",
  );
  await appendFile(
    paths.miningEventsPath,
    `${JSON.stringify({
      schemaVersion: 1,
      timestampUnixMs: 2,
      level: "info",
      kind: "event-2",
      message: "second",
    })}\n`,
    "utf8",
  );
  await appendFile(paths.miningEventsPath, "{\"schemaVersion\":1", "utf8");

  const limited = await readMiningEvents({
    eventsPath: paths.miningEventsPath,
    limit: 1,
  });
  const allEvents = await readMiningEvents({
    eventsPath: paths.miningEventsPath,
    all: true,
  });

  assert.deepEqual(limited.map((event) => event.kind), ["event-2"]);
  assert.deepEqual(allEvents.map((event) => event.kind), ["event-1", "event-2"]);
});

test("requestMiningGenerationPreemption waits for an active generation request to stop and acknowledges the request", async () => {
  const root = await mkdtemp(join(tmpdir(), "cogcoin-mining-preempt-"));
  const paths = createTempWalletPaths(root);

  await markMiningGenerationActive({
    paths,
    runId: "run-1",
    pid: 123,
  });

  const preemptionPromise = requestMiningGenerationPreemption({
    paths,
    reason: "wallet-send",
    timeoutMs: 2_000,
  });

  setTimeout(() => {
    void markMiningGenerationInactive({
      paths,
      runId: "run-1",
      pid: 123,
    });
  }, 50);

  const handle = await preemptionPromise;
  const request = await readMiningPreemptionRequest(paths);
  const activity = await readMiningGenerationActivity(paths);

  assert.equal(request?.requestId, handle.requestId);
  assert.equal(request?.reason, "wallet-send");
  assert.equal(activity?.generationActive, false);
  assert.equal(activity?.acknowledgedRequestId, handle.requestId);

  await handle.release();
  assert.equal(await readMiningPreemptionRequest(paths), null);
});
