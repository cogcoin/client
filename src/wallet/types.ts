export type WalletNetwork = "mainnet";
export type ScriptPubKeyHex = string;
export type WalletMnemonicLanguage = "english";

export interface OutpointRecord {
  txid: string;
  vout: number;
}

export type PendingMutationStatus =
  | "draft"
  | "broadcasting"
  | "broadcast-unknown"
  | "live"
  | "confirmed"
  | "canceled"
  | "repair-required";

export interface PendingMutationRecord {
  mutationId: string;
  kind:
    | "anchor"
    | "register"
    | "transfer"
    | "sell"
    | "buy"
    | "rep-give"
    | "rep-revoke"
    | "send"
    | "lock"
    | "claim"
    | "field-create"
    | "field-set"
    | "field-clear"
    | "endpoint"
    | "delegate"
    | "miner"
    | "canonical";
  registerKind?: "root" | "subdomain";
  domainName: string;
  parentDomainName: string | null;
  senderScriptPubKeyHex: ScriptPubKeyHex;
  senderLocalIndex: number | null;
  recipientScriptPubKeyHex?: ScriptPubKeyHex | null;
  endpointValueHex?: string | null;
  priceCogtoshi?: bigint | null;
  amountCogtoshi?: bigint | null;
  recipientDomainName?: string | null;
  reviewPayloadHex?: string | null;
  timeoutHeight?: number | null;
  conditionHex?: string | null;
  lockId?: number | null;
  preimageHex?: string | null;
  fieldName?: string | null;
  fieldId?: number | null;
  fieldPermanent?: boolean | null;
  fieldFormat?: number | null;
  fieldValueHex?: string | null;
  intentFingerprintHex: string;
  status: PendingMutationStatus;
  createdAtUnixMs: number;
  lastUpdatedAtUnixMs: number;
  attemptedTxid: string | null;
  attemptedWtxid: string | null;
  selectedFeeRateSatVb?: number | null;
  feeSelectionSource?: "custom-satvb" | "estimated-next-block-plus-one" | "fallback-default" | null;
  temporaryBuilderLockedOutpoints: OutpointRecord[];
}

export interface LocalIdentityRecord {
  index: number;
  scriptPubKeyHex: ScriptPubKeyHex;
  address: string | null;
  status: "funding" | "dedicated" | "read-only";
  assignedDomainNames: string[];
}

export interface DomainRecord {
  name: string;
  domainId: number | null;
  currentOwnerScriptPubKeyHex: ScriptPubKeyHex | null;
  canonicalChainStatus:
    | "unknown"
    | "registered-unanchored"
    | "anchored";
  currentCanonicalAnchorOutpoint:
    | { txid: string; vout: number; valueSats: number }
    | null;
  foundingMessageText: string | null;
  birthTime: number | null;
}

export interface MiningStateRecord {
  runMode: "stopped" | "foreground" | "background";
  state:
    | "idle"
    | "live"
    | "paused"
    | "paused-stale"
    | "repair-required";
  pauseReason: string | null;
  currentPublishState:
    | "none"
    | "broadcasting"
    | "broadcast-unknown"
    | "in-mempool";
  currentDomain: string | null;
  currentDomainId: number | null;
  currentDomainIndex: number | null;
  currentSenderScriptPubKeyHex: ScriptPubKeyHex | null;
  currentTxid: string | null;
  currentWtxid: string | null;
  currentFeeRateSatVb: number | null;
  currentAbsoluteFeeSats: number | null;
  currentScore: string | null;
  currentSentence: string | null;
  currentEncodedSentenceBytesHex: string | null;
  currentBip39WordIndices: number[] | null;
  currentBlendSeedHex: string | null;
  currentBlockTargetHeight: number | null;
  currentReferencedBlockHashDisplay: string | null;
  currentIntentFingerprintHex: string | null;
  livePublishInMempool: boolean | null;
  currentPublishDecision: string | null;
  replacementCount: number;
  currentBlockFeeSpentSats: string;
  sessionFeeSpentSats: string;
  lifetimeFeeSpentSats: string;
  sharedMiningConflictOutpoint: { txid: string; vout: number } | null;
}

export interface WalletStateV1 {
  schemaVersion: 4;
  stateRevision: number;
  lastWrittenAtUnixMs: number;
  walletRootId: string;
  network: WalletNetwork;
  anchorValueSats: number;
  localScriptPubKeyHexes?: ScriptPubKeyHex[];
  mnemonic: {
    phrase: string;
    language: WalletMnemonicLanguage;
  };
  keys: {
    masterFingerprintHex: string;
    accountPath: string;
    accountXprv: string;
    accountXpub: string;
  };
  descriptor: {
    privateExternal: string;
    publicExternal: string;
    checksum: string | null;
    rangeEnd: number;
    safetyMargin: number;
  };
  funding: {
    address: string;
    scriptPubKeyHex: ScriptPubKeyHex;
  };
  walletBirthTime: number;
  managedCoreWallet: {
    walletName: string;
    internalPassphrase: string;
    descriptorChecksum: string | null;
    walletAddress?: string | null;
    walletScriptPubKeyHex?: ScriptPubKeyHex | null;
    proofStatus: "not-proven" | "ready" | "missing" | "mismatch";
    lastImportedAtUnixMs: number | null;
    lastVerifiedAtUnixMs: number | null;
  };
  domains: DomainRecord[];
  miningState: MiningStateRecord;
  pendingMutations?: PendingMutationRecord[];
}

export interface EncryptedEnvelopeV1 {
  format: string;
  version: 1;
  cipher: "aes-256-gcm";
  wrappedBy: string;
  walletRootIdHint?: string | null;
  secretProvider?: {
    kind: string;
    keyId: string;
  } | null;
  nonce: string;
  tag: string;
  ciphertext: string;
}

export interface WalletPendingInitializationStateV1 {
  schemaVersion: 1;
  createdAtUnixMs: number;
  mnemonic: {
    phrase: string;
    language: WalletMnemonicLanguage;
  };
}
