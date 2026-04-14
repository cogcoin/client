import assert from "node:assert/strict";
import test from "node:test";

import {
  loadWalletArtTemplateForTesting,
  renderWalletMnemonicRevealArt,
} from "../src/wallet/mnemonic-art.js";

function formatSlot(index: number, word: string): string {
  return `${index}.${word.padEnd(8, " ")}`;
}

function assertFragmentsAppearInOrder(line: string, fragments: readonly string[]): void {
  let cursor = -1;

  for (const fragment of fragments) {
    const next = line.indexOf(fragment, cursor + 1);
    assert.notEqual(next, -1, `missing_fragment_${fragment}`);
    assert.ok(next > cursor, `fragment_out_of_order_${fragment}`);
    cursor = next;
  }
}

function requireLine(lines: readonly string[], fragment: string): string {
  const line = lines.find((entry) => entry.includes(fragment));
  assert.ok(line, `missing_line_${fragment}`);
  return line;
}

test("wallet mnemonic art template stays internally consistent", () => {
  const template = loadWalletArtTemplateForTesting();

  assert.equal(template.length, 10);

  for (const line of template) {
    assert.equal(line.length, 80);
  }
});

test("renderWalletMnemonicRevealArt maps the 24 words by numbered vertical columns", () => {
  const words = [
    "a",
    "bb",
    "ccc",
    "dddd",
    "eeeee",
    "ffffff",
    "ggggggg",
    "hhhhhhhh",
    "i",
    "jj",
    "kkk",
    "llll",
    "mmmmm",
    "nnnnnn",
    "ooooooo",
    "pppppppp",
    "q",
    "rr",
    "sss",
    "tttt",
    "uuuuu",
    "vvvvvv",
    "wwwwwww",
    "xxxxxxxx",
  ];
  const rendered = renderWalletMnemonicRevealArt(words);
  const row1 = requireLine(rendered, formatSlot(1, words[0]!));
  const row2 = requireLine(rendered, formatSlot(2, words[1]!));
  const row3 = requireLine(rendered, formatSlot(3, words[2]!));
  const row4 = requireLine(rendered, formatSlot(4, words[3]!));
  const row5 = requireLine(rendered, formatSlot(5, words[4]!));

  assertFragmentsAppearInOrder(row1, [
    formatSlot(1, words[0]!),
    formatSlot(6, words[5]!),
    formatSlot(11, words[10]!),
    formatSlot(16, words[15]!),
    formatSlot(21, words[20]!),
  ]);
  assertFragmentsAppearInOrder(row2, [
    formatSlot(2, words[1]!),
    formatSlot(7, words[6]!),
    formatSlot(12, words[11]!),
    formatSlot(17, words[16]!),
    formatSlot(22, words[21]!),
  ]);
  assertFragmentsAppearInOrder(row3, [
    formatSlot(3, words[2]!),
    formatSlot(8, words[7]!),
    formatSlot(13, words[12]!),
    formatSlot(18, words[17]!),
    formatSlot(23, words[22]!),
  ]);
  assertFragmentsAppearInOrder(row4, [
    formatSlot(4, words[3]!),
    formatSlot(9, words[8]!),
    formatSlot(14, words[13]!),
    formatSlot(19, words[18]!),
    formatSlot(24, words[23]!),
  ]);
  assertFragmentsAppearInOrder(row5, [
    formatSlot(5, words[4]!),
    formatSlot(10, words[9]!),
    formatSlot(15, words[14]!),
    formatSlot(20, words[19]!),
  ]);
  assert.ok(!row5.includes(formatSlot(24, words[23]!)));
  assert.ok(row3.includes(formatSlot(8, words[7]!)));

  const trailingAfterTwenty = row5.slice(
    row5.indexOf(formatSlot(20, words[19]!)) + formatSlot(20, words[19]!).length,
  );
  assert.equal(trailingAfterTwenty, "               │");
});
