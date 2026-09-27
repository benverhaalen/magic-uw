import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { OUTLOOK_CALENDAR_COURSE_ID } from "@magic/contracts";
import { createIngestion } from "../apps/desktop/src/ingestion";
import type { PublicClient } from "../packages/connectors/src/network";

const LINK = "https://outlook.office365.com/owa/calendar/a@wisc.edu/b/calendar.ics";
// Six meetings, so the drift guard (baseline of 5 or more) would block an empty "read".
const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0",
  ...Array.from({ length: 6 }, (_, i) => [
    "BEGIN:VEVENT", `UID:m${i}@x`, `SUMMARY:Private meeting ${i}`,
    `DTSTART:2026092${7 + (i % 3)}T1${i}0000Z`, `DTEND:2026092${7 + (i % 3)}T1${i}3000Z`, "END:VEVENT",
  ]).flat(),
  "END:VCALENDAR", "",
].join("\r\n");

test("disconnecting Outlook through the real refresh removes its meetings, even past the drift guard", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-outlook-disconnect-"));
  const store = createStore(join(directory, "coursework.sqlite"));
  const vault: Record<string, string> = { "calendar:outlook": LINK };
  const refuse = async () => {
    throw new Error("No other network access in this test.");
  };
  const client = {
    isCanvas: () => false,
    get: refuse,
    text: refuse,
    feed: refuse,
    outlookFeed: async (url: string) => {
      assert.equal(url, LINK);
      return ICS;
    },
  } as unknown as PublicClient;
  const runtime = createIngestion(store, {
    directory,
    client,
    now: () => new Date("2026-09-26T17:00:00Z"),
    // Canvas is signed out; the feeds step still runs first on every refresh.
    canvasFetch: async () => new Response("", { status: 401 }),
    async secrets(operation, key, value) {
      if (operation === "list") return { ...vault };
      vault[key!] = value!;
    },
  });
  const meetings = () =>
    store.resources().filter((r) => r.courseId === OUTLOOK_CALENDAR_COURSE_ID && !r.deleted);
  try {
    await runtime.tick("manual");
    await runtime.tick("manual");
    assert.equal(meetings().length, 6, "connected: meetings are captured");
    // The app disconnects by blanking the vault entry (main.ts, magic:outlook-calendar with null).
    vault["calendar:outlook"] = "";
    await runtime.tick("manual");
    assert.equal(meetings().length, 0, "disconnected: meetings are gone");
    assert.equal(store.sources().some((s) => s.courseId === OUTLOOK_CALENDAR_COURSE_ID), false);
    assert.equal(store.resources("Private meeting").length, 0);
  } finally {
    await runtime.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the outlook-disconnect command removes only the Outlook calendar, right away", async () => {
  const { createCore } = await import("@magic/core");
  const { captureBatchSchema } = await import("@magic/contracts");
  const fixture = (await import("../fixtures/course.json")).default;
  const directory = mkdtempSync(join(tmpdir(), "magic-outlook-command-"));
  const store = createStore(join(directory, "coursework.sqlite"));
  const core = createCore(store, { fixture: captureBatchSchema.parse(fixture) });
  try {
    await core.execute({ type: "fixture" });
    const course = store.resources().filter((r) => !r.deleted && r.courseId !== OUTLOOK_CALENDAR_COURSE_ID).length;
    store.ingest({
      source: { id: "calendar:outlook:x", label: "Outlook calendar", kind: "calendar", accountScope: "local", courseId: OUTLOOK_CALENDAR_COURSE_ID, scope: "outlook_calendar" },
      observedAt: new Date().toISOString(), complete: true, status: "ok",
      resources: Array.from({ length: 6 }, (_, i) => ({
        externalId: `calendar:m${i}`, kind: "event" as const, courseId: OUTLOOK_CALENDAR_COURSE_ID, courseName: "Outlook calendar",
        title: `Private meeting ${i}`, url: "https://outlook.office.com/calendar/", text: "", deadlines: [], points: null, submitted: null,
        policy: { mode: "coaching" as const, evidence: "Personal calendar." },
        calendar: { uid: `m${i}@x`, start: "2026-09-27T15:00:00Z", end: "2026-09-27T16:00:00Z", allDay: false, timezone: "UTC" },
      })),
    });
    const result = await core.execute({ type: "outlook-disconnect" });
    assert.equal(result.snapshot.resources.filter((r) => r.courseId === OUTLOOK_CALENDAR_COURSE_ID && !r.deleted).length, 0);
    assert.equal(result.snapshot.sources.some((s) => s.courseId === OUTLOOK_CALENDAR_COURSE_ID), false);
    assert.equal(result.snapshot.resources.filter((r) => !r.deleted && r.courseId !== OUTLOOK_CALENDAR_COURSE_ID).length, course, "coursework untouched");
    // Nothing connected is a harmless no-op.
    await core.execute({ type: "outlook-disconnect" });
  } finally {
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
