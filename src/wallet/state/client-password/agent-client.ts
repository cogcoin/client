import net from "node:net";
import { rm } from "node:fs/promises";

import {
  shouldRemoveAgentEndpointPath,
} from "./agent-protocol.js";
import type {
  AgentRequest,
  AgentResponse,
  ClientPasswordResolvedContext,
} from "./types.js";

async function openAgentConnection(endpoint: string): Promise<net.Socket> {
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on("connect", onConnect);
    socket.on("error", onError);
  });
}

export async function requestAgent(
  context: ClientPasswordResolvedContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const socket = await openAgentConnection(context.agentEndpoint);

  return await new Promise<AgentResponse>((resolve, reject) => {
    let received = "";

    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("close", onClose);
    };

    const finish = (response: AgentResponse) => {
      cleanup();
      socket.end();
      resolve(response);
    };

    const fail = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };

    const onData = (chunk: Buffer) => {
      received += chunk.toString("utf8");
      const newlineIndex = received.indexOf("\n");

      if (newlineIndex === -1) {
        return;
      }

      try {
        finish(JSON.parse(received.slice(0, newlineIndex)) as AgentResponse);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const onError = (error: Error) => {
      fail(error);
    };

    const onEnd = () => {
      if (received.length === 0) {
        fail(new Error("wallet_client_password_locked"));
      }
    };

    const onClose = () => {
      if (received.length === 0) {
        fail(new Error("wallet_client_password_locked"));
      }
    };

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
    socket.on("close", onClose);
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

export async function requestAgentOrNull(
  context: ClientPasswordResolvedContext,
  request: AgentRequest,
): Promise<AgentResponse | null> {
  try {
    return await requestAgent(context, request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message === "wallet_client_password_locked") {
      return null;
    }

    const code = error instanceof Error && "code" in error
      ? String((error as NodeJS.ErrnoException).code ?? "")
      : "";

    if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") {
      if (shouldRemoveAgentEndpointPath(context.agentEndpoint)) {
        await rm(context.agentEndpoint, { force: true }).catch(() => undefined);
      }
      return null;
    }

    throw error;
  }
}
