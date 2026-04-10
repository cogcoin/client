import type { SnapshotMetadata } from "../types.js";

export const SNAPSHOT_METADATA_VERSION = 1;
export const DOWNLOAD_RETRY_BASE_MS = 1_000;
export const DOWNLOAD_RETRY_MAX_MS = 30_000;
export const HEADER_POLL_MS = 2_000;
export const HEADER_NO_PEER_TIMEOUT_MS = 60_000;

export const DEFAULT_SNAPSHOT_METADATA: SnapshotMetadata = {
  url: "https://snapshots.cogcoin.org/utxo-910000.dat",
  filename: "utxo-910000.dat",
  height: 910_000,
  sha256: "6ac0208110d6d6c0783c50ea825aae32f5229cf1dcb63ac986543e95aa0306bf",
  sizeBytes: 9_637_809_744,
};
