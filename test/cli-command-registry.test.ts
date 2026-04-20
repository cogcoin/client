import assert from "node:assert/strict";
import test from "node:test";

import {
  commandSupportsSatvb,
  commandSupportsYesFlag,
  getCommandHandlerFamily,
  listCommandSpecsForTesting,
  resolveCommandMatch,
} from "../src/cli/command-registry.js";

function argvForAlias(alias: { tokens: readonly string[]; matchMode?: string }): string[] {
  if (alias.matchMode === "requires-arg") {
    return [...alias.tokens, "placeholder"];
  }

  if (alias.matchMode === "end-or-flag") {
    return [...alias.tokens, "--help"];
  }

  return [...alias.tokens];
}

test("every declared public command path resolves to its canonical command id", () => {
  for (const spec of listCommandSpecsForTesting()) {
    for (const alias of spec.aliases) {
      const argv = argvForAlias(alias);
      const match = resolveCommandMatch(argv, 0);

      assert.notEqual(match, null, alias.tokens.join(" "));
      assert.equal(match?.command, spec.id, alias.tokens.join(" "));
      assert.equal(match?.consumedTokens, alias.tokens.length, alias.tokens.join(" "));
      assert.deepEqual(match?.invokedTokens, alias.tokens, alias.tokens.join(" "));
    }
  }
});

test("representative aliases map to the expected canonical command and handler family", () => {
  const cases = [
    { argv: ["wallet", "init"], command: "init", family: "wallet-admin" },
    { argv: ["wallet", "address"], command: "address", family: "wallet-read" },
    { argv: ["wallet", "ids"], command: "ids", family: "wallet-read" },
    { argv: ["domain", "register", "alpha"], command: "register", family: "wallet-mutation" },
    { argv: ["domain", "show", "alpha"], command: "show", family: "wallet-read" },
    { argv: ["domain", "list", "--mineable"], command: "domains", family: "wallet-read" },
    { argv: ["field", "show", "alpha", "bio"], command: "field", family: "wallet-read" },
    { argv: ["field", "list", "alpha"], command: "fields", family: "wallet-read" },
    { argv: ["cog", "send", "10"], command: "send", family: "wallet-mutation" },
    { argv: ["cog", "claim", "lock-1"], command: "claim", family: "wallet-mutation" },
    { argv: ["cog", "reclaim", "lock-1"], command: "reclaim", family: "wallet-mutation" },
    { argv: ["mine", "prompt", "list"], command: "mine-prompt-list", family: "mining-read" },
  ] as const;

  for (const entry of cases) {
    const match = resolveCommandMatch(entry.argv, 0);

    assert.notEqual(match, null, entry.argv.join(" "));
    assert.equal(match?.command, entry.command, entry.argv.join(" "));
    assert.equal(getCommandHandlerFamily(match?.command ?? null), entry.family, entry.argv.join(" "));
  }
});

test("registry helpers preserve command capability metadata", () => {
  for (const spec of listCommandSpecsForTesting()) {
    assert.equal(commandSupportsYesFlag(spec.id), spec.supportsYes, spec.id);
    assert.equal(commandSupportsSatvb(spec.id), spec.supportsSatvb, spec.id);
  }

  assert.equal(commandSupportsYesFlag("register"), true);
  assert.equal(commandSupportsYesFlag("reset"), false);
  assert.equal(commandSupportsSatvb("register"), true);
  assert.equal(commandSupportsSatvb("mine-start"), false);
});
