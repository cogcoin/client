import { MAX_SCRIPT_PUBKEY_BYTES, MIN_SCRIPT_PUBKEY_BYTES } from "./constants.js";

export function validateExternalScriptPubKey(spk: Uint8Array): void {
  if (spk.length < MIN_SCRIPT_PUBKEY_BYTES || spk.length > MAX_SCRIPT_PUBKEY_BYTES) {
    throw new Error("wallet_cogop_invalid_scriptpubkey_length");
  }
}

export function writeLenPrefixedSpk(spk: Uint8Array): Uint8Array {
  validateExternalScriptPubKey(spk);
  const out = new Uint8Array(1 + spk.length);
  out[0] = spk.length;
  out.set(spk, 1);
  return out;
}
