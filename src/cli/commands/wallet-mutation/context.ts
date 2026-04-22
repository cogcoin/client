import { withInteractiveWalletSecretProvider } from "../../../wallet/state/provider.js";
import type {
  ParsedCliArgs,
  RequiredCliRunnerContext,
} from "../../types.js";
import type { ResolvedWalletMutationCommandContext } from "./types.js";

export function resolveWalletMutationCommandContext(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
  runtimePaths = context.resolveWalletRuntimePaths(),
): ResolvedWalletMutationCommandContext {
  const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
  const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();
  const prompter = context.createPrompter();
  const interactive = prompter.isInteractive;
  const provider = withInteractiveWalletSecretProvider(
    context.walletSecretProvider,
    prompter,
  );

  return {
    parsed,
    context,
    runtimePaths,
    dataDir,
    dbPath,
    prompter,
    provider,
    interactive,
  };
}
