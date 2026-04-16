import { writeLine } from "./io.js";
import type { WritableLike } from "./types.js";

export interface MutationTextField {
  label: string;
  value: string;
  when?: boolean;
}

function mutationExplorerUrl(txid: string): string {
  return `https://mempool.space/tx/${txid}`;
}

export function writeMutationTextResult(
  stream: WritableLike,
  options: {
    heading: string;
    fields: MutationTextField[];
    reusedExisting?: boolean;
    reusedMessage?: string;
    trailerLines?: string[];
    interactive?: boolean;
    explorerTxid?: string | null;
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

  if (options.interactive === true && options.explorerTxid) {
    writeLine(stream, "");
    writeLine(stream, `View at: ${mutationExplorerUrl(options.explorerTxid)}`);
  }
}
