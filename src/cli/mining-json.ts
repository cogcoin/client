import type {
  MiningControlPlaneView,
  MiningDomainPromptMutationResult,
  MiningRuntimeStatusV1,
} from "../wallet/mining/index.js";
import { buildStateChangeData } from "./mutation-json.js";

function summarizeRuntime(snapshot: MiningRuntimeStatusV1 | null) {
  if (snapshot === null) {
    return null;
  }

  return {
    runMode: snapshot.runMode,
    miningState: snapshot.miningState,
    currentPhase: snapshot.currentPhase,
    backgroundWorkerPid: snapshot.backgroundWorkerPid,
    backgroundWorkerRunId: snapshot.backgroundWorkerRunId,
    note: snapshot.note,
  };
}

export function buildMineSetupData(view: MiningControlPlaneView) {
  const after = {
    provider: {
      configured: view.provider.configured,
      provider: view.provider.provider,
      status: view.provider.status,
      modelId: view.provider.modelId,
      modelOverride: view.provider.modelOverride,
      modelSelectionSource: view.provider.modelSelectionSource,
      effectiveModel: view.provider.effectiveModel,
      usingDefaultModel: view.provider.usingDefaultModel,
      extraPromptConfigured: view.provider.extraPromptConfigured,
      estimatedDailyCostUsd: view.provider.estimatedDailyCostUsd,
      estimatedDailyCostDisplay: view.provider.estimatedDailyCostDisplay,
    },
    runtime: summarizeRuntime(view.runtime),
  };

  return buildStateChangeData({
    kind: "mine-setup",
    state: after,
    after,
  });
}

export function buildMinePromptData(result: MiningDomainPromptMutationResult) {
  return {
    domain: result.domain,
    previousPrompt: result.previousPrompt,
    prompt: result.prompt,
    status: result.status,
    fallbackPromptConfigured: result.fallbackPromptConfigured,
  };
}
