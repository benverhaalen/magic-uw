import test from "node:test";
import assert from "node:assert/strict";
import {
  extractDeadlineMentions,
  resolveDeadline,
  validateDeadlineSpan,
  zonedTimeToUtc,
  type ExtractionAnchors,
} from "@magic/domain";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import {
  captureBatchSchema,
  type DeadlineEvidenceClaim,
} from "@magic/contracts";
import fixture from "../fixtures/course.json";

// Fall 2026 at UW: 9/2/2026 through 12/19/2026 (Central).
const term = { start: "2026-09-02T05:00:00Z", end: "2026-12-20T06:00:00Z" };
const extract = (text: string, anchors: ExtractionAnchors = { term }, field: "text" | "title" = "text") =>
  extractDeadlineMentions({ resourceId: "r1", version: 3, contentHash: "abc", field, text }, anchors);
const only = (text: string, anchors?: ExtractionAnchors) => {
  const found = extract(text, anchors);
  assert.equal(found.length, 1, `expected one mention in ${JSON.stringify(text)}, got ${found.length}`);
  return found[0]!;
};

test("Chicago wall time converts across DST", () => {
  assert.equal(zonedTimeToUtc(2026, 9, 25, 23, 59), "2026-09-26T04:59:00.000Z");
  assert.equal(zonedTimeToUtc(2026, 12, 10, 12, 0), "2026-12-10T18:00:00.000Z");
});

test("realistic prose varieties resolve with kind, precision, and year inference from the term", () => {
  const cases: Array<[string, string, string | null, string?]> = [
    ["HW3 due Fri 9/25 11:59pm", "due", "2026-09-26T04:59:00.000Z"],
    ["Problem Set 2 is due Friday, September 25th at 11:59 PM.", "due", "2026-09-26T04:59:00.000Z"],
    ["Submit your lab report by 5 p.m. on Oct. 9.", "due", "2026-10-09T22:00:00.000Z"],
    ["Deadline: 2026-10-16 23:59", "due", "2026-10-17T04:59:00.000Z"],
    ["The final paper must be turned in by noon on December 10, 2026.", "due", "2026-12-10T18:00:00.000Z"],
    ["Project 1 due 10/2 at 9:00 ET", "due", "2026-10-02T13:00:00.000Z"],
    ["Week 5 | 9/30 | Essay draft due", "due", null, "day"],
  ];
  for (const [text, kind, value, precision] of cases) {
    const m = only(text);
    assert.equal(m.kind, kind, text);
    if (value) assert.equal(m.value, value, text);
    if (precision) assert.equal(m.precision, precision, text);
    assert.equal(m.span.text, text.trim(), text);
    if (!/2026/.test(text)) assert.equal(m.inference, "year_from_term", text);
    else assert.equal(m.inference, undefined, text);
  }
});

test("late-until, closes, and exam are distinguished from due", () => {
  const [due, late] = extract(
    "HW3 is due 9/25 at 11:59pm and late submissions accepted until 9/27 at 11:59pm.",
  );
  assert.equal(due!.kind, "due");
  assert.equal(late!.kind, "lock");
  assert.equal(late!.detail, "late_until");
  assert.equal(late!.value, "2026-09-28T04:59:00.000Z");
  const closes = only("The Canvas quiz closes Oct 5 at 8am.");
  assert.equal(closes.kind, "lock");
  assert.equal(closes.detail, "closes");
  const exam = only("Midterm exam: Wednesday, October 14, in class.");
  assert.equal(exam.kind, "event");
  assert.equal(exam.detail, "exam");
  assert.equal(exam.precision, "day");
  assert.match(exam.note!, /in class/);
});

test("“start of lecture” and midnight keep the day without inventing a clock time", () => {
  const lecture = only("Homework is due by the start of lecture on Oct 3.");
  assert.equal(lecture.precision, "day");
  assert.equal(lecture.value, "2026-10-03T05:00:00.000Z");
  assert.match(lecture.note!, /start of lecture/);
  const midnight = only("Reading response due at midnight on 10/7.");
  assert.equal(midnight.precision, "day");
  assert.match(midnight.note!, /Midnight/);
});

test("ambiguous and relative dates abstain without an anchor", () => {
  const noYear = only("Due 10/3 at 11:59pm", {});
  assert.equal(noYear.value, null);
  assert.match(noYear.unresolvedReason!, /No year/);
  const weekday = only("Reminder: Project 2 is due Friday at 5pm.", { term });
  assert.equal(weekday.value, null);
  assert.match(weekday.unresolvedReason!, /weekday/i);
  const vague = only("Quiz 3 due next week.");
  assert.equal(vague.value, null);
  const nextFri = only("HW5 due next Friday.", { statedAt: "2026-09-22T15:00:00Z" });
  assert.equal(nextFri.value, null);
  const mismatch = only("HW3 due Fri 9/26 11:59pm"); // 9/26/2026 is a Saturday
  assert.equal(mismatch.value, null);
  assert.match(mismatch.unresolvedReason!, /weekday does not match/);
  const outside = only("Essay due 3/4 at noon.");
  assert.equal(outside.value, null, "March is outside a fall term");
  const tomorrow = only("The lab is due tomorrow at 11:59pm.", {});
  assert.equal(tomorrow.value, null);
});

test("announcement post time anchors weekday and relative days", () => {
  const posted = "2026-09-22T15:00:00Z"; // Tuesday in Chicago
  const fri = only("Reminder: Project 2 is due Friday at 5pm.", { statedAt: posted });
  assert.equal(fri.value, "2026-09-25T22:00:00.000Z");
  assert.equal(fri.inference, "relative_to_post");
  const tmr = only("The lab is due tomorrow at 11:59pm.", { statedAt: posted });
  assert.equal(tmr.value, "2026-09-24T04:59:00.000Z");
  const same = only("HW due Tuesday at 5pm.", { statedAt: posted });
  assert.equal(same.value, null, "same weekday as the post is ambiguous");
  const fromSource = only("Due 10/3 at 11:59pm", { sourceDate: "2026-09-10T12:00:00Z" });
  assert.equal(fromSource.inference, "year_from_source_date");
  assert.equal(fromSource.value, "2026-10-04T04:59:00.000Z");
});

test("no false positives on chapters, scores, point values, or undated keywords", () => {
  for (const text of [
    "Read Chapter 9/26 before class.",
    "You scored 9/26 on the quiz.",
    "HW3 (10 points) is due soon; see section 3/4.",
    "Problems 3/4 and 5/6 are due with the next homework.",
    "Grades: 18/20 points on HW2.",
    "Office hours 3-4pm in room 1240.",
    "Lecture notes 9/26 are posted.",
    "You may 3D print your project.",
    "There is no exam on 10/14.",
  ])
    assert.deepEqual(
      extract(text).filter((m) => m.value || m.unresolvedReason),
      [],
      text,
    );
});

test("an extension sentence pairs the replaced date with the change", () => {
  const found = extract("HW3 deadline extended from Fri 9/25 to Mon 9/28 at 11:59pm.");
  const change = found.find((m) => !m.previous)!;
  const old = found.find((m) => m.previous)!;
  assert.equal(change.change, true);
  assert.equal(change.value, "2026-09-29T04:59:00.000Z");
  assert.equal(change.supersedes, old.value);
  const instead = extract("HW4 is now due 10/5 at 11:59 pm instead of 10/3.");
  assert.equal(instead.find((m) => !m.previous)!.supersedes, "2026-10-03T05:00:00.000Z");
});

test("spans are literal slices validated against the exact source version", () => {
  const text = "Intro paragraph.\nHW3 due Fri 9/25 11:59pm. Late work accepted until 9/27 at noon.";
  const resource = { id: "r1", version: 3, contentHash: "abc", title: "HW3", text };
  const found = extract(text);
  assert.equal(found.length, 2);
  for (const m of found) {
    assert.ok(validateDeadlineSpan(resource, m.span));
    assert.equal(text.slice(m.span.start, m.span.end), m.span.text);
    assert.equal(text.slice(m.match.start, m.match.end), m.match.text);
  }
  const span = found[0]!.span;
  assert.equal(validateDeadlineSpan({ ...resource, version: 4 }, span), false);
  assert.equal(validateDeadlineSpan({ ...resource, contentHash: "zzz" }, span), false);
  assert.equal(validateDeadlineSpan({ ...resource, text: text.replace("9/25", "9/24") }, span), false);
  assert.equal(validateDeadlineSpan(resource, { ...span, start: span.start + 1 }), false);
  assert.equal(validateDeadlineSpan(resource, { ...span, field: "title" }), false);
});

// ------------------------------------------------------------ resolver hierarchy
const claim = (
  value: string,
  origin: DeadlineEvidenceClaim["origin"],
  extra: Partial<DeadlineEvidenceClaim> = {},
): DeadlineEvidenceClaim => ({
  value,
  kind: "due",
  quote: "fixture",
  authority: origin === "title" ? "title" : origin === "canvas" || origin === "calendar" ? "structured" : "document",
  scopeConfirmed: true,
  origin,
  ...extra,
});

test("canvas outranks lower tiers but disagreement stays a visible conflict with conservative planning", () => {
  const r = resolveDeadline([
    claim("2026-09-26T04:59:00Z", "canvas"),
    claim("2026-09-25T04:59:00Z", "syllabus", { inference: "year_from_term" }),
    claim("2026-09-26T04:59:00Z", "title"),
  ]);
  assert.equal(r.conflict, true);
  assert.equal(r.dueAt, null);
  assert.equal(r.preferredAt, "2026-09-26T04:59:00.000Z");
  assert.equal(r.basis, "canvas");
  assert.equal(r.planningAt, "2026-09-25T04:59:00.000Z");
  assert.ok(r.notes!.some((n) => /Disagrees: syllabus/.test(n)));
  assert.ok(r.notes!.some((n) => /Year inferred from the course term/.test(n)));
});

test("agreeing tiers establish the due date; a day-only claim agrees on the same Chicago day", () => {
  const r = resolveDeadline([
    claim("2026-10-03T04:59:00Z", "canvas"),
    claim("2026-10-02T05:00:00Z", "assignment_text", { precision: "day" }),
    claim("2026-10-03T04:59:00Z", "title"),
  ]);
  assert.equal(r.conflict, false);
  assert.equal(r.dueAt, "2026-10-03T04:59:00.000Z");
  assert.equal(r.planningAt, "2026-10-03T04:59:00.000Z");
  const dayOnly = resolveDeadline([claim("2026-10-03T05:00:00Z", "assignment_text", { precision: "day" })]);
  assert.equal(dayOnly.dueAt, null);
  assert.equal(dayOnly.planningAt, "2026-10-03T05:00:00.000Z");
  assert.match(dayOnly.reason, /no time of day/);
});

test("an explicit change supersedes lower tiers with notes, but not Canvas", () => {
  const change = claim("2026-09-29T04:59:00Z", "announcement", {
    authority: "explicit_change",
    supersedes: "2026-09-25T05:00:00.000Z",
    statedAt: "2026-09-23T14:00:00Z",
  });
  const withoutCanvas = resolveDeadline([
    change,
    claim("2026-09-26T04:59:00Z", "syllabus"),
    claim("2026-09-26T04:59:00Z", "title"),
  ]);
  assert.equal(withoutCanvas.conflict, false);
  assert.equal(withoutCanvas.dueAt, "2026-09-29T04:59:00.000Z");
  assert.equal(withoutCanvas.basis, "explicit_change");
  assert.equal(withoutCanvas.notes!.filter((n) => n.startsWith("Superseded")).length, 2);

  const stale = resolveDeadline([claim("2026-09-26T04:59:00Z", "canvas"), change]);
  assert.equal(stale.conflict, true);
  assert.equal(stale.dueAt, null);
  assert.equal(stale.planningAt, "2026-09-26T04:59:00.000Z");
  assert.ok(stale.notes!.some((n) => /Canvas still lists .* the date an announced change moved/.test(n)));

  const updated = resolveDeadline([claim("2026-09-29T04:59:00Z", "canvas"), change]);
  assert.equal(updated.conflict, false);
  assert.equal(updated.dueAt, "2026-09-29T04:59:00.000Z");
});

test("a later announced change replaces an earlier one only when post order is known", () => {
  const first = claim("2026-09-29T04:59:00Z", "announcement", { authority: "explicit_change", statedAt: "2026-09-23T14:00:00Z" });
  const second = claim("2026-10-01T04:59:00Z", "announcement", { authority: "explicit_change", statedAt: "2026-09-27T14:00:00Z" });
  const ordered = resolveDeadline([first, second]);
  assert.equal(ordered.dueAt, "2026-10-01T04:59:00.000Z");
  assert.equal(ordered.conflict, false);
  const unordered = resolveDeadline([{ ...first, statedAt: undefined }, second]);
  assert.equal(unordered.conflict, true);
  assert.equal(unordered.planningAt, "2026-09-29T04:59:00.000Z");
});

test("unconfirmed and unresolved mentions are explained but never used", () => {
  const r = resolveDeadline(
    [claim("2026-09-20T04:59:00Z", "page", { scopeConfirmed: false })],
    [
      {
        kind: "due",
        origin: "announcement",
        reason: "A weekday without a date.",
        span: { resourceId: "a", version: 1, contentHash: "h", field: "text", start: 0, end: 10, text: "due Friday" },
      },
    ],
  );
  assert.equal(r.planningAt, null);
  assert.match(r.reason, /cannot be determined/);
  assert.ok(r.notes!.some((n) => /Not used/.test(n)));
  assert.ok(r.notes!.some((n) => /Unresolved due mention/.test(n)));
});

// ------------------------------------------------------------ end to end through the store and snapshot
const course = { courseId: "101", courseName: "COMP SCI 400" };
const origin = "https://canvas.wisc.edu/courses/101";
function batch(scope: string, resources: unknown[], observedAt = "2026-09-24T12:00:00Z") {
  return {
    source: { id: `canvas:acct:101:${scope}`, label: `Canvas ${scope}`, kind: "canvas", accountScope: "acct", ...{ courseId: "101" }, scope },
    observedAt,
    complete: true,
    status: "ok",
    resources,
  };
}
test("an extension announcement surfaces as a change/conflict with literal evidence in the snapshot", () => {
  const store = createStore(":memory:");
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture) });
  store.ingest(
    batch("course", [
      { externalId: "course", kind: "course", ...course, title: "COMP SCI 400", url: origin, text: "", course: { termName: "Fall 2026" } },
    ]),
  );
  store.ingest(
    batch("assignments", [
      {
        externalId: "a3", kind: "assignment", ...course, title: "HW3: Recursion", url: `${origin}/assignments/3`,
        text: "Implement the recursive solver. Due Fri 9/25 at 11:59pm. Late submissions accepted until 9/27 at 11:59pm.",
        updatedAt: "2026-09-01T12:00:00Z",
        deadlines: [{ value: "2026-09-26T04:59:00Z", kind: "due", quote: "due_at: 2026-09-26T04:59:00Z", authority: "structured", scopeConfirmed: true }],
      },
      {
        externalId: "a4", kind: "assignment", ...course, title: "HW4: Trees", url: `${origin}/assignments/4`,
        text: "Due with no date listed yet.", deadlines: [],
      },
    ]),
  );
  store.ingest(
    batch("announcements", [
      {
        externalId: "n1", kind: "message", ...course, title: "HW3 extended", url: `${origin}/discussion_topics/9`,
        text: "Because of the server outage, the deadline has been extended from Fri 9/25 to Mon 9/28 at 11:59pm. HW4 will be due next week.",
        createdAt: "2026-09-23T14:00:00Z",
      },
    ]),
  );
  store.ingest(
    batch("syllabus", [
      {
        externalId: "syllabus", kind: "material", ...course, title: "Syllabus", url: `${origin}/assignments/syllabus`,
        text: "Week 4 | 9/25 | HW3 due\nWeek 5 | 10/2 | HW4 due at 11:59pm\nChapter 9/26 reading",
      },
    ]),
  );
  const resources = core.snapshot().resources;
  const hw3 = resources.find((r) => r.externalId === "a3")!;
  const d = hw3.deadline;
  // Canvas still shows the old date: conflict, planning on the earlier date, change explained.
  assert.equal(d.conflict, true);
  assert.equal(d.dueAt, null);
  assert.equal(d.planningAt, "2026-09-26T04:59:00.000Z");
  assert.equal(d.basis, "canvas");
  const change = d.claims.find((c) => c.authority === "explicit_change")!;
  assert.equal(change.origin, "announcement");
  assert.equal(change.value, "2026-09-29T04:59:00.000Z");
  assert.equal(change.statedAt, "2026-09-23T14:00:00Z");
  assert.match(change.note!, /announcement title/);
  const announcement = store.resources().find((r) => r.externalId === "n1")!;
  assert.ok(validateDeadlineSpan(announcement, change.span!));
  assert.ok(d.notes!.some((n) => /Canvas still lists/.test(n)));
  assert.ok(d.notes!.some((n) => /Superseded: syllabus/.test(n)), "stale syllabus row is superseded, not silently dropped");
  assert.equal(d.lockAt, "2026-09-28T04:59:00.000Z");
  assert.ok(d.claims.some((c) => c.origin === "assignment_text" && c.kind === "lock" && c.detail === "late_until"));

  // HW4: syllabus is the only dated source; the announcement's "next week" stays unresolved.
  const hw4 = resources.find((r) => r.externalId === "a4")!.deadline;
  assert.equal(hw4.dueAt, "2026-10-03T04:59:00.000Z");
  assert.equal(hw4.basis, "syllabus");
  assert.equal(hw4.claims[0]!.inference, "year_from_term");
  assert.equal(hw4.unresolved!.length, 1);
  assert.match(hw4.unresolved![0]!.reason, /next week/);

  // When Canvas is updated to the announced date, the change no longer conflicts.
  store.ingest(
    batch("assignments", [
      {
        externalId: "a3", kind: "assignment", ...course, title: "HW3: Recursion", url: `${origin}/assignments/3`,
        text: "Implement the recursive solver.",
        deadlines: [{ value: "2026-09-29T04:59:00Z", kind: "due", quote: "due_at", authority: "structured", scopeConfirmed: true }],
      },
      { externalId: "a4", kind: "assignment", ...course, title: "HW4: Trees", url: `${origin}/assignments/4`, text: "", deadlines: [] },
    ], "2026-09-25T12:00:00Z"),
  );
  const after = core.snapshot().resources.find((r) => r.externalId === "a3")!.deadline;
  assert.equal(after.conflict, false);
  assert.equal(after.dueAt, "2026-09-29T04:59:00.000Z");
  core.close?.();
  store.close();
});

test("title dates are lowest authority, and prose never crosses courses or other assignments", () => {
  const store = createStore(":memory:");
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture) });
  store.ingest(
    batch("course", [
      { externalId: "course", kind: "course", ...course, title: "COMP SCI 400", url: origin, text: "", course: { termName: "Fall 2026" } },
    ]),
  );
  store.ingest(
    batch("assignments", [
      { externalId: "l2", kind: "assignment", ...course, title: "Lab 2 (due Oct 9 at 5pm)", url: `${origin}/assignments/20`, text: "Build the parser.", deadlines: [] },
      { externalId: "h3", kind: "assignment", ...course, title: "HW3", url: `${origin}/assignments/3`, text: "HW2 was due 9/18 at 11:59pm; this one builds on it.", deadlines: [] },
      { externalId: "p1", kind: "assignment", ...course, title: "Project 1 Proposal", url: `${origin}/assignments/31`, text: "", deadlines: [] },
      { externalId: "p1b", kind: "assignment", ...course, title: "Project 1 Final", url: `${origin}/assignments/32`, text: "", deadlines: [] },
    ]),
  );
  // Another course's announcement names HW3 with a date; it must not apply.
  store.ingest({
    ...batch("announcements", [
      { externalId: "x1", kind: "message", courseId: "202", courseName: "MATH 340", title: "HW3", url: "https://canvas.wisc.edu/courses/202/discussion_topics/1", text: "HW3 is due Oct 1 at 11:59pm.", createdAt: "2026-09-20T12:00:00Z" },
    ]),
    source: { id: "canvas:acct:202:announcements", label: "Canvas", kind: "canvas", accountScope: "acct", courseId: "202", scope: "announcements" },
  });
  // Same course, but "Project 1" is shared by two assignments: not unique, so not applied.
  store.ingest(
    batch("announcements", [
      { externalId: "n2", kind: "message", ...course, title: "Reminders", url: `${origin}/discussion_topics/12`, text: "Project 1 is due Oct 20 at 11:59pm.", createdAt: "2026-09-20T12:00:00Z" },
    ]),
  );
  const rows = core.snapshot().resources;
  const lab = rows.find((r) => r.externalId === "l2")!.deadline;
  assert.equal(lab.dueAt, "2026-10-09T22:00:00.000Z");
  assert.equal(lab.basis, "title");
  assert.equal(lab.claims[0]!.authority, "title");
  assert.equal(lab.claims[0]!.span!.field, "title");
  assert.match(lab.reason, /lowest authority/);
  const hw3 = rows.find((r) => r.externalId === "h3")!.deadline;
  assert.equal(hw3.claims.length, 0, "HW2's date and the other course's HW3 date do not apply");
  assert.equal(hw3.planningAt, null);
  for (const id of ["p1", "p1b"])
    assert.equal(rows.find((r) => r.externalId === id)!.deadline.claims.length, 0);
  store.close();
});
