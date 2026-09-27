/**
 * `lecture.session {courseId, sessionId | date}` (owner: page-views): one class session's page.
 * The session and its scaffold come from the notes package (the schedule adapter and the 0-token
 * scaffold); this view adds recordings as link cards, key terms with their quotes, assignments due
 * within 7 days that use this session's materials, and office hours that day. Reads only.
 */
import type { LectureSession, PageEvidence, PageMissing, PageResource, SessionType } from "@magic/contracts";
import { classifyHost } from "../../../connectors/src/space-hosts";
import { courseContext, scaffold as buildScaffold, sessionMaterials, sessionOrdinal, type ScaffoldLink } from "../../../notes/src/scaffold";
import { createSessionsAdapter, parseSessionId, sessionIdOf, type NoteSession } from "../../../notes/src/sessions";
import { references } from "../graph/references";
import type { Res } from "../graph/course-index";
import {
  PageViewError,
  addDays,
  contextFor,
  factHash,
  fieldEvidence,
  included,
  localDay,
  noteSummary,
  officeHourLines,
  quoteEvidence,
  resourceRow,
  roleOf,
  structureEvidence,
  textEvidence,
  titleEvidence,
  weekdayOf,
  type ViewContext,
  type ViewStore,
} from "./common";

export interface LectureRequest {
  courseId: string;
  accountScope?: string;
  sessionId?: string;
  date?: string;
  type?: SessionType;
}
const RECORDING = /\b(recordings?|video|lecture capture|panopto|kaltura|mediaspace|zoom recording)\b/i;
const CAP = 5;

/** Evidence for a scaffold link: the title it matched, the course-map row, the post date or the module. */
function linkEvidence(ctx: ViewContext, r: Res, link: ScaffoldLink, session: NoteSession): PageEvidence {
  if (link.reason.startsWith("posted ")) {
    const field = r.unlockAt ? "unlockAt" : r.createdAt ? "createdAt" : "file.updatedAt";
    return fieldEvidence(ctx, r, field, r.unlockAt ?? r.createdAt ?? r.file?.updatedAt ?? link.reason.slice(7, 17));
  }
  if (link.reason.startsWith("course map")) return structureEvidence(ctx, r, "map_links", link.reason, "course_map");
  if (link.role === "module") return structureEvidence(ctx, r, "module", r.title, "module");
  if (link.reason.includes("date")) {
    const [, mo, d] = session.date.split("-").map(Number);
    const m = new RegExp(`(?<!\\d)0?${mo}[/.-]0?${d}(?!\\d)|\\b[a-z]{3}[a-z]*\\.?\\s+0?${d}(?!\\d)`, "i").exec(r.title);
    if (m) return titleEvidence(ctx, r, m.index, m.index + m[0].length);
  }
  return titleEvidence(ctx, r);
}

export function lectureSession(store: ViewStore, request: LectureRequest, now: string): LectureSession {
  const sources = store.sources();
  const parsed = request.sessionId ? parseSessionId(request.sessionId) : null;
  if (request.sessionId && (!parsed || parsed.courseId !== request.courseId)) throw new PageViewError("That session isn't in this course.");
  const date = parsed?.date ?? request.date;
  if (!date) throw new PageViewError("Name a session or a date.");
  const accountScope =
    request.accountScope ??
    sources.filter((s) => s.courseId === request.courseId && s.kind === "canvas").map((s) => s.accountScope).sort()[0];
  if (!accountScope) throw new PageViewError("This course isn't in your workspace.");
  const course = { accountScope, courseId: request.courseId };
  const ctx = contextFor(store, course, now, sources);
  if (!ctx.index.resources.size) throw new PageViewError("This course isn't in your workspace.");
  const courseRes = [...ctx.index.resources.values()].find((r) => r.kind === "course");
  if (courseRes && !included(ctx)(courseRes)) throw new PageViewError("This course is excluded. Include it in Sources to see this session.");
  const missing: PageMissing[] = [];
  const miss = (field: string, text: string) => missing.push({ field, text });

  const port = createSessionsAdapter(ctx.scoped);
  const info = port.course(course.courseId, accountScope);
  if (!info) throw new PageViewError("This course isn't in your workspace.");
  const onDay = port.sessions(course.courseId, { from: date, to: date });
  const type = parsed?.type ?? request.type;
  const found =
    (request.sessionId ? onDay.find((s) => s.id === request.sessionId) : undefined) ??
    (type ? onDay.find((s) => s.type === type) : onDay.find((s) => s.type === "lecture") ?? onDay[0]);
  const session: NoteSession = found ?? {
    id: sessionIdOf(course.courseId, date, type ?? "lecture"),
    type: type ?? "lecture",
    date,
    startMinute: null,
    endMinute: null,
    title: "Lecture",
    section: null,
    location: null,
    origin: "calendar",
    typeBasis: "no scheduled session; matched by date only",
    accountScope,
    courseId: course.courseId,
    courseName: info.courseName,
    courseSessionId: null,
  };
  if (!found) miss("session", "No scheduled session found for this date; materials are matched by the date only.");

  const cctx = courseContext(ctx.scoped, info);
  const ordinal = found ? sessionOrdinal(port, cctx, session) : null;
  const sc = found ? buildScaffold(ctx.scoped, cctx, session, ordinal) : null;
  const raw = sc?.links ?? sessionMaterials(cctx, session, ordinal);
  // The scaffold lists a module item and its page or file separately: keep the captured target once.
  const links: ScaffoldLink[] = [];
  for (const l of raw) {
    const r = ctx.index.resources.get(l.resourceId);
    const target = r?.moduleItem ? ctx.index.itemTarget(r) ?? r : r;
    if (!target || links.some((x) => x.resourceId === target.id)) continue;
    links.push({ ...l, resourceId: target.id });
  }
  const isVideo = (r: Res) => {
    try {
      return classifyHost(new URL(r.moduleItem?.externalUrl ?? r.url).hostname).rule.kind === "video";
    } catch {
      return false;
    }
  };
  const moduleLink = links.find((l) => l.role === "module");
  // The scaffold caps its list, so its module link can be cut: then the module of its first material.
  const firstMaterial = links.find((l) => l.role !== "module");
  const fallbackModule = !moduleLink && firstMaterial ? ctx.index.modulesOf.get(firstMaterial.resourceId)?.[0] : undefined;
  const fallbackRes = fallbackModule ? ctx.index.modules.get(fallbackModule)?.resourceId : undefined;
  const moduleRes = moduleLink ? ctx.index.resources.get(moduleLink.resourceId) : fallbackRes ? ctx.index.resources.get(fallbackRes) : undefined;
  const moduleReason = moduleLink?.reason ?? (moduleRes && firstMaterial ? `the module of "${ctx.index.resources.get(firstMaterial.resourceId)?.title ?? ""}"` : "");

  const row = (link: ScaffoldLink): PageResource | null => {
    const r = ctx.index.resources.get(link.resourceId);
    if (!r) return null;
    return resourceRow(ctx, r, {
      title: r.moduleItem?.title ?? r.title,
      kind: ctx.index.contentType(r) ?? "page",
      reason: link.reason,
      reasons: [link.reason],
      strength: "session",
      score: 1,
      evidence: [linkEvidence(ctx, r, link, session)],
      url: r.moduleItem?.externalUrl ?? r.url,
    });
  };
  const materialLinks = links.filter((l) => l.role !== "module");
  const recordingLink = (l: ScaffoldLink) => {
    const r = ctx.index.resources.get(l.resourceId);
    return !!r && (isVideo(r) || RECORDING.test(r.title));
  };
  const slides = materialLinks
    .filter((l) => !recordingLink(l) && (l.role === "slides" || (l.role === "material" && roleOf(ctx, ctx.index.resources.get(l.resourceId)) === "lecture")))
    .map(row)
    .filter((x): x is PageResource => !!x)
    .slice(0, CAP);
  const readings = materialLinks.filter((l) => !recordingLink(l) && l.role === "reading").map(row).filter((x): x is PageResource => !!x).slice(0, CAP);
  if (!slides.length) miss("slides", "No slides found for this session.");
  if (!readings.length) miss("readings", "No reading found for this session.");

  // Recordings: video links the scaffold matched, in the session's module, or titled for this date. Kaltura is a link card.
  const recordings: PageResource[] = materialLinks.filter(recordingLink).map(row).filter((x): x is PageResource => !!x);
  const moduleId = moduleRes?.module?.id ?? moduleRes?.externalId;
  const moduleItems = moduleId ? ctx.index.modules.get(moduleId)?.items ?? [] : [];
  const [, mo, d] = date.split("-").map(Number);
  const dated = new RegExp(`(?<!\d)0?${mo}[/.-]0?${d}(?!\d)`);
  for (const r of [...moduleItems, ...[...ctx.index.resources.values()].filter((x) => dated.test(x.title))]) {
    if (!isVideo(r) && !RECORDING.test(r.title)) continue;
    if (recordings.some((x) => x.resourceId === r.id)) continue;
    const inModule = moduleItems.includes(r);
    recordings.push(
      resourceRow(ctx, r, {
        title: r.moduleItem?.title ?? r.title,
        kind: "recording",
        reason: inModule ? `in the session's module, "${moduleRes!.title}"` : "title names the session date",
        reasons: [inModule ? "same module" : "date in title"],
        strength: inModule ? "module" : "date",
        score: inModule ? 0.5 : 0.9,
        evidence: [inModule ? structureEvidence(ctx, moduleRes!, "module", moduleRes!.title, "module") : titleEvidence(ctx, r)],
        url: r.moduleItem?.externalUrl ?? r.url,
      }),
    );
  }
  if (!recordings.length) miss("recordings", "No recording or caption link found for this session.");

  // Key terms: the session materials' quoted term facts.
  const keyTerms: LectureSession["keyTerms"] = [];
  const seen = new Set<string>();
  for (const l of materialLinks) {
    const r = ctx.index.resources.get(l.resourceId);
    if (!r) continue;
    for (const f of store.materialFacts(l.resourceId)) {
      if (f.kind !== "term" || keyTerms.length >= 8) continue;
      const key = f.value.trim().toLowerCase();
      if (seen.has(key)) continue;
      const ev = f.basis === "text" ? textEvidence(ctx, r, f.start, f.end) : f.basis === "title" && r.title.slice(f.start, f.end) === f.value ? titleEvidence(ctx, r, f.start, f.end) : null;
      if (!ev) continue;
      seen.add(key);
      keyTerms.push({ term: f.value.trim(), evidence: ev });
    }
  }
  if (!keyTerms.length) miss("keyTerms", "No key terms were found in this session's materials.");

  // Assignments due within 7 days of the session that use its materials.
  const sessionIds = new Set(materialLinks.map((l) => l.resourceId));
  const until = addDays(date, 7);
  const dueSoon: LectureSession["dueSoon"] = [];
  for (const a of ctx.index.assignmentById.values()) {
    const at = a.dueAt;
    if (!at || localDay(at) < date || localDay(at) > until) continue;
    const used = references(store, a.id).find((ref) => ref.resourceId && sessionIds.has(ref.resourceId));
    if (!used) continue;
    const quote = /"([^"]{3,})"/.exec(used.reason)?.[1];
    const ev = quote ? quoteEvidence(ctx, a, quote) : null;
    dueSoon.push({
      resourceId: a.id,
      title: a.title,
      dueAt: at,
      reason: `uses "${used.title}" (${used.reason})`,
      evidence: [fieldEvidence(ctx, a, "dueAt", at), ev ?? structureEvidence(ctx, a, "reference", used.reason)],
      open: { how: "browser", url: a.url, resourceId: a.id, note: null },
    });
  }
  dueSoon.sort((x, y) => x.dueAt.localeCompare(y.dueAt));
  if (!dueSoon.length) miss("dueSoon", "No assignment due within 7 days uses this session's materials.");

  // Office hours that day, as posted.
  const day = weekdayOf(date);
  const officeHours = officeHourLines(ctx)
    .filter((l) => l.weekdays.includes(day))
    .map((l) => ({ text: l.text, evidence: l.evidence }));
  if (!officeHours.length) miss("officeHours", "No office hours posted for this weekday.");

  const note = found && store.notes ? store.notes.noteBySession(accountScope, course.courseId, session.id) : undefined;
  const page: Omit<LectureSession, "factHash"> & { factHash: string } = {
    view: "lecture.session",
    generatedAt: now,
    factHash: "",
    course: { ...course, courseName: ctx.courseName, url: ctx.courseUrl },
    session: found
      ? {
          id: session.id,
          type: session.type,
          date: session.date,
          startMinute: session.startMinute,
          endMinute: session.endMinute,
          title: session.title,
          location: session.location,
          origin: session.origin,
          typeBasis: session.typeBasis,
          module: moduleRes ? { id: moduleRes.module?.id ?? moduleRes.externalId, title: moduleRes.title, reason: moduleReason } : null,
        }
      : null,
    scaffold: sc ? { blocks: sc.head, hash: sc.hash } : null,
    note: note && store.notes ? noteSummary(store.notes, note) : null,
    slides,
    readings,
    recordings: recordings.slice(0, CAP),
    keyTerms,
    dueSoon: dueSoon.slice(0, CAP),
    officeHours,
    missing,
  };
  page.factHash = factHash(JSON.parse(JSON.stringify(page, (k, v) => (k === "generatedAt" || k === "freshness" || k === "factHash" ? undefined : v))));
  return page;
}
