import { randomUUID } from "node:crypto";
import net from "node:net";

import {
  mapIndexerDaemonTransportError,
  mapIndexerDaemonValidationError,
  validateIndexerDaemonStatus,
} from "../managed-runtime/indexer-policy.js";
import type { ManagedIndexerDaemonProbeResult } from "../managed-runtime/types.js";
import type { ManagedIndexerDaemonObservedStatus } from "../types.js";
import type {
  DaemonRequest,
  DaemonResponse,
  IndexerDaemonClient,
  IndexerSnapshotHandle,
  IndexerSnapshotPayload,
  ManagedIndexerDaemonOwnership,
  ManagedIndexerDaemonServiceLifetime,
} from "./types.js";

const INDEXER_DAEMON_REQUEST_TIMEOUT_MS = 15_000;
const INDEXER_DAEMON_RESUME_BACKGROUND_FOLLOW_REQUEST_TIMEOUT_MS = 35_000;

interface IndexerDaemonClientCloseOptions {
  serviceLifetime: ManagedIndexerDaemonServiceLifetime;
  ownership: ManagedIndexerDaemonOwnership;
  shutdownOwnedDaemon?: (() => Promise<void>) | null;
  requestTimeoutMs?: number;
  resumeBackgroundFollowRequestTimeoutMs?: number;
}

export function createIndexerDaemonClient(
  socketPath: string,
  closeOptions: IndexerDaemonClientCloseOptions | null = null,
): IndexerDaemonClient {
  let closed = false;

  async function sendRequest<T>(request: DaemonRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = "";
      let settled = false;

      const finish = (handler: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        socket.destroy();
        handler();
      };

      socket.setTimeout(
        request.method === "ResumeBackgroundFollow"
          ? closeOptions?.resumeBackgroundFollowRequestTimeoutMs ?? INDEXER_DAEMON_RESUME_BACKGROUND_FOLLOW_REQUEST_TIMEOUT_MS
          : closeOptions?.requestTimeoutMs ?? INDEXER_DAEMON_REQUEST_TIMEOUT_MS,
      );
      socket.on("connect", () => {
        socket.write(`${JSON.stringify(request)}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let newlineIndex = buffer.indexOf("\n");

        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);

          if (line.trim().length === 0) {
            newlineIndex = buffer.indexOf("\n");
            continue;
          }

          let response: DaemonResponse;

          try {
            response = JSON.parse(line) as DaemonResponse;
          } catch (error) {
            finish(() => reject(error));
            return;
          }

          if (response.id !== request.id) {
            newlineIndex = buffer.indexOf("\n");
            continue;
          }

          if (!response.ok) {
            finish(() => reject(new Error(response.error ?? "indexer_daemon_request_failed")));
            return;
          }

          finish(() => resolve(response.result as T));
          return;
        }
      });
      socket.on("timeout", () => {
        finish(() => reject(new Error("indexer_daemon_request_timeout")));
      });
      socket.on("error", (error) => {
        finish(() => reject(error));
      });
      socket.on("end", () => {
        if (!settled) {
          finish(() => reject(new Error("indexer_daemon_connection_closed")));
        }
      });
    });
  }

  return {
    getStatus() {
      return sendRequest<ManagedIndexerDaemonObservedStatus>({
        id: randomUUID(),
        method: "GetStatus",
      });
    },
    openSnapshot() {
      return sendRequest<IndexerSnapshotHandle>({
        id: randomUUID(),
        method: "OpenSnapshot",
      });
    },
    readSnapshot(token: string) {
      return sendRequest<IndexerSnapshotPayload>({
        id: randomUUID(),
        method: "ReadSnapshot",
        token,
      });
    },
    async closeSnapshot(token: string) {
      await sendRequest<null>({
        id: randomUUID(),
        method: "CloseSnapshot",
        token,
      });
    },
    async resumeBackgroundFollow() {
      await sendRequest<null>({
        id: randomUUID(),
        method: "ResumeBackgroundFollow",
      });
    },
    async close() {
      if (closed) {
        return;
      }

      closed = true;

      if (closeOptions === null || closeOptions.serviceLifetime !== "ephemeral" || closeOptions.ownership === "attached") {
        return;
      }

      await closeOptions.shutdownOwnedDaemon?.();
    },
  };
}

export async function probeIndexerDaemonAtSocket(
  socketPath: string,
  expectedWalletRootId: string,
): Promise<ManagedIndexerDaemonProbeResult<IndexerDaemonClient>> {
  const client = createIndexerDaemonClient(socketPath);

  try {
    const status = await client.getStatus();
    try {
      validateIndexerDaemonStatus(status, expectedWalletRootId);
      return {
        compatibility: "compatible",
        status,
        client,
        error: null,
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      return mapIndexerDaemonValidationError<IndexerDaemonClient>(error, status);
    }
  } catch (error) {
    await client.close().catch(() => undefined);
    return mapIndexerDaemonTransportError<IndexerDaemonClient>(error);
  }
}
