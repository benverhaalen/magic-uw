/**
 * N15 (with the exam-prep research brief §2 and §6a): the exam blueprint, derived by code from
 * the course's own evidence. Scope comes from stated coverage (with its quote), the syllabus row,
 * or the schedule window; format and cognitive level come from the instructor's practice exam,
 * review sheet or a past exam, read question by question; weight and length come from the
 * syllabus or the assessment record. Every value carries the evidence it came from. When the
 * course shows no format, the blueprint says so (`thin`) and invents none. Nothing here says a
 * topic "will be on" an exam.
 */
import type { CoverageRow, Tier } from "../store";
import { tierLabel } from "../labels";
import { assessmentKey, type ExamEvidence, type ExamMaterial } from "./evidence";
import { LEVEL_ORDER, parseExam, statedFormats, statedMinutes, type ParsedExam } from "./parse";
import type {
  BlueprintConcept,
  BlueprintEvidence,
  BlueprintSection,
  CognitiveLevel,
  ExamBlueprint,
  ExamFormat,
  FormatShare,
  LevelShare,
} from "./types";

export interface BlueprintTopic {
  id: string;
  label: string;
  moduleId: string | null;
  moduleLabel: string | null;
}

export interface BlueprintInput {
  evidence: ExamEvidence;
  topics: BlueprintTopic[];
  modules: { id: string; label: string }[];
  /** The learning store's coverage rows for this assessment (N13), when any exist. */
  coverage: CoverageRow[];
  now: Date;
}

export type DocKind = "practice_exam" | "review_sheet" | "past_exam" | "solutions" | "exam_info";

export interface ClassifiedDoc {
  material: ExamMaterial;
  kind: DocKind;
  /** How strongly the document belongs to this assessment: 3 linked, 2 same name, 1 same kind, 0.5 unnamed. */
  relevance: number;
  thisTerm: boolean;
  parsed: ParsedExam;
}

const SOLUTIONS = /\b(?:solutions?|solns?|answer keys?|key)\b/i;
const PAST = /\b(?:past|old|previous|prior|last (?:year|term|semester)'?s?)\b/i;
const PRACTICE = /\b(?:practice|sample|mock)\b/i;
const REVIEW = /\b(?:review|study guide|study sheet|topics? list|exam topics)\b/i;
const INFO = /\b(?:info|information|format|logistics|guidelines|what to expect|details)\b/i;
const EXAMISH = /\b(?:exams?|midterms?|finals?|tests?|quiz(?:zes)?|problems?)\b/i;
const TERM_YEAR = /\b(?:(fall|spring|summer|winter)\s+)?(20\d\d)\b/i;

const COVERS = /[^.\n]*\b(?:covers?|covered|covering|will include|includes)\b[^.\n]*/gi;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Is a dated title from an earlier term than now? */
function pastTerm(title: string, now: Date, termName: string | null): boolean {
  if (PAST.test(title)) return true;
  const m = TERM_YEAR.exec(title);
  if (!m) return false;
  const year = Number(m[2]);
  if (termName && m[1] && norm(`${m[1]} ${m[2]}`) === norm(termName.replace(/^.*?((?:fall|spring|summer|winter)\s+20\d\d).*$/i, "$1"))) return false;
  if (year < now.getFullYear()) return true;
  if (year > now.getFullYear()) return false;
  // Same calendar year: a named season before the current one is a past term.
  const season = m[1]?.toLowerCase();
  const month = now.getMonth();
  const current = month < 5 ? "spring" : month < 8 ? "summer" : "fall";
  const order = ["winter", "spring", "summer", "fall"];
  return !!season && order.indexOf(season) < order.indexOf(current);
}

/** Classify the course's non-graded documents that can inform this exam. */
export function classifyDocs(evidence: ExamEvidence, now: Date): ClassifiedDoc[] {
  const target = assessmentKey(evidence.assessment.title);
  const targetWord = target?.split(" ")[0] ?? null;
  const linked = new Set(evidence.links.map((l) => l.resourceId));
  const out: ClassifiedDoc[] = [];
  for (const m of evidence.materials) {
    if (m.graded || m.kind !== "material") continue;
    const t = m.title;
    const role = m.role;
    const looksExam = role === "exam" || role === "solutions" || EXAMISH.test(t) || REVIEW.test(t);
    if (!looksExam) continue;
    const parsed = parseExam(m.text);
    let kind: DocKind;
    if (role === "solutions" || SOLUTIONS.test(t)) kind = "solutions";
    else if (REVIEW.test(t)) kind = "review_sheet";
    else if (pastTerm(t, now, evidence.termName)) kind = "past_exam";
    else if (PRACTICE.test(t)) kind = "practice_exam";
    else if (INFO.test(t)) kind = "exam_info";
    else if (parsed.questions.length >= 2) kind = "practice_exam";
    else if (role === "exam") kind = "exam_info";
    else continue;
    const key = assessmentKey(t);
    let relevance = 0.5;
    if (linked.has(m.id) || m.covers.some((c) => c === evidence.assessment.id || c === evidence.assessment.resourceId)) relevance = 3;
    else if (key && target && key === target) relevance = 2;
    else if (key && target && key.split(" ")[0] === targetWord && !key.includes(" ")) relevance = 1;
    else if (key && target && key !== target) continue; // names a different assessment
    out.push({ material: m, kind, relevance, thisTerm: kind !== "past_exam", parsed });
  }
  return out.sort((a, b) => b.relevance - a.relevance || a.material.title.localeCompare(b.material.title) || a.material.id.localeCompare(b.material.id));
}

const ev = (
  kind: BlueprintEvidence["kind"],
  m: { id: string; title: string; contentHash: string } | null,
  quote: string | null,
  start: number | null,
  end: number | null,
  basis: BlueprintEvidence["basis"] = "text",
): BlueprintEvidence => ({ kind, resourceId: m?.id ?? null, title: m?.title ?? "", quote, start, end, basis, contentHash: m?.contentHash ?? null });

const cut = (m: ExamMaterial, kind: BlueprintEvidence["kind"], s: { start: number; end: number }) => ev(kind, m, m.text.slice(s.start, s.end), s.start, s.end);

/** Sections, formats and levels from one parsed document. */
function sectionsFrom(doc: ClassifiedDoc): BlueprintSection[] {
  const { parsed, material: m } = doc;
  const kind = doc.kind === "review_sheet" ? "review_sheet" : doc.kind === "past_exam" ? "past_exam" : "practice_exam";
  const build = (id: string, label: string, qs: ParsedExam["questions"], heading: BlueprintEvidence[], grouped: boolean, headingFormat: ParsedExam["sections"][number] | null): BlueprintSection => {
    const formats = new Map<ExamFormat, FormatShare>();
    const levels = new Map<CognitiveLevel, LevelShare>();
    for (const q of qs) {
      const f = formats.get(q.format) ?? { format: q.format, items: 0, points: null, evidence: [] };
      f.items = (f.items ?? 0) + 1;
      if (q.points !== null) f.points = (f.points ?? 0) + q.points;
      if (f.evidence.length < 3) f.evidence.push(q.formatSpan ? cut(m, kind, q.formatSpan) : cut(m, kind, { start: q.start, end: Math.min(q.end, q.start + 160) }));
      formats.set(q.format, f);
      if (q.level && q.levelSpan) {
        const l = levels.get(q.level) ?? { level: q.level, items: 0, evidence: [] };
        l.items++;
        if (l.evidence.length < 3) l.evidence.push(cut(m, kind, q.levelSpan));
        levels.set(q.level, l);
      }
    }
    if (!qs.length && headingFormat?.format)
      formats.set(headingFormat.format, { format: headingFormat.format, items: null, points: headingFormat.points, evidence: heading });
    const points = qs.some((q) => q.points !== null) ? qs.reduce((s, q) => s + (q.points ?? 0), 0) : (headingFormat?.points ?? null);
    return {
      id,
      label,
      formats: [...formats.values()],
      levels: [...levels.values()].sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level)),
      items: qs.length || null,
      points,
      evidence: heading,
      grouped,
      profile: qs.length ? qs.map((q) => ({ format: q.format, level: q.level })) : [...formats.keys()].map((format) => ({ format, level: null })),
    };
  };
  if (parsed.sections.length) {
    const out = parsed.sections.map((s, i) =>
      build(`s${i + 1}`, s.label, parsed.questions.filter((q) => q.sectionIndex === i), [cut(m, kind, s.span)], false, s),
    );
    const loose = parsed.questions.filter((q) => q.sectionIndex === null);
    if (loose.length) out.unshift(build("s0", "Questions before the first section", loose, [], true, null));
    return out.filter((s) => s.formats.length);
  }
  // No headings: consecutive questions of one format form a section.
  const runs: ParsedExam["questions"][] = [];
  for (const q of parsed.questions) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1]!.format === q.format) last.push(q);
    else runs.push([q]);
  }
  return runs.map((qs, i) => {
    const first = qs[0]!.number;
    const last = qs[qs.length - 1]!.number;
    return build(`s${i + 1}`, first === last ? `Question ${first}` : `Questions ${first}–${last}`, qs, [], true, null);
  });
}

function mix(sections: BlueprintSection[]): { formats: FormatShare[]; levels: LevelShare[] } {
  const formats = new Map<ExamFormat, FormatShare>();
  const levels = new Map<CognitiveLevel, LevelShare>();
  for (const s of sections) {
    for (const f of s.formats) {
      const g = formats.get(f.format) ?? { format: f.format, items: null, points: null, evidence: [] };
      if (f.items !== null) g.items = (g.items ?? 0) + f.items;
      if (f.points !== null) g.points = (g.points ?? 0) + f.points;
      g.evidence = [...g.evidence, ...f.evidence].slice(0, 3);
      formats.set(f.format, g);
    }
    for (const l of s.levels) {
      const g = levels.get(l.level) ?? { level: l.level, items: 0, evidence: [] };
      g.items += l.items;
      g.evidence = [...g.evidence, ...l.evidence].slice(0, 3);
      levels.set(l.level, g);
    }
  }
  return {
    formats: [...formats.values()].sort((a, b) => (b.items ?? 0) - (a.items ?? 0) || a.format.localeCompare(b.format)),
    levels: [...levels.values()].sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level)),
  };
}

const NUMBERED = /\b(chapters?|ch\.?|modules?|units?|weeks?|lectures?|topics?)\s*((?:\d{1,2}\s*(?:[-–]|to|through|and|,|&)?\s*)+)/gi;
const family = (w: string) => (/^ch/i.test(w) ? "chapter" : /^(module|unit)/i.test(w) ? "module" : /^week/i.test(w) ? "week" : /^lecture/i.test(w) ? "lecture" : "topic");

/** "Chapters 3–5 and 7" → { chapter: {3,4,5,7} }. */
export function numberedScope(text: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const m of text.matchAll(NUMBERED)) {
    const fam = family(m[1]!);
    const set = out.get(fam) ?? new Set<number>();
    const parts = m[2]!.split(/\s*(?:,|&|\band\b)\s*/);
    for (const p of parts) {
      const range = /(\d{1,2})\s*(?:[-–]|to|through)\s*(\d{1,2})/.exec(p);
      if (range) {
        const a = Number(range[1]), b = Number(range[2]);
        if (b >= a && b - a <= 30) for (let n = a; n <= b; n++) set.add(n);
      } else for (const n of p.match(/\d{1,2}/g) ?? []) set.add(Number(n));
    }
    out.set(fam, set);
  }
  return out;
}

function unitNumber(label: string): { family: string; n: number } | null {
  const m = /\b(chapters?|ch\.?|modules?|units?|weeks?|lectures?|topics?)\s*#?\s*(\d{1,2})\b/i.exec(label);
  return m ? { family: family(m[1]!), n: Number(m[2]) } : null;
}

/** Derive the blueprint. Pure: the same evidence and map give the same blueprint. */
export function deriveBlueprint(input: BlueprintInput): ExamBlueprint {
  const { evidence, now } = input;
  const a = evidence.assessment;
  const warnings: string[] = [];
  const docs = classifyDocs(evidence, now);
  const excludedResourceIds = evidence.materials.filter((m) => m.graded).map((m) => m.id);
  const materialById = new Map(evidence.materials.map((m) => [m.id, m]));
  const syllabus = evidence.brief ? (materialById.get(evidence.brief.syllabusResourceId) ?? null) : null;

  // ---- Scope ----
  const statements: BlueprintEvidence[] = [];
  for (const s of evidence.scopes) {
    const m = s.evidence ? materialById.get(s.evidence.resourceId) : undefined;
    statements.push(
      s.evidence && m
        ? ev("scope_statement", m, s.evidence.quote, s.evidence.start, s.evidence.end)
        : ev("scope_statement", null, s.stated, null, null, "structure"),
    );
  }
  if (evidence.brief?.scope && syllabus)
    statements.push(ev("syllabus", syllabus, evidence.brief.quote, evidence.brief.start, evidence.brief.end));
  // A relevant review sheet or exam-info page states coverage in its own words ("covers chapters 1–4").
  for (const d of docs)
    if ((d.kind === "review_sheet" || d.kind === "exam_info") && d.relevance >= 1) {
      const found = [...d.material.text.matchAll(COVERS)].slice(0, 3);
      for (const c of found) {
        const lead = c[0].length - c[0].trimStart().length;
        const span = { start: c.index + lead, end: c.index + c[0].trimEnd().length };
        statements.push(cut(d.material, d.kind === "review_sheet" ? "review_sheet" : "scope_statement", span));
      }
    }
  const dated = evidence.assessments.filter((x) => x.date && x.id !== a.id && a.date && x.date < a.date).sort((x, y) => x.date!.localeCompare(y.date!));
  const statedWindow = evidence.scopes.find((s) => s.windowStart || s.windowEnd);
  const window = statedWindow
    ? { start: statedWindow.windowStart, end: statedWindow.windowEnd, basis: "stated" as const }
    : a.date && dated.length
      ? { start: dated[dated.length - 1]!.date, end: a.date, basis: "previous_assessment" as const }
      : { start: null, end: a.date, basis: "none" as const };

  const scopeText = statements.map((s) => s.quote ?? "").join("\n");
  const numbered = numberedScope(scopeText);
  const modulesInScope: { id: string; label: string; evidence: BlueprintEvidence[] }[] = [];
  for (const u of input.modules) {
    const n = unitNumber(u.label);
    if (n && numbered.get(n.family)?.has(n.n))
      modulesInScope.push({ id: u.id, label: u.label, evidence: statements.filter((s) => (s.quote ?? "").match(NUMBERED)) });
  }
  let conceptBasis: ExamBlueprint["scope"]["basis"] = "none";
  let scoped: { topic: BlueprintTopic; basis: BlueprintConcept["basis"] }[] = [];
  const live = input.coverage.filter((r) => r.status !== "rejected" && r.status !== "flagged");
  if (live.length) {
    const byId = new Map(input.topics.map((t) => [t.id, t]));
    scoped = live.flatMap((r) => (byId.has(r.conceptId) ? [{ topic: byId.get(r.conceptId)!, basis: r.basis }] : []));
    conceptBasis = live.some((r) => r.basis === "stated") ? "stated" : live.some((r) => r.basis === "schedule_window") ? "schedule_window" : "mapped";
  }
  if (!scoped.length && modulesInScope.length) {
    const ids = new Set(modulesInScope.map((m) => m.id));
    scoped = input.topics.filter((t) => t.moduleId && ids.has(t.moduleId)).map((topic) => ({ topic, basis: "stated" as const }));
    if (scoped.length) conceptBasis = "stated";
  }
  if (!scoped.length) {
    // Mapped: the modules of materials linked to this assessment (course-map links or covers facts).
    const linked = new Set([...evidence.links.map((l) => l.resourceId), ...evidence.materials.filter((m) => m.covers.includes(a.id) || (!!a.resourceId && m.covers.includes(a.resourceId))).map((m) => m.id)]);
    const titles = new Set(evidence.materials.filter((m) => linked.has(m.id)).flatMap((m) => m.moduleTitles.map(norm)));
    const units = input.modules.filter((u) => titles.has(norm(u.label)));
    for (const u of units) if (!modulesInScope.some((m) => m.id === u.id)) modulesInScope.push({ id: u.id, label: u.label, evidence: [ev("course_structure", null, u.label, null, null, "structure")] });
    const ids = new Set(units.map((u) => u.id));
    scoped = input.topics.filter((t) => t.moduleId && ids.has(t.moduleId)).map((topic) => ({ topic, basis: "mapped" as const }));
    if (scoped.length) conceptBasis = "mapped";
  }
  if (!scoped.length) {
    scoped = input.topics.map((topic) => ({ topic, basis: "course" as const }));
    warnings.push("No coverage statement found. Practice spans the whole course.");
  }
  const seen = new Set<string>();
  scoped = scoped.filter((s) => !seen.has(s.topic.id) && !!seen.add(s.topic.id));
  const concepts: BlueprintConcept[] = scoped.map(({ topic, basis }) => ({
    conceptId: topic.id,
    label: topic.label,
    moduleLabel: topic.moduleLabel,
    weight: 1 / scoped.length,
    basis,
  }));

  // ---- Format: the best document, else a stated format, else nothing ----
  const formatDocs = docs.filter((d) => d.kind !== "solutions" && d.kind !== "exam_info" && d.parsed.questions.length + d.parsed.sections.length > 0);
  const thisTerm = formatDocs.filter((d) => d.kind === "practice_exam" && d.relevance >= 0.5).sort((x, y) => y.relevance - x.relevance);
  const past = formatDocs.filter((d) => d.kind === "past_exam" && d.relevance >= 0.5);
  const review = formatDocs.filter((d) => d.kind === "review_sheet" && d.relevance >= 0.5 && d.parsed.questions.length >= 2);
  const primary = thisTerm[0] ?? review[0] ?? past[0] ?? null;
  let sections = primary ? sectionsFrom(primary) : [];
  const formatSources = [primary, ...thisTerm.slice(1), ...past.filter((d) => d !== primary)]
    .filter((d): d is ClassifiedDoc => !!d)
    .map((d) => ev(d.kind === "past_exam" ? "past_exam" : d.kind === "review_sheet" ? "review_sheet" : "practice_exam", d.material, null, null, null, "title"));

  const infoDocs = docs.filter((d) => d.kind === "exam_info" && d.relevance >= 1);
  const statedFormatSources: { text: string; evidence: (s: { start: number; end: number }) => BlueprintEvidence }[] = [];
  if (a.format) statedFormatSources.push({ text: a.format, evidence: () => ev("assessment_record", null, a.format, null, null, "structure") });
  if (evidence.brief && syllabus) {
    const b = evidence.brief;
    statedFormatSources.push({ text: b.quote, evidence: (s) => ev("syllabus", syllabus, b.quote.slice(s.start, s.end), b.start + s.start, b.start + s.end) });
  }
  for (const d of infoDocs) statedFormatSources.push({ text: d.material.text, evidence: (s) => cut(d.material, "practice_exam", s) });
  if (!sections.length) {
    const formats: FormatShare[] = [];
    for (const src of statedFormatSources)
      for (const f of statedFormats(src.text))
        if (!formats.some((x) => x.format === f.format)) formats.push({ format: f.format, items: null, points: null, evidence: [src.evidence(f.span)] });
    if (formats.length)
      sections = [
        {
          id: "s1",
          label: "As the course describes the exam",
          formats,
          levels: [],
          items: null,
          points: null,
          evidence: formats.flatMap((f) => f.evidence).slice(0, 3),
          grouped: true,
          profile: formats.map((f) => ({ format: f.format, level: null })),
        },
      ];
  }
  const thin = !sections.length;
  if (thin) warnings.push("No exam format found in this course's materials. Practice uses the course's checked questions and doesn't imitate a format.");

  // ---- Tier ----
  const hasExamInfo =
    statements.some((s) => s.kind === "scope_statement" || s.kind === "syllabus" || s.kind === "review_sheet") ||
    statedFormatSources.length > 0 ||
    docs.some((d) => (d.kind === "review_sheet" || d.kind === "exam_info") && d.relevance >= 1);
  let tier: Tier;
  if (thisTerm.length) tier = "T1";
  else if (hasExamInfo) tier = "T2";
  else if (past.length) tier = "T3";
  else tier = "T4";
  const pastTitles = past.map((d) => d.material.title);
  if (primary?.kind === "past_exam" || tier === "T3")
    warnings.push(`Built partly from past-term exams (${pastTitles.join(", ")}). A past question may not match this term's coverage.`);
  const basis =
    primary?.kind === "practice_exam"
      ? `Format read from your instructor's practice exam: ${primary.material.title}.`
      : primary?.kind === "review_sheet"
        ? `Format read from the review sheet: ${primary.material.title}.`
        : primary?.kind === "past_exam"
          ? `Format read from a past-term exam: ${primary.material.title}.`
          : sections.length
            ? "Format as the course describes it; no practice exam was found."
            : "No exam format found; practice is built from course materials only.";

  // ---- Weight, length, points ----
  const weight =
    a.weight !== null
      ? { percent: a.weight, evidence: [ev("assessment_record", null, `${a.title}: ${a.weight}%`, null, null, "structure")] }
      : evidence.brief?.weight != null && syllabus
        ? { percent: evidence.brief.weight, evidence: [ev("syllabus", syllabus, evidence.brief.quote, evidence.brief.start, evidence.brief.end)] }
        : null;
  let length: ExamBlueprint["length"] = null;
  if (primary?.parsed.minutes) length = { minutes: primary.parsed.minutes.value, evidence: [cut(primary.material, "practice_exam", primary.parsed.minutes.span)] };
  if (!length)
    for (const src of statedFormatSources) {
      const m = statedMinutes(src.text);
      if (m) {
        length = { minutes: m.value, evidence: [src.evidence(m.span)] };
        break;
      }
    }
  const qPoints = primary ? primary.parsed.questions.reduce((s, q) => s + (q.points ?? 0), 0) : 0;
  const totalPoints = primary?.parsed.totalPoints
    ? { value: primary.parsed.totalPoints.value, evidence: [cut(primary.material, "practice_exam", primary.parsed.totalPoints.span)] }
    : qPoints > 0 && primary
      ? { value: qPoints, evidence: [ev("practice_exam", primary.material, null, null, null, "title")] }
      : null;

  const { formats, levels } = mix(sections);
  return {
    assessmentId: a.id,
    title: a.title,
    kind: a.kind,
    date: a.date,
    weight,
    tier,
    tierLabel: tierLabel(tier, tier === "T3" ? (pastTitles[0] ?? null) : null),
    basis,
    scope: { statements, window, modules: modulesInScope.map(({ label, evidence }) => ({ label, evidence })), concepts, basis: conceptBasis },
    length,
    totalPoints,
    sections,
    formatMix: formats,
    levelMix: levels,
    formatSources,
    thin,
    warnings,
    excludedResourceIds,
  };
}
