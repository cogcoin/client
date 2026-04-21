export const CLIENT_PASSWORD_STATE_FORMAT = "cogcoin-client-password";
export const CLIENT_PASSWORD_ROTATION_JOURNAL_FORMAT = "cogcoin-client-password-rotation";
export const CLIENT_PASSWORD_VERIFIER_FORMAT = "cogcoin-client-password-verifier";
export const LOCAL_SECRET_ENVELOPE_FORMAT = "cogcoin-local-wallet-secret";
export const CLIENT_PASSWORD_VERIFIER_TEXT = "cogcoin-client-password-verifier-v1";

export type ClientPasswordReadiness =
  | "ready"
  | "setup-required"
  | "migration-required";

export type ClientPasswordSetupAction =
  | "created"
  | "migrated"
  | "already-configured";

export interface ClientPasswordPrompt {
  readonly isInteractive: boolean;
  writeLine(message: string): void;
  prompt(message: string): Promise<string>;
  promptHidden?(message: string): Promise<string>;
}

export interface ClientPasswordSessionStatus {
  unlocked: boolean;
  unlockUntilUnixMs: number | null;
}

export interface ClientPasswordLegacyKeychainReader {
  loadSecret(keyId: string): Promise<Uint8Array>;
}

export interface ClientPasswordStorageOptions {
  platform: NodeJS.Platform;
  stateRoot: string;
  runtimeRoot: string;
  directoryPath: string;
  runtimeErrorCode: string;
  legacyMacKeychainReader?: ClientPasswordLegacyKeychainReader | null;
}

export interface ClientPasswordResolvedContext extends ClientPasswordStorageOptions {
  legacyMacKeychainReader?: ClientPasswordLegacyKeychainReader | null;
  passwordStatePath: string;
  rotationJournalPath: string;
}

export interface ClientPasswordStateV1 {
  format: typeof CLIENT_PASSWORD_STATE_FORMAT;
  version: 1;
  passwordHint: string;
  kdf: {
    name: "argon2id";
    memoryKib: number;
    iterations: number;
    parallelism: number;
    salt: string;
  };
  verifier: {
    cipher: "aes-256-gcm";
    nonce: string;
    tag: string;
    ciphertext: string;
  };
}

export interface WrappedSecretEnvelopeV1 {
  format: typeof LOCAL_SECRET_ENVELOPE_FORMAT;
  version: 1;
  cipher: "aes-256-gcm";
  wrappedBy: "client-password";
  nonce: string;
  tag: string;
  ciphertext: string;
}

export interface ClientPasswordRotationJournalV1 {
  format: typeof CLIENT_PASSWORD_ROTATION_JOURNAL_FORMAT;
  version: 1;
  nextState: ClientPasswordStateV1;
  secrets: Array<{
    keyId: string;
    envelope: WrappedSecretEnvelopeV1;
  }>;
}

export interface ClientPasswordAgentBootstrapState {
  unlockUntilUnixMs: number;
  derivedKeyBase64: string;
}

export type LocalSecretFile =
  | { state: "missing" }
  | { state: "raw"; secret: Uint8Array }
  | { state: "wrapped"; envelope: WrappedSecretEnvelopeV1 };
