import assert from "node:assert/strict";
import net from "node:net";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { requestAgentOrNull } from "../src/wallet/state/client-password/agent-client.js";
import { resolveClientPasswordContext } from "../src/wallet/state/client-password/context.js";
import {
  lockClientPasswordSessionResolved,
  readClientPasswordSessionStatusResolved,
  startClientPasswordSessionWithExpiryResolved,
} from "../src/wallet/state/client-password/session.js";

test("client-password session start/status/lock use the shared session owner", async (t) => {
  const stateRoot = await createTrackedTempDirectory(t, "cogcoin-client-password-session");
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

  const session = await startClientPasswordSessionWithExpiryResolved({
    ...context,
    derivedKey: Buffer.alloc(32, 7),
    unlockUntilUnixMs: Date.now() + 60_000,
  });

  assert.equal(session.unlocked, true);
  assert.ok((session.unlockUntilUnixMs ?? 0) > Date.now());
  assert.deepEqual(await readClientPasswordSessionStatusResolved(context), {
    unlocked: true,
    unlockUntilUnixMs: session.unlockUntilUnixMs,
  });
  assert.deepEqual(await lockClientPasswordSessionResolved(context), {
    unlocked: false,
    unlockUntilUnixMs: null,
  });
  assert.deepEqual(await readClientPasswordSessionStatusResolved(context), {
    unlocked: false,
    unlockUntilUnixMs: null,
  });
});

test("client-password agent client removes stale unix socket endpoints", async (t) => {
  const stateRoot = await createTrackedTempDirectory(t, "cogcoin-client-password-stale-socket");
  const context = resolveClientPasswordContext({
    platform: "linux",
    stateRoot,
    runtimeRoot: join(stateRoot, "runtime"),
    directoryPath: join(stateRoot, "secrets"),
    runtimeErrorCode: "wallet_secret_provider_linux_runtime_error",
  });

  if (context.agentEndpoint.startsWith("\\\\.\\pipe\\")) {
    t.skip("unix socket cleanup path is not used on Windows");
    return;
  }

  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(context.agentEndpoint, () => resolve());
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error != null) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const response = await requestAgentOrNull(context, { command: "status" });
  assert.equal(response, null);
  await assert.rejects(() => access(context.agentEndpoint, constants.F_OK), /ENOENT/);
});
