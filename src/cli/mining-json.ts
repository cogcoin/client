import type {
  MiningControlPlaneView,
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
      modelOverride: view.provider.modelOverride,
      extraPromptConfigured: view.provider.extraPromptConfigured,
    },
    runtime: summarizeRuntime(view.runtime),
  };

  return buildStateChangeData({
    kind: "mine-setup",
    state: after,
    after,
  });
}

export function buildMineStartData(result: {
  started: boolean;
  snapshot: MiningRuntimeStatusV1 | null;
}) {
  const after = {
    started: result.started,
    runtime: summarizeRuntime(result.snapshot),
  };

  return buildStateChangeData({
    kind: "mine-start",
    state: after,
    after,
  });
}

export function buildMineStopData(snapshot: MiningRuntimeStatusV1 | null) {
  const after = {
    stopped: snapshot !== null,
    runtime: summarizeRuntime(snapshot),
    note: snapshot?.note ?? "Background mining was not active.",
  };

  return buildStateChangeData({
    kind: "mine-stop",
    state: after,
    after,
  });
}
