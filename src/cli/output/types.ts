export interface CliErrorClassification {
  exitCode: number;
  errorCode: string;
  message: string;
}

export interface CliErrorPresentation {
  what: string;
  why: string | null;
  next: string | null;
}

export interface CliErrorPresentationInput {
  errorCode: string;
  fallbackMessage: string;
  error?: unknown;
}

export type CliErrorPresentationRule = (
  input: CliErrorPresentationInput,
) => CliErrorPresentation | null;
