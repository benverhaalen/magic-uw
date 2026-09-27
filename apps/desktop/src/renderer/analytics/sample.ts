// The synthetic sample course's analytics inputs ("Writing 101 · Sample"; fictional course, people and
// scores). Used only when the course is the built-in sample (a `fixture` source), never mixed with a
// real course's data. Dates are relative to `now`, like the sample fixture's rebased dates. The grade
// figures still go through the real grade bank (`courseGrades`), so the sample exercises the same math.
import type { LearningRequest, LearningResult } from "@magic/contracts";

/** The few fields the sample reads from a stored resource. */
type StoredRef = { id: string; courseId: string; externalId: string; deleted?: boolean; dueAt?: string | null };
import { courseGrades } from "../../../../../packages/learning/src/grades/index";
import type { CourseGradeInput, GradeGroup, GradeItem } from "../../../../../packages/learning/src/grades/types";
import type { CourseMasteryData, MasteryAssessment, MasteryTopic, NextStep, StateCounts } from "../../../../../packages/learning/src/mastery/types";
import type { FlashcardData, FlashcardSessionView } from "../../../../../packages/learning/src/router-types";
import type { ConceptStateName } from "../../../../../packages/learning/src/types";
import type { AnalyticsInputs } from "./model";

export const SAMPLE_SYLLABUS = [
  "Writing 101 · Sample syllabus (synthetic)",
  "Instructor: Prof. Ada Quill (fictional)",
  "Reading responses: 15%",
  "Grammar quizzes: 15%",
  "Essays: 35%",
  "Peer review: 10%",
  "Exams: 25%",
  "Letter grades",
  "A 93–100",
  "AB 88–92.9",
  "B 83–87.9",
  "BC 78–82.9",
  "C 70–77.9",
  "D 60–69.9",
  "F below 60",
].join("\n");

const GROUPS: GradeGroup[] = [
  { id: "g-rr", title: "Reading responses", weight: 15, position: 1, dropLowest: 0, dropHighest: 0, neverDrop: [] },
  { id: "g-gq", title: "Grammar quizzes", weight: 15, position: 2, dropLowest: 0, dropHighest: 0, neverDrop: [] },
  { id: "g-es", title: "Essays", weight: 35, position: 3, dropLowest: 0, dropHighest: 0, neverDrop: [] },
  { id: "g-pr", title: "Peer review", weight: 10, position: 4, dropLowest: 0, dropHighest: 0, neverDrop: [] },
  { id: "g-ex", title: "Exams", weight: 25, position: 5, dropLowest: 0, dropHighest: 0, neverDrop: [] },
];

/** [key, title, group, points, due offset in days, score | null, flags, sample-fixture externalId]. */
type Row = [string, string, string, number, number, number | null, ("late" | "missing")[], string?];
const ROWS: Row[] = [
  ["rr1", "Reading response 1", "g-rr", 10, -33, 10, []],
  ["gq1", "Grammar quiz 1", "g-gq", 10, -31, 9, []],
  ["rr2", "Reading response 2", "g-rr", 10, -26, 9, []],
  ["gq2", "Grammar quiz 2", "g-gq", 10, -24, 9, []],
  ["es1", "Essay 1: Personal narrative", "g-es", 100, -22, 91, []],
  ["pr1", "Peer review 1", "g-pr", 15, -20, 15, []],
  ["rr3", "Reading response 3", "g-rr", 10, -19, 8, []],
  ["gq3", "Grammar quiz 3", "g-gq", 10, -17, 7, ["late"]],
  ["rr4", "Reading response 4", "g-rr", 10, -12, 9, ["late"]],
  ["gq4", "Grammar quiz 4", "g-gq", 10, -10, 0, ["missing"]],
  ["es2", "Essay 2: Rhetorical analysis", "g-es", 100, -8, 82, ["late"]],
  ["pr2", "Peer review 2", "g-pr", 15, -6, 13, []],
  ["rr5", "Reading response 5", "g-rr", 10, -5, 8, []],
  ["rr6", "Reading response 6", "g-rr", 10, 1, null, []],
  ["mid", "Midterm exam", "g-ex", 100, 2, null, [], "midterm"],
  ["gq5", "Grammar quiz", "g-gq", 10, 4, null, [], "grammar-quiz"],
  ["prd", "Peer review draft", "g-pr", 15, 6, null, [], "peer-review"],
  ["es3", "Comparative analysis", "g-es", 30, 9, null, [], "essay-1"],
  ["rr7", "Reading response 7", "g-rr", 10, 8, null, []],
  ["fin", "Final exam", "g-ex", 100, 45, null, []],
];

const TOPICS: [string, string, string, ConceptStateName, { confirmed?: boolean; awaiting?: boolean; due?: boolean }][] = [
  ["t-thesis", "Thesis statements", "Workshop 1 · Claims", "solid", { confirmed: true }],
  ["t-counter", "Counterarguments", "Workshop 1 · Claims", "getting_there", {}],
  ["t-evidence", "Integrating evidence", "Workshop 2 · Evidence", "getting_there", { awaiting: true }],
  ["t-cite", "Quoting and citation", "Workshop 2 · Evidence", "solid", {}],
  ["t-comma", "Comma splices", "Workshop 3 · Style", "iffy", { due: true }],
  ["t-sva", "Subject–verb agreement", "Workshop 3 · Style", "iffy", { due: true }],
  ["t-cohesion", "Paragraph cohesion", "Workshop 3 · Style", "getting_there", { due: true }],
  ["t-frame", "Comparative frameworks", "Workshop 4 · Comparison", "not_seen", {}],
  ["t-ptbypt", "Point-by-point structure", "Workshop 4 · Comparison", "not_seen", {}],
];
const LABEL: Record<ConceptStateName, string> = { solid: "Mastered", getting_there: "Getting there", iffy: "Iffy", not_seen: "Not seen yet" };
const ITEM_TOPICS: Record<string, string[]> = {
  mid: ["t-thesis", "t-counter", "t-evidence", "t-cite", "t-cohesion"],
  gq5: ["t-comma", "t-sva"],
  prd: ["t-counter", "t-cohesion"],
  es3: ["t-frame", "t-ptbypt", "t-thesis", "t-evidence"],
  rr6: ["t-evidence", "t-cite"],
  rr7: ["t-counter"],
};
export const SAMPLE_CARDS_DUE: Record<string, number> = { "t-comma": 7, "t-sva": 5, "t-cohesion": 3, "t-counter": 2 };

const iso = (now: Date, days: number, hour = 17) => {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, 0, 0);
  return d.toISOString();
};

/** Sample item IDs: the sample fixture's own stored resource when it is loaded (so Prep opens it), else a synthetic ID. */
function stored(ext: string | undefined, resources: StoredRef[], courseId: string) {
  return ext ? resources.find((r) => r.courseId === courseId && r.externalId === ext && !r.deleted) : undefined;
}

export function sampleGradeInput(now: Date, resources: StoredRef[] = [], courseId = "sample-101"): { input: CourseGradeInput; ids: Record<string, string> } {
  const ids: Record<string, string> = {};
  const items: GradeItem[] = ROWS.map(([key, title, groupId, points, offset, score, flags, ext]) => {
    const hit = stored(ext, resources, courseId);
    const id = hit?.id ?? `sample-analytics:${key}`;
    ids[key] = id;
    // The loaded fixture's own due date wins, so Prep and the item page agree.
    const dueAt = hit?.dueAt && hit.dueAt >= now.toISOString() ? hit.dueAt : iso(now, offset);
    const late = flags.includes("late");
    const missing = flags.includes("missing");
    const submittedAt = score !== null && !missing ? iso(now, offset + (late ? 1 : 0), late ? 21 : 14) : null;
    return {
      id,
      externalId: `sample-${key}`,
      title,
      groupId,
      points,
      score,
      excused: false,
      missing,
      late,
      submitted: submittedAt !== null,
      dueAt,
      submittedAt,
      at: submittedAt ?? dueAt,
      examKind: /midterm/i.test(title) ? "midterm" : /final/i.test(title) ? "final" : /quiz/i.test(title) ? "quiz" : null,
    };
  });
  return {
    input: { accountScope: "synthetic", courseId, courseName: "Writing 101 · Sample", groups: GROUPS, items, syllabusWeights: [], coverage: { status: "complete", reasons: [] } },
    ids,
  };
}

function counts(ids: string[]): StateCounts {
  const c: StateCounts = { solid: 0, getting_there: 0, iffy: 0, not_seen: 0 };
  for (const id of ids) c[TOPICS.find((t) => t[0] === id)![3]]++;
  return c;
}

export function sampleMastery(now: Date, ids: Record<string, string>, courseId = "sample-101"): CourseMasteryData {
  const topics: MasteryTopic[] = TOPICS.map(([topicId, label, moduleLabel, state, o]) => ({
    topicId,
    label,
    moduleId: `m:${moduleLabel}`,
    moduleLabel,
    state: o.awaiting ? "getting_there" : state,
    stateLabel: LABEL[o.awaiting ? "getting_there" : state],
    confirmed: o.confirmed === true,
    awaitingLaterRecall: o.awaiting === true,
    dueForReview: o.due === true,
    lastEvidenceDay: state === "not_seen" ? null : iso(now, -2).slice(0, 10),
    evidenceCount: state === "not_seen" ? 0 : state === "iffy" ? 6 : 9,
    practiceItems: 8,
    why: state === "iffy" ? "Two of your last four answers on it were wrong." : state === "not_seen" ? "No answers on it yet." : "Mostly right over several days.",
    reasons: [],
    assessments: [],
  }));
  const review: NextStep = {
    kind: "review",
    label: "Review 12 due cards",
    detail: "Comma splices and Subject–verb agreement are due for review: time since you last recalled them makes slipping likely.",
    topicIds: ["t-comma", "t-sva"],
    usesAi: false,
    command: { type: "learning", request: { op: "practice.target", courseId, topicIds: ["t-comma", "t-sva"], mode: "flashcards", count: 12 } },
  };
  const quiz: NextStep = {
    kind: "quiz",
    label: "Quiz me: 5 questions on Counterarguments and Integrating evidence",
    detail: "The Midterm exam covers them and they're Getting there.",
    topicIds: ["t-counter", "t-evidence"],
    usesAi: false,
    command: { type: "learning", request: { op: "practice.target", courseId, topicIds: ["t-counter", "t-evidence"], mode: "test", count: 5 } },
  };
  const exam = (key: string, title: string, kind: MasteryAssessment["kind"], days: number, step: NextStep): MasteryAssessment => {
    const topicIds = ITEM_TOPICS[key]!;
    const c = counts(topicIds);
    return { assessmentId: ids[key]!, title, kind, at: iso(now, days), daysAway: days, dateSource: "assignment", scope: "linked", topicIds, counts: c, dueForReview: topicIds.filter((t) => TOPICS.find((x) => x[0] === t)![4].due).length, label: `Mastered ${c.solid} of ${topicIds.length} topics for ${title}`, nextStep: step };
  };
  const all = counts(TOPICS.map((t) => t[0]));
  return {
    courseId,
    status: "ok",
    message: null,
    counts: all,
    total: TOPICS.length,
    label: `Mastered ${all.solid} of ${TOPICS.length} topics`,
    sinceLastWeek: { since: iso(now, -7), movedUp: 2, movedDown: 1, dueForReview: 3, text: "2 topics moved up and 1 moved down since last week." },
    nextStep: review,
    nextStepNote: null,
    modules: [],
    topics,
    assessments: [exam("mid", "Midterm exam", "midterm", 2, quiz), exam("gq5", "Grammar quiz", "quiz", 4, review)],
    undatedAssessments: [],
    hidden: [],
    note: "Synthetic sample: topic states for a fictional student.",
  };
}

/** Every input the tab needs for the sample course. */
export function sampleInputs(now: Date, resources: StoredRef[] = [], courseId = "sample-101", courseName = "Writing 101 · Sample"): AnalyticsInputs {
  const { input, ids } = sampleGradeInput(now, resources, courseId);
  const itemTopics: Record<string, string[]> = {};
  for (const [key, topics] of Object.entries(ITEM_TOPICS)) itemTopics[ids[key]!] = topics;
  return {
    courseId,
    courseName,
    now,
    synthetic: true,
    grades: courseGrades(input, now),
    gradesMessage: null,
    work: input.items,
    mastery: sampleMastery(now, ids, courseId),
    masteryMessage: null,
    itemTopics,
    syllabus: { text: SAMPLE_SYLLABUS, resourceId: "sample-analytics:syllabus" },
    cardsDueByTopic: SAMPLE_CARDS_DUE,
  };
}

// ---------- a synthetic flashcard deck, so "Review 12 due cards" opens the real review UI ----------

const DECK: [string, string, string][] = [
  ["t-comma", "What is a comma splice?", "Two independent clauses joined only by a comma."],
  ["t-comma", "Fix: “The draft was long, it needed cuts.”", "“The draft was long; it needed cuts.” (or a period, or “so”)"],
  ["t-sva", "Choose: “The list of sources (is / are) on page 2.”", "is: the subject is “list”, not “sources”."],
  ["t-comma", "Name three ways to repair a comma splice.", "A period, a semicolon, or a comma plus a coordinating conjunction."],
  ["t-sva", "Choose: “Neither the author nor the editors (was / were) sure.”", "were: the verb agrees with the nearer subject."],
  ["t-sva", "Is “each of the essays” singular or plural?", "Singular: “each of the essays is…”"],
];

/** An in-memory stand-in for the study router, for the sample course only. It never touches the store. */
export function sampleStudyApi() {
  let session: FlashcardSessionView | null = null;
  let cursor = 0;
  const view = (count: number): FlashcardSessionView => {
    const done = cursor >= count;
    const [topic, front, back] = DECK[cursor % DECK.length]!;
    const t = TOPICS.find((x) => x[0] === topic)!;
    return {
      id: "sample-session",
      courseId: "sample-101",
      revision: cursor,
      availability: "current",
      reason: "Synthetic sample deck.",
      status: done ? "complete" : "active",
      current: done ? undefined : { cardId: `sample-card-${cursor}`, itemId: `sample-item-${cursor}`, itemVersion: 1, front, back, topics: [{ conceptId: topic, label: t[1], primary: true }], citations: [], isNew: false },
      remaining: Math.max(0, count - cursor),
      dueToday: count,
      reviewed: session?.reviewed ?? [],
      topicIds: ["t-comma", "t-sva"],
    };
  };
  let size = DECK.length;
  return {
    async learning(request: LearningRequest): Promise<LearningResult> {
      if (request.op === "practice.target" && request.mode === "flashcards") {
        cursor = 0;
        size = Math.min(DECK.length, request.count);
        session = null;
        session = view(size);
        return { op: request.op, status: "ok", data: { flashcards: session } satisfies FlashcardData };
      }
      if (request.op === "study.review") {
        const reviewed = [...(session?.reviewed ?? []), { cardId: request.cardId, reviewId: `r-${cursor}`, rating: request.rating, undone: false }];
        cursor++;
        session = { ...view(size), reviewed };
        return { op: request.op, status: "ok", data: { flashcards: session } satisfies FlashcardData };
      }
      return { op: request.op, status: "unavailable", message: "The synthetic sample course has no question bank. In your own course this starts the quiz from your materials." };
    },
    async pack() {
      return { status: "unavailable", message: "The synthetic sample course doesn't generate. In your own course this uses your AI, with its consent and receipt." };
    },
  };
}
