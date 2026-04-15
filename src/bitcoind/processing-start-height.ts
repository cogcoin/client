import type { GenesisParameters } from "@cogcoin/indexer/types";

export function resolveCogcoinProcessingStartHeight(
  genesisParameters: GenesisParameters,
): number {
  return genesisParameters.genesisBlock;
}

export function assertCogcoinProcessingStartHeight(options: {
  chain: "main" | "regtest";
  startHeight: number;
  genesisParameters: GenesisParameters;
}): void {
  const processingStartHeight = resolveCogcoinProcessingStartHeight(options.genesisParameters);

  if (options.chain === "main" && options.startHeight < processingStartHeight) {
    throw new Error("cogcoin_processing_start_height_before_genesis");
  }
}
