import assert from "node:assert/strict";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  replaceFileAtomicWithRetryForTesting,
  writeFileAtomic,
} from "../src/wallet/fs/atomic.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";

function createErrnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

test("replaceFileAtomicWithRetryForTesting replaces immediately when no retry is needed", async (t) => {
  const root = await createTrackedTempDirectory(t, "cogcoin-atomic-replace");
  const tempPath = join(root, "file.txt.tmp");
  const filePath = join(root, "file.txt");
  let attempts = 0;
  let sleeps = 0;

  await writeFile(tempPath, "next", "utf8");
  await writeFile(filePath, "current", "utf8");

  await replaceFileAtomicWithRetryForTesting(tempPath, filePath, {
    platform: "linux",
    rename: async (sourcePath, destinationPath) => {
      attempts += 1;
      await rename(sourcePath, destinationPath);
    },
    sleep: async () => {
      sleeps += 1;
    },
  });

  assert.equal(attempts, 1);
  assert.equal(sleeps, 0);
  assert.equal(await readFile(filePath, "utf8"), "next");
});

test("replaceFileAtomicWithRetryForTesting retries transient Windows rename errors and then succeeds", async (t) => {
  const root = await createTrackedTempDirectory(t, "cogcoin-atomic-retry");
  const tempPath = join(root, "file.txt.tmp");
  const filePath = join(root, "file.txt");
  let attempts = 0;
  let sleeps = 0;
  let nowUnixMs = 0;

  await writeFile(tempPath, "next", "utf8");
  await writeFile(filePath, "current", "utf8");

  await replaceFileAtomicWithRetryForTesting(tempPath, filePath, {
    platform: "win32",
    rename: async (sourcePath, destinationPath) => {
      attempts += 1;
      if (attempts < 3) {
        throw createErrnoError("EPERM");
      }
      await rename(sourcePath, destinationPath);
    },
    sleep: async () => {
      sleeps += 1;
      nowUnixMs += 25;
    },
    now: () => nowUnixMs,
  });

  assert.equal(attempts, 3);
  assert.equal(sleeps, 2);
  assert.equal(await readFile(filePath, "utf8"), "next");
});

test("replaceFileAtomicWithRetryForTesting does not retry non-transient Windows rename errors", async (t) => {
  const root = await createTrackedTempDirectory(t, "cogcoin-atomic-nonretry");
  const tempPath = join(root, "file.txt.tmp");
  const filePath = join(root, "file.txt");
  let attempts = 0;
  let sleeps = 0;

  await writeFile(tempPath, "next", "utf8");
  await writeFile(filePath, "current", "utf8");

  await assert.rejects(
    async () => replaceFileAtomicWithRetryForTesting(tempPath, filePath, {
      platform: "win32",
      rename: async () => {
        attempts += 1;
        throw createErrnoError("ENOENT");
      },
      sleep: async () => {
        sleeps += 1;
      },
      now: () => 0,
    }),
    /ENOENT/,
  );

  assert.equal(attempts, 1);
  assert.equal(sleeps, 0);
});

test("writeFileAtomic preserves the destination and cleans the temp file when Windows retries exhaust", async (t) => {
  const root = await createTrackedTempDirectory(t, "cogcoin-atomic-exhaust");
  const filePath = join(root, "file.txt");
  let attempts = 0;
  let sleeps = 0;
  let nowUnixMs = 0;

  await writeFile(filePath, "current", "utf8");

  await assert.rejects(
    async () => writeFileAtomic(filePath, "next", {}, {
      platform: "win32",
      rename: async () => {
        attempts += 1;
        throw createErrnoError("EPERM");
      },
      rm,
      sleep: async () => {
        sleeps += 1;
        nowUnixMs += 25;
      },
      now: () => nowUnixMs,
    }),
    /EPERM/,
  );

  assert.equal(await readFile(filePath, "utf8"), "current");
  assert.ok(attempts >= 2);
  assert.ok(sleeps >= 1);
  assert.deepEqual(
    (await readdir(root)).filter((entry) => entry.includes(".tmp-")),
    [],
  );
});
