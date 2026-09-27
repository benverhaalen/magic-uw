/**
 * The synthetic semester for `pnpm semester`: three current courses, one week in. COMPSCI 400 has a
 * hashing lecture (notes and slides), a syllabus with the exam and the grading scheme, graded work,
 * an announcement and a TA email. A second capture on the morning of NOW moves a deadline and posts
 * the announcement, so "what changed since yesterday" has a code-checkable answer. No real data.
 */
import { createStore } from "@magic/storage";
import { defaultPrivacy, OUTLOOK_MAIL_COURSE_ID, type CaptureBatch, type ResourceInput } from "@magic/contracts";
import { conceptId } from "../../packages/learning/src/concepts";
import type { Concept } from "../../packages/learning/src/store";

// Monday 2026-09-28, 10:00 in Chicago.
export const NOW = new Date("2026-09-28T15:00:00.000Z");
export const TZ = "America/Chicago";
export const ACCT = "acct";
const BASE_AT = "2026-09-25T12:00:00.000Z";
/** The morning capture: after "yesterday" (2026-09-27 in Chicago) began. */
export const DELTA_AT = "2026-09-28T13:00:00.000Z";
export const SINCE_YESTERDAY = "2026-09-27T05:00:00.000Z"; // 2026-09-27 00:00 in Chicago

export const CS = "COMPSCI400: Programming III (001) FA26";
const ECON = "ECON101: Principles of Microeconomics (002) FA26";
const PHIL = "PHILOS101: Introduction to Philosophy (004) FA26";

/** Twenty-two distinct sentences: the explain, quiz and flashcard source. */
export const HASHING = [
  "A hash table stores key-value pairs in an array of buckets.",
  "A hash function maps each key to a bucket index.",
  "A good hash function spreads keys uniformly across the buckets.",
  "A collision happens when two keys map to the same bucket.",
  "Chaining resolves collisions by keeping a linked list in each bucket.",
  "Open addressing resolves collisions by probing for another empty slot.",
  "Linear probing checks the next slot, then the one after, until it finds an empty slot.",
  "Quadratic probing checks slots at squared offsets from the home bucket.",
  "Double hashing uses a second hash function to choose the probe step.",
  "The load factor is the number of stored keys divided by the number of buckets.",
  "With chaining, the expected cost of a lookup grows with the load factor.",
  "Java's HashMap resizes when the load factor exceeds 0.75.",
  "Resizing allocates a larger array and rehashes every stored key.",
  "Rehashing costs linear time, but amortized over many inserts it keeps insertion constant on average.",
  "Primary clustering is the tendency of linear probing to form long runs of occupied slots.",
  "Deleting from an open-addressing table leaves a tombstone so later probes keep going.",
  "The worst case for a hash table lookup is linear time, when every key lands in one bucket.",
  "Objects that are equal must return the same hashCode.",
  "Overriding equals without overriding hashCode breaks lookups in a HashMap.",
  "A hash set is a hash table that stores keys without values.",
  "Hash tables do not keep their keys in sorted order.",
  "A binary search tree is the better choice when you need keys in sorted order.",
];
export const LECTURE_NOTES = `Lecture 5: Hashing. ${HASHING.join(" ")}`;
export const SLIDES = "Lecture 5 slides: Hashing. Slide 1: Hash tables and hash functions. Slide 2: Collisions, chaining and open addressing. Slide 3: Load factor and resizing.";
export const EXAM_SENTENCE = "The midterm exam is on Thursday, October 15, 2026, from 7:15 to 9:15 PM in Room 1240 Computer Sciences.";
export const EXAM_COVERS = "The midterm covers lectures 1 through 6: recursion, binary search trees and hashing.";
export const GRADING = "Grading: homework 30%, midterm exam 30%, final exam 40%. Letter grades: A 93 and above, AB 88, B 83, BC 78, C 70, D 60.";
export const LATE = "Late work loses 10% per day, up to three days. After three days late, work is not accepted.";
export const ANNOUNCEMENT = "Homework 4 is now due Friday, October 9 at 11:59 PM instead of Wednesday, October 7. The autograder had a bug in the tests for part 2, which is now fixed. Office hours this week move to Room 1207.";
export const TA_EMAIL = { subject: "Regrade request for Homework 2", preview: "Hi, I looked at your regrade request for Homework 2 question 3. You get the 4 points back; your updated score is 46/50.", from: "Jordan Lee (TA)" };

// The student's graded work (Canvas submission scores); the expectation is computed from these.
export const SCORES = { homework: [{ title: "Homework 1", score: 47, points: 50 }, { title: "Homework 2", score: 46, points: 50 }], midterm: null as number | null, quizAvg: null };
export const WEIGHTS = { homework: 30, midterm: 30, final: 40 };
/** The midterm has not happened yet; its score comes from the question ("if I get 80 on the midterm"). */
export const ASSUMED_MIDTERM = 80;
export const B_CUTOFF = 83;

const res = (courseId: string, courseName: string, id: string, kind: ResourceInput["kind"], extra: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId: id,
  kind,
  courseId,
  courseName,
  title: id,
  text: "",
  url: `https://canvas.example.test/courses/${courseId}/${encodeURIComponent(id)}`,
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "coaching", evidence: "Synthetic: AI help is allowed for practice." },
  ...extra,
});
const due = (iso: string) => [{ value: iso, kind: "due" as const, quote: "", authority: "structured" as const, scopeConfirmed: true }];
const batch = (sourceId: string, courseId: string, scope: string, observedAt: string, resources: ResourceInput[]): CaptureBatch => ({
  source: { id: sourceId, kind: "canvas", accountScope: ACCT, courseId, scope, label: courseId },
  observedAt,
  complete: true,
  status: "ok",
  resources,
});

const HW3_DUE = "2026-09-30T04:59:00.000Z";
const HW4_DUE = "2026-10-08T04:59:00.000Z";
export const HW4_MOVED = "2026-10-10T04:59:00.000Z";
const graded = (title: string, score: number, dueAt: string): ResourceInput =>
  res("c400", CS, title, "assignment", { dueAt, deadlines: due(dueAt), points: 50, submitted: true, assignmentGroup: { weight: WEIGHTS.homework }, submission: { workflowState: "graded", score } });

function cs400Assignments(hw4Due: string): ResourceInput[] {
  return [
    res("c400", CS, "Programming III", "course"),
    graded("Homework 1", 47, "2026-09-16T04:59:00.000Z"),
    graded("Homework 2", 46, "2026-09-23T04:59:00.000Z"),
    res("c400", CS, "Homework 3", "assignment", { dueAt: HW3_DUE, deadlines: due(HW3_DUE), points: 50, assignmentGroup: { weight: WEIGHTS.homework } }),
    res("c400", CS, "Homework 4", "assignment", { dueAt: hw4Due, deadlines: due(hw4Due), points: 50, assignmentGroup: { weight: WEIGHTS.homework } }),
    res("c400", CS, "Midterm exam", "assignment", { dueAt: "2026-10-16T02:15:00.000Z", deadlines: due("2026-10-16T02:15:00.000Z"), points: 100, assignmentGroup: { weight: WEIGHTS.midterm } }),
    res("c400", CS, "Final exam", "assignment", { dueAt: "2026-12-15T21:00:00.000Z", deadlines: due("2026-12-15T21:00:00.000Z"), points: 100, assignmentGroup: { weight: WEIGHTS.final } }),
  ];
}
const cs400Files = (): ResourceInput[] => [
  res("c400", CS, "Syllabus", "material", { text: `Course policies. ${LATE} Exams are closed book. ${EXAM_SENTENCE} ${EXAM_COVERS} ${GRADING}` }),
  res("c400", CS, "Lecture 5 notes: Hashing", "material", { text: LECTURE_NOTES }),
  res("c400", CS, "Lecture 5 slides: Hashing", "material", { text: SLIDES }),
  res("c400", CS, "Recursion notes", "material", { text: "Recursion solves a problem by solving smaller instances of the same problem. Every recursive method needs a base case." }),
];
const announcement = (): ResourceInput =>
  res("c400", CS, "Homework 4 deadline moved", "message", { text: ANNOUNCEMENT, createdAt: DELTA_AT, updatedAt: DELTA_AT });

function mailBatch(): CaptureBatch {
  const email = (id: string, subject: string, preview: string, fromName: string, receivedAt: string, category: "course" | "general" | "org") => ({
    externalId: `mail:${id}`,
    kind: "message" as const,
    courseId: OUTLOOK_MAIL_COURSE_ID,
    courseName: "Outlook mail",
    title: subject,
    url: `https://outlook.office.com/mail/inbox/id/${id}`,
    text: preview,
    createdAt: receivedAt,
    updatedAt: receivedAt,
    deadlines: [],
    points: null,
    submitted: null,
    policy: { mode: "unknown" as const, evidence: "" },
    mail: { messageId: `msg-${id}`, folder: "Inbox", fromName, fromAddress: `${id}@example.edu`, receivedAt, preview, category, categoryReason: `Synthetic ${category}`, courseId: category === "course" ? "c400" : undefined, isRead: false },
  });
  return {
    source: { id: "mail:outlook:acct:inbox", kind: "mail", accountScope: ACCT, courseId: OUTLOOK_MAIL_COURSE_ID, scope: "inbox", label: "Outlook mail" },
    observedAt: BASE_AT,
    complete: true,
    status: "ok",
    resources: [
      email("ta-regrade", TA_EMAIL.subject, TA_EMAIL.preview, TA_EMAIL.from, "2026-09-26T18:00:00.000Z", "course"),
      email("ta-oh", "Office hours moved this week", "Office hours on Wednesday move to Room 1207 this week only.", TA_EMAIL.from, "2026-09-27T16:00:00.000Z", "course"),
      email("club", "Badger Herald weekly", "This week's issue is out.", "Badger Herald", "2026-09-27T12:00:00.000Z", "org"),
    ].map((r) => (r.mail.courseId ? r : { ...r, mail: Object.fromEntries(Object.entries(r.mail).filter(([k]) => k !== "courseId")) })) as ResourceInput[],
  };
}

/** Every batch a student's first sync would hold, in ingest order (the delta is separate). */
export function baseBatches(): CaptureBatch[] {
  return [
    batch("canvas-c400", "c400", "course", BASE_AT, cs400Assignments(HW4_DUE)),
    batch("canvas-c400-files", "c400", "files", BASE_AT, cs400Files()),
    batch("canvas-c400-announcements", "c400", "announcements", BASE_AT, []),
    batch("canvas-c101", "c101", "course", BASE_AT, [
      res("c101", ECON, "Principles of Microeconomics", "course"),
      res("c101", ECON, "Problem Set 2", "assignment", { dueAt: "2026-09-29T22:00:00.000Z", deadlines: due("2026-09-29T22:00:00.000Z") }),
      res("c101", ECON, "Supply and demand", "material", { text: "Demand curves slope downward because consumers buy more at lower prices." }),
    ]),
    batch("canvas-c102", "c102", "course", BASE_AT, [
      res("c102", PHIL, "Introduction to Philosophy", "course"),
      res("c102", PHIL, "Essay 1", "assignment", { dueAt: "2026-10-02T04:59:00.000Z", deadlines: due("2026-10-02T04:59:00.000Z") }),
      res("c102", PHIL, "Utilitarianism reading", "material", { text: "Utilitarianism holds that the right action is the one that produces the greatest happiness." }),
    ]),
    mailBatch(),
  ];
}
/** This morning's capture: Homework 4 moved, and the announcement saying so. */
export function deltaBatches(): CaptureBatch[] {
  return [
    batch("canvas-c400", "c400", "course", DELTA_AT, cs400Assignments(HW4_MOVED)),
    batch("canvas-c400-announcements", "c400", "announcements", DELTA_AT, [announcement()]),
  ];
}

export function semesterWorkspace(path = ":memory:") {
  const store = createStore(path);
  const base = baseBatches();
  for (const b of base) store.ingest(b);
  for (const b of deltaBatches()) store.ingest(b);
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  // Homework 3 points at the hashing lecture. In the app the material pipeline finds this link; the
  // harness doesn't run the pipeline, so it stores the accepted link the pipeline would. Practice
  // draws only on materials linked to the course's assignments (the study context).
  const find = (title: string) => store.resources().find((r) => r.title === title)!;
  const notes = find("Lecture 5 notes: Hashing");
  store.putLink({ id: "semester-hw3-lecture5", fromId: notes.id, toId: find("Homework 3").id, type: "specifies", reason: "Synthetic: Homework 3 practises the Lecture 5 hashing material", status: "accepted", inputHash: notes.contentHash });
  const ref = `${ACCT}:c400`;
  store.learning.course(ACCT, "c400", "Programming III");
  const concept = (kind: "unit" | "concept", label: string, parentId: string | null, position: number): Concept => ({
    id: conceptId(ref, kind, label), courseRef: ref, parentId, label, kind, position, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "semester", sources: [],
  });
  const unit = concept("unit", "Recursion, trees and hashing", null, 0);
  store.learning.putConceptMap(ref, [unit, concept("concept", "Recursion", unit.id, 1), concept("concept", "Binary search trees", unit.id, 2), concept("concept", "Hash tables", unit.id, 3)], "semester");
  return { store, fixture: base[0]!, ref, hashTables: conceptId(ref, "concept", "Hash tables") };
}

// ── Expectations, computed by code from the constants above ──────────────────────────────────
/** Assignments due 2026-09-28..2026-10-04 in Chicago, after this morning's capture. */
export const EXPECT_DUE_THIS_WEEK = ["Problem Set 2", "Homework 3", "Essay 1"].sort();
/** The final-exam percentage for a B, assuming the midterm at ASSUMED_MIDTERM. */
export function expectedFinalForB(): number {
  const hw = SCORES.homework.reduce((s, h) => s + h.score, 0) / SCORES.homework.reduce((s, h) => s + h.points, 0);
  const have = hw * WEIGHTS.homework + (ASSUMED_MIDTERM / 100) * WEIGHTS.midterm;
  return Math.ceil(((B_CUTOFF - have) / WEIGHTS.final) * 100 * 10) / 10;
}
/**
 * The one numeric check both sides use for "what do I need on the final": some percentage in the
 * answer lies within ±1 point of the computed need. Same tolerance for ours and the baseline.
 */
export function percentNear(answer: string, need: number, tolerance = 1): boolean {
  return (answer.match(/\d{2,3}(?:\.\d+)?(?=\s*%)/g) ?? []).map(Number).some((n) => Math.abs(n - need) <= tolerance);
}
