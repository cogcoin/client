export {
  isMiningGenerationAbortRequested,
  markMiningGenerationActive,
  markMiningGenerationInactive,
  readMiningGenerationActivity,
  readMiningPreemptionRequest,
  requestMiningGenerationPreemption,
} from "./coordination.js";
export {
  followMiningLog,
  inspectMiningControlPlane,
  readMiningLog,
  refreshMiningRuntimeStatus,
  setupBuiltInMining,
} from "./control.js";
export {
  ensureBuiltInMiningSetupIfNeeded,
  runBackgroundMiningWorker,
  runForegroundMining,
  startBackgroundMining,
  stopBackgroundMining,
  type MiningStartResult,
} from "./runner.js";
export {
  appendMiningEvent,
  loadMiningRuntimeStatus,
  readMiningEvents,
  resolveRotatedMiningEventsPath,
  saveMiningRuntimeStatus,
} from "./runtime-artifacts.js";
export type {
  MiningSentenceCandidateV1,
  MiningSentenceGenerationRequestV1,
  MiningSentenceGenerationResponseV1,
} from "./sentence-protocol.js";
export {
  loadClientConfig,
  saveBuiltInMiningProviderConfig,
  saveClientConfig,
} from "./config.js";
export type {
  ClientConfigV1,
  MiningControlPlaneView,
  MiningEventRecord,
  MiningProviderConfigRecord,
  MiningProviderInspection,
  MiningRuntimeStatusV1,
  MiningServiceHealth,
} from "./types.js";
