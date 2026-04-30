import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseSemver } from "../src/semver.js";

const packageJsonPath = join(process.cwd(), "package.json");
const packageJsonRaw = readFileSync(packageJsonPath, "utf8");
const packageJson = JSON.parse(packageJsonRaw) as { version?: unknown };

if (typeof packageJson.version !== "string") {
  throw new TypeError(`package.json is missing a string version at ${packageJsonPath}`);
}

const parsedCurrentVersion = parseSemver(packageJson.version);

if (parsedCurrentVersion === null) {
  throw new TypeError(`package.json version is not valid semver: ${packageJson.version}`);
}

export const CURRENT_CLIENT_VERSION = packageJson.version;
export const NEWER_CLIENT_VERSION =
  `${parsedCurrentVersion.major}.${parsedCurrentVersion.minor}.${parsedCurrentVersion.patch + 1}`;
export const CURRENT_ARTWORK_VERSION_TEXT = `v${CURRENT_CLIENT_VERSION}`;
