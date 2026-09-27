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
