import { createInterface } from "node:readline/promises";

import type { WalletPrompter } from "../wallet/lifecycle.js";
import type { ReadableLike, WritableLike } from "./types.js";

const CLEAR_SENSITIVE_DISPLAY_SEQUENCE = "\u001B[2J\u001B[3J\u001B[H";

export function createTerminalPrompter(
  input: NodeJS.ReadStream | ReadableLike,
  output: NodeJS.WriteStream | WritableLike,
): WalletPrompter {
  return {
    isInteractive: Boolean(input.isTTY && output.isTTY),
    writeLine(message: string): void {
      output.write(`${message}\n`);
    },
    async prompt(message: string): Promise<string> {
      if (!("on" in input) || !("off" in input)) {
        throw new Error("wallet_prompt_input_unavailable");
      }

      const readline = createInterface({
        input: input as NodeJS.ReadStream,
        output: output as NodeJS.WriteStream,
      });

      try {
        return await readline.question(message);
      } finally {
        readline.close();
      }
    },
    clearSensitiveDisplay(scope: "mnemonic-reveal"): void {
      if (!input.isTTY || !output.isTTY) {
        return;
      }

      if (scope === "mnemonic-reveal") {
        output.write(CLEAR_SENSITIVE_DISPLAY_SEQUENCE);
      }
    },
  };
}
