import assert from "node:assert/strict";
import test from "node:test";

import { bytesToHex } from "../src/bytes.js";
import {
  FIELD_FORMAT_BYTES,
  computeRootRegistrationPriceSats,
  serializeCogClaim,
  serializeCogLock,
  serializeCogTransfer,
  serializeDataUpdate,
  serializeDomainAnchor,
  serializeDomainBuy,
  serializeDomainReg,
  serializeDomainSell,
  serializeDomainTransfer,
  serializeFieldReg,
  serializeMine,
  serializeRepCommit,
  serializeRepRevoke,
  serializeSetCanonical,
  serializeSetDelegate,
  serializeSetEndpoint,
  serializeSetMiner,
  validateDomainName,
  validateExternalScriptPubKey,
  validateFieldName,
} from "../src/wallet/cogop/index.js";

test("domain and field validators reject malformed names", () => {
  validateDomainName("weatherbot");
  validateFieldName("profile-json");

  assert.throws(() => validateDomainName("WeatherBot"), /wallet_cogop_invalid_domain_name/);
  assert.throws(() => validateDomainName("-weatherbot"), /wallet_cogop_invalid_domain_name/);
  assert.throws(() => validateDomainName("weather--bot"), /wallet_cogop_invalid_domain_name/);
  assert.throws(() => validateFieldName("bad field"), /wallet_cogop_invalid_field_name/);
});

test("scriptpubkey validation enforces the 1..67 byte bound", () => {
  validateExternalScriptPubKey(Uint8Array.of(0x51));
  assert.throws(
    () => validateExternalScriptPubKey(new Uint8Array()),
    /wallet_cogop_invalid_scriptpubkey_length/,
  );
  assert.throws(
    () => validateExternalScriptPubKey(new Uint8Array(68)),
    /wallet_cogop_invalid_scriptpubkey_length/,
  );
});

test("computeRootRegistrationPriceSats follows the fixed length tiers", () => {
  assert.equal(computeRootRegistrationPriceSats("a"), 10_000_000_000n);
  assert.equal(computeRootRegistrationPriceSats("ab"), 1_000_000_000n);
  assert.equal(computeRootRegistrationPriceSats("abc"), 100_000_000n);
  assert.equal(computeRootRegistrationPriceSats("abcd"), 10_000_000n);
  assert.equal(computeRootRegistrationPriceSats("abcde"), 1_000_000n);
  assert.equal(computeRootRegistrationPriceSats("abcdef"), 100_000n);
});

test("serializers produce exact payload shapes for representative operations", () => {
  const spk = Uint8Array.from([0x00, 0x14, ...new Uint8Array(20).fill(0xaa)]);
  const bytes32 = Uint8Array.from(new Uint8Array(32).fill(0x11));
  const sentence60 = Uint8Array.from(new Uint8Array(60).fill(0x22));

  assert.equal(
    bytesToHex(serializeMine(7, bytes32, sentence60).opReturnData),
    `434f47010000000711111111${"22".repeat(60)}`,
  );
  assert.equal(
    bytesToHex(serializeCogTransfer(123n, spk).opReturnData),
    `434f4702000000000000007b16${bytesToHex(spk)}`,
  );
  assert.equal(
    bytesToHex(serializeCogLock(123n, 456, 9, bytes32).opReturnData),
    `434f4703000000000000007b000001c800000009${"11".repeat(32)}`,
  );
  assert.equal(
    bytesToHex(serializeCogClaim(12, bytes32).opReturnData),
    `434f47040000000c${"11".repeat(32)}`,
  );
  assert.equal(
    bytesToHex(serializeDomainReg("weatherbot").opReturnData),
    "434f47050a77656174686572626f74",
  );
  assert.equal(
    bytesToHex(serializeDomainTransfer(12, spk).opReturnData),
    `434f47060000000c16${bytesToHex(spk)}`,
  );
  assert.equal(
    bytesToHex(serializeDomainSell(12, 456n).opReturnData),
    "434f47070000000c00000000000001c8",
  );
  assert.equal(
    bytesToHex(serializeDomainBuy(12, 456n).opReturnData),
    "434f47080000000c00000000000001c8",
  );
  assert.equal(
    bytesToHex(serializeFieldReg(12, true, "profile").opReturnData),
    "434f47090000000c010770726f66696c65",
  );
  assert.equal(
    bytesToHex(serializeDataUpdate(12, 33, FIELD_FORMAT_BYTES.text, new TextEncoder().encode("hi")).opReturnData),
    "434f470a0000000c00000021026869",
  );
  assert.equal(
    bytesToHex(serializeSetEndpoint(12, new TextEncoder().encode("https://cogcoin.org")).opReturnData),
    "434f470b0000000c68747470733a2f2f636f67636f696e2e6f7267",
  );
  assert.equal(
    bytesToHex(serializeRepCommit(12, 13, 99n, sentence60).opReturnData),
    `434f470c0000000c0000000d0000000000000063${"22".repeat(60)}`,
  );
  assert.equal(
    bytesToHex(serializeRepRevoke(12, 13, 99n).opReturnData),
    "434f470d0000000c0000000d0000000000000063",
  );
  assert.equal(
    bytesToHex(serializeSetCanonical(12).opReturnData),
    "434f470e0000000c",
  );
  assert.equal(
    bytesToHex(serializeDomainAnchor(12, sentence60).opReturnData),
    `434f470f0000000c${"22".repeat(60)}${"00".repeat(12)}`,
  );
  assert.equal(
    bytesToHex(serializeSetDelegate(12, spk).opReturnData),
    `434f47100000000c16${bytesToHex(spk)}`,
  );
  assert.equal(
    bytesToHex(serializeSetMiner(12, spk).opReturnData),
    `434f47110000000c16${bytesToHex(spk)}`,
  );
});

test("clear/update forms stay canonical and length-bounded", () => {
  const clearUpdate = serializeDataUpdate(1, 2, FIELD_FORMAT_BYTES.clear).opReturnData;
  const clearAnchor = serializeDomainAnchor(5).opReturnData;
  const clearDelegate = serializeSetDelegate(5).opReturnData;
  const clearMiner = serializeSetMiner(5).opReturnData;

  assert.equal(clearUpdate.length, 13);
  assert.equal(clearAnchor.length, 8);
  assert.equal(clearDelegate.length, 8);
  assert.equal(clearMiner.length, 8);
});

test("serializers reject invalid identifiers, oversize scripts, and oversize payloads", () => {
  const longValue = new Uint8Array(68);
  const spkTooLong = new Uint8Array(68);

  assert.throws(() => serializeDomainSell(0, 1n), /wallet_cogop_invalid_domain_id/);
  assert.throws(() => serializeCogTransfer(1n, spkTooLong), /wallet_cogop_invalid_scriptpubkey_length/);
  assert.throws(
    () => serializeDataUpdate(1, 2, FIELD_FORMAT_BYTES.bytes, longValue),
    /wallet_cogop_payload_out_of_range/,
  );
});
