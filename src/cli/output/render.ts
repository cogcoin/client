import type { CliErrorPresentation } from "./types.js";

export function formatCliTextErrorLines(
  presentation: CliErrorPresentation | null,
): string[] | null {
  if (presentation === null) {
    return null;
  }

  const lines = [`What happened: ${presentation.what}`];

  if (presentation.why !== null) {
    lines.push(`Why: ${presentation.why}`);
  }

  if (presentation.next !== null) {
    lines.push(`Next: ${presentation.next}`);
  }

  return lines;
}
