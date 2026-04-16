import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readPortableWalletArchive,
  writePortableWalletArchive,
} from "../src/wallet/archive.js";
import { createPortableArchivePayload } from "./current-model-helpers.js";

test("portable wallet archive round-trips schema 4 payloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cogcoin-archive-"));
  const path = join(dir, "wallet.cogcoin");
  const payload = createPortableArchivePayload();

  await writePortableWalletArchive(path, payload, "passphrase");
  const loaded = await readPortableWalletArchive(path, "passphrase");

  assert.equal(loaded.schemaVersion, 4);
  assert.equal(loaded.expected.walletAddress, payload.expected.walletAddress);
  assert.equal(loaded.expected.walletScriptPubKeyHex, payload.expected.walletScriptPubKeyHex);
});

test("portable wallet archive preserves historical local scripts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cogcoin-archive-"));
  const path = join(dir, "wallet.cogcoin");
  const payload = createPortableArchivePayload({
    localScriptPubKeyHexes: ["0014" + "22".repeat(20)],
  });

  await writePortableWalletArchive(path, payload, "passphrase");
  const loaded = await readPortableWalletArchive(path, "passphrase");

  assert.deepEqual(loaded.localScriptPubKeyHexes, [
    "0014" + "11".repeat(20),
    "0014" + "22".repeat(20),
  ]);
});
