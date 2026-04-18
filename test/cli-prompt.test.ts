import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";

import { createTerminalPrompter } from "../src/cli/prompt.js";

function createCollectedStream() {
  const stream = new PassThrough();
  let rendered = "";

  stream.on("data", (chunk) => {
    rendered += chunk.toString("utf8");
  });

  return {
    stream,
    read() {
      return rendered;
    },
  };
}

test("hidden terminal prompts keep the question visible while suppressing the entered text", async () => {
  const input = new PassThrough();
  const output = createCollectedStream();

  const prompter = createTerminalPrompter(
    input as unknown as NodeJS.ReadStream,
    output.stream as unknown as NodeJS.WriteStream,
  );
  const promptHidden = prompter.promptHidden;
  assert.ok(typeof promptHidden === "function");

  const answerPromise = promptHidden("Client password: ");
  process.nextTick(() => {
    input.end("correct horse battery staple\n");
  });

  const answer = await answerPromise;

  assert.equal(answer, "correct horse battery staple");
  assert.match(output.read(), /Client password: /);
  assert.ok(output.read().endsWith("\n"));
  assert.doesNotMatch(output.read(), /correct horse battery staple/);
});

test("terminal selector supports raw-mode arrow navigation", async () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawModeCalls: [] as boolean[],
    setRawMode(enabled: boolean) {
      this.setRawModeCalls.push(enabled);
    },
  });
  const output = createCollectedStream();
  const outputStream = Object.assign(output.stream, { isTTY: true });

  const prompter = createTerminalPrompter(
    input as unknown as NodeJS.ReadStream,
    outputStream as unknown as NodeJS.WriteStream,
  );
  const selectOption = prompter.selectOption;
  assert.ok(typeof selectOption === "function");
  const answerPromise = selectOption({
    message: "Choose a model:",
    options: [
      { label: "GPT-5.4", value: "gpt-5.4" },
      { label: "GPT-5.4 mini", value: "gpt-5.4-mini" },
      { label: "GPT-5.4 nano", value: "gpt-5.4-nano" },
    ],
    initialValue: "gpt-5.4-mini",
    footer: "Approximate daily cost footer.",
  });

  process.nextTick(() => {
    input.write("\u001B[B");
    input.write("\r");
  });

  const answer = await answerPromise;

  assert.equal(answer, "gpt-5.4-nano");
  assert.deepEqual(input.setRawModeCalls, [true, false]);
});

test("terminal selector cancels cleanly on escape", async () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() {},
  });
  const output = createCollectedStream();
  const outputStream = Object.assign(output.stream, { isTTY: true });
  const prompter = createTerminalPrompter(
    input as unknown as NodeJS.ReadStream,
    outputStream as unknown as NodeJS.WriteStream,
  );
  const selectOption = prompter.selectOption;
  assert.ok(typeof selectOption === "function");
  const answerPromise = selectOption({
    message: "Choose a model:",
    options: [
      { label: "GPT-5.4", value: "gpt-5.4" },
      { label: "GPT-5.4 mini", value: "gpt-5.4-mini" },
    ],
  });

  process.nextTick(() => {
    input.write("\u001B");
  });

  await assert.rejects(answerPromise, /mining_setup_canceled/);
});

test("terminal selector falls back to numbered choices when raw mode is unavailable", async () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
  });
  const output = createCollectedStream();
  const outputStream = Object.assign(output.stream, { isTTY: true });

  const prompter = createTerminalPrompter(
    input as unknown as NodeJS.ReadStream,
    outputStream as unknown as NodeJS.WriteStream,
  );
  const selectOption = prompter.selectOption;
  assert.ok(typeof selectOption === "function");
  const answerPromise = selectOption({
    message: "Choose a model:",
    options: [
      { label: "GPT-5.4", value: "gpt-5.4" },
      { label: "GPT-5.4 mini", value: "gpt-5.4-mini" },
      { label: "GPT-5.4 nano", value: "gpt-5.4-nano" },
    ],
  });

  process.nextTick(() => {
    input.end("2\n");
  });

  const answer = await answerPromise;

  assert.equal(answer, "gpt-5.4-mini");
});
