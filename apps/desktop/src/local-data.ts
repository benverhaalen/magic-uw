// owner: data-ai. "Your data on this computer" on Data & AI: how much space the app's saved data
// takes. Counts the database (with its journal files) and the app's own data folders; Chromium's
// caches and the student's own files elsewhere are not counted. Sizes only cross to the renderer.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** What the app itself saves under its data folder (the same folders "Delete local data" removes). */
export const LOCAL_DATA_ENTRIES = ["workspace.sqlite", "workspace.sqlite-wal", "workspace.sqlite-shm", "documents", "courses", "mcp", "clients"] as const;

async function sizeOf(path: string): Promise<number> {
  const info = await stat(path).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) if (!entry.isSymbolicLink()) total += await sizeOf(join(path, entry.name));
  return total;
}

export async function localDataBytes(dataDir: string): Promise<number> {
  const sizes = await Promise.all(LOCAL_DATA_ENTRIES.map((name) => sizeOf(join(dataDir, name))));
  return sizes.reduce((a, b) => a + b, 0);
}
