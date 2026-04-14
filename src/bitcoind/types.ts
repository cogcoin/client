import type { BitcoinBlock, Client, ClientOptions, ClientTip } from "../types.js";

export type BootstrapPhase =
  | "snapshot_download"
  | "wait_headers_for_snapshot"
  | "load_snapshot"
  | "bitcoin_sync"
  | "cogcoin_sync"
  | "follow_tip"
  | "paused"
  | "error"
  | "complete";

export type ProgressOutputMode = "auto" | "tty" | "none";

export interface SnapshotMetadata {
  url: string;
  filename: string;
  height: number;
  sha256: string;
  sizeBytes: number;
}

export interface SnapshotChunkManifest {
  formatVersion: number;
  chunkSizeBytes: number;
  snapshotFilename: string;
  snapshotHeight: number;
  snapshotSizeBytes: number;
  snapshotSha256: string;
  chunkSha256s: string[];
}

export interface WritingQuote {
  quote: string;
  author: string;
}

export interface BootstrapProgress {
  phase: BootstrapPhase;
  message: string;
  resumed: boolean;
  downloadedBytes: number | null;
  totalBytes: number | null;
  percent: number | null;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  headers: number | null;
  blocks: number | null;
  targetHeight: number | null;
  baseHeight: number | null;
  tipHashHex: string | null;
  lastError: string | null;
  updatedAt: number;
}

export interface ManagedBitcoindProgressEvent {
  phase: BootstrapPhase;
  progress: BootstrapProgress;
  snapshot: SnapshotMetadata;
  currentQuote: WritingQuote | null;
  cogcoinSyncHeight: number | null;
  cogcoinSyncTargetHeight: number | null;
}

export interface BitcoindRpcConfig {
  url: string;
  cookieFile: string;
  port: number;
}

export interface BitcoindZmqConfig {
  endpoint: string;
  topic: "hashblock";
  port: number;
  pollIntervalMs: number;
}

export interface ManagedBitcoindRuntimeConfig {
  chain: "main" | "regtest";
  rpc: BitcoindRpcConfig;
  zmqPort: number;
  p2pPort: number;
}

export const MANAGED_BITCOIND_SERVICE_API_VERSION = "cogcoin/bitcoind-service/v1";

export type ManagedBitcoindServiceState =
  | "starting"
  | "ready"
  | "stopping"
  | "failed";

export interface ManagedBitcoindServiceStatus {
  serviceApiVersion: typeof MANAGED_BITCOIND_SERVICE_API_VERSION;
  binaryVersion: string;
  buildId: string | null;
  serviceInstanceId: string;
  state: ManagedBitcoindServiceState;
  processId: number | null;
  walletRootId: string;
  chain: "main" | "regtest";
  dataDir: string;
  runtimeRoot: string;
  startHeight: number;
  rpc: BitcoindRpcConfig;
  zmq: BitcoindZmqConfig;
  p2pPort: number;
  walletReplica: ManagedCoreWalletReplicaStatus | null;
  startedAtUnixMs: number;
  heartbeatAtUnixMs: number;
  updatedAtUnixMs: number;
  lastError: string | null;
}

export interface ManagedBitcoindObservedStatus extends Omit<ManagedBitcoindServiceStatus, "serviceApiVersion"> {
  serviceApiVersion: string;
}

export type ManagedBitcoindHealth =
  | "ready"
  | "starting"
  | "failed"
  | "service-version-mismatch"
  | "wallet-root-mismatch"
  | "runtime-mismatch"
  | "replica-missing"
  | "replica-mismatch"
  | "unavailable";

export interface SyncResult {
  appliedBlocks: number;
  rewoundBlocks: number;
  commonAncestorHeight: number | null;
  startingHeight: number | null;
  endingHeight: number | null;
  bestHeight: number;
  bestHashHex: string;
}

export interface ManagedBitcoindStatus {
  ready: boolean;
  following: boolean;
  chain: string;
  pid: number | null;
  walletRootId: string | null;
  rpc: BitcoindRpcConfig;
  zmq: BitcoindZmqConfig;
  indexedTip: ClientTip | null;
  nodeBestHeight: number | null;
  nodeBestHashHex: string | null;
  bootstrapPhase: BootstrapPhase;
  bootstrapProgress: BootstrapProgress;
  cogcoinSyncHeight: number | null;
  cogcoinSyncTargetHeight: number | null;
  currentQuote: WritingQuote | null;
  snapshot: SnapshotMetadata;
  serviceRuntimeRoot?: string;
  serviceUpdatedAtUnixMs?: number | null;
  walletReplica?: ManagedCoreWalletReplicaStatus | null;
  serviceStatus?: ManagedBitcoindObservedStatus | null;
  indexerDaemon?: ManagedIndexerDaemonObservedStatus | null;
}

export interface ManagedBitcoindOptions extends ClientOptions {
  dataDir?: string;
  databasePath?: string;
  rpcPort?: number;
  zmqPort?: number;
  p2pPort?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  pollIntervalMs?: number;
  syncDebounceMs?: number;
  walletRootId?: string;
  managedWalletPassphrase?: string;
  onProgress?: (event: ManagedBitcoindProgressEvent) => void;
  progressOutput?: ProgressOutputMode;
}

export interface ManagedBitcoindClient extends Client {
  syncToTip(): Promise<SyncResult>;
  startFollowingTip(): Promise<void>;
  getNodeStatus(): Promise<ManagedBitcoindStatus>;
  close(): Promise<void>;
}

export interface InternalManagedBitcoindOptions extends ManagedBitcoindOptions {
  chain: "main" | "regtest";
  startHeight: number;
}

export interface ManagedCoreWalletReplicaStatus {
  walletRootId: string;
  walletName: string;
  loaded: boolean;
  descriptors: boolean;
  privateKeysEnabled: boolean;
  created: boolean;
  proofStatus?: "not-proven" | "ready" | "missing" | "mismatch";
  descriptorChecksum?: string | null;
  fundingAddress0?: string | null;
  fundingScriptPubKeyHex0?: string | null;
  message?: string | null;
}

export const INDEXER_DAEMON_SERVICE_API_VERSION = "cogcoin/indexer-ipc/v1";
export const INDEXER_DAEMON_SCHEMA_VERSION = "cogcoin/indexer-db/v1";

export type ManagedIndexerTruthSource = "lease" | "probe" | "status-file" | "none";

export type ManagedIndexerDaemonState =
  | "starting"
  | "catching-up"
  | "reorging"
  | "synced"
  | "stopping"
  | "failed"
  | "schema-mismatch"
  | "service-version-mismatch";

export interface ManagedIndexerDaemonRuntimeIdentity {
  serviceApiVersion: typeof INDEXER_DAEMON_SERVICE_API_VERSION;
  schemaVersion: typeof INDEXER_DAEMON_SCHEMA_VERSION;
  walletRootId: string;
  daemonInstanceId: string;
  processId: number | null;
  startedAtUnixMs: number;
}

export interface ManagedIndexerSnapshotIdentity extends ManagedIndexerDaemonRuntimeIdentity {
  snapshotSeq: string | null;
  tipHeight: number | null;
  tipHash: string | null;
  openedAtUnixMs: number;
}

export interface ManagedIndexerDaemonStatus {
  serviceApiVersion: typeof INDEXER_DAEMON_SERVICE_API_VERSION;
  binaryVersion: string;
  buildId: string | null;
  updatedAtUnixMs: number;
  walletRootId: string;
  daemonInstanceId: string;
  schemaVersion: typeof INDEXER_DAEMON_SCHEMA_VERSION;
  state: ManagedIndexerDaemonState;
  processId: number | null;
  startedAtUnixMs: number;
  heartbeatAtUnixMs: number;
  ipcReady: boolean;
  rpcReachable: boolean;
  coreBestHeight: number | null;
  coreBestHash: string | null;
  appliedTipHeight: number | null;
  appliedTipHash: string | null;
  snapshotSeq: string | null;
  backlogBlocks: number | null;
  reorgDepth: number | null;
  lastAppliedAtUnixMs: number | null;
  activeSnapshotCount: number;
  lastError: string | null;
}

export interface ManagedIndexerDaemonObservedStatus extends Omit<ManagedIndexerDaemonStatus, "serviceApiVersion" | "schemaVersion"> {
  serviceApiVersion: string;
  schemaVersion: string;
}

export interface RpcBlockchainInfo {
  chain: string;
  blocks: number;
  headers: number;
  bestblockhash: string;
  pruned: boolean;
  verificationprogress?: number;
  initialblockdownload?: boolean;
}

export interface RpcNetworkInfo {
  networkactive: boolean;
  connections: number;
  connections_in?: number;
  connections_out?: number;
}

export interface RpcZmqNotification {
  type: string;
  address: string;
  hwm: number;
}

export interface RpcVout {
  value: number | string;
  n: number;
  scriptPubKey?: {
    hex?: string;
    address?: string;
  };
}

export interface RpcPrevout {
  scriptPubKey?: {
    hex?: string;
    address?: string;
  };
}

export interface RpcVin {
  txid?: string;
  coinbase?: string;
  prevout?: RpcPrevout;
}

export interface RpcTransaction {
  txid: string;
  hash?: string;
  vin: RpcVin[];
  vout: RpcVout[];
}

export interface RpcMempoolInfo {
  loaded: boolean;
  size?: number;
}

export interface RpcMempoolEntry {
  vsize: number;
  fees: {
    base: number;
    ancestor: number;
    descendant: number;
  };
  ancestorsize?: number;
  descendantsize?: number;
}

export interface RpcRawMempoolVerbose {
  txids: string[];
  mempool_sequence: string | number;
}

export interface RpcWalletTransaction {
  txid: string;
  walletconflicts?: string[];
  confirmations: number;
  blockhash?: string;
  blockheight?: number;
  time?: number;
  timereceived?: number;
}

export interface RpcBlock {
  hash: string;
  previousblockhash?: string;
  height: number;
  time?: number;
  tx: RpcTransaction[];
}

export interface RpcChainState {
  blocks?: number;
  validated?: boolean;
  snapshot_blockhash?: string;
  verificationprogress?: number;
}

export interface RpcChainStatesResponse {
  chainstates: RpcChainState[];
  headers?: number;
}

export interface RpcLoadTxOutSetResult {
  coins_loaded: number;
  base_height: number;
  tip_hash: string;
}

export interface RpcCreateWalletResult {
  name: string;
  warning: string;
}

export interface RpcLoadWalletResult {
  name: string;
  warning: string;
}

export interface RpcWalletInfo {
  walletname: string;
  private_keys_enabled: boolean;
  descriptors: boolean;
  unlocked_until?: number;
}

export interface RpcDescriptorInfo {
  descriptor: string;
  checksum: string;
  isrange: boolean;
  issolvable: boolean;
  hasprivatekeys: boolean;
}

export interface RpcListDescriptorsEntry {
  desc: string;
  active?: boolean;
  internal?: boolean;
  next?: number;
  range?: number | [number, number];
  timestamp?: number | string;
}

export interface RpcListDescriptorsResult {
  wallet_name?: string;
  descriptors: RpcListDescriptorsEntry[];
}

export interface RpcImportDescriptorRequest {
  desc: string;
  timestamp: string | number;
  active?: boolean;
  internal?: boolean;
  next_index?: number;
  range?: number | [number, number];
  label?: string;
}

export interface RpcImportDescriptorResult {
  success: boolean;
  warnings?: string[];
  error?: {
    code: number;
    message: string;
  };
}

export interface RpcWalletProcessPsbtResult {
  psbt: string;
  complete: boolean;
}

export interface RpcWalletCreateFundedPsbtResult {
  psbt: string;
  fee: number;
  changepos: number;
}

export interface RpcLockedUnspent {
  txid: string;
  vout: number;
}

export interface RpcListUnspentEntry {
  txid: string;
  vout: number;
  address?: string;
  scriptPubKey: string;
  amount: number;
  confirmations: number;
  spendable?: boolean;
  solvable?: boolean;
  safe?: boolean;
}

export interface RpcDecodedPsbt {
  tx: RpcTransaction;
}

export interface RpcFinalizePsbtResult {
  psbt?: string;
  hex?: string;
  complete: boolean;
}

export interface RpcTestMempoolAcceptResult {
  txid?: string;
  wtxid?: string;
  allowed: boolean;
  "reject-reason"?: string;
}

export interface ManagedBitcoindNodeHandle {
  rpc: BitcoindRpcConfig;
  zmq: BitcoindZmqConfig;
  pid: number | null;
  expectedChain: "main" | "regtest";
  startHeight: number;
  dataDir: string;
  walletRootId?: string;
  runtimeRoot?: string;
  validate(): Promise<void>;
  refreshServiceStatus?(): Promise<ManagedBitcoindServiceStatus>;
  stop(): Promise<void>;
}

export type { BitcoinBlock };
