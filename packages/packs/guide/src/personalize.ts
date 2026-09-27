/**
 * Personalisation, pure code at 0 tokens: a cached guide plus the student's topic states and
 * error patterns become a view. Weak topics come first; weak and untested topics are marked;
 * "Common confusions for you" is built from item text and the anchors' quotes (never model
 * text); "Study this next" points at a passage. The cached artifact is never changed, and
 * nothing here enters the cache key.
 */
import { normaliseLabel } from "../../../learning/src/concepts";
import { studyThisNext, type Anchor } from "../../../learning/src/insights/anchors";
import type { ConfusablePair, FrequentDistractor, PatternAnchor } from "../../../learning/src/insights/errors";
import type { ConceptStateName } from "../../../learning/src/types";
import type { ConceptMapDoc, GuideDoc, GuideSection, MapEdge, MapNode } from "./review";

export type TopicMark = "weak" | "developing" | "untested" | "solid";
export interface TopicState {
  conceptId: string;
  label: string;
  state: ConceptStateName;
}
export interface PersonalSignals {
  states: TopicState[];
  pairs: ConfusablePair[];
  /** Frequent distractors with the item's own stem and primary concept. */
  distractors: (FrequentDistractor & { stem: string; conceptId: string | null })[];
  /** Concept id → label, for pairs. */
  labels: Record<string, string>;
  /** Resource id → version and title, so a guide quote can become an anchor. */
  resources: Record<string, { version: number; title: string }>;
  /** Concept id → a valid anchor from the course map, when it has one. */
  anchors: Record<string, PatternAnchor>;
}

const MARK_OF: Record<ConceptStateName, TopicMark> = { iffy: "weak", getting_there: "developing", not_seen: "untested", solid: "solid" };
const RANK: Record<TopicMark, number> = { weak: 0, developing: 1, untested: 2, solid: 3 };
export const MAX_CONFUSIONS = 5;
export const MAX_STUDY_NEXT = 3;

export interface TopicMarkView {
  topic: string;
  conceptId: string | null;
  mark: TopicMark;
}
export interface SectionView extends GuideSection {
  /** The section's weakest topic decides: weak, developing, untested or solid. */
  mark: TopicMark;
  topicMarks: TopicMarkView[];
}
export interface ConfusionView {
  kind: "confusable_pair" | "frequent_distractor";
  text: string;
  count: number;
  quotes: PatternAnchor[];
  /** confusable_pair: a compare session's item ids, both concepts interleaved. */
  compare: string[];
}
export interface StudyNextView {
  conceptId: string;
  label: string;
  mark: TopicMark;
  anchor: Anchor;
  quote: string;
  quick: { op: "practice.quick"; conceptId: string; minutes: 3 | 5 | 10 };
}
interface Common {
  confusions: ConfusionView[];
  studyNext: StudyNextView[];
  summary: { weak: number; developing: number; untested: number; solid: number };
}
export interface GuideView extends Common {
  kind: GuideDoc["kind"];
  title: string;
  sections: SectionView[];
}
export interface ConceptMapView extends Common {
  kind: "conceptmap";
  title: string;
  nodes: (MapNode & { mark: TopicMark; conceptId: string | null })[];
  /** The artifact's edges, plus `personal` confused_with edges from the student's own mistakes. */
  edges: (MapEdge & { personal: boolean })[];
}

function marker(signals: PersonalSignals) {
  const byLabel = new Map<string, TopicState>();
  for (const s of signals.states) {
    const k = normaliseLabel(s.label);
    const prev = byLabel.get(k);
    if (!prev || RANK[MARK_OF[s.state]] < RANK[MARK_OF[prev.state]]) byLabel.set(k, s);
  }
  return (topic: string): TopicMarkView => {
    const s = byLabel.get(normaliseLabel(topic));
    return { topic, conceptId: s?.conceptId ?? null, mark: s ? MARK_OF[s.state] : "untested" };
  };
}
const worst = (marks: TopicMarkView[]): TopicMark =>
  marks.reduce<TopicMark>((w, m) => (RANK[m.mark] < RANK[w] ? m.mark : w), marks.length ? "solid" : "untested");

type Span = { resourceId: string; start: number; end: number; quote: string };
/** Quotes come from the course map's anchors, else from the guide's own grounded quote for that topic. */
function confusions(signals: PersonalSignals, relevant: (conceptId: string | null) => boolean, fallback: (topic: string) => Span | null): ConfusionView[] {
  const out: ConfusionView[] = [];
  for (const p of signals.pairs) {
    if (!relevant(p.asked) && !relevant(p.answeredAs)) continue;
    const a = signals.labels[p.asked] ?? p.asked;
    const b = signals.labels[p.answeredAs] ?? p.answeredAs;
    const side = (anchors: PatternAnchor[], label: string) => (anchors.length ? anchors.slice(0, 1) : [fallback(label)].filter((x): x is Span => !!x));
    const quotes = [...side(p.anchors.asked, a), ...side(p.anchors.answeredAs, b)];
    if (!quotes.length) continue;
    out.push({ kind: "confusable_pair", text: `You answered ${a} questions as ${b} ${p.count} times.`, count: p.count, quotes, compare: p.compare });
  }
  for (const d of signals.distractors) {
    if (!relevant(d.conceptId) || !d.anchors.length) continue;
    const tempting = d.tempting ? ` Why it's tempting: ${d.tempting}` : "";
    out.push({ kind: "frequent_distractor", text: `On "${d.stem}" you chose "${d.optionText}" ${d.count} times.${tempting}`, count: d.count, quotes: d.anchors.slice(0, 2), compare: [] });
  }
  return out.sort((x, y) => y.count - x.count).slice(0, MAX_CONFUSIONS);
}

function studyNext(
  marks: TopicMarkView[],
  signals: PersonalSignals,
  fallback: (topic: string) => Span | null,
): StudyNextView[] {
  const out: StudyNextView[] = [];
  const seen = new Set<string>();
  const ordered = marks.filter((m) => m.mark !== "solid").sort((a, b) => RANK[a.mark] - RANK[b.mark]);
  for (const m of ordered) {
    if (out.length >= MAX_STUDY_NEXT) break;
    const key = m.conceptId ?? normaliseLabel(m.topic);
    if (seen.has(key)) continue;
    const span = (m.conceptId ? signals.anchors[m.conceptId] : undefined) ?? fallback(m.topic);
    const r = span && signals.resources[span.resourceId];
    if (!span || !r) continue;
    seen.add(key);
    const anchor: Anchor = { resourceId: span.resourceId, version: r.version, start: span.start, end: span.end, label: r.title, valid: true };
    const next = studyThisNext(m.conceptId ?? key, anchor);
    out.push({ conceptId: m.conceptId ?? key, label: m.topic, mark: m.mark, anchor: next.anchor, quote: span.quote, quick: next.quick });
  }
  return out;
}

function summary(marks: TopicMarkView[]) {
  const s = { weak: 0, developing: 0, untested: 0, solid: 0 };
  const seen = new Set<string>();
  for (const m of marks) {
    const k = normaliseLabel(m.topic);
    if (seen.has(k)) continue;
    seen.add(k);
    s[m.mark]++;
  }
  return s;
}

export function personalizeGuide(doc: GuideDoc, signals: PersonalSignals): GuideView {
  const mark = marker(signals);
  const sections: SectionView[] = doc.sections.map((s) => {
    const topicMarks = [...new Set([...s.topics, ...s.blocks.map((b) => b.topic)])].map(mark);
    return { ...s, blocks: s.blocks.map((b) => ({ ...b, source: { ...b.source } })), mark: worst(s.topics.map(mark)), topicMarks };
  });
  // A stable sort: weak first, then developing, untested, solid; the guide's order within each.
  const order = sections.map((s, i) => ({ s, i })).sort((a, b) => RANK[a.s.mark] - RANK[b.s.mark] || a.i - b.i).map((x) => x.s);
  const marks = sections.flatMap((s) => s.topicMarks);
  const inGuide = new Set(marks.map((m) => m.conceptId).filter(Boolean));
  const fallback = (topic: string) => {
    for (const s of doc.sections)
      for (const b of s.blocks)
        if (normaliseLabel(b.topic) === normaliseLabel(topic) && b.source.resourceId && b.source.start !== null && b.source.end !== null)
          return { resourceId: b.source.resourceId, start: b.source.start, end: b.source.end, quote: b.source.quote };
    return null;
  };
  return {
    kind: doc.kind,
    title: doc.title,
    sections: order,
    confusions: confusions(signals, (id) => !!id && inGuide.has(id), fallback),
    studyNext: studyNext(marks, signals, fallback),
    summary: summary(marks),
  };
}

export function personalizeConceptMap(doc: ConceptMapDoc, signals: PersonalSignals): ConceptMapView {
  const mark = marker(signals);
  const nodes = doc.nodes.map((n) => {
    const m = mark(n.label);
    return { ...n, mark: m.mark, conceptId: m.conceptId };
  });
  const byConcept = new Map(nodes.filter((n) => n.conceptId).map((n) => [n.conceptId!, n]));
  const edges: ConceptMapView["edges"] = doc.edges.map((e) => ({ ...e, personal: false }));
  for (const p of signals.pairs) {
    const a = byConcept.get(p.asked);
    const b = byConcept.get(p.answeredAs);
    if (!a || !b || edges.some((e) => e.kind === "confused_with" && ((e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id)))) continue;
    edges.push({ from: a.id, to: b.id, kind: "confused_with", source: null, reason: `You answered ${a.label} questions as ${b.label} ${p.count} times.`, personal: true });
  }
  const marks = nodes.map((n) => ({ topic: n.label, conceptId: n.conceptId, mark: n.mark }));
  const fallback = (topic: string) => {
    const n = doc.nodes.find((x) => normaliseLabel(x.label) === normaliseLabel(topic));
    const s = n?.source;
    return s?.resourceId && s.start !== null && s.end !== null ? { resourceId: s.resourceId, start: s.start, end: s.end, quote: s.quote } : null;
  };
  return {
    kind: "conceptmap",
    title: doc.title,
    nodes,
    edges,
    confusions: confusions(signals, (id) => !!id && byConcept.has(id), fallback),
    studyNext: studyNext(marks, signals, fallback),
    summary: summary(marks),
  };
}

export function personalize(doc: GuideDoc | ConceptMapDoc, signals: PersonalSignals): GuideView | ConceptMapView {
  return doc.kind === "conceptmap" ? personalizeConceptMap(doc, signals) : personalizeGuide(doc, signals);
}
