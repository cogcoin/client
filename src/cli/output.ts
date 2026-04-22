import { classifyCliError } from "./output/classify.js";
import { formatCliTextErrorLines } from "./output/render.js";
import { createCliErrorPresentation } from "./output/rules/index.js";
import type { ParsedCliArgs, WritableLike } from "./types.js";

export { classifyCliError } from "./output/classify.js";
export { createCliErrorPresentation } from "./output/rules/index.js";

export function formatCliTextError(error: unknown): string[] | null {
  const classified = classifyCliError(error);
  const presentation = createCliErrorPresentation(
    classified.errorCode,
    classified.message,
    error,
  );
  return formatCliTextErrorLines(presentation);
}

export function writeHandledCliError(options: {
  parsed: ParsedCliArgs;
  stdout: WritableLike;
  stderr: WritableLike;
  error: unknown;
}): number {
  const classified = classifyCliError(options.error);

  const formatted = formatCliTextError(options.error);
  if (formatted !== null) {
    for (const line of formatted) {
      options.stderr.write(`${line}\n`);
    }
  } else {
    options.stderr.write(`${classified.message}\n`);
  }

  return classified.exitCode;
}
