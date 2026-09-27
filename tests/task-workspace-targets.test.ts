import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema, type GitlabLink, type SourceInvestigationResult, type Store, type WorkSet } from "@magic/contracts";
import { linkExactEvidence } from "../packages/core/src/evidence";
import {
  availableTargets, choose, gitlabView, initialDraft, missingChoices, readWorkspace, recordFrom, saveWorkspace, windowPages, type KeyValueStore,
} from "../apps/desktop/src/renderer/task-workspace/model";
import { targetWhy, withInvestigation } from "../apps/desktop/src/renderer/task-workspace/investigation-targets";
import { createTaskWindows, taskContextFrom, type TaskWindowHost } from "../apps/desktop/src/task-windows/controller";

// Synthetic shapes of the traced cases; no private text. The adapter is exercised on the real
// producer (core's work-set command) and the real window controller with a fake native helper.
const ACCOUNT = "uw";
const PROJECT = "https://sites.google.com/undergroundshirts.com/mhr-322-ugp-t-shirt-project/home";
const SITE = "https://course.example.edu/";
const SCHEDULE = ["Sep 23", "Lecture 7: Frontend with React and TypeScript.", "Activity: Book Review Arc (4/6). Readings: React Quick Start.", "Sep 30", "Lecture 8: Testing."].join("\n");

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); } };
}
function newCore() {
  const store = createStore(":memory:");
  const core = createCore(store, { fixture: captureBatchSchema.parse({ source: { id: "x", label: "x", kind: "canvas", accountScope: "a", courseId: "x", scope: "assignments" }, observedAt: "2026-09-26T18:00:00Z", complete: true, status: "ok", resources: [] }) });
  return { store, core };
}
function ingest(store: Store, id: string, kind: "canvas" | "web", account: string, course: string, resources: unknown[], status: "ok" | "partial" = "ok") {
  store.ingest(captureBatchSchema.parse({
    source: { id, label: kind === "web" ? "Course website" : "Synthetic Canvas", kind, accountScope: account, courseId: course, scope: kind === "web" ? "site" : "assignments" },
    observedAt: "2026-09-26T18:00:00Z", complete: status === "ok", status, resources,
  }));
}
const material = (externalId: string, course: string, title: string, url: string, text: string, links: unknown[] = []) =>
  ({ externalId, kind: "material", courseId: course, courseName: "Course", title, url, text, links, deadlines: [], points: null, submitted: null });

/** CS639 Lecture 7 shape: empty Canvas assignment, same-course website with a schedule and a home page. */
async function lecture7() {
  const { store, core } = newCore();
  ingest(store, "canvas-639", "canvas", ACCOUNT, "639", [{ externalId: "lec7", kind: "assignment", courseId: "639", courseName: "CS 639", title: "lecture 7 activity", url: "https://canvas.wisc.edu/courses/639/assignments/7", text: "", submissionTypes: ["none"], deadlines: [], points: 1, submitted: false }]);
  ingest(store, "web-639", "web", ACCOUNT, "639", [
    material("schedule", "639", "Schedule", `${SITE}schedule/`, SCHEDULE, [{ url: "https://react.dev/learn", text: "React Quick Start" }]),
    material("home", "639", "Course website", SITE, "Welcome. Activities are submitted as the schedule says."),
  ], "partial");
  // Same course ID under another account, with the same page.
  ingest(store, "web-other", "web", "other", "639", [material("home", "639", "Course website", SITE, "Other account copy.")]);
  const byExternal = (e: string, source: string) => store.resources().find(r => r.externalId === e && r.sourceId === source)!;
  const assignment = byExternal("lec7", "canvas-639");
  const set = (await core.execute({ type: "work-set", id: assignment.id })).workSet!;
  return { store, core, assignment, set, schedule: byExternal("schedule", "web-639"), home: byExternal("home", "web-639"), otherHome: byExternal("home", "web-other") };
}
type Cited = { id: string; contentHash: string; version: number; url: string; text: string };
const cite = (r: Cited, provisional = true) => ({ resourceId: r.id, contentHash: r.contentHash, version: r.version, start: 0, end: Math.min(60, r.text.length), excerpt: r.text.slice(0, 60), provisional, sourceUrl: r.url });
function result(assignmentId: string, set: WorkSet, findings: SourceInvestigationResult["findings"]): SourceInvestigationResult {
  return { status: "partial", summary: "Synthetic.", assignmentId, workSet: { assignmentId: set.assignmentId, items: set.items, held: set.held }, findings, unknowns: [], model: "test", client: "claude" };
}
const links = (path: string): GitlabLink => ({ accountScope: ACCOUNT, courseId: "639", projectPath: path } as GitlabLink);

test("TSP direct target: Canvas instructions left, the assignment-linked project page right; a source check changes nothing", async () => {
  const { store, core } = newCore();
  ingest(store, "canvas-322", "canvas", ACCOUNT, "322", [
    { externalId: "tsp", kind: "assignment", courseId: "322", courseName: "MHR 322", title: "TSP: Submit T-shirt cart request", url: "https://canvas.wisc.edu/courses/322/assignments/9", text: "Use the project site to build your cart.", links: [{ url: PROJECT, text: "Project site" }], submissionTypes: ["online_upload"], deadlines: [], points: 20, submitted: false },
    material("portal", "322", "MHR 322 Project Portal", "https://canvas.wisc.edu/courses/322/pages/portal", "Portal text for the project."),
  ]);
  linkExactEvidence(store);
  const assignment = store.resources().find(r => r.externalId === "tsp")!;
  const portal = store.resources().find(r => r.externalId === "portal")!;
  const set = (await core.execute({ type: "work-set", id: assignment.id })).workSet!;
  const offered = withInvestigation(availableTargets({ set, gitlab: { kind: "missing" }, tools: [] }), {
    result: result(assignment.id, set, [{ kind: "work_target", text: "The portal describes the cart.", citations: [cite(portal)] }]),
    forHash: assignment.contentHash, assignment, accountScope: ACCOUNT, saved: { resources: store.resources(), sources: store.sources() },
  });
  const draft = initialDraft(null, offered.targets);
  const pages = windowPages({ url: assignment.url, title: assignment.title }, set, offered.targets, draft);
  assert.deepEqual(pages.map(p => [p.role, p.url]), [["instructions", assignment.url], ["work", PROJECT]]);
  const project = offered.targets.find(t => t.url === PROJECT)!;
  assert.deepEqual([project.evidence.source, project.evidence.confirmed, project.external], ["assignment_link", true, true]);
  const suggested = offered.targets.find(t => t.url === portal.url)!;
  assert.deepEqual([suggested.evidence.source, suggested.evidence.confirmed, suggested.external ?? false], ["source_check", false, false]);
});

test("a saved off-site direct link is still the right window; a saved Canvas page it links is not", async () => {
  const { store, core } = newCore();
  ingest(store, "canvas-322", "canvas", ACCOUNT, "322", [
    { externalId: "tsp", kind: "assignment", courseId: "322", courseName: "MHR 322", title: "TSP", url: "https://canvas.wisc.edu/courses/322/assignments/9", text: "Synthetic.", links: [{ url: "https://canvas.wisc.edu/courses/322/pages/brief" }, { url: PROJECT }], deadlines: [], points: 1, submitted: false },
    material("brief", "322", "Brief", "https://canvas.wisc.edu/courses/322/pages/brief", "Brief."),
  ]);
  ingest(store, "web-322", "web", ACCOUNT, "322", [material("project", "322", "Project site", PROJECT, "Saved project site.")]);
  linkExactEvidence(store);
  const id = store.resources().find(r => r.externalId === "tsp")!.id;
  const set = (await core.execute({ type: "work-set", id })).workSet!;
  const targets = availableTargets({ set, gitlab: { kind: "missing" }, tools: [] });
  assert.deepEqual(targets.map(t => [t.label, t.evidence.source, !!t.external]), [["Brief", "assignment_link", false], ["Project site", "assignment_link", true]]);
  assert.equal(targets.find(t => t.key === initialDraft(null, targets).work)!.url, PROJECT);
});

test("CS639 Lecture 7: schedule and source-check pages are cited, optional and never pre-selected; GitLab isn't assumed", async () => {
  const { store, assignment, set, schedule, home } = await lecture7();
  const gitlab = gitlabView({ state: "unset" }, [links("cs639/course-repo")]);
  assert.equal(gitlab.kind, "suggested");
  const check = result(assignment.id, set, [
    { kind: "work_target", text: "The course site says activities are submitted as the schedule says.", citations: [cite(home)] },
    { kind: "reading", text: "Lecture 7 lists the React Quick Start reading.", citations: [cite(schedule)] },
  ]);
  const offered = withInvestigation(availableTargets({ set, gitlab, tools: [] }), {
    result: check, forHash: assignment.contentHash, assignment, accountScope: ACCOUNT, saved: { resources: store.resources(), sources: store.sources() },
  });
  assert.deepEqual(offered.notes, []);
  assert.ok(!offered.targets.some(t => t.origin === "gitlab" || /git\.doit/.test(t.url)));
  assert.deepEqual(initialDraft(null, offered.targets), { work: null, support: [], pages: [] });
  assert.ok(offered.targets.every(t => !t.evidence.confirmed && !t.external));

  const scheduleTarget = offered.targets.find(t => t.url === schedule.url)!;
  assert.equal(scheduleTarget.evidence.source, "course_section"); // its own provenance is kept
  assert.equal(scheduleTarget.evidence.finding?.kind, "reading");
  assert.match(targetWhy(scheduleTarget)!, /^Possibly related, not confirmed as this assignment's work or submission page\. Source check: Lecture 7 lists/);
  const homeTarget = offered.targets.find(t => t.url === SITE)!;
  assert.deepEqual([homeTarget.key, homeTarget.origin, homeTarget.evidence.source, homeTarget.evidence.finding?.kind], [`page:${SITE}`, "student", "source_check", "work_target"]);
  assert.match(homeTarget.detail, /^Possibly related · cited by the source check, not linked to this assignment/);
  assert.doesNotMatch(homeTarget.detail + targetWhy(homeTarget), /Work target|Submit (it )?(here|on)/);
  assert.match(targetWhy(homeTarget)!, /^Possibly related, not confirmed as this assignment's work or submission page\./);
  assert.match(targetWhy(homeTarget)!, /“Welcome\. Activities are submitted/);
  // With nothing chosen only the instructions open.
  assert.deepEqual(windowPages({ url: assignment.url, title: assignment.title }, set, offered.targets, initialDraft(null, offered.targets)).map(p => p.role), ["instructions"]);
});

test("stale, revoked or cross-scope source checks offer nothing", async () => {
  const { store, assignment, set, home, otherHome } = await lecture7();
  const base = availableTargets({ set, gitlab: { kind: "missing" }, tools: [] });
  const saved = { resources: store.resources(), sources: store.sources() };
  const run = (check: SourceInvestigationResult, extra: Partial<Parameters<typeof withInvestigation>[1]> = {}) =>
    withInvestigation(base, { result: check, forHash: assignment.contentHash, assignment, accountScope: ACCOUNT, saved, ...extra });
  const good = (c = cite(home)) => result(assignment.id, set, [{ kind: "context", text: "Course site.", citations: [c] }]);
  assert.equal(run(good()).targets.length, base.length + 1);

  const other = run(result("another-assignment", set, good().findings));
  assert.equal(other.targets.length, base.length);
  assert.match(other.notes[0]!, /different assignment/);
  const changed = run(good(), { forHash: "older-version" });
  assert.equal(changed.targets.length, base.length);
  assert.match(changed.notes[0]!, /assignment changed since the source check/);
  // Without a caller-supplied version, a citation of an older assignment version still marks it stale.
  const olderSelf = run(result(assignment.id, set, [{ kind: "context", text: "Course site.", citations: [cite(home), { ...cite({ ...assignment, text: "x" }), contentHash: "old" }] }]), { forHash: undefined });
  assert.equal(olderSelf.targets.length, base.length);
  assert.match(olderSelf.notes[0]!, /assignment changed/);
  assert.equal(run(good(), { forHash: undefined }).targets.length, base.length + 1);
  for (const bad of [
    { ...cite(home), contentHash: "0".repeat(64) },           // page changed since the check
    { ...cite(home), version: home.version + 1 },
    { ...cite(home), sourceUrl: "https://evil.example/" },     // address doesn't match the saved page
    cite(otherHome),                                          // same course ID, other account
    { ...cite(home), resourceId: "not-saved" },
  ]) {
    const out = run(good(bad));
    assert.equal(out.targets.length, base.length, JSON.stringify(bad).slice(0, 80));
    assert.match(out.notes[0]!, /One cited page changed or isn't available/);
  }
  // Removed (revoked or deleted) from what the app still shows.
  const removed = run(good(), { saved: { resources: saved.resources.filter(r => r.id !== home.id), sources: saved.sources } });
  assert.equal(removed.targets.length, base.length);
  // A source that now needs sign-in isn't offered either.
  const signedOut = run(good(), { saved: { resources: saved.resources, sources: saved.sources.map(s => s.id === home.sourceId ? { ...s, status: "needs_sign_in" as const } : s) } });
  assert.equal(signedOut.targets.length, base.length);
  assert.equal(run({ ...good(), findings: [] }).targets.length, base.length);
  assert.equal(withInvestigation(base, { result: null, forHash: undefined, assignment, accountScope: ACCOUNT, saved }).targets.length, base.length);
});

test("no evidence: an empty assignment with nothing saved opens only its instructions", async () => {
  const { store, core } = newCore();
  ingest(store, "canvas-1", "canvas", ACCOUNT, "1", [{ externalId: "a", kind: "assignment", courseId: "1", courseName: "C", title: "Reflection", url: "https://canvas.wisc.edu/courses/1/assignments/1", text: "", submissionTypes: ["none"], deadlines: [], points: 1, submitted: false }]);
  const assignment = store.resources()[0]!;
  const set = (await core.execute({ type: "work-set", id: assignment.id })).workSet!;
  const offered = withInvestigation(availableTargets({ set, gitlab: { kind: "missing" }, tools: [] }), {
    result: result(assignment.id, set, []), forHash: assignment.contentHash, assignment, accountScope: ACCOUNT, saved: { resources: store.resources(), sources: store.sources() },
  });
  assert.deepEqual(offered.targets, []);
  assert.deepEqual(windowPages({ url: assignment.url, title: assignment.title }, set, offered.targets, initialDraft(null, offered.targets)).map(p => [p.role, p.url]), [["instructions", assignment.url]]);
});

test("task setup and saved role: a chosen source-check page is the student's own and reopens on Continue without a new check", async () => {
  const { store, assignment, set, schedule, home } = await lecture7();
  const saved = { resources: store.resources(), sources: store.sources() };
  const offered = withInvestigation(availableTargets({ set, gitlab: { kind: "missing" }, tools: [] }), {
    result: result(assignment.id, set, [{ kind: "context", text: "Course site.", citations: [cite(home)] }]), forHash: assignment.contentHash, assignment, accountScope: ACCOUNT, saved,
  });
  const homeTarget = offered.targets.find(t => t.url === SITE)!;
  const scheduleTarget = offered.targets.find(t => t.url === schedule.url)!;
  let draft = initialDraft(null, offered.targets);
  draft = choose(draft, scheduleTarget, "right");       // the student chooses the schedule for the right window
  draft = choose(draft, homeTarget, "own");
  assert.deepEqual(draft.pages, [{ url: SITE, title: "Course website", via: "source_check" }]);
  const kv = memoryStore();
  saveWorkspace(recordFrom({ previous: null, accountScope: ACCOUNT, resource: assignment, draft, gitlab: { state: "unset" }, now: new Date("2026-09-27T10:00:00Z") }), kv);
  assert.equal(readWorkspace("other", assignment.id, kv), null); // exact account identity
  const record = readWorkspace(ACCOUNT, assignment.id, kv)!;
  assert.deepEqual(record.choices.pages, [{ url: SITE, title: "Course website", via: "source_check" }]);

  // Continue: the check hasn't run again (or no client is connected).
  const again = initialDraft(record, []);
  const targets = availableTargets({ set, gitlab: { kind: "missing" }, tools: [], pages: again.pages });
  assert.deepEqual(missingChoices(again, targets, true), []);
  const pages = windowPages({ url: assignment.url, title: assignment.title }, set, targets, again);
  assert.deepEqual(pages.map(p => [p.role, p.url, p.origin]), [["instructions", assignment.url, "work_set"], ["work", schedule.url, "work_set"], ["support", SITE, "student"]]);
  assert.match(targets.find(t => t.url === SITE)!.detail, /You chose this from the source check/);
  // Setting it back to Don't open drops it, unlike a page the student typed in.
  const off = choose(again, targets.find(t => t.url === SITE)!, "off");
  assert.deepEqual([off.pages, off.support], [[], []]);
  const typed = { ...again, pages: [{ url: "https://example.org/", title: "Mine" }] };
  assert.equal(choose(typed, { key: "page:https://example.org/", url: "https://example.org/", label: "Mine", evidence: { source: "student_page", confirmed: true } }, "off").pages.length, 1);
});

test("the window controller re-derives every page from the saved task: a source-check page opens only as the student's choice", async () => {
  const { store, core, assignment, set, schedule } = await lecture7();
  const opened: string[] = [];
  let n = 100;
  const host: TaskWindowHost = {
    headless: false, beforeOpen: async () => {}, now: () => new Date("2026-09-27T10:00:00Z"),
    run: async (request: Record<string, unknown>) => {
      if (request.action === "status") return { event: "status", name: "Firefox.app", bundleId: "org.mozilla.firefox", family: "firefox", newWindow: true, accessibility: true };
      if (request.action === "open") { opened.push(`${request.side}:${request.url}`); return { event: "opened", pid: 42, windowNumber: n++, bundleId: "org.mozilla.firefox", placed: request.side !== "none", area: { x: 0, y: 25, w: 1440, h: 875 } }; }
      return { event: "error", code: "unsupported_action" };
    },
    context: async (accountScope, resourceId) => taskContextFrom(await core.execute({ type: "work-set", id: resourceId }), accountScope, resourceId, "https://git.doit.wisc.edu"),
  };
  const tw = createTaskWindows(host);
  const result = await tw.handle({ action: "open", accountScope: ACCOUNT, resourceId: assignment.id, pages: [
    { key: "instructions", role: "instructions", url: assignment.url, title: assignment.title, origin: "work_set" },
    { key: `context:${schedule.url}`, role: "work", url: schedule.url, title: "Schedule", origin: "work_set" },
    { key: `page:${SITE}`, role: "support", url: SITE, title: "Course website", origin: "student" },
    { key: "forged", role: "support", url: "https://course.example.edu/admin", title: "Forged", origin: "work_set" },
  ] });
  assert.deepEqual(opened, [`left:${assignment.url}`, `right:${schedule.url}`, `none:${SITE}`]);
  assert.deepEqual(Object.fromEntries(result.outcomes.map(o => [o.key, o.state])), { instructions: "new_window", [`context:${schedule.url}`]: "new_window", [`page:${SITE}`]: "new_window", forged: "not_sent" });
  assert.ok(set.context);
  // Revoked scope: once the course is excluded, nothing is sent, including the student's page.
  store.setCourseOverride({ accountScope: ACCOUNT, courseId: "639", included: false } as never);
  opened.length = 0;
  await assert.rejects(() => tw.handle({ action: "open", accountScope: ACCOUNT, resourceId: assignment.id, pages: [
    { key: "instructions", role: "instructions", url: assignment.url, title: assignment.title, origin: "work_set" },
    { key: `page:${SITE}`, role: "support", url: SITE, title: "Course website", origin: "student" },
  ] }), /not currently available/);
  assert.deepEqual(opened, []);
});
