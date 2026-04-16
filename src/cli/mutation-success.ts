import {
  createPreviewSuccessEnvelope,
  createMutationSuccessEnvelope,
  describeCanonicalCommand,
  resolvePreviewJsonSchema,
  resolveStableMutationJsonSchema,
  writeJsonValue,
} from "./output.js";
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
  json: string[];
  text: string[];
}

export function commandMutationNextSteps(command: string): MutationSuccessNextSteps {
  return {
    json: [`Run \`${command}\`.`],
    text: [`Next step: ${command}`],
  };
}

export function workflowMutationNextSteps(
  nextSteps: readonly string[],
): MutationSuccessNextSteps {
  return {
    json: [...nextSteps],
    text: formatNextStepLines(nextSteps),
  };
}

function mutationOutcome(reusedExisting: boolean): "submitted" | "reconciled" {
  return reusedExisting ? "reconciled" : "submitted";
}

function reuseExplanation(reusedExisting: boolean, message: string): string[] {
  return reusedExisting ? [message] : [];
}

export function writeMutationCommandSuccess(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
  options: {
    data: unknown;
    previewData?: unknown;
    reusedExisting: boolean;
    reusedMessage: string;
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
  if (parsed.outputMode === "preview-json") {
    writeJsonValue(context.stdout, createPreviewSuccessEnvelope(
      resolvePreviewJsonSchema(parsed)!,
      describeCanonicalCommand(parsed),
      options.outcome ?? mutationOutcome(options.reusedExisting),
      options.previewData ?? options.data,
      {
        explanations: reuseExplanation(
          options.reusedExisting,
          options.reusedMessage,
        ),
        nextSteps: options.nextSteps.json,
        warnings: options.warnings,
      },
    ));
    return 0;
  }

  if (parsed.outputMode === "json") {
    writeJsonValue(context.stdout, createMutationSuccessEnvelope(
      resolveStableMutationJsonSchema(parsed)!,
      describeCanonicalCommand(parsed),
      options.outcome ?? mutationOutcome(options.reusedExisting),
      options.data,
      {
        explanations: reuseExplanation(
          options.reusedExisting,
          options.reusedMessage,
        ),
        nextSteps: options.nextSteps.json,
        warnings: options.warnings,
      },
    ));
    return 0;
  }

  writeMutationTextResult(context.stdout, {
    heading: options.text.heading,
    fields: options.text.fields,
    reusedExisting: options.reusedExisting,
    reusedMessage: options.reusedMessage,
    trailerLines: options.nextSteps.text,
    interactive: options.interactive,
    explorerTxid: options.explorerTxid,
  });
  return 0;
}
