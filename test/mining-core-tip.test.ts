import assert from "node:assert/strict";
import test from "node:test";

import { resolveMiningCoreTipObservation } from "../src/wallet/mining/engine-types.js";

test("mining Core tip observation prefers live node tip over stale indexer-observed Core tip", () => {
  const nodeHash = "22".repeat(32);
  const indexerHash = "11".repeat(32);

  const tip = resolveMiningCoreTipObservation({
    nodeStatus: {
      nodeBestHeight: 951_398,
      nodeBestHashHex: nodeHash,
    } as any,
    indexerStatus: {
      coreBestHeight: 951_397,
      coreBestHash: indexerHash,
    } as any,
  });

  assert.equal(tip.height, 951_398);
  assert.equal(tip.hash, nodeHash);
});

test("mining Core tip observation falls back to indexer-observed Core tip when node is unavailable", () => {
  const indexerHash = "11".repeat(32);

  const tip = resolveMiningCoreTipObservation({
    nodeStatus: {
      nodeBestHeight: null,
      nodeBestHashHex: null,
    } as any,
    indexerStatus: {
      coreBestHeight: 951_397,
      coreBestHash: indexerHash,
    } as any,
  });

  assert.equal(tip.height, 951_397);
  assert.equal(tip.hash, indexerHash);
});

test("mining Core tip observation keeps node hash on same-height node/indexer hash mismatch", () => {
  const nodeHash = "33".repeat(32);
  const indexerHash = "44".repeat(32);

  const tip = resolveMiningCoreTipObservation({
    nodeStatus: {
      nodeBestHeight: 951_398,
      nodeBestHashHex: nodeHash,
    } as any,
    indexerStatus: {
      coreBestHeight: 951_398,
      coreBestHash: indexerHash,
    } as any,
  });

  assert.equal(tip.height, 951_398);
  assert.equal(tip.hash, nodeHash);
});
