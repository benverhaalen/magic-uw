import test from "node:test";
import assert from "node:assert/strict";
import {
  createPublicClient,
  isOutlookPublishedCalendar,
  outlookCalendarConnector,
  type PublicClient,
} from "@magic/connectors";
import { contentCategories } from "../packages/core/src/access";
import { OUTLOOK_CALENDAR_COURSE_ID, type Resource } from "@magic/contracts";
import { buildTodayRail, resolveDeadline, type RailResource } from "@magic/domain";

const LINK =
  "https://outlook.office365.com/owa/calendar/0f9c1d2e@wisc.edu/AbCdEf123456/calendar.ics";

test("only Outlook's published-calendar link format is accepted", () => {
  assert.equal(isOutlookPublishedCalendar(LINK), true);
  assert.equal(
    isOutlookPublishedCalendar(LINK.replace("outlook.office365.com", "outlook.office.com")),
    true,
  );
  for (const bad of [
    LINK.replace("https:", "http:"),
    LINK.replace("outlook.office365.com", "evil.example.com"),
    LINK.replace("calendar.ics", "calendar.html"),
    LINK.replace("/owa/calendar/", "/owa/other/"),
    LINK.replace("https://", "https://user:pass@"),
    "https://canvas.wisc.edu/feeds/calendars/user_x.ics",
    "not a url",
  ])
    assert.equal(isOutlookPublishedCalendar(bad), false, bad);
});

test("the Outlook fetcher refuses any other link before touching the network", async () => {
  const client = createPublicClient();
  await assert.rejects(
    client.outlookFeed!("https://evil.example.com/owa/calendar/a/b/calendar.ics"),
    /invalid_feed/,
  );
});

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:Microsoft Exchange Server 2010",
  "BEGIN:VEVENT",
  "UID:teams-1@example",
  "SUMMARY:Project sync",
  "LOCATION:Microsoft Teams Meeting",
  "DTSTART:20260929T200000Z",
  "DTEND:20260929T203000Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:room-1@example",
  "SUMMARY:Advising appointment",
  "LOCATION:Van Hise 101",
  "DTSTART:20260929T160000Z",
  "DTEND:20260929T163000Z",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");
const fakeClient = { outlookFeed: async () => ICS } as unknown as PublicClient;

async function pull() {
  const batches = [];
  for await (const b of outlookCalendarConnector({
    feedUrl: LINK,
    accountScope: "local",
    client: fakeClient,
    now: () => new Date("2026-09-29T15:00:00Z"),
  }).pull())
    batches.push(b);
  return batches[0]!;
}

test("Outlook events keep their location, flag Teams meetings, and never link to Canvas work", async () => {
  const batch = await pull();
  assert.equal(batch.source.kind, "calendar");
  assert.equal(batch.source.scope, "outlook_calendar");
  const teams = batch.resources.find((r) => r.title === "Project sync")!;
  assert.equal(teams.courseId, OUTLOOK_CALENDAR_COURSE_ID);
  assert.equal(teams.calendar?.location, "Microsoft Teams Meeting");
  assert.equal(teams.calendar?.onlineMeeting, "teams");
  assert.equal(teams.calendar?.assignmentExternalId, undefined);
  assert.match(teams.url, /^https:\/\/outlook\.office\.com\//);
  const room = batch.resources.find((r) => r.title === "Advising appointment")!;
  assert.equal(room.calendar?.location, "Van Hise 101");
  assert.equal(room.calendar?.onlineMeeting, undefined);
  // The capability link itself is never stored in a record.
  assert.equal(JSON.stringify(batch).includes("AbCdEf123456"), false);
});

test("personal Outlook events are communications, not course text, for sharing decisions", async () => {
  const r = (await pull()).resources[0]!;
  assert.deepEqual(contentCategories(r as unknown as Resource), ["communications"]);
});

test("the rail shows Outlook meetings as fixed events with location and a Teams flag", async () => {
  const resources: RailResource[] = (await pull()).resources.map((r) => ({
    ...r,
    id: r.externalId,
    completed: false,
    submitted: null,
    kindLabel: null,
    deadline: resolveDeadline(r.deadlines),
  }));
  const rail = buildTodayRail(resources, "2026-09-29T15:00:00Z", "America/Chicago");
  const sync = rail.events.find((e) => e.title === "Project sync")!;
  assert.equal(sync.onlineMeeting, "teams");
  assert.equal(sync.location, "Microsoft Teams Meeting");
  assert.equal(rail.events.find((e) => e.title === "Advising appointment")?.location, "Van Hise 101");
});
