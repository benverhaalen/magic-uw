/**
 * `assessment.page {assessmentId}` (owner: page-views): a fixed template for one exam or quiz.
 *   1. posted details, each with every source (a disagreement shows both);
 *   2. the scope in the instructor's words, and the modules code maps it to;
 *   3. relevant materials by tier (spec C5: Core ≤8, Also useful ≤6, Practice ≤5, the rest collapsed);
 *   4. practice (the exam blueprint when built; otherwise topic practice targets);
 *   5. a formula or glossary sheet from quoted facts, only if the course allows notes or sheets;
 *   6. readiness per topic and a day-by-day plan to the exam date (code);
 *   7. office hours between now and the exam.
 * Reads only; 0 tokens.
 */
import type { AssessmentPage, CourseRef, PageEvidence, PageMissing, PageResource, Resource } from "@magic/contracts";
import { courseInclusion } from "../access";
import { references, STRUCTURE_COVERS_WEIGHT } from "../graph/references";
import { courseIndex, type Res } from "../graph/course-index";
import { approachFacts, readApproach } from "./approach";
import { hashPage } from "./assignment";
import {
  PageViewError,
  addDays,
  contextFor,
  courseOf,
  fieldEvidence,
  included,
  localDay,
  namer,
  officeHourLines,
  quoteEvidence,
  resourceRow,
  roleOf,
  showDate,
  structureEvidence,
  textEvidence,
  titleEvidence,
  weekdayOf,
  type ViewContext,
  type ViewStore,
} from "./common";
import { postedDetails, sheetRule, subjectFor, type Subject, type Window } from "./details";
import { gradeBank, offerRow, offersFor, stakesOf } from "./grades";
import { readinessFor, topicReader } from "./readiness";

export const CAPS = { core: 8, alsoUseful: 6, practice: 5, floor: 5 };
/** Minutes per remaining topic by state: starting values, not validated. */
export const MINUTES_PER_TOPIC: Record<string, number> = { not_seen: 30, iffy: 25, getting_there: 15 };
export const DAY_CAP_MINUTES = 90;
const PRACTICE_TITLE = /\b(practice|sample|review|old|past|previous|mock|solutions?|key)\b/i;
/** The course-mastery builder's slice (`course.mastery`, assessment scope) plugs in here when it lands. */
export const MASTERY_NOT_BUILT = { status: "not_built" as const, message: "Course mastery isn't on this build yet.", slice: null };

const SCOPE_WORDS = /\b(covers?|covered|covering|material from|topics?|includes?|scope)\b/i;
const SCOPE_UNITS = /\b(chapters?|ch\.|sections?|lectures?|weeks?|modules?|units?|topics?|material)\b/i;
const UNIT_LIST = /\b(chapters?|ch\.?|weeks?|wk|modules?|units?|lectures?|lec)\s*((?:\d{1,2}\s*(?:-|–|to|through|,|and|&)?\s*)+)/gi;
const unitKind = (w: string) => (/^ch/i.test(w) ? "chapter" : /^w/i.test(w) ? "week" : /^mod/i.test(w) ? "module" : /^unit/i.test(w) ? "unit" : "lecture");
/** "chapters 1-4", "weeks 2, 3 and 5" → { chapter: {1,2,3,4} } */
export function scopeUnits(text: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const m of text.matchAll(UNIT_LIST)) {
    const kind = unitKind(m[1]!);
    const set = out.get(kind) ?? new Set<number>();
    const list = m[2]!;
    for (const r of list.matchAll(/(\d{1,2})\s*(?:(?:-|–|to|through)\s*(\d{1,2}))?/g)) {
      const a = Number(r[1]);
      const b = r[2] ? Number(r[2]) : a;
      for (let n = Math.min(a, b); n <= Math.max(a, b) && n - Math.min(a, b) < 40; n++) set.add(n);
    }
    out.set(kind, set);
  }
  return out;
}

interface Candidate {
  r: Res;
  tier: "core" | "alsoUseful" | "practice";
  score: number;
  strength: string;
  reasons: string[];
  evidence: PageEvidence[];
}

function resolveSubject(store: ViewStore, assessmentId: string): { course: CourseRef } {
  const row = store.assessments().find((a) => a.id === assessmentId);
  if (row) return { course: { accountScope: row.accountScope, courseId: row.courseId } };
  return { course: courseOf(store, assessmentId).course };
}

/** Due items per local day across the student's included courses (the "free days" the plan fits into). */
function busyDays(ctx: ViewContext, from: string, to: string): Map<string, number> {
  const busy = new Map<string, number>();
  const courses = new Map<string, CourseRef>();
  for (const s of ctx.sources.values())
    if (s.kind === "canvas" && s.accountScope === ctx.course.accountScope && /^\d+$/.test(s.courseId)) courses.set(s.courseId, { accountScope: s.accountScope, courseId: s.courseId });
  const indexes = [...courses.values()].map((c) => courseIndex(ctx.store, c));
  const courseRows = indexes.flatMap((ix) => [...ix.resources.values()].filter((r) => r.kind === "course"));
  const list = [...ctx.sources.values()];
  const include = courseInclusion(Object.assign(Object.create(ctx.store) as ViewStore, { resources: () => courseRows as Resource[], sources: () => list }));
  for (const ix of indexes) {
    const courseRow = [...ix.resources.values()].find((r) => r.kind === "course");
    if (courseRow && !include(courseRow)) continue;
    for (const a of ix.assignmentById.values()) {
      if (!a.dueAt || a.submitted === true || a.submission?.submittedAt) continue;
      const day = localDay(a.dueAt);
      if (day >= from && day <= to) busy.set(day, (busy.get(day) ?? 0) + 1);
    }
  }
  return busy;
}

function scopeOf(ctx: ViewContext, s: Subject, windows: Window[]): AssessmentPage["scope"] {
  const quotes: PageEvidence[] = [];
  const texts: string[] = [];
  if (s.row)
    for (const sc of ctx.store.assessmentScopes(s.row.id)) {
      const r = sc.evidence ? ctx.index.resources.get(sc.evidence.resourceId) : undefined;
      const ev = r && sc.evidence && r.text.slice(sc.evidence.start, sc.evidence.end) === sc.evidence.quote ? textEvidence(ctx, r, sc.evidence.start, sc.evidence.end) : null;
      quotes.push(ev ?? fieldEvidence(ctx, null, "assessment_scopes.stated", sc.stated, "course_map", `Course map: ${s.title}`));
      texts.push(sc.stated);
    }
  const brief = ctx.store.courseBrief(ctx.course);
  const syllabus = brief ? ctx.index.resources.get(brief.syllabusResourceId) : undefined;
  const names = namer(ctx, s.title, null);
  for (const b of brief?.brief.assessments ?? []) {
    if (!b.scope || !names.text(b.title)) continue;
    const ev = syllabus && syllabus.text.slice(b.start, b.end) === b.quote ? textEvidence(ctx, syllabus, b.start, b.end) : null;
    quotes.push(ev ? { ...ev, origin: "course_profile" } : fieldEvidence(ctx, null, "brief.assessments.scope", b.scope, "course_profile", "Course profile"));
    texts.push(b.scope);
  }
  for (const w of windows) {
    if (!SCOPE_WORDS.test(w.line) || !SCOPE_UNITS.test(w.line) || /\blate|office hours\b/i.test(w.line)) continue;
    if (quotes.some((q) => q.resourceId === w.r.id && q.quote === w.line)) continue;
    const ev = textEvidence(ctx, w.r, w.start, Math.min(w.end, w.start + 300), w.statedAt);
    if (ev) {
      quotes.push(ev);
      texts.push(w.line);
    }
  }
  // Modules the scope names: the same unit and number in the module title, or its title verbatim.
  const units = scopeUnits(texts.join("\n"));
  const all = texts.join("\n").toLowerCase();
  const modules: AssessmentPage["scope"]["modules"] = [];
  for (const m of ctx.index.modules.values()) {
    if (!m.title) continue;
    let reason: string | null = null;
    for (const t of m.title.matchAll(/\b(chapters?|ch\.?|weeks?|wk|modules?|units?|lectures?|lec)\s*#?\s*(\d{1,2})\b/gi)) {
      const kind = unitKind(t[1]!);
      if (units.get(kind)?.has(Number(t[2]))) {
        reason = `the scope names ${kind} ${Number(t[2])}`;
        break;
      }
    }
    if (!reason && m.title.length >= 6 && all.includes(m.title.toLowerCase())) reason = "the scope names this module";
    if (reason) modules.push({ moduleId: m.id, title: m.title, reason });
  }
  modules.sort((a, b) => (ctx.index.modules.get(a.moduleId)?.position ?? 0) - (ctx.index.modules.get(b.moduleId)?.position ?? 0));
  return {
    stated: quotes.length > 0,
    quotes: quotes.slice(0, 6),
    modules,
    text: quotes.length ? `In the instructor's words (${quotes.length} source${quotes.length === 1 ? "" : "s"}).` : "Scope not stated by the instructor.",
  };
}

export function assessmentPage(store: ViewStore, assessmentId: string, now: string): AssessmentPage {
  const { course } = resolveSubject(store, assessmentId);
  const ctx = contextFor(store, course, now);
  const s = subjectFor(ctx, assessmentId);
  const anyRes = s.resource ?? [...ctx.index.resources.values()].find((r) => r.kind === "course");
  if (anyRes && !included(ctx)(anyRes)) throw new PageViewError("This course is excluded. Include it in Sources to see this assessment.");
  const missing: PageMissing[] = [];
  const miss = (field: string, text: string) => missing.push({ field, text });

  // 1. Posted details (the grade bank's share joins the weight sources when it is a real number).
  const bank = gradeBank(ctx);
  const grade = s.resource
    ? bank.shareOf(s.resource)
    : bank.shareOfRow(s.title, s.row?.weight ?? null, s.row?.weight != null ? fieldEvidence(ctx, null, "assessments.weight", s.row.weight, "course_map", `Course map: ${s.title}`) : null);
  const share = grade.sharePercent !== null && (grade.basis === "computed" || grade.basis === "syllabus") ? { percent: grade.sharePercent, evidence: grade.evidence } : null;
  const posted = postedDetails(ctx, s, share);
  for (const d of posted.details) if (d.status === "missing") miss(d.field, d.text);
  const examDay = posted.date ? localDay(posted.date) : null;

  // 2. Scope.
  const scope = scopeOf(ctx, s, posted.windows);
  if (!scope.stated) miss("scope", "Scope not stated by the instructor.");

  // 3. Materials by tier.
  const own = new Set([...s.copies.map((c) => c.id), ...(s.resource ? [s.resource.id] : [])]);
  const candidates = new Map<string, Candidate>();
  const offer = (r: Res | undefined, tier: Candidate["tier"], score: number, strength: string, reason: string, evidence: PageEvidence[]) => {
    if (!r || own.has(r.id) || r.kind === "message" || r.kind === "event") return;
    const role = roleOf(ctx, r);
    if (role === "admin") return;
    // Practice: past or sample exams, solutions, problem sets and quizzes; an exam-info page is Core.
    const practice = role === "solutions" || role === "homework" || r.kind === "assignment" || (role === "exam" && PRACTICE_TITLE.test(r.title));
    const t = practice && strength !== "direct" ? "practice" : tier;
    const kept = candidates.get(r.id);
    if (!kept) return void candidates.set(r.id, { r, tier: t, score, strength, reasons: [reason], evidence });
    if (!kept.reasons.includes(reason)) kept.reasons.push(reason);
    for (const e of evidence) if (!kept.evidence.some((k) => k.quote === e.quote)) kept.evidence.push(e);
    const rank = { core: 0, alsoUseful: 1, practice: 2 };
    if (rank[t] < rank[kept.tier] && t !== "practice") kept.tier = t;
    if (score > kept.score) Object.assign(kept, { score, strength });
  };
  if (s.resource)
    for (const ref of references(store, s.resource.id)) {
      const target = ref.resourceId ? ctx.index.resources.get(ref.resourceId) : undefined;
      if (!target) continue;
      const quote = /"([^"]{3,})"/.exec(ref.reason)?.[1]?.replace(/…$/, "") ?? null;
      const ev =
        (quote && (s.copies.map((c) => quoteEvidence(ctx, c, quote)).find(Boolean) ?? quoteEvidence(ctx, target, quote) ?? (ctx.index.syllabus ? quoteEvidence(ctx, ctx.index.syllabus, quote) : null))) ||
        structureEvidence(ctx, target, "reference", quote ?? ref.reason);
      const tier = ref.strength === "direct" || ref.strength === "named" || (ref.strength === "covers" && ref.weight > STRUCTURE_COVERS_WEIGHT) ? "core" : "alsoUseful";
      offer(target, tier, ref.weight, ref.strength, ref.reason, [ev]);
    }
  for (const m of scope.modules) {
    const entry = ctx.index.modules.get(m.moduleId);
    const header = entry?.resourceId ? ctx.index.resources.get(entry.resourceId) ?? null : null;
    for (const item of entry?.items ?? []) {
      const target = ctx.index.itemTarget(item) ?? (item.text ? item : undefined);
      const role = roleOf(ctx, target);
      offer(target, "core", 0.7 + (role === "lecture" || role === "reading" ? 0.05 : 0), "scope", `in "${m.title}", which ${m.reason.replace(/^the /, "the ")}`, [structureEvidence(ctx, header, "module", m.title, "module")]);
    }
  }
  const names = namer(ctx, s.title, s.resource?.externalId ?? null);
  for (const r of [...ctx.index.pageBySlug.values(), ...ctx.index.fileById.values()]) {
    if (own.has(r.id) || !names.text(r.title)) continue;
    offer(r, "core", 0.75, "named", "its title names the assessment", [titleEvidence(ctx, r)]);
  }
  for (const l of store.mapLinks(ctx.course)) {
    if (!l.current || l.status === "rejected" || l.fromKind !== "assessment" || (l.fromId !== s.id && l.fromId !== s.row?.id)) continue;
    const target = ctx.index.resources.get(l.toResourceId);
    offer(target, l.tier === "core" ? "core" : l.tier === "practice" ? "practice" : "alsoUseful", l.tier === "core" ? 0.9 : 0.5, "map", `course map: ${l.reason}`, [structureEvidence(ctx, target ?? null, "map_links", l.reason, "course_map")]);
  }
  const posting = (r: Res) => r.unlockAt ?? r.createdAt ?? r.file?.updatedAt ?? null;
  const dateGap = (r: Res) => (examDay && posting(r) ? Math.abs(Date.parse(examDay) - Date.parse(posting(r)!)) : Infinity);
  const sorted = [...candidates.values()].sort((a, b) => b.score - a.score || dateGap(a.r) - dateGap(b.r) || a.r.title.localeCompare(b.r.title));
  const row = (c: Candidate, provisional = false): PageResource =>
    resourceRow(ctx, c.r, { title: c.r.title, kind: ctx.index.contentType(c.r) ?? "page", reason: c.reasons[0]!, reasons: c.reasons, strength: c.strength, score: c.score + 0.05 * (c.reasons.length - 1), evidence: c.evidence.slice(0, 3), provisional });
  let core = sorted.filter((c) => c.tier === "core").slice(0, CAPS.core).map((c) => row(c));
  const alsoUseful = sorted.filter((c) => c.tier === "alsoUseful").slice(0, CAPS.alsoUseful).map((c) => row(c));
  const practiceRows = sorted.filter((c) => c.tier === "practice").slice(0, CAPS.practice).map((c) => row(c));
  let provisional = false;
  // The floor (spec C5): no stated scope and no Core: the top items by date window, marked provisional.
  if (!scope.stated && !core.length && examDay) {
    const others = store.assessments(ctx.course).filter((a) => a.id !== s.id && a.date && localDay(a.date) < examDay).map((a) => localDay(a.date!));
    const start = others.sort().pop() ?? addDays(examDay, -42);
    const floor = [...ctx.index.pageBySlug.values(), ...ctx.index.fileById.values()]
      .filter((r) => r.text && !own.has(r.id) && !candidates.has(r.id) && posting(r) && localDay(posting(r)!) > start && localDay(posting(r)!) <= examDay)
      .filter((r) => !["admin", "syllabus", "solutions"].includes(roleOf(ctx, r) ?? ""))
      .sort((a, b) => posting(b)!.localeCompare(posting(a)!))
      .slice(0, CAPS.floor);
    core = floor.map((r) =>
      row({ r, tier: "core", score: 0.2, strength: "date", reasons: [`posted ${localDay(posting(r)!)}, before the exam (provisional: the scope isn't stated)`], evidence: [fieldEvidence(ctx, r, r.unlockAt ? "unlockAt" : r.createdAt ? "createdAt" : "file.updatedAt", posting(r)!)] }, true),
    );
    provisional = core.length > 0;
  }
  if (!core.length && !alsoUseful.length && !practiceRows.length) miss("materials", "No material is linked to this assessment, named for it or in a module its scope names.");

  // 4-6. Readiness, practice and the sheet.
  const anchors = s.resource ? [s.resource.id] : core.map((c) => c.resourceId).filter((x): x is string => !!x);
  const readiness = readinessFor(ctx, s.resource ? { resourceId: s.resource.id, assessmentId: s.id } : { assessmentId: s.id }, anchors);
  if (readiness.status !== "ok") miss("readiness", readiness.message);
  const allowed = posted.details.find((d) => d.field === "allowed_materials");
  const rule = sheetRule(allowed);
  const entries: AssessmentPage["sheet"]["entries"] = [];
  if (rule.status === "allowed")
    for (const c of [...core, ...alsoUseful]) {
      const r = c.resourceId ? ctx.index.resources.get(c.resourceId) : undefined;
      if (!r) continue;
      for (const f of store.materialFacts(r.id)) {
        if ((f.kind !== "formula" && f.kind !== "definition") || f.basis !== "text" || entries.length >= 40) continue;
        const ev = textEvidence(ctx, r, f.start, f.end);
        if (ev) entries.push({ kind: f.kind, value: f.kind === "formula" ? ev.quote : f.value, evidence: ev });
      }
    }
  if (rule.status === "allowed" && !entries.length) miss("sheet", "Notes are allowed, but no formula or definition was found in the scope's materials.");

  // 6. The plan: remaining topics × minutes, fitted into the free days before the exam.
  const today = localDay(now);
  const remaining = readiness.topics.filter((t) => t.state !== "solid");
  const order = [...readiness.studyNext.map((x) => x.conceptId), ...remaining.map((t) => t.conceptId)].filter((id, i, all) => all.indexOf(id) === i && remaining.some((t) => t.conceptId === id));
  let plan: AssessmentPage["plan"];
  const perTopic = Object.entries(MINUTES_PER_TOPIC).map(([state, minutes]) => ({ state, minutes, basis: "starting value, not validated" }));
  if (!examDay) plan = { status: "no_date", text: "No exam date is posted, so there's no plan to a date.", days: [], minutesPerTopic: perTopic };
  else if (examDay <= today) plan = { status: "past", text: `The exam date (${showDate(examDay)}) is today or past.`, days: [], minutesPerTopic: perTopic };
  else if (!order.length) plan = { status: "no_topics", text: "No practice topics are linked yet, so there's nothing to plan by topic.", days: [], minutesPerTopic: perTopic };
  else {
    const last = addDays(examDay, -1);
    const busy = busyDays(ctx, today, last);
    const window: string[] = [];
    for (let d = today; d <= last; d = addDays(d, 1)) window.push(d);
    const free = window.filter((d) => !busy.get(d));
    const days = (free.length ? free : [...window].sort((a, b) => (busy.get(a) ?? 0) - (busy.get(b) ?? 0) || a.localeCompare(b))).map((date) => ({ date, minutes: 0, topics: [] as { conceptId: string; label: string; minutes: number }[], busy: busy.get(date) ?? 0 }));
    for (const id of order) {
      const t = remaining.find((x) => x.conceptId === id)!;
      const minutes = MINUTES_PER_TOPIC[t.state] ?? 30;
      const day = [...days].sort((a, b) => a.minutes - b.minutes || a.date.localeCompare(b.date))[0]!;
      day.topics.push({ conceptId: id, label: t.label, minutes });
      day.minutes += minutes;
    }
    const used = days.filter((d) => d.topics.length).sort((a, b) => a.date.localeCompare(b.date));
    const total = used.reduce((n, d) => n + d.minutes, 0);
    const over = used.some((d) => d.minutes > DAY_CAP_MINUTES);
    plan = {
      status: "ok",
      text: `${order.length} topic${order.length === 1 ? "" : "s"}, about ${total} minutes over ${used.length} ${free.length ? "free " : ""}day${used.length === 1 ? "" : "s"} before ${showDate(examDay)}${over ? `; some days run past ${DAY_CAP_MINUTES} minutes` : ""}.`,
      days: used,
      minutesPerTopic: perTopic,
    };
  }

  // 7. Office hours between now and the exam.
  const lines = officeHourLines(ctx);
  const officeHours: AssessmentPage["officeHours"] = [];
  const endDay = examDay ?? addDays(today, 13);
  for (let d = today; d <= endDay && officeHours.length < 20; d = addDays(d, 1))
    for (const l of lines) if (l.weekdays.includes(weekdayOf(d))) officeHours.push({ date: d, text: l.text, evidence: l.evidence });
  if (!officeHours.length) miss("officeHours", lines.length ? "No posted office hours fall before the exam." : "No office hours posted.");

  const offers = s.resource
    ? offerRow(ctx, bank, s.resource, topicReader(ctx)).offers
    : offersFor(ctx, { id: s.id, resourceId: null, kind: s.kind, stakes: stakesOf(s.kind, grade) }, { resourceIds: core.map((c) => c.resourceId).filter((x): x is string => !!x), topicIds: readiness.topics.map((t) => t.conceptId) }, stakesOf(s.kind, grade) === "high" ? rule : null);

  const page: Omit<AssessmentPage, "approach"> = {
    view: "assessment.page",
    generatedAt: now,
    factHash: "",
    course: { ...course, courseName: ctx.courseName, url: ctx.courseUrl },
    assessment: { id: s.id, resourceId: s.resource?.id ?? null, title: s.title, kind: s.kind, url: s.resource?.url ?? null, origin: s.row?.origin ?? "canvas" },
    details: posted.details,
    scope,
    materials: { core, alsoUseful, practice: practiceRows, allInScope: { count: candidates.size, resourceIds: sorted.map((c) => c.r.id).slice(0, 60) }, provisional },
    practice: {
      blueprint: null,
      practiceExam: null,
      message: readiness.targets.length ? "The exam blueprint and practice exam aren't built yet; practice these topics instead." : "The exam blueprint and practice exam aren't built yet, and no practice topics are linked yet.",
      targets: readiness.targets,
    },
    sheet: { status: rule.status, text: rule.text, policy: allowed?.claims.map((c) => c.evidence) ?? [], entries },
    readiness,
    plan,
    officeHours,
    grade,
    offers,
    mastery: MASTERY_NOT_BUILT,
    missing,
  };
  page.factHash = hashPage(page);
  const approach = readApproach(ctx, page.factHash, approachFacts(page), { courseId: course.courseId, assessmentId: s.id });
  return { ...page, approach };
}
