/**
 * Part B: academic agent tasks whose answers code can check against the gold. Ten families, six
 * tasks each (60), drawn deterministically from the gold's current courses; each trial is one
 * agent run on one task. Answers are JSON with Canvas ids; an exact title is accepted where it is
 * unique in its course. Scoring is code only.
 */
import type { Gold } from "./gold";
import { hash32, rng, sameInstant, sameName, sameNumber } from "./text";

export type Family =
  | "due_between" | "due_date" | "points" | "group_weight" | "module_of" | "readings" | "next_due" | "exam_date" | "module_size" | "files_in_module";
export interface Task { id: string; family: Family; courseId: string; question: string; schema: object; expected: Record<string, unknown> }

const idList = { type: "array", items: { type: "string" } };
const obj = (properties: Record<string, object>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const chicago = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });

export function generateTasks(gold: Gold, perFamily = 6, seed = 7): Task[] {
  const random = rng(seed);
  const shuffle = <T>(xs: T[]) => xs.map((x) => [random(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
  const courses = new Map(gold.courses.filter((c) => c.current).map((c) => [c.id, c]));
  const courseName = (id: string) => courses.get(id)?.name ?? id;
  const unique = <T extends { courseId: string; name?: string; title?: string }>(rows: T[]) =>
    rows.filter((r) => rows.filter((o) => o.courseId === r.courseId && sameName(o.name ?? o.title, r.name ?? r.title)).length === 1);
  const assignments = unique(gold.assignments.filter((a) => courses.has(a.courseId)));
  const tasks: Task[] = [];
  const add = (family: Family, courseId: string, question: string, schema: object, expected: Record<string, unknown>) =>
    tasks.push({ id: `${family}-${tasks.filter((t) => t.family === family).length + 1}`, family, courseId, question, schema, expected });

  const dated = assignments.filter((a) => a.dueAt);
  for (const a of shuffle(dated).slice(0, perFamily))
    add("due_date", a.courseId, `When is "${a.name}" in ${courseName(a.courseId)} due? Give the instant in UTC ISO 8601.`, obj({ due_at: { type: ["string", "null"] } }), { due_at: a.dueAt });
  for (const a of shuffle(assignments).slice(0, perFamily))
    add("points", a.courseId, `How many points is "${a.name}" in ${courseName(a.courseId)} worth?`, obj({ points: { type: ["number", "null"] } }), { points: a.points });
  const weighted = unique(gold.groups.filter((g) => courses.get(g.courseId)?.weighted && g.weight !== null).map((g) => ({ ...g, title: g.name })));
  for (const g of shuffle(weighted).slice(0, perFamily))
    add("group_weight", g.courseId, `What percent of the final grade is the "${g.name}" assignment group in ${courseName(g.courseId)}?`, obj({ weight: { type: ["number", "null"] } }), { weight: g.weight });
  const items = unique(gold.items.filter((i) => courses.has(i.courseId) && i.type !== "SubHeader"));
  for (const i of shuffle(items).slice(0, perFamily))
    add("module_of", i.courseId, `Which module in ${courseName(i.courseId)} contains the item "${i.title}"? Give the module's id.`, obj({ module_id: { type: "string" } }), { module_id: i.moduleId });
  const withLinks = assignments.filter((a) => a.links.files.length + a.links.pages.length > 0);
  for (const a of shuffle(withLinks).slice(0, perFamily))
    add("readings", a.courseId, `Which course files and pages does the description of "${a.name}" in ${courseName(a.courseId)} link to? Give file ids and page url slugs.`, obj({ file_ids: idList, page_urls: idList }), { file_ids: a.links.files, page_urls: a.links.pages });
  const exams = assignments.filter((a) => /exam|midterm|final/i.test(a.name) && a.dueAt);
  for (const a of shuffle(exams).slice(0, perFamily))
    add("exam_date", a.courseId, `When is the ${a.name} in ${courseName(a.courseId)}? Give the instant in UTC ISO 8601.`, obj({ due_at: { type: ["string", "null"] } }), { due_at: a.dueAt });
  for (const courseId of shuffle([...courses.keys()]).slice(0, perFamily)) {
    const inCourse = dated.filter((a) => a.courseId === courseId).sort((x, y) => x.dueAt!.localeCompare(y.dueAt!));
    if (inCourse.length < 3) continue;
    const pivot = inCourse[Math.floor(random() * (inCourse.length - 2))]!;
    const start = new Date(Date.parse(pivot.dueAt!) - 3600_000), end = new Date(start.getTime() + 10 * 86400_000);
    const within = inCourse.filter((a) => Date.parse(a.dueAt!) >= start.getTime() && Date.parse(a.dueAt!) <= end.getTime());
    add("due_between", courseId, `List every assignment in ${courseName(courseId)} due from ${chicago.format(start)} to ${chicago.format(end)} (America/Chicago), in due-date order. Give assignment ids.`, obj({ assignment_ids: idList }), { assignment_ids: within.map((a) => a.id) });
    const after = new Date(Date.parse(inCourse[1]!.dueAt!) - 1800_000);
    const next = inCourse.find((a) => Date.parse(a.dueAt!) > after.getTime())!;
    add("next_due", courseId, `In ${courseName(courseId)}, which assignment is due first after ${chicago.format(after)} (America/Chicago)? Give its id.`, obj({ assignment_id: { type: "string" } }), { assignment_id: next.id });
  }
  const modules = unique(gold.modules.filter((m) => courses.has(m.courseId)).map((m) => ({ ...m, title: m.name })));
  for (const m of shuffle(modules).slice(0, perFamily)) {
    const inModule = gold.items.filter((i) => i.moduleId === m.id);
    add("module_size", m.courseId, `How many items (sub-headers included) does the module "${m.name}" in ${courseName(m.courseId)} have?`, obj({ count: { type: "number" } }), { count: inModule.length });
    add("files_in_module", m.courseId, `List the files in the module "${m.name}" of ${courseName(m.courseId)}. Give file ids.`, obj({ file_ids: idList }), { file_ids: inModule.filter((i) => i.type === "File" && i.contentId).map((i) => i.contentId!) });
  }
  const byFamily = new Map<Family, Task[]>();
  for (const t of tasks) byFamily.set(t.family, [...(byFamily.get(t.family) ?? []), t]);
  return [...byFamily.values()].flatMap((list) => list.slice(0, perFamily));
}

/** The same deterministic sample of tasks for every client and condition (paired comparison). */
export function sampleTasks(tasks: Task[], n: number, seed = 11): Task[] {
  return [...tasks].sort((a, b) => hash32(`${seed}:${a.id}`) - hash32(`${seed}:${b.id}`)).slice(0, n);
}

export type Failure = "wrong_answer" | "schema_error" | "timeout" | "budget" | "tool_error" | "agent_error";

/** Resolves ids given as ids or as exact, course-unique titles. */
function resolve(values: unknown, gold: Gold, courseId: string, kind: "assignment" | "module" | "file"): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const rows: Array<{ id: string; title: string }> =
    kind === "assignment" ? gold.assignments.filter((a) => a.courseId === courseId).map((a) => ({ id: a.id, title: a.name }))
    : kind === "module" ? gold.modules.filter((m) => m.courseId === courseId).map((m) => ({ id: m.id, title: m.name }))
    : gold.files.filter((f) => f.courseId === courseId).map((f) => ({ id: f.id, title: f.name }));
  return values.map((v) => {
    const s = String(v).trim();
    if (rows.some((r) => r.id === s)) return s;
    const byName = rows.filter((r) => sameName(r.title, s));
    return byName.length === 1 ? byName[0]!.id : s;
  });
}
const sameSet = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

export function checkAnswer(task: Task, answer: unknown, gold: Gold): { correct: boolean; failure?: Failure } {
  if (!answer || typeof answer !== "object") return { correct: false, failure: "schema_error" };
  const a = answer as Record<string, unknown>, e = task.expected;
  let correct = false;
  switch (task.family) {
    case "due_date":
    case "exam_date":
      correct = sameInstant(typeof a.due_at === "string" ? a.due_at : null, e.due_at as string | null);
      break;
    case "points":
      correct = sameNumber(typeof a.points === "number" ? a.points : null, e.points as number | null);
      break;
    case "group_weight":
      correct = sameNumber(typeof a.weight === "number" ? a.weight : null, e.weight as number | null);
      break;
    case "module_of":
      correct = resolve([a.module_id], gold, task.courseId, "module")?.[0] === e.module_id;
      break;
    case "readings":
      correct = sameSet(resolve(a.file_ids, gold, task.courseId, "file"), e.file_ids as string[]) &&
        sameSet(Array.isArray(a.page_urls) ? a.page_urls.map((p) => String(p).replace(/^.*\/pages\//, "").toLowerCase()) : undefined, (e.page_urls as string[]).map((p) => p.toLowerCase()));
      break;
    case "due_between": {
      const got = resolve(a.assignment_ids, gold, task.courseId, "assignment");
      const want = e.assignment_ids as string[];
      const due = (id: string) => gold.assignments.find((x) => x.id === id)?.dueAt ?? "";
      // Order must follow due dates; ties may come in either order.
      correct = sameSet(got, want) && !!got && got.every((id, i) => i === 0 || due(got[i - 1]!) <= due(id));
      break;
    }
    case "next_due":
      correct = resolve([a.assignment_id], gold, task.courseId, "assignment")?.[0] === e.assignment_id;
      break;
    case "module_size":
      correct = a.count === e.count;
      break;
    case "files_in_module":
      correct = sameSet(resolve(a.file_ids, gold, task.courseId, "file"), e.file_ids as string[]);
      break;
  }
  return correct ? { correct } : { correct, failure: "wrong_answer" };
}

/** A deliberately wrong answer of the right shape (the fake agent's misses). */
export function wrongAnswer(task: Task): Record<string, unknown> {
  const e = task.expected;
  const k = Object.keys(e)[0]!;
  const v = e[k];
  return { ...e, [k]: Array.isArray(v) ? [] : typeof v === "number" ? v + 1 : typeof v === "string" ? `${v}0` : "unknown" };
}

/** Percentile bootstrap of a mean (95% by default). */
export function bootstrap(values: number[], iterations = 2000, seed = 3, level = 0.95): { mean: number; low: number; high: number } {
  if (!values.length) return { mean: NaN, low: NaN, high: NaN };
  const random = rng(seed);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) sum += values[Math.floor(random() * values.length)]!;
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const q = (p: number) => means[Math.min(means.length - 1, Math.max(0, Math.floor(p * means.length)))]!;
  return { mean, low: q((1 - level) / 2), high: q(1 - (1 - level) / 2) };
}
