import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import {
  loadClientPasswordRotationJournalOrNull,
  loadClientPasswordStateOrNull,
  readLocalSecretFile,
} from "../src/wallet/state/client-password/files.js";
import { resolveLocalSecretFilePath } from "../src/wallet/state/client-password/context.js";

test("client-password files parse wrapped and raw secret formats and sanitize local secret paths", async (t) => {
  const root = await createTrackedTempDirectory(t, "cogcoin-client-password-files");
  const directoryPath = join(root, "secrets");
  await mkdir(directoryPath, { recursive: true });

  const wrappedPath = resolveLocalSecretFilePath(directoryPath, "wallet-state:wallet/root");
  const rawPath = resolveLocalSecretFilePath(directoryPath, "wallet-state:legacy");

  assert.equal(wrappedPath, join(directoryPath, "wallet-state-wallet-root.secret"));

  await writeFile(
    wrappedPath,
    `${JSON.stringify({
      format: "cogcoin-local-wallet-secret",
      version: 1,
      cipher: "aes-256-gcm",
      wrappedBy: "client-password",
      nonce: "nonce",
      tag: "tag",
      ciphertext: "ciphertext",
    }, null, 2)}\n`,
  );
  await writeFile(rawPath, `${Buffer.alloc(32, 9).toString("base64")}\n`);

  assert.deepEqual(await readLocalSecretFile(wrappedPath), {
    state: "wrapped",
    envelope: {
      format: "cogcoin-local-wallet-secret",
      version: 1,
      cipher: "aes-256-gcm",
      wrappedBy: "client-password",
      nonce: "nonce",
      tag: "tag",
      ciphertext: "ciphertext",
    },
  });
  assert.deepEqual(await readLocalSecretFile(rawPath), {
    state: "raw",
    secret: new Uint8Array(Buffer.alloc(32, 9)),
  });
});

test("client-password files return null for invalid state and rotation journal shapes", async (t) => {
  const root = await createTrackedTempDirectory(t, "cogcoin-client-password-files-invalid");
  const directoryPath = join(root, "secrets");
  await mkdir(directoryPath, { recursive: true });
  const statePath = join(directoryPath, "client-password.json");
  const journalPath = join(directoryPath, "client-password-rotation.json");

  await writeFile(statePath, `${JSON.stringify({ format: "wrong", version: 1 })}\n`);
  await writeFile(journalPath, `${JSON.stringify({ format: "wrong", version: 1 })}\n`);

  assert.equal(await loadClientPasswordStateOrNull(statePath), null);
  assert.equal(await loadClientPasswordRotationJournalOrNull(journalPath), null);

  await writeFile(statePath, "{not-json\n");
  await writeFile(journalPath, "{not-json\n");

  assert.equal(await loadClientPasswordStateOrNull(statePath), null);
  assert.equal(await loadClientPasswordRotationJournalOrNull(journalPath), null);

  const raw = await readFile(statePath, "utf8");
  assert.match(raw, /\{not-json/);
});
