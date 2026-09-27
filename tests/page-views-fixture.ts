/**
 * A synthetic course for the page views (owner: page-views), shaped like a real Canvas capture:
 * module items in `module-items:<id>` sources, page bodies in `page:<slug>` sources, the same
 * quiz in the assignments and quizzes lists, weighted assignment groups, a syllabus that dates
 * Midterm 1 and an announcement that moves it, a Canvas tool (LTI) module item, a Kaltura link
 * and a timed calendar lecture. Every title, URL and body here is invented.
 */
import type { CaptureBatch, ResourceInput } from "@magic/contracts";
import { createStore } from "@magic/storage";

export const ACCOUNT = "student-1";
export const COURSE = "202";
export const course = { accountScope: ACCOUNT, courseId: COURSE };
export const NOW = "2026-09-29T14:00:00.000Z";
const base = "https://canvas.wisc.edu/courses/202";

type Item = Partial<ResourceInput> & Pick<ResourceInput, "externalId" | "kind" | "title" | "url">;
const item = (value: Item): ResourceInput => ({
  courseId: COURSE,
  courseName: "Signals Example",
  text: "",
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "unknown", evidence: "" },
  ...value,
});
export const batch = (scope: string, resources: ResourceInput[], extra: Partial<CaptureBatch> = {}): CaptureBatch => ({
  source: { id: `src-${scope}`, label: "Example Canvas", kind: "canvas", accountScope: ACCOUNT, courseId: COURSE, scope },
  observedAt: "2026-09-29T12:00:00.000Z",
  complete: true,
  status: "ok",
  resources,
  ...extra,
});
const moduleItem = (id: string, type: string, title: string, position: number, extra: Record<string, unknown> = {}) =>
  item({ externalId: id, kind: "material", title, url: `${base}/modules/items/${id}`, moduleItem: { type, title, position, ...extra } });

export const SLIDES_TEXT = "Signals\nSignal: a function of time that carries information about a system.\nSampling rate: the number of samples taken per second of signal.";
export const CONVOLUTION_TEXT = "Convolution notes\ny(t) = x(t) * h(t)\nImpulse response: the output of a system when the input is an impulse.";
export const EXAM_INFO_TEXT = "Midterm 1 covers weeks 1-2.\nThe exam is 90 minutes long.\nYou may bring one page of notes.";
export const SYLLABUS_TEXT = [
  "Course schedule",
  "Week 1: Read Lecture 1 notes before class.",
  "Midterm 1 is on October 15 at 7:15 PM and lasts 120 minutes.",
  "Midterm 1 location: 1100 Grainger Hall",
  "Office hours: Monday and Tuesday 2-3pm in 4610 Engineering Hall",
  "Final Exam: December 15.",
].join("\n");
export const HW1_TEXT =
  "Read the Lecture 1 notes and use the Problem set guide.pdf for the format. Submit on Gradescope: https://www.gradescope.com/courses/1";

export function batches(): CaptureBatch[] {
  return [
    batch("course", [
      item({
        externalId: COURSE,
        kind: "course",
        title: "Signals Example",
        url: base,
        course: { courseCode: "SIG 202", termName: "Fall 2026", startAt: "2026-09-28T05:00:00.000Z", endAt: "2026-12-20T06:00:00.000Z", selection: { score: 1, included: true, reasons: [] } },
      }),
    ]),
    batch("modules", [
      item({ externalId: "m1", kind: "material", title: "Week 1: Signals", url: `${base}/modules/m1`, module: { id: "m1", position: 1 } }),
      item({ externalId: "m2", kind: "material", title: "Week 2: Systems", url: `${base}/modules/m2`, module: { id: "m2", position: 2 } }),
    ]),
    batch("module-items:m1", [
      moduleItem("1101", "Page", "Lecture 1 notes", 1, { pageUrl: "lecture-1-notes" }),
      moduleItem("1102", "File", "Slides 9/29.pdf", 2, { contentId: "7001" }),
      moduleItem("1103", "Assignment", "Homework 1", 3, { contentId: "3001" }),
      moduleItem("1104", "ExternalUrl", "Lecture 1 recording", 4, { externalUrl: "https://mediaspace.wisc.edu/media/Lecture+1/1_abc" }),
      moduleItem("1105", "ExternalTool", "Gradescope", 5, { externalUrl: "https://www.gradescope.com/auth/lti/callback" }),
    ]),
    batch("module-items:m2", [
      moduleItem("1201", "Page", "Convolution notes", 1, { pageUrl: "convolution-notes" }),
      moduleItem("1202", "Assignment", "Homework 2", 2, { contentId: "3003" }),
    ]),
    batch("page:lecture-1", [
      item({ externalId: "p1", kind: "material", title: "Lecture 1 notes", url: `${base}/pages/lecture-1-notes`, text: "Lecture 1 notes\nA system maps an input signal to an output signal." }),
    ]),
    batch("page:convolution", [item({ externalId: "p2", kind: "material", title: "Convolution notes", url: `${base}/pages/convolution-notes`, text: CONVOLUTION_TEXT })]),
    batch("page:exam-info", [item({ externalId: "p3", kind: "material", title: "Midterm 1 information", url: `${base}/pages/midterm-1-information`, text: EXAM_INFO_TEXT })]),
    batch("files", [
      item({ externalId: "7001", kind: "material", title: "Slides 9/29.pdf", url: `${base}/files/7001`, text: SLIDES_TEXT, createdAt: "2026-09-28T15:00:00.000Z", file: { id: "7001", displayName: "Slides 9/29.pdf", contentType: "application/pdf" } }),
      item({ externalId: "7002", kind: "material", title: "Problem set guide.pdf", url: `${base}/files/7002`, text: "Problem set guide\nShow every step.", file: { id: "7002", displayName: "Problem set guide.pdf", contentType: "application/pdf" } }),
    ]),
    batch("assignment-groups", [
      item({ externalId: "g1", kind: "material", title: "Homework", url: `${base}/assignments`, assignmentGroup: { weight: 40, position: 1 } }),
      item({ externalId: "g2", kind: "material", title: "Exams", url: `${base}/assignments`, assignmentGroup: { weight: 50, position: 2 } }),
      item({ externalId: "g3", kind: "material", title: "Quizzes", url: `${base}/assignments`, assignmentGroup: { weight: 10, position: 3 } }),
    ]),
    batch("assignments", [
      item({
        externalId: "3001",
        kind: "assignment",
        title: "Homework 1",
        url: `${base}/assignments/3001`,
        text: HW1_TEXT,
        links: [
          { url: `${base}/pages/lecture-1-notes`, text: "Lecture 1 notes" },
          { url: `${base}/files/7001`, text: "slides" },
        ],
        dueAt: "2026-10-02T04:59:00.000Z",
        points: 10,
        assignmentGroupId: "g1",
        submissionTypes: ["online_upload"],
        submission: { workflowState: "unsubmitted", late: false, missing: false },
        submitted: false,
        rubric: [{ description: "Correctness", points: 8 }, { description: "Clarity", points: 2 }],
      }),
      item({ externalId: "3003", kind: "assignment", title: "Homework 2", url: `${base}/assignments/3003`, dueAt: "2026-10-09T04:59:00.000Z", points: 10, assignmentGroupId: "g1", submissionTypes: ["external_tool"] }),
      item({ externalId: "3002", kind: "assignment", title: "Midterm 1", url: `${base}/assignments/3002`, points: 100, assignmentGroupId: "g2", submissionTypes: ["on_paper"] }),
      item({ externalId: "3004", kind: "assignment", title: "Final Exam", url: `${base}/assignments/3004`, dueAt: "2026-12-15T15:00:00.000Z", points: 100, assignmentGroupId: "g2", submissionTypes: ["on_paper"] }),
      item({ externalId: "3005", kind: "assignment", title: "Quiz 1", url: `${base}/assignments/3005`, dueAt: "2026-10-01T04:59:00.000Z", points: 5, assignmentGroupId: "g3", submissionTypes: ["online_quiz"] }),
      item({ externalId: "3006", kind: "assignment", title: "Quiz 2", url: `${base}/assignments/3006`, dueAt: "2026-10-08T04:59:00.000Z", points: 5, assignmentGroupId: "g3", submissionTypes: ["online_quiz"] }),
    ]),
    batch("syllabus", [item({ externalId: "syllabus", kind: "material", title: "Syllabus", url: `${base}/assignments/syllabus`, text: SYLLABUS_TEXT })]),
    batch("announcements", [
      item({
        externalId: "a1",
        kind: "message",
        title: "Midterm 1 moved",
        url: `${base}/discussion_topics/a1`,
        text: "Midterm 1 has been moved to October 20 at 7:15 PM.",
        createdAt: "2026-10-05T15:00:00.000Z",
      }),
      item({
        externalId: "a2",
        kind: "message",
        title: "Homework 1 clarification",
        url: `${base}/discussion_topics/a2`,
        text: "For Homework 1, show your sketches.",
        createdAt: "2026-09-28T18:00:00.000Z",
      }),
    ]),
    {
      ...batch("calendar_feed", [
        item({ externalId: "cal:lec1", kind: "event", title: "Lecture: Signals", url: `${base}/calendar_events/1`, calendar: { uid: "event-lec-1", start: "2026-09-29T15:00:00.000Z", end: "2026-09-29T15:50:00.000Z", allDay: false } }),
      ]),
      source: { id: "src-calendar", label: "Example calendar", kind: "calendar", accountScope: ACCOUNT, courseId: COURSE, scope: "calendar_feed" },
    },
  ];
}

export function seededStore(options: { assignmentsComplete?: boolean } = {}) {
  const store = createStore(":memory:");
  for (const b of batches()) {
    const incomplete = b.source.scope === "assignments" && options.assignmentsComplete === false;
    const report = store.ingest(incomplete ? { ...b, complete: false, status: "partial" } : b);
    if (report.rejected) throw new Error(`fixture rejected: ${JSON.stringify(report.diagnostics)}`);
  }
  return store;
}
export const idOf = (store: ReturnType<typeof createStore>, scope: string, externalId: string) =>
  store.resources().find((r) => r.sourceId === `src-${scope}` && r.externalId === externalId)!.id;
