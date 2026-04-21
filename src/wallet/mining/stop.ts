export const MINING_STOP_REQUESTED_ERROR_CODE = "mining_runtime_stop_requested";

export class MiningStopRequestedError extends Error {
  constructor() {
    super(MINING_STOP_REQUESTED_ERROR_CODE);
    this.name = "MiningStopRequestedError";
  }
}

export function isMiningStopRequestedError(error: unknown): error is Error {
  return error instanceof Error && error.message === MINING_STOP_REQUESTED_ERROR_CODE;
}

export function createMiningStopRequestedError(): MiningStopRequestedError {
  return new MiningStopRequestedError();
}

export function throwIfMiningStopRequested(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  const reason = signal.reason;

  if (reason instanceof Error) {
    throw reason;
  }

  throw createMiningStopRequestedError();
}
