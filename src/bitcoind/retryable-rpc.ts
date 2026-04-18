export const MANAGED_RPC_RETRY_BASE_MS = 1_000;
export const MANAGED_RPC_RETRY_MAX_MS = 15_000;
export const MANAGED_RPC_RETRY_MESSAGE = "Managed Bitcoin RPC temporarily unavailable; retrying until canceled.";

export interface ManagedRpcRetryState {
  nextDelayMs: number;
}

export function createManagedRpcRetryState(): ManagedRpcRetryState {
  return {
    nextDelayMs: MANAGED_RPC_RETRY_BASE_MS,
  };
}

export function resetManagedRpcRetryState(state: ManagedRpcRetryState): void {
  state.nextDelayMs = MANAGED_RPC_RETRY_BASE_MS;
}

export function consumeManagedRpcRetryDelayMs(state: ManagedRpcRetryState): number {
  const delayMs = state.nextDelayMs;
  state.nextDelayMs = Math.min(state.nextDelayMs * 2, MANAGED_RPC_RETRY_MAX_MS);
  return delayMs;
}

export function isRetryableManagedRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  if (message === "bitcoind_rpc_timeout") {
    return true;
  }

  if (/^bitcoind_rpc_[^_]+_-28(?:_|$)/.test(message)) {
    return true;
  }

  if (message.startsWith("The managed Bitcoin RPC request to ")) {
    return message.includes(" failed");
  }

  return message.startsWith("The managed Bitcoin RPC cookie file is unavailable at ")
    || message.startsWith("The managed Bitcoin RPC cookie file could not be read at ");
}

export function describeManagedRpcRetryError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
