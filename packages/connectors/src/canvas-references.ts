import type { Resource } from "@magic/contracts";

/** Parse identity only. Body URLs never provide download authority. */
export function canvasFileId(
  input: string,
  origin: string,
  courseId: string,
): string | undefined {
  try {
    const url = new URL(input, origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      /%2f|%5c|%2e/i.test(url.pathname)
    )
      return;
    const match =
      /^\/(?:courses\/([1-9]\d{0,29})\/)?files\/([1-9]\d{0,29})(?:\/(?:download|preview))?\/?$/.exec(
        url.pathname,
      );
    if (match && (!match[1] || match[1] === courseId)) return match[2];
  } catch {
    /* Not a Canvas reference. */
  }
}
export function referencedFileIds(
  resource: Resource,
  origin: string,
): string[] {
  const ids = new Set<string>();
  if (resource.file?.id && !resource.document) ids.add(resource.file.id);
  if (resource.moduleItem?.type === "File" && resource.moduleItem.contentId)
    ids.add(resource.moduleItem.contentId);
  for (const link of resource.links ?? []) {
    const id = canvasFileId(
      typeof link === "string" ? link : link.url,
      origin,
      resource.courseId,
    );
    if (id) ids.add(id);
  }
  return [...ids];
}
/** Explicit upcoming-work relationships propagate through pages; no semantic relevance inference. */
export function urgentFileIds(
  resources: Resource[],
  origin: string,
  now: number,
): Set<string> {
  const visited = new Set<string>(),
    files = new Set<string>();
  const queue = resources.filter(
    (r) =>
      r.dueAt &&
      Date.parse(r.dueAt) >= now - 7 * 86400000 &&
      Date.parse(r.dueAt) <= now + 14 * 86400000,
  );
  const byUrl = new Map(resources.map((r) => [r.url, r]));
  for (let i = 0; i < queue.length && i < 4000; i++) {
    const row = queue[i]!;
    if (visited.has(row.id)) continue;
    visited.add(row.id);
    for (const id of referencedFileIds(row, origin)) files.add(id);
    for (const link of row.links ?? []) {
      const next = byUrl.get(typeof link === "string" ? link : link.url);
      if (next && !visited.has(next.id)) queue.push(next);
    }
  }
  return files;
}
