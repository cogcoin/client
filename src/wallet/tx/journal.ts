import type { PendingMutationRecord, WalletStateV1 } from "../types.js";

const ACTIVE_MUTATION_STATUSES = new Set<PendingMutationRecord["status"]>([
  "draft",
  "broadcasting",
  "broadcast-unknown",
  "live",
  "repair-required",
]);

export function getPendingMutations(state: WalletStateV1): PendingMutationRecord[] {
  return state.pendingMutations ?? [];
}

export function listActivePendingMutations(state: WalletStateV1): PendingMutationRecord[] {
  return getPendingMutations(state).filter((mutation) => ACTIVE_MUTATION_STATUSES.has(mutation.status));
}

export function findPendingMutationByIntent(
  state: WalletStateV1,
  intentFingerprintHex: string,
): PendingMutationRecord | null {
  return getPendingMutations(state).find((mutation) => mutation.intentFingerprintHex === intentFingerprintHex) ?? null;
}

export function upsertPendingMutation(
  state: WalletStateV1,
  mutation: PendingMutationRecord,
): WalletStateV1 {
  const pendingMutations = getPendingMutations(state);
  const existingIndex = pendingMutations.findIndex((entry) => entry.mutationId === mutation.mutationId);
  const nextPendingMutations = pendingMutations.slice();

  if (existingIndex >= 0) {
    nextPendingMutations[existingIndex] = mutation;
  } else {
    nextPendingMutations.push(mutation);
  }

  return {
    ...state,
    pendingMutations: nextPendingMutations,
  };
}
