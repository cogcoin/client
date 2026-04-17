import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import net from "node:net";
import { rm } from "node:fs/promises";

function zeroizeBuffer(buffer: Uint8Array | null | undefined): void {
  if (buffer != null) {
    buffer.fill(0);
  }
}

function createAgentError(message: string): string {
  return JSON.stringify({
    ok: false,
    error: message,
  });
}

async function readBootstrapConfig(): Promise<{
  unlockUntilUnixMs: number;
  endpoint: string;
  derivedKey: Buffer;
}> {
  const endpoint = process.argv[2] ?? "";
  const unlockUntilUnixMs = Number(process.argv[3] ?? "");

  if (endpoint.length === 0 || !Number.isFinite(unlockUntilUnixMs)) {
    throw new Error("wallet_client_password_agent_bootstrap_invalid");
  }

  const raw = await new Promise<string>((resolve, reject) => {
    let received = "";

    const onData = (chunk: Buffer) => {
      received += chunk.toString("utf8");
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
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
    };

    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
  });

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

async function main(): Promise<void> {
  const bootstrap = await readBootstrapConfig();
  let key = bootstrap.derivedKey;
  const unlockUntilUnixMs = bootstrap.unlockUntilUnixMs;
  let expiryTimer: NodeJS.Timeout | null = null;

  const cleanupAndExit = async (): Promise<void> => {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }

    zeroizeBuffer(key);
    key = Buffer.alloc(0);

    if (!bootstrap.endpoint.startsWith("\\\\.\\")) {
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

  const encryptSecret = (secretBase64: string) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(secretBase64, "base64")),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
      nonce: nonce.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  };

  const decryptSecret = (options: {
    nonce: string;
    tag: string;
    ciphertext: string;
  }): string => {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(options.nonce, "base64"),
    );
    decipher.setAuthTag(Buffer.from(options.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(options.ciphertext, "base64")),
      decipher.final(),
    ]).toString("base64");
  };

  const server = net.createServer((socket) => {
    let received = "";

    const send = (payload: unknown) => {
      socket.end(`${JSON.stringify(payload)}\n`);
    };

    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      const newlineIndex = received.indexOf("\n");

      if (newlineIndex === -1) {
        return;
      }

      let parsed: {
        command?: string;
        secretBase64?: string;
        envelope?: {
          nonce?: string;
          tag?: string;
          ciphertext?: string;
        };
      };

      try {
        parsed = JSON.parse(received.slice(0, newlineIndex)) as typeof parsed;
      } catch {
        send({ ok: false, error: "wallet_client_password_agent_protocol_error" });
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
          case "encrypt":
            if (typeof parsed.secretBase64 !== "string") {
              send({ ok: false, error: "wallet_client_password_agent_protocol_error" });
              return;
            }
            send({
              ok: true,
              unlockUntilUnixMs,
              envelope: encryptSecret(parsed.secretBase64),
            });
            return;
          case "decrypt":
            if (
              typeof parsed.envelope?.nonce !== "string"
              || typeof parsed.envelope?.tag !== "string"
              || typeof parsed.envelope?.ciphertext !== "string"
            ) {
              send({ ok: false, error: "wallet_client_password_agent_protocol_error" });
              return;
            }
            send({
              ok: true,
              unlockUntilUnixMs,
              secretBase64: decryptSecret({
                nonce: parsed.envelope.nonce,
                tag: parsed.envelope.tag,
                ciphertext: parsed.envelope.ciphertext,
              }),
            });
            return;
          default:
            send({ ok: false, error: "wallet_client_password_agent_protocol_error" });
        }
      } catch (error) {
        send({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
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

void main().catch((error) => {
  process.stderr.write(`${createAgentError(error instanceof Error ? error.message : String(error))}\n`);
  process.exit(1);
});
