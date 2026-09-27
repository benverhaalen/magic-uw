import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { railBlockFacts, railOverlaps } from "../apps/desktop/src/renderer/TodayRail";
import type { RailEvent, RailSuggestion } from "@magic/domain";

const suggestion: RailSuggestion = {
  id: "work:essay", type: "work", resourceId: "essay", title: "Work on Essay 2",
  courseName: "ENGL 100", reason: "Due tomorrow and about two hours of work left.",
  factors: ["Due tomorrow", "Essay"], startMin: 14 * 60, endMin: 15 * 60 + 30,
  effort: { category: "essay", lowMin: 90, highMin: 180, basis: "title" },
  state: "suggested", doneBy: null,
};
const meeting: RailEvent = {
  id: "sync", title: "Advisor meeting", courseName: "Outlook calendar",
  startMin: 15 * 60, endMin: 15 * 60 + 30, startOnly: false,
  location: "Bascom 117", onlineMeeting: "teams", response: "tentative",
};

test("suggestion details show time, course, due, effort, reason and overlaps", () => {
  const facts = railBlockFacts({ kind: "suggestion", suggestion, dueLabel: "Wed, Sep 30, 11:59 PM", overlaps: ["Advisor meeting"] });
  assert.deepEqual(facts, [
    { label: "When", value: "2:00 PM–3:30 PM · 1 h 30 m" },
    { label: "Course", value: "ENGL 100" },
    { label: "Due", value: "Wed, Sep 30, 11:59 PM" },
    { label: "Effort", value: "Essay, usually 1 h 30 m to 3 h" },
    { label: "Why", value: "Due tomorrow and about two hours of work left." },
    { label: "Overlaps", value: "Advisor meeting" },
  ]);
});

test("event details leave out facts the calendar did not supply", () => {
  const facts = railBlockFacts({ kind: "event", event: { ...meeting, location: undefined, onlineMeeting: undefined, response: undefined, endMin: null, startOnly: true }, overlaps: [] });
  assert.deepEqual(facts, [
    { label: "When", value: "3:00 PM, start time only" },
    { label: "Calendar", value: "Outlook calendar" },
  ]);
  const full = railBlockFacts({ kind: "event", event: meeting, overlaps: [] }).map(f => f.label);
  assert.deepEqual(full, ["When", "Calendar", "Where", "Online", "Your answer"]);
});

test("overlaps ignore the block itself, declined meetings and touching edges", () => {
  const items = [
    { ...meeting },
    { ...meeting, id: "declined", title: "Declined sync", response: "declined" as const },
    { id: "after", title: "Club", startMin: 15 * 60 + 30, endMin: 16 * 60 },
    { id: "open", title: "Office hours", startMin: 13 * 60 + 45, endMin: null },
    suggestion,
  ];
  assert.deepEqual(railOverlaps(suggestion, items), ["Advisor meeting", "Office hours"]);
});

test("the hover bar does not stay open after a mouse click", () => {
  const css = readFileSync(new URL("../apps/desktop/src/renderer/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.rail-slot:focus-within/);
  assert.match(css, /\.rail-slot:has\(:focus-visible\) \.rail-tools/);
});
