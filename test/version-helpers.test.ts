import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { compareSemver } from "../src/semver.js";
import {
  CURRENT_ARTWORK_VERSION_TEXT,
  CURRENT_CLIENT_VERSION,
  NEWER_CLIENT_VERSION,
} from "./version-helpers.js";

test("current client version matches package.json", () => {
  const packageJsonRaw = readFileSync(join(process.cwd(), "package.json"), "utf8");
  const packageJson = JSON.parse(packageJsonRaw) as { version?: unknown };

  assert.equal(CURRENT_CLIENT_VERSION, packageJson.version);
});

test("newer client version compares greater than the current client version", () => {
  assert.equal(compareSemver(NEWER_CLIENT_VERSION, CURRENT_CLIENT_VERSION), 1);
});

test("current artwork version text prefixes the client version with v", () => {
  assert.equal(CURRENT_ARTWORK_VERSION_TEXT, `v${CURRENT_CLIENT_VERSION}`);
});
