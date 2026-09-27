/**
 * owner: study-prep. The `study.prep` query: one composite read, from the local database only, 0
 * tokens (nothing is generated until the student clicks). With an item it answers the item's
 * space: what it is (type and reason), when and where, its status, what the student needs (its
 * instructions, linked materials with reasons, sessions, announcements), the catered sections, the
 * study materials with their state and freshness, readiness, and the cards due for it. Without an
 * item it lists upcoming exams and quizzes (one course, or every included course) with what is
 * prepared for each, and, for one course, each assignment's study state.
 */
import {
  ITEM_SPACE,
  STUDY_PREP_KINDS,
  type QueryRequest,
  type Resource,
  type Store,
  type StudyPrepCard,
  type StudyPrepItem,
  type StudyPrepItemState,
  type StudyPrepKind,
  type StudyPrepMastery,
  type StudyPrepMaterial,
  type StudyPrepOverview,
  type StudyPrepQuizItem,
  type StudyPrepQuote,
  type StudyPrepResult,
  type StudyPrepSections,
  type StudyPrepUpcoming,
} from "@magic/contracts";
import { createExamEvidence, type ExamAssessment } from "../../../learning/src/exam/evidence";
import type { BlueprintEvidence } from "../../../learning/src/exam/types";
import { createMastery, createMasteryMemo, type MasteryMemo } from "../../../learning/src/mastery/index";
import { memoReferences, referenceFingerprint, type ReferencesMemo } from "../../../learning/src/mastery/references-memo";
import type { LearningCard, StoredItem } from "../../../learning/src/store";
import { createPipelineReferences } from "../graph/references-port";
import { isPipelineStore } from "../graph/course-index";
import { courseInclusion } from "../access";
import { STUDY_PREP_PACK_VERSION } from "../../../packs/study-prep/src/index";
import { allScopeHash, collapse, courseRows, courseScope, dueOf, isPrepStore, loadPrep, selectScope, type Prep, type PrepStore, type Selection } from "./scope";
import { GENERATING_TIMEOUT_MS, readRecord, type PrepRecord } from "./records";
import { codeType, decideType, readTypes } from "./item-type";
import { latestItems, linkedReview, readLinks } from "./links";
import { announcementsFor, buildSections, sessionsFor } from "./sections";

type Request = Extract<QueryRequest, { view: "study.prep" }>;
const DAY = 86_400_000;
const MAX_TERMS = 24;
const ASSIGNMENT_HORIZON_DAYS = 60;

function daysAway(date: string | null, now: Date): number | null {
  if (!date) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00` : date);
  if (!Number.isFinite(t)) return null;
  const startOf = (ms: number) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  return Math.round((startOf(t) - startOf(now.getTime())) / DAY);
}

function statusOf(r: Resource | null, now: Date): StudyPrepItem["status"] {
  if (!r) return { submitted: false, graded: null, missing: false, availability: "unknown" };
  const s = r.submission;
  const lock = r.lockAt ? Date.parse(r.lockAt) : NaN;
  const unlock = r.unlockAt ? Date.parse(r.unlockAt) : NaN;
  return {
    submitted: r.submitted === true || !!s?.submittedAt,
    graded: s?.grade ?? (s?.score != null ? String(s.score) : null),
    missing: s?.missing === true,
    availability: Number.isFinite(unlock) && unlock > now.getTime() ? "not_yet_open" : Number.isFinite(lock) && lock <= now.getTime() ? "closed" : "open",
  };
}

function weightOf(row: { weight: number | null } | null, r: Resource | null): StudyPrepItem["weight"] {
  if (row?.weight != null) return { percent: row.weight, of: "course", group: null };
  const g = r?.assignmentGroup?.weight;
  return g != null && g > 0 ? { percent: g, of: "group", group: null } : null;
}

function itemView(prep: Prep, now: Date): StudyPrepItem {
  const s = prep.subject;
  const row = prep.evidence?.assessment ?? (s.row ? { weight: s.row.weight } : null);
  return {
    id: s.id,
    kind: s.kind,
    type: s.type,
    typeReason: s.typeReason,
    typeBasis: s.typeBasis,
    resourceId: s.resource?.id ?? null,
    title: s.title,
    courseId: prep.courseId,
    courseName: prep.label,
    date: s.date,
    daysAway: daysAway(s.date, now),
    where: prep.where?.quote ?? null,
    points: s.resource?.points ?? null,
    weight: weightOf(row, s.resource),
    status: statusOf(s.resource, now),
    url: s.resource?.url ?? null,
  };
}

function quoteOf(prep: Prep, e: BlueprintEvidence): StudyPrepQuote | null {
  if (!e.resourceId || !e.quote) return null;
  const r = prep.resourceById.get(e.resourceId);
  return { resourceId: e.resourceId, title: r?.title ?? e.title, url: r?.url ?? null, quote: e.quote, start: e.start, end: e.end };
}

const FORMAT_WORD: Record<string, string> = {
  multiple_choice: "multiple choice", true_false: "true/false", short_answer: "short answer", numeric: "numeric", problem: "worked problems", essay: "essay", code: "code", proof: "proofs", matching: "matching", fill_blank: "fill in the blank",
};

function overviewOf(prep: Prep, sel: Selection): StudyPrepOverview {
  const bp = prep.blueprint;
  const covered = (bp?.scope.statements ?? []).slice(0, 4).map((s) => ({ text: collapse(s.quote ?? ""), source: quoteOf(prep, s) })).filter((c) => c.text);
  const keyTerms: StudyPrepOverview["keyTerms"] = [];
  const seen = new Set<string>();
  for (const r of sel.resources) {
    if (keyTerms.length >= MAX_TERMS) break;
    for (const f of prep.facts(r.id)) {
      if (keyTerms.length >= MAX_TERMS) break;
      if (f.kind !== "term" && f.kind !== "definition" && f.kind !== "formula") continue;
      const value = collapse(f.value);
      const k = `${f.kind}:${value.toLowerCase()}`;
      if (!value || value.length > 240 || seen.has(k)) continue;
      seen.add(k);
      const inText = f.basis === "text" || !f.basis;
      keyTerms.push({ kind: f.kind, value, source: { resourceId: r.id, title: r.title, url: r.url, quote: inText ? r.text.slice(f.start, f.end) : (f.quote ?? value), start: inText ? f.start : null, end: inText ? f.end : null } });
    }
  }
  const s = prep.subject;
  const dates: StudyPrepOverview["dates"] = [];
  if (bp?.scope.window.start && bp.scope.window.basis !== "none") dates.push({ label: "Coverage starts", date: bp.scope.window.start });
  if (s.date) dates.push({ label: s.title, date: s.date });
  const formats = (bp?.formatMix ?? []).map((f) => FORMAT_WORD[f.format] ?? f.format.replace(/_/g, " "));
  const noLinks = prep.wholeCourse ? ["Nothing links course materials to this item yet, so every course material is a source."] : [];
  return {
    covered,
    modules: (bp?.scope.modules ?? []).map((m) => m.label),
    topics: prep.topics.map(({ id, label }) => ({ id, label })),
    keyTerms,
    dates,
    format: bp ? (formats.length ? `${formats.join(", ")}. ${bp.basis}` : bp.basis) : null,
    length: bp?.length ? `${bp.length.minutes} minutes` : null,
    warnings: [...noLinks, ...(bp?.warnings ?? []).filter((w) => !(prep.wholeCourse && /coverage statement/i.test(w)))],
  };
}

/**
 * Per store: the references port's answers while the course fingerprint holds (the learning
 * router's own memo over the same reads), and mastery's as-of memo. Building the port's answers
 * reads every resource; the fingerprint that guards them costs a few milliseconds.
 */
const memos = new WeakMap<object, { refs: Map<string, ReferencesMemo>; mastery: MasteryMemo }>();
function courseMastery(store: PrepStore, courseRef: string, accountScope: string, courseId: string, now: Date) {
  if (!isPipelineStore(store)) return null;
  try {
    let memo = memos.get(store);
    if (!memo) memos.set(store, (memo = { refs: new Map(), mastery: createMasteryMemo() }));
    const references = memoReferences(createPipelineReferences(store), referenceFingerprint(store, { accountScope, courseId }), memo.refs, courseRef);
    return createMastery({ store: store.learning, ref: courseRef, courseId, references, now }, memo.mastery);
  } catch {
    return null;
  }
}
type Mastery = NonNullable<ReturnType<typeof courseMastery>>;
const masteryLabel = (counts: StudyPrepMastery["counts"], total: number): string => (total ? `Mastered ${counts.solid} of ${total} topic${total === 1 ? "" : "s"}` : "No topics linked yet");
function masteryOf(m: Mastery | null, prep: Prep): { summary: StudyPrepMastery | null; topics: NonNullable<StudyPrepSections["readiness"]> } {
  if (!m) return { summary: null, topics: [] };
  try {
    const s = prep.subject;
    const slice = m.assessment(s.id) ?? (s.resource ? m.assessment(s.resource.id) : null);
    if (slice) {
      const c = slice.assessment.counts;
      return {
        summary: { label: slice.assessment.label, counts: { solid: c.solid, getting_there: c.getting_there, iffy: c.iffy, not_seen: c.not_seen }, total: slice.assessment.topicIds.length },
        topics: slice.topics.map((t) => ({ topicId: t.topicId, label: t.label, state: t.state, stateLabel: t.stateLabel })),
      };
    }
    // Any other item: the states of its topics.
    const ids = new Set(prep.topics.map((t) => t.id));
    const topics = m.course().topics.filter((t) => ids.has(t.topicId));
    const counts = { solid: 0, getting_there: 0, iffy: 0, not_seen: 0 };
    for (const t of topics) counts[t.state]++;
    return { summary: { label: masteryLabel(counts, topics.length), counts, total: topics.length }, topics: topics.map((t) => ({ topicId: t.topicId, label: t.label, state: t.state, stateLabel: t.stateLabel })) };
  } catch {
    return { summary: null, topics: [] };
  }
}

/** Code decides freshness: every source in the selection at the content hash the record was made from. */
export function changedSince(record: Pick<PrepRecord, "sources" | "packVersion">, current: Map<string, Resource> | Selection): string[] {
  const now = current instanceof Map ? current : new Map(current.resources.map((r) => [r.id, r]));
  const out: string[] = [];
  for (const s of record.sources) {
    const r = now.get(s.resourceId);
    if (!r) out.push(`${s.title} (removed)`);
    else if (r.contentHash !== s.contentHash) out.push(r.title);
  }
  if (!(current instanceof Map)) {
    const before = new Set(record.sources.map((s) => s.resourceId));
    for (const r of current.resources) if (!before.has(r.id)) out.push(`${r.title} (added)`);
  }
  return out;
}

function recordState(record: PrepRecord | null, current: Map<string, Resource> | Selection, now: Date) {
  if (!record) return { status: "missing" as const, shown: null, changed: [] as string[], message: null as string | null };
  const interrupted = record.status === "generating" && (!record.startedAt || now.getTime() - Date.parse(record.startedAt) > GENERATING_TIMEOUT_MS);
  const shown = record.status === "ready" ? record : (record.previous ?? null);
  const changed = shown ? changedSince(shown, current) : [];
  const status: StudyPrepMaterial["status"] =
    record.status === "generating" && !interrupted ? "generating" : record.status === "failed" || interrupted ? "failed" : changed.length || record.packVersion !== STUDY_PREP_PACK_VERSION ? "stale" : "ready";
  return { status, shown, changed, message: interrupted ? "Generation was interrupted. Try again." : record.status === "failed" ? record.message : null };
}
const countOf = (kind: StudyPrepKind, r: Omit<PrepRecord, "previous">) =>
  kind === "guide" ? (r.guide?.sections.length ?? 0) : kind === "exam" ? (r.exam?.problems.length ?? 0) : kind === "problems" ? (r.problems?.length ?? 0) : kind === "outline" ? (r.outline?.sections.length ?? 0) : r.itemIds.length;

export function materialsOf(store: PrepStore, prep: Prep, sel: Selection, now: Date, items: Map<string, StoredItem>, cards: LearningCard[]): Record<StudyPrepKind, StudyPrepMaterial> {
  const cardOf = new Map(cards.filter((c) => !c.isConceptTrack).map((c) => [c.itemId, c]));
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();
  const labels = new Map(prep.concepts.map((c) => [c.id, c.studentLabel ?? c.label]));
  const quote = (x: StoredItem): StudyPrepQuote => {
    const s = x.sources[0];
    const r = s ? (prep.resourceById.get(s.resourceId) ?? store.resource(s.resourceId)) : undefined;
    return { resourceId: s?.resourceId ?? null, title: r?.title ?? "", url: r?.url ?? null, quote: s?.quote ?? "", start: s && s.quoteValid ? s.start : null, end: s && s.quoteValid ? s.end : null };
  };
  const topics = (x: StoredItem) => [...x.tags].sort((a, b) => Number(b.primary) - Number(a.primary)).map((t) => labels.get(t.conceptId)).filter((l): l is string => !!l);
  const quizOf = (ids: string[]): StudyPrepQuizItem[] =>
    ids.flatMap((id) => {
      const x = items.get(id);
      if (!x || (x.item.kind !== "mc" && x.item.kind !== "tf" && x.item.kind !== "numeric")) return [];
      return [{ itemId: x.item.id, version: x.item.version, kind: x.item.kind, stem: x.item.stem, options: x.item.options, key: x.item.key, unit: x.item.unit ?? null, explanation: x.item.explanation, topics: topics(x), source: quote(x) }];
    });
  const cardsOf = (ids: string[]): StudyPrepCard[] =>
    ids.flatMap((id) => {
      const x = items.get(id);
      if (!x || (x.item.kind !== "card" && x.item.kind !== "cloze")) return [];
      const card = cardOf.get(id);
      return [{ cardId: card?.id ?? null, itemId: x.item.id, kind: x.item.kind, front: x.item.stem, back: String(x.item.key), topics: topics(x), due: !card || card.fsrs.due <= cutoff, dueAt: card?.fsrs.due ?? null, source: quote(x) }];
    });
  const out = {} as Record<StudyPrepKind, StudyPrepMaterial>;
  for (const kind of STUDY_PREP_KINDS) {
    const record = readRecord(store.learning, prep.courseRef, prep.subject.id, sel.hash, kind);
    const st = recordState(record, sel, now);
    const base: StudyPrepMaterial = { kind, status: st.status, count: 0, generatedAt: null, message: st.message, changed: st.changed, guide: null, quiz: null, cards: null, exam: null, problems: null, outline: null };
    const r = st.shown;
    if (!r) {
      out[kind] = base;
      continue;
    }
    const quiz = kind === "quiz" ? quizOf(r.itemIds) : null;
    const cardList = kind === "cards" ? cardsOf(r.itemIds) : null;
    out[kind] = {
      ...base,
      generatedAt: r.generatedAt,
      guide: kind === "guide" ? r.guide : null,
      quiz,
      cards: cardList,
      exam: kind === "exam" ? (r.exam ?? null) : null,
      problems: kind === "problems" ? (r.problems ?? null) : null,
      outline: kind === "outline" ? (r.outline ?? null) : null,
      count: quiz ? quiz.length : cardList ? cardList.length : countOf(kind, r),
    };
  }
  return out;
}

function itemState(store: PrepStore, courseRef: string, itemId: string, byId: Map<string, Resource>, now: Date, review: { cards: number; due: number; questions: number }): StudyPrepItemState {
  const materials = {} as StudyPrepItemState["materials"];
  const hash = allScopeHash(courseRef, itemId);
  for (const kind of STUDY_PREP_KINDS) {
    const record = readRecord(store.learning, courseRef, itemId, hash, kind);
    const st = recordState(record, byId, now);
    materials[kind] = { status: st.status, count: st.shown ? countOf(kind, st.shown) : 0 };
  }
  return { materials, cards: review.cards, due: review.due, questions: review.questions };
}

/** Upcoming exams and quizzes of one course, with readiness and what is prepared; each assignment's state when asked. */
function courseList(store: PrepStore, accountScope: string, courseId: string, now: Date, withAssignments: boolean): { upcoming: StudyPrepUpcoming[]; assignments: Record<string, StudyPrepItemState> } | null {
  const course = { accountScope, courseId };
  const sources = new Map(store.sources().map((s) => [s.id, s]));
  const resources = courseRows(store, course).filter((r) => !r.deleted && r.courseId === courseId && sources.get(r.sourceId)?.accountScope === accountScope);
  const courseRow = resources.find((r) => r.kind === "course");
  if (courseRow && !courseInclusion(store, [courseRow])(courseRow)) return null;
  const byId = new Map(resources.map((r) => [r.id, r]));
  const courseRef = `${accountScope}:${courseId}`;
  const courseName = resources.find((r) => r.courseName)?.courseName ?? courseId;
  const port = createExamEvidence({ resources: () => resources, sources: () => store.sources(), courseResources: () => resources, assessments: (c) => store.assessments(c) });
  const upcomingRows = port.assessments(accountScope, courseId).filter((a) => {
    const d = daysAway(a.date, now);
    return d === null || d >= 0;
  });
  const assignmentRows = withAssignments
    ? resources.filter((r) => {
        if (r.kind !== "assignment") return false;
        const d = dueOf(r);
        const t = d ? Date.parse(d) : NaN;
        return Number.isFinite(t) && t >= now.getTime() - 7 * DAY && t <= now.getTime() + ASSIGNMENT_HORIZON_DAYS * DAY;
      })
    : [];
  if (!upcomingRows.length && !assignmentRows.length) return { upcoming: [], assignments: {} };
  const items = latestItems(store.learning, courseRef);
  const cards = store.learning.cards({ courseRef });
  const links = readLinks(store.learning, courseRef);
  const types = readTypes(store.learning, courseRef);
  const m = upcomingRows.length ? courseMastery(store, courseRef, accountScope, courseId, now) : null;
  const masteryAssessments = m ? m.course().assessments : [];
  const upcoming = upcomingRows.map((a: ExamAssessment): StudyPrepUpcoming => {
    const r = a.resourceId ? (byId.get(a.resourceId) ?? null) : null;
    const decided = decideType(codeType({ assessment: { kind: a.kind as never, title: a.title }, resource: r }), types[a.id], a.kind === "quiz" ? "quiz" : "exam");
    const ma = masteryAssessments.find((x) => x.assessmentId === a.id || (!!a.resourceId && x.assessmentId === a.resourceId));
    const review = linkedReview(items, cards, links, { itemId: a.id, resourceIds: new Set(), topicIds: new Set(ma?.topicIds ?? []), whole: true }, now);
    return {
      id: a.id,
      kind: a.kind === "quiz" ? "quiz" : "assessment",
      type: decided.type,
      typeReason: decided.reason,
      typeBasis: decided.basis,
      resourceId: a.resourceId,
      title: a.title,
      courseId,
      courseName,
      date: a.date,
      daysAway: daysAway(a.date, now),
      where: null,
      points: r?.points ?? null,
      weight: weightOf(a, r),
      status: statusOf(r, now),
      url: r?.url ?? null,
      mastery: ma ? { label: ma.label, counts: { solid: ma.counts.solid, getting_there: ma.counts.getting_there, iffy: ma.counts.iffy, not_seen: ma.counts.not_seen }, total: ma.topicIds.length } : null,
      state: itemState(store, courseRef, a.id, byId, now, review),
    };
  });
  const assignments: Record<string, StudyPrepItemState> = {};
  const refs = (id: string) => (store.resourceRefs ? store.resourceRefs(id).flatMap((x) => (x.toResourceId ? [x.toResourceId] : [])) : []);
  for (const r of assignmentRows) {
    const review = linkedReview(items, cards, links, { itemId: r.id, resourceIds: new Set([r.id, ...refs(r.id)]), topicIds: new Set(), whole: false }, now);
    assignments[r.id] = itemState(store, courseRef, r.id, byId, now, review);
  }
  return { upcoming, assignments };
}

export function studyPrepQuery(store: Store, request: Request, nowIso: string): StudyPrepResult {
  const t0 = performance.now();
  const now = new Date(nowIso);
  const ms = () => Math.round((performance.now() - t0) * 10) / 10;
  const courseId = request.courseId ?? null;
  const itemId = request.itemId ?? request.assessmentId ?? null;
  const base = { view: "study.prep" as const, modelCalls: 0 as const };
  if (!isPrepStore(store)) return { ...base, courseId, status: "empty", message: "Study prep needs the workspace's learning store.", ms: ms() };
  if (!itemId) {
    const courses = courseId
      ? [{ accountScope: courseScope(store, courseId), courseId }]
      : [...new Map(store.sources().filter((s) => s.kind === "canvas" || s.kind === "fixture").map((s) => [`${s.accountScope}:${s.courseId}`, { accountScope: s.accountScope, courseId: s.courseId }])).values()];
    const upcoming: StudyPrepUpcoming[] = [];
    let assignments: Record<string, StudyPrepItemState> = {};
    for (const c of courses) {
      if (!c.accountScope) continue;
      const list = courseList(store, c.accountScope, c.courseId, now, !!courseId);
      if (!list) continue;
      upcoming.push(...list.upcoming);
      if (courseId) assignments = list.assignments;
    }
    upcoming.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.courseName.localeCompare(b.courseName) || a.title.localeCompare(b.title));
    return { ...base, courseId, status: "list", upcoming, assignments, ms: ms() };
  }
  if (!courseId) return { ...base, courseId, status: "empty", message: "Choose a course.", ms: ms() };
  const prep = loadPrep(store, courseId, itemId, now);
  if ("status" in prep) return { ...base, courseId, status: prep.status, message: prep.message, ms: ms() };
  const sel = selectScope(prep, request);
  const config = ITEM_SPACE[prep.subject.type];
  const has = (s: (typeof config.sections)[number]) => config.sections.includes(s);
  const items = latestItems(store.learning, prep.courseRef);
  const cards = store.learning.cards({ courseRef: prep.courseRef });
  const m = config.actions.length || has("readiness") ? courseMastery(store, prep.courseRef, prep.accountScope, prep.courseId, now) : null;
  const mastery = masteryOf(m, prep);
  const sections = buildSections(prep, config.sections);
  if (has("readiness")) sections.readiness = mastery.topics;
  const r = prep.subject.resource;
  const scopeTopics = new Set(sel.topicIds.length ? sel.topicIds : prep.topics.map((t) => t.id));
  return {
    ...base,
    courseId,
    status: "ok",
    courseRef: prep.courseRef,
    item: itemView(prep, now),
    config,
    instructions: r && prep.subject.kind !== "material" && r.text.trim() ? { text: r.text, resourceId: r.id } : null,
    sections,
    sources: prep.sources.map(({ resource: _r, ...s }) => ({ ...s, checked: sel.resourceIds.includes(s.resourceId) })),
    scopeItems: prep.items,
    sessions: has("sessions") ? sessionsFor(prep, store.courseSessions({ accountScope: prep.accountScope, courseId })) : [],
    announcements: has("announcements") ? announcementsFor(prep) : [],
    scope: { all: sel.all, resourceIds: sel.resourceIds, topicIds: sel.topicIds, hash: sel.hash },
    overview: overviewOf(prep, sel),
    materials: materialsOf(store, prep, sel, now, items, cards),
    mastery: mastery.summary,
    review: linkedReview(items, cards, readLinks(store.learning, prep.courseRef), { itemId: prep.subject.id, resourceIds: new Set(sel.resourceIds), topicIds: scopeTopics, whole: sel.all }, now),
    anchorIds: prep.anchorIds,
    restricted: prep.restricted,
    ms: ms(),
  };
}
