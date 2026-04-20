import type { MiningEventRecord } from "./types.js";

export function createMiningEventRecord(
  kind: string,
  message: string,
  options: Partial<MiningEventRecord> = {},
): MiningEventRecord {
  return {
    schemaVersion: 1,
    timestampUnixMs: options.timestampUnixMs ?? Date.now(),
    level: options.level ?? "info",
    kind,
    message,
    targetBlockHeight: options.targetBlockHeight ?? null,
    referencedBlockHashDisplay: options.referencedBlockHashDisplay ?? null,
    domainId: options.domainId ?? null,
    domainName: options.domainName ?? null,
    txid: options.txid ?? null,
    feeRateSatVb: options.feeRateSatVb ?? null,
    feeSats: options.feeSats ?? null,
    score: options.score ?? null,
    reason: options.reason ?? null,
    runId: options.runId ?? null,
  };
}
