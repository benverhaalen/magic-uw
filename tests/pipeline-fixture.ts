/**
 * A synthetic course for the material pipeline tests, shaped like a real Canvas capture: module
 * items in `module-items:<id>` sources with no text, page bodies in `page:<slug>` sources, files
 * in a folder, the same assignment in the assignments list, the to-do list, a module item and the
 * calendar feed. Every title, URL and body here is invented.
 */
import type { CaptureBatch, ResourceInput } from "@magic/contracts";
import { createStore } from "@magic/storage";

export const ACCOUNT = "student-1";
export const COURSE = "101";
export const course = { accountScope: ACCOUNT, courseId: COURSE };
const base = "https://canvas.wisc.edu/courses/101";
export const TODAY = "2026-10-01";
export const TZ = "America/Chicago";
export const NOW = "2026-10-01T15:00:00.000Z";

type Item = Partial<ResourceInput> & Pick<ResourceInput, "externalId" | "kind" | "title" | "url">;
const item = (value: Item): ResourceInput => ({
  courseId: COURSE,
  courseName: "Linear Algebra Example",
  text: "",
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "unknown", evidence: "" },
  ...value,
});
const batch = (scope: string, resources: ResourceInput[], observedAt = "2026-09-30T12:00:00.000Z"): CaptureBatch => ({
  source: { id: `src-${scope}`, label: "Example Canvas", kind: "canvas", accountScope: ACCOUNT, courseId: COURSE, scope },
  observedAt,
  complete: true,
  status: "ok",
  resources,
});
const moduleItem = (id: string, type: string, title: string, position: number, extra: Record<string, unknown> = {}) =>
  item({ externalId: id, kind: "material", title, url: `${base}/modules/items/${id}`, moduleItem: { type, title, position, ...extra } });

export const VECTORS_TEXT = [
  "Vectors notes",
  "A vector is defined as a quantity with both magnitude and direction.",
  "Magnitude: the length of a vector, written |v|, measured from its tail to its head.",
  "The sum is v = a + b for any two vectors.",
  "Worked example on Sept 30.",
].join("\n");

export function batches(): CaptureBatch[] {
  return [
    batch("modules", [
      item({ externalId: "m1", kind: "material", title: "Week 1: Vectors", url: `${base}/modules/m1`, module: { id: "m1", position: 1 } }),
      item({ externalId: "m2", kind: "material", title: "Week 2: Matrices", url: `${base}/modules/m2`, module: { id: "m2", position: 2 } }),
    ]),
    batch("module-items:m1", [
      moduleItem("901", "SubHeader", "This week", 0),
      moduleItem("902", "Page", "Vectors notes", 1, { pageUrl: "vectors-notes" }),
      moduleItem("903", "File", "Lecture 1 slides.pdf", 2, { contentId: "5001" }),
      moduleItem("904", "Assignment", "Homework 1", 3, { contentId: "1001" }),
      moduleItem("905", "Page", "Office hours and staff", 4, { pageUrl: "office-hours" }),
      moduleItem("906", "ExternalUrl", "Vectors video", 5, { externalUrl: "https://www.youtube.com/embed/vectors-demo" }),
    ]),
    batch("module-items:m2", [
      moduleItem("911", "Page", "Matrix notes", 1, { pageUrl: "matrix-notes" }),
      moduleItem("912", "Assignment", "Homework 2", 2, { contentId: "1002" }),
      moduleItem("913", "File", "Matrix worksheet.pdf", 3, { contentId: "5002" }),
      moduleItem("914", "Quiz", "Quiz 1", 4, { contentId: "7001", dueAt: "2026-10-03T04:59:00.000Z" }),
    ]),
    batch("page:vectors", [item({ externalId: "p1", kind: "material", title: "Vectors notes", url: `${base}/pages/vectors-notes`, text: VECTORS_TEXT })]),
    batch("page:office", [item({ externalId: "p2", kind: "material", title: "Office hours and staff", url: `${base}/pages/office-hours`, text: "Office hours are Monday 2-3pm in the library." })]),
    batch("page:matrix", [item({ externalId: "p3", kind: "material", title: "Matrix notes", url: `${base}/pages/matrix-notes`, text: "Matrix notes\nA matrix is a rectangular array of numbers." })]),
    batch("page:unlisted", [item({ externalId: "p4", kind: "material", title: "Determinant tricks", url: `${base}/pages/determinant-tricks`, text: "Determinant tricks\nExpand along a row with many zeros." })]),
    batch("folders", [
      item({ externalId: "fold1", kind: "material", title: "Worksheets", url: `${base}/files/folder/worksheets` }),
      item({ externalId: "fold2", kind: "material", title: "Readings", url: `${base}/files/folder/readings` }),
    ]),
    batch("files", [
      item({ externalId: "5001", kind: "material", title: "Lecture 1 slides.pdf", url: `${base}/files/5001`, file: { id: "5001", folderId: "fold9", displayName: "Lecture 1 slides.pdf", contentType: "application/pdf" } }),
      item({ externalId: "5002", kind: "material", title: "Matrix worksheet.pdf", url: `${base}/files/5002`, file: { id: "5002", folderId: "fold1", displayName: "Matrix worksheet.pdf", contentType: "application/pdf" } }),
      item({ externalId: "5003", kind: "material", title: "Handbook part A.pdf", url: `${base}/files/5003`, file: { id: "5003", folderId: "fold2", displayName: "Handbook part A.pdf", contentType: "application/pdf" } }),
      item({ externalId: "5004", kind: "material", title: "Mystery handout.pdf", url: `${base}/files/5004`, file: { id: "5004", folderId: "fold9", displayName: "Mystery handout.pdf", contentType: "application/pdf" } }),
      item({ externalId: "5005", kind: "material", title: "figure.png", url: `${base}/files/5005`, file: { id: "5005", folderId: "fold9", displayName: "figure.png", contentType: "image/png" } }),
    ]),
    batch("assignments", [
      item({
        externalId: "1001",
        kind: "assignment",
        title: "Homework 1",
        url: `${base}/assignments/1001`,
        text: "Use the matrix notes and the Handbook part A.pdf. Background: https://example.org/article?id=1 and https://example.org/article?id=2",
        links: [
          { url: `${base}/pages/matrix-notes`, text: "matrix notes" },
          { url: `${base}/files/5999/preview`, text: "old handout" },
          { url: "https://canvas.wisc.edu/equation_images/x" },
        ],
        dueAt: "2026-10-02T04:59:00.000Z",
        submissionTypes: ["online_upload"],
        submission: { workflowState: "unsubmitted", late: false, missing: false },
        submitted: false,
      }),
      item({ externalId: "1002", kind: "assignment", title: "Homework 2", url: `${base}/assignments/1002`, dueAt: "2026-10-04T04:59:00.000Z", submissionTypes: ["online_upload"] }),
      item({ externalId: "1003", kind: "assignment", title: "Midterm Exam", url: `${base}/assignments/1003`, dueAt: "2026-10-06T19:00:00.000Z", submissionTypes: ["on_paper"] }),
      item({
        externalId: "1000",
        kind: "assignment",
        title: "Homework 0",
        url: `${base}/assignments/1000`,
        dueAt: "2026-09-29T04:59:00.000Z",
        submissionTypes: ["online_upload"],
        submission: { workflowState: "unsubmitted", late: false, missing: true },
        submitted: false,
      }),
    ]),
    batch("syllabus", [
      item({
        externalId: "syllabus",
        kind: "material",
        title: "Syllabus",
        url: `${base}/assignments/syllabus`,
        text: "Schedule\nHomework 1 is due Oct 1.\nHW 2 covers matrices.\nFinal exam on October 12.\n",
      }),
    ]),
    batch("account-todo", [
      item({ externalId: "1001", kind: "assignment", title: "Homework 1", url: `${base}/assignments/1001`, dueAt: "2026-10-02T05:00:00.000Z" }),
    ]),
    {
      ...batch("calendar_feed", [
        item({ externalId: "cal:1", kind: "event", title: "Homework 1", url: `${base}/assignments/1001`, calendar: { uid: "event-assignment-1001", start: "2026-10-02T05:00:00.000Z", allDay: false } }),
        item({ externalId: "cal:2", kind: "event", title: "Review session", url: "https://canvas.wisc.edu/calendar", calendar: { uid: "event-review-1", start: "2026-10-05", allDay: true } }),
      ]),
      source: { id: "src-calendar", label: "Example calendar", kind: "calendar", accountScope: ACCOUNT, courseId: COURSE, scope: "calendar_feed" },
    },
  ];
}

export function seededStore() {
  const store = createStore(":memory:");
  for (const b of batches()) {
    const report = store.ingest(b);
    if (report.rejected) throw new Error(`fixture rejected: ${JSON.stringify(report.diagnostics)}`);
  }
  return store;
}
export const idOf = (store: ReturnType<typeof createStore>, sourceScope: string, externalId: string) =>
  store.resources().find((r) => r.sourceId === `src-${sourceScope}` && r.externalId === externalId)!.id;
