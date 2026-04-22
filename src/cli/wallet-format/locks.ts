import { listWalletLocks } from "../../wallet/read/index.js";
import type { WalletReadContext } from "../../wallet/read/index.js";
import { appendWalletAvailability } from "./availability.js";
import { formatCogAmount, formatServiceHealth } from "./shared.js";

export function formatLocksReport(
  context: WalletReadContext,
  options: {
    claimableOnly?: boolean;
    reclaimableOnly?: boolean;
    limit?: number | null;
    all?: boolean;
  } = {},
): string {
  const lines = ["COG Locks"];

  if (context.model === null) {
    appendWalletAvailability(lines, context);
    return lines.join("\n");
  }

  const locks = listWalletLocks(context);

  if (locks === null) {
    lines.push(`Lock state is unavailable while the indexer is ${formatServiceHealth(context.indexer.health)}.`);
    return lines.join("\n");
  }

  let filteredLocks = locks;

  if (options.claimableOnly) {
    filteredLocks = filteredLocks.filter((lock) => lock.claimableNow);
  } else if (options.reclaimableOnly) {
    filteredLocks = filteredLocks.filter((lock) => lock.reclaimableNow);
  }

  const totalMatching = filteredLocks.length;

  if (!options.all && options.limit !== null && options.limit !== undefined) {
    filteredLocks = filteredLocks.slice(0, options.limit);
  }

  if (filteredLocks.length === 0) {
    lines.push("No locally related active locks.");
    return lines.join("\n");
  }

  for (const lock of filteredLocks) {
    const role = lock.lockerLocalIndex !== null ? `locker ${lock.lockerLocalIndex}` : "recipient";
    const action = lock.claimableNow
      ? "claimable-now"
      : lock.reclaimableNow
        ? "reclaimable-now"
        : "not-actionable-now";
    lines.push(
      `lock:${lock.lockId}  ${formatCogAmount(lock.amountCogtoshi)}  timeout ${lock.timeoutHeight}  domain ${lock.recipientDomainName ?? lock.recipientDomainId}  ${role}  ${action}`,
    );
  }

  for (const mutation of (context.localState.state?.pendingMutations ?? [])
    .filter((entry) =>
      (entry.kind === "lock" || entry.kind === "claim")
      && entry.status !== "confirmed"
      && entry.status !== "canceled"
    )) {
    const label = mutation.kind === "claim" && mutation.preimageHex === "0000000000000000000000000000000000000000000000000000000000000000"
      ? "reclaim"
      : mutation.kind;
    lines.push(`Pending: ${label}  ${mutation.status}${mutation.lockId === null || mutation.lockId === undefined ? "" : `  lock:${mutation.lockId}`}${mutation.recipientDomainName === null || mutation.recipientDomainName === undefined ? "" : `  domain ${mutation.recipientDomainName}`}`);
  }

  if (!options.all && options.limit !== null && options.limit !== undefined && totalMatching > options.limit) {
    lines.push(`Showing first ${filteredLocks.length} of ${totalMatching}. Use --limit <n> or --all for more.`);
  }

  return lines.join("\n");
}
