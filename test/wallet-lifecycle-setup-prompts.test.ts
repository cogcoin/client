import test from "node:test";
import assert from "node:assert/strict";

import {
  clearSensitiveDisplay,
  confirmMnemonic,
  confirmTypedAcknowledgement,
  promptForInitializationMode,
  promptForRestoreMnemonic,
} from "../src/wallet/lifecycle/setup-prompts.js";
import type { WalletPrompter } from "../src/wallet/lifecycle/types.js";
import { DEFAULT_TEST_MNEMONIC } from "./wallet-lifecycle-test-helpers.js";

function createScriptedPrompter(options: {
  answers?: string[];
  selectValue?: "generated" | "restored";
  throwOnClear?: boolean;
} = {}) {
  const writes: string[] = [];
  const prompts: string[] = [];
  const answers = [...(options.answers ?? [])];
  let selectionCalls = 0;

  const prompter: WalletPrompter = {
    isInteractive: true,
    writeLine(message: string) {
      writes.push(message);
    },
    async prompt(message: string) {
      prompts.push(message);
      return answers.shift() ?? "";
    },
    async selectOption() {
      selectionCalls += 1;
      return options.selectValue ?? "generated";
    },
    async clearSensitiveDisplay() {
      if (options.throwOnClear) {
        throw new Error("clear_failed");
      }
    },
  };

  return {
    prompter,
    writes,
    prompts,
    getSelectionCalls() {
      return selectionCalls;
    },
  };
}

test("promptForInitializationMode prefers selectOption when available", async () => {
  const scripted = createScriptedPrompter({
    selectValue: "restored",
  });

  const mode = await promptForInitializationMode(scripted.prompter);

  assert.equal(mode, "restored");
  assert.equal(scripted.getSelectionCalls(), 1);
});

test("promptForInitializationMode falls back to the numbered menu and retries invalid answers", async () => {
  const scripted = createScriptedPrompter({
    answers: ["9", "2"],
  });
  delete scripted.prompter.selectOption;

  const mode = await promptForInitializationMode(scripted.prompter);

  assert.equal(mode, "restored");
  assert.deepEqual(scripted.prompts, ["Choice [1-2]: ", "Choice [1-2]: "]);
  assert.ok(scripted.writes.includes("Enter 1 or 2."));
});

test("promptForRestoreMnemonic rejects invalid restore phrases", async () => {
  const scripted = createScriptedPrompter({
    answers: [...Array(24).fill("abandon")],
  });
  scripted.prompter.prompt = async (message: string) => {
    scripted.prompts.push(message);
    return message.startsWith("Word 24") ? "invalidword" : "abandon";
  };

  await assert.rejects(
    promptForRestoreMnemonic(scripted.prompter),
    /wallet_restore_mnemonic_invalid/,
  );
});

test("confirmMnemonic and typed acknowledgement keep the existing validation behavior", async () => {
  const words = DEFAULT_TEST_MNEMONIC.split(/\s+/);
  const typed = createScriptedPrompter({
    answers: [words[0], words[1], "show mnemonic"],
  });

  await confirmMnemonic(typed.prompter, words.slice(0, 2));
  await confirmTypedAcknowledgement(
    typed.prompter,
    "show mnemonic",
    "Type \"show mnemonic\" to continue: ",
    "wallet_show_mnemonic_typed_ack_required",
  );

  await assert.rejects(
    confirmTypedAcknowledgement(
      createScriptedPrompter({ answers: ["nope"] }).prompter,
      "show mnemonic",
      "Type \"show mnemonic\" to continue: ",
      "wallet_show_mnemonic_typed_ack_required",
    ),
    /wallet_show_mnemonic_typed_ack_required/,
  );
});

test("clearSensitiveDisplay swallows cleanup errors from the prompter", async () => {
  await clearSensitiveDisplay(
    createScriptedPrompter({ throwOnClear: true }).prompter,
    "mnemonic-reveal",
  );
});
