import { readFile } from "node:fs/promises";

export async function readPackageVersionFromDisk(): Promise<string> {
  try {
    const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : null;

    if (code === "ENOENT") {
      return "0.0.0";
    }

    throw error;
  }
}
