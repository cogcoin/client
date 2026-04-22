import { requestMiningGenerationPreemption, type MiningPreemptionHandle } from "../mining/coordination.js";
import type { WalletRuntimePaths } from "../runtime.js";

export async function pauseMiningForWalletMutation(options: {
  paths: WalletRuntimePaths;
  reason: string;
}): Promise<MiningPreemptionHandle> {
  return requestMiningGenerationPreemption({
    paths: options.paths,
    reason: options.reason,
  });
}
