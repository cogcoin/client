import { createInterface } from "node:readline/promises";

import type { WalletPrompter } from "../wallet/lifecycle.js";
import type { ReadableLike, WritableLike } from "./types.js";

const CLEAR_SENSITIVE_DISPLAY_SEQUENCE = "\u001B[2J\u001B[3J\u001B[H";
const CLEAR_MENU_SEQUENCE = "\u001B[0J";

function countRenderedLines(text: string): number {
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

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

  const supportsRawSelection = (): boolean => {
    const readable = ensureReadableInput() as NodeJS.ReadStream & {
      setRawMode?: (enabled: boolean) => void;
    };

    return Boolean(
      readable.isTTY
      && output.isTTY
      && typeof readable.setRawMode === "function",
    );
  };

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

  const promptSelectionFallback = async (options: Parameters<NonNullable<WalletPrompter["selectOption"]>>[0]): Promise<string> => {
    const writableOutput = ensureWritableOutput();
    writableOutput.write(`${options.message}\n`);
    for (const [index, option] of options.options.entries()) {
      const description = option.description == null || option.description.length === 0
        ? ""
        : ` - ${option.description}`;
      writableOutput.write(`${index + 1}. ${option.label}${description}\n`);
    }
    if (options.footer != null && options.footer.length > 0) {
      writableOutput.write(`${options.footer}\n`);
    }

    while (true) {
      const answer = (await ask(`Choice [1-${options.options.length}]: `, writableOutput)).trim();

      if (/^(q|quit|esc|escape)$/i.test(answer)) {
        throw new Error("mining_setup_canceled");
      }

      const selection = Number.parseInt(answer, 10);

      if (Number.isInteger(selection) && selection >= 1 && selection <= options.options.length) {
        return options.options[selection - 1]!.value;
      }

      writableOutput.write(`Enter a number from 1 to ${options.options.length}, or q to cancel.\n`);
    }
  };

  const promptSelectionRaw = async (options: Parameters<NonNullable<WalletPrompter["selectOption"]>>[0]): Promise<string> => {
    const readableInput = ensureReadableInput() as NodeJS.ReadStream & {
      setRawMode: (enabled: boolean) => void;
      pause?: () => void;
      resume?: () => void;
    };
    const writableOutput = ensureWritableOutput();
    const initialIndex = options.initialValue == null
      ? -1
      : options.options.findIndex((option) => option.value === options.initialValue);
    let selectedIndex = initialIndex === -1 ? 0 : initialIndex;
    let renderedLineCount = 0;

    const renderMenu = (): void => {
      if (renderedLineCount > 0) {
        writableOutput.write(`\u001B[${renderedLineCount}A${CLEAR_MENU_SEQUENCE}`);
      }

      const lines = [
        options.message,
        "Use Up/Down to choose, Enter to confirm, or q/Esc/Ctrl+C to cancel.",
        ...options.options.map((option, index) => {
          const prefix = index === selectedIndex ? ">" : " ";
          const description = option.description == null || option.description.length === 0
            ? ""
            : ` - ${option.description}`;
          return `${prefix} ${option.label}${description}`;
        }),
      ];

      if (options.footer != null && options.footer.length > 0) {
        lines.push(options.footer);
      }

      const rendered = `${lines.join("\n")}\n`;
      renderedLineCount = countRenderedLines(rendered);
      writableOutput.write(rendered);
    };

    return await new Promise<string>((resolve, reject) => {
      const finish = (handler: () => void): void => {
        readableInput.off("data", onData);
        readableInput.setRawMode(false);
        readableInput.pause?.();
        writableOutput.write("\n");
        handler();
      };

      const onData = (chunk: Buffer | string): void => {
        const value = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;

        switch (value) {
          case "\u001B[A":
            selectedIndex = selectedIndex === 0 ? options.options.length - 1 : selectedIndex - 1;
            renderMenu();
            return;
          case "\u001B[B":
            selectedIndex = selectedIndex === options.options.length - 1 ? 0 : selectedIndex + 1;
            renderMenu();
            return;
          case "\r":
          case "\n":
            finish(() => resolve(options.options[selectedIndex]!.value));
            return;
          case "\u001B":
          case "\u0003":
          case "q":
          case "Q":
            finish(() => reject(new Error("mining_setup_canceled")));
            return;
          default:
            return;
        }
      };

      readableInput.setRawMode(true);
      readableInput.resume?.();
      readableInput.on("data", onData);
      renderMenu();
    });
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
      const hiddenOutput = Object.create(writableOutput) as NodeJS.WriteStream & {
        on?: (...args: unknown[]) => unknown;
        once?: (...args: unknown[]) => unknown;
        off?: (...args: unknown[]) => unknown;
        removeListener?: (...args: unknown[]) => unknown;
      };

      hiddenOutput.write = (() => true) as NodeJS.WriteStream["write"];

      hiddenOutput.on ??= (() => hiddenOutput) as typeof hiddenOutput.on;
      hiddenOutput.once ??= (() => hiddenOutput) as typeof hiddenOutput.once;
      hiddenOutput.off ??= (() => hiddenOutput) as typeof hiddenOutput.off;
      hiddenOutput.removeListener ??= (() => hiddenOutput) as typeof hiddenOutput.removeListener;

      output.write(message);

      try {
        return await ask("", hiddenOutput);
      } finally {
        output.write("\n");
      }
    },
    async selectOption(options): Promise<string> {
      if (!supportsRawSelection()) {
        return await promptSelectionFallback(options);
      }

      return await promptSelectionRaw(options);
    },
    clearSensitiveDisplay(scope: "mnemonic-reveal" | "restore-mnemonic-entry"): void {
      if (!input.isTTY || !output.isTTY) {
        return;
      }

      if (scope === "mnemonic-reveal" || scope === "restore-mnemonic-entry") {
        output.write(CLEAR_SENSITIVE_DISPLAY_SEQUENCE);
      }
    },
  };
}
