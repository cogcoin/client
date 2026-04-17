import { bytesToHex, hexToBytes, reverseBytes } from "../bytes.js";

export function displayHashHexToInternalBytes(hashHex: string): Uint8Array {
  return reverseBytes(hexToBytes(hashHex));
}

export function displayHashHexToInternalHex(hashHex: string): string {
  return bytesToHex(displayHashHexToInternalBytes(hashHex));
}

export function internalBytesToDisplayHashHex(hash: Uint8Array): string {
  return bytesToHex(reverseBytes(hash));
}

export function internalHashHexToDisplayHashHex(hashHex: string): string {
  return internalBytesToDisplayHashHex(hexToBytes(hashHex));
}
