import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNotifications,
  NOTIFICATION_RULES,
  resolveDeadline,
  type NotificationInput,
} from "@magic/domain";
import type {
  DeadlineClaim,
  MailKind,
  MailMetadata,
  MailTriageJudgment,
  MessageKind,
  MessageTriageJudgment,
  ResourceChange,
  ResourceView,
  SourceHealth,
} from "@magic/contracts";

// Synthetic data only. Monday Sep 28 2026, noon in Seattle.
const NOW = "2026-09-28T19:00:00.000Z";
const TZ = "America/Los_Angeles";
const H = 3600000;
const at = (hours: number) => new Date(Date.parse(NOW) + hours * H).toISOString();
const dueClaim = (value: string, kind: DeadlineClaim["kind"] = "due"): DeadlineClaim => ({
  value,
  kind,
  quote: "fixture",
  authority: "structured",
  scopeConfirmed: true,
});

function resource(id: string, over: Partial<ResourceView> & { due?: string | null } = {}): ResourceView {
  const { due, ...rest } = over;
  const deadlines = rest.deadlines ?? (due ? [dueClaim(due)] : []);
  const base = {
    id,
    externalId: `x-${id}`,
    kind: "assignment" as const,
    courseId: "bio180",
    courseName: "BIOL 180",
    title: `Item ${id}`,
    url: `https://canvas.example.edu/courses/1/items/${id}`,
    text: "",
    deadlines,
    points: null,
    submitted: null,
    policy: { mode: "unknown" as const, evidence: "" },
    sourceId: "src-bio",
    contentHash: "h",
    version: 1,
    observedAt: at(-1),
    capturedAt: at(-1),
    deleted: false,
    completed: false,
    kindLabel: null,
    ...(due !== undefined && due !== null ? { dueAt: due } : {}),
    ...rest,
  };
  return { ...base, deadlines, deadline: resolveDeadline(deadlines) } as ResourceView;
}

let seq = 0;
function change(
  resourceId: string,
  type: ResourceChange["type"],
  oldValues: Record<string, unknown> = {},
  newValues: Record<string, unknown> = {},
  over: Partial<ResourceChange> = {},
): ResourceChange {
  seq++;
  return {
    id: `c${String(seq).padStart(3, "0")}`,
    resourceId,
    sourceId: "src-bio",
    accountScope: "uw",
    courseId: "bio180",
    scope: "course",
    readId: "read-2",
    observedAt: at(-2),
    type,
    oldValues,
    newValues,
    ...over,
  };
}

function source(over: Partial<SourceHealth> = {}): SourceHealth {
  return {
    id: "src-bio",
    label: "BIOL 180",
    kind: "canvas",
    accountScope: "uw",
    courseId: "bio180",
    scope: "course",
    status: "ok",
    lastAttemptAt: at(-1),
    lastSuccessAt: at(-1),
    complete: true,
    resourceCount: 1,
    ...over,
  };
}

function build(over: Partial<NotificationInput> = {}) {
  return buildNotifications({
    changes: [],
    resources: [],
    sources: [source()],
    baselineReadIds: ["read-1"],
    included: () => true,
    triage: {},
    mailTriage: {},
    triageStatus: { status: "on", reason: "Ready." },
    state: { readIds: [], dismissedIds: [] },
    now: NOW,
    timeZone: TZ,
    ...over,
  });
}
const only = (feed: ReturnType<typeof build>) => {
  assert.equal(feed.items.length, 1, JSON.stringify(feed.items, null, 1));
  return feed.items[0]!;
};

function judgment(
  kind: MessageKind,
  p: number,
  extra: { runnerUp?: number; actionRequired?: number; affects?: Record<string, number>; upcoming?: MessageTriageJudgment["upcoming"] } = {},
): MessageTriageJudgment {
  const kinds: MessageKind[] = [
    "deadline_or_schedule_change",
    "exam_logistics",
    "action_required",
    "grade_or_feedback_released",
    "new_material_posted",
    "general_information",
    "other",
  ];
  const runner = extra.runnerUp ?? 0;
  const rest = (1 - p - runner) / (kinds.length - 2);
  const other = kinds.find((k) => k !== kind)!;
  const kindProbabilities = Object.fromEntries(
    kinds.map((k) => [k, k === kind ? p : k === other ? runner : rest]),
  ) as Record<MessageKind, number>;
  return {
    result: {
      kind,
      kindProbabilities,
      actionRequired: extra.actionRequired ?? 0.1,
      affects: extra.affects ?? {},
      model: "jev-test",
      questionVersion: "message.triage.v1",
    },
    upcoming: extra.upcoming ?? [],
  };
}

// ── baseline and scope ──────────────────────────────────────────────────────────────────────

test("first-import baseline produces zero notifications", () => {
  const resources = Array.from({ length: 30 }, (_, i) => resource(`a${i}`, { due: at(24 + i) }));
  const changes = resources.map((r) => change(r.id, "new", {}, { title: r.title }, { readId: "read-1" }));
  const msgs = [resource("m1", { kind: "message", text: "Exam moved to Friday." })];
  changes.push(change("m1", "new", {}, {}, { readId: "read-1" }));
  const feed = build({ resources: [...resources, ...msgs], changes });
  assert.deepEqual(feed.items, []);
  assert.equal(feed.unread, 0);
  assert.equal(feed.degraded, false);
});

test("backfill guard: old createdAt or past due suppresses a later 'new'", () => {
  const old = resource("a1", { due: at(24), createdAt: at(-24 * 30) });
  const pastDue = resource("a2", { due: at(-5) });
  const feed = build({
    resources: [old, pastDue],
    changes: [change("a1", "new"), change("a2", "new")],
  });
  assert.deepEqual(feed.items, []);
});

test("excluded course is suppressed", () => {
  const r = resource("a1", { due: at(24), courseId: "hidden" });
  const feed = build({
    resources: [r],
    changes: [change("a1", "date_changed", { dueAt: at(48) }, { dueAt: at(24) })],
    included: (x) => x.courseId !== "hidden",
  });
  assert.deepEqual(feed.items, []);
});

test("changes for missing resources and outside the window are skipped", () => {
  const r = resource("a1", { due: at(24) });
  const feed = build({
    resources: [r],
    changes: [
      change("ghost", "date_changed", { dueAt: at(48) }, { dueAt: at(24) }),
      change("a1", "date_changed", { dueAt: at(48) }, { dueAt: at(24) }, { observedAt: at(-24 * 8) }),
    ],
  });
  assert.deepEqual(feed.items, []);
});

// ── due dates, cutoffs, instructions ─────────────────────────────────────────────────────────

const dueTable: {
  name: string;
  changes: [Record<string, unknown>, Record<string, unknown>][];
  due: string | null;
  expect: null | { level: string; reason: string };
}[] = [
  { name: "moved earlier", changes: [[{ dueAt: at(96) }, { dueAt: at(48) }]], due: at(48), expect: { level: "urgent", reason: "due_earlier" } },
  { name: "moved later", changes: [[{ dueAt: at(48) }, { dueAt: at(96) }]], due: at(96), expect: { level: "important", reason: "due_later" } },
  { name: "added", changes: [[{ dueAt: null }, { dueAt: at(96) }]], due: at(96), expect: { level: "important", reason: "due_added" } },
  { name: "removed", changes: [[{ dueAt: at(96) }, {}]], due: null, expect: { level: "important", reason: "due_removed" } },
  {
    name: "moved and back",
    changes: [
      [{ dueAt: at(96) }, { dueAt: at(48) }],
      [{ dueAt: at(48) }, { dueAt: at(96) }],
    ],
    due: at(96),
    expect: null,
  },
  {
    name: "net over window uses first old and last new",
    changes: [
      [{ dueAt: at(96) }, { dueAt: at(120) }],
      [{ dueAt: at(120) }, { dueAt: at(50) }],
    ],
    due: at(50),
    expect: { level: "urgent", reason: "due_earlier" },
  },
  {
    name: "deadline claims moved earlier",
    changes: [[{ deadlines: [dueClaim(at(96))] }, { deadlines: [dueClaim(at(30))] }]],
    due: at(30),
    expect: { level: "urgent", reason: "due_earlier" },
  },
];
for (const row of dueTable)
  test(`due date: ${row.name}`, () => {
    const r = resource("a1", { due: row.due, title: "Lab report" });
    const changes = row.changes.map(([o, n], i) =>
      change("a1", "date_changed", o, n, { observedAt: at(-10 + i) }),
    );
    const feed = build({ resources: [r], changes: changes.reverse() });
    if (!row.expect) return assert.deepEqual(feed.items, []);
    const n = only(feed);
    assert.equal(n.level, row.expect.level);
    assert.equal(n.reason, row.expect.reason);
    assert.equal(n.courseName, "BIOL 180");
    assert.equal(n.changeIds.length, row.changes.length);
  });

test("due change detail shows before → after and evidence", () => {
  const before = "2026-09-30T06:59:00.000Z"; // Tue 11:59 PM PDT
  const after = "2026-09-29T06:59:00.000Z"; // Mon 11:59 PM PDT
  const n = only(
    build({
      resources: [resource("a1", { due: after })],
      changes: [change("a1", "date_changed", { dueAt: before }, { dueAt: after })],
    }),
  );
  assert.equal(n.detail, "Due date moved earlier: Tue 11:59 PM → Today 11:59 PM");
  assert.deepEqual(n.evidence, { before, after });
});

const cutoffTable = [
  { name: "earlier and within 72h", old: at(120), next: at(48), level: "urgent" },
  { name: "earlier but far", old: at(200), next: at(100), level: "important" },
  { name: "later", old: at(48), next: at(100), level: "important" },
  { name: "added within 72h", old: null, next: at(24), level: "urgent" },
  { name: "removed", old: at(48), next: null, level: "important" },
];
for (const row of cutoffTable)
  test(`late cutoff: ${row.name}`, () => {
    const n = only(
      build({
        resources: [resource("a1", { due: at(24) })],
        changes: [change("a1", "date_changed", row.old ? { lockAt: row.old } : {}, row.next ? { lockAt: row.next } : {})],
      }),
    );
    assert.equal(n.reason, "cutoff_changed");
    assert.equal(n.level, row.level);
  });

const instructionTable: { name: string; over: Partial<ResourceView> & { due?: string | null }; level: string | null }[] = [
  { name: "unsubmitted and upcoming", over: { due: at(48) }, level: "important" },
  { name: "submitted and upcoming", over: { due: at(48), submission: { workflowState: "submitted", submittedAt: at(-5) } }, level: "info" },
  { name: "past and unsubmitted", over: { due: at(-48) }, level: "info" },
  { name: "past and graded", over: { due: at(-48), submission: { workflowState: "graded", score: 9 } }, level: null },
];
for (const row of instructionTable)
  test(`instructions changed: ${row.name}`, () => {
    const feed = build({
      resources: [resource("a1", row.over)],
      changes: [change("a1", "requirements_changed", { text: "a" }, { text: "b" })],
    });
    if (row.level === null) return assert.deepEqual(feed.items, []);
    const n = only(feed);
    assert.equal(n.reason, "instructions_changed");
    assert.equal(n.level, row.level);
  });

test("past and graded suppresses date changes too", () => {
  const feed = build({
    resources: [resource("a1", { due: at(-48), submission: { workflowState: "graded", score: 9 } })],
    changes: [change("a1", "date_changed", { dueAt: at(-24) }, { dueAt: at(-48) })],
  });
  assert.deepEqual(feed.items, []);
});

test("several changes on one item merge into one notification at the highest level", () => {
  const r = resource("a1", { due: at(30) });
  const c1 = change("a1", "requirements_changed", { text: "a" }, { text: "b" }, { observedAt: at(-5) });
  const c2 = change("a1", "date_changed", { dueAt: at(96) }, { dueAt: at(30) }, { observedAt: at(-3) });
  const n = only(build({ resources: [r], changes: [c2, c1] }));
  assert.equal(n.level, "urgent");
  assert.equal(n.reason, "due_earlier");
  assert.match(n.detail!, /^Due date moved earlier: .* · Instructions updated$/);
  assert.deepEqual(n.changeIds, [c1.id, c2.id]);
  assert.equal(n.id, `due_earlier:a1:${c2.id}`);
});

// ── new assignments ────────────────────────────────────────────────────────────────────────

test("new assignment: due within 72h is urgent, later is important", () => {
  const soon = resource("a1", { due: at(24) });
  const later = resource("a2", { due: at(24 * 6) });
  const feed = build({ resources: [soon, later], changes: [change("a1", "new"), change("a2", "new")] });
  const byId = Object.fromEntries(feed.items.map((n) => [n.resourceId, n]));
  assert.equal(byId.a1!.level, "urgent");
  assert.equal(byId.a1!.reason, "new_assignment");
  assert.equal(byId.a2!.level, "important");
});

test("five or more new assignments in one course from one read group into one", () => {
  const rs = Array.from({ length: 6 }, (_, i) => resource(`a${i}`, { due: at(24 * (5 + i)) }));
  const feed = build({ resources: rs, changes: rs.map((r) => change(r.id, "new")) });
  const n = only(feed);
  assert.equal(n.reason, "new_assignments");
  assert.equal(n.title, "6 new assignments");
  assert.equal(n.count, 6);
  assert.equal(n.level, "important");
  assert.equal(n.changeIds.length, 6);

  const withSoon = [...rs.slice(0, 4), resource("s", { due: at(10) })];
  const urgent = only(build({ resources: withSoon, changes: withSoon.map((r) => change(r.id, "new")) }));
  assert.equal(urgent.reason, "new_assignments");
  assert.equal(urgent.level, "urgent");

  const four = rs.slice(0, 4);
  assert.equal(build({ resources: four, changes: four.map((r) => change(r.id, "new")) }).items.length, 4);
});

// ── grades, feedback, missing, removed ─────────────────────────────────────────────────────

const gradeTable: {
  name: string;
  points: number | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  title: string;
  reason: string;
  detail: string;
}[] = [
  { name: "score and points", points: 20, before: null, after: { workflowState: "graded", score: 18 }, title: "Research outline: 18/20", reason: "graded", detail: "Grade posted" },
  { name: "letter grade", points: null, before: null, after: { workflowState: "graded", grade: "A-" }, title: "Research outline: A-", reason: "graded", detail: "Grade posted" },
  { name: "nothing to show", points: null, before: null, after: { workflowState: "graded" }, title: "Research outline: Grade posted", reason: "graded", detail: "Grade posted" },
  {
    name: "grade with new comments",
    points: 20,
    before: { workflowState: "submitted", comments: [] },
    after: { workflowState: "graded", score: 18, comments: [{ text: "Nice" }] },
    title: "Research outline: 18/20",
    reason: "graded",
    detail: "Grade posted · New feedback",
  },
  {
    name: "only new comments",
    points: 20,
    before: { workflowState: "graded", score: 18, comments: [] },
    after: { workflowState: "graded", score: 18, comments: [{ text: "See rubric" }] },
    title: "Research outline",
    reason: "feedback",
    detail: "New feedback",
  },
];
for (const row of gradeTable)
  test(`graded: ${row.name}`, () => {
    const r = resource("a1", { title: "Research outline", due: at(-48), points: row.points, submission: row.after as never });
    const n = only(
      build({ resources: [r], changes: [change("a1", "graded", { submission: row.before }, { submission: row.after })] }),
    );
    assert.equal(n.level, "important");
    assert.equal(n.reason, row.reason);
    assert.equal(n.title, row.title);
    assert.equal(n.detail, row.detail);
  });

test("missing work is urgent current state with a stable id", () => {
  const r = resource("a1", { due: at(-30), submission: { missing: true, workflowState: "unsubmitted" } });
  const excused = resource("a2", { due: at(-30), submission: { missing: true, excused: true } });
  const turnedIn = resource("a3", { due: at(-30), submission: { missing: true, submittedAt: at(-1) } });
  const feed = build({ resources: [r, excused, turnedIn] });
  const n = only(feed);
  assert.equal(n.id, "missing:a1");
  assert.equal(n.level, "urgent");
  assert.equal(n.reason, "missing");
  assert.equal(n.observedAt, r.observedAt);
});

const removedTable = [
  { name: "upcoming unsubmitted", over: { due: at(48) }, level: "important" },
  { name: "past", over: { due: at(-48) }, level: "info" },
  { name: "submitted", over: { due: at(48), submitted: true }, level: "info" },
];
for (const row of removedTable)
  test(`removed assignment: ${row.name}`, () => {
    const r = resource("a1", { ...row.over, deleted: true });
    const n = only(build({ resources: [r], changes: [change("a1", "removed", { deleted: false }, { deleted: true })] }));
    assert.equal(n.reason, "removed");
    assert.equal(n.level, row.level);
  });

test("restored assignment is info", () => {
  const n = only(
    build({ resources: [resource("a1", { due: at(48) })], changes: [change("a1", "restored", { deleted: true }, { deleted: false })] }),
  );
  assert.equal(n.reason, "restored");
  assert.equal(n.level, "info");
});

// ── course messages and Jev ────────────────────────────────────────────────────────────────

const keywordTable = [
  { text: "Hope everyone had a good weekend. Class is cancelled on Friday due to travel. See you Monday.", quote: "Class is cancelled on Friday due to travel." },
  { text: "Reminder: the midterm covers chapters 1-4.", quote: "Reminder: the midterm covers chapters 1-4." },
  { text: "We won't meet tomorrow.", quote: "We won't meet tomorrow." },
  { text: "Section is in a new room this week!", quote: "Section is in a new room this week!" },
  { text: "The deadline was EXTENDED to Sunday.", quote: "The deadline was EXTENDED to Sunday." },
];
for (const row of keywordTable)
  test(`announcement keyword: ${row.quote}`, () => {
    const n = only(
      build({ resources: [resource("m1", { kind: "message", text: row.text })], changes: [change("m1", "new")] }),
    );
    assert.equal(n.reason, "announcement");
    assert.equal(n.level, "important");
    assert.equal(n.evidence?.quote, row.quote);
  });

test("announcement without keywords is info; 'final project' and 'examples' do not match", () => {
  for (const text of ["Slides from today are up.", "Your final project proposal template is posted.", "More examples on the page."]) {
    const n = only(build({ resources: [resource("m1", { kind: "message", text })], changes: [change("m1", "new")] }));
    assert.equal(n.level, "info", text);
    assert.equal(n.evidence, undefined);
  }
});

test("long matching sentence is cut to the quote limit", () => {
  const text = `The exam ${"will be very comprehensive and ".repeat(20)}hard.`;
  const n = only(build({ resources: [resource("m1", { kind: "message", text })], changes: [change("m1", "new")] }));
  assert.ok(n.evidence!.quote!.length <= NOTIFICATION_RULES.quoteMaxChars);
});

test("updated messages are suppressed", () => {
  const feed = build({
    resources: [resource("m1", { kind: "message", text: "Exam moved." })],
    changes: [change("m1", "updated"), change("m1", "requirements_changed", { text: "a" }, { text: "Exam moved." })],
  });
  assert.deepEqual(feed.items, []);
});

const task = resource("a9", { title: "Problem set 3", due: at(40) });
const farTask = resource("a8", { title: "Essay", due: at(24 * 6) });
const upcoming = [
  { key: "a0", resourceId: "a9", title: "Problem set 3" },
  { key: "a1", resourceId: "a8", title: "Essay" },
];
const jevTable: {
  name: string;
  text: string;
  judgment: MessageTriageJudgment;
  level: string;
  raised: boolean;
  affects?: string[];
}[] = [
  { name: "gated schedule change raises to important", text: "Quick note about next week.", judgment: judgment("deadline_or_schedule_change", 0.85), level: "important", raised: true, affects: [] },
  {
    name: "affects a task due within 72h raises to urgent",
    text: "Quick note about next week.",
    judgment: judgment("deadline_or_schedule_change", 0.85, { affects: { a0: 0.9, a1: 0.2 }, upcoming }),
    level: "urgent",
    raised: true,
    affects: ["Problem set 3"],
  },
  {
    name: "affects only a far task stays important",
    text: "Quick note.",
    judgment: judgment("exam_logistics", 0.9, { affects: { a1: 0.9 }, upcoming }),
    level: "important",
    raised: true,
    affects: ["Essay"],
  },
  { name: "action required alone raises", text: "Quick note.", judgment: judgment("action_required", 0.5, { runnerUp: 0.4, actionRequired: 0.8 }), level: "important", raised: true },
  { name: "below kind threshold does nothing", text: "Quick note.", judgment: judgment("deadline_or_schedule_change", 0.65), level: "info", raised: false },
  { name: "margin too small does nothing", text: "Quick note.", judgment: judgment("exam_logistics", 0.72, { runnerUp: 0.62 }), level: "info", raised: false },
  { name: "general information never raises", text: "Quick note.", judgment: judgment("general_information", 0.95, { actionRequired: 0.95, affects: { a0: 0.99 }, upcoming }), level: "info", raised: false },
  { name: "new material never raises", text: "Quick note.", judgment: judgment("new_material_posted", 0.95, { actionRequired: 0.95 }), level: "info", raised: false },
  { name: "never lowers a keyword-important message", text: "Midterm is Thursday.", judgment: judgment("general_information", 0.99), level: "important", raised: false },
  {
    name: "raises a keyword-important message to urgent",
    text: "Midterm is Thursday.",
    judgment: judgment("exam_logistics", 0.9, { affects: { a0: 0.8 }, upcoming }),
    level: "urgent",
    raised: true,
    affects: ["Problem set 3"],
  },
];
for (const row of jevTable)
  test(`Jev: ${row.name}`, () => {
    const n = build({
      resources: [resource("m1", { kind: "message", text: row.text }), task, farTask],
      changes: [change("m1", "new")],
      triage: { m1: row.judgment },
    }).items.find((x) => x.resourceId === "m1")!;
    assert.equal(n.level, row.level);
    assert.equal(Boolean(n.raisedBy), row.raised);
    if (row.raised) {
      assert.equal(n.raisedBy!.by, "jev");
      assert.equal(n.raisedBy!.model, "jev-test");
      assert.notEqual(n.raisedBy!.from, n.level);
      if (row.affects) assert.deepEqual(n.raisedBy!.affects, row.affects);
    }
  });

test("Jev can never lower an urgent item", () => {
  const r = resource("a1", { due: at(30) });
  const n = only(
    build({
      resources: [r],
      changes: [change("a1", "date_changed", { dueAt: at(90) }, { dueAt: at(30) })],
      triage: { a1: judgment("general_information", 0.99) },
    }),
  );
  assert.equal(n.level, "urgent");
  assert.equal(n.raisedBy, undefined);
});

// ── materials and events ───────────────────────────────────────────────────────────────────

test("new materials: single is info, two or more group per course per read", () => {
  const one = only(build({ resources: [resource("f1", { kind: "material" })], changes: [change("f1", "new")] }));
  assert.equal(one.reason, "new_material");
  assert.equal(one.level, "info");
  const fs = ["f1", "f2", "f3"].map((id) => resource(id, { kind: "material" }));
  const n = only(build({ resources: fs, changes: fs.map((f) => change(f.id, "new")) }));
  assert.equal(n.title, "3 new files and pages");
  assert.equal(n.count, 3);
  assert.equal(n.level, "info");
});

const ev = (id: string, time: string, over: Partial<ResourceView> = {}) =>
  resource(id, { kind: "event", deadlines: [dueClaim(time, "event")], ...over });
const eventTable: { name: string; resource: ResourceView; change: ResourceChange; expect: null | { level: string; reason: string } }[] = [
  {
    name: "time change within 48h is urgent",
    resource: ev("e1", at(30)),
    change: change("e1", "date_changed", { deadlines: [dueClaim(at(20), "event")] }, { deadlines: [dueClaim(at(30), "event")] }),
    expect: { level: "urgent", reason: "event_changed" },
  },
  {
    name: "far time change is info",
    resource: ev("e1", at(24 * 5)),
    change: change("e1", "date_changed", { deadlines: [dueClaim(at(24 * 4), "event")] }, { deadlines: [dueClaim(at(24 * 5), "event")] }),
    expect: { level: "info", reason: "event_changed" },
  },
  {
    name: "removed within 48h is cancelled and urgent",
    resource: ev("e1", at(20), { deleted: true }),
    change: change("e1", "removed", { deleted: false }, { deleted: true }),
    expect: { level: "urgent", reason: "event_cancelled" },
  },
  {
    name: "removed far away is suppressed",
    resource: ev("e1", at(24 * 5), { deleted: true }),
    change: change("e1", "removed", { deleted: false }, { deleted: true }),
    expect: null,
  },
];
for (const row of eventTable)
  test(`event: ${row.name}`, () => {
    const feed = build({ resources: [row.resource], changes: [row.change] });
    if (!row.expect) return assert.deepEqual(feed.items, []);
    const n = only(feed);
    assert.equal(n.level, row.expect.level);
    assert.equal(n.reason, row.expect.reason);
  });

// ── source health ──────────────────────────────────────────────────────────────────────────

test("sign-in and stale sources make the feed degraded with stable ids", () => {
  const sources = [
    source({ id: "s1", status: "needs_sign_in", lastSuccessAt: at(-30) }),
    source({ id: "s2", status: "needs_sign_in", lastSuccessAt: at(-40) }),
    source({ id: "s3", status: "error", label: "CHEM 142" }),
    source({ id: "s4", status: "ok", label: "MATH 125", lastSuccessAt: at(-30) }),
    source({ id: "s5", status: "ok", lastSuccessAt: at(-2) }),
  ];
  const feed = build({ sources });
  assert.equal(feed.degraded, true);
  const signIn = feed.items.filter((n) => n.reason === "sign_in");
  assert.equal(signIn.length, 1);
  assert.equal(signIn[0]!.level, "urgent");
  assert.equal(signIn[0]!.id, `sign_in:uw:${at(-30)}`);
  assert.equal(signIn[0]!.title, "Sign in to UW again to keep updates coming");
  const stale = feed.items.find((n) => n.reason === "source_stale")!;
  assert.equal(stale.level, "important");
  assert.equal(stale.count, 2);
  assert.match(stale.detail!, /CHEM 142, MATH 125/);
  assert.equal(feed.checkedAt, at(-1));
  // A later retry does not change the ids.
  const again = build({ sources: sources.map((s) => ({ ...s, lastAttemptAt: at(-0.1) })) });
  assert.deepEqual(again.items.map((n) => n.id), feed.items.map((n) => n.id));
});

test("healthy sources: not degraded; checkedAt null with no sources", () => {
  assert.equal(build().degraded, false);
  const feed = build({ sources: [] });
  assert.equal(feed.checkedAt, null);
  assert.equal(feed.degraded, false);
});

// ── state, ordering, cap ───────────────────────────────────────────────────────────────────

test("dismissed is hidden and returns only with a new change id", () => {
  const r = resource("a1", { due: at(30) });
  const c1 = change("a1", "date_changed", { dueAt: at(90) }, { dueAt: at(30) }, { observedAt: at(-5) });
  const first = only(build({ resources: [r], changes: [c1] }));
  assert.deepEqual(build({ resources: [r], changes: [c1], state: { readIds: [], dismissedIds: [first.id] } }).items, []);
  const c2 = change("a1", "requirements_changed", { text: "a" }, { text: "b" }, { observedAt: at(-1) });
  const back = only(build({ resources: [r], changes: [c2, c1], state: { readIds: [], dismissedIds: [first.id] } }));
  assert.notEqual(back.id, first.id);
});

test("read flag and unread count exclude info", () => {
  const urgent = resource("a1", { due: at(30) });
  const important = resource("a2", { due: at(24 * 6) });
  const info = resource("m1", { kind: "message", text: "Hello." });
  const input = {
    resources: [urgent, important, info],
    changes: [change("a1", "new"), change("a2", "new"), change("m1", "new")],
  };
  const feed = build(input);
  assert.equal(feed.items.length, 3);
  assert.equal(feed.unread, 2);
  const urgentId = feed.items.find((n) => n.level === "urgent")!.id;
  const after = build({ ...input, state: { readIds: [urgentId], dismissedIds: [] } });
  assert.equal(after.unread, 1);
  assert.equal(after.items.find((n) => n.id === urgentId)!.read, true);
});

test("sort: urgent, important, info, then newest first; cap keeps highest levels", () => {
  const rs = [
    resource("a1", { due: at(24 * 6) }),
    resource("a2", { due: at(24 * 6) }),
    resource("a3", { due: at(30) }),
    resource("m1", { kind: "message", text: "Hi." }),
  ];
  const feed = build({
    resources: rs,
    changes: [
      change("m1", "new", {}, {}, { observedAt: at(-1) }),
      change("a2", "new", {}, {}, { observedAt: at(-3), readId: "r3" }),
      change("a1", "new", {}, {}, { observedAt: at(-6), readId: "r4" }),
      change("a3", "new", {}, {}, { observedAt: at(-9), readId: "r5" }),
    ],
  });
  assert.deepEqual(feed.items.map((n) => n.resourceId), ["a3", "a2", "a1", "m1"]);

  const many = Array.from({ length: 60 }, (_, i) => resource(`m${i}`, { kind: "message", text: "Hi." }));
  const urgentOne = resource("u1", { due: at(10) });
  const capped = build({
    resources: [...many, urgentOne],
    changes: [...many.map((m) => change(m.id, "new")), change("u1", "new", {}, {}, { observedAt: at(-100) })],
  });
  assert.equal(capped.items.length, NOTIFICATION_RULES.maxItems);
  assert.equal(capped.items[0]!.resourceId, "u1");
});

test("determinism: same input gives deep-equal output", () => {
  const rs = [
    resource("a1", { due: at(30) }),
    resource("m1", { kind: "message", text: "Exam moved to Friday." }),
    resource("f1", { kind: "material" }),
    resource("f2", { kind: "material" }),
  ];
  const changes = [
    change("a1", "date_changed", { dueAt: at(90) }, { dueAt: at(30) }),
    change("m1", "new"),
    change("f1", "new"),
    change("f2", "new"),
  ];
  const input = { resources: rs, changes, sources: [source(), source({ id: "s9", status: "needs_sign_in" })] };
  assert.deepEqual(build(input), build(input));
  assert.deepEqual(build(input), build({ ...input, resources: [...rs].reverse() }));
});

// ── email ──────────────────────────────────────────────────────────────────────────────────

type MailOver = Partial<MailMetadata> & { subject?: string; links?: ResourceView["links"] };
function email(id: string, over: MailOver = {}): ResourceView {
  const { subject, links, ...mail } = over;
  return resource(id, {
    kind: "message",
    courseId: "outlook-mail",
    courseName: "Outlook mail",
    sourceId: "src-mail",
    title: subject ?? "Hello",
    text: mail.preview ?? "",
    createdAt: at(-3),
    ...(links ? { links } : {}),
    mail: {
      messageId: `msg-${id}`,
      folder: "inbox",
      fromName: "Pat Lee",
      fromAddress: "plee@uw.edu",
      receivedAt: at(-3),
      preview: "",
      category: "general",
      categoryReason: "No rule matched",
      ...mail,
    },
  });
}
const cs220 = resource("cs-a1", { courseId: "cs220", courseName: "CS 220", title: "Project 2", due: at(40) });
const mailFeed = (mails: ResourceView[], over: Partial<NotificationInput> = {}) =>
  build({
    resources: [...mails, cs220],
    changes: mails.map((m) => change(m.id, "new", {}, {}, { sourceId: "src-mail" })),
    ...over,
  });
const mailOnly = (mails: ResourceView[], over: Partial<NotificationInput> = {}) =>
  mailFeed(mails, over).items.filter((n) => n.reason === "email");

const mailTable: { name: string; mail: MailOver; expect: null | { level: string; detail: string; quote?: string; courseName?: string } }[] = [
  { name: "advisor is important", mail: { category: "advisor", subject: "Checking in", categoryReason: "Sender's name matches your assigned advisor" }, expect: { level: "important", detail: "Advisor" } },
  {
    name: "course staff is important with the matched course",
    mail: { category: "course", courseId: "cs220", subject: "Office hours notes", preview: "Thanks for coming by today." },
    expect: { level: "important", detail: "Course staff · CS 220", courseName: "CS 220" },
  },
  {
    name: "course staff with a keyword is urgent",
    mail: { category: "course", courseId: "cs220", subject: "Section update", preview: "Hi all. Friday's quiz is postponed to Monday. Thanks." },
    expect: { level: "urgent", detail: "Course staff · CS 220", quote: "Friday's quiz is postponed to Monday.", courseName: "CS 220" },
  },
  { name: "admin with high importance is important", mail: { category: "admin", importance: "high", subject: "Message from the Registrar", preview: "Please read." }, expect: { level: "important", detail: "University office" } },
  {
    name: "admin with an office keyword is important",
    mail: { category: "admin", subject: "Your account", preview: "You have a hold on your account. Contact us soon." },
    expect: { level: "important", detail: "University office", quote: "You have a hold on your account." },
  },
  { name: "plain admin is info", mail: { category: "admin", subject: "Campus newsletter", preview: "Stories from around campus." }, expect: { level: "info", detail: "University office" } },
  { name: "meeting cancelled is important", mail: { category: "meeting", meetingMessageType: "meetingCancelled", subject: "Canceled: Study group" }, expect: { level: "important", detail: "Meeting cancelled" } },
  { name: "meeting request is info", mail: { category: "meeting", meetingMessageType: "meetingRequest", subject: "Study group" }, expect: { level: "info", detail: "Meeting invitation" } },
  { name: "meeting accepted is suppressed", mail: { category: "meeting", meetingMessageType: "meetingAccepted", subject: "Accepted: Study group" }, expect: null },
  { name: "meeting declined is suppressed", mail: { category: "meeting", meetingMessageType: "meetingDeclined", subject: "Declined: Study group" }, expect: null },
  { name: "meeting tentative is suppressed", mail: { category: "meeting", meetingMessageType: "meetingTenativelyAccepted", subject: "Tentative: Study group" }, expect: null },
  { name: "meeting tentative (correct spelling) is suppressed", mail: { category: "meeting", meetingMessageType: "meetingTentativelyAccepted", subject: "Tentative: Study group" }, expect: null },
  { name: "org is info", mail: { category: "org", subject: "Weekly club update", preview: "Dues reminder." }, expect: { level: "info", detail: "Club or list" } },
  {
    name: "org campus event is info with a quote",
    mail: { category: "org", subject: "This week", preview: "Join our resume workshop Thursday. Pizza provided." },
    expect: { level: "info", detail: "Campus event", quote: "Join our resume workshop Thursday." },
  },
  { name: "general is suppressed", mail: { category: "general", subject: "Hey", preview: "Long time no see." }, expect: null },
  {
    name: "general campus event is info",
    mail: { category: "general", subject: "Career fair next week", preview: "Bring copies of your resume." },
    expect: { level: "info", detail: "Campus event", quote: "Career fair next week" },
  },
  {
    name: "interview invitation in general mail is important",
    mail: { category: "general", subject: "Next steps", preview: "Thanks for applying. We'd like to invite you to an interview. Please share your availability." },
    expect: { level: "important", detail: "Job interview", quote: "We'd like to invite you to an interview." },
  },
  { name: "internship offer is important", mail: { category: "org", subject: "Your internship offer", preview: "Congratulations!" }, expect: { level: "important", detail: "Job interview", quote: "Your internship offer" } },
  { name: "mock interview workshop is not an invitation", mail: { category: "general", subject: "Mock interview workshop schedule", preview: "Sign up." }, expect: { level: "info", detail: "Campus event", quote: "Mock interview workshop schedule" } },
  {
    name: "Canvas notification mail (link) is suppressed",
    mail: { category: "course", courseId: "cs220", subject: "Assignment graded", links: [{ url: "https://canvas.example.edu/courses/220/assignments/1", rel: "canvas-item" }] },
    expect: null,
  },
  {
    name: "Canvas notification mail (reason) is suppressed",
    mail: { category: "course", courseId: "cs220", subject: "Exam moved", categoryReason: "Canvas notification links CS 220" },
    expect: null,
  },
];
for (const row of mailTable)
  test(`email: ${row.name}`, () => {
    const items = mailOnly([email("e1", row.mail)]);
    if (!row.expect) return assert.deepEqual(items, []);
    assert.equal(items.length, 1);
    const n = items[0]!;
    assert.equal(n.reason, "email");
    assert.equal(n.level, row.expect.level);
    assert.equal(n.detail, row.expect.detail);
    assert.equal(n.evidence?.quote, row.expect.quote);
    assert.equal(n.courseName, row.expect.courseName ?? "Outlook mail");
    assert.equal(n.title, row.mail.subject);
    assert.equal(n.from, "Pat Lee");
    assert.equal(n.senderReason, row.mail.categoryReason ?? "No rule matched");
    assert.match(n.id, /^email:e1:c\d+$/);
  });

test("email: sender falls back to the address local part", () => {
  const [n] = mailOnly([email("e1", { category: "advisor", fromName: undefined, fromAddress: "advising@uw.edu" })]);
  assert.equal(n!.from, "advising");
});

test("email: baseline, backfill and non-new changes are not notified", () => {
  const e = email("e1", { category: "advisor" });
  assert.deepEqual(mailOnly([e], { changes: [change("e1", "new", {}, {}, { readId: "read-1" })] }), []);
  const old = email("e2", { category: "advisor", receivedAt: at(-24 * 20) });
  assert.deepEqual(mailOnly([{ ...old, createdAt: at(-24 * 20) }]), []);
  assert.deepEqual(mailOnly([e], { changes: [change("e1", "updated"), change("e1", "requirements_changed")] }), []);
});

test("email: mail about an excluded course is suppressed", () => {
  const e = email("e1", { category: "course", courseId: "cs220", subject: "Hi" });
  assert.deepEqual(mailOnly([e], { included: (r) => r.courseId !== "cs220" }), []);
});

test("email: already-read mail is capped at info and does not count", () => {
  const feed = mailFeed([email("e1", { category: "advisor", isRead: true }), email("e2", { category: "advisor" })]);
  const byId = Object.fromEntries(feed.items.map((n) => [n.resourceId, n]));
  assert.equal(byId.e1!.level, "info");
  assert.equal(byId.e2!.level, "important");
  assert.equal(feed.unread, 1);
});

test("email: three or more info club and list emails from one read group", () => {
  const orgs = ["o1", "o2", "o3"].map((id, i) => email(id, { category: "org", fromName: `Club ${i}`, subject: `News ${i}` }));
  const advisor = email("a1", { category: "advisor" });
  const items = mailOnly([...orgs, advisor]);
  assert.equal(items.length, 2);
  const group = items.find((n) => n.count)!;
  assert.equal(group.title, "3 club and list emails");
  assert.equal(group.level, "info");
  assert.equal(group.changeIds.length, 3);
  assert.equal(group.detail, "From Club 0, Club 1, Club 2");
  assert.equal(mailOnly(orgs.slice(0, 2)).length, 2);
});

function mailJudgment(kind: MailKind, p: number, extra: { actionRequired?: number; affects?: Record<string, number>; upcoming?: MailTriageJudgment["upcoming"] } = {}): MailTriageJudgment {
  const kinds: MailKind[] = [
    "interview_or_job",
    "deadline_or_action_required",
    "schedule_change_or_cancellation",
    "advisor_or_academic_standing",
    "campus_event",
    "club_or_org_update",
    "course_related",
    "newsletter_or_promotion",
    "other",
  ];
  const rest = (1 - p) / (kinds.length - 1);
  return {
    result: {
      kind,
      kindProbabilities: Object.fromEntries(kinds.map((k) => [k, k === kind ? p : rest])) as Record<MailKind, number>,
      actionRequired: extra.actionRequired ?? 0.1,
      affects: extra.affects ?? {},
      model: "jev-mail-test",
      questionVersion: "mail.triage.v1",
    },
    upcoming: extra.upcoming ?? [],
  };
}
const mailJevTable: { name: string; mail: MailOver; judgment: MailTriageJudgment; level: string | null; raised: boolean; kind?: MailKind }[] = [
  { name: "interview kind raises general mail to important", mail: { category: "general", subject: "Quick question" }, judgment: mailJudgment("interview_or_job", 0.9), level: "important", raised: true, kind: "interview_or_job" },
  {
    name: "deadline kind affecting a task due soon is urgent",
    mail: { category: "org", subject: "Heads up" },
    judgment: mailJudgment("deadline_or_action_required", 0.85, { affects: { a0: 0.9 }, upcoming: [{ key: "a0", resourceId: "cs-a1", title: "Project 2" }] }),
    level: "urgent",
    raised: true,
  },
  { name: "action required alone raises a strong kind", mail: { category: "admin", subject: "Notice" }, judgment: mailJudgment("advisor_or_academic_standing", 0.5, { actionRequired: 0.9 }), level: "important", raised: true },
  { name: "below threshold does nothing", mail: { category: "general", subject: "Quick question" }, judgment: mailJudgment("interview_or_job", 0.6), level: null, raised: false },
  { name: "campus event surfaces suppressed general mail as info", mail: { category: "general", subject: "Saturday" }, judgment: mailJudgment("campus_event", 0.9), level: "info", raised: true, kind: "campus_event" },
  { name: "course related never goes above info", mail: { category: "admin", subject: "Notice" }, judgment: mailJudgment("course_related", 0.95, { actionRequired: 0.95 }), level: "info", raised: false },
  { name: "newsletter never raises", mail: { category: "general", subject: "Deals" }, judgment: mailJudgment("newsletter_or_promotion", 0.99, { actionRequired: 0.99 }), level: null, raised: false },
  { name: "other never raises", mail: { category: "general", subject: "Hi" }, judgment: mailJudgment("other", 0.99), level: null, raised: false },
  { name: "never lowers an important advisor email", mail: { category: "advisor", subject: "Hi" }, judgment: mailJudgment("newsletter_or_promotion", 0.99), level: "important", raised: false },
  { name: "never lowers urgent course mail", mail: { category: "course", courseId: "cs220", subject: "Exam moved" }, judgment: mailJudgment("campus_event", 0.99), level: "urgent", raised: false },
  { name: "a Jev-raised read email stays info", mail: { category: "general", subject: "Next week", isRead: true }, judgment: mailJudgment("interview_or_job", 0.9), level: "info", raised: true },
  { name: "read cap drops a raise that no longer changes anything", mail: { category: "admin", subject: "Notice", isRead: true }, judgment: mailJudgment("deadline_or_action_required", 0.9), level: "info", raised: false },
];
for (const row of mailJevTable)
  test(`email Jev: ${row.name}`, () => {
    const items = mailOnly([email("e1", row.mail)], { mailTriage: { e1: row.judgment } });
    if (row.level === null) return assert.deepEqual(items, []);
    const n = items[0]!;
    assert.equal(n.level, row.level);
    assert.equal(Boolean(n.raisedBy), row.raised);
    if (row.raised) {
      assert.equal(n.raisedBy!.model, "jev-mail-test");
      if (row.kind) assert.equal(n.raisedBy!.kind, row.kind);
    }
  });

test("email: message triage and mail triage do not cross", () => {
  const items = mailOnly([email("e1", { category: "general", subject: "Hi" })], {
    triage: { e1: judgment("deadline_or_schedule_change", 0.95) },
  });
  assert.deepEqual(items, []);
});

test("email: determinism", () => {
  const mails = [
    email("e1", { category: "course", courseId: "cs220", subject: "Exam room change", preview: "New room is 101." }),
    email("e2", { category: "org" }),
    email("e3", { category: "org" }),
    email("e4", { category: "org" }),
    email("e5", { category: "general", subject: "Interview invitation" }),
  ];
  const changes = mails.map((m) => change(m.id, "new", {}, {}, { sourceId: "src-mail" }));
  const input = { resources: [...mails, cs220], changes, mailTriage: { e2: mailJudgment("campus_event", 0.9) } };
  assert.deepEqual(build(input), build(input));
  assert.deepEqual(build(input), build({ ...input, resources: [...input.resources].reverse() }));
});

// Tightened announcement rule (Sep 27): exams always count; other topics need a change word in
// the same sentence; a negation cancels everything but an exam mention.
for (const [text, level] of [
  ["Reminder: the exam is still Friday as scheduled.", "important"],
  ["Final exam review slides are posted.", "important"],
  ["Your final project rubric is posted.", "info"],
  ["The deadline for HW 4 is Friday at 11:59 PM.", "info"],
  ["The HW 4 deadline has been extended to Monday.", "important"],
  ["The HW 6 deadline was not extended.", "info"],
  ["Quiz 3 is posted on Canvas.", "info"],
  ["Quiz 3 has moved to Wednesday.", "important"],
  ["The problem set now also covers chapter 5.", "important"],
  ["We won't meet Thursday.", "important"],
  ["No class on Monday for the holiday.", "important"],
  ["Please bring a calculator to tomorrow's quiz.", "important"],
  ["Great work on the reflections this week.", "info"],
] as const)
  test(`announcement change test: ${text}`, () => {
    const n = only(build({ resources: [resource("m1", { kind: "message", text })], changes: [change("m1", "new")] }));
    assert.equal(n.level, level);
  });
