import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_RECURRENCE_LIMITS,
  parseCalendar,
  unsupportedRecurrenceParts,
} from "@magic/connectors";
import { createStore } from "@magic/storage";
import type { ResourceInput } from "@magic/contracts";

// Synthetic feeds only; no network. "now" is fixed so the window is deterministic.
const now = () => new Date("2026-10-01T12:00:00Z");
const options = {
  accountScope: "synthetic-student",
  courseId: "42",
  courseName: "Synthetic History 101",
  canvasOrigin: "https://canvas.wisc.edu",
  now,
};
const ics = (...events: string[]) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events
    .map((lines) => `BEGIN:VEVENT\r\n${lines.trim().split(/\s*\n\s*/).join("\r\n")}\r\nEND:VEVENT`)
    .join("\r\n")}\r\nEND:VCALENDAR\r\n`;
const starts = (resources: ResourceInput[]) =>
  resources.map((r) => r.calendar!.start);
const chicagoWallClock = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));

const weeklyClass = `
  UID:hist-lecture
  SUMMARY:HIST 101 Lecture
  DTSTART;TZID=America/Chicago:20261020T093000
  DTEND;TZID=America/Chicago:20261020T104500
  RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261112T153000Z
  EXDATE;TZID=America/Chicago:20261027T093000
`;

test("weekly Chicago class expands across the DST change at 09:30 wall-clock, honoring EXDATE and UNTIL", async () => {
  const { resources, diagnostics } = await parseCalendar(ics(weeklyClass), options);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(starts(resources), [
    "2026-10-20T14:30:00.000Z",
    "2026-10-22T14:30:00.000Z",
    // 2026-10-27 removed by EXDATE
    "2026-10-29T14:30:00.000Z",
    // DST ends 2026-11-01: same wall-clock, one hour later in UTC
    "2026-11-03T15:30:00.000Z",
    "2026-11-05T15:30:00.000Z",
    "2026-11-10T15:30:00.000Z",
    "2026-11-12T15:30:00.000Z", // UNTIL is inclusive
  ]);
  for (const resource of resources) {
    assert.equal(chicagoWallClock(resource.calendar!.start), "09:30");
    assert.equal(chicagoWallClock(resource.calendar!.end as string), "10:45");
    assert.equal(resource.calendar!.timezone, "America/Chicago");
    assert.equal(resource.calendar!.uid, "hist-lecture");
    assert.equal(resource.calendar!.recurrenceId, resource.calendar!.start);
    // A class meeting without an exact assignment link is an event claim, never a due date.
    assert.equal(resource.deadlines.length, 1);
    assert.equal(resource.deadlines[0]!.kind, "event");
    assert.equal(resource.deadlines[0]!.scopeConfirmed, false);
    assert.equal(resource.deadlines[0]!.authority, "structured");
    assert.match(resource.deadlines[0]!.quote, /^Calendar RRULE occurrence: /);
  }
  assert.equal(new Set(resources.map((r) => r.externalId)).size, resources.length);
});

test("COUNT, INTERVAL, WKST, ordinal BYDAY, BYMONTHDAY and BYMONTH follow RFC 5545", async () => {
  const days = async (lines: string) =>
    starts(
      (await parseCalendar(ics(lines), { ...options, recurrence: { horizonDays: 800 } })).resources,
    ).map((s) => s.slice(0, 10));
  // RFC 5545 §3.8.5.3 WKST example: the week start changes which Sunday pairs with Tuesday.
  const wkst = (w: string) => `UID:wkst-${w}
    DTSTART;TZID=America/Chicago:20261006T090000
    RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=${w}`;
  assert.deepEqual(await days(wkst("MO")), ["2026-10-06", "2026-10-11", "2026-10-20", "2026-10-25"]);
  assert.deepEqual(await days(wkst("SU")), ["2026-10-06", "2026-10-18", "2026-10-20", "2026-11-01"]);
  // Last Friday of each month, all-day: dates stay dates and create no deadline.
  const lastFriday = await parseCalendar(
    ics(`UID:last-friday
      DTSTART;VALUE=DATE:20261030
      DTEND;VALUE=DATE:20261031
      RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3`),
    options,
  );
  assert.deepEqual(starts(lastFriday.resources), ["2026-10-30", "2026-11-27", "2026-12-25"]);
  assert.deepEqual(lastFriday.resources.map((r) => r.calendar!.end), ["2026-10-31", "2026-11-28", "2026-12-26"]);
  assert.ok(lastFriday.resources.every((r) => r.deadlines.length === 0 && r.calendar!.allDay));
  // Thanksgiving: fourth Thursday of November.
  assert.deepEqual(
    await days(`UID:thanksgiving
      DTSTART;VALUE=DATE:20261126
      RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=2`),
    ["2026-11-26", "2027-11-25"],
  );
  // 15th and last day of each month, stopped by UNTIL.
  assert.deepEqual(
    await days(`UID:paydays
      DTSTART;TZID=America/Chicago:20261015T170000
      RRULE:FREQ=MONTHLY;BYMONTHDAY=15,-1;UNTIL=20261201T000000Z`),
    ["2026-10-15", "2026-10-31", "2026-11-15", "2026-11-30"],
  );
});

test("a moved occurrence keeps its original identity, so storage sees a date change, not remove + add", async () => {
  const plain = await parseCalendar(ics(weeklyClass), options);
  const moved = await parseCalendar(
    ics(
      weeklyClass,
      `UID:hist-lecture
       RECURRENCE-ID;TZID=America/Chicago:20261105T093000
       SUMMARY:HIST 101 Lecture (moved to Friday)
       DTSTART;TZID=America/Chicago:20261106T130000
       DTEND;TZID=America/Chicago:20261106T141500`,
      // Moved far past the horizon: still reported under its original identity.
      `UID:hist-lecture
       RECURRENCE-ID;TZID=America/Chicago:20261110T093000
       DTSTART;TZID=America/Chicago:20270901T093000
       DTEND;TZID=America/Chicago:20270901T104500`,
    ),
    options,
  );
  assert.deepEqual(moved.diagnostics, []);
  assert.deepEqual(
    moved.resources.map((r) => r.externalId).sort(),
    plain.resources.map((r) => r.externalId).sort(),
  );
  const original = plain.resources.find((r) => r.calendar!.start === "2026-11-05T15:30:00.000Z")!;
  const shifted = moved.resources.find((r) => r.externalId === original.externalId)!;
  assert.equal(shifted.calendar!.start, "2026-11-06T19:00:00.000Z");
  assert.equal(shifted.calendar!.end, "2026-11-06T20:15:00.000Z");
  assert.equal(shifted.calendar!.recurrenceId, "2026-11-05T15:30:00.000Z");
  assert.equal(shifted.title, "HIST 101 Lecture (moved to Friday)");
  assert.match(shifted.deadlines[0]!.quote, /^Calendar RECURRENCE-ID 2026-11-05T15:30:00.000Z DTSTART: /);
  const far = moved.resources.find((r) => r.calendar!.recurrenceId === "2026-11-10T15:30:00.000Z")!;
  assert.equal(far.calendar!.start, "2027-09-01T14:30:00.000Z");
});

test("a cancelled occurrence retains evidence without an active claim; siblings keep exact due claims", async () => {
  const { resources, diagnostics } = await parseCalendar(
    ics(
      `UID:quiz
       SUMMARY:Weekly quiz
       URL:https://canvas.wisc.edu/courses/42/assignments/77
       DTSTART;TZID=America/Chicago:20261002T235900
       RRULE:FREQ=WEEKLY;COUNT=3`,
      `UID:quiz
       RECURRENCE-ID;TZID=America/Chicago:20261009T235900
       DTSTART;TZID=America/Chicago:20261009T235900
       SUMMARY:Weekly quiz
       STATUS:CANCELLED`,
    ),
    options,
  );
  assert.deepEqual(diagnostics, []);
  assert.equal(resources.length, 3);
  const cancelled = resources.find((r) => r.workflowState === "CANCELLED")!;
  assert.equal(cancelled.calendar!.start, "2026-10-10T04:59:00.000Z");
  assert.deepEqual(cancelled.deadlines, []);
  // Override omits URL: the series' exact assignment link still identifies it.
  assert.equal(cancelled.calendar!.assignmentExternalId, "77");
  for (const active of resources.filter((r) => r !== cancelled)) {
    assert.equal(active.deadlines[0]!.kind, "due");
    assert.equal(active.deadlines[0]!.scopeConfirmed, true);
  }
});

test("RDATE adds TZID and UTC occurrences, respects EXDATE, and works without RRULE", async () => {
  const { resources, diagnostics } = await parseCalendar(
    ics(
      `UID:review
       SUMMARY:Review session
       DTSTART;TZID=America/Chicago:20261015T180000
       DTEND;TZID=America/Chicago:20261015T190000
       RDATE;TZID=America/Chicago:20261105T180000,20261203T180000
       RDATE:20261210T000000Z
       EXDATE;TZID=America/Chicago:20261203T180000`,
    ),
    options,
  );
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(starts(resources), [
    "2026-10-15T23:00:00.000Z",
    "2026-11-06T00:00:00.000Z", // 18:00 CST
    "2026-12-10T00:00:00.000Z",
  ]);
  assert.equal(resources[1]!.calendar!.end, "2026-11-06T01:00:00.000Z");
  assert.match(resources[1]!.deadlines[0]!.quote, /^Calendar RDATE: /);
});

test("unsupported rule parts are named in a diagnostic and the series start is kept, never guessed", async () => {
  assert.deepEqual(unsupportedRecurrenceParts(["FREQ=WEEKLY;BYDAY=TU;UNTIL=20261201T000000Z"]), []);
  assert.deepEqual(unsupportedRecurrenceParts(["FREQ=HOURLY;BYWEEKNO=4"]), ["BYWEEKNO", "FREQ=HOURLY"]);
  assert.deepEqual(unsupportedRecurrenceParts(["FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=-1"]), ["BYSETPOS"]);
  assert.deepEqual(unsupportedRecurrenceParts(["FREQ=WEEKLY;BYDAY=2TU"]), ["BYDAY_ORDINAL_WITH_WEEKLY"]);
  assert.deepEqual(unsupportedRecurrenceParts(["FREQ=DAILY;COUNT=2;UNTIL=20261201"]), ["COUNT_WITH_UNTIL"]);
  assert.deepEqual(unsupportedRecurrenceParts(["FREQ=DAILY"], true), ["EXRULE"]);
  const { resources, diagnostics } = await parseCalendar(
    ics(
      `UID:lab
       SUMMARY:Lab section
       DTSTART;TZID=America/Chicago:20261005T140000
       RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1`,
      `UID:hours
       SUMMARY:Office hours
       DTSTART;TZID=America/Chicago:20261006T100000
       RDATE;VALUE=PERIOD:20261013T150000Z/PT1H`,
      weeklyClass,
    ),
    options,
  );
  assert.deepEqual(diagnostics, [
    { code: "recurrence_rule_unsupported", path: ["BYSETPOS"], severity: "warning" },
    { code: "recurrence_rule_unsupported", path: ["RDATE_PERIOD"], severity: "warning" },
  ]);
  for (const uid of ["lab", "hours"]) {
    const kept = resources.filter((r) => r.calendar!.uid === uid);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.calendar!.recurrenceId, undefined);
    assert.match(kept[0]!.deadlines[0]!.quote, /^Calendar DTSTART: /);
  }
  // Supported series in the same feed still expand.
  assert.equal(resources.filter((r) => r.calendar!.uid === "hist-lecture").length, 7);
});

test("occurrence caps keep the occurrences nearest now, flag the batch, and never crowd out standalone events", async () => {
  const endless = (uid: string) => `UID:${uid}
    SUMMARY:Daily standup
    DTSTART;TZID=America/Chicago:20200106T090000
    RRULE:FREQ=DAILY`;
  const started = Date.now();
  const one = await parseCalendar(ics(endless("daily")), options);
  assert.ok(Date.now() - started < 5000);
  assert.equal(one.resources.length, DEFAULT_RECURRENCE_LIMITS.maxOccurrencesPerSeries);
  assert.deepEqual(one.diagnostics, [
    { code: "recurrence_occurrence_cap", path: ["series"], severity: "warning" },
  ]);
  const first = Date.parse(one.resources[0]!.calendar!.start);
  const last = Date.parse(one.resources.at(-1)!.calendar!.start);
  assert.ok(first <= now().getTime() && last >= now().getTime());
  assert.ok(last <= now().getTime() + DEFAULT_RECURRENCE_LIMITS.horizonDays * 86_400_000);

  // Nine capped series (2250 occurrences) exceed the 2000-record batch; the standalone event survives.
  const many = await parseCalendar(
    ics(
      ...Array.from({ length: 9 }, (_, i) => endless(`daily-${i}`)),
      `UID:final-exam
       SUMMARY:Final exam
       DTSTART;TZID=America/Chicago:20261215T080000`,
    ),
    options,
  );
  assert.equal(many.resources.length, 2000);
  assert.ok(many.resources.some((r) => r.calendar!.uid === "final-exam"));
  assert.deepEqual(
    many.diagnostics.map((d) => d.path[0]),
    ["series", "batch"],
  );

  // Series smaller than the cap are expanded from their first occurrence, so the lower edge never slides.
  const small = await parseCalendar(
    ics(endless("daily").replace("20200106T090000", "20260105T090000")),
    { ...options, recurrence: { maxOccurrencesPerSeries: 1000 } },
  );
  assert.deepEqual(small.diagnostics, []);
  assert.equal(small.resources[0]!.calendar!.start, "2026-01-05T15:00:00.000Z");
  assert.equal(small.resources.length, 453); // 2026-01-05 through the 184-day horizon (2027-04-03)

  // The horizon itself is a defined scope, not a silent drop: later dates appear as it advances.
  const thanksgiving = `UID:thanksgiving
    DTSTART;VALUE=DATE:20261126
    RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH;COUNT=2`;
  assert.equal((await parseCalendar(ics(thanksgiving), options)).resources.length, 1);
});

test("an impossible rule terminates with no occurrences or a flagged failure", async () => {
  const { resources, diagnostics } = await parseCalendar(
    ics(`UID:never
      DTSTART;VALUE=DATE:20261001
      RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30`),
    options,
  );
  assert.ok(
    resources.length === 0 ||
      diagnostics.some((d) => d.code === "recurrence_expansion_failed"),
  );
});

test("storage records a cancelled-by-EXDATE occurrence as removed and a moved one as a date change", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-calendar-recurrence-"));
  const store = createStore(join(directory, "evidence.sqlite"));
  const source = {
    id: "calendar:synthetic",
    label: "Synthetic calendar feed",
    kind: "calendar",
    accountScope: "synthetic-student",
    courseId: "42",
    scope: "calendar_feed",
  };
  const batch = (n: number, resources: ResourceInput[]) => ({
    source,
    observedAt: new Date(Date.UTC(2026, 9, 1, 12, n)).toISOString(),
    status: "ok",
    complete: true,
    readId: `read-${n}`,
    resources,
  });
  try {
    const first = await parseCalendar(ics(weeklyClass), options);
    store.ingest(batch(0, first.resources));
    const second = await parseCalendar(
      ics(
        weeklyClass.replace(
          "EXDATE;TZID=America/Chicago:20261027T093000",
          "EXDATE;TZID=America/Chicago:20261027T093000,20261110T093000",
        ),
        `UID:hist-lecture
         RECURRENCE-ID;TZID=America/Chicago:20261105T093000
         DTSTART;TZID=America/Chicago:20261106T093000
         DTEND;TZID=America/Chicago:20261106T104500`,
      ),
      options,
    );
    assert.deepEqual(second.diagnostics, []);
    const report = store.ingest(batch(1, second.resources));
    assert.equal(report.deleted, 1);
    assert.equal(report.changed, 1);
    const types = store.changes().map((c) => c.type);
    assert.ok(types.includes("removed"));
    assert.ok(types.includes("date_changed"));
  } finally {
    store.close?.();
    rmSync(directory, { recursive: true, force: true });
  }
});
