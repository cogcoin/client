import type { IndexerState } from "@cogcoin/indexer/types";

import type {
  ManagedBitcoindHealth,
  ManagedBitcoindObservedStatus,
  ManagedCoreWalletReplicaStatus,
  ManagedIndexerDaemonObservedStatus,
  ManagedIndexerTruthSource,
} from "../../bitcoind/types.js";
import type { ClientTip } from "../../types.js";
import type { MiningControlPlaneView } from "../mining/index.js";
import type { DomainRecord as LocalDomainRecord, WalletStateV1 } from "../types.js";
import type { ClientPasswordReadiness } from "../state/client-password.js";

export type WalletStateAvailability =
  | "uninitialized"
  | "ready"
  | "local-state-corrupt";

export type WalletServiceHealth =
  | "synced"
  | "catching-up"
  | "reorging"
  | "starting"
  | "stale-heartbeat"
  | "failed"
  | "schema-mismatch"
  | "service-version-mismatch"
  | "wallet-root-mismatch"
  | "unavailable";

export interface WalletLocalStateStatus {
  availability: WalletStateAvailability;
  clientPasswordReadiness: ClientPasswordReadiness;
  unlockRequired: boolean;
  walletRootId: string | null;
  state: WalletStateV1 | null;
  source: "primary" | "backup" | null;
  hasPrimaryStateFile: boolean;
  hasBackupStateFile: boolean;
  message: string | null;
}

export interface WalletNodeStatus {
  ready: boolean;
  chain: string;
  pid: number | null;
  walletRootId: string | null;
  nodeBestHeight: number | null;
  nodeBestHashHex: string | null;
  nodeHeaderHeight: number | null;
  serviceUpdatedAtUnixMs: number | null;
  serviceStatus: ManagedBitcoindObservedStatus | null;
  walletReplica: ManagedCoreWalletReplicaStatus | null;
  walletReplicaMessage?: string | null;
}

export interface WalletBitcoindStatus {
  health: ManagedBitcoindHealth;
  status: ManagedBitcoindObservedStatus | null;
  message: string | null;
}

export interface WalletIndexerStatus {
  health: WalletServiceHealth;
  status: ManagedIndexerDaemonObservedStatus | null;
  message: string | null;
  snapshotTip: ClientTip | null;
  source?: ManagedIndexerTruthSource;
  daemonInstanceId?: string | null;
  snapshotSeq?: string | null;
  openedAtUnixMs?: number | null;
}

export interface WalletSnapshotView {
  state: IndexerState;
  tip: ClientTip | null;
  source?: "lease";
  daemonInstanceId?: string | null;
  snapshotSeq?: string | null;
  openedAtUnixMs?: number | null;
}

export interface WalletDomainView {
  name: string;
  domainId: number | null;
  anchored: boolean | null;
  ownerScriptPubKeyHex: string | null;
  ownerAddress: string | null;
  localTracked: boolean;
  localRecord: LocalDomainRecord | null;
  chainFound: boolean;
  chainStatus: LocalDomainRecord["canonicalChainStatus"];
  foundingMessageText: string | null;
  endpointText: string | null;
  delegateScriptPubKeyHex: string | null;
  minerScriptPubKeyHex: string | null;
  fieldCount: number | null;
  listingPriceCogtoshi: bigint | null;
  activeLockCount: number | null;
  selfStakeCogtoshi: bigint | null;
  supportedStakeCogtoshi: bigint | null;
  totalSupportedCogtoshi: bigint | null;
  totalRevokedCogtoshi: bigint | null;
  readOnly: boolean;
  localRelationship:
    | "local"
    | "external"
    | "unknown";
}

export interface WalletReadModel {
  walletRootId: string;
  walletAddress: string | null;
  walletScriptPubKeyHex: string;
  domains: WalletDomainView[];
}

export interface WalletReadContext {
  dataDir: string;
  databasePath: string;
  localState: WalletLocalStateStatus;
  bitcoind: WalletBitcoindStatus;
  nodeStatus: WalletNodeStatus | null;
  nodeHealth: WalletServiceHealth;
  nodeMessage: string | null;
  indexer: WalletIndexerStatus;
  snapshot: WalletSnapshotView | null;
  model: WalletReadModel | null;
  fundingSpendableSats: bigint | null;
  mining?: MiningControlPlaneView;
  close(): Promise<void>;
}

export interface WalletLockView {
  lockId: number;
  status: "active" | "claimed" | "reclaimed";
  amountCogtoshi: bigint;
  timeoutHeight: number;
  lockerScriptPubKeyHex: string;
  lockerLocal?: boolean;
  lockerLocalIndex: number | null;
  recipientDomainId: number;
  recipientDomainName: string | null;
  recipientLocal: boolean;
  claimableNow: boolean;
  reclaimableNow: boolean;
}

export interface WalletFieldView {
  domainName: string;
  domainId: number;
  fieldId: number;
  name: string;
  permanent: boolean;
  hasValue: boolean;
  format: number | null;
  preview: string | null;
  rawValueHex: string | null;
}

export interface WalletDomainDetailsView {
  domain: WalletDomainView;
  localRelationship: WalletDomainView["localRelationship"];
}
