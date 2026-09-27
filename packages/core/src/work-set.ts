import type {
  Link,
  Resource,
  Store,
  WorkHeldItem,
  WorkItem,
  WorkLaunchReceipt,
  WorkSet,
} from "@magic/contracts";
import { copyFile, mkdir, constants, realpath, lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { evidenceFor } from "./evidence";
import { courseIncluded, courseInclusion } from "./access";
import { resolveAssignmentContext } from "./assignment-context";
import { createHash } from "node:crypto";

/** One click should not become a tab storm: the assignment plus a few materials. */
export const MAX_WORK_ITEMS = 6;

const DOCUMENT_TYPES: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.oasis.opendocument.text": ".odt",
  "application/vnd.oasis.opendocument.presentation": ".odp",
  "application/vnd.oasis.opendocument.spreadsheet": ".ods",
  "application/rtf": ".rtf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
};
function nameExtension(name: string | undefined) {
  if (!name) return "";
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}
/**
 * A saved copy opens only when local extraction read it as a document and its
 * type maps to the allowlist. Cached files are stored without a name or extension.
 */
function localCopy(resource: Resource) {
  const path = resource.document?.localPath ?? resource.file?.localPath;
  const status =
    resource.document?.extractionStatus ?? resource.file?.extractionStatus;
  if (!path || (status !== "ok" && status !== "partial")) return null;
  const mime = (resource.contentType ?? resource.file?.contentType ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  let extension = DOCUMENT_TYPES[mime];
  if (!extension)
    for (const name of [
      resource.file?.displayName,
      resource.title,
      (() => {
        try {
          return new URL(resource.url).pathname;
        } catch {
          return undefined;
        }
      })(),
    ]) {
      const candidate = nameExtension(name);
      if (OPENABLE_DOCUMENT.has(candidate)) {
        extension = candidate;
        break;
      }
    }
  return extension && OPENABLE_DOCUMENT.has(extension)
    ? { path, extension }
    : null;
}
function urlKey(url: string) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

/**
 * Rebuilds the "Start work" set from saved evidence. Only accepted links open;
 * suggested matches are listed as held so an uncertain match never looks verified.
 */
export function buildWorkSet(store: Store, id: string): WorkSet {
  const assignment = store.resource(id);
  if (!assignment || assignment.deleted)
    throw new Error("This item is no longer available.");
  if (assignment.kind !== "assignment")
    throw new Error("Start work is available for assignments.");
  if (!courseIncluded(store, assignment))
    throw new Error("This course is not currently available for prepared work.");
  const sources = new Map(store.sources().map((s) => [s.id, s]));
  const scope = (r: Resource) => sources.get(r.sourceId)?.accountScope;
  const sameCourse = (r: Resource) =>
    r.courseId === assignment.courseId && scope(r) === scope(assignment);

  const materials: WorkItem[] = [];
  const held: WorkHeldItem[] = [];
  const seen = new Set([urlKey(assignment.url)]);
  // Keep the order the assignment itself lists its materials in.
  const listed = (assignment.links ?? []).map((l) =>
    urlKey(typeof l === "string" ? l : l.url),
  );
  const position = (r: Resource) => {
    const at = listed.indexOf(urlKey(r.url));
    return at < 0 ? listed.length : at;
  };
  const supporting = evidenceFor(store).supporting(assignment);
  // Direct links the saved assignment itself lists. Links to saved resources go
  // through the evidence graph above; links on the assignment's own site (Canvas
  // navigation, other courses, unsaved pages) are never opened from here.
  const savedUrls = new Set(store.resources().map((r) => urlKey(r.url)));
  const home = (() => {
    try {
      return new URL(assignment.url).origin;
    } catch {
      return "";
    }
  })();
  const direct: { key: string; url: string; title: string; at: number }[] = [];
  (assignment.links ?? []).forEach((l, at) => {
    const pointer = typeof l === "string" ? { url: l } : l;
    let url: string;
    try {
      url = safeWebLink(pointer.url);
    } catch {
      return;
    }
    const key = urlKey(url);
    if (savedUrls.has(key) || new URL(url).origin === home) return;
    if (direct.some((d) => d.key === key)) return;
    const text = "text" in pointer ? pointer.text?.trim() : undefined;
    direct.push({ key, url, title: text || linkTitle(url), at });
  });
  const candidates = [
    ...supporting.map((r, index) => ({ r, index, at: position(r) })),
    ...direct.map((d, index) => ({ d, index: supporting.length + index, at: d.at })),
  ].sort((a, b) => a.at - b.at || a.index - b.index);
  for (const candidate of candidates) {
    if ("d" in candidate) {
      const link = candidate.d;
      if (seen.has(link.key)) continue;
      seen.add(link.key);
      const resourceId = directLinkId(assignment.id, link.key);
      if (materials.length >= MAX_WORK_ITEMS - 1) {
        held.push({ resourceId, title: link.title, reason: "Also linked; open it from the assignment detail." });
        continue;
      }
      materials.push({
        resourceId,
        title: link.title,
        role: "material",
        provenance: "assignment_link",
        reason: "Linked directly in the saved assignment. This page isn't saved in Magic, so it opens as linked.",
        target: { kind: "web", url: link.url },
      });
      continue;
    }
    const material = candidate.r;
    if (material.deleted || !sameCourse(material) || !courseIncluded(store, material)) continue;
    const key = urlKey(material.url);
    if (seen.has(key)) continue;
    seen.add(key);
    if (materials.length >= MAX_WORK_ITEMS - 1) {
      held.push({
        resourceId: material.id,
        title: material.title,
        reason: "Also linked; open it from the assignment detail.",
      });
      continue;
    }
    const copy = localCopy(material);
    const listedHere = listed.includes(key);
    materials.push({
      resourceId: material.id,
      title: material.title,
      role: "material",
      provenance: listedHere ? "assignment_link" : "supporting_evidence",
      reason: listedHere
        ? "Directly linked in the saved assignment."
        : "Connected through accepted supporting evidence; not a direct assignment link.",
      target: copy
        ? { kind: "file", ...copy, fallbackUrl: material.url }
        : { kind: "web", url: material.url },
    });
  }

  const suggested = store
    .links()
    .filter(
      (l: Link) =>
        l.status === "proposed" &&
        l.type === "specifies" &&
        l.toId === assignment.id,
    );
  for (const link of suggested) {
    const target = store.resource(link.fromId);
    if (!target || target.deleted || !sameCourse(target)) continue;
    if (materials.some((m) => m.resourceId === target.id)) continue;
    held.push({
      resourceId: target.id,
      title: target.title,
      reason: "Suggested match, not confirmed. Accept it in the detail to include it.",
    });
  }

  // Provisional same-course context (e.g. the "Lecture 7" section of the course site) is
  // shown, never opened automatically and never presented as the assignment's instructions.
  const context = resolveAssignmentContext(store, assignment.id, {
    permitted: courseInclusion(store),
  });
  for (const section of context.sections) {
    if (materials.some((m) => m.resourceId === section.resourceId)) continue;
    if (held.some((h) => h.resourceId === section.resourceId)) continue;
    held.push({
      resourceId: section.resourceId,
      title: section.title,
      reason: section.linkedToAssignment
        ? `${context.anchor} section; linked to this assignment.`
        : `Possibly related: its ${context.anchor} section. Not linked to this assignment.`,
    });
  }

  const notes: string[] = [];
  if (!materials.length)
    notes.push(
      "No accepted supporting material is available in your saved sources, so only the assignment opens.",
    );
  const instructions: WorkItem = {
    resourceId: assignment.id,
    title: assignment.title,
    role: "instructions",
    reason: "Assignment instructions and submission page.",
    target: { kind: "web", url: assignment.url },
  };
  const items = [...materials, instructions];
  const usedSources = new Set(items.map(item => store.resource(item.resourceId)?.sourceId));
  for (const sourceId of usedSources) {
    const source = sourceId ? sources.get(sourceId) : undefined;
    if (!source) continue;
    notes.push(`${source.label}: last successful refresh ${source.lastSuccessAt ?? "not recorded"}.${source.status !== "ok" || !source.complete ? ` Saved source is ${source.status === "ok" ? "incomplete" : source.status.replaceAll("_", " ")}; destinations may be out of date.` : ""}`);
  }
  const previewHash = createHash("sha256").update(JSON.stringify({
    items: items.map(item => ({ ...item, version: store.resource(item.resourceId)?.contentHash })),
    held,
    context: context.sections.map((c) => [c.resourceId, c.contentHash, c.start, c.end]),
  })).digest("hex");
  return {
    previewHash,
    assignmentId: assignment.id,
    assignmentTitle: assignment.title,
    contentHash: assignment.contentHash,
    items,
    held,
    notes,
    context,
  };
}

/** Stable ID for a direct assignment link that is not a saved resource. */
export function directLinkId(assignmentId: string, url: string) {
  return `${assignmentId}:link:${createHash("sha256").update(urlKey(url)).digest("hex").slice(0, 16)}`;
}
function linkTitle(url: string) {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.hostname}${path && path !== "/" ? path : ""}`.slice(0, 200);
}

/** Accepts only ordinary web links without embedded credentials. */
export function safeWebLink(input: unknown) {
  if (typeof input !== "string" || input.length > 2000)
    throw new Error("Invalid link.");
  const url = new URL(input);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Only ordinary web links can be opened.");
  return url.toString();
}

/** Downloaded course documents only. Executables and scripts are never opened. */
export const OPENABLE_DOCUMENT = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".odt",
  ".odp",
  ".ods",
  ".rtf",
  ".txt",
  ".md",
  ".csv",
]);

export interface WorkLaunchHost {
  openExternal(url: string, activate: boolean): Promise<void>;
  /** Resolves "" on success, an error message otherwise (Electron semantics). */
  openPath(path: string): Promise<string>;
  /** Canonical path; rejects when the file is missing. */
  realpath(path: string): Promise<string>;
  /**
   * Returns a correctly named copy of a cached file inside the document folder,
   * so the operating system picks the document's usual app.
   */
  materialize(path: string, extension: string): Promise<string>;
  /** Canonical app document cache directory. */
  documentsRoot: string;
  separator: string;
  now(): Date;
  dryRun?: boolean;
  /** Recheck current consent and reviewed identity immediately before each target. */
  beforeItem?(): Promise<void>;
}

/**
 * Re-validates every target at the boundary and opens materials in the
 * background, then the assignment in front. Failures never stop the rest.
 */
export async function launchWorkSet(
  set: WorkSet,
  host: WorkLaunchHost,
): Promise<WorkLaunchReceipt> {
  const receipt: WorkLaunchReceipt = {
    assignmentId: set.assignmentId,
    assignmentTitle: set.assignmentTitle,
    at: host.now().toISOString(),
    mode: host.dryRun ? "dry_run" : "opened",
    opened: [],
    failed: [],
    held: set.held,
    notes: [...set.notes],
  };
  const root = host.documentsRoot.endsWith(host.separator)
    ? host.documentsRoot
    : host.documentsRoot + host.separator;
  for (const item of set.items) {
    const front = item.role === "instructions";
    const openWeb = async (url: string) => {
      const safe = safeWebLink(url);
      if (!host.dryRun) await host.openExternal(safe, front);
    };
    try {
      await host.beforeItem?.();
      if (item.target.kind === "web") {
        await openWeb(item.target.url);
        receipt.opened.push({ resourceId: item.resourceId, title: item.title, via: "browser" });
        continue;
      }
      let fileError: string;
      try {
        const real = await host.realpath(item.target.path);
        if (!real.startsWith(root))
          fileError = "the saved copy is outside the app's document folder";
        else if (!OPENABLE_DOCUMENT.has(item.target.extension))
          fileError = "this file type is not opened automatically";
        else {
          fileError = host.dryRun
            ? ""
            : await host.openPath(
                await host.materialize(real, item.target.extension),
              );
          if (!fileError) {
            receipt.opened.push({ resourceId: item.resourceId, title: item.title, via: "file" });
            continue;
          }
        }
      } catch {
        fileError = "the saved copy is no longer on this device";
      }
      await openWeb(item.target.fallbackUrl);
      receipt.opened.push({ resourceId: item.resourceId, title: item.title, via: "browser_fallback" });
      receipt.notes.push(`${item.title}: opened the original because ${fileError}.`);
    } catch (error) {
      receipt.failed.push({
        resourceId: item.resourceId,
        title: item.title,
        reason: error instanceof Error ? error.message : "Could not open this item.",
      });
    }
  }
  return receipt;
}

/**
 * Cached files have no extension; a named copy lets the OS choose the usual app.
 * It stays inside the document folder, so local purge removes it too.
 */
export async function materializeCopy(
  documentsRoot: string,
  path: string,
  extension: string,
) {
  if (!OPENABLE_DOCUMENT.has(extension))
    throw new Error("This file type is not opened automatically.");
  const canonicalRoot = await realpath(documentsRoot);
  const canonicalPath = await realpath(path);
  const separator = (await import("node:path")).sep;
  if (!canonicalPath.startsWith(canonicalRoot + separator)) throw new Error("Saved copy is outside the app document folder.");
  const directory = join(canonicalRoot, ".open");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw new Error("Document opening folder must not be a symlink.");
  const target = join(directory, `${basename(path)}${extension}`);
  const existing = await lstat(target).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error("Unsafe existing document copy.");
  await copyFile(path, target, constants.COPYFILE_EXCL).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  return target;
}

/** A retry can only narrow the current reviewed set to previously failed IDs. */
export function selectWorkRetry(set: WorkSet, previewHash: string, only?: string[], failed?: ReadonlySet<string>): WorkSet {
  if (set.previewHash !== previewHash) throw new Error("Prepared work changed. Review the updated destinations before opening.");
  if (!only) return set;
  if (!only.length || only.length > MAX_WORK_ITEMS || new Set(only).size !== only.length ||
      only.some(id => !failed?.has(id) || !set.items.some(item => item.resourceId === id)))
    throw new Error("Retry only the failed items from the last launch.");
  return { ...set, items: set.items.filter(item => only.includes(item.resourceId)) };
}
