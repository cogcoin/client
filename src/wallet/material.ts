import { createHash, randomBytes } from "node:crypto";

import { bech32 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import type { WalletMnemonicLanguage } from "./types.js";

export const WALLET_ACCOUNT_PATH = "m/84'/0'/0'";
export const DEFAULT_DESCRIPTOR_RANGE_END = 4095;
export const DEFAULT_DESCRIPTOR_SAFETY_MARGIN = 128;

export interface WalletMaterial {
  mnemonic: {
    phrase: string;
    words: string[];
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
    index: 0;
    address: string;
    scriptPubKeyHex: string;
  };
}

export interface WalletDerivedIdentity {
  index: number;
  address: string;
  scriptPubKeyHex: string;
  ethereumAddress: string;
  nostrPublicKeyHex: string;
  nostrNpub: string;
}

function hash160(value: Uint8Array): Uint8Array {
  const sha256 = createHash("sha256").update(value).digest();
  return createHash("ripemd160").update(sha256).digest();
}

function formatFingerprint(fingerprint: number): string {
  return fingerprint.toString(16).padStart(8, "0");
}

function encodeSegwitV0Address(program: Uint8Array): string {
  return bech32.encode("bc", [0, ...bech32.toWords(program)]);
}

function encodeNostrNpub(xOnlyPublicKey: Uint8Array): string {
  return bech32.encode("npub", bech32.toWords(xOnlyPublicKey));
}

function buildExternalDescriptor(
  fingerprintHex: string,
  accountKey: string,
): string {
  return `wpkh([${fingerprintHex}/84h/0h/0h]${accountKey}/0/*)`;
}

function deriveFundingAddress(root: HDKey): {
  address: string;
  scriptPubKeyHex: string;
} {
  const fundingNode = root.derive("m/84'/0'/0'/0/0");

  if (fundingNode.publicKey == null) {
    throw new Error("wallet_material_missing_funding_public_key");
  }

  const pubkeyHash = hash160(fundingNode.publicKey);
  return {
    address: encodeSegwitV0Address(pubkeyHash),
    scriptPubKeyHex: `0014${Buffer.from(pubkeyHash).toString("hex")}`,
  };
}

function deriveIdentityFromNode(index: number, node: HDKey): WalletDerivedIdentity {
  if (node.publicKey == null || node.privateKey == null) {
    throw new Error("wallet_material_missing_identity_key");
  }

  const compressedPublicKey = secp256k1.getPublicKey(node.privateKey, true);
  const uncompressedPublicKey = secp256k1.getPublicKey(node.privateKey, false);
  const pubkeyHash = hash160(compressedPublicKey);
  const ethereumAddress = `0x${Buffer.from(keccak_256(uncompressedPublicKey.subarray(1)).subarray(-20)).toString("hex")}`;
  const nostrPublicKey = compressedPublicKey.subarray(1, 33);

  return {
    index,
    address: encodeSegwitV0Address(pubkeyHash),
    scriptPubKeyHex: `0014${Buffer.from(pubkeyHash).toString("hex")}`,
    ethereumAddress,
    nostrPublicKeyHex: Buffer.from(nostrPublicKey).toString("hex"),
    nostrNpub: encodeNostrNpub(nostrPublicKey),
  };
}

export function generateWalletMaterial(): WalletMaterial {
  const phrase = generateMnemonic(englishWordlist, 256);
  return deriveWalletMaterialFromMnemonic(phrase);
}

export function deriveWalletMaterialFromMnemonic(
  phrase: string,
): WalletMaterial {
  const words = phrase.trim().split(/\s+/);
  const seed = mnemonicToSeedSync(phrase);
  const root = HDKey.fromMasterSeed(seed);
  const accountNode = root.derive(WALLET_ACCOUNT_PATH);

  if (accountNode.privateExtendedKey == null || accountNode.publicExtendedKey == null) {
    throw new Error("wallet_material_missing_account_keys");
  }

  const masterFingerprintHex = formatFingerprint(root.fingerprint);
  const funding = deriveFundingAddress(root);

  return {
    mnemonic: {
      phrase,
      words,
      language: "english",
    },
    keys: {
      masterFingerprintHex,
      accountPath: WALLET_ACCOUNT_PATH,
      accountXprv: accountNode.privateExtendedKey,
      accountXpub: accountNode.publicExtendedKey,
    },
    descriptor: {
      privateExternal: buildExternalDescriptor(masterFingerprintHex, accountNode.privateExtendedKey),
      publicExternal: buildExternalDescriptor(masterFingerprintHex, accountNode.publicExtendedKey),
      checksum: null,
      rangeEnd: DEFAULT_DESCRIPTOR_RANGE_END,
      safetyMargin: DEFAULT_DESCRIPTOR_SAFETY_MARGIN,
    },
    funding: {
      index: 0,
      address: funding.address,
      scriptPubKeyHex: funding.scriptPubKeyHex,
    },
  };
}

export function deriveWalletIdentityMaterial(
  accountKey: string,
  index: number,
): WalletDerivedIdentity {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("wallet_material_invalid_identity_index");
  }

  const accountNode = HDKey.fromExtendedKey(accountKey);
  const identityNode = accountNode.deriveChild(0).deriveChild(index);
  return deriveIdentityFromNode(index, identityNode);
}

export function createInternalCoreWalletPassphrase(): string {
  return randomBytes(32).toString("hex");
}

export function createMnemonicConfirmationChallenge(
  words: string[],
  count = 4,
): Array<{ index: number; word: string }> {
  const selected = new Set<number>();

  while (selected.size < Math.min(count, words.length)) {
    selected.add(randomBytes(1)[0]! % words.length);
  }

  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => ({
      index,
      word: words[index]!,
    }));
}
