export function writeU8(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error("wallet_cogop_invalid_u8");
  }

  return Uint8Array.of(value);
}

export function writeU32BE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error("wallet_cogop_invalid_u32");
  }

  const bytes = new Uint8Array(4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(0, value, false);
  return bytes;
}

export function writeU64BE(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new Error("wallet_cogop_invalid_u64");
  }

  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setBigUint64(0, value, false);
  return bytes;
}
