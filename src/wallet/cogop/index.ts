import {
  COG_OPCODES,
  COG_PREFIX,
  FIELD_FORMAT_BYTES,
  MAX_OP_RETURN_BYTES,
  MIN_OP_RETURN_BYTES,
} from "./constants.js";
import { writeU8, writeU32BE, writeU64BE } from "./numeric.js";
import { validateExternalScriptPubKey, writeLenPrefixedSpk } from "./scriptpubkey.js";
import { validateDomainName, validateFieldName } from "./validate-name.js";

export type ScriptPubKey = Uint8Array;
export type Bytes32 = Uint8Array;
export type Coglex60 = Uint8Array;
export type OpReturnPayload = Uint8Array;

export interface SerializerResult {
  opReturnData: Uint8Array;
}

function concatParts(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

function ensureIdentifier(value: number, errorCode: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new Error(errorCode);
  }
}

function ensureBytes32(value: Uint8Array, errorCode: string): void {
  if (value.length !== 32) {
    throw new Error(errorCode);
  }
}

function ensureSentence60(value: Uint8Array, errorCode: string): void {
  if (value.length !== 60) {
    throw new Error(errorCode);
  }
}

function ensurePayloadLength(payload: Uint8Array): Uint8Array {
  if (payload.length < MIN_OP_RETURN_BYTES || payload.length > MAX_OP_RETURN_BYTES) {
    throw new Error("wallet_cogop_payload_out_of_range");
  }

  return payload;
}

function writeAsciiName(name: string, validator: (value: string) => void): Uint8Array {
  validator(name);
  return new TextEncoder().encode(name);
}

function createPayload(opcode: number, ...parts: Uint8Array[]): Uint8Array {
  return ensurePayloadLength(concatParts([COG_PREFIX, writeU8(opcode), ...parts]));
}

export function computeRootRegistrationPriceSats(rootName: string): bigint {
  validateDomainName(rootName);

  switch (rootName.length) {
    case 1:
      return 10_000_000_000n;
    case 2:
      return 1_000_000_000n;
    case 3:
      return 100_000_000n;
    case 4:
      return 10_000_000n;
    case 5:
      return 1_000_000n;
    default:
      return 100_000n;
  }
}

export function serializeMine(
  domainId: number,
  referencedBlockHashInternal: Bytes32,
  sentence60: Coglex60,
  minerData?: Uint8Array,
): SerializerResult {
  ensureIdentifier(domainId, "wallet_cogop_invalid_domain_id");
  ensureBytes32(referencedBlockHashInternal, "wallet_cogop_invalid_block_hash");
  ensureSentence60(sentence60, "wallet_cogop_invalid_sentence");

  if (minerData !== undefined && minerData.length > 8) {
    throw new Error("wallet_cogop_invalid_miner_data_length");
  }

  return {
    opReturnData: createPayload(
      COG_OPCODES.MINE,
      writeU32BE(domainId),
      referencedBlockHashInternal.slice(0, 4),
      sentence60,
      minerData ?? new Uint8Array(),
    ),
  };
}

export function serializeCogTransfer(amount: bigint, recipientSpk: ScriptPubKey): SerializerResult {
  if (amount <= 0n) {
    throw new Error("wallet_cogop_invalid_amount");
  }

  return {
    opReturnData: createPayload(
      COG_OPCODES.COG_TRANSFER,
      writeU64BE(amount),
      writeLenPrefixedSpk(recipientSpk),
    ),
  };
}

export function serializeCogLock(
  amount: bigint,
  timeoutHeight: number,
  recipientDomainId: number,
  condition32: Bytes32,
): SerializerResult {
  if (amount <= 0n) {
    throw new Error("wallet_cogop_invalid_amount");
  }

  ensureIdentifier(recipientDomainId, "wallet_cogop_invalid_domain_id");
  ensureBytes32(condition32, "wallet_cogop_invalid_condition");

  return {
    opReturnData: createPayload(
      COG_OPCODES.COG_LOCK,
      writeU64BE(amount),
      writeU32BE(timeoutHeight),
      writeU32BE(recipientDomainId),
      condition32,
    ),
  };
}

export function serializeCogClaim(lockId: number, preimage32: Bytes32): SerializerResult {
  ensureIdentifier(lockId, "wallet_cogop_invalid_lock_id");
  ensureBytes32(preimage32, "wallet_cogop_invalid_preimage");

  return {
    opReturnData: createPayload(
      COG_OPCODES.COG_CLAIM,
      writeU32BE(lockId),
      preimage32,
    ),
  };
}

export function serializeDomainReg(name: string): SerializerResult {
  const asciiName = writeAsciiName(name, validateDomainName);

  return {
    opReturnData: createPayload(
      COG_OPCODES.DOMAIN_REG,
      writeU8(asciiName.length),
      asciiName,
    ),
  };
}

export function serializeDomainTransfer(domainId: number, recipientSpk: ScriptPubKey): SerializerResult {
  ensureIdentifier(domainId, "wallet_cogop_invalid_domain_id");

  return {
    opReturnData: createPayload(
      COG_OPCODES.DOMAIN_TRANSFER,
      writeU32BE(domainId),
      writeLenPrefixedSpk(recipientSpk),
    ),
  };
}

export function serializeDomainSell(domainId: number, listedPrice: bigint): SerializerResult {
  ensureIdentifier(domainId, "wallet_cogop_invalid_domain_id");
  if (listedPrice < 0n) {
    throw new Error("wallet_cogop_invalid_amount");
  }

  return {
    opReturnData: createPayload(
      COG_OPCODES.DOMAIN_SELL,
      writeU32BE(domainId),
      writeU64BE(listedPrice),
    ),
  };
}

export function serializeDomainBuy(domainId: number, expectedPrice: bigint): SerializerResult {
  ensureIdentifier(domainId, "wallet_cogop_invalid_domain_id");
  if (expectedPrice <= 0n) {
    throw new Error("wallet_cogop_invalid_amount");
  }

  return {
    opReturnData: createPayload(
      COG_OPCODES.DOMAIN_BUY,
      writeU32BE(domainId),
      writeU64BE(expectedPrice),
    ),
  };
}

export function serializeFieldReg(parentDomainId: number, permanent: boolean, fieldName: string): SerializerResult {
  ensureIdentifier(parentDomainId, "wallet_cogop_invalid_domain_id");
  const asciiName = writeAsciiName(fieldName, validateFieldName);

  return {
    opReturnData: createPayload(
      COG_OPCODES.FIELD_REG,
      writeU32BE(parentDomainId),
      writeU8(permanent ? 0x01 : 0x00),
      writeU8(asciiName.length),
      asciiName,
    ),
  };
}

export function serializeDataUpdate(
  domainId: number,
  fieldId: number,
  format: number,
  value?: Uint8Array,
): SerializerResult {
  ensureIdentifier(domainId, "wallet_cogop_invalid_domain_id");
  ensureIdentifier(fieldId, "wallet_cogop_invalid_field_id");

  if (!Number.isInteger(format) || format < 0 || format > 0xff) {
    throw new Error("wallet_cogop_invalid_format");
  }

  if (format === FIELD_FORMAT_BYTES.clear) {
    return {
      opReturnData: createPayload(
        COG_OPCODES.DATA_UPDATE,
        writeU32BE(domainId),
        writeU32BE(fieldId),
        writeU8(format),
      ),
    };
  }

  if (value === undefined || value.length === 0) {
    throw new Error("wallet_cogop_missing_value");
  }

  return {
    opReturnData: createPayload(
      COG_OPCODES.DATA_UPDATE,
      writeU32BE(domainId),
      writeU32BE(fieldId),
      writeU8(format),
      value,
    ),
  };
}

export function serializeSetEndpoint(domainId: number, endpoint?: Uint8Array): SerializerResult {
  ensureIdentifier(domainId, "wallet_cogop_invalid_domain_id");

  return {
    opReturnData: createPayload(
      COG_OPCODES.SET_ENDPOINT,
      writeU32BE(domainId),
      endpoint ?? new Uint8Array(),
    ),
  };
}

export function serializeRepCommit(
  sourceDomainId: number,
  targetDomainId: number,
  amount: bigint,
  review60?: Coglex60,
): SerializerResult {
  ensureIdentifier(sourceDomainId, "wallet_cogop_invalid_domain_id");
  ensureIdentifier(targetDomainId, "wallet_cogop_invalid_domain_id");
  if (amount <= 0n) {
    throw new Error("wallet_cogop_invalid_amount");
  }
  if (review60 !== undefined) {
    ensureSentence60(review60, "wallet_cogop_invalid_review");
  }

  return {
    opReturnData: createPayload(
      COG_OPCODES.REP_COMMIT,
      writeU32BE(sourceDomainId),
      writeU32BE(targetDomainId),
      writeU64BE(amount),
      review60 ?? new Uint8Array(),
    ),
  };
}

export function serializeRepRevoke(
  sourceDomainId: number,
  targetDomainId: number,
  amount: bigint,
  review60?: Coglex60,
): SerializerResult {
  ensureIdentifier(sourceDomainId, "wallet_cogop_invalid_domain_id");
  ensureIdentifier(targetDomainId, "wallet_cogop_invalid_domain_id");
  if (amount <= 0n) {
    throw new Error("wallet_cogop_invalid_amount");
  }
  if (review60 !== undefined) {
    ensureSentence60(review60, "wallet_cogop_invalid_review");
  }

  return {
    opReturnData: createPayload(
      COG_OPCODES.REP_REVOKE,
      writeU32BE(sourceDomainId),
      writeU32BE(targetDomainId),
      writeU64BE(amount),
      review60 ?? new Uint8Array(),
    ),
  };
}

export function serializeSetCanonical(domainId: number): SerializerResult {
  ensureIdentifier(domainId, "wallet_cogop_invalid_domain_id");

  return {
    opReturnData: createPayload(COG_OPCODES.SET_CANONICAL, writeU32BE(domainId)),
  };
}

export function serializeDomainAnchor(domainId: number, foundingMessage60?: Coglex60): SerializerResult {
  ensureIdentifier(domainId, "wallet_cogop_invalid_domain_id");

  if (foundingMessage60 === undefined) {
    return {
      opReturnData: createPayload(COG_OPCODES.DOMAIN_ANCHOR, writeU32BE(domainId)),
    };
  }

  ensureSentence60(foundingMessage60, "wallet_cogop_invalid_founding_message");

  return {
    opReturnData: createPayload(
      COG_OPCODES.DOMAIN_ANCHOR,
      writeU32BE(domainId),
      foundingMessage60,
      new Uint8Array(12),
    ),
  };
}

export function serializeSetDelegate(domainId: number, delegateSpk?: ScriptPubKey): SerializerResult {
  ensureIdentifier(domainId, "wallet_cogop_invalid_domain_id");

  return {
    opReturnData: createPayload(
      COG_OPCODES.SET_DELEGATE,
      writeU32BE(domainId),
      delegateSpk === undefined ? new Uint8Array() : writeLenPrefixedSpk(delegateSpk),
    ),
  };
}

export function serializeSetMiner(domainId: number, minerSpk?: ScriptPubKey): SerializerResult {
  ensureIdentifier(domainId, "wallet_cogop_invalid_domain_id");

  return {
    opReturnData: createPayload(
      COG_OPCODES.SET_MINER,
      writeU32BE(domainId),
      minerSpk === undefined ? new Uint8Array() : writeLenPrefixedSpk(minerSpk),
    ),
  };
}

export {
  concatParts,
  FIELD_FORMAT_BYTES,
  validateDomainName,
  validateExternalScriptPubKey,
  validateFieldName,
  writeAsciiName,
  writeLenPrefixedSpk,
  writeU8,
  writeU32BE,
  writeU64BE,
};
