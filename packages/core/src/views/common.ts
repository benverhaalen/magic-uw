/**
 * Shared pieces of the three page views (owner: page-views): the course-scoped store, evidence,
 * open actions, freshness, deadline claims and names. Everything here reads; nothing calls a model.
 *
 * Latency: `store.resources()` decodes the whole workspace (about 110 ms on a live-shaped copy),
 * so no view calls it. Each view works on one course through the pipeline's cached `courseIndex`,
 * and hands the course-scoped reuse targets (course inclusion, the notes scaffold, the analytics
 * references port) a store whose `resources()` is that course only.
 */
import { createHash } from "node:crypto";
import type {
  CourseRef,
  DeadlineEvidenceClaim,
  NoteSummary,
  PageEvidence,
  PageFreshness,
  PageOpen,
  PageOrigin,
  PageResource,
  Resource,
  SourceHealth,
  Store,
  UnresolvedDeadlineMention,
} from "@magic/contracts";
import { identifiersIn } from "@magic/domain";
import { courseInclusion } from "../access";
import { proseDeadlines } from "../deadline-evidence";
import { classifyRole } from "../graph/analyze";
import { courseIndex, courseOfSource, isPipelineStore, normaliseUrl, type CourseIndex, type PipelineStore, type Res } from "../graph/course-index";
import { classifyHost } from "../../../connectors/src/space-hosts";
import type { LearningStore } from "../../../learning/src/store";
import type { SqlNotesStore } from "../../../notes/src/sql-store";

export type ViewStore = PipelineStore & { learning?: LearningStore; notes?: SqlNotesStore };

export class PageViewError extends Error {}

/** One request's reads: sources once, and the course's index (cached by the pipeline). */
export interface ViewContext {
  store: ViewStore;
  now: string;
  sources: Map<string, SourceHealth>;
  course: CourseRef;
  index: CourseIndex;
  courseName: string;
  courseUrl: string | null;
  /** The course's resources only; `sources()` answers from this request's read. */
  scoped: ViewStore;
  /** A long-lived course-only store (per index) for reuse targets that cache by store object. */
  courseStore: ViewStore;
}

const courseStores = new WeakMap<CourseIndex, ViewStore>();
/** A store whose `resources()` (with no search) is one course's live resources. */
function courseOnly(store: ViewStore, index: CourseIndex): ViewStore {
  let scoped = courseStores.get(index);
  if (!scoped) {
    const list = [...index.resources.values()] as Resource[];
    scoped = Object.assign(Object.create(store) as ViewStore, {
      resources: (search?: string) => (search === undefined ? list : store.resources(search)),
    });
    courseStores.set(index, scoped);
  }
  return scoped;
}

interface RequestMemo {
  hash: Map<string, string>;
  resource: Map<string, Resource | undefined>;
  sources?: SourceHealth[];
  intelligence?: ReturnType<Store["courseIntelligence"]>;
}
const views = new WeakMap<Store, { view: ViewStore; memo: RequestMemo }>();
/**
 * The store a page reads through: one object per workspace store (so the pipeline's per-store caches
 * hit), whose inventory hashes, sources, resources and course profiles are read once per request.
 * Every call starts a new request: a page never sees the previous page's reads.
 */
export function viewStore(store: Store): ViewStore {
  if (!isPipelineStore(store)) throw new PageViewError("Page views need the course graph store.");
  const base = store as ViewStore;
  let entry = views.get(store);
  if (!entry) {
    const memo: RequestMemo = { hash: new Map(), resource: new Map() };
    const view = Object.assign(Object.create(base) as ViewStore, {
      courseInventoryHash(course: CourseRef) {
        const key = `${course.accountScope}\u0000${course.courseId}`;
        let hash = memo.hash.get(key);
        if (hash === undefined) memo.hash.set(key, (hash = base.courseInventoryHash(course)));
        return hash;
      },
      sources: () => (memo.sources ??= base.sources()),
      resource(id: string) {
        if (!memo.resource.has(id)) memo.resource.set(id, base.resource(id));
        return memo.resource.get(id);
      },
      courseIntelligence: () => (memo.intelligence ??= base.courseIntelligence()),
    });
    entry = { view, memo };
    views.set(store, entry);
  }
  entry.memo.hash.clear();
  entry.memo.resource.clear();
  entry.memo.sources = undefined;
  entry.memo.intelligence = undefined;
  return entry.view;
}

export function contextFor(store: ViewStore, course: CourseRef, now: string, sourcesList?: SourceHealth[]): ViewContext {
  const list = sourcesList ?? store.sources();
  const sources = new Map(list.map((s) => [s.id, s]));
  const index = courseIndex(store, course);
  const courseStore = courseOnly(store, index);
  const scoped = Object.assign(Object.create(courseStore) as ViewStore, { sources: () => list });
  const courseRes = [...index.resources.values()].find((r) => r.kind === "course");
  const any = courseRes ?? index.resources.values().next().value;
  const url = courseRes?.url ?? (any ? (/^(https:\/\/[^/]+\/courses\/[^/?#]+)/.exec(any.url)?.[1] ?? null) : null);
  return {
    store,
    now,
    sources,
    course,
    index,
    courseName: any?.courseName ?? course.courseId,
    courseUrl: url,
    scoped,
    courseStore,
  };
}

/** The course of a resource ID, or a page-view error the renderer can show. */
export function courseOf(store: ViewStore, resourceId: string): { course: CourseRef; resource: Resource } {
  const r = store.resource(resourceId);
  if (!r || r.deleted) throw new PageViewError("This item is no longer available.");
  const c = courseOfSource(store, r.sourceId);
  if (!c) throw new PageViewError("This item's course isn't known.");
  return { course: { accountScope: c.accountScope, courseId: c.courseId }, resource: r };
}

/** Course inclusion (term filter, access, overrides, selection) over this course's resources only. */
export function included(ctx: ViewContext): (r: Resource) => boolean {
  return courseInclusion(ctx.scoped);
}

const scopeName = (scope: string) => scope.split(":")[0]!;
export function originOf(ctx: ViewContext, r: Resource): PageOrigin {
  if (r.mail) return "mail";
  const scope = scopeName((r as Res).scope ?? ctx.sources.get(r.sourceId)?.scope ?? "");
  if (r.externalId === "syllabus" || scope === "syllabus") return "syllabus";
  if (scope === "announcements") return "announcement";
  if (scope === "discussions") return "page";
  if (scope === "calendar_feed" || r.calendar) return "calendar";
  if (scope === "assignment-groups" || scope === "assignments" || scope === "quizzes") return "canvas";
  if (scope === "module-items") return "module";
  if (scope === "files" || scope === "document" || r.file || r.document) return "file";
  if (r.kind === "assignment") return "canvas";
  return "page";
}

const httpsUrl = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
};

/** Evidence builders: every quote is a literal slice or the structured value code read. */
export function textEvidence(ctx: ViewContext, r: Resource, start: number, end: number, statedAt: string | null = null): PageEvidence | null {
  if (start < 0 || end > r.text.length || end <= start) return null;
  return {
    resourceId: r.id,
    source: r.title,
    origin: originOf(ctx, r),
    url: httpsUrl(r.url),
    quote: r.text.slice(start, end),
    basis: "text",
    field: null,
    start,
    end,
    statedAt,
  };
}
export function titleEvidence(ctx: ViewContext, r: Resource, start = 0, end = r.title.length): PageEvidence {
  return {
    resourceId: r.id,
    source: r.title,
    origin: originOf(ctx, r),
    url: httpsUrl(r.url),
    quote: r.title.slice(start, end),
    basis: "title",
    field: "title",
    start,
    end,
    statedAt: null,
  };
}
export function fieldEvidence(ctx: ViewContext, r: Resource | null, field: string, value: unknown, origin?: PageOrigin, source?: string): PageEvidence {
  return {
    resourceId: r?.id ?? null,
    source: source ?? r?.title ?? field,
    origin: origin ?? (r ? originOf(ctx, r) : "canvas"),
    url: httpsUrl(r?.url),
    quote: typeof value === "string" ? value : JSON.stringify(value),
    basis: "field",
    field,
    start: null,
    end: null,
    statedAt: null,
  };
}
export function structureEvidence(ctx: ViewContext, r: Resource | null, field: string, quote: string, origin?: PageOrigin): PageEvidence {
  return { ...fieldEvidence(ctx, r, field, quote, origin), basis: "structure" };
}
/** The first line of `r.text` that matches, as text evidence (the line, trimmed, ≤300 chars). */
export function lineEvidence(ctx: ViewContext, r: Resource, test: (line: string) => boolean, statedAt: string | null = null): PageEvidence | null {
  let at = 0;
  for (const line of r.text.split("\n")) {
    if (test(line)) {
      const lead = line.length - line.trimStart().length;
      const trimmed = line.trim().slice(0, 300);
      return textEvidence(ctx, r, at + lead, at + lead + trimmed.length, statedAt);
    }
    at += line.length + 1;
  }
  return null;
}
/** Evidence for an exact substring of `r.text` (first occurrence), else null. */
export function quoteEvidence(ctx: ViewContext, r: Resource, quote: string, statedAt: string | null = null): PageEvidence | null {
  const q = quote.trim();
  if (!q) return null;
  const at = r.text.indexOf(q);
  return at < 0 ? null : textEvidence(ctx, r, at, at + q.length, statedAt);
}

const ltiCache = new WeakMap<CourseIndex, Set<string>>();
/** The launch URLs of the course's Canvas tool (ExternalTool) module items: never opened directly. */
export function ltiUrls(ctx: ViewContext): Set<string> {
  let set = ltiCache.get(ctx.index);
  if (!set) {
    set = new Set<string>();
    for (const item of ctx.index.moduleItemById.values())
      if (item.moduleItem?.type === "ExternalTool") {
        const key = item.moduleItem.externalUrl ? normaliseUrl(item.moduleItem.externalUrl) : undefined;
        if (key) set.add(key);
        const own = normaliseUrl(item.url);
        if (own) set.add(own);
      }
    ltiCache.set(ctx.index, set);
  }
  return set;
}

/** How the student opens an item. The app never launches an LTI tool (D32): it points at Canvas. */
export function openFor(ctx: ViewContext, r: Resource | null, url: string | null = r?.url ?? null): PageOpen {
  const safe = httpsUrl(url);
  const key = safe ? normaliseUrl(safe) : undefined;
  const lti =
    (key !== undefined && ltiUrls(ctx).has(key)) ||
    r?.moduleItem?.type === "ExternalTool" ||
    (safe ? /\/external_tools\//.test(new URL(safe).pathname) : false) ||
    (safe ? classifyHost(new URL(safe).hostname).rule.route === "lti_launch" : false);
  if (lti) {
    const rule = safe ? classifyHost(new URL(safe).hostname).rule : null;
    if (rule?.openable === false)
      return { how: "none", url: null, resourceId: r?.id ?? null, note: rule.launchEffect ?? "Open it from Canvas when you need it." };
    return {
      how: "canvas",
      url: ctx.courseUrl ? `${ctx.courseUrl}/modules` : null,
      resourceId: r?.id ?? null,
      note: "A Canvas tool: open it from its Canvas page. The app never launches it.",
    };
  }
  if (r && r.text.trim() && r.kind !== "event") return { how: "app", url: safe, resourceId: r.id, note: null };
  if (safe) {
    const rule = classifyHost(new URL(safe).hostname).rule;
    if (rule.openable === false) return { how: "none", url: null, resourceId: r?.id ?? null, note: rule.launchEffect ?? null };
    return { how: "browser", url: safe, resourceId: r?.id ?? null, note: rule.launchEffect ?? null };
  }
  return { how: "none", url: null, resourceId: r?.id ?? null, note: "No link was captured for it." };
}

export function freshnessOf(ctx: ViewContext, r: Resource | null): PageFreshness {
  const source = r ? ctx.sources.get(r.sourceId) : undefined;
  if (!r || !source) return { observedAt: r?.observedAt ?? null, lastSuccessAt: null, status: "unknown" };
  const age = source.lastSuccessAt ? Date.parse(ctx.now) - Date.parse(source.lastSuccessAt) : Infinity;
  const status: PageFreshness["status"] =
    source.status === "error" || source.status === "inaccessible" || source.status === "needs_sign_in"
      ? source.lastSuccessAt ? "stale" : "failed"
      : age > 24 * 3_600_000
        ? "stale"
        : source.status === "ok" && source.complete
          ? "current"
          : "partial";
  return { observedAt: r.observedAt, lastSuccessAt: source.lastSuccessAt, status };
}

export function roleOf(ctx: ViewContext, r: Res | undefined): string | null {
  if (!r) return null;
  return classifyRole(ctx.index, r)?.role ?? null;
}

/** A resource row with its evidence and open action. */
export function resourceRow(
  ctx: ViewContext,
  r: Res | null,
  row: Pick<PageResource, "title" | "kind" | "reason" | "reasons" | "strength" | "score" | "evidence"> & { url?: string | null; provisional?: boolean },
): PageResource {
  return {
    resourceId: r?.id ?? null,
    title: row.title,
    kind: row.kind,
    role: r ? roleOf(ctx, r) : null,
    reason: row.reason,
    reasons: row.reasons,
    strength: row.strength,
    score: Math.round(row.score * 1000) / 1000,
    evidence: row.evidence,
    open: openFor(ctx, r, row.url ?? r?.url ?? null),
    freshness: freshnessOf(ctx, r),
    provisional: row.provisional ?? false,
  };
}

// ---------- Deadlines, by the same evidence the rest of the app uses ----------
const proseCache = new WeakMap<CourseIndex, ReturnType<typeof proseDeadlines>>();
/** Prose deadline claims (announcements, syllabus, pages that name the item), per course index. */
export function proseFor(ctx: ViewContext) {
  let prose = proseCache.get(ctx.index);
  if (!prose) {
    prose = proseDeadlines([...ctx.index.resources.values()], ctx.sources);
    proseCache.set(ctx.index, prose);
  }
  return prose;
}
/** Every copy of an assignment in the course (lists, to-do, module items, calendar events). */
export function copiesOf(ctx: ViewContext, canonical: Res): Res[] {
  return [...ctx.index.resources.values()].filter(
    (r) =>
      r.id === canonical.id ||
      (r.kind === "assignment" && r.externalId === canonical.externalId) ||
      (r.moduleItem?.contentId === canonical.externalId && (r.moduleItem.type === "Assignment" || r.moduleItem.type === "Quiz")) ||
      r.calendar?.assignmentExternalId === canonical.externalId ||
      r.calendar?.uid === `event-assignment-${canonical.externalId}`,
  );
}
export function deadlineClaims(ctx: ViewContext, target: Resource, copies: Resource[]): { claims: DeadlineEvidenceClaim[]; unresolved: UnresolvedDeadlineMention[] } {
  const claims: DeadlineEvidenceClaim[] = [];
  for (const c of copies) {
    const origin = c.calendar ? ("calendar" as const) : ("canvas" as const);
    for (const d of c.deadlines) claims.push({ ...d, origin });
    // The structured field itself, when the capture's deadline list doesn't already carry it.
    const fields: [DeadlineEvidenceClaim["kind"], string | null | undefined, string][] = [
      ["due", c.dueAt ?? c.moduleItem?.dueAt, c.dueAt ? "dueAt" : "moduleItem.dueAt"],
      ["lock", c.lockAt ?? c.moduleItem?.lockInfo?.lockAt, c.lockAt ? "lockAt" : "moduleItem.lockInfo.lockAt"],
    ];
    for (const [kind, value, field] of fields)
      if (value && !c.deadlines.some((d) => d.kind === kind && Date.parse(d.value) === Date.parse(value)))
        claims.push({ value, kind, quote: `${field}: ${value}`, authority: "structured", scopeConfirmed: true, origin });
  }
  const prose = proseFor(ctx)(target);
  return { claims: [...claims, ...prose.claims], unresolved: prose.unresolved };
}
/** A deadline claim as evidence: its span when it has one, else the structured value. */
export function claimEvidence(ctx: ViewContext, c: DeadlineEvidenceClaim): PageEvidence {
  const r = c.span ? ctx.index.resources.get(c.span.resourceId) ?? ctx.store.resource(c.span.resourceId) : undefined;
  if (r && c.span) {
    const text = c.span.field === "title" ? r.title : r.text;
    if (text.slice(c.span.start, c.span.end) === c.span.text)
      return c.span.field === "title"
        ? titleEvidence(ctx, r, c.span.start, c.span.end)
        : { ...textEvidence(ctx, r, c.span.start, c.span.end, c.statedAt ?? null)! };
  }
  return {
    resourceId: null,
    source: c.origin === "calendar" ? "Canvas calendar" : "Canvas",
    origin: c.origin === "calendar" ? "calendar" : "canvas",
    url: null,
    quote: c.quote || c.value,
    basis: "field",
    field: c.kind === "lock" ? "lockAt" : "dueAt",
    start: null,
    end: null,
    statedAt: c.statedAt ?? null,
  };
}

// ---------- Names ----------
const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Name variants an instructor writes for the same item ("Homework 3", "HW 3", "Midterm 1"). */
export function namePatterns(title: string): RegExp[] {
  const clean = title.trim();
  const out = clean.length >= 4 ? [new RegExp(`(?<![a-z0-9])${escape(clean).replace(/\s+/g, "\\s+")}(?![a-z0-9])`, "i")] : [];
  const m = /^(.*?)(?:\s*#?\s*)(\d{1,3})\b/.exec(clean);
  if (m && m[1]) {
    const word = m[1].trim().toLowerCase();
    const n = m[2];
    const forms = new Set([escape(word)]);
    if (/^home\s*work$/.test(word)) forms.add("hw");
    if (/^problem\s*set$/.test(word)) ["ps", "pset"].forEach((f) => forms.add(f));
    if (/^lab(oratory)?$/.test(word)) forms.add("lab");
    if (/^(exam|midterm|midterm exam)$/.test(word)) ["exam", "midterm"].forEach((f) => forms.add(f));
    for (const f of forms) if (f) out.push(new RegExp(`(?<![a-z0-9])${f.replace(/\s+/g, "\\s*")}\\s*#?\\s*0?${n}(?![0-9])`, "i"));
  } else if (/^(midterm|final|final exam|midterm exam)$/i.test(clean)) {
    out.push(new RegExp(`(?<![a-z0-9])${escape(clean.split(/\s+/)[0]!)}(?:\\s+exam)?(?![a-z0-9])`, "i"));
  }
  return out;
}
/** Does this text name the item (by a name variant, or an identifier unique in the course)? */
export function namer(ctx: ViewContext, title: string, externalId: string | null) {
  const patterns = namePatterns(title);
  const peers = [...ctx.index.assignmentById.values(), ...ctx.index.quizById.values()];
  const own = identifiersIn(title);
  const unique = own.filter((code) => peers.filter((p) => identifiersIn(p.title).includes(code)).length <= 1);
  const idLink = externalId ? new RegExp(`/(?:assignments|quizzes)/${escape(externalId)}(?![0-9])`) : null;
  return {
    text: (text: string) => patterns.some((p) => p.test(text)) || (unique.length > 0 && identifiersIn(text).some((c) => unique.includes(c))),
    links: (r: Resource) => !!idLink && (r.links ?? []).some((l) => idLink.test(typeof l === "string" ? l : l.url)),
  };
}

// ---------- Notes and office hours ----------
type NoteRecord = NonNullable<ReturnType<SqlNotesStore["note"]>>;
/** A note's list row, read-only (sync state is the notes service's; here it is `local`). */
export function noteSummary(notes: SqlNotesStore, n: NoteRecord): NoteSummary {
  const blocks = notes.blocks(n.id) ?? [];
  const preview = clip(blocks.flatMap((b) => b.items.filter((i) => i.origin !== "scaffold").map((i) => i.text)).join(" ").trim(), 160);
  return {
    id: n.id,
    courseId: n.courseId,
    accountScope: n.accountScope,
    title: n.title,
    sessionId: n.sessionId,
    sessionType: n.sessionType,
    date: n.sessionDate,
    moduleName: n.moduleName,
    template: n.template,
    state: n.state,
    sync: "local",
    revision: n.revision,
    updatedAt: n.updatedAt,
    editedAt: n.editedAt,
    preview,
    scheduled: n.scheduled,
  };
}

const WEEKDAY = /\b(mon|tue|wed|thu|fri|sat|sun)(?:day|s|sday|nesday|rsday|urday|\.)?\b/gi;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export interface OfficeHourLine {
  text: string;
  evidence: PageEvidence;
  /** 1 = Monday … 7 = Sunday, as the line names them. */
  weekdays: number[];
}
/** Office hours as posted: the course profile's staff rows, else syllabus and course-info lines. */
export function officeHourLines(ctx: ViewContext): OfficeHourLine[] {
  const out: OfficeHourLine[] = [];
  const days = (text: string) => [...new Set([...text.matchAll(WEEKDAY)].map((m) => DAYS.indexOf(m[1]!.toLowerCase()) + 1))];
  const brief = ctx.store.courseBrief(ctx.course);
  const syllabus = brief ? ctx.index.resources.get(brief.syllabusResourceId) : undefined;
  for (const s of brief?.brief.staff ?? []) {
    if (!s.officeHours) continue;
    const ev = syllabus && syllabus.text.slice(s.start, s.end) === s.quote ? textEvidence(ctx, syllabus, s.start, s.end) : null;
    out.push({
      text: `${s.name} (${s.role}): ${s.officeHours}`,
      evidence: ev ? { ...ev, origin: "course_profile" } : { ...fieldEvidence(ctx, syllabus ?? null, "brief.staff", s.quote, "course_profile", "Course profile") },
      weekdays: days(s.officeHours),
    });
  }
  if (out.length) return out;
  const sources = [ctx.index.syllabus, ...[...ctx.index.pageBySlug.values()].filter((p) => /office hours|staff|contact/i.test(p.title))].filter((r): r is Res => !!r?.text);
  for (const r of sources) {
    let at = 0;
    for (const line of r.text.split("\n")) {
      if (/office\s*hours?/i.test(line) && days(line).length) {
        const lead = line.length - line.trimStart().length;
        const trimmed = line.trim().slice(0, 300);
        const ev = textEvidence(ctx, r, at + lead, at + lead + trimmed.length);
        if (ev) out.push({ text: trimmed, evidence: ev, weekdays: days(line) });
      }
      at += line.length + 1;
    }
  }
  return out.slice(0, 10);
}
/** 1 = Monday … 7 = Sunday for a YYYY-MM-DD date. */
export const weekdayOf = (date: string) => ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

// ---------- Hashing ----------
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as object)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}
/** A stable hash of the facts a page shows (never of when it was generated or how fresh it is). */
export function factHash(facts: unknown): string {
  return createHash("sha256").update(canonical(facts)).digest("hex").slice(0, 32);
}

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
export const isDateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
export const ZONE = "America/Chicago";
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
/** The local (America/Chicago) calendar day of an instant or date. */
export function localDay(at: string): string {
  return isDateOnly(at) ? at : dayFmt.format(new Date(at));
}
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const human = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const humanDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
/** "Tue, Oct 6, 2:00 PM" in America/Chicago; a date-only value shows the day only. */
export function showDate(at: string): string {
  return isDateOnly(at) ? humanDay.format(new Date(`${at}T12:00:00Z`)) : human.format(new Date(at));
}
