/**
 * View-open harness: every query and command a top-level view or tab issues when it opens, run
 * against a workspace database (a copy: it is copied again to a temporary folder before use, so
 * the input is never written). Times each op over N warm runs (p50, p95), the first (cold) call,
 * statements per call, the JSON payload and its structured-clone time (each IPC hop clones it).
 *
 *   tsx evals/perf/views.ts --db <workspace.sqlite> --out <folder> [--runs 10] [--label before]
 *
 * Writes <out>/views-<label>.json and .md. Prints nothing from the workspace's content: op names,
 * counts, times and byte sizes only. No network, no model calls, no UI.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatementSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema, type Command, type GraphQuery, type LearningRequest, type NotesRequest, type QueryRequest } from "@magic/contracts";
import { agenda, courseGraph, createPipelineReferences, references } from "../../packages/core/src/graph/index";
import { appJobRegistry } from "../../packages/core/src/jobs/default-registry";
import { createLearningRouter } from "../../packages/learning/src/router";
import { createExamEvidence } from "../../packages/learning/src/exam/evidence";
import { createNotesService } from "../../packages/notes/src/index";
import { createStudyContextResolver } from "../../apps/desktop/src/learning-context";
import fixture from "../../fixtures/course.json";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const DB = arg("db");
const OUT = arg("out");
const RUNS = Number(arg("runs", "10"));
const LABEL = arg("label", "run")!;
if (!DB || !OUT) {
  console.error("usage: tsx evals/perf/views.ts --db <workspace.sqlite> --out <folder> [--runs 10] [--label name]");
  process.exit(2);
}

let statements = 0;
for (const method of ["all", "get", "run", "iterate"] as const) {
  const original = StatementSync.prototype[method] as (...args: unknown[]) => unknown;
  (StatementSync.prototype as unknown as Record<string, unknown>)[method] = function (this: StatementSync, ...args: unknown[]) {
    statements++;
    return original.apply(this, args);
  };
}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]!;
};

const work = mkdtempSync(join(tmpdir(), "magic-views-"));
const file = join(work, "workspace.sqlite");
copyFileSync(DB, file);
const store = createStore(file);
const core = createCore(store, { fixture: captureBatchSchema.parse(fixture), jobs: appJobRegistry() });
const resolveStudyContext = createStudyContextResolver(store, core);
const router = createLearningRouter({
  store: store.learning,
  resolveContext: (id) => resolveStudyContext(id),
  resolveContexts: (ids) => resolveStudyContext.many(ids),
  analyticsReferences: () => createPipelineReferences(store),
  coursework: () => store,
  examEvidence: () => createExamEvidence(store),
});
const notes = createNotesService({ store });
// The worker's composition, minus every runner: learning and notes through core.execute's seams.
const seamed = createCore(store, {
  fixture: captureBatchSchema.parse(fixture),
  jobs: appJobRegistry(),
  seams: { learning: router, notes },
});
const signal = new AbortController().signal;

// ------------------------------------------------------------------ the scope the views open on
const summary = core.query({ view: "summary" });
if (summary.view !== "summary") throw new Error("summary");
const notCourses = new Set(["outlook-mail", "outlook-calendar"]);
const courseRows = summary.courses.filter((c) => c.included && !notCourses.has(c.courseId));
// The course with the most saved assignments (the heaviest a student opens).
const assignmentsOf = (c: { accountScope: string; courseId: string }) => {
  const r = core.query({ view: "resources", courseId: c.courseId, accountScope: c.accountScope, kinds: ["assignment"], limit: 50 });
  return r.view === "resources" ? r.items.filter((a) => !a.deleted) : [];
};
const ranked = courseRows.map((c) => ({ c, n: assignmentsOf(c).length })).sort((a, b) => b.n - a.n);
const course = ranked[0]?.c;
if (!course) throw new Error("No included course with assignments in this workspace.");
const scope = { accountScope: course.accountScope, courseId: course.courseId };
const assignments = assignmentsOf(course);
const anchorIds = assignments.map((a) => a.id);
const assignmentId = anchorIds[0]!;
const assessmentId = (assignments.find((a) => /exam|midterm|quiz|final/i.test(a.title)) ?? assignments[0])!.id;
const today = new Date().toISOString().slice(0, 10);
const tz = "America/Chicago";

type Op = { view: string; name: string; run: () => unknown };
const q = (request: QueryRequest) => () => core.query(request);
const g = (request: GraphQuery) => () =>
  request.type === "references"
    ? references(store, request.assignmentId)
    : request.type === "agenda"
      ? agenda(store, { date: request.date, tz: request.tz, ...(request.days ? { days: request.days } : {}) })
      : courseGraph(store, { accountScope: request.accountScope, courseId: request.courseId });
const exec = (command: Command) => () => seamed.execute(command);
const learn = (request: LearningRequest) => exec({ type: "learning", request, reply: "result" });
const note = (request: NotesRequest) => exec({ type: "notes", request, reply: "result" });
const base = { courseId: course.courseId, anchorIds };

const ops: Op[] = [
  { view: "shell (poll every 2 s; every command's reply)", name: "execute snapshot", run: exec({ type: "snapshot" }) },
  { view: "Today: open an item", name: "execute ui_event open", run: exec({ type: "ui_event", value: { kind: "open", subject: assignmentId }, reply: "result" }) },
  { view: "Today: open an item", name: "learning study.sessions", run: learn({ op: "study.sessions", resourceId: assignmentId }) },
  { view: "Sources: course access", name: "query courseSpaces", run: q({ view: "courseSpaces", ...scope }) },
  { view: "Workspace tools (open)", name: "query summary", run: q({ view: "summary" }) },
  { view: "Workspace tools (open)", name: "query resources (assignments, 50)", run: q({ view: "resources", ...scope, kinds: ["assignment"], limit: 50 }) },
  { view: "Tools: Agenda", name: "graph agenda (14 days)", run: g({ type: "agenda", date: today, tz, days: 14 }) },
  { view: "Tools: References", name: "graph references", run: g({ type: "references", assignmentId }) },
  { view: "Tools: Guides", name: "graph courseGraph", run: g({ type: "courseGraph", ...scope }) },
  { view: "Tools: Guides", name: "query guide", run: q({ view: "guide", courseId: course.courseId, kind: "guide" }) },
  { view: "Tools: Practice", name: "learning practice.path", run: learn({ op: "practice.path", ...base }) },
  { view: "Tools: Practice", name: "learning knowledge.state", run: learn({ op: "knowledge.state", ...base }) },
  { view: "Tools: Analytics", name: "learning analytics.course", run: learn({ op: "analytics.course", ...base }) },
  { view: "Tools: Analytics", name: "learning analytics.agendaHints", run: learn({ op: "analytics.agendaHints", ...base }) },
  { view: "Tools: Analytics", name: "learning analytics.assignment", run: learn({ op: "analytics.assignment", ...base, assignmentId }) },
  { view: "Study & Learn (Mastery)", name: "learning course.mastery", run: learn({ op: "course.mastery", ...base }) },
  { view: "Study & Learn: exams tab", name: "learning mastery.history", run: learn({ op: "mastery.history", ...base }) },
  { view: "Study & Learn: grades tab", name: "learning course.grades", run: learn({ op: "course.grades", ...base }) },
  { view: "Tools: Notes", name: "notes notes.recent", run: note({ op: "notes.recent", courseId: course.courseId, limit: 5 }) },
  { view: "Tools: Notes", name: "notes notes.tree", run: note({ op: "notes.tree", ...scope }) },
  { view: "Tools: Notes", name: "notes notes.templates", run: note({ op: "notes.templates" }) },
  { view: "Tools: Notes", name: "notes notes.sync.status", run: note({ op: "notes.sync.status" }) },
  { view: "Tools: Outlook", name: "query summary (main's status)", run: q({ view: "summary" }) },
  { view: "Tools: Outlook", name: "query mail.search", run: q({ view: "mail.search", limit: 10 }) },
  { view: "Tools: Outlook", name: "query resources (meetings)", run: q({ view: "resources", courseId: "outlook-calendar", kinds: ["event"], limit: 50 }) },
  { view: "Tools: Page views", name: "query assignment.workspace", run: q({ view: "assignment.workspace", resourceId: assignmentId }) },
  { view: "Tools: Page views", name: "query assessment.page", run: q({ view: "assessment.page", assessmentId }) },
  { view: "Tools: Page views", name: "query lecture.session", run: q({ view: "lecture.session", ...scope, date: today }) },
  { view: "Tools: Page views", name: "query study.offers", run: q({ view: "study.offers", ...scope, days: 30 }) },
  { view: "Other reads", name: "query agenda.ranked", run: q({ view: "agenda.ranked", limit: 20, timeZone: tz }) },
  { view: "Other reads", name: "query workspace.bootstrap", run: q({ view: "workspace.bootstrap", top: 5, timeZone: tz }) },
  { view: "Other reads", name: "query resource", run: q({ view: "resource", id: assignmentId }) },
  { view: "Practice action", name: "learning practice.target (flashcards)", run: learn({ op: "practice.target", ...base, mode: "flashcards", count: 10, operationId: crypto.randomUUID() }) },
];

interface Row {
  view: string;
  name: string;
  status: string;
  firstMs: number;
  p50: number;
  p95: number;
  statements: number;
  bytes: number;
  cloneMs: number;
}
const rows: Row[] = [];
for (const op of ops) {
  let status = "ok";
  const time = async () => {
    const before = statements;
    const t = performance.now();
    let value: unknown;
    try {
      value = await op.run();
    } catch (error) {
      status = `error: ${error instanceof Error ? error.message.slice(0, 80) : "unknown"}`;
    }
    return { ms: performance.now() - t, n: statements - before, value };
  };
  const first = await time();
  const times: number[] = [];
  let last = first;
  for (let i = 0; i < RUNS; i++) {
    last = await time();
    times.push(last.ms);
  }
  const inner = (last.value as { learning?: { status?: string }; notes?: { status?: string } } | undefined) ?? {};
  if (status === "ok" && (inner.learning?.status ?? inner.notes?.status)) status = String(inner.learning?.status ?? inner.notes?.status);
  const json = last.value === undefined ? "" : JSON.stringify(last.value);
  const clones: number[] = [];
  for (let i = 0; i < 3 && last.value !== undefined; i++) {
    const t = performance.now();
    deserialize(serialize(last.value));
    clones.push(performance.now() - t);
  }
  rows.push({
    view: op.view,
    name: op.name,
    status,
    firstMs: first.ms,
    p50: pct(times, 50),
    p95: pct(times, 95),
    statements: last.n,
    bytes: Buffer.byteLength(json),
    cloneMs: clones.length ? pct(clones, 50) : 0,
  });
  process.stdout.write(`${op.name}: p50 ${pct(times, 50).toFixed(1)} ms, p95 ${pct(times, 95).toFixed(1)} ms, ${last.n} statements\n`);
}

const shape = {
  resources: store.resources().length,
  sources: store.sources().length,
  anchors: anchorIds.length,
  courses: courseRows.length,
};
mkdirSync(OUT, { recursive: true });
const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
const md = [
  `# View-open harness: ${LABEL}`,
  "",
  `${new Date().toISOString()} · ${RUNS} warm runs per op · workspace: ${shape.resources} resources, ${shape.sources} sources, ${shape.courses} included courses; practice anchors: ${shape.anchors}.`,
  "Learning and notes ops go through core.execute, as the renderer calls them (the reply's snapshot included).",
  "",
  "| View | Op | status | first ms | p50 ms | p95 ms | statements | payload | clone ms |",
  "|---|---|---|---:|---:|---:|---:|---:|---:|",
  ...rows.map((r) => `| ${r.view} | ${r.name} | ${r.status} | ${fmt(r.firstMs)} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${r.statements} | ${kb(r.bytes)} | ${fmt(r.cloneMs)} |`),
  "",
].join("\n");
writeFileSync(join(OUT, `views-${LABEL}.md`), md);
writeFileSync(join(OUT, `views-${LABEL}.json`), `${JSON.stringify({ label: LABEL, runs: RUNS, shape, rows }, null, 2)}\n`);
await seamed.close();
await core.close().catch(() => {});
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${join(OUT, `views-${LABEL}.md`)}`);
