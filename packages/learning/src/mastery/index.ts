// Course mastery (D57): topic states by module and by upcoming exam, the delayed-recall tier, the
// due-for-review flag, one next step, self-referenced change, past exams as of their dates, and the
// day-agenda roll-up. Code only, 0 tokens. It reads the analytics context (the cached topic states,
// the exam scopes along the material chain, the priority order) rather than rebuilding it.
import { analyticsContext, type AnalyticsContext, type AnalyticsInput } from "../analytics";
import { shortDate } from "../knowledge/rules";
import type { Concept, LearningCard } from "../store";
import { STATE_LABEL, type ConceptStateName } from "../types";
import { bandsAsOf, shownState, topicExtras, type TopicExtras } from "./rules";
import type {
  AssessmentMasteryData,
  CourseMasteryData,
  ExamHistoryData,
  ItemsMasteryData,
  MasteryAssessment,
  MasteryModule,
  MasteryTopic,
  NextStep,
  PastExam,
  StateCounts,
} from "./types";

export type * from "./types";
export { bandsAsOf, reviewThreshold, shownState, topicExtras } from "./rules";

export const NOTE = "Based on your answers in Magic Canvas, not a grade prediction.";

/** Starting values, not validated. */
export const MASTERY_CONFIG = {
  /** A weak topic in an exam's scope this close (days) comes before due reviews. */
  examSoonDays: 7,
  /** Questions in a next-step quiz, at most. */
  quizMax: 10,
  /** Cards in a next-step review, at most. */
  reviewMax: 20,
  /** Questions in a claim check. */
  claimCheck: 3,
  /** "Since last week". */
  sinceDays: 7,
} as const;

const RANK: Record<ConceptStateName, number> = { not_seen: 0, iffy: 1, getting_there: 2, solid: 3 };
const CARD_KINDS = new Set(["card", "typed", "cloze", "numeric"]);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const inDays = (d: number) => (d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`);
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const endOfLocalDay = (d: Date) => {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e.toISOString();
};
const emptyCounts = (): StateCounts => ({ solid: 0, getting_there: 0, iffy: 0, not_seen: 0 });
const names = (labels: string[]) => (labels.length <= 2 ? labels.join(" and ") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`);

export interface MasteryInput extends AnalyticsInput {
  /** The course's FSRS cards; read from the store when absent. */
  cards?: LearningCard[];
}

/** Long-lived results that depend only on evidence before a past instant (keyed by what they read). */
export interface MasteryMemo {
  /** States and mastery facts as of a past instant; evidence before it can't change, so the key is what was read. */
  asOf: Map<string, { bands: Map<string, ConceptStateName>; extras: Map<string, TopicExtras> }>;
}
export const createMasteryMemo = (): MasteryMemo => ({ asOf: new Map() });

export function createMastery(input: MasteryInput, memo: MasteryMemo = createMasteryMemo(), ctx: AnalyticsContext = analyticsContext(input)) {
  const { now } = input;
  const today = localDay(now);
  const cards = input.cards ?? input.store.cards({ courseRef: input.ref });
  const extras = topicExtras(ctx.evidence, ctx.all, cards, now, ctx.km);
  const topicIds = ctx.topics.map((t) => t.id);
  const topicSet = new Set(topicIds);

  const x = (t: string): TopicExtras | undefined => extras.get(t);
  const shown = (t: string) => shownState(ctx.model(t).band, x(t));
  const label = (t: string) => ctx.label(ctx.byId.get(t)!);
  const examsOf = (t: string) =>
    ctx.upcoming.filter((e) => ctx.scope.get(e.assessmentId)?.has(t)).map((e) => ({ assessmentId: e.assessmentId, title: e.title, daysAway: e.daysAway }));
  const questions = (t: string) => (ctx.itemsOf.get(t) ?? []).filter((s) => s.item.kind !== "card");
  const families = (ids: string[]) => new Set(ids.flatMap((t) => questions(t).map((s) => s.item.familyId))).size;

  function topicView(c: Concept): MasteryTopic {
    const m = ctx.model(c.id),
      e = x(c.id),
      mod = ctx.moduleOf(c);
    const state = shownState(m.band, e);
    const awaiting = m.band === "solid" && !e?.confirmed;
    const items = ctx.itemsOf.get(c.id)?.length ?? 0;
    const why =
      state === "not_seen"
        ? items
          ? "Not practiced yet."
          : "Not practiced yet. No practice items yet."
        : state === "iffy"
          ? (m.reasons[0]?.text ?? "Recent answers missed it.")
          : state === "solid"
            ? "Your answers meet every Mastered rule, including a right answer recalled on a later day."
            : awaiting
              ? "Your answers meet the Mastered rules. It shows as Mastered once you recall it right on a later day."
              : m.counts.answers
                ? `${m.counts.correct} of ${plural(m.counts.answers, "answer")} right without help so far.`
                : "From card reviews so far.";
    return {
      topicId: c.id,
      label: ctx.label(c),
      moduleId: mod?.id ?? null,
      moduleLabel: mod ? ctx.label(mod) : null,
      state,
      stateLabel: STATE_LABEL[state],
      confirmed: state === "solid",
      awaitingLaterRecall: awaiting,
      dueForReview: e?.dueForReview ?? false,
      lastEvidenceDay: e?.lastDay ?? null,
      evidenceCount: e?.evidenceCount ?? 0,
      practiceItems: items,
      why,
      reasons: m.reasons.map((r) => ({ text: r.text, clearsWhen: r.clearsWhen })),
      assessments: examsOf(c.id),
    };
  }

  const countsOf = (ids: string[]): StateCounts => {
    const out = emptyCounts();
    for (const t of ids) out[shown(t)]++;
    return out;
  };
  const dueOf = (ids: string[]) => ids.filter((t) => x(t)?.dueForReview).length;

  /** The single highest-priority action over `ids` (weakness × exam proximity, then due reviews). */
  function nextStep(ids: string[]): { step: NextStep | null; note: string | null } {
    if (!ids.length) return { step: null, note: "No topics are linked here yet." };
    const courseId = input.courseId;
    const weak = ctx.studyNext(ids, ids.length);
    const top = weak[0];
    const quiz = (): NextStep => {
      const second = weak.slice(1).find((r) => (top!.exam && r.exam?.assessmentId === top!.exam.assessmentId) || ctx.moduleOf(ctx.byId.get(r.conceptId)!)?.id === ctx.moduleOf(ctx.byId.get(top!.conceptId)!)?.id);
      const chosen = [top!, ...(second && families([second.conceptId]) ? [second] : [])];
      const chosenIds = chosen.map((r) => r.conceptId);
      const available = families(chosenIds);
      const why = top!.state === "iffy" ? `${top!.label} is Iffy.` : top!.state === "not_seen" ? `${top!.label} isn't practiced yet.` : `${top!.label} is Getting there.`;
      const exam = top!.exam ? ` It's on ${top!.exam.title} ${inDays(top!.exam.daysAway)}.` : "";
      if (!available)
        return {
          kind: "generate",
          label: `Generate practice for ${names(chosen.map((r) => r.label))}`,
          detail: `${why}${exam} No practice items yet: your AI writes checked questions from the course materials.`,
          topicIds: chosenIds,
          usesAi: true,
          command: { type: "pack", pack: "quiz", scope: { courseId, topicIds: chosenIds } },
        };
      const count = Math.min(MASTERY_CONFIG.quizMax, available);
      return {
        kind: "quiz",
        label: `Quiz me: ${plural(count, "question")} on ${names(chosen.map((r) => r.label))}`,
        detail: `${why}${exam}`,
        topicIds: chosenIds,
        usesAi: false,
        command: { type: "learning", request: { op: "practice.target", courseId, topicIds: chosenIds, mode: "test", count } },
      };
    };
    if (top && (top.state === "iffy" || (top.exam && top.exam.daysAway <= MASTERY_CONFIG.examSoonDays))) return { step: quiz(), note: null };
    // Due reviews: the existing cards on due topics whose FSRS due date has come (what a flashcard session serves first).
    const cutoff = endOfLocalDay(now);
    const cardByItem = new Map(cards.filter((c) => !c.isConceptTrack).map((c) => [c.itemId, c]));
    const dueTopics: string[] = [];
    let dueCards = 0;
    for (const t of ids) {
      if (!x(t)?.dueForReview) continue;
      const n = (ctx.itemsOf.get(t) ?? []).filter((s) => CARD_KINDS.has(s.item.kind) && (cardByItem.get(s.item.id)?.fsrs.due ?? "~") <= cutoff).length;
      if (n) {
        dueTopics.push(t);
        dueCards += n;
      }
    }
    if (dueCards) {
      const count = Math.min(MASTERY_CONFIG.reviewMax, dueCards);
      return {
        step: {
          kind: "review",
          label: `Review ${plural(count, "due card")}`,
          detail: `${names(dueTopics.map(label))} ${dueTopics.length === 1 ? "is" : "are"} due for review: time since you last recalled ${dueTopics.length === 1 ? "it" : "them"} makes slipping likely.`,
          topicIds: dueTopics,
          usesAi: false,
          command: { type: "learning", request: { op: "practice.target", courseId, topicIds: dueTopics, mode: "flashcards", count } },
        },
        note: null,
      };
    }
    if (top) return { step: quiz(), note: null };
    const waiting = ids.find((t) => ctx.model(t).band === "solid" && !x(t)?.confirmed && (x(t)?.firstDay ?? today) < today && families([t]));
    if (waiting) {
      const count = Math.min(MASTERY_CONFIG.claimCheck, families([waiting]));
      return {
        step: {
          kind: "recall_check",
          label: `Recall check: ${plural(count, "question")} on ${label(waiting)}`,
          detail: `${label(waiting)} is Mastered once you recall it right on a later day.`,
          topicIds: [waiting],
          usesAi: false,
          command: { type: "learning", request: { op: "practice.target", courseId, topicIds: [waiting], mode: "test", count } },
        },
        note: null,
      };
    }
    return { step: null, note: "Nothing needs work right now: every topic here is Mastered or waiting for a later day, and nothing is due for review." };
  }

  function assessmentView(e: (typeof ctx.upcoming)[number]): MasteryAssessment {
    const inScope = ctx.scope.get(e.assessmentId);
    const ids = topicIds.filter((t) => inScope?.has(t));
    const counts = countsOf(ids);
    return {
      assessmentId: e.assessmentId,
      title: e.title,
      kind: e.kind,
      at: e.at,
      daysAway: e.daysAway,
      dateSource: e.dateSource,
      scope: ids.length ? "linked" : "not_linked",
      topicIds: ids,
      counts,
      dueForReview: dueOf(ids),
      label: ids.length ? `Mastered ${counts.solid} of ${plural(ids.length, "topic")} for ${e.title}` : `No topics linked to ${e.title} yet`,
      nextStep: nextStep(ids).step,
    };
  }

  /** Bands and mastery facts as of a past instant, memoised by what they read. */
  function asOf(key: string, at: string) {
    let hit = memo.asOf.get(key);
    if (!hit) {
      hit = { bands: bandsAsOf(ctx.evidence, ctx.all, at, ctx.km), extras: topicExtras(ctx.evidence, ctx.all, [], now, ctx.km, at) };
      memo.asOf.set(key, hit);
      // Bounded: the oldest entries go first (a new day or new evidence makes new keys).
      while (memo.asOf.size > 64) memo.asOf.delete(memo.asOf.keys().next().value!);
    }
    return hit;
  }

  function sinceLastWeek() {
    const then = new Date(now.getTime() - MASTERY_CONFIG.sinceDays * 86_400_000);
    const thenAt = endOfLocalDay(then);
    const thenDay = localDay(then);
    const key = [
      input.ref,
      thenAt,
      ctx.km.version,
      ctx.evidence.attempts.filter((a) => a.createdAt <= thenAt).length,
      ctx.evidence.reviews.filter((r) => r.createdAt <= thenAt).length,
      ctx.evidence.disputes.map((d) => `${d.id}:${d.status}`).sort().join(","),
      ctx.all.map((c) => `${c.id}:${c.status}:${c.mergedInto ?? ""}`).join(","),
    ].join("|");
    const { bands, extras: thenExtras } = asOf(key, thenAt);
    let up = 0,
      down = 0;
    for (const t of topicIds) {
      const before = shownState(bands.get(t) ?? "not_seen", thenExtras.get(t));
      const after = shown(t);
      if (RANK[after] > RANK[before]) up++;
      else if (RANK[after] < RANK[before]) down++;
    }
    const due = dueOf(topicIds);
    const parts = [`${plural(up, "topic")} moved up`, ...(down ? [`${down} moved down`] : []), `${due} ${due === 1 ? "is" : "are"} due for review`];
    return { since: thenDay, movedUp: up, movedDown: down, dueForReview: due, text: `Since ${shortDate(thenDay)}: ${parts.join(", ")}.` };
  }

  function course(): CourseMasteryData {
    const hidden = ctx.all.filter((c) => c.kind === "concept" && c.status === "hidden").map((c) => ({ topicId: c.id, label: ctx.label(c) }));
    const assessments = ctx.upcoming.map(assessmentView);
    if (!ctx.topics.length)
      return {
        courseId: input.courseId,
        status: "no_topics",
        message: "This course has no topic map yet. Generating practice from its materials builds one.",
        counts: emptyCounts(),
        total: 0,
        label: "No topics yet",
        sinceLastWeek: { since: localDay(new Date(now.getTime() - MASTERY_CONFIG.sinceDays * 86_400_000)), movedUp: 0, movedDown: 0, dueForReview: 0, text: "" },
        nextStep: {
          kind: "generate",
          label: "Generate practice for this course",
          detail: "Your AI writes checked questions from the course materials; their topics become this course's topic map.",
          topicIds: [],
          usesAi: true,
          command: { type: "pack", pack: "quiz", scope: { courseId: input.courseId } },
        },
        nextStepNote: null,
        modules: [],
        topics: [],
        assessments,
        undatedAssessments: ctx.undated,
        hidden,
        note: NOTE,
      };
    const topics = ctx.topics.map(topicView);
    const modules: MasteryModule[] = ctx.modules.flatMap((m) => {
      const ids = ctx.topics.filter((t) => ctx.moduleOf(t)?.id === m.id).map((t) => t.id);
      return ids.length ? [{ moduleId: m.id, label: ctx.label(m), topicIds: ids, counts: countsOf(ids), dueForReview: dueOf(ids) }] : [];
    });
    const loose = ctx.topics.filter((t) => !ctx.moduleOf(t)).map((t) => t.id);
    if (loose.length) modules.push({ moduleId: null, label: "Other topics", topicIds: loose, counts: countsOf(loose), dueForReview: dueOf(loose) });
    const counts = countsOf(topicIds);
    const next = nextStep(topicIds);
    return {
      courseId: input.courseId,
      status: "ok",
      message: null,
      counts,
      total: topicIds.length,
      label: `Mastered ${counts.solid} of ${plural(topicIds.length, "topic")}`,
      sinceLastWeek: sinceLastWeek(),
      nextStep: next.step,
      nextStepNote: next.note,
      modules,
      topics,
      assessments,
      undatedAssessments: ctx.undated,
      hidden,
      note: NOTE,
    };
  }

  /** One upcoming exam's slice, for the assessment page to embed. Null: not an upcoming exam of this course. */
  function assessment(assessmentId: string): AssessmentMasteryData | null {
    const e = ctx.upcoming.find((u) => u.assessmentId === assessmentId);
    if (!e) return null;
    const view = assessmentView(e);
    return { courseId: input.courseId, assessment: view, topics: ctx.topics.filter((t) => view.topicIds.includes(t.id)).map(topicView), note: NOTE };
  }

  /** The topics behind a set of due items (an agenda day), rolled up, with one next step for them. */
  function forItems(itemIds: string[]): ItemsMasteryData {
    const items = [...new Set(itemIds)].map((id) => {
      const a = input.references.assignment(id);
      if (!a || a.courseId !== input.courseId) return { itemId: id, title: null, topicIds: [] as string[], linkage: "unknown_item" as const };
      const materials = new Set(input.references.references(id).map((m) => m.resourceId));
      const ids = topicIds.filter((t) => [...(ctx.materialsOf.get(t) ?? [])].some((m) => materials.has(m)));
      return { itemId: id, title: a.title, topicIds: ids, linkage: !materials.size ? ("no_materials" as const) : !ids.length ? ("no_topics" as const) : ("linked" as const) };
    });
    const union = topicIds.filter((t) => items.some((i) => i.topicIds.includes(t)));
    const counts = countsOf(union);
    return {
      courseId: input.courseId,
      items,
      topicIds: union,
      counts,
      dueForReview: dueOf(union),
      label: union.length ? `Mastered ${counts.solid} of ${plural(union.length, "topic")} behind these items` : "No topics are linked to these items yet",
      nextStep: nextStep(union).step,
      note: NOTE,
    };
  }

  /**
   * Past exams: each one's topic states as of its date (replayed from the evidence stored up to
   * then), the score Canvas shows for it, and which topics moved since. `scoreOf` reads a captured
   * submission (account-scoped by the caller); without it no score is shown.
   */
  function history(scoreOf: (resourceId: string) => { earned: number; possible: number } | null = () => null): ExamHistoryData {
    const nowIso = now.toISOString();
    const past = input.references
      .examDates(input.courseId)
      .filter((e): e is typeof e & { at: string } => e.at !== null && e.at < nowIso)
      .sort((a, b) => b.at.localeCompare(a.at));
    const scopeOf = (assessmentId: string) => {
      const ids = new Set<string>();
      for (const [t, ms] of ctx.materialsOf) for (const m of ms) if (input.references.assessmentsFor(m).some((a) => a.assessmentId === assessmentId)) ids.add(t);
      for (const row of input.store.coverage(assessmentId)) if (row.status !== "rejected" && topicSet.has(row.conceptId)) ids.add(row.conceptId);
      return topicIds.filter((t) => ids.has(t));
    };
    const exams: PastExam[] = past.map((e) => {
      const ids = scopeOf(e.assessmentId);
      const key = [input.ref, e.at, ctx.km.version, ctx.evidence.attempts.filter((a) => a.createdAt <= e.at).length, ctx.evidence.reviews.filter((r) => r.createdAt <= e.at).length, ctx.evidence.disputes.map((d) => `${d.id}:${d.status}`).sort().join(","), ctx.all.map((c) => `${c.id}:${c.status}:${c.mergedInto ?? ""}`).join(",")].join("|");
      const then = asOf(key, e.at);
      const states = ids.map((t) => {
        const state = shownState(then.bands.get(t) ?? "not_seen", then.extras.get(t));
        return { topicId: t, label: label(t), state, stateLabel: STATE_LABEL[state] };
      });
      const counts = emptyCounts();
      for (const t of states) counts[t.state]++;
      const up: PastExam["since"]["up"] = [],
        down: PastExam["since"]["down"] = [];
      for (const t of states) {
        const to = shown(t.topicId);
        if (RANK[to] > RANK[t.state]) up.push({ topicId: t.topicId, label: t.label, from: t.state, to });
        else if (RANK[to] < RANK[t.state]) down.push({ topicId: t.topicId, label: t.label, from: t.state, to });
      }
      const s = e.resourceId ? scoreOf(e.resourceId) : null;
      return {
        assessmentId: e.assessmentId,
        title: e.title,
        kind: e.kind,
        at: e.at,
        topicIds: ids,
        asOf: { counts, topics: states },
        score: s ? { ...s, text: `${s.earned} of ${s.possible} points, as Canvas shows it` } : null,
        since: { up, down },
      };
    });
    return { courseId: input.courseId, exams, note: "States as of each exam date, from your answers stored up to then. Not a grade prediction." };
  }

  /** Weak topics (anything short of Mastered) behind each upcoming high-weight item: an exam's scope, else its references. */
  function overlaps(items: { itemId: string; title: string; dueAt: string | null; weight: { share: number | null; group: number; source: "canvas" | "syllabus" } | null; groupTitle: string | null }[]) {
    return items.map((i) => {
      const inScope = ctx.scope.get(i.itemId);
      let ids: string[];
      if (inScope) ids = topicIds.filter((t) => inScope.has(t));
      else {
        const materials = new Set(input.references.references(i.itemId).map((m) => m.resourceId));
        ids = topicIds.filter((t) => [...(ctx.materialsOf.get(t) ?? [])].some((m) => materials.has(m)));
      }
      const weak = ids.filter((t) => shown(t) !== "solid").map((t) => ({ topicId: t, label: label(t), state: shown(t), stateLabel: STATE_LABEL[shown(t)] }));
      return { ...i, topicIds: ids, weakTopics: weak };
    });
  }

  return {
    course,
    assessment,
    forItems,
    history,
    overlaps,
    /** For the claim check and the tests: a topic's shown state and facts. */
    topic: (id: string) => (topicSet.has(id) ? topicView(ctx.byId.get(id)!) : null),
    context: ctx,
  };
}

/** The assessment page's embed (pages builder): one upcoming exam's mastery slice. */
export function assessmentMastery(input: MasteryInput, assessmentId: string, memo?: MasteryMemo): AssessmentMasteryData | null {
  return createMastery(input, memo).assessment(assessmentId);
}
