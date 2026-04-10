import { writeLine } from "./io.js";
import type { WritableLike } from "./types.js";

export interface MutationTextField {
  label: string;
  value: string;
  when?: boolean;
}

export function writeMutationTextResult(
  stream: WritableLike,
  options: {
    heading: string;
    fields: MutationTextField[];
    reusedExisting?: boolean;
    reusedMessage?: string;
    trailerLines?: string[];
  },
): void {
  writeLine(stream, options.heading);

  for (const field of options.fields) {
    if (field.when === false) {
      continue;
    }
    writeLine(stream, `${field.label}: ${field.value}`);
  }

  if (options.reusedExisting === true && options.reusedMessage !== undefined) {
    writeLine(stream, options.reusedMessage);
  }

  for (const line of options.trailerLines ?? []) {
    writeLine(stream, line);
  }
}
