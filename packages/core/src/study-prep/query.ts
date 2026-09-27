/**
 * owner: study-prep. The `study.prep` query: one composite read per assessment, from the local
 * database only, 0 tokens (efficiency item 5: nothing is generated until the student clicks). It
 * answers the assessment, its Sources (coverage) with the filter chips, the code-built overview,
 * the Studio's materials for the selected scope with their status and freshness, and mastery.
 * Without an assessment it lists the course's upcoming exams and quizzes.
 */
import type {
  QueryRequest,
  Store,
  StudyPrepAssessment,
  StudyPrepCard,
  StudyPrepKind,
  StudyPrepMastery,
  StudyPrepMaterial,
  StudyPrepOverview,
  StudyPrepQuizItem,
  StudyPrepQuote,
  StudyPrepResult,
} from "@magic/contracts";
import { createExamEvidence, type ExamAssessment } from "../../../learning/src/exam/evidence";
import type { BlueprintEvidence } from "../../../learning/src/exam/types";
import { assessmentMastery, createMasteryMemo, type MasteryMemo } from "../../../learning/src/mastery/index";
import { memoReferences, referenceFingerprint, type ReferencesMemo } from "../../../learning/src/mastery/references-memo";
import type { StoredItem } from "../../../learning/src/store";
import { createPipelineReferences } from "../graph/references-port";
import { isPipelineStore } from "../graph/course-index";
import { STUDY_PREP_PACK_VERSION } from "../../../packs/study-prep/src/index";
import { collapse, courseRows, courseScope, isPrepStore, loadPrep, selectScope, type Prep, type PrepStore, type Selection } from "./scope";
import { GENERATING_TIMEOUT_MS, readRecord, type PrepRecord } from "./records";

type Request = Extract<QueryRequest, { view: "study.prep" }>;
const DAY = 86_400_000;
const MAX_TERMS = 24;

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

const assessmentView = (a: ExamAssessment, now: Date, where: string | null = null): StudyPrepAssessment => ({
  id: a.id,
  title: a.title,
  kind: a.kind,
  date: a.date,
  daysAway: daysAway(a.date, now),
  where,
  weight: a.weight,
});

function quoteOf(prep: Prep, e: BlueprintEvidence): StudyPrepQuote | null {
  if (!e.resourceId || !e.quote) return null;
  const r = prep.resourceById.get(e.resourceId);
  return { resourceId: e.resourceId, title: r?.title ?? e.title, url: r?.url ?? null, quote: e.quote, start: e.start, end: e.end };
}

const FORMAT_WORD: Record<string, string> = {
  multiple_choice: "multiple choice",
  true_false: "true/false",
  short_answer: "short answer",
  numeric: "numeric",
  problem: "worked problems",
  essay: "essay",
  code: "code",
  proof: "proofs",
  matching: "matching",
  fill_blank: "fill in the blank",
};

function overviewOf(prep: Prep, sel: Selection): StudyPrepOverview {
  const bp = prep.blueprint;
  const covered = bp.scope.statements.slice(0, 4).map((s) => ({ text: collapse(s.quote ?? ""), source: quoteOf(prep, s) })).filter((c) => c.text);
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
      const quote = f.basis === "text" || !f.basis ? r.text.slice(f.start, f.end) : (f.quote ?? value);
      keyTerms.push({ kind: f.kind, value, source: { resourceId: r.id, title: r.title, url: r.url, quote, start: f.basis === "text" || !f.basis ? f.start : null, end: f.basis === "text" || !f.basis ? f.end : null } });
    }
  }
  const a = prep.evidence.assessment;
  const dates: StudyPrepOverview["dates"] = [];
  if (bp.scope.window.start && bp.scope.window.basis !== "none") dates.push({ label: "Coverage starts", date: bp.scope.window.start });
  if (a.date) dates.push({ label: a.title, date: a.date });
  const formats = bp.formatMix.map((f) => FORMAT_WORD[f.format] ?? f.format.replace(/_/g, " "));
  return {
    covered,
    modules: bp.scope.modules.map((m) => m.label),
    topics: prep.topics.map(({ id, label }) => ({ id, label })),
    keyTerms,
    dates,
    format: formats.length ? `${formats.join(", ")}. ${bp.basis}` : bp.basis,
    length: bp.length ? `${bp.length.minutes} minutes` : null,
    warnings: [...(prep.wholeCourse ? ["No coverage statement links materials to this assessment, so every course material is a source."] : []), ...bp.warnings],
  };
}

/**
 * Per store: the references port's answers while the course fingerprint holds (the learning
 * router's own memo over the same reads), and mastery's as-of memo. Building the port's answers
 * reads every resource; the fingerprint that guards them costs a few milliseconds.
 */
const memos = new WeakMap<object, { refs: Map<string, ReferencesMemo>; mastery: MasteryMemo }>();
function masteryOf(store: PrepStore, prep: Prep, now: Date): StudyPrepMastery | null {
  if (!isPipelineStore(store)) return null;
  try {
    let memo = memos.get(store);
    if (!memo) memos.set(store, (memo = { refs: new Map(), mastery: createMasteryMemo() }));
    const course = { accountScope: prep.accountScope, courseId: prep.courseId };
    const references = memoReferences(createPipelineReferences(store), referenceFingerprint(store, course), memo.refs, prep.courseRef);
    const input = { store: store.learning, ref: prep.courseRef, courseId: prep.courseId, references, now };
    const a = prep.evidence.assessment;
    const data = assessmentMastery(input, a.id, memo.mastery) ?? (a.resourceId ? assessmentMastery(input, a.resourceId, memo.mastery) : null);
    if (!data) return null;
    const c = data.assessment.counts;
    return { label: data.assessment.label, counts: { solid: c.solid, getting_there: c.getting_there, iffy: c.iffy, not_seen: c.not_seen }, total: data.assessment.topicIds.length };
  } catch {
    return null;
  }
}

/** Code decides freshness: every source in the selection at the content hash the record was made from. */
export function changedSince(record: Pick<PrepRecord, "sources" | "packVersion">, sel: Selection): string[] {
  const now = new Map(sel.resources.map((r) => [r.id, r]));
  const out: string[] = [];
  for (const s of record.sources) {
    const r = now.get(s.resourceId);
    if (!r) out.push(`${s.title} (removed)`);
    else if (r.contentHash !== s.contentHash) out.push(r.title);
  }
  const before = new Set(record.sources.map((s) => s.resourceId));
  for (const r of sel.resources) if (!before.has(r.id)) out.push(`${r.title} (added)`);
  return out;
}

export function materialsOf(store: PrepStore, prep: Prep, sel: Selection, now: Date): Record<StudyPrepKind, StudyPrepMaterial> {
  const learning = store.learning;
  let items: Map<string, StoredItem> | null = null;
  const itemMap = () => {
    if (items) return items;
    items = new Map();
    for (const x of learning.items({ courseRef: prep.courseRef })) {
      const prev = items.get(x.item.id);
      if (!prev || prev.item.version < x.item.version) items.set(x.item.id, x);
    }
    return items;
  };
  let cardsByItem: Map<string, { id: string; due: string }> | null = null;
  const cardMap = () => (cardsByItem ??= new Map(learning.cards({ courseRef: prep.courseRef }).map((c) => [c.itemId, { id: c.id, due: c.fsrs.due }])));
  const labels = new Map(prep.concepts.map((c) => [c.id, c.studentLabel ?? c.label]));
  const quote = (x: StoredItem): StudyPrepQuote => {
    const s = x.sources[0];
    const r = s ? (prep.resourceById.get(s.resourceId) ?? store.resource(s.resourceId)) : undefined;
    return { resourceId: s?.resourceId ?? null, title: r?.title ?? "", url: r?.url ?? null, quote: s?.quote ?? "", start: s && s.quoteValid ? s.start : null, end: s && s.quoteValid ? s.end : null };
  };
  const topics = (x: StoredItem) => [...x.tags].sort((a, b) => Number(b.primary) - Number(a.primary)).map((t) => labels.get(t.conceptId)).filter((l): l is string => !!l);
  const live = (id: string) => {
    const x = itemMap().get(id);
    return x && x.item.status !== "quarantined" ? x : null;
  };
  const quizOf = (ids: string[]): StudyPrepQuizItem[] =>
    ids.flatMap((id) => {
      const x = live(id);
      if (!x || (x.item.kind !== "mc" && x.item.kind !== "tf" && x.item.kind !== "numeric")) return [];
      return [{ itemId: x.item.id, version: x.item.version, kind: x.item.kind, stem: x.item.stem, options: x.item.options, key: x.item.key, unit: x.item.unit ?? null, explanation: x.item.explanation, topics: topics(x), source: quote(x) }];
    });
  const cardsOf = (ids: string[]): StudyPrepCard[] =>
    ids.flatMap((id) => {
      const x = live(id);
      const card = cardMap().get(id);
      if (!x || (x.item.kind !== "card" && x.item.kind !== "cloze") || (x.item.kind === "card" && !card)) return [];
      return [{ cardId: card?.id ?? null, itemId: x.item.id, kind: x.item.kind, front: x.item.stem, back: String(x.item.key), topics: topics(x), due: card?.due ?? null, source: quote(x) }];
    });

  const out = {} as Record<StudyPrepKind, StudyPrepMaterial>;
  for (const kind of ["guide", "quiz", "cards"] as const) {
    const record = readRecord(learning, prep.courseRef, prep.evidence.assessment.id, sel.hash, kind);
    const base: StudyPrepMaterial = { kind, status: "missing", count: 0, generatedAt: null, message: null, changed: [], guide: null, quiz: null, cards: null };
    if (!record) {
      out[kind] = base;
      continue;
    }
    const interrupted = record.status === "generating" && (!record.startedAt || now.getTime() - Date.parse(record.startedAt) > GENERATING_TIMEOUT_MS);
    const shown = record.status === "ready" ? record : (record.previous ?? null);
    const content = (r: Omit<PrepRecord, "previous">) =>
      kind === "guide" ? { guide: r.guide, count: r.guide?.sections.length ?? 0 } : kind === "quiz" ? (() => { const q = quizOf(r.itemIds); return { quiz: q, count: q.length }; })() : (() => { const c = cardsOf(r.itemIds); return { cards: c, count: c.length }; })();
    const changed = shown ? changedSince(shown, sel) : [];
    const status: StudyPrepMaterial["status"] =
      record.status === "generating" && !interrupted
        ? "generating"
        : record.status === "failed" || interrupted
          ? "failed"
          : changed.length || record.packVersion !== STUDY_PREP_PACK_VERSION
            ? "stale"
            : "ready";
    out[kind] = {
      ...base,
      ...(shown ? content(shown) : {}),
      status,
      generatedAt: shown?.generatedAt ?? null,
      message: interrupted ? "Generation was interrupted. Try again." : record.status === "failed" ? record.message : null,
      changed,
    };
  }
  return out;
}

export function studyPrepQuery(store: Store, request: Request, nowIso: string): StudyPrepResult {
  const t0 = performance.now();
  const now = new Date(nowIso);
  const ms = () => Math.round((performance.now() - t0) * 10) / 10;
  const base = { view: "study.prep" as const, courseId: request.courseId, modelCalls: 0 as const };
  if (!isPrepStore(store)) return { ...base, status: "empty", message: "Study prep needs the workspace's learning store.", ms: ms() };
  if (!request.assessmentId) {
    const accountScope = courseScope(store, request.courseId);
    if (!accountScope) return { ...base, status: "empty", message: "This course has no saved material yet.", ms: ms() };
    const course = { accountScope, courseId: request.courseId };
    const resources = courseRows(store, course).filter((r) => !r.deleted && r.courseId === request.courseId);
    const port = createExamEvidence({ resources: () => resources, sources: () => store.sources(), courseResources: () => resources, assessments: (c) => store.assessments(c) });
    const upcoming = port
      .assessments(accountScope, request.courseId)
      .map((a) => assessmentView(a, now))
      .filter((a) => a.daysAway === null || a.daysAway >= 0);
    return { ...base, status: "list", upcoming, ms: ms() };
  }
  const prep = loadPrep(store, request.courseId, request.assessmentId, now);
  if ("status" in prep) return { ...base, status: prep.status, message: prep.message, ms: ms() };
  const sel = selectScope(prep, request);
  return {
    ...base,
    status: "ok",
    courseRef: prep.courseRef,
    assessment: assessmentView(prep.evidence.assessment, now, prep.where?.quote ?? null),
    sources: prep.sources.map(({ resource: _r, ...s }) => ({ ...s, checked: sel.resourceIds.includes(s.resourceId) })),
    scopeItems: prep.items,
    scope: { all: sel.all, resourceIds: sel.resourceIds, topicIds: sel.topicIds, hash: sel.hash },
    overview: overviewOf(prep, sel),
    materials: materialsOf(store, prep, sel, now),
    mastery: masteryOf(store, prep, now),
    anchorIds: prep.anchorIds,
    restricted: prep.restricted,
    ms: ms(),
  };
}
