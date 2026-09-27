/**
 * Before/after listings of a student's client homes: `~/.claude`, `~/.claude.json` and `~/.codex`.
 * Names, sizes and modification times only. No file is opened, so no content and no credential
 * is ever read (Tier 2 runs this against the operator's real home).
 */
import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export interface Entry {
  path: string;
  size: number;
  mtimeMs: number;
  dir: boolean;
}
export type Snapshot = Map<string, Entry>;

/** Folders whose churn is the client's own session bookkeeping; listed by count only. */
const MAX_ENTRIES = 20_000;

async function walk(root: string, path: string, out: Snapshot): Promise<void> {
  if (out.size >= MAX_ENTRIES) return;
  let info;
  try {
    info = await lstat(path);
  } catch {
    return;
  }
  const rel = relative(root, path) || ".";
  out.set(rel, { path: rel, size: info.isDirectory() ? 0 : info.size, mtimeMs: Math.round(info.mtimeMs), dir: info.isDirectory() });
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  let names: string[] = [];
  try {
    names = await readdir(path);
  } catch {
    return;
  }
  for (const name of names) await walk(root, join(path, name), out);
}

export async function snapshotHome(home: string): Promise<Snapshot> {
  const out: Snapshot = new Map();
  for (const name of [".claude", ".claude.json", ".codex"]) await walk(home, join(home, name), out);
  return out;
}

export interface HomeDiff {
  added: string[];
  removed: string[];
  changed: string[];
}
/** Files only; a folder's mtime moves whenever a child does. */
export function diffHome(before: Snapshot, after: Snapshot): HomeDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [path, entry] of after) {
    if (entry.dir) continue;
    const old = before.get(path);
    if (!old) added.push(path);
    else if (old.size !== entry.size || old.mtimeMs !== entry.mtimeMs) changed.push(path);
  }
  for (const [path, entry] of before) if (!entry.dir && !after.has(path)) removed.push(path);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}
