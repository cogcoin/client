import type {
  CliErrorPresentation,
  CliErrorPresentationInput,
  CliErrorPresentationRule,
} from "../types.js";
import { cliSurfaceErrorRules } from "./cli-surface.js";
import { genericCliErrorRules } from "./generic.js";
import { miningAndUpdateErrorRules } from "./mining-update.js";
import { serviceErrorRules } from "./services.js";
import { walletAdminErrorRules } from "./wallet-admin.js";
import { walletMutationErrorRules } from "./wallet-mutations.js";

const cliErrorPresentationRules: readonly CliErrorPresentationRule[] = [
  ...walletAdminErrorRules,
  ...cliSurfaceErrorRules,
  ...miningAndUpdateErrorRules,
  ...serviceErrorRules,
  ...walletMutationErrorRules,
  ...genericCliErrorRules,
];

export function createCliErrorPresentation(
  errorCode: string,
  fallbackMessage: string,
  error?: unknown,
): CliErrorPresentation | null {
  const input: CliErrorPresentationInput = { errorCode, fallbackMessage, error };

  for (const rule of cliErrorPresentationRules) {
    const presentation = rule(input);
    if (presentation !== null) {
      return presentation;
    }
  }

  return null;
}
