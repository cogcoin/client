import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  createAgentBootstrapState,
  shouldRemoveAgentEndpointPath,
} from "./agent-protocol.js";
import { requestAgentOrNull } from "./agent-client.js";
import {
  promptForUnlockDuration,
  promptForUnlockDurationWithDefault,
  promptForVerifiedClientPassword,
  resolveRemainingUnlockSeconds,
} from "./prompts.js";
import { zeroizeBuffer } from "./crypto.js";
import type {
  ClientPasswordPrompt,
  ClientPasswordResolvedContext,
  ClientPasswordSessionStatus,
} from "./types.js";

export async function readClientPasswordSessionStatusResolved(
  context: ClientPasswordResolvedContext,
): Promise<ClientPasswordSessionStatus> {
  const response = await requestAgentOrNull(context, { command: "status" });

  if (response === null || !response.ok) {
    return {
      unlocked: false,
      unlockUntilUnixMs: null,
    };
  }

  return {
    unlocked: true,
    unlockUntilUnixMs: response.unlockUntilUnixMs ?? null,
  };
}

export async function lockClientPasswordSessionResolved(
  context: ClientPasswordResolvedContext,
): Promise<ClientPasswordSessionStatus> {
  await requestAgentOrNull(context, { command: "lock" }).catch(() => null);

  if (shouldRemoveAgentEndpointPath(context.agentEndpoint)) {
    await rm(context.agentEndpoint, { force: true }).catch(() => undefined);
  }

  return {
    unlocked: false,
    unlockUntilUnixMs: null,
  };
}

async function waitForAgentReady(child: ReturnType<typeof spawn>): Promise<void> {
  const stdout = child.stdout;

  if (stdout == null) {
    throw new Error("wallet_client_password_agent_start_failed");
  }

  await new Promise<void>((resolve, reject) => {
    let received = "";

    const cleanup = () => {
      stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    const onData = (chunk: Buffer) => {
      received += chunk.toString("utf8");
      const newlineIndex = received.indexOf("\n");

      if (newlineIndex === -1) {
        return;
      }

      cleanup();
      if (received.slice(0, newlineIndex).trim() === "ready") {
        resolve();
        return;
      }

      reject(new Error("wallet_client_password_agent_start_failed"));
    };

    const onExit = () => {
      cleanup();
      reject(new Error("wallet_client_password_agent_start_failed"));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    stdout.on("data", onData);
    child.on("exit", onExit);
    child.on("error", onError);
  });
}

function releaseAgentBootstrapHandles(child: ReturnType<typeof spawn>): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
}

export async function startClientPasswordSessionResolved(options: ClientPasswordResolvedContext & {
  derivedKey: Buffer;
  unlockDurationSeconds: number;
}): Promise<ClientPasswordSessionStatus> {
  return await startClientPasswordSessionWithExpiryResolved({
    ...options,
    unlockUntilUnixMs: Date.now() + (options.unlockDurationSeconds * 1_000),
  });
}

export async function startClientPasswordSessionWithExpiryResolved(
  options: ClientPasswordResolvedContext & {
    derivedKey: Buffer;
    unlockUntilUnixMs: number;
  },
): Promise<ClientPasswordSessionStatus> {
  const unlockUntilUnixMs = options.unlockUntilUnixMs;

  await lockClientPasswordSessionResolved(options).catch(() => undefined);
  await mkdir(options.runtimeRoot, { recursive: true }).catch(() => undefined);

  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../client-password-agent.js", import.meta.url)), options.agentEndpoint, String(unlockUntilUnixMs)],
    {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    },
  );

  try {
    child.stdin?.end(`${JSON.stringify(createAgentBootstrapState({
      derivedKeyBase64: options.derivedKey.toString("base64"),
      unlockUntilUnixMs,
    }))}\n`);
    await waitForAgentReady(child);
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    releaseAgentBootstrapHandles(child);
    zeroizeBuffer(options.derivedKey);
  }

  child.unref();

  return {
    unlocked: true,
    unlockUntilUnixMs,
  };
}

async function refreshClientPasswordSessionResolved(
  context: ClientPasswordResolvedContext & {
    unlockUntilUnixMs: number;
  },
): Promise<ClientPasswordSessionStatus | null> {
  const response = await requestAgentOrNull(context, {
    command: "refresh",
    unlockUntilUnixMs: context.unlockUntilUnixMs,
  });

  if (response === null || !response.ok) {
    return null;
  }

  return {
    unlocked: true,
    unlockUntilUnixMs: response.unlockUntilUnixMs ?? context.unlockUntilUnixMs,
  };
}

async function unlockClientPasswordSessionWithPromptResolved(options: {
  context: ClientPasswordResolvedContext;
  prompt: ClientPasswordPrompt;
}): Promise<ClientPasswordSessionStatus> {
  const derivedKey = await promptForVerifiedClientPassword({
    context: options.context,
    prompt: options.prompt,
    promptMessage: "Client password: ",
    ttyErrorCode: "wallet_client_password_unlock_requires_tty",
  });
  const unlockDurationSeconds = await promptForUnlockDuration(options.prompt);

  return await startClientPasswordSessionResolved({
    ...options.context,
    derivedKey,
    unlockDurationSeconds,
  });
}

export async function unlockClientPasswordSessionResolved(options: {
  context: ClientPasswordResolvedContext;
  prompt: ClientPasswordPrompt;
}): Promise<ClientPasswordSessionStatus> {
  if (!options.prompt.isInteractive) {
    throw new Error("wallet_client_password_unlock_requires_tty");
  }

  const currentStatus = await readClientPasswordSessionStatusResolved(options.context);

  if (currentStatus.unlocked) {
    const unlockDurationSeconds = await promptForUnlockDurationWithDefault(
      options.prompt,
      resolveRemainingUnlockSeconds(currentStatus),
    );
    const refreshed = await refreshClientPasswordSessionResolved({
      ...options.context,
      unlockUntilUnixMs: Date.now() + (unlockDurationSeconds * 1_000),
    });

    if (refreshed !== null) {
      return refreshed;
    }
  }

  return await unlockClientPasswordSessionWithPromptResolved(options);
}
