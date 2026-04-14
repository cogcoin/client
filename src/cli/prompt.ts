import { createInterface } from "node:readline/promises";

import type { WalletPrompter } from "../wallet/lifecycle.js";
import type { ReadableLike, WritableLike } from "./types.js";

const CLEAR_SENSITIVE_DISPLAY_SEQUENCE = "\u001B[2J\u001B[3J\u001B[H";

export function createTerminalPrompter(
  input: NodeJS.ReadStream | ReadableLike,
  output: NodeJS.WriteStream | WritableLike,
): WalletPrompter {
  const ensureReadableInput = (): NodeJS.ReadStream => {
    if (!("on" in input) || !("off" in input)) {
      throw new Error("wallet_prompt_input_unavailable");
    }

    return input as NodeJS.ReadStream;
  };

  const ensureWritableOutput = (): NodeJS.WriteStream => output as NodeJS.WriteStream;

  const ask = async (
    message: string,
    questionOutput: NodeJS.WriteStream,
  ): Promise<string> => {
    const readline = createInterface({
      input: ensureReadableInput(),
      output: questionOutput,
    });

    try {
      return await readline.question(message);
    } finally {
      readline.close();
    }
  };

  return {
    isInteractive: Boolean(input.isTTY && output.isTTY),
    writeLine(message: string): void {
      output.write(`${message}\n`);
    },
    async prompt(message: string): Promise<string> {
      return await ask(message, ensureWritableOutput());
    },
    async promptHidden(message: string): Promise<string> {
      const writableOutput = ensureWritableOutput() as NodeJS.WriteStream & {
        on?: (...args: unknown[]) => unknown;
        once?: (...args: unknown[]) => unknown;
        off?: (...args: unknown[]) => unknown;
        removeListener?: (...args: unknown[]) => unknown;
      };
      let promptShown = false;
      const hiddenOutput = Object.create(writableOutput) as NodeJS.WriteStream & {
        on?: (...args: unknown[]) => unknown;
        once?: (...args: unknown[]) => unknown;
        off?: (...args: unknown[]) => unknown;
        removeListener?: (...args: unknown[]) => unknown;
      };

      hiddenOutput.write = ((chunk: string): boolean => {
          if (!promptShown) {
            promptShown = true;
            output.write(chunk);
            return true;
          }

          if (chunk === "\n" || chunk === "\r\n") {
            output.write(chunk);
          }
          return true;
        }) as NodeJS.WriteStream["write"];

      hiddenOutput.on ??= (() => hiddenOutput) as typeof hiddenOutput.on;
      hiddenOutput.once ??= (() => hiddenOutput) as typeof hiddenOutput.once;
      hiddenOutput.off ??= (() => hiddenOutput) as typeof hiddenOutput.off;
      hiddenOutput.removeListener ??= (() => hiddenOutput) as typeof hiddenOutput.removeListener;

      return await ask(message, hiddenOutput);
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
