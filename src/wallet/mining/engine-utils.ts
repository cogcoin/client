import { createHash } from "node:crypto";

import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english.js";

export function resolveBip39WordsFromIndices(indices: readonly number[] | null | undefined): readonly string[] {
  if (indices === null || indices === undefined) {
    return [];
  }

  const words: string[] = [];
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= englishWordlist.length) {
      continue;
    }

    words.push(englishWordlist[index]!);
  }

  return words;
}

export function rootDomain(name: string): boolean {
  return !name.includes("-");
}

function uint32BigEndian(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

export function getBlockRewardCogtoshi(height: number): bigint {
  const halvingEra = Math.floor(height / 210_000);

  if (halvingEra >= 33) {
    return 0n;
  }

  return 5_000_000_000n >> BigInt(halvingEra);
}

export function deriveMiningWordIndices(referencedBlockhash: Uint8Array, miningDomainId: number): number[] {
  const seed = createHash("sha256")
    .update(Buffer.from(referencedBlockhash))
    .update(uint32BigEndian(miningDomainId))
    .digest();
  const indices: number[] = [];

  for (let index = 0; index < 5; index += 1) {
    const chunkOffset = index * 4;
    let wordIndex = seed.readUInt32BE(chunkOffset) % 2048;

    while (indices.includes(wordIndex)) {
      wordIndex = (wordIndex + 1) % 2048;
    }

    indices.push(wordIndex);
  }

  return indices;
}

export function numberToSats(value: number | string): bigint {
  const text = typeof value === "number" ? value.toFixed(8) : value;
  const match = /^(-?)(\d+)(?:\.(\d{0,8}))?$/.exec(text.trim());

  if (match == null) {
    throw new Error(`mining_invalid_amount_${text}`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  const fraction = BigInt((match[3] ?? "").padEnd(8, "0"));
  return sign * ((whole * 100_000_000n) + fraction);
}

export function compareLexicographically(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index]! < right[index]! ? -1 : 1;
    }
  }

  if (left.length === right.length) {
    return 0;
  }

  return left.length < right.length ? -1 : 1;
}

export function tieBreakHash(blendSeed: Uint8Array, miningDomainId: number): Uint8Array {
  return createHash("sha256")
    .update(Buffer.from(blendSeed))
    .update(uint32BigEndian(miningDomainId))
    .digest();
}
