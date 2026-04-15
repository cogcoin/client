import assert from "node:assert/strict";
import test from "node:test";

import { loadBundledGenesisParameters } from "@cogcoin/indexer";

import {
  assertCogcoinProcessingStartHeight,
  resolveCogcoinProcessingStartHeight,
} from "../src/bitcoind/processing-start-height.js";

test("processing start height resolves from bundled genesis and rejects pre-genesis mainnet values", async () => {
  const genesis = await loadBundledGenesisParameters();
  const processingStartHeight = resolveCogcoinProcessingStartHeight(genesis);

  assert.equal(processingStartHeight, genesis.genesisBlock);

  assert.doesNotThrow(() => {
    assertCogcoinProcessingStartHeight({
      chain: "main",
      startHeight: processingStartHeight,
      genesisParameters: genesis,
    });
  });

  assert.throws(() => {
    assertCogcoinProcessingStartHeight({
      chain: "main",
      startHeight: processingStartHeight - 1,
      genesisParameters: genesis,
    });
  }, /cogcoin_processing_start_height_before_genesis/);

  assert.doesNotThrow(() => {
    assertCogcoinProcessingStartHeight({
      chain: "regtest",
      startHeight: 0,
      genesisParameters: genesis,
    });
  });
});
