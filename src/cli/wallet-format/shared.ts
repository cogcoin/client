import type { WalletReadContext } from "../../wallet/read/index.js";

export function formatUnitAmount(value: bigint, unit: string): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 100_000_000n;
  const fraction = absolute % 100_000_000n;
  return `${sign}${whole.toString()}.${fraction.toString().padStart(8, "0")} ${unit}`;
}

export function formatCogAmount(value: bigint): string {
  return formatUnitAmount(value, "COG");
}

export function formatBitcoinAmount(value: bigint | null): string {
  return value === null ? "unavailable BTC" : formatUnitAmount(value, "BTC");
}

export function formatServiceHealth(health: string): string {
  return health.replaceAll("-", " ");
}

export function formatMaybe(value: string | number | null): string {
  return value === null ? "unavailable" : String(value);
}

export function formatIndexerTruthSource(
  source: WalletReadContext["indexer"]["source"],
): string {
  switch (source) {
    case "lease":
      return "coherent snapshot lease";
    case "probe":
      return "live daemon probe";
    case "status-file":
      return "advisory status file";
    default:
      return "none";
  }
}
