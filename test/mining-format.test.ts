import test from "node:test";
import assert from "node:assert/strict";

import { formatMineStatusReport } from "../src/cli/mining-format.js";
import { createMiningControlPlaneView, createMiningRuntimeStatus } from "./current-model-helpers.js";

test("mine status text renders the default provider model", () => {
  const report = formatMineStatusReport(createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      providerState: "ready",
    }),
    provider: {
      configured: true,
      provider: "anthropic",
      status: "ready",
      message: null,
      modelId: "claude-sonnet-4-20250514",
      effectiveModel: "claude-sonnet-4-20250514",
      modelOverride: null,
      modelSelectionSource: "legacy-default",
      usingDefaultModel: true,
      extraPromptConfigured: false,
      estimatedDailyCostUsd: null,
      estimatedDailyCostDisplay: null,
    },
  }));

  assert.match(report, /Provider: anthropic configured/);
  assert.match(report, /Provider model: claude-sonnet-4-20250514 \(default\)/);
  assert.match(report, /Provider model source: legacy-default/);
});

test("mine status text renders the override provider model and 404 next step", () => {
  const report = formatMineStatusReport(createMiningControlPlaneView({
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
  }));

  assert.match(report, /Provider model: claude-sonnet-4-missing \(override\)/);
  assert.match(report, /Provider model source: custom/);
  assert.match(report, /Provider runtime: not-found/);
  assert.match(report, /Note: Mining is waiting because the configured sentence-provider model was not found\./);
  assert.match(report, /Next: run `cogcoin mine setup` and clear or correct the provider model\./);
});

test("mine status text shows the insufficient-funds next step from publish decision", () => {
  const report = formatMineStatusReport(createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      currentPhase: "waiting",
      miningState: "paused",
      currentPublishDecision: "publish-paused-insufficient-funds",
      note: "Insufficient BTC to mine.",
    }),
  }));

  assert.match(report, /Publish decision: publish-paused-insufficient-funds/);
  assert.match(report, /Note: Insufficient BTC to mine\./);
  assert.match(report, /Next: wait for enough safe BTC funding to become spendable for the next publish; mining resumes automatically\./);
  assert.doesNotMatch(report, /Note: Insufficient funds for mining\./);
});

test("mine status text shows concrete Bitcoin publishability blockers", () => {
  const report = formatMineStatusReport(createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      currentPhase: "waiting-bitcoin-network",
      readinessBlocker: "bitcoin-core",
      corePublishState: "mempool-loading",
      note: null,
    }),
  }));

  assert.match(report, /Readiness blocker: bitcoin-core/);
  assert.match(report, /Core publishability: mempool-loading/);
  assert.match(report, /Note: Mining is waiting because Bitcoin Core is still loading its mempool\./);
});

test("mine status text separates current target from stale live publish tx", () => {
  const report = formatMineStatusReport(createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      currentPhase: "idle",
      miningState: "paused-stale",
      targetBlockHeight: 102,
      referencedBlockHashDisplay: "22".repeat(32),
      currentTxid: "aa".repeat(32),
      livePublishInMempool: true,
      livePublishTargetBlockHeight: 101,
      livePublishReferencedBlockHashDisplay: "11".repeat(32),
      livePublishTxid: "aa".repeat(32),
      livePublishDecision: "paused-stale-mempool",
      livePublishStaleToCoreTip: true,
      currentPublishDecision: "publish-skipped-no-candidate",
    }),
  }));

  assert.match(report, /Current target height: 102/);
  assert.match(report, new RegExp(`Current referenced block: ${"22".repeat(32)}`));
  assert.match(report, new RegExp(`Live publish txid: ${"aa".repeat(32)}`));
  assert.match(report, /Live publish target height: 101/);
  assert.match(report, new RegExp(`Live publish referenced block: ${"11".repeat(32)}`));
  assert.match(report, /Live publish decision: paused-stale-mempool/);
  assert.match(report, /Live publish stale to Core tip: yes/);
  assert.match(report, /Publish decision: publish-skipped-no-candidate/);
  assert.doesNotMatch(report, /Current txid:/);
});

test("mine status text renders competitiveness gate diagnostics", () => {
  const report = formatMineStatusReport(createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      currentPhase: "waiting",
      miningState: "idle",
      currentPublishDecision: "indeterminate-mempool-gate",
      competitivenessGateIndeterminate: true,
      competitivenessGateReason: "mempool_index_hydration_incomplete",
      competitivenessGateDiagnostics: {
        visibleMempoolTxCount: 12,
        indexedContextCount: 9,
        negativeTxCount: 2,
        unknownTxCount: 3,
        hydratedTxCount: 7,
        mempoolEntryCount: 8,
        missingEntryCount: 1,
        cacheStatus: "index-warming",
        mempoolSequence: "seq-42",
        candidateRank: null,
        higherRankedCompetitorDomainCount: 0,
        dedupedCompetitorDomainCount: 0,
      },
      mempoolSequenceCacheStatus: "index-warming",
      lastMempoolSequence: "seq-42",
    }),
  }));

  assert.match(report, /Publish decision: indeterminate-mempool-gate/);
  assert.match(report, /Competitiveness gate: indeterminate \(mempool_index_hydration_incomplete\), so this tick was skipped safely/);
  assert.match(report, /Gate diagnostics: visible=12 indexed=9 negative=2 unknown=3 hydrated=7 entries=8 missingEntries=1 higherDomains=0 competitorDomains=0/);
  assert.match(report, /Last mempool sequence: seq-42/);
  assert.match(report, /Gate cache: index-warming/);
  assert.doesNotMatch(report, /raw transaction/i);
});

test("mine status text renders auto-reconciled mining publish decisions", () => {
  const emptyPublishReport = formatMineStatusReport(createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      currentPhase: "idle",
      miningState: "idle",
      currentPublishDecision: "repair-auto-cleared-empty-publish",
      note: "No locally controlled anchored root domains are currently eligible to mine.",
    }),
  }));
  const confirmedConflictReport = formatMineStatusReport(createMiningControlPlaneView({
    runtime: createMiningRuntimeStatus({
      currentPhase: "idle",
      miningState: "idle",
      currentPublishDecision: "repair-auto-cleared-confirmed-conflict",
      note: "No locally controlled anchored root domains are currently eligible to mine.",
    }),
  }));

  assert.match(emptyPublishReport, /Publish decision: repair-auto-cleared-empty-publish/);
  assert.match(confirmedConflictReport, /Publish decision: repair-auto-cleared-confirmed-conflict/);
});
