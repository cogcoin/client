import {
  formatSatVb,
  type WalletMutationFeeSummary,
} from "../wallet/tx/common.js";
import {
  type MutationTextField,
  writeMutationTextResult,
} from "./mutation-text-write.js";
import type {
  ParsedCliArgs,
  RequiredCliRunnerContext,
} from "./types.js";
import { formatNextStepLines } from "./workflow-hints.js";

export interface MutationSuccessNextSteps {
  text: string[];
}

export function commandMutationNextSteps(command: string): MutationSuccessNextSteps {
  return {
    text: [`Next step: ${command}`],
  };
}

export function workflowMutationNextSteps(
  nextSteps: readonly string[],
): MutationSuccessNextSteps {
  return {
    text: formatNextStepLines(nextSteps),
  };
}

function mutationOutcome(reusedExisting: boolean): "submitted" | "reconciled" {
  return reusedExisting ? "reconciled" : "submitted";
}

function reuseExplanation(reusedExisting: boolean, message: string): string[] {
  return reusedExisting ? [message] : [];
}

function feeFields(fees: WalletMutationFeeSummary | null | undefined): MutationTextField[] {
  if (fees == null) {
    return [];
  }

  return [
    { label: "Fee rate", value: `${formatSatVb(fees.feeRateSatVb)} sat/vB` },
    { label: "Fee", value: `${fees.feeSats} sats`, when: fees.feeSats !== null },
  ];
}

export function writeMutationCommandSuccess(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
  options: {
    data: unknown;
    previewData?: unknown;
    reusedExisting: boolean;
    reusedMessage: string;
    fees?: WalletMutationFeeSummary | null;
    interactive?: boolean;
    explorerTxid?: string | null;
    nextSteps: MutationSuccessNextSteps;
    outcome?: string;
    text: {
      heading: string;
      fields: MutationTextField[];
    };
    warnings?: string[];
  },
): number {
  writeMutationTextResult(context.stdout, {
    heading: options.text.heading,
    fields: [...options.text.fields, ...feeFields(options.fees)],
    reusedExisting: options.reusedExisting,
    reusedMessage: options.reusedMessage,
    trailerLines: options.nextSteps.text,
    interactive: options.interactive,
    explorerTxid: options.explorerTxid,
  });
  return 0;
}
