import { CLIENT_PASSWORD_DEFAULT_UNLOCK_SECONDS, CLIENT_PASSWORD_SETUP_AUTO_UNLOCK_SECONDS } from "./crypto.js";
import type {
  ClientPasswordPrompt,
  ClientPasswordSessionStatus,
} from "./types.js";

export type ClientPasswordSessionPolicy =
  | "default-60m"
  | "init-24h"
  | "mining-indefinite";

const promptPolicies = new WeakMap<ClientPasswordPrompt, ClientPasswordSessionPolicy>();

export function bindClientPasswordPromptSessionPolicy<T extends ClientPasswordPrompt>(
  prompt: T,
  policy: ClientPasswordSessionPolicy,
): T {
  promptPolicies.set(prompt, policy);
  return prompt;
}

export function resolveClientPasswordPromptSessionPolicy(
  prompt: ClientPasswordPrompt | null | undefined,
): ClientPasswordSessionPolicy {
  if (prompt == null) {
    return "default-60m";
  }

  return promptPolicies.get(prompt) ?? "default-60m";
}

export function resolveClientPasswordSessionUnlockUntilUnixMs(
  policy: ClientPasswordSessionPolicy,
  nowUnixMs: number = Date.now(),
): number | null {
  switch (policy) {
    case "default-60m":
      return nowUnixMs + (CLIENT_PASSWORD_DEFAULT_UNLOCK_SECONDS * 1_000);
    case "init-24h":
      return nowUnixMs + (CLIENT_PASSWORD_SETUP_AUTO_UNLOCK_SECONDS * 1_000);
    case "mining-indefinite":
      return null;
  }
}

export function resolvePostChangeClientPasswordUnlockUntilUnixMs(
  status: ClientPasswordSessionStatus,
  policy: ClientPasswordSessionPolicy,
  nowUnixMs: number = Date.now(),
): number | null {
  if (status.unlocked) {
    return status.unlockUntilUnixMs;
  }

  return resolveClientPasswordSessionUnlockUntilUnixMs(policy, nowUnixMs);
}
