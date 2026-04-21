import net from "node:net";
import { rm } from "node:fs/promises";

import {
  createAgentProtocolErrorResponse,
  encodeAgentLine,
  parseAgentRequestLine,
  readAgentBootstrapConfigFromProcess,
  shouldRemoveAgentEndpointPath,
} from "./client-password/agent-protocol.js";
import {
  decryptSessionSecretBase64,
  encryptSessionSecretBase64,
  zeroizeBuffer,
} from "./client-password/crypto.js";

async function main(): Promise<void> {
  const bootstrap = await readAgentBootstrapConfigFromProcess({
    argv: process.argv,
    stdin: process.stdin,
  });
  let key = bootstrap.derivedKey;
  let unlockUntilUnixMs = bootstrap.unlockUntilUnixMs;
  let expiryTimer: NodeJS.Timeout | null = null;

  const cleanupAndExit = async (): Promise<void> => {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }

    zeroizeBuffer(key);
    key = Buffer.alloc(0);

    if (shouldRemoveAgentEndpointPath(bootstrap.endpoint)) {
      await rm(bootstrap.endpoint, { force: true }).catch(() => undefined);
    }

    process.exit(0);
  };

  const refreshExpiry = (): void => {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer);
    }

    const remainingMs = Math.max(0, unlockUntilUnixMs - Date.now());
    expiryTimer = setTimeout(() => {
      void cleanupAndExit();
    }, remainingMs);
    expiryTimer.unref();
  };

  const server = net.createServer((socket) => {
    let received = "";

    const send = (payload: unknown) => {
      socket.end(encodeAgentLine(payload));
    };

    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      const newlineIndex = received.indexOf("\n");

      if (newlineIndex === -1) {
        return;
      }

      const parsed = parseAgentRequestLine(received.slice(0, newlineIndex));

      if (parsed === null) {
        send(createAgentProtocolErrorResponse("wallet_client_password_agent_protocol_error"));
        return;
      }

      try {
        switch (parsed.command) {
          case "status":
            send({ ok: true, unlockUntilUnixMs });
            return;
          case "lock":
            send({ ok: true, unlockUntilUnixMs: null });
            setImmediate(() => {
              void cleanupAndExit();
            });
            return;
          case "refresh":
            if (!Number.isFinite(parsed.unlockUntilUnixMs)) {
              send(createAgentProtocolErrorResponse("wallet_client_password_agent_protocol_error"));
              return;
            }
            unlockUntilUnixMs = Number(parsed.unlockUntilUnixMs);
            refreshExpiry();
            send({ ok: true, unlockUntilUnixMs });
            return;
          case "encrypt":
            if (typeof parsed.secretBase64 !== "string") {
              send(createAgentProtocolErrorResponse("wallet_client_password_agent_protocol_error"));
              return;
            }
            send({
              ok: true,
              unlockUntilUnixMs,
              envelope: encryptSessionSecretBase64({
                key,
                secretBase64: parsed.secretBase64,
              }),
            });
            return;
          case "decrypt":
            if (
              typeof parsed.envelope?.nonce !== "string"
              || typeof parsed.envelope?.tag !== "string"
              || typeof parsed.envelope?.ciphertext !== "string"
            ) {
              send(createAgentProtocolErrorResponse("wallet_client_password_agent_protocol_error"));
              return;
            }
            send({
              ok: true,
              unlockUntilUnixMs,
              secretBase64: decryptSessionSecretBase64({
                key,
                envelope: parsed.envelope,
              }),
            });
            return;
          default:
            send(createAgentProtocolErrorResponse("wallet_client_password_agent_protocol_error"));
        }
      } catch (error) {
        send(createAgentProtocolErrorResponse(error instanceof Error ? error.message : String(error)));
      }
    });
  });

  process.on("SIGTERM", () => {
    void cleanupAndExit();
  });
  process.on("SIGINT", () => {
    void cleanupAndExit();
  });
  process.on("exit", () => {
    zeroizeBuffer(key);
  });

  refreshExpiry();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(bootstrap.endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });

  process.stdout.write("ready\n");
}

await main();
