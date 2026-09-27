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
