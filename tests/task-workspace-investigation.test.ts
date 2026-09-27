import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResourceView, Snapshot, SourceInvestigationResult } from "@magic/contracts";
import { defaultPrivacy } from "@magic/contracts";
import {
  SourceInvestigation, clearInvestigations, investigationRelevance, type InvestigationBridge, type InvestigationState,
} from "../apps/desktop/src/renderer/task-workspace/source-investigation";
import { clearTaskWorkspaces } from "../apps/desktop/src/renderer/task-workspace/model";

Object.assign(globalThis, { React });
registerHooks({ load: (url, context, next) => url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context) });

/** A bridge whose answers arrive only when the test says so, like a slow paid call. */
function slowBridge() {
  const calls: { operationId: string; assignmentId: string; resolve: (v: SourceInvestigationResult) => void; reject: (e: unknown) => void }[] = [];
  const stopped: string[] = [];
  const bridge: InvestigationBridge = {
    investigateAssignment: request => new Promise((resolve, reject) => { calls.push({ ...request, resolve, reject }); }),
    stopAssignmentInvestigation: async operationId => { stopped.push(operationId); },
  };
  return { bridge, calls, stopped };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
let ids = 0;
const nextId = () => `op-${++ids}`;
function mount(bridge: InvestigationBridge, account = "uw", assignment = "a7") {
  const seen: InvestigationState[] = [];
  const controller = new SourceInvestigation(account, assignment, bridge, state => seen.push(state), nextId);
  return { controller, seen, last: () => seen.at(-1) };
}

const citation = (patch: Partial<SourceInvestigationResult["findings"][number]["citations"][number]> = {}) => ({
  resourceId: "p7", contentHash: "ph1", version: 3, start: 120, end: 180, excerpt: "Lecture 7 activity: bring two questions about the reading.",
  provisional: true, sourceUrl: "https://canvas.wisc.edu/courses/1/pages/week-7", ...patch,
});
const result = (findings: SourceInvestigationResult["findings"]): SourceInvestigationResult => ({
  status: "partial", summary: "The course page for week 7 describes the activity.", assignmentId: "a7",
  workSet: { assignmentId: "a7", items: [], held: [] }, findings, unknowns: [], model: "m", client: "claude",
});
const titleOnly = result([{ kind: "instruction", text: "Bring two questions about the reading.", citations: [citation()] }]);

const assignment = { id: "a7", kind: "assignment", title: "lecture 7 activity", courseId: "c1", sourceId: "s1", contentHash: "h1", deleted: false, text: "" } as unknown as ResourceView;
const page = { id: "p7", kind: "page", title: "Week 7", courseId: "c1", sourceId: "s1", contentHash: "ph1", deleted: false, text: "" } as unknown as ResourceView;
const elsewhere = { id: "x1", kind: "page", title: "Other course", courseId: "c2", sourceId: "s2", contentHash: "xh1", deleted: false } as unknown as ResourceView;
const otherAccount = { id: "y1", kind: "page", title: "Same course id, other account", courseId: "c1", sourceId: "s3", contentHash: "yh1", deleted: false } as unknown as ResourceView;
const base = {
  resources: [assignment, page, elsewhere, otherAccount],
  sources: [
    { id: "s1", accountScope: "uw", courseId: "c1", status: "ok" }, { id: "s2", accountScope: "uw", courseId: "c2", status: "ok" },
    { id: "s3", accountScope: "other", courseId: "c1", status: "ok" },
  ],
  privacy: { ...defaultPrivacy, mode: "selective_cloud", shareCourseText: true },
  consents: [{ recipient: "claude", disclosureVersion: "1", grantedAt: "2026-09-27T10:00:00Z" }],
  courseOverrides: [], courseIntelligence: [], jobs: [], receipts: [], gitlabLinks: [], generatedAt: "2026-09-27T10:00:00Z",
} as unknown as Snapshot;
const relevance = (snap: Snapshot) => investigationRelevance(snap, assignment, "uw");

test("Stop wins over a late success and a late failure; nothing reruns until the student asks", async () => {
  clearInvestigations();
  const { bridge, calls, stopped } = slowBridge();
  const view = mount(bridge);
  view.controller.sync(relevance(base), true);
  assert.equal(calls.length, 1);
  assert.equal(view.last()?.kind, "loading");
  view.controller.stop();
  assert.deepEqual(stopped, [calls[0]!.operationId]);
  calls[0]!.resolve(titleOnly);
  await flush();
  assert.deepEqual(view.last(), { kind: "stopped" }, "a success arriving after Stop is ignored");
  // The same evidence refreshes, then the student reopens: still stopped, no new call.
  view.controller.sync(relevance(base), true);
  const reopened = mount(bridge);
  assert.deepEqual(SourceInvestigation.initial("uw", "a7", relevance(base), true), { kind: "stopped", changed: false });
  reopened.controller.sync(relevance(base), true);
  assert.equal(calls.length, 1);
  // Only the explicit request runs again; a failure that arrives after a second Stop is ignored too.
  reopened.controller.restart();
  assert.equal(calls.length, 2);
  reopened.controller.stop();
  calls[1]!.reject(new Error("Error invoking remote method 'magic:source-investigate': Error: Investigation stopped."));
  await flush();
  assert.equal(reopened.last()?.kind, "stopped");
  assert.equal(view.seen.filter(s => s.kind === "ready" || s.kind === "error").length + reopened.seen.filter(s => s.kind === "ready" || s.kind === "error").length, 0);
});

test("leaving the page or switching accounts cancels without a late overwrite, and doesn't count as Stop", async () => {
  clearInvestigations();
  const { bridge, calls, stopped } = slowBridge();
  const view = mount(bridge);
  view.controller.sync(relevance(base), true);
  view.controller.release();
  assert.deepEqual(stopped, [calls[0]!.operationId]);
  calls[0]!.resolve(titleOnly);
  await flush();
  assert.equal(view.last()?.kind, "loading", "the unmounted view receives nothing after release");
  assert.deepEqual(SourceInvestigation.initial("uw", "a7", relevance(base), true), { kind: "loading" }, "no stale result was saved");
  // Another account's view of the same assignment ID never sees this account's results.
  const other = mount(bridge, "other");
  other.controller.sync(investigationRelevance(base, assignment, "other"), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.assignmentId, "a7");
});

test("unrelated snapshot refreshes and reopening show the saved result without a paid rerun", async () => {
  clearInvestigations();
  const { bridge, calls } = slowBridge();
  const view = mount(bridge);
  const first = relevance(base);
  view.controller.sync(first, true);
  calls[0]!.resolve(titleOnly);
  await flush();
  assert.equal(view.last()?.kind, "ready");
  const unrelated: Snapshot[] = [
    { ...base, generatedAt: "2026-09-27T11:00:00Z", jobs: [{ id: "j" }], receipts: [{ id: "r" }] } as unknown as Snapshot,
    { ...base, gitlabLinks: [{ accountScope: "uw", courseId: "c1", projectPath: "cs/x", addedAt: "2026-09-27T11:00:00Z" }] },
    { ...base, resources: [assignment, page, { ...elsewhere, contentHash: "xh2" }, otherAccount] },
    { ...base, resources: [assignment, page, elsewhere, { ...otherAccount, contentHash: "yh2" }] },
    { ...base, resources: [otherAccount, elsewhere, page, assignment] },
    { ...base, sources: base.sources.map(s => ({ ...s, lastAttemptAt: "2026-09-27T11:00:00Z", status: s.id === "s1" ? "partial" : s.status })) } as unknown as Snapshot,
  ];
  for (const snap of unrelated) {
    assert.equal(relevance(snap), first);
    view.controller.sync(relevance(snap), true);
  }
  const reopened = mount(bridge);
  assert.equal(SourceInvestigation.initial("uw", "a7", first, true).kind, "ready");
  reopened.controller.sync(first, true);
  assert.equal(calls.length, 1, "one paid call for one evidence state");
});

test("a relevant evidence, source, inclusion or privacy change reruns once, replacing the older operation", async () => {
  clearInvestigations();
  const { bridge, calls, stopped } = slowBridge();
  const view = mount(bridge);
  view.controller.sync(relevance(base), true);
  calls[0]!.resolve(titleOnly);
  await flush();
  const relevant: Snapshot[] = [
    { ...base, resources: [assignment, { ...page, contentHash: "ph2" }, elsewhere, otherAccount] },
    { ...base, resources: [{ ...assignment, contentHash: "h2" }, page, elsewhere, otherAccount] },
    { ...base, resources: [assignment, { ...page, deleted: true }, elsewhere, otherAccount] },
    { ...base, sources: base.sources.map(s => s.id === "s1" ? { ...s, status: "inaccessible" } : s) } as unknown as Snapshot,
    { ...base, privacy: { ...base.privacy, shareCourseText: false } },
    { ...base, consents: [] },
    { ...base, courseOverrides: [{ accountScope: "uw", courseId: "c1", included: false }] },
  ];
  for (const snap of relevant) assert.notEqual(relevance(snap), relevance(base));
  const changed = relevance(relevant[0]!);
  view.controller.sync(changed, true);
  view.controller.sync(changed, true);
  assert.equal(calls.length, 2, "the same new evidence starts one run");
  // Evidence changes again while that run is pending: the pending one is stopped and its late answer ignored.
  view.controller.sync(relevance(relevant[1]!), true);
  assert.equal(calls.length, 3);
  assert.ok(stopped.includes(calls[1]!.operationId));
  calls[1]!.resolve(titleOnly);
  await flush();
  assert.equal(view.last()?.kind, "loading");
  calls[2]!.reject(new Error("Saved course evidence changed."));
  await flush();
  assert.deepEqual(view.last(), { kind: "error", message: "Saved course evidence changed." });
});

test("Delete local data drops saved investigation results with the task setups", async () => {
  clearInvestigations();
  const { bridge, calls } = slowBridge();
  const view = mount(bridge);
  view.controller.sync(relevance(base), true);
  calls[0]!.resolve(titleOnly);
  await flush();
  clearTaskWorkspaces(null);
  assert.deepEqual(SourceInvestigation.initial("uw", "a7", relevance(base), true), { kind: "loading" });
});

const { SourceInvestigationFacts, TaskWorkspace } = await import("../apps/desktop/src/renderer/task-workspace/TaskWorkspace");
const facts = (state: InvestigationState, lookup?: (id: string) => ResourceView | undefined) =>
  renderToStaticMarkup(createElement(SourceInvestigationFacts, { state, onStop: () => {}, onRestart: () => {}, lookup }));
const visible = (html: string) => html.replace(/<span[^>]*class="magic-info-panel"[^>]*>[\s\S]*?<\/span>/g, "").replace(/<[^>]+>/g, " ");

test("a title-match-only finding is related course context, not a confirmed instruction", () => {
  const html = facts({ kind: "ready", value: titleOnly });
  assert.match(html, /Related course context/);
  assert.match(html, /isn(’|'|&#x27;)t confirmed as this assignment(’|'|&#x27;)s instructions/);
  assert.doesNotMatch(html, /Confirmed instruction/);
  const linked = facts({ kind: "ready", value: result([{ kind: "instruction", text: "Submit a PDF.", citations: [citation({ provisional: false })] }]) });
  assert.match(linked, /Confirmed instruction/);
  assert.doesNotMatch(linked, /Related course context/);
});

test("citations: quoted source and link inline; version and characters only in the info disclosure", () => {
  const saved = { ...page, title: "Week 7: Motivation", contentHash: "ph1", text: `${"x".repeat(120)}${"Bring two questions about the reading and one example.".padEnd(60)}${"y".repeat(40)}` } as unknown as ResourceView;
  const html = facts({ kind: "ready", value: titleOnly }, id => id === "p7" ? saved : undefined);
  const text = visible(html);
  assert.match(html, /Bring two questions about the reading\.<span class="task-workspace__cite-ref"> \[(?:<!-- -->)?1(?:<!-- -->)?\]<\/span>/);
  assert.match(html, /<blockquote cite="https:\/\/canvas.wisc.edu\/courses\/1\/pages\/week-7">Bring two questions about the reading and one example\.<\/blockquote>/, "the saved local span, not the sent excerpt");
  assert.match(html, /<a href="https:\/\/canvas.wisc.edu\/courses\/1\/pages\/week-7" target="_blank" rel="noreferrer">Week 7: Motivation<\/a>/);
  assert.doesNotMatch(text, /version|characters|120/i, "technical metadata isn't in the reading flow");
  assert.match(html, /aria-label="Source 1 details"/);
  assert.match(html, /class="magic-info-panel"[^>]*>Saved version (?:<!-- -->)?3(?:<!-- -->)?, characters (?:<!-- -->)?120(?:<!-- -->)?–(?:<!-- -->)?180/);
  // A changed or unknown source falls back to the excerpt the result carried, and to the link's host for a name.
  const fallback = facts({ kind: "ready", value: titleOnly });
  assert.match(fallback, /<blockquote[^>]*>Lecture 7 activity: bring two questions about the reading\.<\/blockquote>/);
  assert.match(fallback, />canvas\.wisc\.edu<\/a>/);
});

test("pending, stopped and failed states keep one keyboard control in the region", () => {
  assert.match(facts({ kind: "loading" }), /role="status">Checking saved course sources[\s\S]*<button type="button" class="task-workspace__inline-action">Stop<\/button>/);
  assert.match(facts({ kind: "stopped" }), /Stopped checking course sources[\s\S]*>Check course sources<\/button>/);
  assert.match(facts({ kind: "stopped", changed: true }), /changed since/);
  assert.match(facts({ kind: "error", message: "Choose a connected Claude Code or Codex client first." }), /couldn(’|'|&#x27;)t be checked: Choose a connected[\s\S]*>Try again<\/button>/);
  assert.match(facts({ kind: "loading" }), /<section tabindex="-1" class="task-workspace__context task-workspace__investigation" aria-label="What the course sources say">/);
  assert.equal(facts({ kind: "idle" }), "");
});

test("reopening the assignment renders the saved cited result on first paint", async () => {
  clearInvestigations();
  const { bridge, calls } = slowBridge();
  Object.assign(globalThis, {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: { magic: { ...bridge, execute: async () => { throw new Error("not used"); } }, addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", hasFocus: () => true },
  });
  const view = mount(bridge);
  view.controller.sync(relevance(base), true);
  calls[0]!.resolve(titleOnly);
  await flush();
  const html = renderToStaticMarkup(createElement(TaskWorkspace, { resource: { ...assignment, observedAt: "2026-09-27T09:00:00Z" } as ResourceView, snapshot: base, refreshKey: "changed-revision" }));
  assert.match(html, /What the course sources say/);
  assert.match(html, /Related course context/);
  assert.doesNotMatch(html, /Checking saved course sources/);
  assert.equal(calls.length, 1);
});
