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

  assert.equal(packageJson.version, "1.2.7");
  assert.equal(CURRENT_CLIENT_VERSION, packageJson.version);
});

test("package metadata targets the indexer release required for mirror history", () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const packageLock = JSON.parse(readFileSync(join(process.cwd(), "package-lock.json"), "utf8")) as {
    packages?: Record<string, {
      version?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>;
  };
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

  assert.equal(packageJson.dependencies?.["@cogcoin/indexer"], "1.0.2");
  assert.equal(packageLock.packages?.[""]?.dependencies?.["@cogcoin/indexer"], "1.0.2");
  assert.equal(packageLock.packages?.["node_modules/@cogcoin/indexer"]?.version, "1.0.2");
  assert.match(readme, /@cogcoin\/indexer@1\.0\.2/u);
});

test("package metadata uses vectors release aligned with the current indexer", () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const packageLock = JSON.parse(readFileSync(join(process.cwd(), "package-lock.json"), "utf8")) as {
    packages?: Record<string, {
      version?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>;
  };
  const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

  assert.equal(packageJson.devDependencies?.["@cogcoin/vectors"], "1.0.1");
  assert.equal(packageLock.packages?.[""]?.devDependencies?.["@cogcoin/vectors"], "1.0.1");
  assert.equal(packageLock.packages?.["node_modules/@cogcoin/vectors"]?.version, "1.0.1");
  assert.equal(
    packageLock.packages?.["node_modules/@cogcoin/vectors"]?.dependencies?.["@cogcoin/indexer"],
    "1.0.2",
  );
  assert.equal(packageLock.packages?.["node_modules/@cogcoin/vectors/node_modules/@cogcoin/indexer"], undefined);
  assert.match(readme, /@cogcoin\/vectors@1\.0\.1/u);
});

test("newer client version compares greater than the current client version", () => {
  assert.equal(compareSemver(NEWER_CLIENT_VERSION, CURRENT_CLIENT_VERSION), 1);
});

test("current artwork version text prefixes the client version with v", () => {
  assert.equal(CURRENT_ARTWORK_VERSION_TEXT, `v${CURRENT_CLIENT_VERSION}`);
});
