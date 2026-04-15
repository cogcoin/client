import assert from "node:assert/strict";
import test from "node:test";

import {
  createBootstrapProgressForTesting,
  DEFAULT_SNAPSHOT_METADATA,
  formatProgressLineForTesting,
} from "../src/bitcoind/testing.js";

test("getblock_archive_download progress formatting shows a determinate download bar", () => {
  const progress = createBootstrapProgressForTesting("getblock_archive_download", DEFAULT_SNAPSHOT_METADATA);
  progress.downloadedBytes = 512;
  progress.totalBytes = 1024;
  progress.percent = 50;
  progress.etaSeconds = 10;

  const line = formatProgressLineForTesting(progress, null, null, 120, 0);

  assert.match(line, /^\[[█░]{20}\] 50\.00% 512 B \/ 1\.00 KB -- ETA 00:00:10/);
});

test("getblock_archive_import progress formatting shows Bitcoin height import progress", () => {
  const progress = createBootstrapProgressForTesting("getblock_archive_import", DEFAULT_SNAPSHOT_METADATA);
  progress.blocks = 945_120;
  progress.headers = 945_188;
  progress.targetHeight = 945_188;

  const line = formatProgressLineForTesting(progress, null, null, 120, 0);

  assert.equal(line, "[████████████████████] Bitcoin 945,120 / 945,188 Bitcoin Core is importing getblock archive blocks.");
});
