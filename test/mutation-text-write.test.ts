import assert from "node:assert/strict";
import test from "node:test";

import { writeMutationTextResult } from "../src/cli/mutation-text-write.js";

class MemoryStream {
  readonly chunks: string[] = [];

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  toString(): string {
    return this.chunks.join("");
  }
}

test("writeMutationTextResult preserves heading, field order, reuse messaging, and trailer lines", () => {
  const stream = new MemoryStream();

  writeMutationTextResult(stream, {
    heading: "Field create+write family submitted.",
    fields: [
      { label: "Domain", value: "alpha" },
      { label: "Field", value: "tagline" },
      { label: "Value", value: "format 1, 5 bytes", when: true },
      { label: "Skipped", value: "never", when: false },
      { label: "Status", value: "live" },
    ],
    reusedExisting: true,
    reusedMessage: "The existing pending field family was reconciled instead of creating a duplicate.",
    trailerLines: [
      "Next step: cogcoin field show alpha tagline",
      "Next step: cogcoin show alpha",
    ],
  });

  assert.equal(stream.toString(), [
    "Field create+write family submitted.",
    "Domain: alpha",
    "Field: tagline",
    "Value: format 1, 5 bytes",
    "Status: live",
    "The existing pending field family was reconciled instead of creating a duplicate.",
    "Next step: cogcoin field show alpha tagline",
    "Next step: cogcoin show alpha",
    "",
  ].join("\n"));
});
