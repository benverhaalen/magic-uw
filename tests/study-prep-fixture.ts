// owner: study-prep. A synthetic signals course with maths content for the Study prepper tests (not
// a test file itself). Every text is invented for the fixture: a syllabus stating Midterm 2's
// scope and room, lectures on complex exponentials (Module 1, out of scope), the DTFT (Module 3)
// and sampling (Module 4), a practice midterm with solutions, a past-due homework in the window,
// an open homework, and the two midterms. No real course, student or account data.
import assert from "node:assert/strict";
import { textHash } from "@magic/retrieval";
import { createStore } from "../packages/storage/src/index";
import type { CaptureBatch, ResourceInput } from "@magic/contracts";
import type { Concept } from "../packages/learning/src/store";

export const NOW = new Date("2026-10-05T15:00:00.000Z");
export const COURSE = { courseId: "SIG203", courseName: "SIG 203 Synthetic Signals and Computation" };

export const TEXTS = {
  syllabus: [
    "SIG 203 Synthetic Signals and Computation: Syllabus",
    "Grading: Homework 30%, Midterm 1 20%, Midterm 2 20%, Final 30%.",
    "Midterm 2 is a 90-minute exam with multiple choice and short answer problems.",
    "Midterm 2 covers Modules 3 and 4.",
    "Midterm 2 is held in Room 1100 Synthetic Hall.",
  ].join("\n"),
  euler: [
    "Module 1: Complex Exponentials",
    "Euler's formula states that e^(j*theta) = cos(theta) + j*sin(theta).",
    "A complex exponential has magnitude one on the unit circle.",
  ].join("\n"),
  dtft: [
    "Module 3: The Discrete-Time Fourier Transform",
    "The DTFT of a sequence x[n] is X(e^(jw)) = sum over all n of x[n] e^(-jwn).",
    "The DTFT is periodic in w with period 2*pi.",
    "The frequency response of an LTI system is the DTFT of its impulse response h[n].",
  ].join("\n"),
  sampling: [
    "Module 4: Sampling",
    "A signal band-limited to B Hz can be recovered from its samples when the sampling rate fs is greater than 2B.",
    "Sampling below the Nyquist rate causes aliasing: high frequencies appear as low ones.",
    "A 3 kHz tone sampled at 8 kHz has a sampling period of 1/8000 s, which is 0.000125 s.",
  ].join("\n"),
  practice: [
    "Midterm 2 Practice Exam",
    "Time: 90 minutes. Total: 20 points.",
    "1. (10 points) Compute the DTFT of x[n] = delta[n - 2].",
    "2. (10 points) What is the Nyquist rate of a signal band-limited to 4 kHz?",
  ].join("\n"),
  solutions: [
    "Midterm 2 Practice Exam Solutions",
    "1. X(e^(jw)) = e^(-2jw)",
    "2. The Nyquist rate is 2B = 8 kHz.",
  ].join("\n"),
  hw5: "Homework 5: Find the DTFT of x[n] = (0.5)^n u[n] and sketch its magnitude. The lab kit costs $5 at the store.",
  hw6: "Homework 6: Sample a 1 kHz tone at 1.5 kHz and describe the aliasing you observe.",
  midterm1: "Midterm 1 is taken in class.",
  midterm2: "Midterm 2 is taken in class. Bring a calculator.",
} as const;

const material = (externalId: string, title: string, text: string, extra: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId,
  kind: "material",
  ...COURSE,
  title,
  url: `https://canvas.example.test/courses/203/files/${externalId}`,
  text,
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "coaching", evidence: "Synthetic: AI help is allowed for practice." },
  ...extra,
});
const assignment = (externalId: string, title: string, text: string, dueAt: string, extra: Partial<ResourceInput> = {}): ResourceInput =>
  material(externalId, title, text, {
    kind: "assignment",
    url: `https://canvas.example.test/courses/203/assignments/${externalId}`,
    dueAt,
    deadlines: [{ kind: "due", value: dueAt, quote: `Due ${dueAt}`, authority: "structured", scopeConfirmed: true }],
    points: 10,
    ...extra,
  });

export const materialsBatch = (over: Partial<Record<keyof typeof TEXTS, string>> = {}, observedAt = NOW.toISOString()): CaptureBatch => ({
  source: { id: "sig-materials", kind: "canvas", accountScope: "acct", courseId: COURSE.courseId, scope: "materials", label: "Synthetic" },
  observedAt,
  complete: true,
  status: "ok",
  resources: [
    material("syllabus", "Syllabus", over.syllabus ?? TEXTS.syllabus),
    material("euler", "Lecture 1: Complex Exponentials", over.euler ?? TEXTS.euler),
    material("dtft", "Lecture 7: The DTFT", over.dtft ?? TEXTS.dtft),
    material("sampling", "Lecture 9: Sampling", over.sampling ?? TEXTS.sampling),
    material("practice", "Midterm 2 Practice Exam", over.practice ?? TEXTS.practice),
    material("solutions", "Midterm 2 Practice Exam Solutions", over.solutions ?? TEXTS.solutions),
  ],
});
const assignmentsBatch = (): CaptureBatch => ({
  source: { id: "sig-assignments", kind: "canvas", accountScope: "acct", courseId: COURSE.courseId, scope: "assignments", label: "Synthetic" },
  observedAt: NOW.toISOString(),
  complete: true,
  status: "ok",
  resources: [
    assignment("hw5", "Homework 5", TEXTS.hw5, "2026-10-01T05:00:00.000Z"),
    assignment("hw6", "Homework 6", TEXTS.hw6, "2026-10-10T05:00:00.000Z"),
    assignment("midterm1", "Midterm 1", TEXTS.midterm1, "2026-09-24T19:00:00.000Z"),
    assignment("midterm2", "Midterm 2", TEXTS.midterm2, "2026-10-15T19:00:00.000Z"),
  ],
});

export const LABELS = {
  m1: "Module 1: Complex Exponentials",
  m3: "Module 3: The Discrete-Time Fourier Transform",
  m4: "Module 4: Sampling",
  euler: "Euler's formula",
  dtft: "DTFT",
  response: "Frequency response",
  nyquist: "Sampling theorem",
  aliasing: "Aliasing",
};

export type SignalsStore = ReturnType<typeof createStore>;
export interface SignalsFixture {
  store: SignalsStore;
  ref: string;
  ids: Record<string, string>;
  topics: Record<string, string>;
}

/** The synthetic course in a SQL workspace store: resources, the course map, the midterms and facts. */
export function signalsFixture(store: SignalsStore = createStore(":memory:")): SignalsFixture {
  store.ingest(materialsBatch());
  store.ingest(assignmentsBatch());
  const ids: Record<string, string> = {};
  for (const r of store.resources()) ids[r.externalId] = r.id;
  const byExt = (e: string) => store.resources().find((r) => r.externalId === e)!;
  const at = NOW.toISOString();
  store.putAssessment({ id: "a-mid1", sourceId: "sig-materials", resourceId: ids.midterm1!, kind: "midterm", title: "Midterm 1", date: "2026-09-24", weight: 20, format: null, origin: "syllabus" }, at);
  store.putAssessment({ id: "a-mid2", sourceId: "sig-materials", resourceId: ids.midterm2!, kind: "midterm", title: "Midterm 2", date: "2026-10-15", weight: 20, format: null, origin: "syllabus" }, at);
  const syllabus = byExt("syllabus");
  const quote = "Midterm 2 covers Modules 3 and 4.";
  const scope = store.putAssessmentScope(
    { id: "scope-mid2", assessmentId: "a-mid2", stated: quote, evidence: { resourceId: syllabus.id, version: syllabus.version, quote }, windowStart: null, windowEnd: null, status: "settled", rung: "code" },
    at,
  );
  assert.equal(scope.ok, true, JSON.stringify(scope));
  const fact = (ext: string, kind: "term" | "formula" | "definition", value: string) => {
    const r = byExt(ext);
    const start = r.text.indexOf(value);
    assert.ok(start >= 0, `${value} in ${ext}`);
    return { kind, value, basis: "text" as const, start, end: start + value.length };
  };
  for (const [ext, list] of Object.entries({
    dtft: [fact("dtft", "formula", "X(e^(jw)) = sum over all n of x[n] e^(-jwn)"), fact("dtft", "term", "frequency response")],
    sampling: [fact("sampling", "term", "Nyquist rate"), fact("sampling", "term", "aliasing")],
  })) {
    const r = byExt(ext);
    const put = store.putMaterialFacts({ resourceId: r.id, textHash: textHash(r.title, r.text), analyzerVersion: "fixture.v1", facts: list });
    assert.equal(put.ok, true, JSON.stringify(put));
  }

  const learning = store.learning;
  const ref = learning.course("acct", COURSE.courseId, COURSE.courseName).id;
  const source = (ext: string, q: string) => {
    const r = byExt(ext);
    const start = r.text.indexOf(q);
    return { resourceId: r.id, contentHash: r.contentHash, start, end: start + q.length, quote: q, quoteValid: true };
  };
  const c = (id: string, label: string, kind: Concept["kind"], parentId: string | null, position: number, sources: Concept["sources"] = []): Concept => ({
    id, courseRef: ref, parentId, label, kind, position, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "sig-fixture", sources,
  });
  learning.putConceptMap(
    ref,
    [
      c("u1", LABELS.m1, "unit", null, 0),
      c("u3", LABELS.m3, "unit", null, 1),
      c("u4", LABELS.m4, "unit", null, 2),
      c("t-euler", LABELS.euler, "concept", "u1", 0, [source("euler", "Euler's formula states that")]),
      c("t-dtft", LABELS.dtft, "concept", "u3", 1, [source("dtft", "The DTFT of a sequence x[n]")]),
      c("t-response", LABELS.response, "concept", "u3", 2, [source("dtft", "The frequency response of an LTI system")]),
      c("t-nyquist", LABELS.nyquist, "concept", "u4", 3, [source("sampling", "can be recovered from its samples")]),
      c("t-aliasing", LABELS.aliasing, "concept", "u4", 4, [source("sampling", "Sampling below the Nyquist rate causes aliasing")]),
    ],
    "sig-fixture",
  );
  return { store, ref, ids, topics: { euler: "t-euler", dtft: "t-dtft", response: "t-response", nyquist: "t-nyquist", aliasing: "t-aliasing" } };
}

/** One synthetic item of every type, with the Canvas signals code types it by, and its links. */
export const CATALOGUE = {
  ps4: { title: "Problem Set 4", text: "Problem Set 4: Using the DTFT definition, find X(e^(jw)) for x[n] = delta[n] + delta[n - 1]. Then sample a 2 kHz tone at 5 kHz and find the sampling period. Upload a PDF.", due: "2026-10-12T05:00:00.000Z", subs: ["online_upload"], expect: "problem_set" },
  essay: { title: "Reflection Essay: Signals in Everyday Life", text: "Write a 1000-word reflection on where sampling appears in daily life. Draw on Chapter 2 of the reading. Use IEEE citation style for every source.", due: "2026-10-20T05:00:00.000Z", subs: ["online_upload"], expect: "essay" },
  lab: { title: "Lab 3: Sampling with the Oscilloscope", text: "Procedure: connect the function generator to channel 1 and sample the tone at three rates.\nWear safety goggles and keep liquids away from the equipment.\nRecord the aliased frequency you observe at each rate.", due: "2026-10-09T05:00:00.000Z", subs: ["online_upload"], expect: "lab" },
  proposal: { title: "Final Project Proposal", text: "Propose a signal-processing project with a team of three. Name your dataset and your method.", due: "2026-10-18T05:00:00.000Z", subs: ["online_upload"], expect: "project" },
  milestone: { title: "Final Project Milestone 1", text: "Show a working prototype of your pipeline.", due: "2026-11-05T05:00:00.000Z", subs: ["online_upload"], expect: "project" },
  discussion: { title: "Discussion: Aliasing in Film", text: "After the Chapter 2 reading, post one example of aliasing you have seen on screen and reply to two classmates.", due: "2026-10-11T05:00:00.000Z", subs: ["discussion_topic"], expect: "discussion_post" },
  talk: { title: "Presentation: Sampling Demo", text: "Give a five-minute talk demonstrating the sampling theorem.", due: "2026-10-22T05:00:00.000Z", subs: ["on_paper"], expect: "presentation" },
  attendance: { title: "Attendance Week 6", text: "In-class attendance.", due: "2026-10-08T05:00:00.000Z", subs: ["none"], points: 0, expect: "participation" },
  quiz3: { title: "Quiz 3", text: "Quiz 3 covers aliasing and the Nyquist rate. 20 minutes, taken on Canvas.", due: "2026-10-08T17:00:00.000Z", subs: ["online_quiz"], expect: "quiz" },
} as const;
export const READING = { title: "Reading: Chapter 2 Signals", text: "Chapter 2 introduces continuous and discrete signals.\nA discrete-time signal is a sequence x[n] defined for integer n.\nSampling a continuous signal every Ts seconds gives x[n] = x(nTs)." };

export function addCatalogue(f: SignalsFixture): Record<keyof typeof CATALOGUE | "reading", string> {
  const { store } = f;
  const rubric = [
    { description: "Thesis", longDescription: "A clear claim about where sampling appears.", points: 4, ratings: [{ description: "Clear", points: 4 }, { description: "Vague", points: 2 }] },
    { description: "Evidence", longDescription: "Uses the Chapter 2 reading with IEEE citations.", points: 6, ratings: [] },
  ];
  store.ingest({
    source: { id: "sig-catalogue", kind: "canvas", accountScope: "acct", courseId: COURSE.courseId, scope: "assignments-2", label: "Synthetic" },
    observedAt: NOW.toISOString(),
    complete: true,
    status: "ok",
    resources: Object.entries(CATALOGUE).map(([id, c]) =>
      assignment(id, c.title, c.text, c.due, {
        submissionTypes: [...c.subs],
        ...("points" in c ? { points: c.points } : {}),
        ...(id === "essay" || id === "talk" ? { rubric } : {}),
        ...(id === "proposal" || id === "milestone" ? { assignmentGroupId: "g-project" } : {}),
      }),
    ),
  });
  store.ingest({
    source: { id: "sig-readings", kind: "canvas", accountScope: "acct", courseId: COURSE.courseId, scope: "readings", label: "Synthetic" },
    observedAt: NOW.toISOString(),
    complete: true,
    status: "ok",
    resources: [material("reading", READING.title, READING.text)],
  });
  const ids = Object.fromEntries(store.resources().filter((r) => r.externalId in CATALOGUE || r.externalId === "reading").map((r) => [r.externalId, r.id])) as Record<keyof typeof CATALOGUE | "reading", string>;
  const link = (from: string, to: string[]) => {
    const r = store.resource(from)!;
    const put = store.putResourceRefs(from, r.contentHash, to.map((t) => ({ toResourceId: t, externalRefId: null, target: store.resource(t)!.title, kind: "file" as const, strength: "named" as const, reason: "Named in the instructions" })));
    assert.equal(put.ok, true, JSON.stringify(put));
  };
  link(ids.ps4, [f.ids.dtft!, f.ids.sampling!]);
  link(ids.essay, [ids.reading]);
  link(ids.lab, [f.ids.sampling!]);
  link(ids.discussion, [ids.reading]);
  link(ids.talk, [f.ids.sampling!]);
  link(ids.proposal, [f.ids.dtft!]);
  return ids;
}

/** The one passage of a fixture resource (each text is short enough to be one passage). */
export function passageId(store: SignalsStore, resourceId: string): string {
  const list = store.passages(resourceId);
  assert.ok(list.length >= 1, `passages for ${resourceId}`);
  return `p${list[0]!.pid}`;
}
