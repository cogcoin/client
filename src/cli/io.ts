import type { ProgressOutput, WritableLike } from "./types.js";

export function writeLine(stream: WritableLike, line: string): void {
  stream.write(`${line}\n`);
}

export function usesTtyProgress(progressOutput: ProgressOutput, stream: WritableLike): boolean {
  if (progressOutput === "none") {
    return false;
  }

  if (progressOutput === "tty") {
    return true;
  }

  return stream.isTTY === true;
}
