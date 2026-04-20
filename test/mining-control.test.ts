import test from "node:test";
import assert from "node:assert/strict";

import { buildMineStatusJson } from "../src/cli/read-json.js";
import { saveBuiltInMiningProviderConfig } from "../src/wallet/mining/config.js";
import { inspectMiningControlPlane } from "../src/wallet/mining/control.js";
import { saveMiningRuntimeStatus } from "../src/wallet/mining/runtime-artifacts.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createMemoryWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import {
  createMiningControlPlaneView,
  createMiningRuntimeStatus,
  createMiningState,
  createWalletReadContext,
} from "./current-model-helpers.js";

test("mine status JSON exposes livePublishInMempool", () => {
  const mining = createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      miningState: "paused",
      currentPhase: "waiting",
      livePublishInMempool: true,
      currentPublishDecision: "kept-live-publish",
      note: "Waiting on current publish.",
    }),
  });

  const result = buildMineStatusJson(mining);

  assert.equal(result.data.livePublishInMempool, true);
  assert.equal(result.data.publishDecision, "kept-live-publish");
  assert.match(result.nextSteps[0] ?? "", /live mining publish/);
});

test("mine status explanations avoid family wording", () => {
  const mining = createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      note: "Mining is paused while another wallet mutation is active.",
    }),
  });

  const result = buildMineStatusJson(mining);
  assert.equal(result.explanations[0], "Mining is paused while another wallet mutation is active.");
  assert.doesNotMatch(result.explanations.join("\n"), /family/);
});

test("mine status JSON exposes the effective provider model and not-found next step", () => {
  const mining = createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      currentPhase: "waiting-provider",
      miningState: "paused",
      providerState: "not-found",
      lastError: "The built-in Anthropic mining provider returned HTTP 404 for model \"claude-sonnet-4-missing\". The configured model override may be invalid. Rerun `cogcoin mine setup` to clear or correct it.",
    }),
    provider: {
      configured: true,
      provider: "anthropic",
      status: "ready",
      message: null,
      modelId: "claude-sonnet-4-missing",
      effectiveModel: "claude-sonnet-4-missing",
      modelOverride: "claude-sonnet-4-missing",
      modelSelectionSource: "custom",
      usingDefaultModel: false,
      extraPromptConfigured: false,
      estimatedDailyCostUsd: null,
      estimatedDailyCostDisplay: null,
    },
  });

  const result = buildMineStatusJson(mining);

  assert.deepEqual(result.data.provider, {
    configured: true,
    kind: "anthropic",
    modelId: "claude-sonnet-4-missing",
    effectiveModel: "claude-sonnet-4-missing",
    modelOverride: "claude-sonnet-4-missing",
    modelSelectionSource: "custom",
    usingDefaultModel: false,
    extraPromptConfigured: false,
    estimatedDailyCostUsd: null,
    estimatedDailyCostDisplay: null,
  });
  assert.equal(result.data.providerState, "not-found");
  assert.equal(result.nextSteps[0], "Run `cogcoin mine setup` and clear or correct the provider model.");
});

test("mine status JSON shows the insufficient-funds next step from publish decision", () => {
  const mining = createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      currentPhase: "waiting",
      miningState: "paused",
      currentPublishDecision: "publish-paused-insufficient-funds",
      note: "Mining is waiting for enough safe BTC funding that Bitcoin Core can use for the next publish.",
    }),
  });

  const result = buildMineStatusJson(mining);

  assert.equal(result.data.publishDecision, "publish-paused-insufficient-funds");
  assert.equal(result.nextSteps[0], "Wait for enough safe BTC funding to become spendable for the next publish; mining resumes automatically.");
});

test("inspectMiningControlPlane drops stale provider wait details when paused live publish becomes the effective blocker", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-mining-control-provider-stale");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const secretReference = createWalletSecretReference("wallet-root");
  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 9));
  await saveBuiltInMiningProviderConfig({
    path: paths.clientConfigPath,
    provider,
    secretReference,
    config: {
      provider: "openai",
      apiKey: "test-api-key",
      extraPrompt: null,
      modelOverride: "gpt-5.4-mini",
      modelSelectionSource: "custom",
      updatedAtUnixMs: 1,
    },
  });

  const baseReadContext = createWalletReadContext();
  const readContext = createWalletReadContext({
    localState: {
      availability: "ready",
      clientPasswordReadiness: "ready",
      unlockRequired: false,
      walletRootId: "wallet-root",
      state: {
        ...baseReadContext.localState.state,
        miningState: createMiningState({
          runMode: "stopped",
          state: "paused",
          pauseReason: "user-stopped",
          currentPublishState: "in-mempool",
          livePublishInMempool: true,
          currentTxid: "aa".repeat(32),
          currentPublishDecision: "restored-live-publish",
        }),
      },
      source: "primary",
      hasPrimaryStateFile: true,
      hasBackupStateFile: false,
      message: null,
    },
  });

  await saveMiningRuntimeStatus(paths.miningStatusPath, createMiningRuntimeStatus({
    currentPhase: "waiting-provider",
    providerState: "backoff",
    lastError: "The built-in OpenAI mining provider timed out after 30 seconds.",
    note: "Mining is waiting for the sentence provider to recover.",
  }));

  const mining = await inspectMiningControlPlane({
    provider,
    localState: readContext.localState,
    bitcoind: readContext.bitcoind,
    nodeStatus: readContext.nodeStatus,
    nodeHealth: readContext.nodeHealth,
    indexer: readContext.indexer,
    paths,
  });

  assert.equal(mining.runtime.note, "Mining is paused, but the last mining transaction may still confirm from mempool without further fee bumps.");
  assert.equal(mining.runtime.lastError, null);
  assert.equal(mining.runtime.providerState, "ready");
});
