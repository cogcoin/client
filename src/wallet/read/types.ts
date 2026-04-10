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
import type { DomainRecord as LocalDomainRecord, LocalIdentityRecord, WalletStateV1 } from "../types.js";

export type WalletStateAvailability =
  | "uninitialized"
  | "locked"
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
  walletRootId: string | null;
  state: WalletStateV1 | null;
  source: "primary" | "backup" | null;
  unlockUntilUnixMs: number | null;
  hasPrimaryStateFile: boolean;
  hasBackupStateFile: boolean;
  hasUnlockSessionFile: boolean;
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

export interface WalletIdentityView {
  index: number;
  scriptPubKeyHex: string;
  address: string | null;
  selectors: string[];
  assignedDomainNames: string[];
  localStatus: LocalIdentityRecord["status"];
  effectiveStatus: LocalIdentityRecord["status"];
  canonicalDomainId: number | null;
  canonicalDomainName: string | null;
  ownedDomainNames: string[];
  anchoredOwnedDomainNames: string[];
  observedCogBalance: bigint | null;
  readOnly: boolean;
}

export interface WalletDomainView {
  name: string;
  domainId: number | null;
  anchored: boolean | null;
  ownerScriptPubKeyHex: string | null;
  ownerLocalIndex: number | null;
  ownerAddress: string | null;
  localTracked: boolean;
  localRecord: LocalDomainRecord | null;
  chainFound: boolean;
  chainStatus: LocalDomainRecord["canonicalChainStatus"];
  localAnchorIntent: LocalDomainRecord["localAnchorIntent"] | null;
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
    | "owned"
    | "read-only"
    | "tracked"
    | "external"
    | "unknown";
}

export interface WalletReadModel {
  walletRootId: string;
  fundingIdentity: WalletIdentityView | null;
  identities: WalletIdentityView[];
  domains: WalletDomainView[];
  readOnlyIdentityCount: number;
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
  mining?: MiningControlPlaneView;
  close(): Promise<void>;
}

export interface WalletLockView {
  lockId: number;
  status: "active" | "claimed" | "reclaimed";
  amountCogtoshi: bigint;
  timeoutHeight: number;
  lockerScriptPubKeyHex: string;
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
