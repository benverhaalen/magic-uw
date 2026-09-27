// Synthetic workspace for the intent router tests: five courses (one from an older term), their
// assignments and materials, and a concept map for COMPSCI 400. No real course data.
import { createStore } from "@magic/storage";
import { defaultPrivacy, type CaptureBatch, type ResourceInput } from "@magic/contracts";
import { conceptId } from "../packages/learning/src/concepts";
import type { Concept } from "../packages/learning/src/store";

// Monday 2026-09-28, 10:00 in Chicago.
export const NOW = new Date("2026-09-28T15:00:00.000Z");
export const TZ = "America/Chicago";
const ACCT = "acct";

const res = (courseId: string, courseName: string, id: string, kind: ResourceInput["kind"], extra: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId: id,
  kind,
  courseId,
  courseName,
  title: id,
  text: "",
  url: `https://canvas.example.test/courses/${courseId}/${id}`,
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "coaching", evidence: "Synthetic: AI help is allowed for practice." },
  ...extra,
});
const due = (iso: string) => [{ value: iso, kind: "due" as const, quote: "", authority: "structured" as const, scopeConfirmed: true }];
const batch = (courseId: string, label: string, resources: ResourceInput[]): CaptureBatch => ({
  source: { id: `canvas-${courseId}`, kind: "canvas", accountScope: ACCT, courseId, scope: "course", label },
  observedAt: "2026-09-28T12:00:00.000Z",
  complete: true,
  status: "ok",
  resources,
});
const CS = "COMPSCI400: Programming III (001) FA26";
const ECON = "ECON101: Principles of Microeconomics (002) FA26";
const PHIL = "PHILOS101: Introduction to Philosophy (004) FA26";
const MATH = "MATH234: Calculus--Functions of Several Variables (002) FA26";
const OLDMATH = "MATH221: Calculus and Analytic Geometry 1 (005) FA24";
export const LATE = "Late work loses 10% per day, up to three days. After three days late, work is not accepted.";

export function workspace() {
  const store = createStore(":memory:");
  const batches = [
    batch("c400", CS, [
      res("c400", CS, "Programming III", "course"),
      res("c400", CS, "Homework 3", "assignment", { deadlines: due("2026-09-30T04:59:00.000Z") }),
      res("c400", CS, "Homework 4", "assignment", { deadlines: due("2026-10-07T04:59:00.000Z") }),
      res("c400", CS, "Syllabus", "material", { text: `Course policies. ${LATE} Exams are closed book.` }),
      res("c400", CS, "Recursion notes", "material", { text: "Recursion solves a problem by solving smaller instances of the same problem. Every recursive method needs a base case." }),
    ]),
    batch("c101", ECON, [
      res("c101", ECON, "Principles of Microeconomics", "course"),
      res("c101", ECON, "Problem Set 2", "assignment", { deadlines: due("2026-09-29T22:00:00.000Z") }),
      res("c101", ECON, "Supply and demand", "material", { text: "Demand curves slope downward because consumers buy more at lower prices." }),
    ]),
    batch("c102", PHIL, [
      res("c102", PHIL, "Introduction to Philosophy", "course"),
      res("c102", PHIL, "Essay 1", "assignment", { deadlines: due("2026-10-02T04:59:00.000Z") }),
      res("c102", PHIL, "Utilitarianism reading", "material", { text: "Utilitarianism holds that the right action is the one that produces the greatest happiness." }),
    ]),
    batch("c234", MATH, [res("c234", MATH, "Calculus--Functions of Several Variables", "course"), res("c234", MATH, "Quiz 1", "assignment", { deadlines: due("2026-10-01T04:59:00.000Z") })]),
    batch("c221", OLDMATH, [res("c221", OLDMATH, "Calculus and Analytic Geometry 1", "course")]),
  ];
  for (const b of batches) store.ingest(b);
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  const ref = `${ACCT}:c400`;
  store.learning.course(ACCT, "c400", "Programming III");
  const concept = (kind: "unit" | "concept", label: string, parentId: string | null, position: number): Concept => ({
    id: conceptId(ref, kind, label),
    courseRef: ref,
    parentId,
    label,
    kind,
    position,
    origin: "code",
    status: "active",
    mergedInto: null,
    studentLabel: null,
    mapVersion: "test",
    sources: [],
  });
  const unit = concept("unit", "Recursion and trees", null, 0);
  store.learning.putConceptMap(ref, [unit, concept("concept", "Recursion", unit.id, 1), concept("concept", "Binary search trees", unit.id, 2), concept("concept", "Hash tables", unit.id, 3)], "test");
  return { store, batches, ref };
}

