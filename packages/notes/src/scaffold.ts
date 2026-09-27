/**
 * The scaffold: pure code, 0 tokens. For one session it fills the note's head blocks (the
 * session's date, time, module and section; its slides and readings with links; key terms; what's
 * due next) and the chosen template's empty blocks. Every source link carries code's reason.
 */
import { createHash } from "node:crypto";
import type { CourseCoreStore, NoteBlock, NoteItem, NoteTemplateId, Resource, Store } from "@magic/contracts";
import { resolveDeadline } from "@magic/domain";
import { evidenceFor } from "../../core/src/evidence";
import { addDays, type CanvasCourseInfo, type NoteSession, type SessionsPort } from "./sessions";
import { SCAFFOLD_BLOCKS, templateBlocks } from "./templates/index";

export const MAX_SOURCES = 5;
export const MAX_TERMS = 8;
export const MAX_DUE = 3;
export const SCAFFOLD_VERSION = "scaffold-v1";

export type ScaffoldStore = Store & Pick<CourseCoreStore, "materialFacts" | "mapLinks">;
export interface ScaffoldLink {
  resourceId: string;
  role: "slides" | "reading" | "module" | "material";
  reason: string;
}
export interface Scaffold {
  head: NoteBlock[];
  links: ScaffoldLink[];
  moduleId: string | null;
  moduleName: string | null;
  hash: string;
  stats: { sources: number; module: boolean; terms: number; termsFrom: "materials" | "profile" | "none"; due: number };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function clock(minute: number): string {
  const h = Math.floor(minute / 60) % 24, m = minute % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
export function sessionLabel(s: Pick<NoteSession, "date" | "type" | "startMinute" | "endMinute">): string {
  const [y, mo, d] = s.date.split("-").map(Number);
  const day = WEEKDAYS[((new Date(Date.UTC(y!, mo! - 1, d!)).getUTCDay() + 6) % 7)];
  const month = MONTHS[mo! - 1]!;
  const time = s.startMinute !== null ? ` · ${clock(s.startMinute)}${s.endMinute !== null ? `–${clock(s.endMinute)}` : ""}` : "";
  return `${day} ${month[0]!.toUpperCase()}${month.slice(1)} ${d}${time}`;
}
function dateMatchers(date: string): RegExp[] {
  const [, mo, d] = date.split("-").map(Number);
  const month = MONTHS[mo! - 1]!;
  return [
    new RegExp(`(?<!\\d)0?${mo}[/.-]0?${d}(?!\\d)`),
    new RegExp(`\\b${month}[a-z]*\\.?\\s+0?${d}(?!\\d)`, "i"),
  ];
}
const isNoteSource = (kind: string | undefined) => kind === "notes";
const SLIDES = /\b(slides?|lecture|deck|notes|handout)\b|\.(pdf|pptx?|key)$/i;
const READING = /\b(readings?|chapters?|ch\.|articles?|textbook)\b/i;

/** Course-level inputs, read once for every session of the course. */
export function courseContext(store: ScaffoldStore, course: CanvasCourseInfo) {
  const sources = new Map(store.sources().map((s) => [s.id, s]));
  const resources = store
    .resources()
    .filter((r) => !r.deleted && r.courseId === course.courseId && sources.get(r.sourceId)?.accountScope === course.accountScope)
    .filter((r) => !isNoteSource(sources.get(r.sourceId)?.kind));
  const evidence = evidenceFor(store);
  const due = resources
    .filter((r) => r.kind === "assignment" && !r.completed)
    .flatMap((r) => {
      const at = resolveDeadline(evidence.deadlines(r)).dueAt;
      return at ? [{ r, at }] : [];
    })
    .sort((a, b) => a.at.localeCompare(b.at) || a.r.title.localeCompare(b.r.title));
  const modules = resources.filter((r) => r.module && !r.moduleItem);
  const materials = resources.filter(
    (r) => (r.kind === "material" && !(r.module && !r.moduleItem)) || (r.kind === "assignment" && READING.test(r.title)),
  );
  const profile = store.courseIntelligence().find((p) => p.accountScope === course.accountScope && p.courseId === course.courseId);
  const topics = [...new Set((profile?.claims ?? []).filter((c) => c.kind === "topic").map((c) => c.label.trim()).filter(Boolean))];
  const mapLinks = store.mapLinks({ accountScope: course.accountScope, courseId: course.courseId }).filter((l) => l.current);
  return { course, resources, materials, modules, due, topics, mapLinks, byId: new Map(resources.map((r) => [r.id, r])) };
}
export type CourseContext = ReturnType<typeof courseContext>;

/** The session's module: a module named for its date or term week, else the latest unlocked by then. */
function moduleFor(ctx: CourseContext, session: NoteSession): { module: Resource; reason: string } | null {
  const start = ctx.course.startAt?.slice(0, 10);
  const week = start ? Math.floor((Date.parse(session.date) - Date.parse(addDays(start, 1 - isoWeekday(start)))) / (7 * 86_400_000)) + 1 : null;
  const dated = ctx.modules.find((m) => dateMatchers(session.date).some((re) => re.test(m.title)));
  if (dated) return { module: dated, reason: "module title names the date" };
  if (week !== null && week > 0) {
    const named = ctx.modules.find((m) => new RegExp(`\\bweek\\s*0?${week}\\b`, "i").test(m.title));
    if (named) return { module: named, reason: `module for week ${week} of the term` };
  }
  const unlocked = ctx.modules
    .filter((m) => m.module?.unlockAt && m.module.unlockAt.slice(0, 10) <= session.date && m.module.unlockAt.slice(0, 10) >= addDays(session.date, -6))
    .sort((a, b) => b.module!.unlockAt!.localeCompare(a.module!.unlockAt!));
  return unlocked[0] ? { module: unlocked[0], reason: "module unlocked this week" } : null;
}
function isoWeekday(date: string): number {
  return ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

/** The session's slides and readings, best first, each with code's reason. */
export function sessionMaterials(ctx: CourseContext, session: NoteSession, ordinal: number | null): ScaffoldLink[] {
  const scored = new Map<string, { score: number; link: ScaffoldLink }>();
  const offer = (r: Resource, score: number, role: ScaffoldLink["role"], reason: string) => {
    const kept = scored.get(r.id);
    if (!kept || kept.score < score) scored.set(r.id, { score, link: { resourceId: r.id, role, reason } });
  };
  const roleOf = (r: Resource): ScaffoldLink["role"] => (READING.test(r.title) ? "reading" : SLIDES.test(r.title) ? "slides" : "material");
  if (session.courseSessionId)
    for (const l of ctx.mapLinks)
      if (l.fromKind === "session" && l.fromId === session.courseSessionId && ["covers", "reading"].includes(l.kind)) {
        const r = ctx.byId.get(l.toResourceId);
        if (r) offer(r, 100, l.kind === "reading" ? "reading" : roleOf(r), `course map: ${l.kind}`);
      }
  const dates = dateMatchers(session.date);
  const ordinalRe =
    ordinal !== null && session.type === "lecture"
      ? new RegExp(`\\b(?:lecture|lec|l)\\s*0?${ordinal}\\b`, "i")
      : ordinal !== null && session.type !== "other"
        ? new RegExp(`\\b(?:${session.type}|dis|lab)\\s*0?${ordinal}\\b`, "i")
        : null;
  for (const r of ctx.materials) {
    if (dates.some((re) => re.test(r.title))) offer(r, 90, roleOf(r), "title names the session date");
    else if (ordinalRe?.test(r.title)) offer(r, 80, roleOf(r), `title names ${session.type} ${ordinal}`);
    else {
      const posted = (r.unlockAt ?? r.createdAt ?? r.file?.updatedAt ?? "").slice(0, 10);
      if (posted && posted <= session.date && posted >= addDays(session.date, -3) && (SLIDES.test(r.title) || READING.test(r.title)))
        offer(r, 60, roleOf(r), `posted ${posted}, just before the session`);
    }
  }
  const module = moduleFor(ctx, session);
  if (module) offer(module.module, 50, "module", module.reason);
  return [...scored.values()]
    .sort((a, b) => b.score - a.score || ctx.byId.get(a.link.resourceId)!.title.localeCompare(ctx.byId.get(b.link.resourceId)!.title))
    .slice(0, MAX_SOURCES)
    .map((x) => x.link);
}

function item(id: string, text: string, link?: NoteItem["link"]): NoteItem {
  return { id, text, ...(link ? { link } : {}), origin: "scaffold" };
}
function safeLink(r: Resource): NoteItem["link"] | undefined {
  try {
    const url = new URL(r.url);
    return url.protocol === "https:" ? { title: r.title.slice(0, 500), url: url.href, resourceId: r.id } : undefined;
  } catch {
    return undefined;
  }
}

export function scaffold(
  store: Pick<CourseCoreStore, "materialFacts">,
  ctx: CourseContext,
  session: NoteSession,
  ordinal: number | null,
): Scaffold {
  const links = sessionMaterials(ctx, session, ordinal);
  const module = links.find((l) => l.role === "module");
  const moduleRes = module ? ctx.byId.get(module.resourceId)! : null;
  const context: NoteItem[] = [
    item("when", sessionLabel(session)),
    ...(session.title && !/^(lecture|discussion|lab)$/i.test(session.title) ? [item("title", session.title)] : []),
    ...(moduleRes ? [item("module", `Module: ${moduleRes.title}`, safeLink(moduleRes))] : []),
    ...(session.section ? [item("section", `Section: ${session.section}`)] : []),
    ...(session.location ? [item("location", `Location: ${session.location}`)] : []),
  ];
  const materialLinks = links.filter((l) => l.role !== "module");
  const sources = materialLinks.map((l) => {
    const r = ctx.byId.get(l.resourceId)!;
    return item(`src-${r.id}`, r.title, safeLink(r));
  });
  // Key terms: the session materials' term facts; else the course profile's topics.
  const facts = materialLinks.flatMap((l) => store.materialFacts(l.resourceId).filter((f) => f.kind === "term"));
  let termsFrom: Scaffold["stats"]["termsFrom"] = "none";
  let terms: string[] = [];
  if (facts.length) {
    terms = [...new Set(facts.map((f) => f.value.trim()).filter(Boolean))].slice(0, MAX_TERMS);
    termsFrom = "materials";
  } else if (ctx.topics.length) {
    terms = ctx.topics.slice(0, MAX_TERMS);
    termsFrom = "profile";
  }
  const after = `${session.date}T00:00:00`;
  const due = ctx.due.filter((d) => d.at >= after).slice(0, MAX_DUE);
  const dueItems = due.map((d) => item(`due-${d.r.id}`, `${d.r.title} — due ${sessionLabel({ date: d.at.slice(0, 10), type: session.type, startMinute: null, endMinute: null })}`, safeLink(d.r)));
  const fill: Record<string, NoteItem[]> = {
    context,
    sources,
    terms: terms.map((t, i) => item(`term-${i}`, t)),
    due: dueItems,
  };
  const head: NoteBlock[] = SCAFFOLD_BLOCKS.map((b) => ({ id: b.id, kind: b.kind, heading: b.heading, hint: b.hint, items: fill[b.id] ?? [] }));
  const hash = createHash("sha256")
    .update(JSON.stringify([SCAFFOLD_VERSION, head, links]))
    .digest("hex");
  return {
    head,
    links,
    moduleId: moduleRes?.module?.id ?? moduleRes?.id ?? null,
    moduleName: moduleRes?.title ?? null,
    hash,
    stats: { sources: sources.length, module: moduleRes !== null, terms: terms.length, termsFrom, due: dueItems.length },
  };
}

/** Head blocks plus the template's empty blocks: a new note's first version. */
export function scaffoldBlocks(s: Scaffold, template: NoteTemplateId): NoteBlock[] {
  return [...s.head, ...templateBlocks(template)];
}

/** The session's ordinal among the course's sessions of its type, from the term's start. */
export function sessionOrdinal(port: SessionsPort, ctx: CourseContext, session: NoteSession): number | null {
  if (session.type === "other") return null;
  const start = ctx.course.startAt?.slice(0, 10);
  if (!start || start > session.date) return null;
  const list = port.sessions(ctx.course.courseId, { from: start, to: session.date }).filter((s) => s.type === session.type);
  const index = list.findIndex((s) => s.id === session.id);
  return index >= 0 ? index + 1 : null;
}
