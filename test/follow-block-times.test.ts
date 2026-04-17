import assert from "node:assert/strict";
import test from "node:test";

import { loadVisibleFollowBlockTimes } from "../src/bitcoind/client/follow-block-times.js";

test("loadVisibleFollowBlockTimes looks up Bitcoin blocks using display-order tip hashes", async () => {
  const requestedHashes: string[] = [];
  const tipHashHex = "00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f";
  const previousHashHex = "ffeeddccbbaa998877665544332211000f1e2d3c4b5a69788796a5b4c3d2e1f0";

  const blockTimes = await loadVisibleFollowBlockTimes({
    tip: {
      height: 200,
      blockHashHex: tipHashHex,
      previousHashHex,
      stateHashHex: null,
    },
    startHeight: 199,
    store: {
      async loadBlockRecord(height: number) {
        if (height !== 199) {
          return null;
        }

        return {
          height,
          blockHashHex: previousHashHex,
          previousHashHex: null,
          stateHashHex: null,
          recordBytes: new Uint8Array(),
          createdAt: 1,
        };
      },
    } as never,
    rpc: {
      async getBlock(hashHex: string) {
        requestedHashes.push(hashHex);
        return {
          hash: hashHex,
          height: hashHex === tipHashHex ? 200 : 199,
          previousblockhash: hashHex === tipHashHex ? previousHashHex : undefined,
          time: hashHex === tipHashHex ? 1_700_000_200 : 1_700_000_199,
          tx: [],
        };
      },
    } as never,
  });

  assert.deepEqual(requestedHashes, [tipHashHex, previousHashHex]);
  assert.deepEqual(blockTimes, {
    199: 1_700_000_199,
    200: 1_700_000_200,
  });
});
