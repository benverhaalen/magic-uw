/**
 * owner: study-prep. The catered sections of an item's space, by code at 0 tokens: only the ones
 * its type lists are built. Every quoted line keeps its source so it opens in place.
 */
import type { ItemSectionId, Resource, StudyPrepQuote, StudyPrepSections } from "@magic/contracts";
import { collapse, dueOf, norm, type Prep } from "./scope";

const quote = (r: Resource, start: number, end: number): StudyPrepQuote => ({ resourceId: r.id, title: r.title, url: r.url, quote: r.text.slice(start, end), start, end });

/** Sentences of a text, with their offsets. */
function sentences(text: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const re = /[^.!?\n]+[.!?]?/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const lead = m[0].length - m[0].trimStart().length;
    const t = m[0].trim();
    if (t.length >= 8) out.push({ text: t, start: m.index + lead, end: m.index + lead + t.length });
  }
  return out;
}

const SAFETY = /\b(?:safety|goggles|gloves|lab coat|closed-toe|hazard|fume hood|flammable|corrosive|dispose|waste|eye wash|ppe|equipment)\b/i;
const CITATION = /\b(APA|MLA|Chicago|IEEE|Harvard|Turabian|ACS|AMA|Vancouver)\b(?:\s+(?:style|format|citations?))?/;

export function buildSections(prep: Prep, want: readonly ItemSectionId[]): StudyPrepSections {
  const has = (s: ItemSectionId) => want.includes(s);
  const r = prep.subject.resource;
  const out: StudyPrepSections = {};
  if (has("past_exams"))
    out.pastExams = prep.sources
      .filter((s) => s.role === "practice_exam" || s.role === "past_exam" || s.role === "solutions" || s.role === "review_sheet")
      .map((s) => ({ resourceId: s.resourceId, title: s.title, role: s.role, saved: { status: "pending" as const, at: null, problems: 0 } }));
  if (has("worked_examples")) {
    const list: NonNullable<StudyPrepSections["workedExamples"]> = [];
    for (const s of prep.sources) {
      for (const f of prep.facts(s.resourceId)) {
        if (f.kind !== "example" || list.length >= 6) continue;
        const text = collapse(f.basis === "text" || !f.basis ? s.resource.text.slice(f.start, f.end) : (f.quote ?? f.value));
        if (text) list.push({ text, source: f.basis === "text" || !f.basis ? quote(s.resource, f.start, f.end) : { resourceId: s.resourceId, title: s.title, url: s.url, quote: text, start: null, end: null } });
      }
      // Code-found worked examples where the pipeline has none yet: a line that computes a value.
      if (list.length < 3)
        for (const line of sentences(s.resource.text))
          if (list.length < 6 && /\d\s*[*/x×+\-]\s*\d|=\s*-?\d/.test(line.text) && /\b(?:so|gives|is|equals|=)\b|=/.test(line.text))
            list.push({ text: line.text, source: quote(s.resource, line.start, line.end) });
    }
    out.workedExamples = list;
  }
  if (has("rubric"))
    out.rubric = (r?.rubric ?? []).map((c) => ({
      criterion: collapse(c.description ?? "Criterion"),
      detail: c.longDescription ? collapse(c.longDescription) : null,
      points: c.points ?? null,
      ratings: (c.ratings ?? []).map((x) => ({ label: collapse(x.description ?? ""), points: x.points ?? null })).filter((x) => x.label),
    }));
  if (has("citation_style")) {
    let found: StudyPrepSections["citationStyle"] = null;
    for (const doc of [r, prep.syllabusId ? prep.resourceById.get(prep.syllabusId) : undefined])
      if (doc && !found) {
        const m = CITATION.exec(doc.text);
        if (m) found = { style: m[1]!, source: quote(doc, m.index, m.index + m[0].length) };
      }
    out.citationStyle = found;
  }
  if (has("safety")) {
    const list: NonNullable<StudyPrepSections["safety"]> = [];
    for (const doc of [r, ...prep.sources.filter((s) => s.role !== "homework").map((s) => s.resource)])
      if (doc) for (const line of sentences(doc.text)) if (list.length < 6 && SAFETY.test(line.text)) list.push({ text: line.text, source: quote(doc, line.start, line.end) });
    out.safety = list;
  }
  if (has("milestones")) {
    // Deliverables of the same project: the course's assignments sharing its group, module or title stem.
    const stem = norm(prep.subject.title).split(" ").filter((w) => w.length > 3 && !/^\d+$/.test(w))[0] ?? null;
    const group = r?.assignmentGroupId ?? null;
    const moduleId = r?.moduleItem?.moduleId ?? r?.module?.id ?? null;
    out.milestones = prep.resources
      .filter((x) => x.kind === "assignment" && (x.id === r?.id || (group && x.assignmentGroupId === group) || (moduleId && (x.moduleItem?.moduleId ?? x.module?.id) === moduleId) || (stem && norm(x.title).includes(stem))))
      .map((x) => ({ resourceId: x.id, title: x.title, date: dueOf(x), done: x.submitted === true || !!x.submission?.submittedAt }))
      .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.title.localeCompare(b.title))
      .slice(0, 12);
  }
  if (has("contacts")) {
    const row = prep.resources.find((x) => x.kind === "course" && x.course?.instructors?.length) ?? prep.resources.find((x) => x.course?.instructors?.length);
    out.contacts = (row?.course?.instructors ?? []).slice(0, 6).map((name) => ({ name, role: "Instructor" }));
  }
  if (has("material")) out.material = r && prep.subject.kind === "material" ? { resourceId: r.id, title: r.title, text: r.text, url: r.url || null } : null;
  return out;
}

/** Messages in the course that name the item or link to it, newest first. */
export function announcementsFor(prep: Prep): { resourceId: string; title: string; date: string | null; excerpt: string }[] {
  const title = norm(prep.subject.title);
  if (title.length < 5) return [];
  const out: { resourceId: string; title: string; date: string | null; excerpt: string; at: string }[] = [];
  for (const m of prep.resources) {
    if (m.kind !== "message") continue;
    const text = norm(`${m.title} ${m.text}`);
    if (!text.includes(title)) continue;
    const at = m.createdAt ?? m.observedAt;
    const i = m.text.toLowerCase().indexOf(prep.subject.title.toLowerCase());
    const from = Math.max(0, i - 60);
    const excerpt = collapse(i >= 0 ? `${from ? "…" : ""}${m.text.slice(from, i + 140)}…` : m.text.slice(0, 180));
    out.push({ resourceId: m.id, title: m.title, date: m.createdAt ?? null, excerpt, at });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3).map(({ at: _at, ...x }) => x);
}

/** Class sessions in the item's window (before its date), newest first. */
export function sessionsFor(prep: Prep, sessions: { date: string | null; title: string }[]): { date: string; title: string }[] {
  const { start, end } = prep.window;
  return sessions
    .filter((s): s is { date: string; title: string } => !!s.date)
    .filter((s) => {
      const t = Date.parse(s.date);
      return Number.isFinite(t) && (end === null || t <= end) && (start === null || t > start);
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);
}
