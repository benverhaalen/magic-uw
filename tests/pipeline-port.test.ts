import test from "node:test";
import assert from "node:assert/strict";
import { graphQuerySchema } from "../packages/contracts/src/course-core";
import { compileCourse, courseIndex, createPipelineReferences, references, STRUCTURE_COVERS_WEIGHT, strengthWeight } from "../packages/core/src/graph/index";
import { course, idOf, NOW, seededStore } from "./pipeline-fixture";

test("covers facts: a quoted covers is a reference, ranked after linked, named, module and syllabus ones", async () => {
  const store = seededStore();
  await compileCourse(store, course, NOW);
  const exam = idOf(store, "assignments", "1003");
  const review = idOf(store, "page:review", "p6");
  const practice = idOf(store, "page:practice", "p5");
  const covering = store.coveringFacts([exam]);
  assert.ok(covering.some((f) => f.resourceId === review && f.basis === "title" && f.quote === "Midterm"));
  assert.ok(covering.some((f) => f.resourceId === practice && f.basis === "structure"));
  const refs = references(store, exam);
  const byId = new Map(refs.map((r) => [r.resourceId, r]));
  assert.equal(byId.get(review)?.strength, "covers");
  assert.equal(byId.get(review)?.weight, strengthWeight.covers);
  assert.ok(strengthWeight.covers > STRUCTURE_COVERS_WEIGHT);
  // The practice page's structural covers is the same fact as its module membership: listed once, as module.
  assert.equal(byId.get(practice)?.strength, "module");
  assert.equal(refs.at(-1)?.strength, "covers");
  store.close();
});

test("the analytics port: references and assessmentsFor agree exactly; unknown IDs answer empty", async () => {
  const store = seededStore();
  await compileCourse(store, course, NOW);
  const port = createPipelineReferences(store);
  const hw1 = idOf(store, "assignments", "1001");
  assert.deepEqual(port.assignment(hw1), { id: hw1, title: "Homework 1", courseId: course.courseId });
  assert.equal(port.assignment("missing"), null);
  assert.deepEqual(port.references("missing"), []);
  const links = port.references(hw1);
  assert.ok(links.some((l) => l.title === "Matrix notes" && /^Linked in the body/.test(l.reason)));
  assert.ok(links.every((l) => store.resource(l.resourceId)?.courseId === course.courseId));
  assert.ok(links.every((l) => /[.!?"]$/.test(l.reason)));
  // Exam dates come from analytics' own adapter.
  assert.ok(port.examDates(course.courseId).some((e) => e.title === "Midterm Exam" && e.kind === "midterm"));
  // Inverse: a material lists a subject iff the subject's references list the material.
  const subjects = [...new Set(store.resources().filter((r) => r.sourceId === "src-assignments").map((r) => r.id))];
  for (const material of store.resources()) {
    const listed = new Set(port.assessmentsFor(material.id).map((a) => a.assessmentId));
    for (const s of subjects)
      assert.equal(listed.has(s), port.references(s).some((l) => l.resourceId === material.id), `${material.title} / ${s}`);
  }
  store.close();
});

test("graph queries are validated at the IPC boundary", () => {
  assert.equal(graphQuerySchema.safeParse({ type: "agenda", date: "2026-10-01", tz: "America/Chicago" }).success, true);
  assert.equal(graphQuerySchema.safeParse({ type: "agenda", date: "2026-10-01", tz: "Not/AZone" }).success, false);
  assert.equal(graphQuerySchema.safeParse({ type: "references", assignmentId: "a", extra: 1 }).success, false);
  assert.equal(graphQuerySchema.safeParse({ type: "courseGraph", accountScope: "s", courseId: "" }).success, false);
});

test("external refs read access state from sync's course spaces; file links use sync's parser", async () => {
  const store = seededStore();
  await compileCourse(store, course, NOW);
  const hw1 = idOf(store, "assignments", "1001");
  const article = () => store.externalRefs(course).find((e) => e.url === "https://example.org/article")!;
  assert.equal(article().accessState, null, "no space recorded yet");
  store.putCourseSpace({
    id: "space:1", sourceId: "src-assignments", kind: "course_site", host: "example.org", url: "https://example.org/article/",
    title: "Article space", foundInResourceId: hw1, route: "public", readState: "found", readSourceId: null, lastReadAt: null,
    recipeId: null, accessState: "link-only", accessReason: null, checkedAt: NOW, storeOrLink: "link",
  });
  assert.deepEqual([article().spaceId, article().accessState], ["space:1", "link-only"]);
  // A link to another course's file is not this course's file, even when the ID matches a stored one.
  const index = courseIndex(store, course);
  assert.equal(index.resolve("https://canvas.wisc.edu/courses/101/files/5002/preview").type, "resource");
  assert.equal(index.resolve("https://canvas.wisc.edu/files/5002/download").type, "resource");
  assert.equal(index.resolve("https://canvas.wisc.edu/courses/999/files/5002").type, "unresolved");
  store.close();
});
