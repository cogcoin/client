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
  dedicatedIndex: number | null;
  currentOwnerScriptPubKeyHex: ScriptPubKeyHex | null;
  currentOwnerLocalIndex: number | null;
  canonicalChainStatus:
    | "unknown"
    | "registered-unanchored"
    | "anchored";
  localAnchorIntent:
    | "none"
    | "reserved"
    | "tx1-live"
    | "tx2-live"
    | "repair-required";
  currentCanonicalAnchorOutpoint:
    | { txid: string; vout: number; valueSats: number }
    | null;
  foundingMessageText: string | null;
  birthTime: number | null;
}

export interface HookClientStateRecord {
  mode: "builtin" | "custom" | "disabled";
  validationState: "unknown" | "validated" | "stale" | "failed" | "never" | "current";
  lastValidationAtUnixMs: number | null;
  lastValidationError: string | null;
  validatedLaunchFingerprint: string | null;
  validatedFullFingerprint: string | null;
  fullTrustWarningAcknowledgedAtUnixMs: number | null;
  consecutiveFailureCount: number;
  cooldownUntilUnixMs: number | null;
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
  liveMiningFamilyInMempool: boolean | null;
  currentPublishDecision: string | null;
  replacementCount: number;
  currentBlockFeeSpentSats: string;
  sessionFeeSpentSats: string;
  lifetimeFeeSpentSats: string;
  sharedMiningConflictOutpoint: { txid: string; vout: number } | null;
}

export interface ProactiveFamilyTransactionRecord {
  status:
    | "draft"
    | "broadcasting"
    | "broadcast-unknown"
    | "live"
    | "confirmed"
    | "canceled"
    | "repair-required";
  attemptedTxid: string | null;
  attemptedWtxid: string | null;
  temporaryBuilderLockedOutpoints: OutpointRecord[];
  rawHex: string | null;
}

export interface ProactiveFamilyStateRecord {
  familyId: string;
  type: "anchor" | "field" | string;
  status:
    | "draft"
    | "broadcasting"
    | "broadcast-unknown"
    | "live"
    | "confirmed"
    | "canceled"
    | "repair-required";
  intentFingerprintHex: string;
  createdAtUnixMs: number;
  lastUpdatedAtUnixMs?: number;
  domainName?: string | null;
  domainId?: number | null;
  sourceSenderLocalIndex?: number | null;
  sourceSenderScriptPubKeyHex?: ScriptPubKeyHex | null;
  reservedDedicatedIndex?: number | null;
  reservedScriptPubKeyHex?: ScriptPubKeyHex | null;
  foundingMessageText?: string | null;
  foundingMessagePayloadHex?: string | null;
  listingCancelCommitted?: boolean;
  fieldName?: string | null;
  expectedFieldId?: number | null;
  fieldPermanent?: boolean | null;
  fieldFormat?: number | null;
  fieldValueHex?: string | null;
  currentStep?: "reserved" | "tx1" | "tx2" | null;
  tx1?: ProactiveFamilyTransactionRecord | null;
  tx2?: ProactiveFamilyTransactionRecord | null;
}

export interface WalletStateV1 {
  schemaVersion: 1;
  stateRevision: number;
  lastWrittenAtUnixMs: number;
  walletRootId: string;
  network: WalletNetwork;
  anchorValueSats: number;
  nextDedicatedIndex: number;
  fundingIndex: 0;
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
    fundingAddress0: string | null;
    fundingScriptPubKeyHex0: ScriptPubKeyHex | null;
    proofStatus: "not-proven" | "ready" | "missing" | "mismatch";
    lastImportedAtUnixMs: number | null;
    lastVerifiedAtUnixMs: number | null;
  };
  identities: LocalIdentityRecord[];
  domains: DomainRecord[];
  miningState: MiningStateRecord;
  hookClientState: {
    mining: HookClientStateRecord;
  };
  proactiveFamilies: ProactiveFamilyStateRecord[];
  pendingMutations?: PendingMutationRecord[];
}

export interface PortableWalletArchivePayloadV1 {
  schemaVersion: 1;
  exportedAtUnixMs: number;
  walletRootId: string;
  network: WalletNetwork;
  anchorValueSats: number;
  nextDedicatedIndex: number;
  fundingIndex: 0;
  mnemonic: {
    phrase: string;
    language: WalletMnemonicLanguage;
  };
  expected: {
    masterFingerprintHex: string;
    accountPath: string;
    accountXpub: string;
    publicExternalDescriptor: string;
    descriptorChecksum: string | null;
    rangeEnd: number;
    safetyMargin: number;
    fundingAddress0: string;
    fundingScriptPubKeyHex0: ScriptPubKeyHex;
    walletBirthTime: number;
  };
  identities: LocalIdentityRecord[];
  domains: DomainRecord[];
  miningState: MiningStateRecord;
  hookClientState: {
    mining: HookClientStateRecord;
  };
  proactiveFamilies: ProactiveFamilyStateRecord[];
}

export interface Argon2EnvelopeParams {
  name: "argon2id";
  memoryKib: number;
  iterations: number;
  parallelism: number;
  salt: string;
}

export interface EncryptedEnvelopeV1 {
  format: string;
  version: 1;
  cipher: "aes-256-gcm";
  wrappedBy: string;
  argon2id?: Argon2EnvelopeParams | null;
  secretProvider?: {
    kind: string;
    keyId: string;
  } | null;
  nonce: string;
  tag: string;
  ciphertext: string;
}

export interface UnlockSessionStateV1 {
  schemaVersion: 1;
  walletRootId: string;
  sessionId: string;
  createdAtUnixMs: number;
  unlockUntilUnixMs: number;
  sourceStateRevision: number;
  wrappedSessionKeyMaterial: string;
}

export interface WalletExplicitLockStateV1 {
  schemaVersion: 1;
  walletRootId: string;
  lockedAtUnixMs: number;
}

export interface WalletPendingInitializationStateV1 {
  schemaVersion: 1;
  createdAtUnixMs: number;
  mnemonic: {
    phrase: string;
    language: WalletMnemonicLanguage;
  };
}
