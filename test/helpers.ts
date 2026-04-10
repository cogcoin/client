import { createRequire } from "node:module";

import type { BitcoinBlock, BitcoinOutput, BitcoinTransaction } from "@cogcoin/indexer/types";

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

interface VectorOutput {
  valueSats: string;
  scriptPubKeyHex: string;
}

interface VectorTransaction {
  txidHex: string;
  senderScriptPubKeyHex: string | null;
  outputs: VectorOutput[];
}

interface VectorBlock {
  height: number;
  hashHex: string;
  previousHashHex: string | null;
  transactions: VectorTransaction[];
  expected?: {
    stateHashHex?: string | null;
  };
}

interface VectorFile {
  setupBlocks: VectorBlock[];
  testBlocks: VectorBlock[];
}

const require = createRequire(import.meta.url);

export function loadHistoryVector(): VectorFile {
  return require("@cogcoin/vectors/history-queries.json") as VectorFile;
}

function materializeOutput(output: VectorOutput): BitcoinOutput {
  return {
    valueSats: BigInt(output.valueSats),
    scriptPubKey: hexToBytes(output.scriptPubKeyHex),
  };
}

function materializeTransaction(transaction: VectorTransaction): BitcoinTransaction {
  return {
    txid: hexToBytes(transaction.txidHex),
    inputs: [
      {
        prevoutScriptPubKey: transaction.senderScriptPubKeyHex === null ? null : hexToBytes(transaction.senderScriptPubKeyHex),
      },
    ],
    outputs: transaction.outputs.map(materializeOutput),
  };
}

export function materializeBlock(block: VectorBlock): BitcoinBlock {
  return {
    height: block.height,
    hash: hexToBytes(block.hashHex),
    previousHash: block.previousHashHex === null ? null : hexToBytes(block.previousHashHex),
    transactions: block.transactions.map(materializeTransaction),
  };
}

export function createTempDatabasePath(prefix: string): string {
  return require("node:path").join(
    require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), `${prefix}-`)),
    "client.sqlite",
  );
}
