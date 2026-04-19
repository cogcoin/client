import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";

import type { WalletSecretProvider } from "../src/wallet/state/provider.js";

const LEGACY_CLIENT_PASSWORD_PIPE_PREFIX = "\\\\.\\pipe\\cogcoin-client-password-";

export async function listLegacyClientPasswordPipeArtifactsForTesting(
  root = process.cwd(),
): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.name.startsWith(LEGACY_CLIENT_PASSWORD_PIPE_PREFIX))
    .map((entry) => entry.name)
    .sort();
}

export async function cleanupLegacyClientPasswordPipeArtifactsForTesting(
  root = process.cwd(),
): Promise<void> {
  const entries = await listLegacyClientPasswordPipeArtifactsForTesting(root);

  await Promise.all(entries.map(async (entry) => {
    await rm(join(root, entry), { force: true }).catch(() => undefined);
  }));
}

beforeEach(async () => {
  await cleanupLegacyClientPasswordPipeArtifactsForTesting();
});

afterEach(async () => {
  await cleanupLegacyClientPasswordPipeArtifactsForTesting();
});

export function createScriptedPrompter(responses: string[]) {
  let index = 0;

  return {
    isInteractive: true,
    writeLine() {},
    async prompt(): Promise<string> {
      return responses[index++] ?? "";
    },
    async promptHidden(): Promise<string> {
      return responses[index++] ?? "";
    },
  };
}

export async function configureTestClientPassword(
  provider: WalletSecretProvider,
  options: {
    password?: string;
    hint?: string;
  } = {},
): Promise<void> {
  const password = options.password ?? "test-client-password";
  const hint = options.hint ?? "test hint";

  assert.ok(typeof provider.ensureClientPasswordConfigured === "function");

  await provider.ensureClientPasswordConfigured!(
    createScriptedPrompter([password, password, hint]),
  );
}
