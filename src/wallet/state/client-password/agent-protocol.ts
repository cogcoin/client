import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import type {
  AgentRequest,
  AgentResponse,
  ClientPasswordAgentBootstrapState,
} from "./types.js";

export function resolveAgentEndpoint(stateRoot: string): string {
  const hash = createHash("sha256").update(stateRoot).digest("hex").slice(0, 24);

  // Wallet provider tests simulate foreign platforms, but the local agent transport
  // still has to follow the real host runtime.
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\cogcoin-client-password-${hash}`;
  }

  return join(tmpdir(), `cogcoin-client-password-${hash}.sock`);
}

export function shouldRemoveAgentEndpointPath(endpoint: string): boolean {
  return !endpoint.startsWith("\\\\.\\pipe\\");
}

export function createAgentBootstrapState(
  options: ClientPasswordAgentBootstrapState,
): ClientPasswordAgentBootstrapState {
  return options;
}

export function createAgentProtocolErrorResponse(message: string): AgentResponse {
  return {
    ok: false,
    error: message,
  };
}

export function encodeAgentLine(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

export function parseAgentRequestLine(raw: string): AgentRequest | null {
  try {
    return JSON.parse(raw) as AgentRequest;
  } catch {
    return null;
  }
}

async function readLineFromReadable(stream: Readable): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let received = "";

    const onData = (chunk: Buffer | string) => {
      received += chunk.toString();
      const newlineIndex = received.indexOf("\n");

      if (newlineIndex !== -1) {
        cleanup();
        resolve(received.slice(0, newlineIndex));
      }
    };

    const onEnd = () => {
      cleanup();
      reject(new Error("wallet_client_password_agent_bootstrap_missing"));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

export async function readAgentBootstrapConfigFromProcess(options: {
  argv: string[];
  stdin: Readable;
}): Promise<{
  unlockUntilUnixMs: number;
  endpoint: string;
  derivedKey: Buffer;
}> {
  const endpoint = options.argv[2] ?? "";
  const unlockUntilUnixMs = Number(options.argv[3] ?? "");

  if (endpoint.length === 0 || !Number.isFinite(unlockUntilUnixMs)) {
    throw new Error("wallet_client_password_agent_bootstrap_invalid");
  }

  const raw = await readLineFromReadable(options.stdin);
  const parsed = JSON.parse(raw) as {
    derivedKeyBase64?: string;
  };

  if (typeof parsed.derivedKeyBase64 !== "string") {
    throw new Error("wallet_client_password_agent_bootstrap_invalid");
  }

  return {
    endpoint,
    unlockUntilUnixMs,
    derivedKey: Buffer.from(parsed.derivedKeyBase64, "base64"),
  };
}
