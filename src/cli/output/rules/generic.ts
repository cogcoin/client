import { isBlockedError } from "../classify.js";
import type { CliErrorPresentationRule } from "../types.js";

export const genericCliErrorRules: readonly CliErrorPresentationRule[] = [
  ({ errorCode, fallbackMessage }) => {
    if (!isBlockedError(errorCode)) {
      return null;
    }

    return {
      what: fallbackMessage,
      why: "The command was blocked by the current local wallet or service state.",
      next: "Review `cogcoin status` and retry after the blocking condition is cleared.",
    };
  },
];
