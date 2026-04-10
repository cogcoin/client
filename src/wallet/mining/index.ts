export {
  isMiningGenerationAbortRequested,
  markMiningGenerationActive,
  markMiningGenerationInactive,
  readMiningGenerationActivity,
  readMiningPreemptionRequest,
  requestMiningGenerationPreemption,
} from "./coordination.js";
export {
  disableMiningHooks,
  enableMiningHooks,
  followMiningLog,
  inspectMiningControlPlane,
  readMiningLog,
  refreshMiningRuntimeStatus,
  setupBuiltInMining,
} from "./control.js";
export {
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
export {
  ensureMiningHookTemplate,
  inspectMiningHookState,
  runGenerateSentencesHookRequest,
  validateCustomMiningHook,
} from "./hooks.js";
export type {
  GenerateSentencesHookCandidateV1,
  GenerateSentencesHookRequestV1,
  GenerateSentencesHookResponseV1,
  MiningHookOperatorValidationState,
} from "./hook-protocol.js";
export {
  loadClientConfig,
  saveBuiltInMiningProviderConfig,
  saveClientConfig,
} from "./config.js";
export type {
  ClientConfigV1,
  MiningControlPlaneView,
  MiningEventRecord,
  MiningHookInspection,
  MiningProviderConfigRecord,
  MiningProviderInspection,
  MiningRuntimeStatusV1,
  MiningServiceHealth,
} from "./types.js";
