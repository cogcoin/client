import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { createScriptedPrompter } from "./client-password-test-helpers.js";
import { resolveClientPasswordContext } from "../src/wallet/state/client-password/context.js";
import { loadClientPasswordStateOrNull } from "../src/wallet/state/client-password/files.js";
import { ensureClientPasswordConfiguredResolved } from "../src/wallet/state/client-password/setup.js";
import { lockClientPasswordSessionResolved } from "../src/wallet/state/client-password/session.js";

test("client-password setup creates state and opens the initial 24-hour session through the setup owner", async (t) => {
  const stateRoot = await createTrackedTempDirectory(t, "cogcoin-client-password-setup");
  const context = resolveClientPasswordContext({
    platform: "linux",
    stateRoot,
    runtimeRoot: join(stateRoot, "runtime"),
    directoryPath: join(stateRoot, "secrets"),
    runtimeErrorCode: "wallet_secret_provider_linux_runtime_error",
  });

  t.after(async () => {
    await lockClientPasswordSessionResolved(context);
  });

  const result = await ensureClientPasswordConfiguredResolved({
    context,
    prompt: createScriptedPrompter(["client-password", "client-password", "hint"]),
  });

  assert.equal(result.action, "created");
  assert.equal(result.session.unlocked, true);
  assert.ok((result.session.unlockUntilUnixMs ?? 0) - Date.now() > 80_000_000);

  const state = await loadClientPasswordStateOrNull(context.passwordStatePath);
  assert.equal(state?.passwordHint, "hint");
});
