import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createStore } from "@magic/storage";
import { createCore, readContextSpan, resolveAssignmentContext, CONTEXT_LIMITS } from "@magic/core";
import { captureBatchSchema, type Store } from "@magic/contracts";
import { openSession } from "../packages/agent-api/src/session";
import { registerHooks } from "node:module";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { availableTargets, initialDraft } from "../apps/desktop/src/renderer/task-workspace/model";
import { allowedTaskUrls } from "../apps/desktop/src/task-windows/controller";

Object.assign(globalThis, { React });
registerHooks({ load: (url, context, next) => url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context) });

// Synthetic shapes of two real cases (no private text): an empty "Lecture 7" Canvas assignment
// whose course website schedule is saved separately, and a TSP assignment with a Canvas body,
// direct Box links and two submission types.
const ACCOUNT = "synthetic-account";
const COURSE = "639";
const SITE = "https://course.example.edu/";
const SCHEDULE = [
  "Course schedule",
  "Sep 16",
  "Lecture 5: Planning with agents. Readings: Planning notes.",
  "Sep 23",
  "Lecture 7: Frontend with React and TypeScript; full-stack integration.",
  "Activity: Book Review Arc (4/6). Readings: React Quick Start, React TypeScript Cheatsheet, React Router Tutorial.",
  "Sep 24",
  "Lecture 7: Frontend with React and TypeScript (continued).",
  "Sep 30",
  "Lecture 8: Testing the full stack. Readings: Testing Library.",
  "Lecture 17: Deployment.",
].join("\n");
const SCHEDULE_LINKS = [
  { url: "https://react.dev/learn", text: "React Quick Start" },
  { url: "https://react-typescript-cheatsheet.netlify.app/", text: "React TypeScript Cheatsheet" },
  { url: "https://reactrouter.com/tutorials", text: "React Router Tutorial" },
  { url: "https://testing-library.com/", text: "Testing Library" },
];
const BOX = ["https://example.app.box.com/s/segmentation-brief", "https://example.app.box.com/s/segmentation-template"];

function canvas(store: Store, account: string, course: string, resources: unknown[]) {
  store.ingest(captureBatchSchema.parse({
    source: { id: `canvas-${account}-${course}`, label: "Synthetic Canvas", kind: "canvas", accountScope: account, courseId: course, scope: "assignments" },
    observedAt: "2026-09-26T18:00:00Z", complete: true, status: "ok", resources,
  }));
}
function web(store: Store, account: string, course: string, text: string, status: "ok" | "partial" = "partial") {
  store.ingest(captureBatchSchema.parse({
    source: { id: `web-${account}-${course}`, label: "Course website", kind: "web", accountScope: account, courseId: course, scope: "site" },
    observedAt: "2026-09-26T18:00:00Z", complete: status === "ok", status,
    resources: [{ externalId: `schedule-${course}`, kind: "material", courseId: course, courseName: "CS 639", title: "Schedule", url: `${SITE}schedule/`, text, links: SCHEDULE_LINKS, deadlines: [], points: null, submitted: null }],
  }));
}
function setup(schedule = SCHEDULE) {
  const store = createStore(":memory:");
  const core = createCore(store, { fixture: captureBatchSchema.parse({ source: { id: "x", label: "x", kind: "canvas", accountScope: "a", courseId: "x", scope: "assignments" }, observedAt: "2026-09-26T18:00:00Z", complete: true, status: "ok", resources: [] }) });
  canvas(store, ACCOUNT, COURSE, [
    { externalId: "lec7", kind: "assignment", courseId: COURSE, courseName: "CS 639", title: "Lecture 7 activity", url: `https://canvas.example.edu/courses/${COURSE}/assignments/7`, text: "", submissionTypes: ["none"], dueAt: "2026-09-24T04:59:00Z", deadlines: [], points: 1, submitted: false },
    { externalId: "tsp", kind: "assignment", courseId: COURSE, courseName: "CS 639", title: "TSP Market Segmentation", url: `https://canvas.example.edu/courses/${COURSE}/assignments/8`,
      text: "Use the segmentation brief and the template. Submit your finished analysis.", submissionTypes: ["online_url", "online_upload"],
      links: [{ url: BOX[0], text: "Segmentation brief" }, BOX[1], `https://canvas.example.edu/courses/${COURSE}/modules`, "https://canvas.example.edu/courses/999/pages/other"],
      deadlines: [], points: 10, submitted: false },
  ]);
  web(store, ACCOUNT, COURSE, schedule);
  const id = (externalId: string) => store.resources().find(r => r.externalId === externalId && r.sourceId === `canvas-${ACCOUNT}-${COURSE}`)!.id;
  return { store, core, lecture: id("lec7"), tsp: id("tsp") };
}

test("Lecture 7 Start work: cited same-course schedule section, provisional, submission unknown", async () => {
  const { core, lecture } = setup();
  const set = (await core.execute({ type: "work-set", id: lecture })).workSet!;
  const context = set.context!;
  assert.equal(context.instructions.status, "empty");
  assert.equal(context.anchor, "Lecture 7");
  assert.equal(context.submission.status, "none_listed");
  assert.match(context.submission.text, /doesn't show whether there's something to hand in/);
  assert.equal(context.sections.length, 2);
  const [first, second] = context.sections;
  assert.match(first!.quote, /^Lecture 7: Frontend with React/);
  assert.match(first!.quote, /Book Review Arc \(4\/6\)/);
  assert.ok(!first!.quote.includes("Lecture 8") && !first!.quote.includes("Sep 24"));
  assert.deepEqual(first!.links.map(l => l.text), ["React Quick Start", "React TypeScript Cheatsheet", "React Router Tutorial"]);
  assert.equal(first!.provisional, true);
  assert.equal(first!.linkedToAssignment, false);
  assert.match(first!.reason, /isn't linked to the assignment/);
  // Both dated headings are kept and the conflict is stated, not resolved.
  assert.deepEqual([first!.dates, second!.dates], [["Sep 23"], ["Sep 24"]]);
  assert.match(first!.dateConflict!, /more than one date \(Sep 23, Sep 24\)/);
  assert.equal(context.canvas.dueAt, "2026-09-24T04:59:00Z");
  // Exact span and version of the cut.
  const schedule = set.held.find(h => h.title === "Schedule")!;
  assert.match(schedule.reason, /Possibly related: its Lecture 7 section\. Not linked to this assignment\./);
  assert.ok(first!.contentHash && first!.observedAt);
  assert.ok(context.unknowns.some(u => /Detailed instructions: not in the Canvas assignment.*isn't confirmed/.test(u)));
  assert.ok(context.unknowns.some(u => /Where to submit: not confirmed/.test(u)));
  assert.ok(context.sources.some(s => s.kind === "web" && s.complete === false && /only partly/.test(s.note ?? "")));
  // It is shown, never opened: only the Canvas assignment is an item.
  assert.deepEqual(set.items.map(i => i.role), ["instructions"]);
});

test("a schedule saved without line breaks gives the same sections and dates", () => {
  const { store, lecture } = setup(SCHEDULE.replaceAll("\n", " "));
  const context = resolveAssignmentContext(store, lecture);
  assert.deepEqual(context.sections.map(s => s.dates), [["Sep 23"], ["Sep 24"]]);
  assert.match(context.sections[0]!.quote, /^Lecture 7: Frontend with React.*React Router Tutorial\.$/);
  assert.ok(!context.sections[1]!.quote.includes("Sep 30"));
  assert.ok(context.sections[0]!.dateConflict);
});

test("TSP: Canvas body and direct Box links; URL vs upload submission; Box bodies unread", async () => {
  const { core, tsp } = setup();
  const set = (await core.execute({ type: "work-set", id: tsp })).workSet!;
  const context = set.context!;
  assert.equal(context.instructions.status, "captured");
  assert.equal(context.sections.length, 0); // captured instructions: no provisional search
  assert.deepEqual(context.submission.types, ["online_url", "online_upload"]);
  assert.match(context.submission.text, /a website address \(URL\) or a file upload/);
  assert.deepEqual(context.links.map(l => [l.url, l.captured]), [[BOX[0], null], [BOX[1], null]]);
  for (const l of context.links) assert.match(l.note, /hasn't read this page or file, so its contents aren't part of these instructions/);
  assert.ok(context.unknowns.some(u => /2 linked pages or files haven't been read: example\.app\.box\.com/.test(u)));
  // Box links remain action targets in the work set.
  assert.deepEqual(set.items.filter(i => i.provenance === "assignment_link").map(i => (i.target as { url: string }).url), BOX);
  const text = JSON.stringify(context);
  for (const absent of ["courses/999", "/modules"]) assert.ok(!text.includes(absent), absent);
});

test("guards: cross-account, excluded course, other lecture numbers and bounded output", async () => {
  // Same course ID under another account, and another course in this account, both with Lecture 7.
  const { store, core, lecture } = setup("Course schedule\nLecture 17: Deployment.\nLecture 70: none.");
  web(store, "other-account", COURSE, SCHEDULE);
  web(store, ACCOUNT, "640", SCHEDULE);
  let context = (await core.execute({ type: "work-set", id: lecture })).workSet!.context!;
  assert.equal(context.sections.length, 0);
  assert.ok(context.unknowns.some(u => /no saved page names it/.test(u)));
  assert.ok(!context.sources.some(s => s.sourceId.includes("other-account") || s.sourceId.endsWith("-640")));

  const fresh = setup(`${SCHEDULE}\n${"Lecture 7: again\n".repeat(20)}`);
  context = resolveAssignmentContext(fresh.store, fresh.lecture);
  assert.ok(context.sections.length <= CONTEXT_LIMITS.sections);
  for (const s of context.sections) assert.ok(s.quote.length <= CONTEXT_LIMITS.sectionChars);
  // A permitted predicate that hides the schedule (excluded course / denied category) leaks nothing.
  const schedule = fresh.store.resources().find(r => r.title === "Schedule")!;
  context = resolveAssignmentContext(fresh.store, fresh.lecture, { permitted: r => r.id !== schedule.id });
  assert.equal(context.sections.length, 0);
  assert.throws(() => resolveAssignmentContext(fresh.store, fresh.lecture, { permitted: () => false }), /isn't available/);
  // Excluding the course blocks Start work entirely.
  fresh.store.setCourseOverride({ accountScope: ACCOUNT, courseId: COURSE, included: false } as never);
  await assert.rejects(() => fresh.core.execute({ type: "work-set", id: fresh.lecture }), /not currently available/);
});

test("agent contract: the real session's allowed() gates the resolver and the bounded span read", () => {
  const { store, lecture } = setup();
  const token = "t".repeat(64);
  const grant = { id: "client", label: "Test client", recipient: "local" as const, enabled: true, courses: [{ accountScope: ACCOUNT, courseId: COURSE }], categories: ["course_text" as const], tokenHash: createHash("sha256").update(token).digest("hex") };
  store.setMcpGrant(grant);
  const session = openSession(store, { clientId: "client", token });
  const context = resolveAssignmentContext(store, lecture, { permitted: r => session.allowed(r) });
  const section = context.sections[0]!;
  const span = readContextSpan(store, lecture, section.resourceId, section.start, 10_000, r => session.allowed(r));
  assert.equal(span.text.length, Math.min(CONTEXT_LIMITS.readChars, span.total - section.start));
  assert.ok(span.text.startsWith("Lecture 7"));
  // The grant no longer covers the course: nothing resolves or reads.
  store.setMcpGrant({ ...grant, courses: [] });
  const narrowed = openSession(store, { clientId: "client", token });
  assert.throws(() => resolveAssignmentContext(store, lecture, { permitted: r => narrowed.allowed(r) }), /isn't available/);
  assert.throws(() => readContextSpan(store, lecture, section.resourceId, 0, 100, r => narrowed.allowed(r)), /isn't available/);
  // Revoked: the session itself refuses to open.
  store.setMcpGrant({ ...grant, enabled: false });
  assert.throws(() => openSession(store, { clientId: "client", token }), /revoked/);
});

test("panel path: the same work set renders the cited section and offers its pages unselected", async () => {
  const { core, lecture, tsp } = setup();
  const { ContextFacts } = await import("../apps/desktop/src/renderer/task-workspace/TaskWorkspace");
  const set = (await core.execute({ type: "work-set", id: lecture })).workSet!;
  const html = renderToStaticMarkup(createElement(ContextFacts, { context: set.context! }));
  assert.match(html, /Possibly related: Lecture 7 in Schedule/);
  assert.match(html, /isn&#x27;t linked to this assignment, so it may not be its instructions/);
  assert.match(html, /<blockquote cite="https:\/\/course\.example\.edu\/schedule\/">Lecture 7: Frontend with React/);
  assert.doesNotMatch(html, /more than one date \(Sep 23, Sep 24\)/, "temporary display suppression retains the tested core conflict evidence");
  assert.match(html, /Course website was read only partly/);
  assert.match(html, /Canvas lists no online submission/);
  const targets = availableTargets({ set, gitlab: { kind: "none" } as never, tools: [] });
  assert.deepEqual(targets.map(t => t.label), ["Schedule", "React Quick Start", "React TypeScript Cheatsheet", "React Router Tutorial"]);
  assert.ok(targets.every(t => /^Possibly related · /.test(t.detail) && !t.external));
  assert.deepEqual(initialDraft(null, targets), { work: null, support: [], pages: [] }); // nothing pre-selected
  const allowed = allowedTaskUrls(set, []);
  for (const t of targets) assert.equal(allowed.get(t.url), "work_set");

  const tspSet = (await core.execute({ type: "work-set", id: tsp })).workSet!;
  const tspHtml = renderToStaticMarkup(createElement(ContextFacts, { context: tspSet.context! }));
  assert.match(tspHtml, /a website address \(URL\) or a file upload/);
  assert.match(tspHtml, /2 linked pages \(example\.app\.box\.com\) open as linked\. Magic hasn&#x27;t read /);
  assert.ok(!/blockquote/.test(tspHtml));
});

test("source excerpt display removes markup without changing stored evidence", async () => {
  const { sourceQuoteText } = await import("../apps/desktop/src/renderer/task-workspace/TaskWorkspace");
  const quote = '<p>Lecture 7 &mdash; React</p><ul><li>Read <a href="https://example.org">A &amp; B</a></li></ul>';
  assert.equal(sourceQuoteText(quote), "Lecture 7 — React\n\nRead A & B");
  assert.equal(sourceQuoteText('<script>alert(1)</script><p>&#x1F4DA; &lt;example&gt;</p>'), "📚 <example>");
});
