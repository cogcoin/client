import { loadClientPasswordStateOrNull } from "./files.js";
import {
  CLIENT_PASSWORD_MANUAL_UNLOCK_SECONDS,
  verifyPassword,
  zeroizeBuffer,
} from "./crypto.js";
import { describeReadinessError, inspectClientPasswordReadinessResolved } from "./readiness.js";
import type {
  ClientPasswordPrompt,
  ClientPasswordResolvedContext,
  ClientPasswordSessionStatus,
} from "./types.js";

export async function promptForHiddenValue(
  prompt: ClientPasswordPrompt,
  message: string,
): Promise<string> {
  const value = prompt.promptHidden != null
    ? await prompt.promptHidden(message)
    : await prompt.prompt(message);

  return value.trim();
}

export async function promptForUnlockDuration(
  prompt: ClientPasswordPrompt,
): Promise<number> {
  return await promptForUnlockDurationWithDefault(prompt, CLIENT_PASSWORD_MANUAL_UNLOCK_SECONDS);
}

export async function promptForUnlockDurationWithDefault(
  prompt: ClientPasswordPrompt,
  defaultSeconds: number,
): Promise<number> {
  while (true) {
    const answer = (await prompt.prompt(`Unlock duration in seconds [${defaultSeconds}]: `)).trim();

    if (answer === "") {
      return defaultSeconds;
    }

    if (/^[1-9]\d*$/.test(answer)) {
      return Number(answer);
    }

    prompt.writeLine("Enter a whole-number duration in seconds.");
  }
}

export function resolveRemainingUnlockSeconds(status: ClientPasswordSessionStatus): number {
  if (status.unlockUntilUnixMs === null) {
    return CLIENT_PASSWORD_MANUAL_UNLOCK_SECONDS;
  }

  return Math.max(1, Math.ceil((status.unlockUntilUnixMs - Date.now()) / 1_000));
}

export function resolvePostChangeUnlockUntilUnixMs(
  status: ClientPasswordSessionStatus,
): number {
  if (status.unlocked && status.unlockUntilUnixMs != null) {
    return status.unlockUntilUnixMs;
  }

  return Date.now() + 86_400_000;
}

export async function promptForVerifiedClientPassword(options: {
  context: ClientPasswordResolvedContext;
  prompt: ClientPasswordPrompt;
  promptMessage: string;
  ttyErrorCode: string;
}): Promise<Buffer> {
  const readiness = await inspectClientPasswordReadinessResolved(options.context);

  if (readiness !== "ready") {
    throw new Error(describeReadinessError(readiness));
  }

  if (!options.prompt.isInteractive) {
    throw new Error(options.ttyErrorCode);
  }

  const state = await loadClientPasswordStateOrNull(options.context.passwordStatePath);

  if (state === null) {
    throw new Error("wallet_client_password_setup_required");
  }

  let attempts = 0;

  while (true) {
    if (attempts >= 2 && state.passwordHint.trim().length > 0) {
      options.prompt.writeLine(`Hint: ${state.passwordHint}`);
    }

    const passwordText = await promptForHiddenValue(options.prompt, options.promptMessage);
    const passwordBytes = Buffer.from(passwordText, "utf8");
    let derivedKey: Buffer | null = null;

    try {
      derivedKey = await verifyPassword({
        state,
        passwordBytes,
      });
    } finally {
      zeroizeBuffer(passwordBytes);
    }

    if (derivedKey !== null) {
      return derivedKey;
    }

    attempts += 1;
    options.prompt.writeLine("Incorrect client password.");
  }
}

export async function promptForNewPassword(
  prompt: ClientPasswordPrompt,
): Promise<{
  passwordBytes: Buffer;
  passwordHint: string;
}> {
  if (!prompt.isInteractive) {
    throw new Error("wallet_client_password_setup_requires_tty");
  }

  while (true) {
    const first = await promptForHiddenValue(prompt, "Create client password: ");
    const firstBytes = Buffer.from(first, "utf8");

    if (firstBytes.length === 0) {
      zeroizeBuffer(firstBytes);
      prompt.writeLine("Client password cannot be blank.");
      continue;
    }

    const second = await promptForHiddenValue(prompt, "Confirm client password: ");
    const secondBytes = Buffer.from(second, "utf8");

    if (!firstBytes.equals(secondBytes)) {
      zeroizeBuffer(firstBytes);
      zeroizeBuffer(secondBytes);
      prompt.writeLine("Client password entries did not match.");
      continue;
    }

    zeroizeBuffer(secondBytes);

    let passwordHint = "";

    while (passwordHint.length === 0) {
      passwordHint = (await prompt.prompt("Password hint: ")).trim();

      if (passwordHint.length === 0) {
        prompt.writeLine("Password hint cannot be blank.");
      }
    }

    return {
      passwordBytes: firstBytes,
      passwordHint,
    };
  }
}
