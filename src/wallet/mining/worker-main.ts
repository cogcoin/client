import { runBackgroundMiningWorker } from "./runner.js";
import { readClientPasswordSessionBootstrapFromFd } from "./session-bootstrap.js";

function readFlag(name: string): string | null {
  const prefix = `--${name}=`;
  const match = process.argv.find((entry) => entry.startsWith(prefix));
  return match === undefined ? null : match.slice(prefix.length);
}

const dataDir = readFlag("data-dir");
const databasePath = readFlag("database-path");
const runId = readFlag("run-id");

if (dataDir === null || databasePath === null || runId === null) {
  throw new Error("mining_worker_missing_args");
}

const clientPasswordSessionBootstrap = await readClientPasswordSessionBootstrapFromFd();

await runBackgroundMiningWorker({
  dataDir,
  databasePath,
  runId,
  clientPasswordSessionBootstrap,
});
