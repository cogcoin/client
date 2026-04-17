import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";

import { createTerminalPrompter } from "../src/cli/prompt.js";

test("hidden terminal prompts keep the question visible while suppressing the entered text", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";

  output.on("data", (chunk) => {
    rendered += chunk.toString("utf8");
  });

  const prompter = createTerminalPrompter(
    input as unknown as NodeJS.ReadStream,
    output as unknown as NodeJS.WriteStream,
  );
  const promptHidden = prompter.promptHidden;
  assert.ok(typeof promptHidden === "function");

  const answerPromise = promptHidden("Client password: ");
  process.nextTick(() => {
    input.end("correct horse battery staple\n");
  });

  const answer = await answerPromise;

  assert.equal(answer, "correct horse battery staple");
  assert.match(rendered, /Client password: /);
  assert.ok(rendered.endsWith("\n"));
  assert.doesNotMatch(rendered, /correct horse battery staple/);
});
