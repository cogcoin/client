import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function run(): Promise<void> {
  const entrypointPath = process.argv[2];

  if (typeof entrypointPath !== "string" || entrypointPath.length === 0) {
    throw new Error("Missing custom mining hook entrypoint path.");
  }

  const moduleUrl = pathToFileURL(entrypointPath).href;
  const requestText = await readStdin();

  let request: unknown;
  try {
    request = JSON.parse(requestText);
  } catch {
    throw new Error("Custom mining hook runner received invalid JSON on stdin.");
  }

  const loaded = await import(moduleUrl);
  const generateSentences = loaded.generateSentences;

  if (typeof generateSentences !== "function") {
    throw new Error("Custom mining hooks must export generateSentences(request).");
  }

  const response = await generateSentences(request);
  process.stdout.write(`${JSON.stringify(response)}\n`, "utf8");
}

if (process.argv[1] !== undefined) {
  const mainUrl = pathToFileURL(process.argv[1]).href;
  if (import.meta.url === mainUrl) {
    await run().catch(async (error) => {
      if (error instanceof Error && error.message.includes("Cannot find module")) {
        try {
          const entrypointPath = process.argv[2];
          if (typeof entrypointPath === "string") {
            await readFile(entrypointPath, "utf8");
          }
        } catch {
          // Ignore; the original import error is still the best diagnostic.
        }
      }

      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`${message.trim()}\n`, "utf8");
      process.exitCode = 1;
    });
  }
}
