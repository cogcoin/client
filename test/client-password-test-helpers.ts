import assert from "node:assert/strict";

import type { WalletSecretProvider } from "../src/wallet/state/provider.js";

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
