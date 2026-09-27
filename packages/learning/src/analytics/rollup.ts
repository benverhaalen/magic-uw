// Practice analytics: code-only rollups of the stored evidence (0 tokens) along
// item → topics → source materials → the assignments and exams those materials serve.
// priority(topic) = weakness × exam proximity × scope share, where
//   weakness × proximity = conceptPriority (km §5.7: (need + rules) × (1 + A·e^(−d/τ)), d = days to
//     the next upcoming exam whose scope holds the topic; 1 when none),
//   scope share = the topic's materials in that exam's scope ÷ the most any topic has there,
//     at least `shareFloor`; `noExamShare` when no upcoming exam holds the topic.
// The number orders "study this next" and never leaves this module (spec H4/H8).
import { CONFIG, params, type KnowledgeConfig } from "../config";
import { calibration } from "../insights/calibration";
import { stateTransitions } from "../insights/changes";
import { conceptPriority } from "../priority";
import type { Concept, CourseRef, LearningCard, LearningStore, StoredItem } from "../store";
import { STATE_LABEL, type ConceptStateName, type Reason } from "../types";
import type {
  AgendaHint,
  AgendaHintsData,
  AnalyticsCalibration,
  AnalyticsTopic,
  AssignmentAnalyticsData,
  CourseAnalyticsData,
  EvidenceCounts,
  ExamRef,
  ExamRollup,
  ModuleRollup,
  StateDistribution,
  StudyNextRow,
  TopicCoverage,
  TrendRow,
} from "../router-types";
import { ANALYTICS_CONFIG, type AnalyticsConfig } from "./config";
import { courseEvidence, topicStates, type TopicModel } from "./cache";
import type { ExamDate, ReferencesPort } from "./references";

export interface AnalyticsInput {
  store: LearningStore;
  /** `accountScope:courseId` (learning_courses.id). */
  ref: CourseRef;
  /** The course ID the references port keys on. */
  courseId: string;
  references: ReferencesPort;
  now: Date;
  /** Checked practice items the student can use now; defaults to the store's active items. */
  practiceItems?: StoredItem[];
  /** The course's items and cards, when the caller already read them (one read per request). */
  items?: StoredItem[];
  cards?: LearningCard[];
  config?: KnowledgeConfig;
  analyticsConfig?: AnalyticsConfig;
}

const NOTE = "Direction and state from your practice, worked out on this device. This is not a grade prediction.";
const STATE_RANK: Record<ConceptStateName, number> = { not_seen: 0, iffy: 1, getting_there: 2, solid: 3 };
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** The student's local calendar day of an ISO date or instant. */
const dayOf = (at: string) => (/^\d{4}-\d{2}-\d{2}$/.test(at) ? at : localDay(new Date(at)));
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const inDays = (d: number) => (d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

interface UpcomingExam extends ExamRef {
  resourceId: string | null;
}

/** Everything the three views share, computed once per request. Exported for course mastery (D57), which reads the same context. */
export function context(input: AnalyticsInput) {
  const { store, ref, now } = input;
  const km = input.config ?? CONFIG;
  const an = input.analyticsConfig ?? ANALYTICS_CONFIG;
  const all = store.concepts(ref);
  const active = all.filter((c) => c.status === "active");
  const byId = new Map(all.map((c) => [c.id, c]));
  const resolve = (id: string) => {
    let cur = byId.get(id);
    for (let hops = 0; cur?.mergedInto && hops < 20; hops++) cur = byId.get(cur.mergedInto) ?? cur;
    return cur?.id ?? id;
  };
  const moduleOf = (x: Concept): Concept | null => {
    let cur = x.parentId ? byId.get(x.parentId) : undefined;
    for (let hops = 0; cur && hops < 20; hops++) {
      if (cur.kind === "unit") return cur.status === "active" ? cur : null;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return null;
  };
  const label = (c: Concept) => c.studentLabel ?? c.label;
  const modules = active.filter((c) => c.kind === "unit").sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const modulePos = new Map(modules.map((m, i) => [m.id, i]));
  const topics = active
    .filter((c) => c.kind === "concept")
    .sort(
      (a, b) =>
        (modulePos.get(moduleOf(a)?.id ?? "") ?? modules.length) - (modulePos.get(moduleOf(b)?.id ?? "") ?? modules.length) ||
        a.position - b.position ||
        a.id.localeCompare(b.id),
    );
  const topicIds = new Set(topics.map((t) => t.id));

  const allItems = input.items ?? store.items({ courseRef: ref });
  const evidence = courseEvidence(store, ref, { items: allItems, ...(input.cards ? { cards: input.cards } : {}) });
  const states = topicStates(store, ref, all, now, { config: km, evidence });

  // Topic → materials: the sources of items tagged with it, and the concept's own sources.
  const materialsOf = new Map<string, Set<string>>();
  const addMaterial = (conceptId: string, resourceId: string) => {
    const t = resolve(conceptId);
    if (!topicIds.has(t)) return;
    materialsOf.set(t, (materialsOf.get(t) ?? new Set()).add(resourceId));
  };
  for (const x of allItems) for (const tag of x.tags) for (const s of x.sources) addMaterial(tag.conceptId, s.resourceId);
  for (const c of active) for (const s of c.sources) addMaterial(c.id, s.resourceId);

  // Practice items per topic (primary tag), latest version of each item.
  const pool =
    input.practiceItems ??
    [
      ...allItems
        .reduce((m, x) => (!m.has(x.item.id) || m.get(x.item.id)!.item.version < x.item.version ? m.set(x.item.id, x) : m), new Map<string, StoredItem>())
        .values(),
    ].filter((x) => x.item.status === "active" && !x.checks.some((c) => c.outcome === "fail"));
  const itemsOf = new Map<string, StoredItem[]>();
  for (const x of pool) {
    const primary = x.tags.find((t) => t.primary)?.conceptId ?? x.tags[0]?.conceptId;
    if (!primary) continue;
    const t = resolve(primary);
    itemsOf.set(t, [...(itemsOf.get(t) ?? []), x]);
  }

  // Exams: dated and upcoming within the horizon; undated listed apart; past ones dropped.
  const today = localDay(now);
  const dates: ExamDate[] = input.references.examDates(input.courseId);
  const upcoming: UpcomingExam[] = dates
    .filter((e): e is ExamDate & { at: string } => e.at !== null)
    .map((e) => ({
      assessmentId: e.assessmentId,
      title: e.title,
      kind: e.kind,
      at: e.at,
      daysAway: daysBetween(today, dayOf(e.at)),
      dateSource: e.dateSource,
      resourceId: e.resourceId,
    }))
    .filter((e) => e.daysAway >= 0 && e.daysAway <= an.upcomingHorizonDays.value)
    .sort((a, b) => a.daysAway - b.daysAway || a.title.localeCompare(b.title));
  const undated = dates.filter((e) => e.at === null).map((e) => ({ assessmentId: e.assessmentId, title: e.title }));
  const upcomingById = new Map(upcoming.map((e) => [e.assessmentId, e]));

  // Exam scope along the chain: each topic material → the exams it serves; plus stored coverage rows.
  const scope = new Map<string, Map<string, number>>(); // examId → topic → materials in scope
  const materialTopics = new Map<string, string[]>();
  for (const [t, ms] of materialsOf) for (const m of ms) materialTopics.set(m, [...(materialTopics.get(m) ?? []), t]);
  for (const [m, ts] of materialTopics)
    for (const a of input.references.assessmentsFor(m)) {
      if (!upcomingById.has(a.assessmentId)) continue;
      const row = scope.get(a.assessmentId) ?? new Map<string, number>();
      for (const t of ts) row.set(t, (row.get(t) ?? 0) + 1);
      scope.set(a.assessmentId, row);
    }
  const statedOnly = new Map<string, Set<string>>();
  for (const e of upcoming)
    for (const row of store.coverage(e.assessmentId)) {
      const t = resolve(row.conceptId);
      if (row.status === "rejected" || !topicIds.has(t)) continue;
      const s = scope.get(e.assessmentId) ?? new Map<string, number>();
      if (!s.has(t)) {
        s.set(t, 0);
        statedOnly.set(e.assessmentId, (statedOnly.get(e.assessmentId) ?? new Set()).add(t));
      }
      scope.set(e.assessmentId, s);
    }
  const share = (t: string, examId: string) => {
    const row = scope.get(examId);
    if (!row?.has(t)) return 0;
    if (statedOnly.get(examId)?.has(t)) return 1;
    const most = Math.max(...row.values());
    return Math.max(an.shareFloor.value, most ? row.get(t)! / most : 1);
  };
  const nextExam = (t: string): UpcomingExam | null => upcoming.find((e) => scope.get(e.assessmentId)?.has(t)) ?? null;
  const examView = (e: UpcomingExam): Omit<ExamRef, "dateSource"> => ({ assessmentId: e.assessmentId, title: e.title, kind: e.kind, at: e.at, daysAway: e.daysAway });

  const model = (t: string): TopicModel =>
    states.models.get(t) ?? { conceptId: t, n: 0, pHat: 0, band: "not_seen", reasons: [], counts: { answers: 0, unassisted: 0, correct: 0, cardReviews: 0, selfRatings: 0 } };
  const priority = (t: string): number => {
    const m = model(t);
    const next = nextExam(t);
    const base = conceptPriority(
      { n: m.n, pHat: m.pHat, band: m.band, reasons: m.reasons, coveredBy: next ? [{ assessmentId: next.assessmentId, title: next.title, daysAway: next.daysAway }] : [] },
      km,
    );
    return base * (next ? share(t, next.assessmentId) : an.noExamShare.value);
  };

  function topicView(t: Concept, materials?: Set<string>): AnalyticsTopic {
    const m = model(t.id),
      mod = moduleOf(t),
      next = nextExam(t.id);
    const mine = [...(materialsOf.get(t.id) ?? [])].filter((id) => !materials || materials.has(id)).sort();
    return {
      conceptId: t.id,
      label: label(t),
      moduleId: mod?.id ?? null,
      moduleLabel: mod ? label(mod) : null,
      state: m.band,
      stateLabel: STATE_LABEL[m.band],
      reasons: m.reasons.map((r: Reason) => ({ text: r.text, clearsWhen: r.clearsWhen })),
      counts: { answers: m.counts.answers, correct: m.counts.correct, cardReviews: m.counts.cardReviews, selfRatings: m.counts.selfRatings },
      practiceItems: itemsOf.get(t.id)?.length ?? 0,
      materialIds: mine,
      nextExam: next ? examView(next) : null,
    };
  }

  function studyNext(ids: string[], limit = 3): StudyNextRow[] {
    return ids
      .filter((t) => model(t).band !== "solid")
      .map((t) => ({ t, p: priority(t) }))
      .sort((a, b) => b.p - a.p || label(byId.get(a.t)!).localeCompare(label(byId.get(b.t)!)))
      .slice(0, limit)
      .map(({ t }) => {
        const m = model(t),
          next = nextExam(t),
          items = itemsOf.get(t)?.length ?? 0;
        const why =
          m.band === "iffy"
            ? (m.reasons[0]?.text ?? "Iffy.")
            : m.band === "not_seen"
              ? "Not practiced yet."
              : m.counts.answers
                ? `Getting there: ${m.counts.correct} of ${m.counts.answers} right so far.`
                : "Getting there from card reviews.";
        const exam = next ? ` In scope for ${next.title} ${inDays(next.daysAway)}.` : "";
        const none = items ? "" : " No practice items yet.";
        return {
          conceptId: t,
          label: label(byId.get(t)!),
          state: m.band,
          stateLabel: STATE_LABEL[m.band],
          reason: `${why}${exam}${none}`,
          exam: next ? examView(next) : null,
          practiceItems: items,
        };
      });
  }

  const distribution = (ids: string[]): StateDistribution => {
    const d: StateDistribution = { solid: 0, getting_there: 0, iffy: 0, not_seen: 0 };
    for (const t of ids) d[model(t).band]++;
    return d;
  };
  const coverage = (ids: string[]): TopicCoverage => {
    const withEvidence = ids.filter((t) => {
      const c = model(t).counts;
      return c.answers + c.cardReviews + c.selfRatings > 0;
    }).length;
    return { withEvidence, of: ids.length, text: `${withEvidence} of ${plural(ids.length, "topic")} practiced` };
  };
  const evidenceCounts = (ids: Set<string>): EvidenceCounts => {
    const attempts = evidence.attempts.filter((a) => a.conceptTags.some((t) => ids.has(resolve(t.conceptId))));
    const undone = new Set(evidence.reviews.filter((r) => r.undoesReviewId).map((r) => r.undoesReviewId!));
    const reviews = evidence.reviews.filter((r) => {
      const card = evidence.cards.get(r.cardId);
      return !r.undoesReviewId && !undone.has(r.id) && !!card && ids.has(resolve(card.conceptId));
    });
    return {
      answers: attempts.length,
      correct: attempts.filter((a) => a.score >= 1).length,
      cardReviews: reviews.length,
      selfRatings: evidence.selfRatings.filter((s) => ids.has(resolve(s.conceptId))).length,
      sessions: new Set(attempts.map((a) => a.sessionId)).size,
    };
  };
  const calibrationFor = (ids: Set<string>): AnalyticsCalibration => {
    const reasonsByConcept = new Map([...states.models].map(([id, m]) => [id, m.reasons]));
    const c = calibration(evidence.attempts, { disputes: evidence.disputes, reasonsByConcept, selfRatings: evidence.selfRatings });
    if (c.status === "not_enough") return c;
    return {
      status: "ready",
      rated: c.rated,
      flags: c.overconfident
        .filter((o) => ids.has(resolve(o.conceptId)))
        .map((o) => ({ conceptId: resolve(o.conceptId), label: label(byId.get(resolve(o.conceptId)) ?? byId.get(o.conceptId)!), wrong: o.wrong, total: o.total, text: o.text })),
    };
  };

  return {
    km,
    an,
    all,
    byId,
    label,
    modules,
    moduleOf,
    topics,
    evidence,
    states,
    materialsOf,
    itemsOf,
    upcoming,
    undated,
    scope,
    nextExam,
    examView,
    model,
    topicView,
    studyNext,
    distribution,
    coverage,
    evidenceCounts,
    calibrationFor,
  };
}

export type AnalyticsContext = ReturnType<typeof context>;

/** Readiness on the topics behind one assignment's references. Null: the assignment isn't this course's. */
export function assignmentAnalytics(input: AnalyticsInput, assignmentId: string, ctx: AnalyticsContext = context(input)): AssignmentAnalyticsData | null {
  const a = input.references.assignment(assignmentId);
  if (!a || a.courseId !== input.courseId) return null;
  const materials = input.references.references(assignmentId);
  const ids = new Set(materials.map((m) => m.resourceId));
  const topics = ctx.topics.filter((t) => [...(ctx.materialsOf.get(t.id) ?? [])].some((m) => ids.has(m)));
  const topicIds = topics.map((t) => t.id);
  const linkage = !materials.length ? "no_materials" : !topics.length ? "no_topics" : "linked";
  return {
    courseId: input.courseId,
    assignmentId,
    title: a.title,
    linkage,
    reason:
      linkage === "no_materials"
        ? "No captured course material is linked to this assignment yet."
        : linkage === "no_topics"
          ? `${plural(materials.length, "linked material")}, but no topic or practice item cites ${materials.length === 1 ? "it" : "them"} yet.`
          : `${plural(materials.length, "linked material")} reach ${plural(topics.length, "topic")}.`,
    materials,
    topics: topics.map((t) => ctx.topicView(t, ids)),
    distribution: ctx.distribution(topicIds),
    coverage: ctx.coverage(topicIds),
    calibration: ctx.calibrationFor(new Set(topicIds)),
    studyNext: ctx.studyNext(topicIds),
    evidence: ctx.evidenceCounts(new Set(topicIds)),
    note: NOTE,
  };
}

/** Per-module and per-upcoming-exam rollups, the trend over the last sessions and the top priorities. */
export function courseAnalytics(input: AnalyticsInput, opts: { sessions?: number } = {}, ctx: AnalyticsContext = context(input)): CourseAnalyticsData {
  const allIds = ctx.topics.map((t) => t.id);
  // Modules with no topic under them carry nothing to roll up; they are left out.
  const modules: ModuleRollup[] = ctx.modules.flatMap((m) => {
    const ids = ctx.topics.filter((t) => ctx.moduleOf(t)?.id === m.id).map((t) => t.id);
    return ids.length ? [{ moduleId: m.id, label: ctx.label(m), topicIds: ids, distribution: ctx.distribution(ids), coverage: ctx.coverage(ids) }] : [];
  });
  const loose = ctx.topics.filter((t) => !ctx.moduleOf(t)).map((t) => t.id);
  if (loose.length) modules.push({ moduleId: null, label: "Other topics", topicIds: loose, distribution: ctx.distribution(loose), coverage: ctx.coverage(loose) });

  const exams: ExamRollup[] = ctx.upcoming.map((e) => {
    const inScope = ctx.scope.get(e.assessmentId);
    const ids = allIds.filter((t) => inScope?.has(t));
    return {
      assessmentId: e.assessmentId,
      title: e.title,
      kind: e.kind,
      at: e.at,
      daysAway: e.daysAway,
      dateSource: e.dateSource,
      scope: ids.length ? "linked" : "not_linked",
      topicIds: ids,
      distribution: ctx.distribution(ids),
      coverage: ctx.coverage(ids),
      studyNext: ctx.studyNext(ids),
    };
  });

  // Trend: transitions since the day before the first of the last N practice sessions.
  const n = opts.sessions ?? ctx.an.trendSessions.value;
  const firstDay = new Map<string, string>();
  for (const a of [...ctx.evidence.attempts].sort((x, y) => x.createdAt.localeCompare(y.createdAt)))
    if (!firstDay.has(a.sessionId)) firstDay.set(a.sessionId, a.localDay);
  const recent = [...firstDay.values()].slice(-n);
  const since = recent.length ? new Date(Date.parse(`${recent.sort()[0]}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : null;
  const topicSet = new Set(allIds);
  const transitions: TrendRow[] = since
    ? stateTransitions(ctx.evidence, ctx.all, since, input.now.toISOString().slice(0, 10), ctx.km)
        .filter((x) => topicSet.has(x.conceptId))
        .map((x) => ({
          conceptId: x.conceptId,
          label: ctx.label(ctx.byId.get(x.conceptId)!),
          day: x.day,
          from: x.from,
          to: x.to,
          direction: x.from === "not_seen" ? "new" : STATE_RANK[x.to] > STATE_RANK[x.from] ? "up" : "down",
          text: x.text,
        }))
    : [];

  return {
    courseId: input.courseId,
    modules,
    exams,
    undatedExams: ctx.undated,
    distribution: ctx.distribution(allIds),
    coverage: ctx.coverage(allIds),
    trend: { sessions: recent.length, since, transitions },
    studyNext: ctx.studyNext(allIds),
    evidence: ctx.evidenceCounts(topicSet),
    note: NOTE,
  };
}

/** At most three "Study X before <exam>" hints, sized from the topic's practice items. */
export function agendaHints(input: AnalyticsInput, ctx: AnalyticsContext = context(input)): AgendaHintsData {
  const minutesPer = params(ctx.km).minutesPerItem;
  const rows = ctx.studyNext(
    ctx.topics.filter((t) => ctx.nextExam(t.id)).map((t) => t.id),
    3,
  );
  const hints: AgendaHint[] = rows.map((r) => {
    const items = (ctx.itemsOf.get(r.conceptId) ?? []).slice().sort((a, b) => a.item.id.localeCompare(b.item.id)).slice(0, ctx.an.hintMaxItems.value);
    const step = ctx.an.hintRoundMinutes.value;
    const raw = items.reduce((sum, x) => sum + minutesPer[x.item.kind], 0);
    const minutes = items.length ? Math.max(step, Math.ceil(raw / step) * step) : null;
    const exam = r.exam!;
    return {
      conceptId: r.conceptId,
      label: r.label,
      state: r.state,
      exam,
      items: items.length,
      minutes,
      text:
        minutes === null
          ? `Study ${r.label} before ${exam.title} (${inDays(exam.daysAway)}). No practice items yet: generate them from its materials.`
          : `Study ${r.label} before ${exam.title} (${inDays(exam.daysAway)}): about ${minutes} min, ${plural(items.length, "practice item")}.`,
    };
  });
  return { courseId: input.courseId, hints };
}

/** One request's analytics over a shared context: the topic states are read or refreshed once. */
export function createAnalytics(input: AnalyticsInput) {
  let ctx: AnalyticsContext | null = null;
  const get = () => (ctx ??= context(input));
  return {
    assignment: (assignmentId: string) => assignmentAnalytics(input, assignmentId, get()),
    course: (opts: { sessions?: number } = {}) => courseAnalytics(input, opts, get()),
    agendaHints: () => agendaHints(input, get()),
    /** Which topics this request recomputed or read from the cache. */
    freshness: () => ({ recomputed: get().states.recomputed, reused: get().states.reused }),
  };
}

/** After practice commits: recompute the affected topics' cached state now (the next read reuses it). */
export function refreshTopics(store: LearningStore, ref: CourseRef, conceptIds: Iterable<string>, now: Date, config: KnowledgeConfig = CONFIG) {
  return topicStates(store, ref, store.concepts(ref), now, { force: conceptIds, config });
}
