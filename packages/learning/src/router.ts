/** N25: bounded prepared practice. No generator/provider is reachable from this router.
 * N08/N09/N10 own grading/progression/planning; this layer owns evidence and atomic persistence. */
import {
  learningRequestSchema,
  type LearningRequest,
  type LearningResult,
  type Resource,
  type StudySessionView,
  type StudyEvent,
  type StudySource,
  type StudyItemView,
} from "@magic/contracts";
import { resolveDeadline } from "@magic/domain";
import type {
  LearningStore,
  LearningSession,
  LearningAttempt,
  StoredItem,
} from "./store";
import { canonical } from "./store";
import {
  createLearnRound,
  nextQuestion,
  recordAnswer,
  flagItem,
  type LearnState,
  type LearnQuestion,
  type LearnFamily,
} from "./learn";
import { buildSession } from "./session";
import { gradeChoice, gradeNumeric, gradeTyped } from "./grade";
import { conceptState } from "./knowledge/state";
import { mistakesQueue } from "./mistakes";
// owner: study-backend. Course practice ops (additive): cards, rounds, quizzes, topic states.
import type { Grade as FsrsGrade } from "ts-fsrs";
import type { ConceptModel } from "./knowledge/state";
import type { Concept, LearningCard, LearningReview as LearningReviewRow } from "./store";
import { ROUND_SIZES } from "./learn";
import { newCard, review as reviewCard, undo as undoCard } from "./fsrs";
import { STATE_LABEL, type ConceptStateName } from "./types";
import {
  EMPTY_POOL_MESSAGE,
  type FlashcardReviewRow,
  type FlashcardSessionView,
  type FlashcardView,
  type ModuleView,
  type OpenPracticeSession,
  type PracticePathData,
  type PracticeResults,
  type PracticeSection,
  type PracticeSessionMeta,
  type TopicChip,
  type TopicResult,
  type TopicStateView,
} from "./router-types";
// end owner: study-backend
// owner: analytics. Practice analytics ops (additive): code-only rollups, 0 tokens.
import { createAnalytics, refreshTopics, type ReferencesPort } from "./analytics";
import type { AnalyticsOp, AnalyticsResult } from "./router-types";
// end owner: analytics
// owner: mastery (D57). Course mastery ops: code only, 0 tokens.
import { createMastery, createMasteryMemo, MASTERY_CONFIG } from "./mastery";
import { courseGradesData } from "./strategy/inputs";
import type { GradeSources } from "./grades";
import { memoReferences, referenceFingerprint, type FingerprintSource, type ReferencesMemo } from "./mastery/references-memo";
// end owner: mastery

export interface StudyResource {
  id: string;
  contentHash: string;
  text: string;
  title: string;
  url: string;
  observedAt: string;
  eligible: boolean;
}
/** Trusted worker-built context; never accepted from a renderer or source document. */
export interface StudyContext {
  resourceId: string;
  accountScope: string;
  courseId: string;
  inputHash: string;
  contextHash?: string;
  label?: string;
  availability: "current" | "stale" | "blocked";
  reason: string;
  resources: StudyResource[];
}
export interface LearningRouterDependencies {
  store: LearningStore;
  resolveContext(resourceId: string): StudyContext | null;
  now?: () => Date;
  // owner: analytics. A fresh references port per analytics request (the pipeline's, or the current adapter).
  analyticsReferences?: () => ReferencesPort;
  // end owner: analytics
  // owner: mastery. The coursework store's read side, for captured Canvas scores (grades and past
  // exam scores). Absent: grades answer `not_built` and past exams show no score.
  coursework?: () => GradeSources & FingerprintSource & { resource(id: string): Resource | undefined };
  // end owner: mastery
}
export interface LearningRouter {
  handle(
    request: LearningRequest,
    signal: AbortSignal,
  ): Promise<LearningResult>;
}
// owner: analytics. The analytics ops through `handle`, or directly through `analytics` (same request shape).
export interface AnalyticsRouter {
  analytics(request: unknown, signal: AbortSignal): Promise<AnalyticsResult>;
}
const ANALYTICS_OPS: readonly AnalyticsOp[] = ["analytics.assignment", "analytics.course", "analytics.agendaHints"];
// end owner: analytics
export function eligibleStudySource(
  resource: Resource,
  at = Date.now(),
): boolean {
  if (resource.deleted || resource.gitlab) return false;
  if (resource.kind !== "assignment")
    return resource.kind === "material" || resource.kind === "course";
  const locks = resource.deadlines.filter((d) => d.kind === "lock");
  if (locks.length)
    return locks.every(
      (d) =>
        d.scopeConfirmed &&
        Number.isFinite(Date.parse(d.value)) &&
        Date.parse(d.value) <= at,
    );
  const due = resolveDeadline(resource.deadlines);
  return (
    !due.conflict &&
    !!due.dueAt &&
    Number.isFinite(Date.parse(due.dueAt)) &&
    Date.parse(due.dueAt) <= at
  );
}
interface SessionState {
  schema: "study-session-1";
  resourceId: string;
  accountScope: string;
  courseId: string;
  inputHash: string;
  contextHash: string;
  revision: number;
  goal: string;
  draft: string;
  updatedAt: string;
  round: LearnState;
  current: LearnQuestion | null;
  answered: boolean;
  assistance: "none" | "hint" | "explained";
  events: StudyEvent[];
  sources: StudySource[];
  operations: Record<string, string>;
  blocks: { kind: string; reason: string; itemIds: string[] }[];
  // owner: study-backend. Present only on course practice sessions (practice.target learn/test).
  anchorIds?: string[];
  mode?: "learn" | "test";
  topicIds?: string[];
  startStates?: Record<string, ConceptStateName>;
  sections?: PracticeSection[];
}
/** owner: study-backend. A flashcard session: a queue of due cards reviewed with FSRS. */
interface CardSessionState {
  schema: "practice-cards-1";
  anchorIds: string[];
  accountScope: string;
  courseId: string;
  contextHash: string;
  revision: number;
  updatedAt: string;
  topicIds: string[];
  queue: { cardId: string; itemId: string }[];
  reviewed: FlashcardReviewRow[];
  operations: Record<string, string>;
}
function cardState(session: LearningSession): CardSessionState | null {
  const p = session.plan as Partial<CardSessionState> | null;
  return p?.schema === "practice-cards-1" && Array.isArray(p.queue) && Array.isArray(p.anchorIds)
    ? (p as CardSessionState)
    : null;
}
const CARD_KINDS = new Set(["card", "typed", "cloze", "numeric"]);
const STATE_RANK: Record<ConceptStateName, number> = { not_seen: 0, iffy: 1, getting_there: 2, solid: 3 };
const primaryConcept = (x: StoredItem) =>
  x.tags.find((t) => t.primary)?.conceptId ?? x.tags[0]?.conceptId ?? "";
const endOfLocalDay = (d: Date) => {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e.toISOString();
};
function state(session: LearningSession): SessionState | null {
  const p = session.plan as Partial<SessionState> | null;
  return p?.schema === "study-session-1" &&
    typeof p.resourceId === "string" &&
    Array.isArray(p.events)
    ? (p as SessionState)
    : null;
}
const itemKey = (id: string, version: number) => `${id}@${version}`;
const requiredChecks = [
  "policy",
  "schema",
  "quote",
  "flaws",
  "near_duplicate",
  "tags",
];
const localDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
function eligible(
  item: StoredItem,
  c: StudyContext,
  courseRef: string,
  allowCards = false,
): boolean {
  return (
    item.item.courseRef === courseRef &&
    (allowCards || item.item.kind !== "card") &&
    item.item.status === "active" &&
    item.sources.length > 0 &&
    requiredChecks.every((name) =>
      item.checks.some(
        (check) => check.check === name && check.outcome === "pass",
      ),
    ) &&
    !item.checks.some((check) => check.outcome === "fail") &&
    item.sources.every((s) => {
      const r = c.resources.find((r) => r.id === s.resourceId);
      return (
        !!r?.eligible &&
        s.quoteValid &&
        r.contentHash === s.contentHash &&
        s.start >= 0 &&
        s.end > s.start &&
        r.text.slice(s.start, s.end) === s.quote
      );
    })
  );
}
function familyPool(pool: StoredItem[], ordered: string[]): LearnFamily[] {
  const families = new Map<string, LearnFamily>();
  for (const id of ordered) {
    const selected = pool.find((p) => p.item.id === id);
    if (!selected) continue;
    if (families.has(selected.item.familyId)) continue;
    const family: LearnFamily = { familyId: selected.item.familyId };
    for (const p of [
      selected,
      ...pool.filter(
        (p) => p.item.familyId === selected.item.familyId && p !== selected,
      ),
    ]) {
      const item = p.item;
      if (item.kind === "card") continue;
      const key =
        item.kind === "mc" || item.kind === "tf" ? "recognition" : "recall";
      family[key] ??= {
        id: item.id,
        version: item.version,
        kind: item.kind,
        stem: item.stem,
        options: item.options,
        key: item.key,
        keyIdeas: item.keyIdeas,
        bPrior: item.bPrior,
      };
    }
    families.set(family.familyId, family);
  }
  return [...families.values()];
}
export function createLearningRouter(
  deps?: LearningRouterDependencies,
): LearningRouter & AnalyticsRouter {
  const time = () => deps?.now?.() ?? new Date();
  const fail = (
    op: LearningRequest["op"],
    message: string,
    status: LearningResult["status"] = "unavailable",
  ): LearningResult => ({ op, status, message });
  function scoped(session: LearningSession) {
    const p = state(session);
    if (!p || !deps) return null;
    const c = p.anchorIds
      ? courseContext(p.anchorIds)
      : deps.resolveContext(p.resourceId);
    if (
      !c ||
      c.accountScope !== p.accountScope ||
      c.courseId !== p.courseId ||
      session.courseRef !== `${c.accountScope}:${c.courseId}`
    )
      return null;
    return { p, c };
  }
  function currentPool(c: StudyContext, courseRef: string, items: StoredItem[] = deps!.store.items({ courseRef })) {
    const latest = new Map<string, StoredItem>();
    for (const item of items)
      if (
        !latest.has(item.item.id) ||
        latest.get(item.item.id)!.item.version < item.item.version
      )
        latest.set(item.item.id, item);
    return [...latest.values()].filter((p) => eligible(p, c, courseRef));
  }
  function projection(
    session: LearningSession,
    p: SessionState,
    c: StudyContext,
  ): StudySessionView {
    const pool = currentPool(c, session.courseRef!);
    const valid = new Set(pool.map((x) => itemKey(x.item.id, x.item.version)));
    const variants = p.round.families.flatMap((f) =>
      [f.recognition, f.recall].filter((v) => v !== undefined),
    );
    const stale =
      (c.contextHash ?? c.inputHash) !== p.contextHash ||
      c.inputHash !== p.inputHash ||
      variants.some((v) => !valid.has(itemKey(v.id, v.version)));
    const availability =
      c.availability !== "current"
        ? c.availability
        : stale
          ? "stale"
          : "current";
    const selected =
      p.current &&
      pool.find(
        (x) =>
          x.item.id === p.current!.itemId &&
          x.item.version === p.current!.itemVersion,
      );
    let currentItem: StudyItemView | undefined;
    if (selected && p.current && availability === "current")
      currentItem = {
        id: selected.item.id,
        version: selected.item.version,
        kind: p.current.format,
        stem: p.current.stem,
        options: p.current.options ?? null,
        ...(selected.item.unit ? { unit: selected.item.unit } : {}),
        citations: selected.sources.map((s) => ({
          resourceId: s.resourceId,
          contentHash: s.contentHash,
          start: s.start,
          end: s.end,
          quote: s.quote,
        })),
        checks: selected.checks.map(({ check, method, outcome }) => ({
          check,
          method,
          outcome,
        })),
      };
    return {
      id: session.id,
      resourceId: p.resourceId,
      accountScope: p.accountScope,
      courseId: p.courseId,
      inputHash: p.inputHash,
      revision: p.revision,
      goal: p.goal,
      draft: p.draft,
      startedAt: session.startedAt,
      updatedAt: p.updatedAt,
      availability,
      reason:
        c.availability !== "current"
          ? c.reason
          : stale
            ? "Course sources or checked items changed. Start a new session; your saved response remains here."
            : "Prepared practice; answers are checked locally.",
      status: p.current ? "active" : "complete",
      ...(currentItem ? { currentItem } : {}),
      answered: p.answered,
      events: p.events,
      sources: p.sources ?? [],
      plan: p.blocks,
    };
  }
  // owner: study-backend. Course practice helpers. Every value comes from the store and code;
  // nothing here reaches a runner, a pack or a provider (0 tokens).
  /** The course scope: each anchor is authorized by the trusted resolver; all must share one course. */
  function courseContext(anchorIds: string[]): StudyContext | null {
    const anchors = [...new Set(anchorIds)].sort();
    const all: StudyContext[] = [];
    for (const a of anchors) {
      const c = deps!.resolveContext(a);
      if (!c) return null;
      all.push(c);
    }
    const first = all[0];
    if (
      !first ||
      all.some(
        (c) =>
          c.accountScope !== first.accountScope || c.courseId !== first.courseId,
      )
    )
      return null;
    const worst =
      all.find((c) => c.availability === "blocked") ??
      all.find((c) => c.availability === "stale") ??
      first;
    const resources = new Map<string, StudyResource>();
    for (const c of all)
      for (const r of c.resources) {
        const prev = resources.get(r.id);
        // Two anchors disagreeing on a source's version make it ineligible, never silently one of them.
        resources.set(
          r.id,
          prev && prev.contentHash !== r.contentHash
            ? { ...prev, eligible: false }
            : (prev ?? r),
        );
      }
    return {
      resourceId: first.resourceId,
      accountScope: first.accountScope,
      courseId: first.courseId,
      inputHash: canonical(all.map((c) => c.inputHash)),
      contextHash: canonical(all.map((c) => c.contextHash ?? c.inputHash)),
      ...(first.label ? { label: first.label } : {}),
      availability: worst.availability,
      reason:
        worst.availability === "current"
          ? "Practice uses checked course material. This is not a grade prediction."
          : worst.reason,
      resources: [...resources.values()],
    };
  }
  function practiceScope(
    courseId: string,
    anchorIds: string[] | undefined,
  ): { c: StudyContext; ref: string; anchors: string[] } | string {
    if (!anchorIds?.length)
      return "Open a course to practice: its resources anchor the practice scope.";
    const anchors = [...new Set(anchorIds)].sort();
    const c = courseContext(anchors);
    if (!c) return "Course context is unavailable.";
    if (c.courseId !== courseId) return "Course context does not match.";
    return { c, ref: `${c.accountScope}:${c.courseId}`, anchors };
  }
  function courseMap(ref: string) {
    const active = deps!.store
      .concepts(ref)
      .filter((x) => x.status === "active");
    const byId = new Map(active.map((x) => [x.id, x]));
    const order = (a: Concept, b: Concept) =>
      a.position - b.position || (a.id < b.id ? -1 : 1);
    const moduleOf = (x: Concept): Concept | null => {
      let cur = x.parentId ? byId.get(x.parentId) : undefined;
      for (let hops = 0; cur && hops < 20; hops++) {
        if (cur.kind === "unit") return cur;
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return null;
    };
    const modules = active.filter((x) => x.kind === "unit").sort(order);
    const modulePos = new Map(modules.map((m, i) => [m.id, i]));
    const topics = active
      .filter((x) => x.kind === "concept")
      .sort(
        (a, b) =>
          (modulePos.get(moduleOf(a)?.id ?? "") ?? modules.length) -
            (modulePos.get(moduleOf(b)?.id ?? "") ?? modules.length) ||
          order(a, b),
      );
    const topicIndex = new Map(topics.map((t, i) => [t.id, i]));
    const label = (x: Concept) => x.studentLabel ?? x.label;
    return { active, byId, modules, topics, topicIndex, moduleOf, label };
  }
  type CourseMap = ReturnType<typeof courseMap>;
  /** The chosen topics: `topicIds` plus every topic under `moduleIds`. Null means the whole course. */
  function chosenTopics(
    map: CourseMap,
    topicIds: string[] | undefined,
    moduleIds: string[] | undefined,
  ): Set<string> | null | "unknown" {
    if (!topicIds?.length && !moduleIds?.length) return null;
    const known = new Set(map.topics.map((t) => t.id));
    const modules = new Set(moduleIds ?? []);
    if (
      (topicIds ?? []).some((t) => !known.has(t)) ||
      [...modules].some((m) => !map.modules.some((x) => x.id === m))
    )
      return "unknown";
    return new Set([
      ...(topicIds ?? []),
      ...map.topics
        .filter((t) => modules.has(map.moduleOf(t)?.id ?? ""))
        .map((t) => t.id),
    ]);
  }
  function topicModels(ref: string, concepts: Concept[]) {
    const store = deps!.store;
    const evidence = store.evidence(ref),
      allItems = store.items({ courseRef: ref }),
      cards = store.cards({ courseRef: ref });
    const models = conceptState(
      {
        ...evidence,
        items: new Map(
          allItems.map((x) => [
            itemKey(x.item.id, x.item.version),
            {
              bPrior: x.item.bPrior,
              options: x.item.options?.length ?? 0,
              status: x.item.status,
            },
          ]),
        ),
        cards: new Map(
          cards.map((x) => [
            x.id,
            { conceptId: x.conceptId, isConceptTrack: x.isConceptTrack },
          ]),
        ),
      },
      concepts,
      undefined,
      time(),
    );
    return new Map<string, ConceptModel>(models.map((m) => [m.conceptId, m]));
  }
  /** Latest eligible card-capable versions: card items, and recall items whose key is the back. */
  function cardPool(c: StudyContext, ref: string, items: StoredItem[] = deps!.store.items({ courseRef: ref })) {
    const latest = new Map<string, StoredItem>();
    for (const item of items)
      if (
        !latest.has(item.item.id) ||
        latest.get(item.item.id)!.item.version < item.item.version
      )
        latest.set(item.item.id, item);
    return [...latest.values()].filter(
      (x) => CARD_KINDS.has(x.item.kind) && eligible(x, c, ref, true),
    );
  }
  function cardOf(ref: string, itemId: string): LearningCard | null {
    return (
      deps!.store
        .cards({ courseRef: ref, itemId })
        .find((k) => !k.isConceptTrack) ?? null
    );
  }
  function cardEntries(c: StudyContext, ref: string, topics: Set<string> | null) {
    const cutoff = endOfLocalDay(time());
    return cardPool(c, ref)
      .filter((x) => !topics || topics.has(primaryConcept(x)))
      .map((x) => {
        const card = cardOf(ref, x.item.id);
        return { x, card, due: !card || card.fsrs.due <= cutoff };
      });
  }
  function chips(map: CourseMap, x: StoredItem): TopicChip[] {
    return x.tags.flatMap((t) => {
      const concept = map.byId.get(t.conceptId);
      return concept
        ? [{ conceptId: concept.id, label: map.label(concept), primary: t.primary }]
        : [];
    });
  }
  function topicViews(
    map: CourseMap,
    models: Map<string, ConceptModel>,
    practiceItems: StoredItem[],
    topics: Set<string> | null,
  ): TopicStateView[] {
    const perTopic = new Map<string, Set<string>>();
    for (const x of practiceItems) {
      const t = primaryConcept(x);
      perTopic.set(t, (perTopic.get(t) ?? new Set()).add(x.item.id));
    }
    return map.topics
      .filter((t) => !topics || topics.has(t.id))
      .map((t) => {
        const m = models.get(t.id),
          mod = map.moduleOf(t),
          state: ConceptStateName = m?.band ?? "not_seen";
        return {
          conceptId: t.id,
          label: map.label(t),
          moduleId: mod?.id ?? null,
          moduleLabel: mod ? map.label(mod) : null,
          state,
          stateLabel: STATE_LABEL[state],
          reasons: (m?.reasons ?? []).map((r) => ({
            text: r.text,
            clearsWhen: r.clearsWhen,
          })),
          counts: {
            answers: m?.counts.answers ?? 0,
            correct: m?.counts.correct ?? 0,
            cardReviews: m?.counts.cardReviews ?? 0,
            selfRatings: m?.counts.selfRatings ?? 0,
          },
          practiceItems: perTopic.get(t.id)?.size ?? 0,
        };
      });
  }
  const mastered = (topics: TopicStateView[]) => ({
    count: topics.filter((t) => t.state === "solid").length,
    of: topics.length,
  });
  function flashFace(
    map: CourseMap,
    x: StoredItem,
    cardId: string,
    card: LearningCard | null,
  ): FlashcardView {
    const item = x.item;
    return {
      cardId,
      itemId: item.id,
      itemVersion: item.version,
      front: item.stem,
      back:
        item.kind === "numeric"
          ? `${item.key}${item.unit ? ` ${item.unit}` : ""}`
          : String(item.key),
      topics: chips(map, x),
      citations: x.sources.map((s) => ({
        resourceId: s.resourceId,
        contentHash: s.contentHash,
        start: s.start,
        end: s.end,
        quote: s.quote,
      })),
      isNew: !card || card.fsrs.reps === 0,
    };
  }
  function flashView(
    session: LearningSession,
    f: CardSessionState,
    c: StudyContext,
  ): FlashcardSessionView {
    const ref = session.courseRef!,
      map = courseMap(ref);
    const head = f.queue[0];
    const x = head && cardPool(c, ref).find((p) => p.item.id === head.itemId);
    const changed =
      (c.contextHash ?? c.inputHash) !== f.contextHash || (!!head && !x);
    const availability =
      c.availability !== "current" ? c.availability : changed ? "stale" : "current";
    const topics = f.topicIds.length ? new Set(f.topicIds) : null;
    return {
      id: session.id,
      courseId: f.courseId,
      revision: f.revision,
      availability,
      reason:
        c.availability !== "current"
          ? c.reason
          : changed
            ? "Course sources or checked cards changed. Start a new session; your reviews are saved."
            : "Cards are scheduled locally with FSRS. This is not a grade prediction.",
      status: f.queue.length ? "active" : "complete",
      ...(head && x && availability === "current"
        ? { current: flashFace(map, x, head.cardId, cardOf(ref, head.itemId)) }
        : {}),
      remaining: f.queue.length,
      dueToday: cardEntries(c, ref, topics).filter((e) => e.due).length,
      reviewed: f.reviewed,
      topicIds: f.topicIds,
    };
  }
  function practiceMeta(p: SessionState, ref: string): PracticeSessionMeta {
    const map = courseMap(ref);
    const items = new Map(
      deps!.store
        .items({ courseRef: ref })
        .map((x) => [itemKey(x.item.id, x.item.version), x]),
    );
    const topicsByItem: Record<string, TopicChip[]> = {};
    for (const f of p.round.families)
      for (const v of [f.recognition, f.recall]) {
        const x = v && items.get(itemKey(v.id, v.version));
        if (x) topicsByItem[itemKey(v.id, v.version)] = chips(map, x);
      }
    return {
      mode: p.mode ?? "learn",
      topicIds: p.topicIds ?? [],
      sections: p.sections ?? [],
      topicsByItem,
    };
  }
  /** Saved-session ops keep their `{ session }` shape; a course practice session adds its meta. */
  function withMeta(
    view: StudySessionView,
    p: SessionState,
    session: LearningSession,
  ) {
    return p.anchorIds
      ? { session: view, practice: practiceMeta(p, session.courseRef!) }
      : { session: view };
  }
  function practiceResults(
    session: LearningSession,
    p: SessionState,
  ): PracticeResults {
    const ref = session.courseRef!,
      map = courseMap(ref),
      models = topicModels(ref, map.active);
    const items = new Map(
      deps!.store
        .items({ courseRef: ref })
        .map((x) => [itemKey(x.item.id, x.item.version), x]),
    );
    const tally = new Map<string, { answered: number; correct: number }>();
    const touched = new Set<string>(Object.keys(p.startStates ?? {}));
    for (const f of p.round.families)
      for (const v of [f.recognition, f.recall]) {
        const x = v && items.get(itemKey(v.id, v.version));
        if (x) touched.add(primaryConcept(x));
      }
    let answered = 0,
      correct = 0,
      unscored = 0,
      skipped = 0;
    for (const e of p.events) {
      if (e.kind === "skip") skipped++;
      if (e.kind !== "answer") continue;
      if (e.outcome === "undecided") {
        unscored++;
        continue;
      }
      const x = items.get(itemKey(e.itemId, e.itemVersion));
      const t = x ? primaryConcept(x) : "";
      const row = tally.get(t) ?? { answered: 0, correct: 0 };
      row.answered++;
      answered++;
      if (e.outcome === "correct") {
        row.correct++;
        correct++;
      }
      tally.set(t, row);
      if (t) touched.add(t);
    }
    const topics: TopicResult[] = map.topics
      .filter((t) => touched.has(t.id))
      .map((t) => {
        const before = p.startStates?.[t.id] ?? null,
          after: ConceptStateName = models.get(t.id)?.band ?? "not_seen";
        const delta =
          before === null ? 0 : STATE_RANK[after] - STATE_RANK[before];
        const mod = map.moduleOf(t);
        return {
          conceptId: t.id,
          label: map.label(t),
          moduleLabel: mod ? map.label(mod) : null,
          before,
          after,
          afterLabel: STATE_LABEL[after],
          direction:
            before === null || before === "not_seen"
              ? after === "not_seen"
                ? "same"
                : "new"
              : delta > 0
                ? "up"
                : delta < 0
                  ? "down"
                  : "same",
          answered: tally.get(t.id)?.answered ?? 0,
          correct: tally.get(t.id)?.correct ?? 0,
        };
      });
    const need = (r: TopicResult) =>
      r.after === "iffy" ? 0 : r.after === "getting_there" ? 1 : r.answered > r.correct ? 2 : 3;
    const studyNext = topics
      .filter((r) => r.after !== "solid" && need(r) < 3)
      .sort((a, b) => need(a) - need(b) || b.answered - b.correct - (a.answered - a.correct))
      .slice(0, 3)
      .map((r) => ({
        conceptId: r.conceptId,
        label: r.label,
        state: r.after,
        reason:
          models.get(r.conceptId)?.reasons[0]?.text ??
          (r.answered > r.correct
            ? `You missed ${r.answered - r.correct} of ${r.answered} here.`
            : "Not settled yet."),
      }));
    return {
      sessionId: session.id,
      mode: p.mode ?? "learn",
      complete: !p.current,
      answered,
      correct,
      unscored,
      skipped,
      topics,
      studyNext,
    };
  }
  const sessionOperations = (s: LearningSession) =>
    state(s)?.operations ?? cardState(s)?.operations ?? null;
  // end owner: study-backend
  // owner: analytics. After practice commits, recompute the touched topics' cached state. The cache is
  // rebuildable: if this refresh fails, the next analytics read finds those rows stale and recomputes
  // them, so the committed practice result is never turned into a failure here.
  function refreshAnalytics(ref: string, conceptIds: string[]) {
    try {
      refreshTopics(deps!.store, ref, conceptIds, time());
    } catch {
      // Stale rows are detected by their evidence mark on the next read.
    }
  }
  async function analytics(raw: unknown, signal: AbortSignal): Promise<AnalyticsResult> {
    const guess = typeof raw === "object" && raw !== null && "op" in raw ? raw.op : undefined;
    const named = ANALYTICS_OPS.find((o) => o === guess) ?? "analytics.course";
    const parsed = learningRequestSchema.safeParse(raw);
    if (!parsed.success) return { op: named, status: "failed", message: "Invalid analytics request." };
    const request = parsed.data;
    if (
      request.op !== "analytics.assignment" &&
      request.op !== "analytics.course" &&
      request.op !== "analytics.agendaHints"
    )
      return { op: named, status: "failed", message: "Invalid analytics request." };
    const op = request.op;
    if (!deps) return { op, status: "not_built", message: "This study feature isn't built yet." };
    if (!deps.analyticsReferences)
      return { op, status: "not_built", message: "Course references aren't connected yet." };
    if (signal.aborted) return { op, status: "unavailable", message: "Analytics request cancelled." };
    const scope = practiceScope(request.courseId, request.anchorIds);
    if (typeof scope === "string") return { op, status: "unavailable", message: scope };
    try {
      const pool = new Map<string, StoredItem>();
      for (const x of [...currentPool(scope.c, scope.ref), ...cardPool(scope.c, scope.ref)]) pool.set(x.item.id, x);
      const a = createAnalytics({
        store: deps.store,
        ref: scope.ref,
        courseId: scope.c.courseId,
        references: deps.analyticsReferences(),
        now: time(),
        practiceItems: [...pool.values()],
      });
      if (op === "analytics.assignment") {
        const data = a.assignment(request.assignmentId);
        return data
          ? { op, status: "ok", data }
          : { op, status: "unavailable", message: "That assignment isn't in this course." };
      }
      if (op === "analytics.course")
        return { op, status: "ok", data: a.course(request.sessions ? { sessions: request.sessions } : {}) };
      return { op, status: "ok", data: a.agendaHints() };
    } catch {
      return { op, status: "failed", message: "Analytics could not be computed. Try again after the course refreshes." };
    }
  }
  // end owner: analytics
  // owner: mastery (D57). Course mastery: states with the delayed-recall tier, due-for-review,
  // one next step, per-exam slices, agenda roll-ups, past exams, grades, claims and hides.
  const masteryMemo = createMasteryMemo();
  const referencesMemo = new Map<string, ReferencesMemo>();
  let handleRef: LearningRouter["handle"] | null = null;
  const MASTERY_OPS = new Set(["course.mastery", "mastery.assessment", "mastery.forItems", "mastery.history", "mastery.claim", "mastery.hide", "course.grades"]);
  type MasteryRequest = Extract<LearningRequest, { op: "course.mastery" | "mastery.assessment" | "mastery.forItems" | "mastery.history" | "mastery.claim" | "mastery.hide" | "course.grades" }>;
  async function mastery(request: MasteryRequest, signal: AbortSignal): Promise<LearningResult> {
    const op = request.op;
    if (!deps!.analyticsReferences) return fail(op, "Course references aren't connected yet.", "not_built");
    const scope = practiceScope(request.courseId, request.anchorIds);
    if (typeof scope === "string") return fail(op, scope);
    const { c, ref } = scope;
    const store = deps!.store;
    if (op === "mastery.hide") {
      const topic = store.concepts(ref).find((t) => t.id === request.topicId && t.kind === "concept");
      if (!topic) return fail(op, "That topic isn't in this course's map.");
      if (request.hidden ? topic.status !== "active" : topic.status !== "hidden")
        return fail(op, request.hidden ? "That topic is already hidden or merged." : "That topic isn't hidden.");
      if (signal.aborted) return fail(op, "Study request cancelled.");
      store.editConcept(topic.id, { kind: request.hidden ? "hide" : "restore" });
      const name = topic.studentLabel ?? topic.label;
      return {
        op,
        status: "ok",
        data: {
          topicId: topic.id,
          hidden: request.hidden,
          message: request.hidden
            ? `${name} is hidden from this course's mastery. Your answers on it are kept; show it again any time.`
            : `${name} is back in this course's mastery.`,
        },
      };
    }
    // One read of the course's items and cards per request, shared by the pools, the evidence and the rules.
    const items = store.items({ courseRef: ref });
    const cards = store.cards({ courseRef: ref });
    const questionPool = currentPool(c, ref, items);
    const pool = new Map<string, StoredItem>();
    for (const x of [...questionPool, ...cardPool(c, ref, items)]) pool.set(x.item.id, x);
    const coursework = deps!.coursework?.();
    const course = { accountScope: c.accountScope, courseId: c.courseId };
    const input = {
      store,
      ref,
      courseId: c.courseId,
      references: memoReferences(deps!.analyticsReferences(), referenceFingerprint(coursework, course), referencesMemo, ref),
      now: time(),
      practiceItems: [...pool.values()],
      items,
      cards,
    };
    if (op === "mastery.claim") {
      const topic = store.concepts(ref).find((t) => t.id === request.topicId && t.kind === "concept" && t.status === "active");
      if (!topic) return fail(op, "That topic isn't in this course's map.");
      const m = createMastery(input, masteryMemo);
      const view = m.topic(topic.id)!;
      // The claim is kept as what the student said (a self-rating, which never moves the state); code checks it.
      const ratingId = `claim:${request.operationId}`;
      if (!store.evidence(ref).selfRatings.some((s) => s.id === ratingId)) {
        const at = time();
        store.addSelfRating({ id: ratingId, conceptId: topic.id, rating: "know_it", delayed: view.lastEvidenceDay !== null && view.lastEvidenceDay < localDay(at), localDay: localDay(at), createdAt: at.toISOString() });
      }
      const families = new Set(questionPool.filter((x) => primaryConcept(x) === topic.id).map((x) => x.item.familyId)).size;
      const name = topic.studentLabel ?? topic.label;
      if (!families)
        return {
          op,
          status: "ok",
          data: {
            topicId: topic.id,
            recorded: "know_it",
            check: null,
            message: `Noted. ${name} has no practice items yet, so there's nothing to check it with. Generate some to confirm it.`,
            generate: { type: "pack", pack: "quiz", scope: { courseId: c.courseId, topicIds: [topic.id] } },
          },
        };
      const count = Math.min(MASTERY_CONFIG.claimCheck, families);
      const started = await handleRef!(
        { op: "practice.target", courseId: c.courseId, anchorIds: request.anchorIds, topicIds: [topic.id], mode: "test", count, operationId: request.operationId },
        signal,
      );
      if (started.status !== "ok") return { ...started, op };
      return {
        op,
        status: "ok",
        data: {
          topicId: topic.id,
          recorded: "know_it",
          check: started.data,
          message: `Noted. Answer ${count === 1 ? "this question" : `these ${count} questions`} to confirm it; the results update ${name} like any practice.`,
          generate: null,
        },
      };
    }
    try {
      if (op === "course.grades") {
        if (!coursework) return fail(op, "Captured grades aren't connected yet.", "not_built");
        return { op, status: "ok", data: courseGradesData(input, coursework, c.accountScope, masteryMemo).data };
      }
      const m = createMastery(input, masteryMemo);
      if (op === "course.mastery") return { op, status: "ok", data: m.course() };
      if (op === "mastery.assessment") {
        const data = m.assessment(request.assessmentId);
        return data ? { op, status: "ok", data } : fail(op, "That isn't an upcoming exam in this course.");
      }
      if (op === "mastery.forItems") return { op, status: "ok", data: m.forItems(request.itemIds) };
      const scoreOf = (resourceId: string) => {
        const r = coursework?.resource(resourceId);
        if (!r || r.deleted || r.courseId !== c.courseId || !coursework!.sources().some((s) => s.id === r.sourceId && s.accountScope === c.accountScope)) return null;
        const score = r.submission?.score;
        return typeof score === "number" && typeof r.points === "number" && r.points > 0 ? { earned: score, possible: r.points } : null;
      };
      return { op, status: "ok", data: m.history(scoreOf) };
    } catch {
      return fail(op, "Course mastery could not be computed. Try again after the course refreshes.", "failed");
    }
  }
  // end owner: mastery
  const router: LearningRouter & AnalyticsRouter = {
    analytics,
    async handle(raw, signal) {
      const parsed = learningRequestSchema.safeParse(raw);
      if (!parsed.success)
        return fail(raw.op, "Invalid learning request.", "failed");
      const request = parsed.data,
        op = request.op;
      if (!deps)
        return fail(op, "This study feature isn't built yet.", "not_built");
      if (signal.aborted) return fail(op, "Study request cancelled.");
      // owner: analytics
      if (op === "analytics.assignment" || op === "analytics.course" || op === "analytics.agendaHints")
        return analytics(request, signal);
      // end owner: analytics
      // owner: mastery
      if (MASTERY_OPS.has(op)) return mastery(request as MasteryRequest, signal);
      // end owner: mastery
      const store = deps.store;
      try {
        if (op === "study.sessions") {
          const c = deps.resolveContext(request.resourceId);
          if (!c) return fail(op, "Course context is unavailable.");
          const sessions = store
            .sessions(`${c.accountScope}:${c.courseId}`)
            .flatMap((s) => {
              const v = scoped(s);
              return v && v.p.resourceId === request.resourceId && !v.p.anchorIds
                ? [projection(s, v.p, v.c)]
                : [];
            });
          return { op, status: "ok", data: { sessions } };
        }
        if (op === "study.plan") {
          if (!request.resourceId || !request.operationId)
            return fail(
              op,
              "Open a course resource to start a saved study session.",
            );
          if (
            request.assessmentId ||
            (request.filter && request.filter !== "all")
          )
            return fail(
              op,
              "Assessment and filtered sessions aren't connected yet.",
              "not_built",
            );
          const c = deps.resolveContext(request.resourceId);
          if (!c) return fail(op, "Course context is unavailable.");
          if (request.courseId && request.courseId !== c.courseId)
            return fail(op, "Course context does not match.");
          const fingerprint = canonical(request),
            ref = `${c.accountScope}:${c.courseId}`;
          const prior = store.sessions(ref).find((s) => {
            const p = state(s);
            return (
              !!p &&
              p.resourceId === request.resourceId &&
              Object.hasOwn(p.operations, request.operationId!)
            );
          });
          if (prior) {
            const p = state(prior)!;
            return p.operations[request.operationId] === fingerprint
              ? { op, status: "ok", data: { session: projection(prior, p, c) } }
              : fail(
                  op,
                  "Operation ID was already used for a different request.",
                  "failed",
                );
          }
          if (c.availability !== "current") return fail(op, c.reason);
          if (request.inputHash && request.inputHash !== c.inputHash)
            return fail(
              op,
              "Course context changed. Reopen it before starting.",
            );
          store.course(c.accountScope, c.courseId, c.label);
          const pool = currentPool(c, ref).slice(0, 1000),
            concepts = store.concepts(ref).filter((x) => x.status === "active");
          if (!pool.length)
            return fail(
              op,
              "No checked practice is ready for this course yet. Your course material is still available.",
            );
          const evidence = store.evidence(ref),
            allItems = store.items({ courseRef: ref }),
            cards = store.cards({ courseRef: ref });
          const models = conceptState(
            {
              ...evidence,
              items: new Map(
                allItems.map((x) => [
                  itemKey(x.item.id, x.item.version),
                  {
                    bPrior: x.item.bPrior,
                    options: x.item.options?.length ?? 0,
                    status: x.item.status,
                  },
                ]),
              ),
              cards: new Map(
                cards.map((x) => [
                  x.id,
                  { conceptId: x.conceptId, isConceptTrack: x.isConceptTrack },
                ]),
              ),
            },
            concepts,
            undefined,
            time(),
          );
          const sessionId = crypto.randomUUID();
          const planned = buildSession({
            sessionId,
            minutes: request.minutes,
            difficulty: request.difficulty,
            concepts,
            models,
            pool: pool.map((x) => ({
              id: x.item.id,
              kind: x.item.kind,
              options: x.item.options?.length ?? 0,
              bPrior: x.item.bPrior,
              tags: x.tags,
            })),
            mistakes: mistakesQueue(evidence.attempts, {
              today: localDay(time()),
              disputes: evidence.disputes,
            }),
            dueCards: [],
          });
          const round = createLearnRound(
            familyPool(
              pool,
              planned.blocks.flatMap((b) => b.itemIds),
            ),
            { size: 10 },
          );
          const current = nextQuestion(round);
          if (!current)
            return fail(
              op,
              "No checked practice matches this course's concept map yet.",
            );
          const at = time().toISOString();
          const p: SessionState = {
            schema: "study-session-1",
            resourceId: c.resourceId,
            accountScope: c.accountScope,
            courseId: c.courseId,
            inputHash: c.inputHash,
            contextHash: c.contextHash ?? c.inputHash,
            revision: 0,
            goal: request.goal ?? "Practice this course",
            draft: "",
            updatedAt: at,
            round,
            current,
            answered: false,
            assistance: "none",
            events: [],
            sources: c.resources
              .filter((r) =>
                pool.some(
                  (item) =>
                    round.families.some(
                      (f) => f.familyId === item.item.familyId,
                    ) &&
                    item.sources.some((source) => source.resourceId === r.id),
                ),
              )
              .map((r) => ({
                resourceId: r.id,
                contentHash: r.contentHash,
                title: r.title,
                url: r.url,
                observedAt: r.observedAt,
              })),
            operations: { [request.operationId]: fingerprint },
            blocks: planned.blocks,
          };
          const s: LearningSession = {
            id: sessionId,
            courseRef: ref,
            kind: "learn",
            plan: p,
            minutes: request.minutes,
            difficulty: request.difficulty,
            startedAt: at,
            endedAt: null,
          };
          if (signal.aborted) return fail(op, "Study request cancelled.");
          if (!store.commitSession(s, null))
            return fail(op, "Study session changed. Reload it.");
          return { op, status: "ok", data: { session: projection(s, p, c) } };
        }
        // owner: study-backend. Course practice ops. Without `anchorIds` they keep their earlier answer.
        if (op === "practice.path" && request.anchorIds) {
          const scope = practiceScope(request.courseId, request.anchorIds);
          if (typeof scope === "string") return fail(op, scope);
          const { c, ref } = scope,
            map = courseMap(ref),
            models = topicModels(ref, map.active);
          const questions = currentPool(c, ref),
            cards = cardEntries(c, ref, null);
          const practiceItems = [
            ...questions,
            ...cards.map((e) => e.x).filter((x) => x.item.kind === "card"),
          ];
          const topics = topicViews(map, models, practiceItems, null);
          const count = (xs: StoredItem[], ids: Set<string>) =>
            xs.filter((x) => ids.has(primaryConcept(x))).length;
          const modules: ModuleView[] = map.modules.map((m) => {
            const topicIds = map.topics
              .filter((t) => map.moduleOf(t)?.id === m.id)
              .map((t) => t.id);
            const ids = new Set(topicIds);
            return {
              moduleId: m.id,
              label: map.label(m),
              position: m.position,
              topicIds,
              questions: count(questions, ids),
              cards: count(
                cards.map((e) => e.x),
                ids,
              ),
            };
          });
          const openSessions: OpenPracticeSession[] = store
            .sessions(ref)
            .flatMap((s): OpenPracticeSession[] => {
              if (s.endedAt) return [];
              const p = state(s),
                f = cardState(s);
              if (p?.anchorIds)
                return [
                  {
                    sessionId: s.id,
                    mode: p.mode ?? "learn",
                    goal: p.goal,
                    updatedAt: p.updatedAt,
                  },
                ];
              if (f)
                return [
                  {
                    sessionId: s.id,
                    mode: "flashcards",
                    goal: "Flashcards",
                    updatedAt: f.updatedAt,
                  },
                ];
              return [];
            })
            .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
            .slice(0, 5);
          const ready = questions.length + cards.length > 0;
          const data: PracticePathData = {
            courseId: c.courseId,
            availability: c.availability,
            reason: c.reason,
            ready,
            questions: questions.length,
            cards: {
              total: cards.length,
              dueToday: cards.filter((e) => e.due).length,
            },
            modules,
            unsectionedTopicIds: map.topics
              .filter((t) => !map.moduleOf(t))
              .map((t) => t.id),
            topics,
            mastered: mastered(topics),
            openSessions,
          };
          return ready
            ? { op, status: "ok", data }
            : { op, status: "unavailable", message: EMPTY_POOL_MESSAGE, data };
        }
        if (op === "knowledge.state" && request.anchorIds) {
          const scope = practiceScope(request.courseId, request.anchorIds);
          if (typeof scope === "string") return fail(op, scope);
          const { c, ref } = scope,
            map = courseMap(ref);
          const topicSet = chosenTopics(map, request.topicIds, request.moduleIds);
          if (topicSet === "unknown")
            return fail(op, "Those topics aren't in this course's map.");
          const practiceItems = [
            ...currentPool(c, ref),
            ...cardPool(c, ref).filter((x) => x.item.kind === "card"),
          ];
          const topics = topicViews(
            map,
            topicModels(ref, map.active),
            practiceItems,
            topicSet,
          );
          return {
            op,
            status: "ok",
            data: { courseId: c.courseId, topics, mastered: mastered(topics) },
          };
        }
        if (op === "practice.target" && request.anchorIds) {
          if (
            request.assessmentId ||
            request.description ||
            (request.filter && request.filter !== "all") ||
            request.mode === "write"
          )
            return fail(
              op,
              "Assessment, described, filtered and Write sessions aren't connected yet.",
              "not_built",
            );
          const scope = practiceScope(request.courseId, request.anchorIds);
          if (typeof scope === "string") return fail(op, scope);
          const { c, ref, anchors } = scope;
          if (!request.operationId)
            return fail(op, "An operation ID is required to start practice.");
          const fingerprint = canonical(request);
          const prior = store.sessions(ref).find((s) => {
            const ops = sessionOperations(s);
            return !!ops && Object.hasOwn(ops, request.operationId!);
          });
          if (prior) {
            const ops = sessionOperations(prior)!;
            if (ops[request.operationId] !== fingerprint)
              return fail(
                op,
                "Operation ID was already used for a different request.",
                "failed",
              );
            const f = cardState(prior),
              p = state(prior);
            if (f) return { op, status: "ok", data: { flashcards: flashView(prior, f, c) } };
            if (p) return { op, status: "ok", data: withMeta(projection(prior, p, c), p, prior) };
          }
          if (c.availability !== "current") return fail(op, c.reason);
          store.course(c.accountScope, c.courseId, c.label);
          const map = courseMap(ref);
          const topicSet = chosenTopics(map, request.topicIds, request.moduleIds);
          if (topicSet === "unknown")
            return fail(op, "Those topics aren't in this course's map.");
          const pool = currentPool(c, ref);
          const nothingPrepared = !pool.length && !cardPool(c, ref).length;
          if (nothingPrepared) return fail(op, EMPTY_POOL_MESSAGE);
          const at = time().toISOString();
          const sessionId = crypto.randomUUID();
          if (request.mode === "flashcards") {
            const entries = cardEntries(c, ref, topicSet);
            if (!entries.length)
              return fail(op, "No checked cards cover the chosen topics yet.");
            const due = entries
              .filter((e) => e.due)
              .sort(
                (a, b) =>
                  (a.card ? 0 : 1) - (b.card ? 0 : 1) ||
                  (a.card?.fsrs.due ?? "").localeCompare(b.card?.fsrs.due ?? "") ||
                  (map.topicIndex.get(primaryConcept(a.x)) ?? 0) -
                    (map.topicIndex.get(primaryConcept(b.x)) ?? 0) ||
                  (a.x.item.id < b.x.item.id ? -1 : 1),
              )
              .slice(0, request.count);
            if (!due.length) {
              const next = entries
                .map((e) => e.card?.fsrs.due ?? "")
                .filter(Boolean)
                .sort()[0];
              return fail(
                op,
                `Nothing is due today.${next ? ` The next card is due ${next.slice(0, 10)}.` : ""}`,
              );
            }
            const f: CardSessionState = {
              schema: "practice-cards-1",
              anchorIds: anchors,
              accountScope: c.accountScope,
              courseId: c.courseId,
              contextHash: c.contextHash ?? c.inputHash,
              revision: 0,
              updatedAt: at,
              topicIds: topicSet ? [...topicSet] : [],
              queue: due.map((e) => ({
                cardId: e.card?.id ?? `card:${ref}:${e.x.item.id}`,
                itemId: e.x.item.id,
              })),
              reviewed: [],
              operations: { [request.operationId]: fingerprint },
            };
            const s: LearningSession = {
              id: sessionId,
              courseRef: ref,
              kind: "flashcards",
              plan: f,
              minutes: Math.max(1, Math.ceil(due.length / 2)),
              difficulty: request.difficulty ?? "normal",
              startedAt: at,
              endedAt: null,
            };
            if (signal.aborted) return fail(op, "Study request cancelled.");
            if (!store.commitSession(s, null))
              return fail(op, "Study session changed. Reload it.");
            return { op, status: "ok", data: { flashcards: flashView(s, f, c) } };
          }
          const mode = request.mode;
          const inScope = pool.filter(
            (x) => !topicSet || topicSet.has(primaryConcept(x)),
          );
          if (!inScope.length)
            return fail(
              op,
              pool.length
                ? "No checked questions cover the chosen topics yet."
                : "No checked questions are ready yet; this course has cards only.",
            );
          const models = topicModels(ref, map.active);
          const topicIdx = (x: StoredItem) =>
            map.topicIndex.get(primaryConcept(x)) ?? map.topics.length;
          const byId = (a: StoredItem, b: StoredItem) =>
            a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
          let families: LearnFamily[];
          if (mode === "learn") {
            // Iffy first, then Getting there, then Not seen yet, then Mastered; module order within.
            const need: Record<ConceptStateName, number> = {
              iffy: 0,
              getting_there: 1,
              not_seen: 2,
              solid: 3,
            };
            const ordered = [...inScope].sort(
              (a, b) =>
                need[models.get(primaryConcept(a))?.band ?? "not_seen"] -
                  need[models.get(primaryConcept(b))?.band ?? "not_seen"] ||
                topicIdx(a) - topicIdx(b) ||
                byId(a, b),
            );
            const size =
              [...ROUND_SIZES].reverse().find((n) => n <= request.count) ??
              ROUND_SIZES[0];
            families = familyPool(
              inScope,
              ordered.map((x) => x.item.id),
            ).slice(0, size);
          } else {
            // A quiz sectioned by module: sections in module order, questions spread across them.
            const bySection = new Map<string, StoredItem[]>();
            for (const x of [...inScope].sort((a, b) => topicIdx(a) - topicIdx(b) || byId(a, b))) {
              const topic = map.byId.get(primaryConcept(x));
              const key = (topic && map.moduleOf(topic)?.id) ?? "";
              bySection.set(key, [...(bySection.get(key) ?? []), x]);
            }
            const lanes = [...bySection.values()].map((xs) =>
              familyPool(
                xs,
                xs.map((x) => x.item.id),
              ),
            );
            const picked = lanes.map(() => [] as LearnFamily[]);
            for (let n = 0, i = 0; n < request.count; i++) {
              if (lanes.every((l, k) => picked[k]!.length >= l.length)) break;
              const k = i % lanes.length;
              const next = lanes[k]![picked[k]!.length];
              if (next) {
                picked[k]!.push(next);
                n++;
              }
            }
            families = picked.flat();
          }
          const round = createLearnRound(families, { size: families.length });
          const current = nextQuestion(round);
          if (!current)
            return fail(op, "No checked practice matches this course's concept map yet.");
          const variants = round.families.flatMap((f) =>
            [f.recognition, f.recall].filter((v) => v !== undefined),
          );
          const storedOf = (id: string) => inScope.find((x) => x.item.id === id);
          const sections: PracticeSection[] = [];
          for (const f of round.families) {
            const first = f.recognition ?? f.recall;
            const topic = first && map.byId.get(primaryConcept(storedOf(first.id)!));
            const mod = topic ? map.moduleOf(topic) : null;
            const key = mod?.id ?? null;
            let section = sections.find((s) => s.moduleId === key);
            if (!section) {
              section = {
                moduleId: key,
                label: mod ? map.label(mod) : "Other topics",
                itemIds: [],
              };
              sections.push(section);
            }
            for (const v of [f.recognition, f.recall])
              if (v) section.itemIds.push(v.id);
          }
          const startStates: Record<string, ConceptStateName> = {};
          for (const v of variants)
            for (const t of storedOf(v.id)?.tags ?? [])
              startStates[t.conceptId] = models.get(t.conceptId)?.band ?? "not_seen";
          const topicNames = topicSet
            ? map.topics.filter((t) => topicSet.has(t.id)).map(map.label)
            : [];
          const goal =
            mode === "test"
              ? `Quiz: ${sections.map((s) => s.label).join(", ")}`
              : topicNames.length
                ? `Learn round: ${topicNames.slice(0, 3).join(", ")}${topicNames.length > 3 ? ` and ${topicNames.length - 3} more` : ""}`
                : "Learn round";
          const p: SessionState = {
            schema: "study-session-1",
            resourceId: c.resourceId,
            accountScope: c.accountScope,
            courseId: c.courseId,
            inputHash: c.inputHash,
            contextHash: c.contextHash ?? c.inputHash,
            revision: 0,
            goal,
            draft: "",
            updatedAt: at,
            round,
            current,
            answered: false,
            assistance: "none",
            events: [],
            sources: c.resources
              .filter((r) =>
                inScope.some(
                  (item) =>
                    round.families.some((f) => f.familyId === item.item.familyId) &&
                    item.sources.some((source) => source.resourceId === r.id),
                ),
              )
              .map((r) => ({
                resourceId: r.id,
                contentHash: r.contentHash,
                title: r.title,
                url: r.url,
                observedAt: r.observedAt,
              })),
            operations: { [request.operationId]: fingerprint },
            blocks: [
              {
                kind: mode,
                reason:
                  mode === "test"
                    ? "A quiz sectioned by module; each question once."
                    : "A Learn round: a missed question comes back after two others.",
                itemIds: variants.map((v) => v.id),
              },
            ],
            anchorIds: anchors,
            mode,
            topicIds: topicSet ? [...topicSet] : [],
            startStates,
            sections,
          };
          const s: LearningSession = {
            id: sessionId,
            courseRef: ref,
            kind: mode,
            plan: p,
            minutes: Math.max(1, variants.length),
            difficulty: request.difficulty ?? "normal",
            startedAt: at,
            endedAt: null,
          };
          if (signal.aborted) return fail(op, "Study request cancelled.");
          if (!store.commitSession(s, null))
            return fail(op, "Study session changed. Reload it.");
          return { op, status: "ok", data: withMeta(projection(s, p, c), p, s) };
        }
        if (op === "study.review" || op === "study.undoReview") {
          if (
            !request.sessionId ||
            request.revision === undefined ||
            !request.operationId
          )
            return fail(op, "Open a flashcard session to review cards.");
          const session = store.session(request.sessionId);
          const f = session && cardState(session);
          if (!session || !f) return fail(op, "Flashcard session is unavailable.");
          const c = courseContext(f.anchorIds);
          const ref = session.courseRef!;
          if (
            !c ||
            c.accountScope !== f.accountScope ||
            c.courseId !== f.courseId ||
            ref !== `${c.accountScope}:${c.courseId}`
          )
            return fail(op, "Flashcard session is unavailable for this course and account.");
          const fingerprint = canonical(request);
          if (Object.hasOwn(f.operations, request.operationId))
            return f.operations[request.operationId] === fingerprint
              ? { op, status: "ok", data: { flashcards: flashView(session, f, c) } }
              : fail(op, "Operation ID was already used for a different request.", "failed");
          if (request.revision !== f.revision)
            return fail(op, "Flashcard session changed. Reload it before continuing.");
          const view = flashView(session, f, c);
          if (view.availability !== "current") return fail(op, view.reason);
          const next = structuredClone(f);
          const now = time();
          const meta = {
            id: crypto.randomUUID(),
            reviewMs: request.op === "study.review" ? request.reviewMs : 0,
            localDay: localDay(now),
          };
          let written: { card: LearningCard; review: LearningReviewRow };
          if (request.op === "study.review") {
            const head = next.queue[0];
            if (!head || head.cardId !== request.cardId)
              return fail(op, "That card isn't the current card. Reload the session.");
            const x = cardPool(c, ref).find((p) => p.item.id === head.itemId);
            if (!x) return fail(op, "This card's source or checks changed. Start a new session.");
            const base =
              cardOf(ref, head.itemId) ??
              newCard(
                {
                  id: head.cardId,
                  itemId: x.item.id,
                  courseRef: ref,
                  conceptId: primaryConcept(x),
                },
                now,
              );
            // ts-fsrs's Grade is its Rating enum without Manual: Again 1 · Hard 2 · Good 3 · Easy 4.
            written = reviewCard(
              { ...base, itemVersion: x.item.version },
              request.rating as unknown as FsrsGrade,
              now,
              meta,
            );
            next.queue.shift();
            next.reviewed.push({
              cardId: base.id,
              reviewId: written.review.id,
              rating: request.rating,
              undone: false,
            });
          } else {
            const reviewId = request.reviewId;
            const row = next.reviewed.find((r) => r.reviewId === reviewId && !r.undone);
            if (!row) return fail(op, "That review can't be undone in this session.");
            const card = store.cards({ courseRef: ref }).find((k) => k.id === row.cardId);
            const logged = store.evidence(ref).reviews.find((r) => r.id === reviewId);
            if (!card || !logged)
              return fail(op, "That review is no longer available to undo.");
            written = undoCard(card, logged, now, meta);
            row.undone = true;
            next.queue.unshift({ cardId: card.id, itemId: card.itemId });
          }
          next.revision++;
          next.updatedAt = now.toISOString();
          next.operations = { ...next.operations, [request.operationId]: fingerprint };
          const updated: LearningSession = {
            ...session,
            plan: next,
            endedAt: next.queue.length ? null : now.toISOString(),
          };
          if (signal.aborted) return fail(op, "Study request cancelled.");
          // The worker handles one request at a time and every call below is synchronous, so the
          // revision checked above still holds; the review log is append-only and undoable.
          store.putCard(written.card);
          store.addReview(written.review);
          if (!store.commitSession(updated, request.revision))
            return fail(op, "Flashcard session changed. Reload it before continuing.");
          refreshAnalytics(ref, [written.card.conceptId]); // owner: analytics
          return { op, status: "ok", data: { flashcards: flashView(updated, next, c) } };
        }
        if (op === "study.submit") {
          const session = store.session(request.sessionId);
          const scope = session && scoped(session);
          if (!session || !scope || !scope.p.anchorIds)
            return fail(op, "Results are available for course practice sessions.");
          refreshAnalytics(session.courseRef!, []); // owner: analytics: settle any topic left stale
          return { op, status: "ok", data: { results: practiceResults(session, scope.p) } };
        }
        // end owner: study-backend
        if (
          op !== "study.session" &&
          op !== "study.resume" &&
          op !== "study.draft" &&
          op !== "study.advance" &&
          op !== "study.answer" &&
          op !== "study.hint"
        )
          return fail(op, "This study feature isn't built yet.", "not_built");
        const session = store.session(request.sessionId);
        if (!session) return fail(op, "Study session is unavailable.");
        // owner: study-backend. A flashcard session reads through study.session / study.resume.
        const cards = cardState(session);
        if (cards && (op === "study.session" || op === "study.resume")) {
          const c = courseContext(cards.anchorIds);
          if (
            !c ||
            c.accountScope !== cards.accountScope ||
            c.courseId !== cards.courseId ||
            session.courseRef !== `${c.accountScope}:${c.courseId}`
          )
            return fail(op, "Flashcard session is unavailable for this course and account.");
          return { op, status: "ok", data: { flashcards: flashView(session, cards, c) } };
        }
        // end owner: study-backend
        const scope = scoped(session);
        if (!scope)
          return fail(
            op,
            "Study session is unavailable for this course and account.",
          );
        const { c } = scope,
          p = structuredClone(scope.p),
          view = projection(session, p, c);
        if (op === "study.session" || op === "study.resume")
          return { op, status: "ok", data: withMeta(view, p, session) };
        if (!request.operationId || request.revision === undefined)
          return fail(op, "A session revision and operation ID are required.");
        const fingerprint = canonical(request);
        if (Object.hasOwn(p.operations, request.operationId))
          return p.operations[request.operationId] === fingerprint
            ? { op, status: "ok", data: withMeta(view, p, session) }
            : fail(
                op,
                "Operation ID was already used for a different request.",
                "failed",
              );
        if (request.revision !== p.revision)
          return fail(
            op,
            "Study session changed. Reload it before continuing.",
          );
        // Draft recovery remains possible when source freshness or policy blocks practice.
        if (op !== "study.draft" && view.availability !== "current")
          return fail(op, view.reason);
        if (p.events.length >= 1000 || Object.keys(p.operations).length >= 5000)
          return fail(op, "This session is full. Start another session.");
        const at = time().toISOString();
        let attempt: LearningAttempt | undefined;
        if (op === "study.draft") p.draft = request.draft;
        else {
          const q = p.current;
          if (!q) return fail(op, "This study round is complete.");
          const selected = currentPool(c, session.courseRef!).find(
            (x) => x.item.id === q.itemId && x.item.version === q.itemVersion,
          );
          if (!selected)
            return fail(
              op,
              "The question's source or checks changed. Start a new session.",
            );
          const item = selected.item;
          const event = (
            kind: StudyEvent["kind"],
            text: string,
          ): StudyEvent => ({
            id: crypto.randomUUID(),
            operationId: request.operationId!,
            itemId: item.id,
            itemVersion: item.version,
            kind,
            text,
            createdAt: at,
            assistance: p.assistance,
          });
          if (op === "study.advance") {
            if (request.action === "next" && !p.answered)
              return fail(op, "Answer or skip this question first.");
            if (request.action === "skip" && !p.answered) {
              p.events.push(event("skip", "Skipped without a score."));
              p.round = flagItem(p.round, item.id);
            }
            p.current = nextQuestion(p.round);
            p.answered = false;
            p.assistance = "none";
            p.draft = "";
          } else if (op === "study.hint") {
            if (request.itemId !== item.id)
              return fail(op, "The question changed. Reload the session.");
            if (p.answered)
              return fail(
                op,
                "Continue to the next question before asking for a hint.",
              );
            if (
              !item.explanation ||
              !selected.checks.some(
                (check) =>
                  check.check === "explanation" && check.outcome === "pass",
              )
            )
              return fail(
                op,
                "This question has no prepared explanation. No model was called.",
              );
            // The canonical checked item stores an explanation, not a separate smaller hint. Label the exposure honestly.
            p.assistance = "explained";
            p.events.push(event("explain", item.explanation));
          } else {
            if (p.answered)
              return fail(
                op,
                "This question was already answered. Continue first.",
              );
            if (
              request.itemId !== item.id ||
              request.itemVersion !== item.version
            )
              return fail(op, "The question changed. Reload the session.");
            const response = request.response;
            if (
              item.kind === "mc" || item.kind === "tf"
                ? response.kind !== "choice" ||
                  !item.options?.some((o) => o.id === response.optionId)
                : item.kind === "numeric"
                  ? response.kind !== "number"
                  : response.kind !== "text"
            )
              return fail(
                op,
                "Answer format does not match this question.",
                "failed",
              );
            const grade =
              response.kind === "choice"
                ? gradeChoice(item, response.optionId)
                : response.kind === "number"
                  ? gradeNumeric(item, response.value, response.unit)
                  : gradeTyped(
                      { ...item, key: String(item.key) },
                      response.text,
                    );
            const score =
              "score" in grade
                ? (grade.score as number | null)
                : grade.outcome === "correct"
                  ? 1
                  : 0;
            const answerText =
              response.kind === "text"
                ? response.text
                : response.kind === "choice"
                  ? (item.options?.find((o) => o.id === response.optionId)
                      ?.text ?? response.optionId)
                  : `${response.value}${response.unit ? ` ${response.unit}` : ""}`;
            p.events.push({
              ...event("answer", answerText),
              outcome: grade.outcome,
              score,
              checks: grade.checks,
            });
            p.round = recordAnswer(
              p.round,
              q,
              grade.outcome === "undecided"
                ? "undecided"
                : grade.outcome === "correct"
                  ? "right"
                  : "wrong",
            ).state;
            // owner: study-backend. A quiz serves each question once: no Learn-style return.
            if (p.mode === "test")
              p.round = {
                ...p.round,
                stage: { ...p.round.stage, [q.familyId]: 2 },
              };
            if (score !== null) {
              const evidence = store.evidence(session.courseRef!);
              attempt = {
                id: crypto.randomUUID(),
                courseRef: session.courseRef!,
                itemId: item.id,
                itemVersion: item.version,
                sourceResourceId: selected.sources[0]?.resourceId ?? null,
                primaryConceptId:
                  selected.tags.find((t) => t.primary)?.conceptId ??
                  selected.tags[0]?.conceptId ??
                  "",
                correct: grade.outcome === "correct",
                assistance: p.assistance,
                seenBefore:
                  evidence.attempts.some((a) => a.itemId === item.id) ||
                  p.events
                    .slice(0, -1)
                    .some((e) => e.itemId === item.id && e.kind === "answer") ||
                  store.sessions(session.courseRef!).some((s) => {
                    if (s.id === session.id) return false;
                    const prior = state(s);
                    return (
                      prior?.current?.itemId === item.id ||
                      prior?.events.some((e) => e.itemId === item.id)
                    );
                  }),
                confidence: request.confidence,
                createdAt: at,
                format: q.format,
                mode:
                  p.mode === "test"
                    ? "test"
                    : p.blocks.some((b) => b.kind === "diagnostic")
                      ? "diagnostic"
                      : "learn",
                response,
                score,
                gradingMethod: "code",
                responseMs: request.responseMs,
                conceptTags: selected.tags,
                sessionId: session.id,
                localDay: localDay(new Date(at)),
                ...(response.kind === "choice"
                  ? { optionId: response.optionId }
                  : {}),
              };
            }
            p.answered = true;
            p.draft = "";
          }
        }
        p.revision++;
        p.updatedAt = at;
        p.operations = { ...p.operations, [request.operationId]: fingerprint };
        const updated = { ...session, plan: p, endedAt: p.current ? null : at };
        if (signal.aborted) return fail(op, "Study request cancelled.");
        if (!store.commitSession(updated, request.revision, attempt))
          return fail(
            op,
            "Study session changed. Reload it before continuing.",
          );
        // owner: analytics
        if (attempt) refreshAnalytics(session.courseRef!, attempt.conceptTags.map((t) => t.conceptId));
        return {
          op,
          status: "ok",
          data: withMeta(projection(updated, p, c), p, updated),
        };
      } catch {
        return fail(
          op,
          "The study request could not be completed. Reload the session to check its saved state.",
          "failed",
        );
      }
    },
  };
  handleRef = (request, signal) => router.handle(request, signal); // owner: mastery: the claim check starts a practice session
  return router;
}
