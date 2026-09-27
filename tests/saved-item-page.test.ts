import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResourceView, Snapshot } from "@magic/contracts";

process.env.TZ = "America/Chicago";
Object.assign(globalThis, { React, window: { magic: {} } });
registerHooks({ load: (url, context, next) => url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context) });

const { eventPresentation, ResourceEvent } = await import("../apps/desktop/src/renderer/ResourceEvent");
const { ResourceDetailHeader } = await import("../apps/desktop/src/renderer/ResourceDetailHeader");
const { ResourceAssignment, instructionsState } = await import("../apps/desktop/src/renderer/ResourceAssignment");

// Synthetic items only; no captured student or course text.
const source = { id: "src-1", label: "Canvas", status: "ok", complete: true, accountScope: "synthetic-account" };
const base = {
  sourceId: "src-1", courseId: "101", courseName: "Synthetic Course", url: "https://canvas.example.edu/courses/101/assignments/7",
  observedAt: "2026-09-20T15:00:00.000Z", contentHash: "hash-1", kindLabel: null, text: "", completed: false,
  deadline: { dueAt: null, planningAt: null, conflict: false, claims: [], reason: "No date" },
} as unknown as ResourceView;
const snapshot = { sources: [source], resources: [], links: [], privacy: {}, courseIntelligence: [] } as unknown as Snapshot;
const event = (patch: Partial<ResourceView>) => ({ ...base, id: "ev-1", kind: "event", title: "Section meeting", ...patch }) as ResourceView;
const assignment = (patch: Partial<ResourceView>) => ({ ...base, id: "as-1", kind: "assignment", title: "Project step 2", points: 20, ...patch }) as ResourceView;
const html = (element: React.ReactElement) => renderToStaticMarkup(element);

test("an all-day calendar DATE keeps its own day and treats DTEND as exclusive", () => {
  const one = eventPresentation(event({ calendar: { uid: "u1", start: "2026-10-01", end: "2026-10-02", allDay: true } }));
  assert.match(one.when!, /Oct 1, 2026 · all day/);
  assert.doesNotMatch(one.when!, /Sep 30/);
  const range = eventPresentation(event({ calendar: { uid: "u2", start: "2026-10-01", end: "2026-10-04", allDay: true } }));
  assert.match(range.when!, /Oct 1.*3, 2026 · all day/);
});

test("a timed event shows its range, and says when the end is missing", () => {
  const timed = eventPresentation(event({ calendar: { uid: "u3", start: "2026-10-01T15:00:00.000Z", end: "2026-10-01T16:20:00.000Z", allDay: false } }));
  assert.match(timed.when!, /10:00.*11:20/);
  const open = eventPresentation(event({ calendar: { uid: "u4", start: "2026-10-01T15:00:00.000Z", end: null, allDay: false } }));
  assert.match(open.when!, /end not provided/);
  assert.equal(eventPresentation(event({})).when, null);
});

test("the event page shows only verified facts and never the item-level AI panels", () => {
  const withFacts = event({ text: "Bring a laptop.", workflowState: "CANCELLED",
    calendar: { uid: "u5", start: "2026-10-01", end: "2026-10-02", allDay: true, location: "Room 120", onlineMeeting: "zoom", organizer: "Course staff", joinUrl: "https://zoom.example.com/j/1" } });
  const page = html(createElement(ResourceEvent, { resource: withFacts, open: () => undefined }));
  for (const text of ["Room 120", "Zoom", "Course staff", "Join meeting", "Bring a laptop."]) assert.ok(page.includes(text), text);
  const header = html(createElement(ResourceDetailHeader, { resource: withFacts, snapshot, open: () => undefined, changedWhileReading: false }));
  assert.match(header, /<dt>When<\/dt>.*Oct 1, 2026 · all day/);
  assert.match(header, /Cancelled · reported by calendar/);
  assert.doesNotMatch(header, /No confirmed due date/);

  const bare = html(createElement(ResourceEvent, { resource: event({}), open: () => undefined }));
  assert.match(bare, /No description was saved for this event/);
  assert.doesNotMatch(bare, /Where|Organizer|Join meeting/);
});

test("instructions state is honest about empty and sparse captures", () => {
  assert.deepEqual(instructionsState({ text: "  " }, true).text, null);
  assert.match(instructionsState({ text: "" }, true).note!, /No instructions were saved/);
  assert.match(instructionsState({ text: "See the course site." }, true).note!, /everything the saved assignment page says.*task setup/);
  assert.doesNotMatch(instructionsState({ text: "See the course site." }, false).note!, /task setup/);
  assert.equal(instructionsState({ text: "x".repeat(240) }, true).note, null);
});

test("the assignment page keeps full instructions, a source link, due and status", () => {
  const full = "Part 1\n\n" + "Write the parser and its tests. ".repeat(12);
  const resource = assignment({ text: full, submitted: false, deadline: { ...base.deadline, dueAt: "2026-10-10T04:59:00.000Z" } as ResourceView["deadline"] });
  const body = html(createElement(ResourceAssignment, { resource, snapshot, policy: null, provenance: null, onSetup: () => undefined, onNotice: () => undefined, onOpenOriginal: () => undefined }));
  assert.ok(body.includes(full.trim().slice(0, 60)) && body.includes("Write the parser and its tests. Write the parser and its tests. Write"));
  assert.match(body, /Instructions<\/h3>.*Open original/);
  assert.doesNotMatch(body, /everything the saved assignment page says/);
  const header = html(createElement(ResourceDetailHeader, { resource, snapshot, open: () => undefined, changedWhileReading: false }));
  assert.match(header, /<dt>Due<\/dt>.*Oct 9, 2026/);
  assert.match(header, /Not submitted · reported by source/);

  const empty = html(createElement(ResourceAssignment, { resource: assignment({}), snapshot, policy: null, provenance: null, onSetup: () => undefined, onNotice: () => undefined, onOpenOriginal: () => undefined }));
  assert.match(empty, /Instructions<\/h3>/);
  assert.match(empty, /No instructions were saved from the assignment page/);
  assert.doesNotMatch(empty, /class="source-text"/);
});

test("the item detail no longer carries local Ask, model setup or raw data preview; Data & AI keeps its controls", () => {
  const app = readFileSync(new URL("../apps/desktop/src/renderer/App.tsx", import.meta.url), "utf8");
  const detail = app.slice(app.indexOf("function ResourceDetail("), app.indexOf("function OutlookCalendar("));
  for (const junk of ["LocalAiPanel", "LearningPanel", "Start practice", "Explain this material", "Data preview", "Preview data", "Classify with Jev", "Exact prepared payload", 'type: "context"'])
    assert.ok(!detail.includes(junk), junk);
  assert.ok(detail.includes("<ResourceEvent"));
  // Source and provenance paths stay for every kind; saved learning records keep their component.
  for (const kept of ["<ResourceAssignment", "<ResourceProvenance", "Source content", "policyDetails"]) assert.ok(detail.includes(kept), kept);
  assert.ok(!app.includes('from "./LearningPanel"'), "no item-page practice footer import");
  assert.ok(!app.includes("LocalAiPanel"), "no item-level local model panel remains in the app shell");
  assert.ok(app.includes("<YourAiChoice"), "Data & AI keeps its AI choice");
  const choice = readFileSync(new URL("../apps/desktop/src/renderer/ai-choice/YourAiChoice.tsx", import.meta.url), "utf8");
  assert.ok(choice.includes("<LocalAiPanel privacyKey="), "global local-model settings stay on Data & AI");
  assert.ok(!app.includes("Preview the exact selection from an item"), "settings never promise the removed item preview");
});
