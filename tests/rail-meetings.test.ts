import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTodayRail,
  meetingResponse,
  resolveDeadline,
  validatePlanEdit,
  type RailResource,
} from "@magic/domain";

const TZ = "America/Chicago";
// Tuesday Sep 29, 2:00 PM CDT.
const NOW = "2026-09-29T19:00:00.000Z";

function item(id: string, partial: Partial<RailResource>): RailResource {
  return {
    id,
    kind: "assignment",
    title: id,
    courseId: "c",
    courseName: "Course",
    completed: false,
    submitted: null,
    deadline: resolveDeadline([]),
    kindLabel: null,
    ...partial,
  };
}
// A Graph meeting: 2:15 to 5:00 PM today.
const meeting = (response?: string, extra: Record<string, unknown> = {}) =>
  item("sync", {
    kind: "event",
    title: "Project sync",
    courseId: "outlook-calendar",
    courseName: "Outlook calendar",
    calendar: {
      uid: "sync@x",
      start: "2026-09-29T19:15:00Z",
      end: "2026-09-29T22:00:00Z",
      allDay: false,
      onlineMeeting: "teams",
      ...(response ? { responseStatus: response } : {}),
      ...extra,
    } as RailResource["calendar"],
  });
// Due tomorrow evening, so the rail suggests work today.
const problemSet = item("ps3", {
  title: "Problem Set 3",
  points: 20,
  deadline: resolveDeadline([
    { value: "2026-10-01T04:59:00Z", kind: "due", quote: "due_at", authority: "structured", scopeConfirmed: true },
  ]),
});
const firstWork = (response?: string) =>
  buildTodayRail([meeting(response), problemSet], NOW, TZ).suggestions.find((s) => s.type === "work");

test("Graph response values are normalized", () => {
  assert.equal(meetingResponse("accepted"), "accepted");
  assert.equal(meetingResponse("tentativelyAccepted"), "tentative");
  assert.equal(meetingResponse("declined"), "declined");
  assert.equal(meetingResponse("organizer"), "organizer");
  assert.equal(meetingResponse("notResponded"), "pending");
  assert.equal(meetingResponse("none"), "pending");
  assert.equal(meetingResponse(undefined), undefined);
  assert.equal(meetingResponse("somethingNew"), undefined);
});

test("a declined meeting stays visible but frees its time for study", () => {
  const rail = buildTodayRail([meeting("declined"), problemSet], NOW, TZ);
  assert.equal(rail.events.find((e) => e.id === "sync")?.response, "declined", "still shown, marked declined");
  const declined = firstWork("declined")!;
  const accepted = firstWork("accepted")!;
  assert.ok(declined.startMin < 17 * 60, `declined time is free (starts ${declined.startMin})`);
  assert.ok(accepted.startMin >= 17 * 60, `accepted time is busy (starts ${accepted.startMin})`);
});

test("tentative and unanswered meetings still hold their time", () => {
  for (const r of ["tentativelyAccepted", "notResponded"]) {
    const s = firstWork(r)!;
    assert.ok(s.startMin >= 17 * 60, `${r} holds time (starts ${s.startMin})`);
  }
  assert.equal(buildTodayRail([meeting("tentativelyAccepted")], NOW, TZ).events[0]?.response, "tentative");
});

test("a declined class gets no prep block", () => {
  const lecture = (response?: string) =>
    item("lec", {
      kind: "event",
      title: "GEOSCI 100 Lecture",
      courseId: "geo",
      calendar: {
        uid: "lec@x", start: "2026-09-29T20:30:00Z", end: "2026-09-29T21:45:00Z", allDay: false,
        ...(response ? { responseStatus: response } : {}),
      } as RailResource["calendar"],
    });
  const slides = item("slides", { kind: "material", title: "Week 5 slides", courseId: "geo", updatedAt: "2026-09-28T12:00:00Z" });
  const prep = (response?: string) =>
    buildTodayRail([lecture(response), slides], NOW, TZ).suggestions.filter((s) => s.type === "prep").length;
  assert.equal(prep("accepted"), 1);
  assert.equal(prep("declined"), 0);
});

test("editing a block over a declined meeting does not warn about an overlap", () => {
  const events = buildTodayRail([meeting("declined")], NOW, TZ).events;
  assert.deepEqual(validatePlanEdit({ startMin: 15 * 60, endMin: 16 * 60 }, events).overlaps, []);
  const busy = buildTodayRail([meeting("accepted")], NOW, TZ).events;
  assert.deepEqual(validatePlanEdit({ startMin: 15 * 60, endMin: 16 * 60 }, busy).overlaps, ["Project sync"]);
});

test("only an https join link reaches the rail", () => {
  const join = (url: string) =>
    buildTodayRail([meeting("accepted", { joinUrl: url })], NOW, TZ).events[0]?.joinUrl;
  assert.equal(join("https://teams.microsoft.com/l/meetup-join/abc"), "https://teams.microsoft.com/l/meetup-join/abc");
  assert.equal(join("http://teams.microsoft.com/l/meetup-join/abc"), undefined);
  assert.equal(join("javascript:alert(1)"), undefined);
  assert.equal(join("https://user:pass@example.com/x"), undefined);
});

test("every meeting provider is kept for its badge", () => {
  for (const provider of ["teams", "zoom", "webex", "meet"] as const)
    assert.equal(buildTodayRail([meeting("accepted", { onlineMeeting: provider })], NOW, TZ).events[0]?.onlineMeeting, provider);
});
