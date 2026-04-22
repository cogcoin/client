import type { WalletRuntimePaths } from "../../../wallet/runtime.js";
import type { WalletSecretProvider } from "../../../wallet/state/provider.js";
import type { WalletPrompter } from "../../../wallet/lifecycle.js";
import type {
  WalletMutationFeeSummary,
} from "../../../wallet/tx/index.js";
import type { MutationSuccessNextSteps } from "../../mutation-success.js";
import type { MutationTextField } from "../../mutation-text-write.js";
import type {
  ParsedCliArgs,
  RequiredCliRunnerContext,
} from "../../types.js";

export interface ResolvedWalletMutationCommandContext {
  parsed: ParsedCliArgs;
  context: RequiredCliRunnerContext;
  runtimePaths: WalletRuntimePaths;
  dataDir: string;
  dbPath: string;
  prompter: WalletPrompter;
  provider: WalletSecretProvider;
  interactive: boolean;
}

export interface WalletMutationCommandSuccessDescriptor {
  reusedExisting: boolean;
  reusedMessage: string;
  fees?: WalletMutationFeeSummary | null;
  explorerTxid?: string | null;
  nextSteps: MutationSuccessNextSteps;
  text: {
    heading: string;
    fields: MutationTextField[];
  };
}

export interface WalletMutationCommandSpec {
  id: string;
  run(
    context: ResolvedWalletMutationCommandContext,
  ): Promise<WalletMutationCommandSuccessDescriptor>;
}
