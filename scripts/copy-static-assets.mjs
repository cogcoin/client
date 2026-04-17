import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), "..");

const STATIC_ASSETS = [
  ["src/writing_quotes.json", "writing_quotes.json"],
  ["src/art/banner.txt", "art/banner.txt"],
  ["src/art/balance.txt", "art/balance.txt"],
  ["src/art/scroll.txt", "art/scroll.txt"],
  ["src/art/train-smoke.txt", "art/train-smoke.txt"],
  ["src/art/train.txt", "art/train.txt"],
  ["src/art/train-car.txt", "art/train-car.txt"],
  ["src/art/wallet.txt", "art/wallet.txt"],
  ["src/art/welcome.txt", "art/welcome.txt"],
];

export function resolveStaticAssetOutputRoot(mode) {
  if (mode === "build") {
    return join(PROJECT_ROOT, "dist");
  }

  if (mode === "test") {
    return join(PROJECT_ROOT, ".test-dist", "src");
  }

  throw new Error(`static_asset_copy_mode_invalid_${mode ?? "missing"}`);
}

export async function copyStaticAssets(outputRoot) {
  await Promise.all(
    STATIC_ASSETS.map(async ([sourceRelativePath, destinationRelativePath]) => {
      const sourcePath = join(PROJECT_ROOT, sourceRelativePath);
      const destinationPath = join(outputRoot, destinationRelativePath);
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  await copyStaticAssets(resolveStaticAssetOutputRoot(process.argv[2]));
}
