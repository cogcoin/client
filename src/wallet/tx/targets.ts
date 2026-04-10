import { createHash } from "node:crypto";

import { base58, bech32, bech32m } from "@scure/base";

import { validateExternalScriptPubKey } from "../cogop/index.js";

const BASE58CHECK_P2PKH_MAINNET = 0x00;
const BASE58CHECK_P2SH_MAINNET = 0x05;
const BECH32_HRP_MAINNET = "bc";

export interface NormalizedBtcTarget {
  scriptPubKeyHex: string;
  address: string | null;
  opaque: boolean;
}

function sha256(value: Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

function checksum4(value: Uint8Array): Uint8Array {
  return sha256(sha256(value)).subarray(0, 4);
}

function encodeBase58Check(version: number, payload: Uint8Array): string {
  const body = Buffer.concat([Buffer.from([version]), Buffer.from(payload)]);
  return base58.encode(Buffer.concat([body, Buffer.from(checksum4(body))]));
}

function decodeBase58Check(value: string): { version: number; payload: Uint8Array } {
  const decoded = Buffer.from(base58.decode(value));

  if (decoded.length < 5) {
    throw new Error("wallet_target_invalid_address");
  }

  const body = decoded.subarray(0, decoded.length - 4);
  const actualChecksum = decoded.subarray(decoded.length - 4);
  const expectedChecksum = checksum4(body);

  if (!Buffer.from(expectedChecksum).equals(actualChecksum)) {
    throw new Error("wallet_target_invalid_address");
  }

  return {
    version: body[0]!,
    payload: body.subarray(1),
  };
}

function encodeWitnessAddress(version: number, program: Uint8Array): string {
  const words = [version, ...bech32.toWords(program)];
  return version === 0
    ? bech32.encode(BECH32_HRP_MAINNET, words)
    : bech32m.encode(BECH32_HRP_MAINNET, words);
}

function buildWitnessScript(version: number, program: Uint8Array): string {
  const versionOpcode = version === 0 ? 0x00 : 0x50 + version;
  return Buffer.concat([Buffer.from([versionOpcode, program.length]), Buffer.from(program)]).toString("hex");
}

function tryDecodeWitnessAddress(value: string): string | null {
  for (const codec of [bech32, bech32m]) {
    try {
      const decoded = codec.decode(value as `${string}1${string}`);
      if (decoded.prefix !== BECH32_HRP_MAINNET || decoded.words.length === 0) {
        continue;
      }

      const version = decoded.words[0]!;
      const program = Buffer.from(codec.fromWords(decoded.words.slice(1)));

      if (version < 0 || version > 16 || program.length < 2 || program.length > 40) {
        continue;
      }

      if (version === 0 && program.length !== 20 && program.length !== 32) {
        continue;
      }

      return buildWitnessScript(version, program);
    } catch {
      continue;
    }
  }

  return null;
}

function decodeAddressToScriptPubKeyHex(address: string): string {
  const witnessScriptHex = tryDecodeWitnessAddress(address);
  if (witnessScriptHex !== null) {
    return witnessScriptHex;
  }

  const decoded = decodeBase58Check(address);

  if (decoded.version === BASE58CHECK_P2PKH_MAINNET && decoded.payload.length === 20) {
    return `76a914${Buffer.from(decoded.payload).toString("hex")}88ac`;
  }

  if (decoded.version === BASE58CHECK_P2SH_MAINNET && decoded.payload.length === 20) {
    return `a914${Buffer.from(decoded.payload).toString("hex")}87`;
  }

  throw new Error("wallet_target_invalid_address");
}

export function renderScriptPubKeyAsAddress(scriptPubKeyHex: string): string | null {
  if (/^0014[0-9a-f]{40}$/i.test(scriptPubKeyHex)) {
    return encodeWitnessAddress(0, Buffer.from(scriptPubKeyHex.slice(4), "hex"));
  }

  if (/^0020[0-9a-f]{64}$/i.test(scriptPubKeyHex)) {
    return encodeWitnessAddress(0, Buffer.from(scriptPubKeyHex.slice(4), "hex"));
  }

  if (/^5120[0-9a-f]{64}$/i.test(scriptPubKeyHex)) {
    return encodeWitnessAddress(1, Buffer.from(scriptPubKeyHex.slice(4), "hex"));
  }

  if (/^76a914[0-9a-f]{40}88ac$/i.test(scriptPubKeyHex)) {
    return encodeBase58Check(BASE58CHECK_P2PKH_MAINNET, Buffer.from(scriptPubKeyHex.slice(6, -4), "hex"));
  }

  if (/^a914[0-9a-f]{40}87$/i.test(scriptPubKeyHex)) {
    return encodeBase58Check(BASE58CHECK_P2SH_MAINNET, Buffer.from(scriptPubKeyHex.slice(4, -2), "hex"));
  }

  return null;
}

export function normalizeBtcTarget(target: string): NormalizedBtcTarget {
  const trimmed = target.trim();

  if (trimmed === "") {
    throw new Error("wallet_target_missing");
  }

  if (trimmed.startsWith("spk:")) {
    const scriptPubKeyHex = trimmed.slice(4).toLowerCase();

    if (!/^[0-9a-f]+$/.test(scriptPubKeyHex) || scriptPubKeyHex.length % 2 !== 0) {
      throw new Error("wallet_target_invalid_script");
    }

    validateExternalScriptPubKey(Buffer.from(scriptPubKeyHex, "hex"));

    return {
      scriptPubKeyHex,
      address: renderScriptPubKeyAsAddress(scriptPubKeyHex),
      opaque: renderScriptPubKeyAsAddress(scriptPubKeyHex) === null,
    };
  }

  const scriptPubKeyHex = decodeAddressToScriptPubKeyHex(trimmed).toLowerCase();
  validateExternalScriptPubKey(Buffer.from(scriptPubKeyHex, "hex"));

  return {
    scriptPubKeyHex,
    address: trimmed,
    opaque: false,
  };
}
