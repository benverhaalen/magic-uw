import test from "node:test";
import assert from "node:assert/strict";
import { parseCalendar } from "@magic/connectors";
import { buildTodayRail, resolveDeadline, type RailResource } from "@magic/domain";

// A Mon/Wed/Fri lecture as Outlook and Canvas publish it: Windows zone name,
// one canceled day (EXDATE), and one session moved to the afternoon and online.
const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0",
  "BEGIN:VTIMEZONE", "TZID:Central Standard Time",
  "BEGIN:STANDARD", "DTSTART:16010101T020000", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0600", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11", "END:STANDARD",
  "BEGIN:DAYLIGHT", "DTSTART:16010101T020000", "TZOFFSETFROM:-0600", "TZOFFSETTO:-0500", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3", "END:DAYLIGHT",
  "END:VTIMEZONE",
  "BEGIN:VEVENT", "UID:lec@x", "SUMMARY:CS 574 Lecture", "LOCATION:Morgridge 1570",
  "DTSTART;TZID=Central Standard Time:20260902T110000", "DTEND;TZID=Central Standard Time:20260902T115000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261211T235959Z",
  "EXDATE;TZID=Central Standard Time:20261030T110000",
  "END:VEVENT",
  "BEGIN:VEVENT", "UID:lec@x", "RECURRENCE-ID;TZID=Central Standard Time:20261028T110000",
  "SUMMARY:CS 574 Lecture (moved)", "LOCATION:Online",
  "DTSTART;TZID=Central Standard Time:20261028T140000", "DTEND;TZID=Central Standard Time:20261028T145000",
  "END:VEVENT",
  "BEGIN:VEVENT", "UID:once@x", "SUMMARY:Advising", "DTSTART:20261027T200000Z", "DTEND:20261027T203000Z", "END:VEVENT",
  "END:VCALENDAR", "",
].join("\r\n");

// Mon Oct 26, 9:00 AM Central.
const NOW = new Date("2026-10-26T14:00:00Z");
const parse = () =>
  parseCalendar(ICS, {
    canvasOrigin: "https://canvas.wisc.edu",
    accountScope: "a",
    courseId: "574",
    courseName: "COMPSCI 574",
    now: () => NOW,
    expandRecurrence: true,
  });

test("a weekly class becomes one event per meeting, at the right local time across the DST change", async () => {
  const { resources, diagnostics } = await parse();
  const lectures = resources.filter((r) => r.calendar?.uid === "lec@x");
  const starts = lectures.map((r) => r.calendar!.start);
  assert.ok(starts.includes("2026-10-26T16:00:00.000Z"), "Mon Oct 26, 11 AM CDT");
  assert.ok(starts.includes("2026-11-02T17:00:00.000Z"), "Mon Nov 2, 11 AM CST after DST ends");
  assert.equal(new Set(lectures.map((r) => r.externalId)).size, lectures.length, "each meeting has its own id");
  assert.ok(lectures.every((r) => r.calendar?.recurrenceId));
  assert.equal(diagnostics.some((d) => d.code === "recurrence_not_expanded"), false);
});

test("a canceled meeting is skipped and a moved meeting replaces the original", async () => {
  const { resources } = await parse();
  const lectures = resources.filter((r) => r.calendar?.uid === "lec@x");
  const starts = lectures.map((r) => r.calendar!.start);
  assert.equal(starts.includes("2026-10-30T16:00:00.000Z"), false, "Oct 30 was canceled");
  assert.equal(starts.includes("2026-10-28T16:00:00.000Z"), false, "the 11 AM slot on Oct 28 moved");
  const moved = lectures.find((r) => r.calendar!.start === "2026-10-28T19:00:00.000Z")!;
  assert.equal(moved.title, "CS 574 Lecture (moved)");
  assert.equal(moved.calendar?.location, "Online");
  assert.equal(moved.calendar?.end, "2026-10-28T19:50:00.000Z");
});

test("expansion is bounded to the near future and past meetings drop off", async () => {
  const { resources } = await parse();
  const lectures = resources.filter((r) => r.calendar?.uid === "lec@x");
  const first = lectures.map((r) => r.calendar!.start).sort()[0]!;
  const last = lectures.map((r) => r.calendar!.start).sort().at(-1)!;
  assert.ok(first >= "2026-10-25", `nothing long past (first ${first})`);
  assert.ok(last <= "2026-11-17", `only a few weeks ahead (last ${last})`);
  // A one-off event is unchanged.
  assert.equal(resources.filter((r) => r.calendar?.uid === "once@x").length, 1);
});

test("today's rail shows the day's meeting from the series", async () => {
  const { resources } = await parse();
  const rail = buildTodayRail(
    resources.map((r): RailResource => ({ ...r, id: r.externalId, completed: false, submitted: null, kindLabel: null, deadline: resolveDeadline(r.deadlines) })),
    NOW.toISOString(),
    "America/Chicago",
  );
  const lecture = rail.events.find((e) => e.title === "CS 574 Lecture")!;
  assert.deepEqual([lecture.startMin, lecture.endMin, lecture.location], [11 * 60, 11 * 60 + 50, "Morgridge 1570"]);
});

test("times with no zone, or a zone the file never defines, are still rejected", async () => {
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:floating@x", "SUMMARY:Floating", "DTSTART:20261026T110000", "END:VEVENT",
    "BEGIN:VEVENT", "UID:unknown@x", "SUMMARY:Unknown zone", "DTSTART;TZID=Nowhere Standard Time:20261026T110000", "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n");
  const { resources, diagnostics } = await parseCalendar(ics, {
    canvasOrigin: "https://canvas.wisc.edu", accountScope: "a", courseId: "574", courseName: "C", now: () => NOW,
  });
  assert.equal(resources.length, 0);
  assert.equal(diagnostics.filter((d) => d.code === "calendar_timezone_unresolved").length, 2);
});

test("Canvas course feeds keep main's behavior: a series stays one event and the read is incomplete", async () => {
  const { calendarConnector } = await import("@magic/connectors");
  const batches = [];
  for await (const b of calendarConnector({
    feedUrl: "https://canvas.wisc.edu/feeds/calendars/course_x.ics",
    canvasOrigin: "https://canvas.wisc.edu",
    accountScope: "a",
    courseId: "574",
    courseName: "COMPSCI 574",
    client: { feed: async () => ICS } as never,
    now: () => NOW,
  }).pull())
    batches.push(b);
  const batch = batches[0]!;
  const lectures = batch.resources.filter((r) => r.calendar?.uid === "lec@x");
  assert.equal(lectures.length, 1, "not expanded into meetings");
  assert.equal(lectures[0]!.calendar?.recurrenceId, undefined);
  assert.ok(batch.diagnostics?.some((d) => d.code === "recurrence_not_expanded"));
  // An incomplete read can never delete previously captured events.
  assert.equal(batch.complete, false);
});

test("the Outlook feed expands a weekly class into one event per meeting", async () => {
  const { outlookCalendarConnector } = await import("@magic/connectors");
  const batches = [];
  for await (const b of outlookCalendarConnector({
    feedUrl: "https://outlook.office365.com/owa/calendar/a@wisc.edu/b/calendar.ics",
    accountScope: "local",
    client: { outlookFeed: async () => ICS } as never,
    now: () => NOW,
  }).pull())
    batches.push(b);
  const lectures = batches[0]!.resources.filter((r) => r.calendar?.uid === "lec@x");
  assert.ok(lectures.length > 5, `expanded (${lectures.length})`);
  assert.equal(batches[0]!.diagnostics?.some((d) => d.code === "recurrence_not_expanded") ?? false, false);
});

test("a canceled or moved day in an all-day repeating series is applied too", async () => {
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:ad@x", "SUMMARY:Study week", "DTSTART;VALUE=DATE:20261026", "DTEND;VALUE=DATE:20261027",
    "RRULE:FREQ=DAILY;COUNT=5", "EXDATE;VALUE=DATE:20261028", "END:VEVENT",
    "BEGIN:VEVENT", "UID:ad@x", "RECURRENCE-ID;VALUE=DATE:20261029", "SUMMARY:Study week (moved)",
    "DTSTART;VALUE=DATE:20261031", "DTEND;VALUE=DATE:20261101", "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n");
  const { resources } = await parseCalendar(ics, {
    canvasOrigin: "https://canvas.wisc.edu", accountScope: "a", courseId: "574", courseName: "C", now: () => NOW,
    expandRecurrence: true,
  });
  const days = resources.filter((r) => r.calendar?.uid === "ad@x").map((r) => r.calendar!.start).sort();
  assert.deepEqual(days, ["2026-10-26", "2026-10-27", "2026-10-30", "2026-10-31"]);
  assert.equal(resources.find((r) => r.calendar!.start === "2026-10-31")?.title, "Study week (moved)");
});

test("all-day dates keep their calendar day east of UTC", async () => {
  // DATE values parse as local midnight; formatting them in UTC moved them a day early (CI runs in UTC).
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:day@x", "SUMMARY:Reading day", "DTSTART;VALUE=DATE:20261028", "DTEND;VALUE=DATE:20261029", "END:VEVENT",
    "END:VCALENDAR", "",
  ].join("\r\n");
  const previous = process.env.TZ;
  try {
    for (const zone of ["Pacific/Auckland", "Asia/Tokyo", "America/Chicago", "UTC"]) {
      process.env.TZ = zone;
      const { resources } = await parseCalendar(ics, {
        canvasOrigin: "https://canvas.wisc.edu", accountScope: "a", courseId: "574", courseName: "C", now: () => NOW,
      });
      const day = resources.find((r) => r.calendar?.uid === "day@x")!.calendar!;
      assert.equal(day.start, "2026-10-28", zone);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test("expansion has an overall cap, and hitting it marks the read incomplete", async () => {
  // Ten hourly series: each hits the per-series cap, and together they pass the feed-wide cap.
  const events = Array.from({ length: 10 }, (_, i) => [
    "BEGIN:VEVENT", `UID:hourly-${i}@x`, `SUMMARY:Hourly ${i}`,
    "DTSTART:20261026T000000Z", "DTEND:20261026T001500Z", "RRULE:FREQ=HOURLY", "END:VEVENT",
  ]).flat();
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR", ""].join("\r\n");
  const { resources, diagnostics } = await parseCalendar(ics, {
    canvasOrigin: "https://canvas.wisc.edu", accountScope: "a", courseId: "574", courseName: "C", now: () => NOW,
    expandRecurrence: true,
  });
  assert.ok(resources.length <= 3000, `bounded (${resources.length})`);
  assert.ok(diagnostics.some((d) => d.code === "recurrence_truncated"));
});

test("once the feed-wide cap is full, later series are not expanded at all", async () => {
  const series = (i: number) => [
    "BEGIN:VEVENT", `UID:h${i}@x`, `SUMMARY:Hourly ${i}`,
    "DTSTART:20261026T000000Z", "DTEND:20261026T001500Z", "RRULE:FREQ=HOURLY", "END:VEVENT",
  ];
  const ics = (n: number) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...Array.from({ length: n }, (_, i) => series(i)).flat(), "END:VCALENDAR", ""].join("\r\n");
  // Count calls into the recurrence library's date computation.
  // The same ES-module build the connectors package imports (its CommonJS build is a separate copy).
  // A path variable keeps TypeScript from type-checking the library's untyped ESM file.
  const parserPath = "../packages/connectors/node_modules/node-ical/node-ical.js";
  const ical = (await import(parserPath)).default as { async: { parseICS(text: string): Promise<Record<string, { type?: string; rrule?: object }>> } };
  const sample = Object.values(await ical.async.parseICS(ics(1))).find((x) => x?.type === "VEVENT") as { rrule: object };
  const proto = Object.getPrototypeOf(sample.rrule) as { between: (...a: unknown[]) => unknown };
  const original = proto.between;
  let calls = 0;
  proto.between = function (this: unknown, ...a: unknown[]) { calls++; return original.apply(this, a); };
  try {
    await parseCalendar(ics(10), {
      canvasOrigin: "https://canvas.wisc.edu", accountScope: "a", courseId: "574", courseName: "C", now: () => NOW,
      expandRecurrence: true,
    });
  } finally {
    proto.between = original;
  }
  // 400 per series: the cap of 3,000 fills during the 8th series, so the 9th and 10th are skipped.
  assert.equal(calls, 8);
});
