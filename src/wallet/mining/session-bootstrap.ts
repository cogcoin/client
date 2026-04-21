import { createReadStream } from "node:fs";

import { zeroizeBuffer } from "../state/client-password/crypto.js";
import type { ClientPasswordSessionBootstrapState } from "../state/client-password/types.js";

export const MINING_CLIENT_PASSWORD_BOOTSTRAP_FD = 3;

function isClientPasswordSessionBootstrapState(
  value: unknown,
): value is ClientPasswordSessionBootstrapState {
  return typeof value === "object"
    && value !== null
    && (
      (value as { unlockUntilUnixMs?: unknown }).unlockUntilUnixMs === null
      || Number.isFinite((value as { unlockUntilUnixMs?: unknown }).unlockUntilUnixMs)
    )
    && typeof (value as { derivedKeyBase64?: unknown }).derivedKeyBase64 === "string";
}

export function providerUsesLocalFileClientPassword(providerKind: string | null | undefined): boolean {
  return providerKind === "linux-local-file"
    || providerKind === "macos-local-file"
    || providerKind === "windows-local-file";
}

export function resolveClientPasswordPlatformForProviderKind(
  providerKind: string | null | undefined,
  fallback: NodeJS.Platform = process.platform,
): NodeJS.Platform {
  switch (providerKind) {
    case "linux-local-file":
      return "linux";
    case "macos-local-file":
      return "darwin";
    case "windows-local-file":
      return "win32";
    default:
      return fallback;
  }
}

export async function writeClientPasswordSessionBootstrap(
  stream: NodeJS.WritableStream,
  bootstrap: ClientPasswordSessionBootstrapState,
): Promise<void> {
  const payload = Buffer.from(`${JSON.stringify(bootstrap)}\n`, "utf8");

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        stream.off("error", onError);
      };

      stream.on("error", onError);
      stream.end(payload, (error?: Error | null) => {
        cleanup();
        if (error != null) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  } finally {
    zeroizeBuffer(payload);
  }
}

export async function readClientPasswordSessionBootstrapFromFd(
  fd: number = MINING_CLIENT_PASSWORD_BOOTSTRAP_FD,
): Promise<ClientPasswordSessionBootstrapState | null> {
  const chunks: Buffer[] = [];

  try {
    const stream = createReadStream(".", {
      fd,
      autoClose: true,
    });

    try {
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (
          (error as NodeJS.ErrnoException).code === "EBADF"
          || (error as NodeJS.ErrnoException).code === "EINVAL"
        )
      ) {
        return null;
      }

      throw error;
    }

    if (chunks.length === 0) {
      return null;
    }

    const payload = Buffer.concat(chunks);

    try {
      const parsed = JSON.parse(payload.toString("utf8").trim()) as unknown;

      if (!isClientPasswordSessionBootstrapState(parsed)) {
        throw new Error("mining_client_password_bootstrap_invalid");
      }

      return parsed;
    } finally {
      zeroizeBuffer(payload);
    }
  } finally {
    for (const chunk of chunks) {
      zeroizeBuffer(chunk);
    }
  }
}
