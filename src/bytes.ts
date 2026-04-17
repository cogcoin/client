const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

export function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

export function reverseBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from([...bytes].reverse());
}

export function encodeText(value: string): Uint8Array {
  return textEncoder.encode(value);
}

export function decodeText(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function encodeNullableText(value: string | null): Uint8Array {
  return encodeText(value ?? "");
}

export function decodeNullableText(bytes: Uint8Array): string | null {
  if (bytes.length === 0) {
    return null;
  }

  return decodeText(bytes);
}

export function encodeInteger(value: number): Uint8Array {
  return encodeText(String(value));
}

export function decodeInteger(bytes: Uint8Array): number {
  const decoded = Number.parseInt(decodeText(bytes), 10);

  if (!Number.isSafeInteger(decoded)) {
    throw new Error("sqlite_meta_integer_invalid");
  }

  return decoded;
}
