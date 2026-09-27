import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitlabLink, ResourceView, Snapshot, TaskWindowRequest, TaskWindowResult, WorkSet } from "@magic/contracts";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema } from "@magic/contracts";
import { linkExactEvidence } from "../packages/core/src/evidence";
import {
  STORAGE_KEY, availableTargets, clearTaskWorkspaces, courseGitlabLinks, forgetWorkspace, gitlabPathFromUrl, gitlabView, initialDraft,
  instructionsChanged, lastOpenLine, linkReceipt, mergeWindows, missingChoices, place, placementOf, pruneWorkspaces, readWorkspace, recordFrom,
  saveWorkspace, stageOf, windowPages, type KeyValueStore, type TaskWorkspaceRecord,
} from "../apps/desktop/src/renderer/task-workspace/model";
import { isUnsupported, readCourseTools, resetCourseToolsCache, toolsFromPageView } from "../apps/desktop/src/renderer/task-workspace/page-view-adapter";

Object.assign(globalThis, { React });
registerHooks({ load: (url, context, next) => url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context) });

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
}
const set: WorkSet = {
  previewHash: "a".repeat(64), assignmentId: "a7", assignmentTitle: "lecture 7 activity", contentHash: "h1",
  items: [{ resourceId: "a7", title: "lecture 7 activity", role: "instructions", reason: "Assignment page.", target: { kind: "web", url: "https://canvas.wisc.edu/courses/1/assignments/7" } }],
  held: [], notes: [],
};
const link = (projectPath: string, accountScope = "uw", courseId = "c1"): GitlabLink => ({ accountScope, courseId, projectPath, addedAt: "2026-09-27T10:00:00.000Z" });
const resource = { id: "a7", courseId: "c1", contentHash: "h1" };
// The MHR 322 assignment's shape: one direct link to an outside project site.
const MHR_ID = "3410f029-eb0c-43bf-908f-682ab1550ceb";
const PROJECT = "https://sites.google.com/undergroundshirts.com/mhr-322-ugp-t-shirt-project/home";
const mhrSet: WorkSet = {
  previewHash: "b".repeat(64), assignmentId: MHR_ID, assignmentTitle: "UGP T-shirt project", contentHash: "m1",
  items: [
    { resourceId: `${MHR_ID}:link:x`, title: "sites.google.com/undergroundshirts.com/mhr-322-ugp-t-shirt-project/home", role: "material", provenance: "assignment_link", reason: "Linked directly in the saved assignment.", target: { kind: "web", url: PROJECT } },
    { resourceId: MHR_ID, title: "UGP T-shirt project", role: "instructions", reason: "Assignment page.", target: { kind: "web", url: "https://canvas.wisc.edu/courses/322/assignments/9" } },
  ],
  held: [], notes: [],
};
const record = (patch: Partial<TaskWorkspaceRecord> = {}): TaskWorkspaceRecord => ({
  ...recordFrom({ previous: null, accountScope: "uw", resource, draft: { work: null, support: [], pages: [] }, gitlab: { state: "unset" }, now: new Date("2026-09-27T10:00:00Z") }),
  ...patch,
});

test("setups are keyed by exact account and resource, and survive a reread", () => {
  const store = memoryStore();
  saveWorkspace(record(), store);
  saveWorkspace({ ...record(), accountScope: "other", choices: { gitlab: { state: "none" }, work: null, support: [], pages: [] } }, store);
  assert.equal(readWorkspace("uw", "a7", store)?.choices.gitlab.state, "unset");
  assert.equal(readWorkspace("other", "a7", store)?.choices.gitlab.state, "none");
  assert.equal(readWorkspace("uw", "missing", store), null);
  forgetWorkspace("uw", "a7", store);
  assert.equal(readWorkspace("uw", "a7", store), null);
  assert.ok(readWorkspace("other", "a7", store));
  clearTaskWorkspaces(store);
  assert.equal(store.data.has(STORAGE_KEY), false);
});

test("malformed or tampered records are ignored, not trusted", () => {
  const store = memoryStore();
  store.setItem(STORAGE_KEY, JSON.stringify([
    { ...record(), choices: { prepared: true, gitlab: { state: "project", projectPath: "../../etc" }, tools: ["http://insecure.example", "https://ok.example/x", "javascript:alert(1)"] },
      windows: [{ key: "instructions", role: "instructions", url: "https://canvas.wisc.edu/x", bundleId: "org.mozilla.firefox", pid: 42, windowNumber: 7, placed: true, openedAt: "t" },
        { key: "bad", role: "work", url: "http://insecure.example", bundleId: "b", pid: 1, windowNumber: 2, placed: true, openedAt: "t" },
        { key: "bad2", role: "boss", url: "https://ok.example", bundleId: "b", pid: -1, windowNumber: 2, placed: true, openedAt: "t" }] },
    { v: 2, accountScope: "uw", resourceId: "x" },
  ]));
  const read = readWorkspace("uw", "a7", store)!;
  assert.deepEqual(read.choices.gitlab, { state: "unset" });
  // An earlier setup's course tool becomes an own-window page; unsafe entries are dropped.
  assert.deepEqual(read.choices.support, ["tool:https://ok.example/x"]);
  assert.deepEqual(read.windows.map(w => w.key), ["instructions"]);
  store.setItem(STORAGE_KEY, "{not json");
  assert.equal(readWorkspace("uw", "a7", store), null);
});

test("prune drops setups whose assignment is no longer saved for that account", () => {
  const store = memoryStore();
  saveWorkspace(record(), store);
  saveWorkspace({ ...record(), resourceId: "gone" }, store);
  const snapshot = { sources: [{ id: "s1", accountScope: "uw" }], resources: [{ id: "a7", sourceId: "s1", kind: "assignment", deleted: false }] } as unknown as Snapshot;
  assert.equal(pruneWorkspaces(snapshot, store), 1);
  assert.ok(readWorkspace("uw", "a7", store));
  assert.equal(readWorkspace("uw", "gone", store), null);
});

test("a course GitLab link is only a suggestion; it opens only after the student confirms it for this task", () => {
  const links = [link("cs639/lab7")];
  assert.deepEqual(gitlabView({ state: "unset" }, links), { kind: "suggested", links: ["cs639/lab7"] });
  assert.deepEqual(gitlabView({ state: "unset" }, []), { kind: "missing" });
  assert.deepEqual(gitlabView({ state: "none" }, links), { kind: "none" });
  assert.deepEqual(gitlabView({ state: "project", projectPath: "cs639/lab7" }, links), { kind: "confirmed", projectPath: "cs639/lab7" });
  assert.deepEqual(gitlabView({ state: "project", projectPath: "cs639/lab7" }, []), { kind: "removed", projectPath: "cs639/lab7" });
  const suggested = availableTargets({ set, gitlab: gitlabView({ state: "unset" }, links), tools: [] });
  assert.deepEqual(suggested, [], "a suggestion is not a page to open");
  const confirmed = availableTargets({ set, gitlab: gitlabView({ state: "project", projectPath: "cs639/lab7" }, links), tools: [] });
  assert.equal(confirmed[0]!.url, "https://git.doit.wisc.edu/cs639/lab7");
  assert.deepEqual(availableTargets({ set, gitlab: gitlabView({ state: "project", projectPath: "cs639/lab7" }, []), tools: [] }), []);
});

test("course links are scoped to the exact account and course", () => {
  const snapshot = { gitlabLinks: [link("a/b"), link("c/d", "other"), link("e/f", "uw", "c2")] } as Snapshot;
  assert.deepEqual(courseGitlabLinks(snapshot, "uw", "c1").map(l => l.projectPath), ["a/b"]);
  assert.equal(gitlabPathFromUrl("https://git.doit.wisc.edu/group/project/-/tree/main"), "group/project");
  assert.equal(gitlabPathFromUrl("https://git.doit.wisc.edu/group/project.git"), "group/project");
  assert.equal(gitlabPathFromUrl("https://gitlab.com/group/project"), null);
  assert.equal(gitlabPathFromUrl("https://git.doit.wisc.edu/users/someone"), null);
});

test("first open: the right window is the assignment's own outside link, else a confirmed GitLab project; nothing else is chosen", () => {
  assert.deepEqual(initialDraft(null, []), { work: null, support: [], pages: [] });
  assert.equal(stageOf(null), "first_open");
  assert.equal(stageOf(record()), "continue");
  const tool = { name: "Piazza", host: "piazza.com", url: "https://piazza.com/class/x", reason: "Linked in the syllabus.", evidence: null };
  const gitlabOnly = availableTargets({ set, gitlab: { kind: "confirmed", projectPath: "a/b" }, tools: [tool] });
  assert.equal(initialDraft(null, gitlabOnly).work, "gitlab:a/b");
  const withLink = availableTargets({ set: mhrSet, gitlab: { kind: "confirmed", projectPath: "a/b" }, tools: [tool] });
  assert.equal(initialDraft(null, withLink).work, `item:${MHR_ID}:link:x`, "GitLab is not assumed over the assignment's own link");
  let draft = initialDraft(null, withLink);
  draft = place(draft, "tool:https://piazza.com/class/x", "own");
  assert.equal(placementOf(draft, "tool:https://piazza.com/class/x"), "own");
  draft = place(draft, "gitlab:a/b", "right");
  assert.deepEqual([draft.work, draft.support], ["gitlab:a/b", ["tool:https://piazza.com/class/x"]], "one right window; the page it replaces isn't opened");
  assert.deepEqual(missingChoices({ work: "tool:https://old.example/", support: [], pages: [] }, withLink, true), ["tool:https://old.example/"]);
  assert.deepEqual(missingChoices({ work: "tool:https://old.example/", support: [], pages: [] }, withLink, false), [], "unknown pages are not declared missing");
});

test("changed instructions are noticed against the saved version", () => {
  assert.equal(instructionsChanged(record(), { contentHash: "h1" }), false);
  assert.equal(instructionsChanged(record(), { contentHash: "h2" }), true);
  assert.equal(instructionsChanged(null, { contentHash: "h2" }), false);
});

test("receipts: a fallback link is only a handoff; window states never claim a page loaded", () => {
  const page = { key: "gitlab:a/b", title: "GitLab · a/b" };
  assert.equal(linkReceipt(page).state, "handed_off");
  assert.match(linkReceipt(page).detail!, /browser chose where/);
  assert.equal(linkReceipt(page, new Error("External windows are disabled in headless mode.")).state, "test_only");
  assert.equal(linkReceipt(page, new Error("Only https links open from a link card.")).state, "not_sent");
  assert.equal(linkReceipt(page, new Error("boom")).state, "unconfirmed");
  const line = lastOpenLine({ at: "2026-09-27T10:00:00Z", targets: [{ key: page.key, label: page.title, state: "new_window" }, { key: "x", label: page.title, state: "not_observed" }] }, new Date("2026-09-27T12:00:00Z"));
  assert.match(line, /^Last opened today at .+: 1 opened, 1 needs a look\.$/);
  assert.doesNotMatch(line, /loaded|restored|submitted/i);
  assert.equal(lastOpenLine(null), "Saved. Nothing has been opened from this setup yet.");
  const w = (key: string, windowNumber: number) => ({ key, role: "support" as const, url: "https://a.example", bundleId: "b", pid: 1, windowNumber, placed: false, openedAt: "t" });
  assert.deepEqual(mergeWindows([w("a", 1), w("b", 2)], [w("b", 3)], false).map(x => x.windowNumber), [1, 3]);
  assert.deepEqual(mergeWindows([w("a", 1), w("b", 2)], [w("b", 3)], true).map(x => x.windowNumber), [3]);
});

test("page-view adapter keeps only browser-openable https tools and never launches Canvas tools", () => {
  const result = toolsFromPageView({ view: "assignment.workspace", tools: [
    { name: "Piazza", host: "piazza.com", url: "https://piazza.com/class/x", reason: "Named in the syllabus.", action: { kind: "open_in_browser", url: "https://piazza.com/class/x" }, evidence: [{ quote: "Use Piazza", source: "Syllabus" }] },
    { name: "Insecure", host: "x", url: "http://x.example", reason: "", action: { kind: "open_in_browser", url: "http://x.example" }, evidence: [] },
    { name: "Gradescope (LTI)", host: "gradescope.com", url: "https://canvas.wisc.edu/courses/1/external_tools/9", reason: "", action: { kind: "open_from_canvas", url: "https://canvas.wisc.edu/courses/1/modules", note: "Open it from Canvas." }, evidence: [] },
    { name: "Duplicate", host: "piazza.com", url: "https://piazza.com/class/x", reason: "", action: { kind: "open_in_browser", url: "https://piazza.com/class/x" }, evidence: [] },
  ] })!;
  assert.deepEqual(result.tools.map(t => t.name), ["Piazza"]);
  assert.deepEqual(result.tools[0]!.evidence, { quote: "Use Piazza", source: "Syllabus" });
  assert.deepEqual(result.canvasOnly.map(t => t.name), ["Gradescope (LTI)"]);
  assert.equal(toolsFromPageView({ view: "lecture.session" }), null);
});

test("an app without the page view reports unsupported once; a real failure is retried later", async () => {
  resetCourseToolsCache();
  let calls = 0;
  const unsupported = { query: async () => { calls++; throw new Error("Error invoking remote method 'magic:query': ZodError: invalid_union No matching discriminator"); } };
  assert.equal((await readCourseTools("a7", "h1", unsupported)).kind, "unsupported");
  assert.equal((await readCourseTools("a8", "h1", unsupported)).kind, "unsupported");
  assert.equal(calls, 1);
  resetCourseToolsCache();
  const flaky = { query: async () => { calls++; throw new Error("Local workspace request timed out."); } };
  assert.equal((await readCourseTools("a7", "h1", flaky)).kind, "error");
  assert.equal((await readCourseTools("a7", "h1", flaky)).kind, "error");
  assert.equal(calls, 3);
  assert.equal(isUnsupported(new Error("Local workspace request timed out.")), false);
  assert.equal((await readCourseTools("a7", "h1", undefined)).kind, "unsupported");
  resetCourseToolsCache();
});

// Rendered states. A synthetic record shaped like the saved Lecture 7 activity: empty instructions,
// no online submission, and no GitLab project saved for the course. No private data.
const store = memoryStore();
Object.assign(globalThis, {
  localStorage: store,
  window: { magic: { execute: async () => { throw new Error("not used"); }, startWork: async () => { throw new Error("not used"); }, openLink: async () => {} }, addEventListener() {}, removeEventListener() {} },
  document: { addEventListener() {}, removeEventListener() {}, visibilityState: "visible", hasFocus: () => true },
});
const { TaskWorkspace, openTaskPages } = await import("../apps/desktop/src/renderer/task-workspace/TaskWorkspace");
const lecture7 = {
  id: "a7", kind: "assignment", title: "lecture 7 activity", courseId: "c1", sourceId: "s1", contentHash: "h1", text: "", submissionTypes: ["none"],
  url: "https://canvas.wisc.edu/courses/1/assignments/7", observedAt: "2026-09-27T09:00:00Z",
} as unknown as ResourceView;
const snapshot = { sources: [{ id: "s1", accountScope: "uw" }], resources: [lecture7], gitlabLinks: [] } as unknown as Snapshot;
const render = (snap = snapshot, res = lecture7) => renderToStaticMarkup(createElement(TaskWorkspace, { resource: res, snapshot: snap, refreshKey: "r" }));

test("first open: honest instructions state, instructions fixed on the left, GitLab not assumed", () => {
  store.data.clear();
  const html = render();
  assert.match(html, /Set up this task/);
  assert.match(html, /The saved capture has no instructions for this assignment/);
  assert.match(html, /No GitLab project is saved for this course/);
  assert.match(html, /Link a project/);
  assert.match(html, /This task doesn(’|'|&#x27;)t use GitLab/);
  assert.doesNotMatch(html, /git\.doit\.wisc\.edu\/[a-z]/, "no project URL is invented");
  assert.doesNotMatch(html, /Submission|submit (it|in|through|on)/i, "no submission destination is suggested");
  assert.match(html, /It can(’|'|&#x27;)t see your tabs/);
  assert.match(html, /Canvas assignment instructions<\/small><\/span><span class="task-workspace__state">Left window/);
  assert.match(html, /Add a page/);
});

test("a course link is offered as a question, not preselected", () => {
  store.data.clear();
  const html = render({ ...snapshot, gitlabLinks: [link("cs639/course-repo")] } as Snapshot);
  assert.match(html, /This course has a linked project, cs639\/course-repo\. A course link doesn(’|'|&#x27;)t say which project this task uses\./);
  assert.match(html, /Use it for this task/);
});

test("Continue: saved pages, last receipt, remembered windows, changed instructions and a removed project are all visible", () => {
  store.data.clear();
  saveWorkspace({
    ...record({ instructionsHash: "old" }),
    choices: { gitlab: { state: "project", projectPath: "cs639/lab7" }, work: "gitlab:cs639/lab7", support: [], pages: [] },
    windows: [{ key: "instructions", role: "instructions", url: lecture7.url, bundleId: "org.mozilla.firefox", pid: 42, windowNumber: 7, placed: true, openedAt: "2026-09-26T15:00:00Z" }],
    last: { at: "2026-09-26T15:00:00Z", targets: [{ key: "instructions", label: "lecture 7 activity", state: "new_window" }, { key: "gitlab:cs639/lab7", label: "GitLab · cs639/lab7", state: "not_observed" }] },
  }, store);
  const html = render();
  assert.match(html, /Continue this task/);
  assert.match(html, /Last opened .+: 1 opened, 1 needs a look\./);
  assert.match(html, /The instructions changed since you saved this setup/);
  assert.match(html, /cs639\/lab7 is no longer linked to this course, so it won(’|'|&#x27;)t open/);
  assert.match(html, /window remembered/);
  assert.match(html, /In its own window/);
  assert.match(html, /Change pages/);
  assert.match(html, /Forget this setup/);
  assert.match(html, /existing windows stay untouched/);
  assert.match(html, /After restarting Magic, choose Open fresh windows/);
});

test("the one-click Upcoming → assignment path carries the MHR 322 project link to the right window", async () => {
  // The same producer the detail and Home use: core's work-set command on a saved capture of that shape.
  const s = createStore(":memory:");
  const core = createCore(s, { fixture: captureBatchSchema.parse({ source: { id: "x", label: "x", kind: "canvas", accountScope: "a", courseId: "x", scope: "assignments" }, observedAt: "2026-09-26T18:00:00Z", complete: true, status: "ok", resources: [] }) });
  s.ingest(captureBatchSchema.parse({
    source: { id: "canvas-322", label: "Synthetic Canvas", kind: "canvas", accountScope: "uw", courseId: "322", scope: "assignments" },
    observedAt: "2026-09-26T18:00:00Z", complete: true, status: "ok",
    resources: [{ externalId: "ugp", kind: "assignment", courseId: "322", courseName: "MHR 322", title: "UGP T-shirt project", url: "https://canvas.wisc.edu/courses/322/assignments/9", text: "Synthetic.", links: [{ url: PROJECT }], deadlines: [], points: 20, submitted: false }],
  }));
  linkExactEvidence(s);
  const id = s.resources()[0]!.id;
  const produced = (await core.execute({ type: "work-set", id })).workSet!;
  const targets = availableTargets({ set: produced, gitlab: { kind: "missing" }, tools: [] });
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.url, PROJECT);
  assert.equal(targets[0]!.external, true);
  assert.match(targets[0]!.detail, /Linked in the assignment · sites\.google\.com/);
  const draft = initialDraft(null, targets);
  const pages = windowPages({ url: "https://canvas.wisc.edu/courses/322/assignments/9", title: "UGP T-shirt project" }, produced, targets, draft);
  assert.deepEqual(pages.map(p => [p.role, p.url, p.origin]), [
    ["instructions", "https://canvas.wisc.edu/courses/322/assignments/9", "work_set"],
    ["work", PROJECT, "work_set"],
  ]);
});

test("open: task windows go through the app's window bridge; without it pages are ordinary links, labeled so", async () => {
  const pages = windowPages({ url: mhrSet.items[1]!.target.kind === "web" ? mhrSet.items[1]!.target.url : "", title: "UGP" }, mhrSet, availableTargets({ set: mhrSet, gitlab: { kind: "missing" }, tools: [] }), { work: `item:${MHR_ID}:link:x`, support: [], pages: [] });
  const requests: TaskWindowRequest[] = [];
  const bridge = async (request: TaskWindowRequest): Promise<TaskWindowResult> => {
    requests.push(request);
    return { mode: "live", capability: { browser: "Firefox", bundleId: "org.mozilla.firefox", family: "firefox", newWindow: true, accessibility: true },
      windows: [{ key: "instructions", role: "instructions", url: pages[0]!.url, bundleId: "org.mozilla.firefox", pid: 9, windowNumber: 101, placed: true, openedAt: "t" }],
      outcomes: [{ key: "instructions", state: "new_window" }, { key: pages[1]!.key, state: "new_window_unplaced", detail: "Allow window arrangement." }] };
  };
  const opened = await openTaskPages({ bridge, accountScope: "uw", resourceId: MHR_ID, pages });
  assert.equal(requests[0]!.action, "open");
  assert.deepEqual(opened.receipts.map(r => r.state), ["new_window", "new_window_unplaced"]);
  assert.equal(opened.windows![0]!.windowNumber, 101);
  await openTaskPages({ bridge, accountScope: "uw", resourceId: MHR_ID, pages, windows: opened.windows! });
  assert.equal(requests[1]!.action, "continue", "Continue sends the remembered windows so nothing is duplicated");

  const links: string[] = [];
  const w = (globalThis as unknown as { window: { magic: { openLink?: (url: string) => Promise<void> } } }).window;
  w.magic.openLink = async url => { links.push(url); };
  const fallback = await openTaskPages({ bridge: undefined, accountScope: "uw", resourceId: MHR_ID, pages });
  assert.deepEqual(links, [pages[0]!.url, PROJECT]);
  assert.deepEqual(fallback.receipts.map(r => r.state), ["handed_off", "handed_off"]);
  assert.equal(fallback.windows, null, "an ordinary link never becomes a remembered window");
  w.magic.openLink = undefined;
  assert.equal((await openTaskPages({ bridge: undefined, accountScope: "uw", resourceId: MHR_ID, pages })).receipts[0]!.state, "not_sent");
});
