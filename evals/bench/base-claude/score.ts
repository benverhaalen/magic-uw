/**
 * Scores one target database against the gold, the same way for every side. The pass criteria are
 * the pre-registered ones (preregistration.md); a change to a threshold here is a change to that
 * file, made before any run, and the file's hash is recorded in every result.
 */
import type { Gold } from "./gold";
import type { TargetRows } from "./schema";
import { sameInstant, sameNumber, textF1 } from "./text";

export const THRESHOLDS = {
  assignmentsRecall: 0.98,
  assignmentsDueExact: 0.99,
  assignmentsPointsExact: 0.99,
  extraShare: 0.01,
  modulesRecall: 0.98,
  itemsRecall: 0.98,
  groupsRecall: 0.98,
  groupWeightsExact: 0.98,
  pagesRecall: 0.95,
  pagesTextF1: 0.8,
  filesRecall: 0.95,
  filesTextPresent: 0.9,
  filesSampledF1: 0.7,
  syllabusPresent: 0.9,
  syllabusTextF1: 0.6,
  /** Agenda-usable: this share of the gold's dated assignments present with the exact due date. */
  agendaShare: 0.95,
} as const;

export interface TableScore { gold: number; found: number; matched: number; missing: number; extra: number; outOfScope: number; recall: number; precision: number }
export interface Check { name: string; value: number; threshold: string; pass: boolean }
export interface Score {
  courses: { listedGold: number; listedFound: number; currentGold: number; currentMarked: number; currentCorrect: number; currentMissing: number; wrongCurrent: number; wrongCurrentRestricted: number; missingCourses: number };
  modules: TableScore;
  items: TableScore & { wrongModule: number };
  groups: TableScore & { weightExact: number };
  assignments: TableScore & { dueExact: number; pointsExact: number; dueMismatch: number; pointsMismatch: number };
  pages: TableScore & { textF1Mean: number; emptyBodies: number };
  files: TableScore & { textPresent: number; textBearingMatched: number; sampled: number; sampledF1Mean: number; hiddenTabGold: number; hiddenTabMatched: number };
  syllabus: { gold: number; present: number; sourceMatch: number; textF1Mean: number };
  checks: Check[];
  pass: boolean;
  problems: string[];
}

const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);
const round = (x: number) => Math.round(x * 10000) / 10000;
const slugKey = (course: string, url: string) => {
  let u = url.trim();
  try {
    u = decodeURIComponent(u);
  } catch {}
  u = u.replace(/^.*\/pages\//, "").replace(/[?#].*$/, "");
  return `${course}/${u.toLowerCase()}`;
};

function table<G, R>(gold: G[], rows: R[], goldKey: (g: G) => string, rowKey: (r: R) => string, inScope: (r: R) => boolean) {
  const byKey = new Map(gold.map((g) => [goldKey(g), g]));
  const matched: Array<[G, R]> = [];
  const seen = new Set<string>();
  let extra = 0, outOfScope = 0;
  for (const row of rows) {
    const key = rowKey(row);
    const g = byKey.get(key);
    if (g && !seen.has(key)) {
      seen.add(key);
      matched.push([g, row]);
    } else if (!inScope(row)) outOfScope++;
    else extra++;
  }
  const score: TableScore = {
    gold: gold.length, found: rows.length, matched: matched.length, missing: gold.length - matched.length,
    extra: extra + outOfScope, outOfScope, recall: round(ratio(matched.length, gold.length)), precision: round(ratio(matched.length, rows.length)),
  };
  return { score, matched };
}

export function scoreRows(gold: Gold, rows: TargetRows, problems: string[] = []): Score {
  const current = new Set(gold.courses.filter((c) => c.current).map((c) => c.id));
  const inScope = (r: { course_id: string }) => current.has(String(r.course_id));

  // Courses
  const listed = new Set(gold.courses.map((c) => c.id));
  const marked = rows.courses.filter((r) => r.is_current === 1);
  const restricted = new Set(gold.courses.filter((c) => c.restricted).map((c) => c.id));
  const courses = {
    listedGold: gold.courses.length,
    listedFound: rows.courses.filter((r) => listed.has(r.id)).length,
    currentGold: current.size,
    currentMarked: marked.length,
    currentCorrect: marked.filter((r) => current.has(r.id)).length,
    currentMissing: [...current].filter((id) => !marked.some((r) => r.id === id)).length,
    wrongCurrent: marked.filter((r) => !current.has(r.id)).length,
    wrongCurrentRestricted: marked.filter((r) => restricted.has(r.id)).length,
    missingCourses: [...listed].filter((id) => !rows.courses.some((r) => r.id === id)).length,
  };

  const modules = table(gold.modules, rows.modules, (g) => g.id, (r) => r.id, inScope);
  const items = table(gold.items, rows.module_items, (g) => g.id, (r) => r.id, inScope);
  const wrongModule = items.matched.filter(([g, r]) => g.moduleId !== r.module_id).length;
  const groups = table(gold.groups, rows.assignment_groups, (g) => g.id, (r) => r.id, inScope);
  const weightExact = groups.matched.filter(([g, r]) => (g.weight === null ? r.weight === null || r.weight === 0 : sameNumber(g.weight, r.weight))).length;
  const assignments = table(gold.assignments, rows.assignments, (g) => g.id, (r) => r.id, inScope);
  const dueOk = assignments.matched.filter(([g, r]) => sameInstant(g.dueAt, r.due_at)).length;
  const pointsOk = assignments.matched.filter(([g, r]) => sameNumber(g.points, r.points_possible)).length;
  const pages = table(gold.pages, rows.pages, (g) => slugKey(g.courseId, g.url), (r) => slugKey(r.course_id, r.url), inScope);
  const pageF1 = pages.matched.map(([g, r]) => textF1(r.body_text, g.text));
  const files = table(gold.files, rows.files, (g) => g.id, (r) => r.id, inScope);
  const bearing = files.matched.filter(([g]) => g.textBearing);
  const textPresent = bearing.filter(([, r]) => (r.text ?? "").trim().length > 0).length;
  const sampled = files.matched.filter(([g]) => g.text !== undefined && g.text.trim().length > 0);
  const sampledF1 = sampled.map(([g, r]) => textF1(r.text, g.text!));
  const hiddenCourses = new Set(
    gold.courses.filter((c) => c.current && !gold.files.some((f) => f.courseId === c.id && f.reachableVia.includes("files_list"))).map((c) => c.id),
  );
  const hiddenGold = gold.files.filter((f) => hiddenCourses.has(f.courseId));
  const hiddenMatched = files.matched.filter(([g]) => hiddenCourses.has(g.courseId)).length;

  const syllabusRows = new Map(rows.syllabus.map((r) => [r.course_id, r]));
  const syllabusPresent = gold.syllabus.filter((g) => (syllabusRows.get(g.courseId)?.text ?? "").trim().length > 0);
  const syllabusF1 = gold.syllabus.map((g) => textF1(syllabusRows.get(g.courseId)?.text ?? "", g.text));

  const mean = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : 1);
  const score: Score = {
    courses,
    modules: modules.score,
    items: { ...items.score, wrongModule },
    groups: { ...groups.score, weightExact: round(ratio(weightExact, groups.matched.length)) },
    assignments: {
      ...assignments.score,
      dueExact: round(ratio(dueOk, assignments.matched.length)),
      pointsExact: round(ratio(pointsOk, assignments.matched.length)),
      dueMismatch: assignments.matched.length - dueOk,
      pointsMismatch: assignments.matched.length - pointsOk,
    },
    pages: { ...pages.score, textF1Mean: mean(pageF1), emptyBodies: pages.matched.filter(([, r]) => !(r.body_text ?? "").trim()).length },
    files: {
      ...files.score, textPresent: round(ratio(textPresent, bearing.length)), textBearingMatched: bearing.length,
      sampled: sampled.length, sampledF1Mean: mean(sampledF1), hiddenTabGold: hiddenGold.length, hiddenTabMatched: hiddenMatched,
    },
    syllabus: {
      gold: gold.syllabus.length, present: syllabusPresent.length,
      sourceMatch: gold.syllabus.filter((g) => syllabusRows.get(g.courseId)?.source === g.source).length,
      textF1Mean: mean(syllabusF1),
    },
    checks: [],
    pass: false,
    problems,
  };
  const T = THRESHOLDS;
  const extraOk = (s: TableScore) => s.extra <= Math.max(1, Math.floor(T.extraShare * s.gold));
  const check = (name: string, value: number, threshold: string, pass: boolean) => score.checks.push({ name, value: round(value), threshold, pass });
  check("current courses exact (missing + wrong)", courses.currentMissing + courses.wrongCurrent, "= 0", courses.currentMissing + courses.wrongCurrent === 0);
  check("assignments recall", score.assignments.recall, `>= ${T.assignmentsRecall}`, score.assignments.recall >= T.assignmentsRecall);
  check("assignments due_at exact", score.assignments.dueExact, `>= ${T.assignmentsDueExact}`, score.assignments.dueExact >= T.assignmentsDueExact);
  check("assignments points exact", score.assignments.pointsExact, `>= ${T.assignmentsPointsExact}`, score.assignments.pointsExact >= T.assignmentsPointsExact);
  check("assignments extra rows", score.assignments.extra, `<= max(1, 1% of gold)`, extraOk(score.assignments));
  check("assignment groups recall", score.groups.recall, `>= ${T.groupsRecall}`, score.groups.recall >= T.groupsRecall);
  check("assignment group weights exact", score.groups.weightExact, `>= ${T.groupWeightsExact}`, score.groups.weightExact >= T.groupWeightsExact);
  check("modules recall", score.modules.recall, `>= ${T.modulesRecall}`, score.modules.recall >= T.modulesRecall);
  check("modules extra rows", score.modules.extra, `<= max(1, 1% of gold)`, extraOk(score.modules));
  check("module items recall", score.items.recall, `>= ${T.itemsRecall}`, score.items.recall >= T.itemsRecall);
  check("module items in the wrong module", wrongModule, `<= max(1, 1% of gold)`, wrongModule <= Math.max(1, Math.floor(T.extraShare * score.items.gold)));
  check("module items extra rows", score.items.extra, `<= max(1, 1% of gold)`, extraOk(score.items));
  check("pages recall", score.pages.recall, `>= ${T.pagesRecall}`, score.pages.recall >= T.pagesRecall);
  check("pages text F1 (mean)", score.pages.textF1Mean, `>= ${T.pagesTextF1}`, score.pages.textF1Mean >= T.pagesTextF1);
  check("files recall (incl. hidden Files tabs)", score.files.recall, `>= ${T.filesRecall}`, score.files.recall >= T.filesRecall);
  check("files with text (text-bearing)", score.files.textPresent, `>= ${T.filesTextPresent}`, score.files.textPresent >= T.filesTextPresent);
  check("sampled file text F1 (mean)", score.files.sampledF1Mean, `>= ${T.filesSampledF1}`, score.files.sampledF1Mean >= T.filesSampledF1);
  check("syllabus present", ratio(syllabusPresent.length, gold.syllabus.length), `>= ${T.syllabusPresent}`, ratio(syllabusPresent.length, gold.syllabus.length) >= T.syllabusPresent);
  check("syllabus text F1 (mean)", score.syllabus.textF1Mean, `>= ${T.syllabusTextF1}`, score.syllabus.textF1Mean >= T.syllabusTextF1);
  score.pass = score.checks.every((c) => c.pass);
  return score;
}

/** The target rows a perfect ingestion would write (tests, and the fake agent's starting point). */
export function goldToRows(gold: Gold): TargetRows {
  return {
    courses: gold.courses.map((c) => ({ id: c.id, name: c.name ?? `Course ${c.id}`, course_code: c.code, term: c.term, is_current: c.current ? 1 : 0 })),
    modules: gold.modules.map((m) => ({ id: m.id, course_id: m.courseId, name: m.name, position: m.position })),
    module_items: gold.items.map((i) => ({ id: i.id, module_id: i.moduleId, course_id: i.courseId, title: i.title, type: i.type, content_id: i.contentId, page_url: i.pageUrl, position: i.position })),
    assignment_groups: gold.groups.map((g) => ({ id: g.id, course_id: g.courseId, name: g.name, weight: g.weight })),
    assignments: gold.assignments.map((a) => ({ id: a.id, course_id: a.courseId, name: a.name, due_at: a.dueAt, points_possible: a.points, assignment_group_id: a.groupId, description: a.text })),
    pages: gold.pages.map((p) => ({ course_id: p.courseId, url: p.url, title: p.title, updated_at: p.updatedAt, body_text: p.text })),
    files: gold.files.map((f) => ({ id: f.id, course_id: f.courseId, display_name: f.name, content_type: f.contentType, size: f.size, updated_at: f.updatedAt, text: f.text ?? (f.textBearing ? `${f.name} text` : null) })),
    syllabus: gold.syllabus.map((s) => ({ course_id: s.courseId, source: s.source, text: s.text })),
  };
}

/** One timeline snapshot: when, and the assignment rows (id, due, points) at that moment. */
export interface Snapshot { ms: number; counts: Record<string, number>; assignments: Array<[string, string | null, number | null]> }

/** Milliseconds from the run's start until the agenda was usable (see THRESHOLDS.agendaShare); null if never. */
export function agendaUsableMs(gold: Gold, timeline: Snapshot[]): number | null {
  const dated = gold.assignments.filter((a) => a.dueAt);
  if (!dated.length) return null;
  for (const snap of [...timeline].sort((a, b) => a.ms - b.ms)) {
    const rows = new Map(snap.assignments.map(([id, due]) => [id, due]));
    const ok = dated.filter((a) => sameInstant(a.dueAt, rows.get(a.id) ?? null) && rows.has(a.id)).length;
    if (ok / dated.length >= THRESHOLDS.agendaShare) return snap.ms;
  }
  return null;
}

/** Whether each repeat-sync mutation is reflected (dry run only: the live account is never changed). */
export function changesPickedUp(
  gold: Gold,
  rows: TargetRows,
  changes: Array<{ kind: string; courseId: string; id: string }>,
): { picked: number; total: number } {
  let picked = 0;
  for (const change of changes) {
    if (change.kind === "due_date_moved") {
      const g = gold.assignments.find((a) => a.id === change.id);
      const r = rows.assignments.find((a) => a.id === change.id);
      if (g && r && sameInstant(g.dueAt, r.due_at)) picked++;
    } else if (change.kind === "page_edited") {
      const g = gold.pages.find((p) => p.courseId === change.courseId && p.url === change.id);
      const r = rows.pages.find((p) => p.course_id === change.courseId && slugKey(p.course_id, p.url) === slugKey(change.courseId, change.id));
      if (g && r && /review session moved/i.test(r.body_text ?? "")) picked++;
    } else if (change.kind === "file_added") {
      const r = rows.files.find((f) => f.id === change.id);
      if (r && (r.text ?? "").trim()) picked++;
    }
  }
  return { picked, total: changes.length };
}
