import { serializeBlockRecord } from "@cogcoin/indexer";
import type { BitcoinBlock, BlockRecord } from "@cogcoin/indexer/types";

import { internalBytesToDisplayHashHex, internalHashHexToDisplayHashHex } from "../bitcoind/hash-order.js";
import type {
  ClientCheckpoint,
  ClientTip,
  StoredBlockRecord,
} from "../types.js";

export function createTip(block: BitcoinBlock, stateHashHex: string | null): ClientTip {
  return {
    height: block.height,
    blockHashHex: internalBytesToDisplayHashHex(block.hash),
    previousHashHex: block.previousHash === null ? null : internalBytesToDisplayHashHex(block.previousHash),
    stateHashHex,
  };
}

export function createStoredBlockRecord(blockRecord: BlockRecord, createdAt: number): StoredBlockRecord {
  return {
    height: blockRecord.height,
    blockHashHex: internalHashHexToDisplayHashHex(blockRecord.hashHex),
    previousHashHex:
      blockRecord.previousHashHex === null ? null : internalHashHexToDisplayHashHex(blockRecord.previousHashHex),
    stateHashHex: blockRecord.stateHashHex,
    recordBytes: serializeBlockRecord(blockRecord),
    createdAt,
  };
}

export function createCheckpoint(tip: ClientTip, stateBytes: Uint8Array, createdAt: number): ClientCheckpoint {
  return {
    height: tip.height,
    blockHashHex: tip.blockHashHex,
    stateBytes,
    createdAt,
  };
}
