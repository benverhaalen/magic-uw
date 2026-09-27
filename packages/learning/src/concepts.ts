// N05: the concept map builder (KM-1). Code proposes candidates from module
// names, lecture titles and syllabus schedule headings, each with a source
// quote; acceptMap validates a proposal (code's or a model's) through the quote
// validator; rebuildMap re-applies student edits on top of a rebuilt map.
import type { Concept, ConceptEdit, ConceptOrigin, ConceptSource, CourseRef } from "./store";
import { locateQuote, type ValidateQuote } from "./quote-port";

/** The fields of a captured resource the map builder reads. */
export interface MapResource {
  id: string;
  kind: string;
  title: string;
  text: string;
  contentHash: string;
  module?: { position?: number } | undefined;
  moduleItem?: unknown;
}

export interface Candidate {
  label: string;
  kind: "unit" | "concept";
  reason: "module" | "lecture" | "schedule";
  resourceId: string;
  quote: string | null;
  position: number;
}

const HEADING = /^\s*(module|week|unit|chapter|part|topic|lecture|lec)\s*\.?\s*(\d+)\s*[:.\-–—]\s*(.+?)\s*$/i;
const LECTURE_TITLE = /^\s*(?:lecture|lec|class|session)\s*\.?\s*(\d+)\s*[:.\-–—]\s*(.+?)\s*$/i;
const UNIT_WORDS = new Set(["module", "unit", "chapter", "part", "week"]);

export function normaliseLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/\((?:[^)]*)\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function slug(label: string): string {
  return normaliseLabel(label).replace(/\s+/g, "-") || "untitled";
}

export function conceptId(courseRef: CourseRef, kind: "unit" | "concept", label: string): string {
  return `${courseRef}#${kind}:${slug(label)}`;
}

/** Strip a trailing "(weeks 1-2)." style note and punctuation from a heading's name. */
function cleanName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*\.?\s*$/, "").replace(/[.\s]+$/, "").trim();
}

function lineContaining(text: string, needle: string): string | null {
  const n = needle.toLowerCase();
  for (const line of text.split(/\r?\n/)) if (line.toLowerCase().includes(n)) return line.trim();
  return null;
}

/** Candidates from code, in course order (KM-1). Deduplicated by label. */
export function candidates(resources: MapResource[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (c: Candidate) => {
    const key = `${c.kind}|${normaliseLabel(c.label)}`;
    if (!normaliseLabel(c.label) || seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  // Module names: a module resource's own title, quoted where its text carries it.
  for (const r of resources) {
    if (!r.module || r.moduleItem) continue;
    const name = cleanName(r.title.replace(HEADING, "$3"));
    push({ label: name, kind: "unit", reason: "module", resourceId: r.id, quote: lineContaining(r.text, name), position: r.module.position ?? out.length });
  }
  // Syllabus schedule headings: "Module 2: Recurrences (weeks 3-4)."
  for (const r of resources) {
    if (!/syllabus/i.test(r.title)) continue;
    for (const line of r.text.split(/\r?\n/)) {
      const m = HEADING.exec(line);
      if (!m) continue;
      const word = m[1]!.toLowerCase();
      push({
        label: cleanName(m[3]!),
        kind: UNIT_WORDS.has(word) ? "unit" : "concept",
        reason: "schedule",
        resourceId: r.id,
        quote: line.trim(),
        position: Number(m[2]),
      });
    }
  }
  // Lecture titles, quoted from the heading line in the lecture's own text.
  for (const r of resources) {
    const m = LECTURE_TITLE.exec(r.title);
    if (!m) continue;
    const name = cleanName(m[2]!);
    push({ label: name, kind: "concept", reason: "lecture", resourceId: r.id, quote: lineContaining(r.text, name), position: Number(m[1]) });
  }
  return out;
}

export interface ProposedConcept {
  label: string;
  resourceId?: string;
  quote?: string;
  origin?: "code" | "model";
}

export interface ProposedUnit extends ProposedConcept {
  concepts: ProposedConcept[];
}

export interface MapProposal {
  units: ProposedUnit[];
}

export interface AcceptResult {
  ok: boolean;
  concepts: Concept[];
  /** Concepts kept as origin "model" with no source, because their quote didn't validate. */
  unsourced: string[];
  errors: string[];
}

/**
 * Validate a proposed map (≥1 unit; every quote checked). A concept whose quote
 * doesn't validate is kept as origin "model" with no source, never dropped.
 */
export function acceptMap(
  proposal: MapProposal,
  ctx: { courseRef: CourseRef; resources: MapResource[]; validate: ValidateQuote; mapVersion: string },
): AcceptResult {
  const errors: string[] = [];
  if (!proposal.units?.length) errors.push("a map needs at least one unit");
  const byId = new Map(ctx.resources.map((r) => [r.id, r]));
  const out = new Map<string, Concept>();
  const unsourced: string[] = [];

  const source = (p: ProposedConcept): ConceptSource | null => {
    const r = p.resourceId ? byId.get(p.resourceId) : undefined;
    if (!r || !p.quote) return null;
    const at = locateQuote(ctx.validate, r.text, p.quote);
    return at ? { resourceId: r.id, contentHash: r.contentHash, start: at.start, end: at.end, quote: p.quote, quoteValid: true } : null;
  };

  const add = (p: ProposedConcept, kind: "unit" | "concept", parentId: string | null, position: number): string | null => {
    const label = p.label?.trim();
    if (!label || !normaliseLabel(label)) {
      errors.push(`an empty ${kind} label`);
      return null;
    }
    const id = conceptId(ctx.courseRef, kind, label);
    const src = source(p);
    const origin: ConceptOrigin = src ? (p.origin ?? "code") : "model";
    const existing = out.get(id);
    if (existing) {
      if (src && !existing.sources.some((s) => s.resourceId === src.resourceId && s.start === src.start)) existing.sources.push(src);
      if (existing.sources.length && existing.origin === "model" && p.origin !== "model") existing.origin = "code";
      return id;
    }
    if (!src) unsourced.push(id);
    out.set(id, {
      id,
      courseRef: ctx.courseRef,
      parentId,
      label,
      kind,
      position,
      origin,
      status: "active",
      mergedInto: null,
      studentLabel: null,
      mapVersion: ctx.mapVersion,
      sources: src ? [src] : [],
    });
    return id;
  };

  (proposal.units ?? []).forEach((u, ui) => {
    const unitId = add(u, "unit", null, ui);
    (u.concepts ?? []).forEach((c, ci) => add(c, "concept", unitId, ci));
  });
  const concepts = [...out.values()];
  return { ok: errors.length === 0, concepts, unsourced: unsourced.filter((id) => !out.get(id)!.sources.length), errors };
}

/** Turn code candidates into a proposal: schedule and module units, lectures under the unit that names them, else under the first unit. */
export function proposalFromCandidates(cands: Candidate[]): MapProposal {
  const units: ProposedUnit[] = cands
    .filter((c) => c.kind === "unit")
    .sort((a, b) => a.position - b.position)
    .map((c) => ({ label: c.label, resourceId: c.resourceId, ...(c.quote ? { quote: c.quote } : {}), origin: "code" as const, concepts: [] }));
  if (!units.length) return { units: [] };
  for (const c of cands.filter((x) => x.kind === "concept").sort((a, b) => a.position - b.position)) {
    const home = units.find((u) => normaliseLabel(u.label) === normaliseLabel(c.label)) ?? units[Math.min(units.length - 1, Math.max(0, c.position - 1))]!;
    home.concepts.push({ label: c.label, resourceId: c.resourceId, ...(c.quote ? { quote: c.quote } : {}), origin: "code" });
  }
  return { units };
}

export interface EditRecord {
  conceptId: string;
  edit: ConceptEdit;
}

/** Apply a log of student edits, in order, to a map. Edits on unknown IDs are kept for later, not lost. */
export function applyEdits(map: Concept[], edits: EditRecord[]): Concept[] {
  const byId = new Map(map.map((c) => [c.id, { ...c }]));
  for (const { conceptId: id, edit } of edits) {
    const c = byId.get(id);
    if (!c) continue;
    if (edit.kind === "rename") c.studentLabel = edit.label;
    else if (edit.kind === "hide") c.status = "hidden";
    else if (edit.kind === "restore") {
      c.status = "active";
      c.mergedInto = null;
    } else if (edit.kind === "merge" && byId.has(edit.intoId) && edit.intoId !== id) {
      c.status = "merged";
      c.mergedInto = edit.intoId;
    }
  }
  return [...byId.values()];
}

const edited = (c: Concept) => c.origin === "student" || c.studentLabel !== null || c.status !== "active" || c.mergedInto !== null;

/**
 * Rebuild: the new map, with every student edit carried over. A previous
 * concept that the student made or edited is never dropped, even when the
 * rebuilt map no longer proposes it (KM-1).
 */
export function rebuildMap(previous: Concept[], next: Concept[], edits: EditRecord[] = []): Concept[] {
  const prevById = new Map(previous.map((c) => [c.id, c]));
  const merged = next.map((c) => {
    const p = prevById.get(c.id);
    return p ? { ...c, studentLabel: p.studentLabel, status: p.status, mergedInto: p.mergedInto } : { ...c };
  });
  const nextIds = new Set(next.map((c) => c.id));
  for (const p of previous) if (!nextIds.has(p.id) && edited(p)) merged.push({ ...p });
  return applyEdits(merged, edits);
}

/** The label a student sees: their rename wins. */
export function displayLabel(c: Concept): string {
  return c.studentLabel ?? c.label;
}
