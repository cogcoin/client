import test from "node:test";
import assert from "node:assert/strict";

import { formatMineStatusReport } from "../src/cli/mining-format.js";
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

test("mine status text exposes live publish wait guidance", () => {
  const mining = createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      miningState: "paused",
      currentPhase: "waiting",
      livePublishInMempool: true,
      currentPublishDecision: "kept-live-publish",
      note: "Waiting on current publish.",
    }),
  });

  const report = formatMineStatusReport(mining);

  assert.match(report, /Publish decision: kept-live-publish/);
  assert.match(report, /Next: wait for the live mining publish to confirm, or rerun mining when you want replacements to resume\./);
});

test("mine status text avoids family wording in the note", () => {
  const mining = createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      note: "Mining is paused while another wallet mutation is active.",
    }),
  });

  const report = formatMineStatusReport(mining);
  assert.match(report, /Note: Mining is paused while another wallet mutation is active\./);
  assert.doesNotMatch(report, /family/);
});

test("mine status text exposes the effective provider model and not-found next step", () => {
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

  const report = formatMineStatusReport(mining);

  assert.match(report, /Provider model: claude-sonnet-4-missing \(override\)/);
  assert.match(report, /Provider model source: custom/);
  assert.match(report, /Provider runtime: not-found/);
  assert.match(report, /Next: run `cogcoin mine setup` and clear or correct the provider model\./);
});

test("mine status text shows the insufficient-funds next step from publish decision", () => {
  const mining = createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      currentPhase: "waiting",
      miningState: "paused",
      currentPublishDecision: "publish-paused-insufficient-funds",
      note: "Insufficient BTC to mine.",
    }),
  });

  const report = formatMineStatusReport(mining);

  assert.match(report, /Publish decision: publish-paused-insufficient-funds/);
  assert.match(report, /Next: wait for enough safe BTC funding to become spendable for the next publish; mining resumes automatically\./);
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
