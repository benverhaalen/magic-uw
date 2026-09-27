import test from "node:test";
import assert from "node:assert/strict";
import { compileCourse, references } from "../packages/core/src/graph/index";
import { course, idOf, NOW, seededStore } from "./pipeline-fixture";

test("references: direct links always kept, module material only, other modules only when linked or named", async () => {
  const store = seededStore();
  await compileCourse(store, course, NOW);
  const hw1 = idOf(store, "assignments", "1001");
  const refs = references(store, hw1);
  const byTitle = new Map(refs.map((r) => [r.title, r]));

  // Direct: a page in another module, linked from the body, is kept (recall-critical).
  assert.equal(byTitle.get("Matrix notes")?.strength, "direct");
  // A link to a file that was never captured is still listed, by URL.
  assert.ok(refs.some((r) => r.strength === "direct" && r.resourceId === null && r.externalUrl?.includes("/files/5999")));
  // External links: one per page (the query is dropped), never the equation images.
  assert.equal(refs.filter((r) => r.kind === "external" && r.strength === "direct").length, 1);
  assert.ok(!refs.some((r) => r.externalUrl?.includes("equation_images")));
  // Named: a file named in the text is kept even though it is in no module.
  assert.equal(byTitle.get("Handbook part A.pdf")?.strength, "named");
  // Module siblings: course material in Homework 1's module; admin pages and other tasks are not.
  assert.equal(byTitle.get("Vectors notes")?.strength, "module");
  assert.equal(byTitle.get("Lecture 1 slides.pdf")?.strength, "module");
  assert.ok(refs.some((r) => r.strength === "module" && r.externalUrl === "https://www.youtube.com/embed/vectors-demo"));
  assert.ok(!byTitle.has("Office hours and staff"), "admin siblings are left out");
  assert.ok(!byTitle.has("Homework 2") && !byTitle.has("Quiz 1"), "other tasks are not references");
  // Other module's items that the body neither links nor names are excluded.
  assert.ok(!byTitle.has("Matrix worksheet.pdf"));
  assert.ok(!byTitle.has("Determinant tricks"));
  // Syllabus: the line that names it.
  const syllabus = refs.find((r) => r.strength === "syllabus");
  assert.match(syllabus!.reason, /Homework 1 is due/);
  // Ordered by strength, and each target once.
  const rank = { direct: 0, named: 1, module: 2, syllabus: 3, covers: 4 };
  assert.deepEqual(refs.map((r) => rank[r.strength]), [...refs.map((r) => rank[r.strength])].sort((a, b) => a - b));
  assert.equal(new Set(refs.map((r) => r.resourceId ?? r.externalUrl)).size, refs.length);

  // Any captured copy (the to-do copy, the module item) answers with the canonical assignment's list.
  assert.deepEqual(references(store, idOf(store, "account-todo", "1001")), refs);
  // The short form in the syllabus ("HW 2") names Homework 2.
  const hw2 = references(store, idOf(store, "assignments", "1002"));
  assert.ok(hw2.some((r) => r.strength === "syllabus" && /HW 2/.test(r.reason)));
  assert.ok(hw2.some((r) => r.title === "Matrix worksheet.pdf" && r.strength === "module"));
  store.close();
});
