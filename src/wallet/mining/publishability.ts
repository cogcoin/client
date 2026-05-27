import type { MiningRuntimeStatusV1 } from "./types.js";

export function resolveCorePublishStateShortLabel(
  state: MiningRuntimeStatusV1["corePublishState"],
): string {
  switch (state) {
    case "network-inactive":
      return "Bitcoin networking inactive";
    case "no-outbound-peers":
      return "Bitcoin has no outbound peers";
    case "ibd":
      return "Bitcoin still syncing";
    case "mempool-loading":
      return "Bitcoin mempool loading";
    case "healthy":
      return "Bitcoin publishable";
    case "unknown":
    case null:
    default:
      return "Waiting for Bitcoin node";
  }
}

export function resolveCorePublishStateNote(
  state: MiningRuntimeStatusV1["corePublishState"],
): string | null {
  switch (state) {
    case "network-inactive":
      return "Mining is waiting because Bitcoin Core networking is inactive.";
    case "no-outbound-peers":
      return "Mining is waiting because Bitcoin Core has no outbound peers.";
    case "ibd":
      return "Mining is waiting because Bitcoin Core is still syncing.";
    case "mempool-loading":
      return "Mining is waiting because Bitcoin Core is still loading its mempool.";
    case "unknown":
      return "Mining is waiting until Bitcoin Core publishability can be confirmed.";
    case "healthy":
    case null:
    default:
      return null;
  }
}
