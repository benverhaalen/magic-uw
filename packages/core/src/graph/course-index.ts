/**
 * The course index (the material pipeline): one in-memory view of a course's captured resources,
 * built by code from structured Canvas fields. It answers "which stored resource is this URL?",
 * "which module holds this item?" and "what does this module item point at?".
 *
 * Real shapes it is built for (observed on a live capture, aggregate only):
 * - module items are separate resources in a `module-items:<moduleId>` source, with no text; they
 *   point at their content by `moduleItem.pageUrl` (pages), `contentId` (files, assignments,
 *   quizzes) or `externalUrl`;
 * - page bodies live in `page:<hash>` sources; files in `files` (text only after extraction);
 * - the same assignment appears in `assignments`, `account-todo`, `account-upcoming-events`,
 *   `account-activity` and `submissions`, and as a calendar event `event-assignment-<id>`;
 * - body links are `{ url, text }` objects; `/equation_images/` and `/profile/` links are noise.
 */
import type { Resource } from "@magic/contracts";
import type { CourseCoreStore, CourseRef, GraphStore } from "../../../contracts/src/course-core";
import type { Store } from "@magic/contracts";

export type PipelineStore = Store & CourseCoreStore & GraphStore;
export type Res = Resource & { scope: string };

export function isPipelineStore(store: Store): store is PipelineStore {
  const s = store as Partial<PipelineStore>;
  return typeof s.courseResources === "function" && typeof s.putResourceRefs === "function";
}

export type ContentType = "page" | "file" | "assignment" | "quiz" | "discussion" | "announcement" | "syllabus" | "external";
export interface ModuleEntry {
  id: string;
  title: string;
  position: number;
  resourceId: string | null;
  /** Module-item resources, by position. */
  items: Res[];
}
export type Resolution =
  | { type: "resource"; resource: Res; kind: ContentType | "module" }
  | { type: "external"; url: string }
  | { type: "unresolved"; url: string; kind: ContentType | "module" }
  | { type: "ignore" };

/** Which source scope wins when the same Canvas object was captured more than once. */
const assignmentScopes = ["assignments", "quizzes", "account-todo", "account-upcoming-events", "account-activity", "submissions"];
const scopeName = (scope: string) => scope.split(":")[0]!;

export interface CourseIndex {
  course: CourseRef;
  hash: string;
  resources: Map<string, Res>;
  canvasHosts: Set<string>;
  pageBySlug: Map<string, Res>;
  fileById: Map<string, Res>;
  assignmentById: Map<string, Res>;
  quizById: Map<string, Res>;
  discussionById: Map<string, Res>;
  moduleItemById: Map<string, Res>;
  modules: Map<string, ModuleEntry>;
  /** Content resource ID → the modules whose items point at it. */
  modulesOf: Map<string, string[]>;
  syllabus: Res | undefined;
  groupTitle: Map<string, string>;
  folderTitle: Map<string, string>;
  /** The content resource a module item points at, if it was captured. */
  itemTarget(item: Res): Res | undefined;
  resolve(url: string): Resolution;
  contentType(r: Res): ContentType | undefined;
}

export function pageSlug(value: string): string {
  let slug = value;
  try {
    slug = decodeURIComponent(value);
  } catch {
    /* keep as written */
  }
  return slug.toLowerCase().replace(/[#?].*$/, "").replace(/\/+$/, "");
}

export function normaliseUrl(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.hash = "";
    url.search = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, (m) => (url.pathname === "/" ? m : ""));
  } catch {
    return undefined;
  }
}

function contentTypeOf(r: Res): ContentType | undefined {
  const scope = scopeName(r.scope);
  if (r.externalId === "syllabus" || scope === "syllabus") return "syllabus";
  if (scope === "page" || scope === "pages") return "page";
  if (scope === "files" || scope === "document" || r.document || r.file) return "file";
  if (scope === "assignments") return "assignment";
  if (scope === "quizzes") return "quiz";
  if (scope === "announcements") return "announcement";
  if (scope === "discussions") return "discussion";
  if (scope === "module-items") {
    const type = r.moduleItem?.type;
    if (type === "ExternalUrl" || type === "ExternalTool") return "external";
    if (type === "Quiz") return "quiz";
  }
  return undefined;
}

function better(scopes: string[], a: Res | undefined, b: Res): boolean {
  if (!a) return true;
  const rank = (r: Res) => {
    const i = scopes.indexOf(scopeName(r.scope));
    return i < 0 ? scopes.length : i;
  };
  return rank(b) < rank(a) || (rank(b) === rank(a) && b.text.length > a.text.length);
}

export function buildCourseIndex(course: CourseRef, hash: string, list: Res[]): CourseIndex {
  const resources = new Map(list.map((r) => [r.id, r]));
  const canvasHosts = new Set<string>(["canvas.wisc.edu"]);
  const pageBySlug = new Map<string, Res>();
  const fileById = new Map<string, Res>();
  const assignmentById = new Map<string, Res>();
  const quizById = new Map<string, Res>();
  const discussionById = new Map<string, Res>();
  const moduleItemById = new Map<string, Res>();
  const modules = new Map<string, ModuleEntry>();
  const groupTitle = new Map<string, string>();
  const folderTitle = new Map<string, string>();
  let syllabus: Res | undefined;
  const moduleEntry = (id: string): ModuleEntry => {
    let entry = modules.get(id);
    if (!entry) modules.set(id, (entry = { id, title: "", position: 0, resourceId: null, items: [] }));
    return entry;
  };
  for (const r of list) {
    const scope = scopeName(r.scope);
    try {
      const host = new URL(r.url).hostname.toLowerCase();
      if (scope !== "calendar_feed" && r.kind !== "event" && /canvas|instructure/.test(host)) canvasHosts.add(host);
    } catch {
      /* stored URLs are validated; nothing to add */
    }
    if (r.externalId === "syllabus" || scope === "syllabus") {
      if (better(["syllabus"], syllabus, r)) syllabus = r;
      continue;
    }
    if (scope === "page" || scope === "pages") {
      const match = /\/pages\/([^/?#]+)/.exec(r.url);
      if (match) {
        const slug = pageSlug(match[1]!);
        if (better(["page", "pages"], pageBySlug.get(slug), r)) pageBySlug.set(slug, r);
      }
      continue;
    }
    if (scope === "files" || scope === "document" || r.file || r.document) {
      const id = r.file?.id ?? r.file?.fileId ?? r.document?.fileId ?? /\/files\/(\d+)/.exec(r.url)?.[1] ?? r.externalId;
      if (better(["files", "document"], fileById.get(id), r)) fileById.set(id, r);
      continue;
    }
    if (scope === "module-items") {
      moduleItemById.set(r.externalId, r);
      moduleEntry(r.scope.slice("module-items:".length)).items.push(r);
      if (r.moduleItem?.type === "Quiz" && r.moduleItem.contentId) {
        if (!quizById.has(r.moduleItem.contentId)) quizById.set(r.moduleItem.contentId, r);
      }
      continue;
    }
    if (scope === "modules" && r.module) {
      const entry = moduleEntry(r.module.id ?? r.externalId);
      entry.title = r.title;
      entry.position = r.module.position ?? 0;
      entry.resourceId = r.id;
      continue;
    }
    if (scope === "assignment-groups") {
      groupTitle.set(r.externalId, r.title);
      continue;
    }
    if (scope === "folders") {
      folderTitle.set(r.externalId, r.title);
      continue;
    }
    if (scope === "quizzes") {
      quizById.set(r.externalId, r);
      continue;
    }
    if (scope === "announcements" || scope === "discussions") {
      discussionById.set(r.externalId, r);
      continue;
    }
    if (r.kind === "assignment" || (scope === "submissions" && /\/assignments\/\d+/.test(r.url))) {
      const id = r.kind === "assignment" ? r.externalId : /\/assignments\/(\d+)/.exec(r.url)![1]!;
      if (better(assignmentScopes, assignmentById.get(id), r)) assignmentById.set(id, r);
    }
  }
  for (const m of modules.values()) m.items.sort((a, b) => (a.moduleItem?.position ?? 0) - (b.moduleItem?.position ?? 0));
  // A file or page seen only as a module item (the Files or Pages list wasn't readable) is still a
  // stored resource: links to it resolve to the module item, which holds its title and URL.
  for (const item of moduleItemById.values()) {
    const mi = item.moduleItem!;
    if (mi.type === "File" && mi.contentId && !fileById.has(mi.contentId)) fileById.set(mi.contentId, item);
    if (mi.type === "Page" && mi.pageUrl && !pageBySlug.has(pageSlug(mi.pageUrl))) pageBySlug.set(pageSlug(mi.pageUrl), item);
  }

  function itemTarget(item: Res): Res | undefined {
    const mi = item.moduleItem;
    if (!mi) return undefined;
    const own = (r: Res | undefined) => (r && r.id !== item.id && scopeName(r.scope) !== "module-items" ? r : undefined);
    if (mi.type === "Page" && mi.pageUrl) return own(pageBySlug.get(pageSlug(mi.pageUrl)));
    if (mi.type === "File" && mi.contentId) return own(fileById.get(mi.contentId));
    if (mi.type === "Assignment" && mi.contentId) return assignmentById.get(mi.contentId);
    if (mi.type === "Quiz" && mi.contentId) {
      const quiz = quizById.get(mi.contentId);
      return quiz && quiz.id !== item.id ? quiz : undefined;
    }
    if (mi.type === "Discussion" && mi.contentId) return discussionById.get(mi.contentId);
    return undefined;
  }
  const modulesOf = new Map<string, string[]>();
  for (const m of modules.values())
    for (const item of m.items) {
      const target = itemTarget(item) ?? (contentTypeOf(item) ? item : undefined);
      if (!target) continue;
      const list = modulesOf.get(target.id) ?? [];
      if (!list.includes(m.id)) list.push(m.id);
      modulesOf.set(target.id, list);
    }

  function resolve(input: string): Resolution {
    const normal = normaliseUrl(input);
    if (!normal) return { type: "ignore" };
    const url = new URL(input);
    const host = url.hostname.toLowerCase();
    if (!canvasHosts.has(host)) return { type: "external", url: normal };
    const path = url.pathname.replace(/\/+$/, "");
    if (/^\/(equation_images|profile|users|conversations|accounts|login|images|media_objects_iframe)\b/.test(path))
      return { type: "ignore" };
    const m = /^\/courses\/(\d+)(\/.*)?$/.exec(path);
    if (!m) {
      const file = /^\/files\/(\d+)/.exec(path);
      if (file) {
        const r = fileById.get(file[1]!);
        return r ? { type: "resource", resource: r, kind: "file" } : { type: "unresolved", url: normal, kind: "file" };
      }
      return { type: "ignore" };
    }
    const rest = m[2] ?? "";
    const sameCourse = m[1] === course.courseId;
    const hit = (r: Res | undefined, kind: ContentType | "module"): Resolution =>
      r && sameCourse ? { type: "resource", resource: r, kind } : { type: "unresolved", url: normal, kind };
    let p: RegExpExecArray | null;
    if ((p = /^\/pages\/([^/]+)/.exec(rest))) return hit(pageBySlug.get(pageSlug(p[1]!)), "page");
    if ((p = /^\/files\/(\d+)/.exec(rest))) return hit(fileById.get(p[1]!), "file");
    if (/^\/assignments\/syllabus/.test(rest)) return hit(syllabus, "syllabus");
    if ((p = /^\/assignments\/(\d+)/.exec(rest))) return hit(assignmentById.get(p[1]!), "assignment");
    if ((p = /^\/quizzes\/(\d+)/.exec(rest))) return hit(quizById.get(p[1]!), "quiz");
    if ((p = /^\/discussion_topics\/(\d+)/.exec(rest))) return hit(discussionById.get(p[1]!), "discussion");
    if ((p = /^\/modules\/items\/(\d+)/.exec(rest))) {
      const item = sameCourse ? moduleItemById.get(p[1]!) : undefined;
      if (!item) return { type: "unresolved", url: normal, kind: "module" };
      const target = itemTarget(item);
      if (target) return { type: "resource", resource: target, kind: contentTypeOf(target) ?? "page" };
      if (item.moduleItem?.externalUrl) return resolve(item.moduleItem.externalUrl);
      return { type: "resource", resource: item, kind: contentTypeOf(item) ?? "page" };
    }
    if ((p = /^\/modules\/(\d+)/.exec(rest))) {
      const entry = sameCourse ? modules.get(p[1]!) : undefined;
      const r = entry?.resourceId ? resources.get(entry.resourceId) : undefined;
      return hit(r, "module");
    }
    if (/^\/modules$/.test(rest) && url.hash.startsWith("#module_")) {
      const entry = modules.get(url.hash.slice("#module_".length));
      const r = entry?.resourceId ? resources.get(entry.resourceId) : undefined;
      return hit(r, "module");
    }
    // Course navigation (home, grades, the file list, external tools): not a reference.
    return { type: "ignore" };
  }

  return {
    course,
    hash,
    resources,
    canvasHosts,
    pageBySlug,
    fileById,
    assignmentById,
    quizById,
    discussionById,
    moduleItemById,
    modules,
    modulesOf,
    syllabus,
    groupTitle,
    folderTitle,
    itemTarget,
    resolve,
    contentType: contentTypeOf,
  };
}

/** Course indexes by course, rebuilt when the course's inventory hash moves. */
const cache = new WeakMap<object, Map<string, CourseIndex>>();
export function courseIndex(store: PipelineStore, course: CourseRef): CourseIndex {
  const hash = store.courseInventoryHash(course);
  let byCourse = cache.get(store);
  if (!byCourse) cache.set(store, (byCourse = new Map()));
  const key = `${course.accountScope}\u0000${course.courseId}`;
  const hit = byCourse.get(key);
  if (hit && hit.hash === hash) return hit;
  const index = buildCourseIndex(course, hash, store.courseResources(course));
  byCourse.set(key, index);
  return index;
}

/** A resource's course, from its source (cached per store; refreshed when a source is new). */
const sourceCache = new WeakMap<object, Map<string, CourseRef & { scope: string }>>();
export function courseOfSource(store: Store, sourceId: string): (CourseRef & { scope: string }) | undefined {
  let map = sourceCache.get(store);
  if (!map || !map.has(sourceId)) {
    map = new Map(store.sources().map((s) => [s.id, { accountScope: s.accountScope, courseId: s.courseId, scope: s.scope }]));
    sourceCache.set(store, map);
  }
  return map.get(sourceId);
}
