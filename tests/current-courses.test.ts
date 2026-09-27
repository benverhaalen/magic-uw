/**
 * fix/current-courses-only: which Canvas courses count as this term, and what is never fetched.
 * Synthetic fixtures only: no real course, account or enrollment data.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureBatch, Snapshot, Store } from "@magic/contracts";
import type { PlanningCapture } from "../packages/contracts/src/planning";
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
import { courseChoices, emptyProgress, firstIncompleteStep } from "../apps/desktop/src/renderer/onboarding/model";

const origin = "https://canvas.wisc.edu";
const now = new Date("2026-09-27T15:00:00Z");
const student = [{ type: "student", enrollment_state: "active" }];
const fall = { id: 50, name: "Fall 2026-2027", start_at: "2026-09-02T05:00:00Z", end_at: "2026-12-23T06:00:00Z" };
const summerEnded = { id: 48, name: "Summer 2025-2026", start_at: "2026-06-15T05:00:00Z", end_at: "2026-09-06T05:00:00Z" };
const defaultTerm = { id: 1, name: "Default Term" };
/** Every course shape the rules must place; ids are synthetic. */
const courses = {
  current: { id: 101, name: "SYNTH 400: Current course", course_code: "FA26 SYNTH 400 001", workflow_state: "available", enrollments: student, term: fall },
  currentEnrolled: { id: 102, name: "SYNTH 510: Enrolled course", course_code: "FA26 SYNTH 510 002", workflow_state: "available", enrollments: student, term: fall },
  orgSite: { id: 201, name: "Synthetic Student Org", course_code: "ORG-2201", workflow_state: "available", enrollments: student, term: defaultTerm },
  rescued: { id: 202, name: "SYNTH 690: Seminar site", course_code: "SYNTH 690", workflow_state: "available", enrollments: student, term: defaultTerm },
  pastEnrolled: { id: 203, name: "SYNTH 777: Old seminar", course_code: "SYNTH 777", workflow_state: "available", enrollments: student, term: defaultTerm },
  endedThreeWeeks: { id: 301, name: "SYNTH 300: Summer course", course_code: "SU26 SYNTH 300 001", workflow_state: "available", enrollments: student, term: summerEnded },
  completed: { id: 401, name: "SYNTH 101: Old course", course_code: "FA24 SYNTH 101 001", workflow_state: "available", concluded: true, enrollments: student, term: { id: 40, name: "Fall 2024-2025", start_at: "2024-09-04T05:00:00Z", end_at: "2024-12-25T06:00:00Z" } },
  nameless: { id: 402, access_restricted_by_date: true },
};
const activeList = [courses.current, courses.currentEnrolled, courses.orgSite, courses.rescued, courses.pastEnrolled, courses.endedThreeWeeks];
const enrolledCodes = new Set(["SYNTH 510", "SYNTH 690"]);
const enrolledThisTerm = (course: SelectableCanvasCourse) => {
  const code = canvasCourseCode(course.course_code);
  return !!code && enrolledCodes.has(`${code.subject} ${code.catalog}`);
};

/** A synthetic Canvas: course lists, and one assignment per course for content reads. */
function canvas(options: { active?: unknown[]; completed?: unknown[]; gate?: Promise<void>; onCourseList?: () => void } = {}) {
  const calls: URL[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch: CanvasConnectorOptions["fetch"] = async (input) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname === "/api/v1/users/self/profile") return json({ id: 7 });
    if (url.pathname === "/api/v1/courses") {
      options.onCourseList?.();
      await options.gate;
      return json(url.searchParams.get("enrollment_state") === "completed"
        ? (options.completed ?? [courses.completed, courses.nameless])
        : (options.active ?? activeList));
    }
    const assignments = url.pathname.match(/^\/api\/v1\/courses\/(\d+)\/assignments$/);
    if (assignments)
      return json([{ id: Number(assignments[1]) * 10, course_id: Number(assignments[1]), name: "Synthetic problem set", description: "<p>Solve.</p>",
        due_at: "2026-10-01T23:00:00Z", lock_at: null, points_possible: 10, workflow_state: "published" }]);
    return json([]);
  };
  /** Courses whose content was requested: any /courses/<id>/... or /courses/<id>? read, or an announcement list. */
  const contentReads = () =>
    [...new Set(calls.map((u) => u.pathname.match(/^\/api\/v1\/courses\/(\d+)(?:\/|$)/)?.[1] ?? u.searchParams.get("context_codes[]")?.replace("course_", "")).filter(Boolean))].sort();
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
const offline = { isCanvas: () => false, async get() { throw new Error("offline"); }, async text() { throw new Error("offline"); }, async feed() { throw new Error("offline"); } } as never;
function workspace(mock: ReturnType<typeof canvas>, clock = { at: new Date(2026, 8, 27, 12) }) {
  const directory = mkdtempSync(join(tmpdir(), "magic-current-courses-"));
  const store = createStore(join(directory, "db.sqlite"));
  const make = () => createIngestion(store, { directory, now: () => clock.at, canvasFetch: mock.fetch, client: offline, secrets: async () => ({}) });
  return { directory, store, make, clock, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
/** Synthetic Course Search & Enroll: SYNTH 510 and 690 in Fall 2026 (1272), SYNTH 777 in the past Spring 2026 (1264). */
function planning(store: Store) {
  const stamp = "2026-09-26T12:00:00.000Z";
  const provenance = (kind: PlanningCapture["scope"]["kind"], key: string) => ({ scope: { kind, key }, sourceUrl: "https://enroll.wisc.edu/", observedAt: stamp });
  const save = (rows: Array<{ provenance: { scope: PlanningCapture["scope"] } }>, source: string, accountScope: string) =>
    store.ingestPlanning({ schemaVersion: 1, id: rows[0]!.provenance.scope.key, accountScope, source, scope: rows[0]!.provenance.scope, sourceUrl: "https://enroll.wisc.edu/", observedAt: stamp, status: "complete", completeness: "complete", records: rows, diagnostics: [] });
  save([{ kind: "subject", id: "901", code: "901", shortName: "SYNTH", formalName: "Synthetic Studies", aliases: [], provenance: provenance("subjects", "subjects") }] as never, "uw_public", "public");
  save([
    { kind: "term", id: "1272", code: "1272", season: "fall", year: 2026, label: "Fall 2026", past: false, provenance: provenance("terms", "terms") },
    { kind: "term", id: "1264", code: "1264", season: "spring", year: 2026, label: "Spring 2026", past: true, provenance: provenance("terms", "terms") },
  ] as never, "uw_public", "public");
  const pkg = (courseKey: string, termCode: string, section: string) => ({
    kind: "enrollment_package", id: `current:${termCode}:${courseKey}`, courseKey, termCode, sections: [section], status: "open", enrollmentState: "enrolled",
    meetings: [], meetingsComplete: false, seatsAvailable: null, capacity: null, waitlistCount: null, instructorNames: [],
    provenance: provenance("enrollment_term", termCode),
  });
  save([pkg("uw:901:510", "1272", "LEC 002"), pkg("uw:901:690", "1272", "SEM 001")] as never, "uw_enroll", "uw-account:synthetic");
  save([pkg("uw:901:777", "1264", "SEM 001")] as never, "uw_enroll", "uw-account:synthetic");
}

test("this term by Canvas's own term dates; enrollment rescues a term-less class; old and org sites are not read", async () => {
  const mock = canvas();
  const rows = courseRows(await pull({ fetch: mock.fetch, enrolledThisTerm }));
  const included = [...rows].filter(([, r]) => r.course?.selection?.included).map(([id]) => id).sort();
  assert.deepEqual(included, ["101", "102", "202"]);
  assert.ok(rows.get("101")!.course!.selection!.reasons.includes(COURSE_REASONS.thisTerm));
  assert.ok(!rows.get("101")!.course!.selection!.reasons.includes(COURSE_REASONS.enrolled));
  assert.ok(rows.get("102")!.course!.selection!.reasons.includes(COURSE_REASONS.enrolled));
  assert.ok(rows.get("202")!.course!.selection!.reasons.includes(COURSE_REASONS.enrolled));
  assert.ok(rows.get("201")!.course!.selection!.reasons.includes(COURSE_REASONS.termless));
  assert.ok(rows.get("301")!.course!.selection!.reasons.includes(COURSE_REASONS.past));
  assert.equal(rows.get("401")!.course!.selection!.included, false);
  assert.equal(rows.has("402"), false, "the nameless restricted row is never stored");
  assert.deepEqual(mock.contentReads(), ["101", "102", "202"], "content reads (detail and lists) only for current courses");
});

test("without planning data a term-less class is not rescued; nothing reaches it", async () => {
  const mock = canvas();
  const rows = courseRows(await pull({ fetch: mock.fetch }));
  assert.equal(rows.get("202")!.course!.selection!.included, false);
  assert.deepEqual(mock.contentReads(), ["101", "102"]);
});

test("the real planning match: this term's UW enrollment (not the highest code, not a past term), by subject, catalog and section", async () => {
  const mock = canvas();
  const w = workspace(mock);
  const ingestion = w.make();
  try {
    planning(w.store);
    await ingestion.discover();
    const selection = (id: string) => w.store.resources().find((r) => r.kind === "course" && r.courseId === id)!.course!.selection!;
    assert.ok(selection("102").reasons.includes(COURSE_REASONS.enrolled), "SYNTH 510 section 002 matches");
    assert.equal(selection("202").included, true, "a term-less class the student is enrolled in this term");
    assert.equal(selection("203").included, false, "an enrollment in a past term rescues nothing");
    assert.ok(!selection("101").reasons.includes(COURSE_REASONS.enrolled), "no enrollment: Canvas rules alone");
  } finally {
    await ingestion.stop();
    w.close();
  }
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

test("term timing: Canvas dates beat the name; approximate dates only without any Canvas dates", () => {
  const at = (iso: string) => new Date(iso);
  const named = (name: string, extra: Partial<SelectableCanvasCourse> = {}) => ({ ...courses.current, term: { id: 9, name }, ...extra });
  const ended = (days: number) => ({ ...courses.current, term: { ...fall, end_at: new Date(now.getTime() - days * 86400_000).toISOString(), start_at: "2026-05-01T00:00:00Z" } });
  assert.equal(courseTiming(ended(10), now), "current", "within the 14-day grace");
  assert.equal(courseTiming(ended(21), now), "past");
  assert.equal(courseTiming({ ...ended(21), end_at: "2026-10-30T00:00:00Z" }, now), "extended");
  assert.equal(courseTiming({ ...ended(21), end_at: "2026-10-30T00:00:00Z", restrict_enrollments_to_course_dates: true, start_at: "2026-05-01T00:00:00Z" }, now), "current");
  // Approximate UW dates from the name, only when Canvas gives no dates at all.
  assert.equal(courseTiming(named("Summer 2025-2026"), now), "past", "summer ends Aug 20");
  assert.equal(courseTiming(named("Winter 2026-2027"), now), "future", "winter starts Dec 24");
  assert.equal(courseTiming(named("Fall 2026-2027"), at("2027-01-03T12:00:00Z")), "current", "fall ends Dec 23, plus grace");
  assert.equal(courseTiming(named("Fall 2026-2027"), at("2027-01-10T12:00:00Z")), "past");
  assert.equal(courseTiming(named("Spring 2026-2027"), now), "future");
  assert.equal(courseTiming(named("Wintersession"), now), "unknown", "no dates, no parseable name");
  // The course's own dates beat the approximation.
  assert.equal(courseTiming(named("Fall 2026-2027", { start_at: "2026-01-10T00:00:00Z", end_at: "2026-05-01T00:00:00Z" }), now), "past");
  // Unparseable term names with Canvas term dates that say current count as this term.
  for (const name of ["2026 Fall", "Academic Year 2026-2027", "Wintersession"]) {
    const course = { ...courses.current, term: { id: 9, name, start_at: "2026-09-01T05:00:00Z", end_at: name.startsWith("Academic") ? "2027-05-20T05:00:00Z" : "2026-12-23T06:00:00Z" } };
    const selection = courseSelection(course, { currentTime: now });
    assert.equal(selection.included, true, name);
    assert.ok(selection.reasons.includes(COURSE_REASONS.thisTerm), name);
  }
  // A catch-all term that spans years is not an academic term, whatever its dates.
  assert.equal(courseSelection({ ...courses.current, term: { id: 1, name: "Default Term", start_at: "2020-01-01T00:00:00Z", end_at: "2030-01-01T00:00:00Z" } }, { currentTime: now }).included, false);
  assert.deepEqual(canvasCourseCode("FA26 COMP SCI 400 001"), { subject: "COMP SCI", catalog: "400", sections: ["001"] });
});

test("onboarding chooser: this term pre-checked (selection.included), other sites unchecked, past and nameless hidden, overrides win; the step waits on the hold", async () => {
  const store = createStore(":memory:");
  try {
    for (const batch of await pull({ fetch: canvas().fetch, catalogOnly: true })) store.ingest(batch);
    const snapshot = (overrides: Snapshot["courseOverrides"] = [], awaitingCourseChoice = false) =>
      ({ sources: store.sources(), resources: store.resources(), courseOverrides: overrides, consents: [], ingestionSettings: { awaitingCourseChoice } }) as unknown as Snapshot;
    const choices = courseChoices(snapshot());
    assert.deepEqual(choices.map((c) => [c.courseId, c.group, c.checked]), [
      ["101", "this-term", true],
      ["102", "this-term", true],
      ["202", "other", false],
      ["203", "other", false],
      ["201", "other", false],
    ]);
    const account = choices[0]!.accountScope;
    const toggled = courseChoices(snapshot([
      { accountScope: account, courseId: "101", included: false },
      { accountScope: account, courseId: "201", included: true },
    ]));
    assert.equal(toggled.find((c) => c.courseId === "101")!.checked, false);
    assert.equal(toggled.find((c) => c.courseId === "201")!.checked, true);
    const agreed = (value: boolean) => (records: unknown, recipient: unknown) => value && recipient === "uw" && !!records;
    const progress = { ...emptyProgress, uw: "confirmed" as const };
    assert.equal(firstIncompleteStep(snapshot([], true), progress, agreed(true)), "courses");
    assert.notEqual(firstIncompleteStep(snapshot([], false), progress, agreed(true)), "courses");
  } finally {
    store.close();
  }
});

test("the hold: set before the course lists are read; background and launch sign-in (manual) never read content; only the confirmation releases it", async () => {
  let heldWhenListed: boolean[] = [];
  let w!: ReturnType<typeof workspace>;
  const mock = canvas({ onCourseList: () => heldWhenListed.push(w.store.ingestionSettings().awaitingCourseChoice) });
  w = workspace(mock);
  const ingestion = w.make();
  try {
    await ingestion.discover();
    assert.ok(heldWhenListed.length && heldWhenListed.every(Boolean), "held before the course lists were read");
    assert.equal(w.store.ingestionSettings().awaitingCourseChoice, true);
    w.clock.at = new Date(w.clock.at.getTime() + 60_000);
    assert.equal(await ingestion.tick("background"), undefined);
    // The launch sign-in (main.ts D33) posts \`refresh\`, which is tick("manual"): it re-lists only.
    heldWhenListed = [];
    await ingestion.tick("manual");
    assert.ok(heldWhenListed.length > 0, "the launch path re-read the course lists");
    assert.deepEqual(mock.contentReads(), [], "no course content before the student confirms");
    assert.equal(w.store.ingestionSettings().awaitingCourseChoice, true, "a plain manual tick keeps the hold");
    // The student unchecks 102 and presses Start syncing.
    const account = w.store.sources().find((s) => s.scope === "course")!.accountScope;
    w.store.setCourseOverride({ accountScope: account, courseId: "102", included: false });
    await ingestion.confirmCourses();
    assert.equal(w.store.ingestionSettings().awaitingCourseChoice, false);
    assert.deepEqual(mock.contentReads(), ["101"], "only the checked current course was read");
    // Re-including resumes it; its coursework is stored.
    w.store.setCourseOverride({ accountScope: account, courseId: "102", included: true });
    w.clock.at = new Date(w.clock.at.getTime() + 7 * 3600_000);
    await ingestion.tick("manual");
    const stored = w.store.resources().filter((r) => r.courseId === "102" && r.kind === "assignment").length;
    assert.ok(stored > 0, "the re-included course's assignments were stored");
    // Excluding it again stops its refresh and keeps what was stored.
    w.store.setCourseOverride({ accountScope: account, courseId: "102", included: false });
    const afterExclude = mock.calls.length;
    w.clock.at = new Date(w.clock.at.getTime() + 7 * 3600_000);
    await ingestion.tick("manual");
    assert.ok(!mock.calls.slice(afterExclude).some((u) => /\/courses\/102(?:\/|$)/.test(u.pathname)), "an excluded course is not refreshed");
    assert.equal(w.store.resources().filter((r) => r.courseId === "102" && r.kind === "assignment").length, stored, "its evidence is kept");
  } finally {
    await ingestion.stop();
    w.close();
  }
});

test("a background tick during discovery reads no course content", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const mock = canvas({ gate });
  const w = workspace(mock);
  const ingestion = w.make();
  try {
    const discovering = ingestion.discover();
    await new Promise((resolve) => setTimeout(resolve, 20));
    w.clock.at = new Date(w.clock.at.getTime() + 60_000);
    assert.equal(await ingestion.tick("background"), undefined);
    release();
    await discovering;
    assert.deepEqual(mock.contentReads(), []);
  } finally {
    release();
    await ingestion.stop();
    w.close();
  }
});

test("the hold survives a restart; nothing listable sets no hold", async () => {
  const mock = canvas();
  const w = workspace(mock);
  let ingestion = w.make();
  try {
    await ingestion.discover();
    await ingestion.stop();
    ingestion = w.make(); // the app restarted mid-onboarding
    w.clock.at = new Date(w.clock.at.getTime() + 60_000);
    assert.equal(await ingestion.tick("background"), undefined);
    await ingestion.tick("manual");
    assert.deepEqual(mock.contentReads(), []);
    await ingestion.confirmCourses();
    assert.ok(mock.contentReads().length > 0);
  } finally {
    await ingestion.stop();
    w.close();
  }
  const empty = canvas({ active: [], completed: [courses.completed, courses.nameless] });
  const w2 = workspace(empty);
  const second = w2.make();
  try {
    await second.discover();
    assert.equal(w2.store.ingestionSettings().awaitingCourseChoice, false, "no choice to make, no hold");
  } finally {
    await second.stop();
    w2.close();
  }
});

test("stored nameless rows: a named earlier version is restored (never deleted); only a never-named row with no other source is retired", async () => {
  const mock = canvas({ active: [courses.current], completed: [] });
  const w = workspace(mock);
  const ingestion = w.make();
  const scope = "legacy-account";
  const courseBatch = (id: string, name: string, restricted: boolean, at: string) => ({
    source: { id: `canvas:${scope}:${id}:course`, label: `${name} · course`, kind: "canvas", accountScope: scope, courseId: id, scope: "course" },
    observedAt: at, status: restricted ? "inaccessible" : "ok", complete: !restricted,
    resources: [{ externalId: id, kind: "course", courseId: id, courseName: name, title: name, url: `${origin}/courses/${id}`, text: "", deadlines: [],
      course: restricted
        ? { accessRestricted: true, accessState: "date_restricted", selection: { score: -1, included: false, reasons: [] } }
        : { courseCode: "SP26 SYNTH 250 001", termName: "Spring 2025-2026", accessState: "open", selection: { score: 5.5, included: true, reasons: ["This term"] } } }],
  }) as never;
  try {
    // 501: a real course (with coursework) whose row a later nameless observation overwrote.
    w.store.ingest(courseBatch("501", "SYNTH 250: Real course", false, "2026-05-01T00:00:00.000Z"));
    w.store.ingest({ source: { id: `canvas:${scope}:501:assignments`, label: "SYNTH 250 · assignments", kind: "canvas", accountScope: scope, courseId: "501", scope: "assignments" },
      observedAt: "2026-05-01T00:00:00.000Z", status: "ok", complete: true,
      resources: [{ externalId: "5010", kind: "assignment", courseId: "501", courseName: "SYNTH 250: Real course", title: "Final project", url: `${origin}/courses/501/assignments/5010`, text: "Build it.", deadlines: [] }] } as never);
    w.store.ingest(courseBatch("501", "Course 501 (name unavailable)", true, "2026-09-20T00:00:00.000Z"));
    // 502: never named, with a sibling source. 503: never named, alone.
    w.store.ingest(courseBatch("502", "Course 502 (name unavailable)", true, "2026-09-20T00:00:00.000Z"));
    w.store.ingest({ source: { id: `canvas:${scope}:502:announcements`, label: "502 · announcements", kind: "canvas", accountScope: scope, courseId: "502", scope: "announcements" },
      observedAt: "2026-09-20T00:00:00.000Z", status: "ok", complete: true,
      resources: [{ externalId: "5020", kind: "message", courseId: "502", courseName: "Course 502 (name unavailable)", title: "Welcome", url: `${origin}/courses/502/discussion_topics/5020`, text: "Hi.", deadlines: [] }] } as never);
    w.store.ingest(courseBatch("503", "Course 503 (name unavailable)", true, "2026-09-20T00:00:00.000Z"));
    await ingestion.discover();
    const row = (id: string) => w.store.resources().find((r) => r.kind === "course" && r.courseId === id);
    assert.equal(row("501")?.courseName, "SYNTH 250: Real course", "the named version is current again");
    assert.equal(row("501")?.course?.selection?.included, false, "restored, not re-included");
    assert.ok(w.store.resources().some((r) => r.courseId === "501" && r.kind === "assignment"), "its coursework is untouched");
    assert.ok(row("502"), "a never-named row with other sources is kept");
    assert.ok(w.store.resources().some((r) => r.courseId === "502" && r.kind === "message"));
    assert.equal(row("503"), undefined, "a never-named row with nothing else is retired");
    assert.ok(!courseChoices({ sources: w.store.sources(), resources: w.store.resources(), courseOverrides: [] } as unknown as Snapshot).some((c) => ["501", "502", "503"].includes(c.courseId)));
  } finally {
    await ingestion.stop();
    w.close();
  }
});
