import test from "node:test";
import assert from "node:assert/strict";
import { analyzeResource, buildCourseIndex, classifyRole, compileCourse, courseIndex, type Res } from "../packages/core/src/graph/index";
import { course, idOf, NOW, seededStore } from "./pipeline-fixture";

const res = (value: Partial<Res> & Pick<Res, "id" | "title">): Res => ({
  externalId: value.id,
  kind: "material",
  courseId: "101",
  courseName: "Example",
  url: `https://canvas.wisc.edu/courses/101/pages/${value.id}`,
  text: "",
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "unknown", evidence: "" },
  sourceId: "s",
  contentHash: "h",
  version: 1,
  observedAt: NOW,
  capturedAt: NOW,
  deleted: false,
  completed: false,
  scope: "page:x",
  ...value,
});

test("role rules: title first, priority order, and a quote that cuts the title", () => {
  const index = buildCourseIndex(course, "h", []);
  const cases: [string, string][] = [
    ["Homework 3", "homework"],
    ["Exam 1 Solutions", "solutions"],
    ["Homework 3 rubric", "rubric"],
    ["Lecture 5 slides", "lecture"],
    ["Midterm review", "exam"],
    ["Peer review of essay 2", "homework"],
    ["Lab 4: Circuits", "lab"],
    ["Chapter 7 reading", "reading"],
    ["Welcome to the course", "admin"],
    ["Course syllabus", "syllabus"],
  ];
  for (const [title, role] of cases) {
    const r = res({ id: title.replace(/\W+/g, "-").toLowerCase(), title });
    const got = classifyRole(index, r);
    assert.equal(got?.role, role, title);
    assert.equal(got!.fact.basis, "title");
    assert.match(title.slice(got!.fact.start, got!.fact.end), /\w/);
  }
  // Only the text's heading line counts: a later sentence doesn't make a page "solutions".
  const page = res({ id: "later", title: "Week notes intro", text: "Getting going\nSubmit your solutions by Friday." });
  assert.notEqual(classifyRole(index, page)?.role, "solutions");
});

test("structure beats silence: folder names, the Canvas type, and needs_judgment for the rest", async () => {
  const store = seededStore();
  const index = courseIndex(store, course);
  const reading = index.resources.get(idOf(store, "files", "5003"))!;
  const role = classifyRole(index, reading)!;
  assert.equal(role.role, "reading");
  assert.equal(role.fact.basis, "structure");
  assert.equal(role.fact.quote, "Readings");
  const mystery = index.resources.get(idOf(store, "files", "5004"))!;
  assert.equal(classifyRole(index, mystery), undefined);
  const facts = analyzeResource(index, mystery, []).facts;
  assert.ok(facts.some((f) => f.kind === "needs_judgment" && f.value === "role"));
  const midterm = index.resources.get(idOf(store, "assignments", "1003"))!;
  assert.equal(classifyRole(index, midterm)?.role, "exam");

  await compileCourse(store, course, NOW);
  // Module, week and the quoted facts land in material_facts with offsets the store checked.
  const page = idOf(store, "page:vectors", "p1");
  const text = store.resource(page)!.text;
  const stored = store.materialFacts(page);
  assert.ok(stored.some((f) => f.kind === "module" && f.value === "m1" && f.quote === "Week 1: Vectors"));
  assert.ok(stored.some((f) => f.kind === "session" && f.value === "week:1"));
  assert.ok(stored.some((f) => f.kind === "definition" && f.value === "Magnitude"));
  assert.ok(stored.some((f) => f.kind === "formula" && f.value.includes("v = a + b")));
  assert.ok(stored.some((f) => f.kind === "date" && f.value === "2026-09-30"));
  for (const f of stored.filter((x) => x.basis === "text")) assert.equal(text.slice(f.start, f.end), f.quote);
  // The image outside every module is a page asset, not a material: no role is asked of it.
  assert.equal(store.materialFacts(idOf(store, "files", "5005")).length, 0);
  store.close();
});
