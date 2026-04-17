import type {
  AppliedBlock,
  BitcoinBlock,
  BlockRecord,
  GenesisParameters,
  IndexerState,
} from "@cogcoin/indexer/types";

export interface ClientTip {
  height: number;
  blockHashHex: string;
  previousHashHex: string | null;
  stateHashHex: string | null;
}

export interface ClientCheckpoint {
  height: number;
  blockHashHex: string;
  stateBytes: Uint8Array;
  createdAt: number;
}

export interface StoredBlockRecord {
  height: number;
  blockHashHex: string;
  previousHashHex: string | null;
  stateHashHex: string | null;
  recordBytes: Uint8Array;
  createdAt: number;
}

export interface WriteAppliedBlockEntry {
  tip: ClientTip | null;
  stateBytes: Uint8Array | null;
  blockRecord?: StoredBlockRecord | null;
  checkpoint?: ClientCheckpoint | null;
  deleteAboveHeight?: number | null;
  deleteBelowHeight?: number | null;
}

export interface ClientStoreAdapter {
  loadTip(): Promise<ClientTip | null>;
  loadLatestSnapshot(): Promise<ClientCheckpoint | null>;
  loadLatestCheckpointAtOrBelow(height: number): Promise<ClientCheckpoint | null>;
  loadBlockRecordsAfter(height: number): Promise<StoredBlockRecord[]>;
  writeAppliedBlock(entry: WriteAppliedBlockEntry): Promise<void>;
  deleteBlockRecordsAbove(height: number): Promise<void>;
  loadBlockRecord(height: number): Promise<StoredBlockRecord | null>;
  close(): Promise<void>;
}

export interface ClientOptions {
  store: ClientStoreAdapter;
  genesisParameters?: GenesisParameters;
  snapshotInterval?: number;
  blockRecordRetention?: number;
}

export interface ApplyBlockResult {
  tip: ClientTip;
  checkpoint: ClientCheckpoint | null;
  applied: AppliedBlock;
}

export interface Client {
  getTip(): Promise<ClientTip | null>;
  getState(): Promise<IndexerState>;
  applyBlock(block: BitcoinBlock): Promise<ApplyBlockResult>;
  rewindToHeight(height: number): Promise<ClientTip | null>;
  close(): Promise<void>;
}

export type {
  BitcoinBlock,
  BlockRecord,
  GenesisParameters,
  IndexerState,
};
