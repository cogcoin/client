import net from "node:net";

import type {
  DaemonRequest,
  DaemonResponse,
  IndexerSnapshotHandle,
  IndexerSnapshotPayload,
} from "./types.js";
import type { ManagedIndexerDaemonStatus } from "../types.js";

interface IndexerDaemonRequestHandlers {
  getStatus(): ManagedIndexerDaemonStatus | Promise<ManagedIndexerDaemonStatus>;
  openSnapshot(): Promise<IndexerSnapshotHandle>;
  readSnapshot(token?: string): Promise<IndexerSnapshotPayload>;
  closeSnapshot(token?: string): Promise<void>;
  resumeBackgroundFollow(): Promise<void>;
}

export function createIndexerDaemonServer(
  handlers: IndexerDaemonRequestHandlers,
): net.Server {
  return net.createServer((socket) => {
    let buffer = "";

    const writeResponse = (response: DaemonResponse) => {
      socket.write(`${JSON.stringify(response)}\n`);
    };

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

        let request: DaemonRequest;

        try {
          request = JSON.parse(line) as DaemonRequest;
        } catch (error) {
          writeResponse({
            id: "invalid",
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
          newlineIndex = buffer.indexOf("\n");
          continue;
        }

        void (async () => {
          try {
            switch (request.method) {
              case "GetStatus":
                writeResponse({
                  id: request.id,
                  ok: true,
                  result: await handlers.getStatus(),
                });
                return;
              case "OpenSnapshot":
                writeResponse({
                  id: request.id,
                  ok: true,
                  result: await handlers.openSnapshot(),
                });
                return;
              case "ReadSnapshot":
                writeResponse({
                  id: request.id,
                  ok: true,
                  result: await handlers.readSnapshot(request.token),
                });
                return;
              case "CloseSnapshot":
                await handlers.closeSnapshot(request.token);
                writeResponse({
                  id: request.id,
                  ok: true,
                  result: null,
                });
                return;
              case "ResumeBackgroundFollow":
                await handlers.resumeBackgroundFollow();
                writeResponse({
                  id: request.id,
                  ok: true,
                  result: null,
                });
                return;
              default:
                throw new Error(`indexer_daemon_unknown_method_${request.method}`);
            }
          } catch (error) {
            writeResponse({
              id: request.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();

        newlineIndex = buffer.indexOf("\n");
      }
    });
  });
}
