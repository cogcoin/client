import assert from "node:assert/strict";
import test from "node:test";

import { loadBundledGenesisParameters } from "@cogcoin/indexer";

import {
  assertCogcoinProcessingStartHeight,
  normalizeCogcoinProcessingStartHeight,
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

  assert.equal(
    normalizeCogcoinProcessingStartHeight({
      chain: "main",
      startHeight: undefined,
      genesisParameters: genesis,
    }),
    processingStartHeight,
  );

  assert.equal(
    normalizeCogcoinProcessingStartHeight({
      chain: "main",
      startHeight: 0,
      genesisParameters: genesis,
    }),
    processingStartHeight,
  );

  assert.equal(
    normalizeCogcoinProcessingStartHeight({
      chain: "main",
      startHeight: processingStartHeight + 10,
      genesisParameters: genesis,
    }),
    processingStartHeight + 10,
  );

  assert.equal(
    normalizeCogcoinProcessingStartHeight({
      chain: "regtest",
      startHeight: 0,
      genesisParameters: genesis,
    }),
    0,
  );
});
