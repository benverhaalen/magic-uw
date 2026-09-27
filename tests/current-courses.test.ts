/**
 * fix/current-courses-only: which Canvas courses count as this term, and what is never fetched.
 * Synthetic fixtures only: no real course, account or enrollment data.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureBatch, Snapshot } from "@magic/contracts";
import { createStore } from "@magic/storage";
import { canvasConnector, type CanvasConnectorOptions } from "../packages/connectors/src/canvas";
import {
  COURSE_REASONS,
  canvasCourseCode,
  courseSelection,
  courseTiming,
  type SelectableCanvasCourse,
} from "../packages/connectors/src/canvas-selection";
import { createIngestion } from "../apps/desktop/src/ingestion";
import { courseChoices } from "../apps/desktop/src/renderer/onboarding/model";

const origin = "https://canvas.wisc.edu";
const now = new Date("2026-09-27T15:00:00Z");
const student = [{ type: "student", enrollment_state: "active" }];
const fall = { id: 50, name: "Fall 2026-2027", start_at: "2026-09-02T05:00:00Z", end_at: "2026-12-23T06:00:00Z" };
const summerEnded = { id: 48, name: "Summer 2025-2026", start_at: "2026-06-15T05:00:00Z", end_at: "2026-09-06T05:00:00Z" };
/** Every course shape the rules must place; ids are synthetic. */
const courses = {
  current: { id: 101, name: "SYNTH 400: Current course", course_code: "FA26 SYNTH 400 001", workflow_state: "available", enrollments: student, term: fall },
  currentEnrolled: { id: 102, name: "SYNTH 510: Enrolled course", course_code: "FA26 SYNTH 510 002", workflow_state: "available", enrollments: student, term: fall },
  orgSite: { id: 201, name: "Synthetic Student Org", course_code: "ORG-2201", workflow_state: "available", enrollments: student, term: { id: 1, name: "Default Term" } },
  rescued: { id: 202, name: "SYNTH 690: Seminar site", course_code: "SYNTH 690", workflow_state: "available", enrollments: student, term: { id: 1, name: "Default Term" } },
  endedThreeWeeks: { id: 301, name: "SYNTH 300: Summer course", course_code: "SU26 SYNTH 300 001", workflow_state: "available", enrollments: student, term: summerEnded },
  completed: { id: 401, name: "SYNTH 101: Old course", course_code: "FA24 SYNTH 101 001", workflow_state: "available", concluded: true, enrollments: student, term: { id: 40, name: "Fall 2024-2025", start_at: "2024-09-04T05:00:00Z", end_at: "2024-12-25T06:00:00Z" } },
  nameless: { id: 402, access_restricted_by_date: true },
};
const enrolledCodes = new Set(["SYNTH 510", "SYNTH 690"]);
const enrolledThisTerm = (course: SelectableCanvasCourse) => {
  const code = canvasCourseCode(course.course_code);
  return !!code && enrolledCodes.has(`${code.subject} ${code.catalog}`);
};

function canvas() {
  const calls: URL[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch: CanvasConnectorOptions["fetch"] = async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname === "/api/v1/users/self/profile") return json({ id: 7 });
    if (url.pathname === "/api/v1/courses")
      return json(url.searchParams.get("enrollment_state") === "completed"
        ? [courses.completed, courses.nameless]
        : [courses.current, courses.currentEnrolled, courses.orgSite, courses.rescued, courses.endedThreeWeeks]);
    return json([]);
  };
  const contentReads = () =>
    [...new Set(calls.map((u) => u.pathname.match(/^\/api\/v1\/courses\/(\d+)\//)?.[1] ?? u.searchParams.get("context_codes[]")?.replace("course_", "")).filter(Boolean))].sort();
  return { fetch, calls, contentReads };
}
async function pull(options: Partial<CanvasConnectorOptions>) {
  const batches: CaptureBatch[] = [];
  for await (const batch of canvasConnector({ origin, now: () => now, sleep: async () => {}, random: () => 0, ...options } as CanvasConnectorOptions).pull())
    batches.push(batch);
  return batches;
}
const courseRows = (batches: CaptureBatch[]) =>
  new Map(batches.filter((b) => b.source.scope === "course").map((b) => [b.source.courseId, b.resources[0]!]));

test("this term by Canvas's own term dates; enrollment rescues a term-less class; old and org sites are not read", async () => {
  const mock = canvas();
  const rows = courseRows(await pull({ fetch: mock.fetch, enrolledThisTerm }));
  const included = [...rows].filter(([, r]) => r.course?.selection?.included).map(([id]) => id).sort();
  assert.deepEqual(included, ["101", "102", "202"]);
  // A current course without planning data: Canvas's rules alone.
  assert.ok(rows.get("101")!.course!.selection!.reasons.includes(COURSE_REASONS.thisTerm));
  assert.ok(!rows.get("101")!.course!.selection!.reasons.includes(COURSE_REASONS.enrolled));
  // A current course the UW enrollment corroborates.
  assert.ok(rows.get("102")!.course!.selection!.reasons.includes(COURSE_REASONS.enrolled));
  // A term-less site the student is enrolled in is rescued; an org site on the Default Term is not.
  assert.ok(rows.get("202")!.course!.selection!.reasons.includes(COURSE_REASONS.enrolled));
  assert.ok(rows.get("201")!.course!.selection!.reasons.includes(COURSE_REASONS.termless));
  // A term that ended three weeks ago is past.
  assert.ok(rows.get("301")!.course!.selection!.reasons.includes(COURSE_REASONS.past));
  // Completed enrollment: metadata only, never included.
  assert.equal(rows.get("401")!.course!.selection!.included, false);
  // The nameless restricted row is never stored as a course.
  assert.equal(rows.has("402"), false);
  // Content reads: only the three current courses; never the old, org or ended courses.
  assert.deepEqual(mock.contentReads(), ["101", "102", "202"]);
});

test("without planning data a term-less class is not rescued; nothing reaches it", async () => {
  const mock = canvas();
  const rows = courseRows(await pull({ fetch: mock.fetch }));
  assert.equal(rows.get("202")!.course!.selection!.included, false);
  assert.deepEqual(mock.contentReads(), ["101", "102"]);
});

test("overrides in each direction; an include cannot pull back a past course", () => {
  const options = (included: boolean, courseId: string) => ({
    accountScope: "a", currentTime: now, courseOverrides: [{ accountScope: "a", courseId, included }],
  });
  assert.equal(courseSelection(courses.current, options(false, "101")).included, false);
  assert.equal(courseSelection(courses.orgSite, options(true, "201")).included, true);
  assert.equal(courseSelection(courses.endedThreeWeeks, options(true, "301")).included, false);
  assert.equal(courseSelection({ ...courses.completed, historicalOnly: true }, options(true, "401")).included, false);
});

test("term timing uses Canvas dates, a 14-day grace, and the course's own dates only when Canvas says so", () => {
  const ended = (days: number) => ({ ...courses.current, term: { ...fall, end_at: new Date(now.getTime() - days * 86400_000).toISOString(), start_at: "2026-05-01T00:00:00Z" } });
  assert.equal(courseTiming(ended(10), now), "current");
  assert.equal(courseTiming(ended(21), now), "past");
  assert.equal(courseTiming({ ...ended(21), end_at: "2026-10-30T00:00:00Z" }, now), "extended");
  assert.equal(courseTiming({ ...ended(21), end_at: "2026-10-30T00:00:00Z", restrict_enrollments_to_course_dates: true, start_at: "2026-05-01T00:00:00Z" }, now), "current");
  assert.equal(courseTiming({ ...courses.current, term: { id: 60, name: "Spring 2026-2027" } }, now), "future");
  assert.deepEqual(canvasCourseCode("FA26 COMP SCI 400 001"), { subject: "COMP SCI", catalog: "400", sections: ["001"] });
  assert.deepEqual(canvasCourseCode("SP26 SYNTH 999 001 002"), { subject: "SYNTH", catalog: "999", sections: ["001", "002"] });
});

test("onboarding chooser: this term pre-checked, other sites unchecked, past and nameless hidden, overrides win", async () => {
  const store = createStore(":memory:");
  try {
    for (const batch of await pull({ fetch: canvas().fetch, catalogOnly: true })) store.ingest(batch);
    const snapshot = (overrides: Snapshot["courseOverrides"] = []) =>
      ({ sources: store.sources(), resources: store.resources(), courseOverrides: overrides }) as unknown as Snapshot;
    const choices = courseChoices(snapshot());
    assert.deepEqual(choices.map((c) => [c.courseId, c.group, c.checked]), [
      ["101", "this-term", true],
      ["102", "this-term", true],
      ["202", "other", false],
      ["201", "other", false],
    ]);
    const account = choices[0]!.accountScope;
    const toggled = courseChoices(snapshot([
      { accountScope: account, courseId: "101", included: false },
      { accountScope: account, courseId: "201", included: true },
    ]));
    assert.equal(toggled.find((c) => c.courseId === "101")!.checked, false);
    assert.equal(toggled.find((c) => c.courseId === "201")!.checked, true);
  } finally {
    store.close();
  }
});

test("discovery reads only the course lists; background waits for the student; the sync reads only checked courses; excluded evidence stays", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-current-courses-"));
  const store = createStore(join(directory, "db.sqlite"));
  const mock = canvas();
  let time = new Date(2026, 8, 27, 12);
  const ingestion = createIngestion(store, {
    directory,
    now: () => time,
    canvasFetch: mock.fetch,
    client: { isCanvas: () => false, async get() { throw new Error("offline"); }, async text() { throw new Error("offline"); }, async feed() { throw new Error("offline"); } } as never,
    secrets: async () => ({}),
  });
  try {
    // A workspace from before this fix: a nameless row stored as a course.
    store.ingest({
      source: { id: `canvas:legacy:402:course`, label: "Course 402 (name unavailable) · course", kind: "canvas", accountScope: "legacy", courseId: "402", scope: "course" },
      observedAt: "2026-09-20T00:00:00.000Z", status: "inaccessible", complete: false,
      resources: [{ externalId: "402", kind: "course", courseId: "402", courseName: "Course 402 (name unavailable)", title: "Course 402 (name unavailable)", url: `${origin}/courses/402`, text: "", deadlines: [], course: { accessRestricted: true, accessState: "date_restricted", selection: { score: -1, included: false, reasons: [] } } }],
    } as never);
    await ingestion.discover();
    assert.deepEqual(mock.calls.map((u) => `${u.pathname}${u.searchParams.get("enrollment_state") ? `?${u.searchParams.get("enrollment_state")}` : ""}`).sort(),
      ["/api/v1/courses?active", "/api/v1/courses?completed", "/api/v1/users/self/profile"]);
    assert.ok(!store.resources().some((r) => r.courseId === "402"), "the nameless row is retired");
    assert.ok(!store.sources().some((s) => s.courseId === "402"));
    // The 30-second timer must not start the full read while the student chooses.
    time = new Date(time.getTime() + 60_000);
    const before = mock.calls.length;
    assert.equal(await ingestion.tick("background"), undefined);
    assert.equal(mock.calls.length, before);
    // The student unchecks 102 and starts: only the checked courses are read.
    const account = store.sources().find((s) => s.scope === "course")!.accountScope;
    store.setCourseOverride({ accountScope: account, courseId: "102", included: false });
    await ingestion.tick("manual");
    assert.deepEqual(mock.contentReads(), ["101"]);
    // Re-including resumes it; excluding keeps the evidence already stored.
    store.setCourseOverride({ accountScope: account, courseId: "102", included: true });
    time = new Date(time.getTime() + 7 * 3600_000);
    await ingestion.tick("manual");
    assert.ok(mock.contentReads().includes("102"));
    const stored = store.resources().filter((r) => r.courseId === "102" && r.kind !== "course").length;
    store.setCourseOverride({ accountScope: account, courseId: "102", included: false });
    const afterExclude = mock.calls.length;
    time = new Date(time.getTime() + 7 * 3600_000);
    await ingestion.tick("manual");
    assert.ok(!mock.calls.slice(afterExclude).some((u) => /\/courses\/102\//.test(u.pathname)), "an excluded course is not refreshed");
    assert.equal(store.resources().filter((r) => r.courseId === "102" && r.kind !== "course").length, stored, "its evidence is not deleted");
  } finally {
    await ingestion.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the onboarding hold survives a restart: a new worker reads nothing until the student starts the sync", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-current-courses-hold-"));
  const store = createStore(join(directory, "db.sqlite"));
  const mock = canvas();
  let time = new Date(2026, 8, 27, 12);
  const make = () =>
    createIngestion(store, {
      directory,
      now: () => time,
      canvasFetch: mock.fetch,
      client: { isCanvas: () => false, async get() { throw new Error("offline"); }, async text() { throw new Error("offline"); }, async feed() { throw new Error("offline"); } } as never,
      secrets: async () => ({}),
    });
  let ingestion = make();
  try {
    await ingestion.discover();
    assert.equal(store.ingestionSettings().awaitingCourseChoice, true);
    await ingestion.stop();
    ingestion = make(); // the app restarted mid-onboarding
    time = new Date(time.getTime() + 60_000);
    const before = mock.calls.length;
    assert.equal(await ingestion.tick("background"), undefined);
    assert.equal(mock.calls.length, before, "no read before the student confirms");
    await ingestion.tick("manual"); // "Start syncing"
    assert.equal(store.ingestionSettings().awaitingCourseChoice, false);
    assert.ok(mock.contentReads().length > 0);
  } finally {
    await ingestion.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
