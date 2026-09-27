// owner: task-workspace (assignment-context). A bounded, code-only resolver for what a saved
// assignment is about when its own Canvas body can't say. It never calls a model, never follows
// a link over the network and never invents an accepted link: a same-course section it finds is
// returned as provisional, with its exact span, source version and source health.
import type {
  AssignmentContext,
  AssignmentContextLink,
  AssignmentContextSection,
  AssignmentContextSource,
  Resource,
  SourceHealth,
  Store,
} from "@magic/contracts";

export const CONTEXT_RESOLVER_VERSION = 1;
/** Bounds: resources scanned, sections returned, characters per section and per agent read. */
export const CONTEXT_LIMITS = { resources: 400, sections: 3, sectionChars: 1500, readChars: 4000 } as const;

const ANCHOR = /\b(lecture|lec|week|wk|lab|module|unit|class|session|day|chapter|ch)\s*\.?\s*#?\s*0*(\d{1,3})(?!\d)/i;
const KIND: Record<string, string> = { lec: "lecture", wk: "week", ch: "chapter" };
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
// Month-name, ISO and m/d/y dates. A bare "4/6" is too often a fraction or a part number.
const DATE = new RegExp(`\\b(?:${MONTH}\\s+\\d{1,2}(?!\\d)|\\d{1,2}/\\d{1,2}/\\d{2,4}(?!\\d)|\\d{4}-\\d{2}-\\d{2})`, "gi");

function urlKey(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}
const hostOf = (value: string) => {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
};

/** "lecture 7 activity" → lecture 7. Titles without a numbered unit have no anchor. */
export function assignmentAnchor(title: string): { kind: string; n: number; label: string } | null {
  const m = ANCHOR.exec(title);
  if (!m) return null;
  const raw = m[1]!.toLowerCase();
  const kind = KIND[raw] ?? raw;
  const n = Number(m[2]);
  return { kind, n, label: `${kind[0]!.toUpperCase()}${kind.slice(1)} ${n}` };
}
function anchorPattern(kind: string, n: number | null) {
  const names = Object.entries(KIND).filter(([, v]) => v === kind).map(([k]) => k).concat(kind);
  return new RegExp(`\\b(?:${names.join("|")})\\s*\\.?\\s*#?\\s*${n === null ? "\\d{1,3}" : `0*${n}`}(?!\\d)`, "gi");
}

/** Every heading-like occurrence of the anchor, cut at the next unit of the same kind. */
export function findSections(text: string, kind: string, n: number) {
  const out: { start: number; end: number }[] = [];
  const own = anchorPattern(kind, n);
  const any = anchorPattern(kind, null);
  for (const m of text.matchAll(own)) {
    const start = m.index!;
    any.lastIndex = start + m[0].length;
    const next = any.exec(text);
    const end = Math.min(next ? sectionEnd(text, next.index) : text.length, start + CONTEXT_LIMITS.sectionChars);
    if (out.some(s => start < s.end)) continue; // a mention inside the previous section
    out.push({ start, end });
    if (out.length >= CONTEXT_LIMITS.sections) break;
  }
  return out;
}
const WEEKDAY = "(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\\.?,?\\s*";
/** A section stops before the next heading and before a date written just ahead of it. */
function sectionEnd(text: string, next: number) {
  const from = Math.max(0, next - 40);
  const tail = new RegExp(`(?:${WEEKDAY})?(?:${DATE.source})[\\s,.:|–—-]*$`, "i").exec(text.slice(from, next));
  return tail ? from + tail.index : next;
}
function datesIn(text: string) {
  return [...new Set([...text.matchAll(DATE)].map(m => m[0].replace(/\s+/g, " ").replace(/\.$/, "")))];
}
/**
 * Dates that label one heading: the nearest date just before it (schedules put the date
 * first) and any on the heading itself, never dates further into the section.
 */
export function headingDates(text: string, start: number, end: number) {
  const prior = [...text.slice(Math.max(0, start - 40), start).matchAll(DATE)].pop();
  const lineEnd = text.indexOf("\n", start);
  const after = text.slice(start, Math.min(end, lineEnd < 0 ? text.length : lineEnd, start + 80));
  return datesIn(`${prior?.[0] ?? ""} ${after}`);
}

function sourceOf(source: SourceHealth | undefined, now: Date): AssignmentContextSource | null {
  if (!source) return null;
  const last = source.lastSuccessAt ? Date.parse(source.lastSuccessAt) : NaN;
  const stale = Number.isNaN(last) || now.getTime() - last > 24 * 3600 * 1000;
  const partial = source.status !== "ok" || !source.complete;
  return {
    sourceId: source.id, label: source.label, kind: source.kind, status: source.status, complete: source.complete,
    lastSuccessAt: source.lastSuccessAt, stale,
    note: partial
      ? `${source.label} was read ${source.status === "ok" || source.status === "partial" ? "only partly" : `with status "${source.status.replaceAll("_", " ")}"`}; other pages may be missing.`
      : stale ? `${source.label} hasn't been read successfully in the last day.` : null,
  };
}

const SUBMISSION_WORDS: Record<string, string> = {
  online_url: "a website address (URL)",
  online_upload: "a file upload",
  online_text_entry: "text typed into Canvas",
  media_recording: "a media recording",
  external_tool: "an external tool",
  on_paper: "on paper",
  discussion_topic: "a discussion post",
  online_quiz: "a Canvas quiz",
};

export interface ResolveOptions {
  /** Visibility of every other resource (course inclusion, agent grant and categories). */
  permitted?: (resource: Resource) => boolean;
  resources?: Resource[];
  now?: Date;
}

/**
 * The assignment's own facts (Canvas body, direct links, submission fields) plus at most a few
 * provisional same-account, same-course sections named by the assignment's numbered unit.
 */
export function resolveAssignmentContext(store: Store, id: string, options: ResolveOptions = {}): AssignmentContext {
  const now = options.now ?? new Date();
  const assignment = store.resource(id);
  if (!assignment || assignment.deleted || assignment.kind !== "assignment") throw new Error("This item is no longer available.");
  const permitted = options.permitted ?? (() => true);
  if (!permitted(assignment)) throw new Error("This assignment isn't available here.");
  const sources = new Map(store.sources().map(s => [s.id, s]));
  const account = sources.get(assignment.sourceId)?.accountScope;
  if (!account) throw new Error("This assignment's source account isn't available.");
  const sameCourse = (r: Resource) => r.courseId === assignment.courseId && sources.get(r.sourceId)?.accountScope === account;
  const all = (options.resources ?? store.resources()).filter(r => !r.deleted && sameCourse(r) && permitted(r));
  const usedSources = new Set<string>([assignment.sourceId]);

  const body = (assignment.text ?? "").trim();
  const instructions = body
    ? { status: "captured" as const, chars: body.length, text: "The saved Canvas assignment has instructions." }
    : { status: "empty" as const, chars: 0, text: "The saved Canvas assignment has no instructions." };

  const types = (assignment.submissionTypes ?? []).filter(Boolean);
  const online = types.filter(t => t !== "none" && t !== "not_graded");
  const submission = !types.length
    ? { types, status: "unknown" as const, text: "Canvas didn't list how to submit." }
    : online.length
      ? { types, status: "listed" as const, text: `Canvas lists ${online.map(t => SUBMISSION_WORDS[t] ?? t.replaceAll("_", " ")).join(" or ")}. Check the task instructions for where to submit.` }
      : { types, status: "none_listed" as const, text: "Canvas lists no online submission. That doesn't show whether there's something to hand in another way." };

  // Direct links from the assignment itself: action targets, never instructions unless captured.
  // Links back into the assignment's own site are listed only when they are saved pages of this
  // course, so Canvas navigation and other courses never appear here.
  const byUrl = new Map(all.map(r => [urlKey(r.url), r]));
  const home = (() => {
    try {
      return new URL(assignment.url).origin;
    } catch {
      return "";
    }
  })();
  const links: AssignmentContextLink[] = [];
  for (const l of assignment.links ?? []) {
    const url = typeof l === "string" ? l : l.url;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
    if (parsed.username || parsed.password) continue;
    if (links.some(x => urlKey(x.url) === urlKey(url))) continue;
    const saved = byUrl.get(urlKey(url));
    if (parsed.origin === home && !saved) continue;
    const chars = saved?.text?.trim().length ?? 0;
    if (saved) usedSources.add(saved.sourceId);
    links.push({
      url, host: hostOf(url), text: typeof l === "string" ? null : l.text ?? null,
      captured: saved && chars ? { resourceId: saved.id, title: saved.title, chars, contentHash: saved.contentHash } : null,
      note: saved && chars ? `Saved in Magic (${chars.toLocaleString("en-US")} characters).`
        : "Link only. Magic hasn't read this page or file, so its contents aren't part of these instructions.",
    });
    if (links.length >= 20) break;
  }

  // Provisional sections: only when the title names a numbered unit, only same account and course.
  const anchor = assignmentAnchor(assignment.title);
  const exactCopies = new Set(all.filter(r => r.externalId === assignment.externalId).map(r => r.id));
  const accepted = new Set(store.links().filter(l => l.status === "accepted" && l.type === "specifies" && l.toId === assignment.id).map(l => l.fromId));
  const sections: AssignmentContextSection[] = [];
  if (anchor && !body) {
    const scanned = all
      .filter(r => r.id !== assignment.id && !exactCopies.has(r.id) && r.kind !== "assignment" && (r.text?.length ?? 0) > 0)
      .slice(0, CONTEXT_LIMITS.resources);
    for (const r of scanned) {
      const text = r.text!;
      const found = findSections(text, anchor.kind, anchor.n);
      if (!found.length) continue;
      const quotes = found.map(s => text.slice(s.start, s.end).trim());
      const dated = found.map(s => headingDates(text, s.start, s.end));
      const distinct = [...new Set(dated.flat())];
      for (const [i, s] of found.entries()) {
        const quote = quotes[i]!;
        const sectionLinks = (r.links ?? [])
          .map(l => (typeof l === "string" ? { url: l, text: null } : { url: l.url, text: l.text ?? null }))
          .filter(l => (l.text && l.text.trim().length > 1 && quote.includes(l.text.trim())) || quote.includes(l.url))
          .slice(0, 10);
        sections.push({
          resourceId: r.id, title: r.title, url: r.url, sourceId: r.sourceId, contentHash: r.contentHash, observedAt: r.observedAt,
          start: s.start, end: s.end, quote, dates: dated[i]!, links: sectionLinks,
          linkedToAssignment: accepted.has(r.id),
          provisional: !accepted.has(r.id),
          reason: accepted.has(r.id)
            ? `Its "${anchor.label}" section, in a page linked to this assignment.`
            : `Its "${anchor.label}" section matches this assignment's title. This page isn't linked to the assignment, so treat it as possibly related.`,
          dateConflict: distinct.length > 1
            ? `This page lists ${anchor.label} under more than one date (${distinct.join(", ")}). Magic doesn't choose between them.`
            : null,
        });
        usedSources.add(r.sourceId);
      }
      if (sections.length >= CONTEXT_LIMITS.sections) break;
    }
    sections.splice(CONTEXT_LIMITS.sections);
  }

  const unknowns: string[] = [];
  if (instructions.status === "empty")
    unknowns.push(sections.length
      ? "Detailed instructions: not in the Canvas assignment. The related section below may describe the activity, but it isn't confirmed as this assignment's instructions."
      : "Detailed instructions: not in the Canvas assignment, and no saved page names it.");
  if (submission.status !== "listed") unknowns.push("Where to submit: not confirmed. Check the Canvas assignment page.");
  const unread = links.filter(l => !l.captured);
  if (unread.length) unknowns.push(`${unread.length} linked ${unread.length === 1 ? "page or file hasn't" : "pages or files haven't"} been read: ${[...new Set(unread.map(l => l.host))].join(", ")}.`);
  if (!assignment.dueAt) unknowns.push("Due date: Canvas lists none.");

  return {
    version: CONTEXT_RESOLVER_VERSION,
    assignmentId: assignment.id, accountScope: account, courseId: assignment.courseId, title: assignment.title,
    contentHash: assignment.contentHash, observedAt: assignment.observedAt, url: assignment.url,
    canvas: { dueAt: assignment.dueAt ?? null, lockAt: assignment.lockAt ?? null },
    anchor: anchor?.label ?? null,
    instructions, submission, links, sections, unknowns,
    sources: [...usedSources].map(sid => sourceOf(sources.get(sid), now)).filter((s): s is AssignmentContextSource => !!s),
  };
}

/**
 * One bounded read of a same-course span for a connected agent's follow-up. The caller
 * (agent-api session) supplies its own `permitted` and scrubs the returned text.
 */
export function readContextSpan(store: Store, assignmentId: string, resourceId: string, start: number, length: number, permitted: (r: Resource) => boolean) {
  const assignment = store.resource(assignmentId);
  const target = store.resource(resourceId);
  const sources = new Map(store.sources().map(s => [s.id, s]));
  if (!assignment || !target || assignment.deleted || target.deleted || !permitted(assignment) || !permitted(target) ||
      target.courseId !== assignment.courseId || sources.get(target.sourceId)?.accountScope !== sources.get(assignment.sourceId)?.accountScope)
    throw new Error("That page isn't available for this assignment.");
  if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 1) throw new Error("Invalid span.");
  const text = target.text ?? "";
  const from = Math.min(start, text.length);
  const to = Math.min(text.length, from + Math.min(length, CONTEXT_LIMITS.readChars));
  return { resourceId: target.id, title: target.title, contentHash: target.contentHash, observedAt: target.observedAt, start: from, end: to, total: text.length, text: text.slice(from, to) };
}
