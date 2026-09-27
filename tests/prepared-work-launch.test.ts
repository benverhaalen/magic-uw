import test from "node:test";
import assert from "node:assert/strict";
import type { WorkLaunchReceipt, WorkSet } from "@magic/contracts";
import {
  classifyLaunchError, counts, outcomeFromError, outcomeFromReceipt, retryableIds, sendingOutcome, stateLabel, summaryLine,
} from "../apps/desktop/src/renderer/prepared-work/launch-model";
import { clearEntry, getEntry, noteLeave, noteReturn, putOutcome, resetStore, subscribe } from "../apps/desktop/src/renderer/prepared-work/session-store";
import { CANVAS_ORIGIN, GITLAB_ORIGIN, destinationGroups, destinationOf, destinationPhrase, destinationSummary } from "../apps/desktop/src/renderer/prepared-work/destination";
import { createStore } from "@magic/storage";
import { createCore, launchWorkSet, selectWorkRetry, type WorkLaunchHost } from "@magic/core";
import { captureBatchSchema } from "@magic/contracts";
import { linkExactEvidence } from "../packages/core/src/evidence";
import { DEFAULT_CANVAS_ORIGIN } from "../packages/connectors/src/network";
import { UW_GITLAB_ORIGIN } from "../packages/connectors/src/gitlab";

const set: WorkSet = {
  previewHash: "a".repeat(64), assignmentId: "essay", assignmentTitle: "Essay 2", contentHash: "c",
  items: [
    { resourceId: "slides", title: "Week 3 slides", role: "material", reason: "Linked from the assignment.", target: { kind: "file", path: "/docs/x", extension: ".pdf", fallbackUrl: "https://canvas.example.edu/files/1" } },
    { resourceId: "reading", title: "Reading", role: "material", reason: "Accepted match.", target: { kind: "web", url: "https://canvas.example.edu/pages/r" } },
    { resourceId: "essay", title: "Essay 2", role: "instructions", reason: "Assignment instructions and submission page.", target: { kind: "web", url: "https://canvas.example.edu/assignments/1" } },
  ],
  held: [], notes: ["Canvas: last successful refresh 2026-09-26T21:10:00Z."],
};
const receipt = (patch: Partial<WorkLaunchReceipt>): WorkLaunchReceipt => ({
  assignmentId: "essay", assignmentTitle: "Essay 2", at: "2026-09-27T15:42:00Z", mode: "opened", opened: [], failed: [], held: [], notes: [...set.notes], ...patch,
});

test("handoff is reported per destination and never as loaded, done or complete", () => {
  const outcome = outcomeFromReceipt(set, receipt({
    opened: [{ resourceId: "slides", title: "Week 3 slides", via: "browser_fallback" }, { resourceId: "essay", title: "Essay 2", via: "browser" }],
    failed: [{ resourceId: "reading", title: "Reading", reason: "Only ordinary web links can be opened." }],
    notes: [...set.notes, "Week 3 slides: opened the original because the saved copy is no longer on this device."],
  }));
  assert.deepEqual(outcome.items.map(item => item.state.kind), ["fallback", "not_sent", "handed_off"]);
  assert.equal(stateLabel(outcome.items[0]!.state), "Sent the original to your browser");
  assert.deepEqual(outcome.items[0]!.state, { kind: "fallback", reason: "the saved copy is no longer on this device" });
  assert.equal(stateLabel(outcome.items[1]!.state), "Not sent: only ordinary web links can be opened");
  assert.equal(stateLabel(outcome.items[2]!.state), "Sent to your browser");
  // Core's fallback note is folded into the row; source freshness notes are not repeated.
  assert.deepEqual(outcome.notes, []);
  assert.deepEqual(retryableIds(outcome), ["reading"]);
  const line = summaryLine(outcome);
  assert.match(line, /^Sent 2 of 3 at .+ · 1 not sent\.$/);
  for (const item of outcome.items.filter(entry => entry.state.kind !== "not_sent")) assert.doesNotMatch(stateLabel(item.state), /opened|loaded|done|complete/i);
  assert.doesNotMatch(line, /opened|done|complete|—/i);
});

test("verification mode says nothing opened", () => {
  const outcome = outcomeFromReceipt(set, receipt({ mode: "dry_run", opened: set.items.map(item => ({ resourceId: item.resourceId, title: item.title, via: item.target.kind === "file" ? "file" as const : "browser" as const })) }));
  assert.equal(outcome.mode, "dry_run");
  assert.equal(summaryLine(outcome), "Verification mode: nothing opened. 3 of 3 would be sent.");
  assert.equal(stateLabel(outcome.items[0]!.state), "Would open the saved copy");
});

test("items missing from a receipt are unconfirmed, not sent", () => {
  const outcome = outcomeFromReceipt(set, receipt({ opened: [{ resourceId: "essay", title: "Essay 2", via: "browser" }] }));
  assert.deepEqual(counts(outcome), { sent: 1, failed: 0, unconfirmed: 2, pending: 0, total: 3 });
  assert.match(summaryLine(outcome), /2 not confirmed/);
});

test("retry of failed items keeps earlier successes and replaces only the retried rows", () => {
  const first = outcomeFromReceipt(set, receipt({
    opened: [{ resourceId: "slides", title: "Week 3 slides", via: "file" }, { resourceId: "essay", title: "Essay 2", via: "browser" }],
    failed: [{ resourceId: "reading", title: "Reading", reason: "Finish the setup step before My Magic UW connects to UW." }],
  }));
  assert.equal(stateLabel(first.items[1]!.state), "Not sent: UW connection setup is not finished");
  const sending = sendingOutcome(set, first, ["reading"]);
  assert.deepEqual(sending.items.map(item => item.state.kind), ["handed_off", "sending", "handed_off"]);
  assert.match(summaryLine(sending), /^Sending 1 item/);
  const second = outcomeFromReceipt(set, receipt({ opened: [{ resourceId: "reading", title: "Reading", via: "browser" }] }), first, ["reading"]);
  assert.deepEqual(second.items.map(item => item.state.kind), ["handed_off", "handed_off", "handed_off"]);
  assert.deepEqual(retryableIds(second), []);
});

test("launch errors map to distinct recoveries; unknown never claims nothing opened", () => {
  const wrap = (message: string) => new Error(`Error invoking remote method 'magic:start-work': Error: ${message}`);
  assert.equal(classifyLaunchError(wrap("Prepared work changed. Review the updated destinations before opening.")).kind, "changed");
  assert.equal(classifyLaunchError(wrap("Review the prepared destinations before opening.")).kind, "changed");
  assert.equal(classifyLaunchError(wrap("Prepared work is already opening.")).kind, "busy");
  assert.equal(classifyLaunchError(wrap("Finish the setup step before My Magic UW connects to UW.")).kind, "setup");
  assert.equal(classifyLaunchError(wrap("Retry only the failed items from the last launch.")).kind, "retry_expired");
  assert.equal(classifyLaunchError(wrap("This course is not currently available for prepared work.")).kind, "unavailable");
  assert.equal(classifyLaunchError(new Error("socket hang up")).kind, "unknown");

  const busy = outcomeFromError(set, wrap("Prepared work is already opening."), null);
  assert.ok(busy.items.every(item => item.state.kind === "ready"));
  assert.equal(summaryLine(busy), "Nothing was sent.");
  const unknown = outcomeFromError(set, new Error("renderer lost the reply"), null);
  assert.ok(unknown.items.every(item => item.state.kind === "unconfirmed"));
  assert.equal(summaryLine(unknown), "Magic could not confirm what opened.");
});

test("a failed retry before launch keeps the earlier per-destination outcome", () => {
  const first = outcomeFromReceipt(set, receipt({ opened: [{ resourceId: "essay", title: "Essay 2", via: "browser" }, { resourceId: "slides", title: "Week 3 slides", via: "file" }], failed: [{ resourceId: "reading", title: "Reading", reason: "Could not open this item." }] }));
  const expired = outcomeFromError(set, new Error("Retry only the failed items from the last launch."), first, ["reading"]);
  assert.equal(expired.problem?.kind, "retry_expired");
  assert.deepEqual(expired.items.map(item => item.state.kind), ["handed_off", "not_sent", "handed_off"]);
  assert.equal(expired.mode, "opened");
});

test("session store survives surface changes and records a return only after leaving", () => {
  resetStore();
  const outcome = outcomeFromReceipt(set, receipt({ opened: [{ resourceId: "essay", title: "Essay 2", via: "browser" }] }));
  putOutcome("essay", outcome, { anchor: "work-essay", awaitingReturn: true, left: false });
  assert.deepEqual(noteReturn(new Date("2026-09-27T15:50:00Z")), [], "focus without leaving is not a return");
  noteLeave();
  assert.deepEqual(noteReturn(new Date("2026-09-27T15:50:00Z")), ["work-essay"]);
  assert.equal(getEntry("essay")?.returnedAt, "2026-09-27T15:50:00.000Z");
  assert.deepEqual(noteReturn(), [], "a second focus is not another return");
  for (let index = 0; index < 25; index++) putOutcome(`other-${index}`, outcome);
  assert.equal(getEntry("essay"), null, "session record is bounded");
  clearEntry("other-24");
  assert.equal(getEntry("other-24"), null);
});

test("destination comes from the actual target: a Canvas-hosted PDF is a PDF, sites need exact origins", () => {
  assert.equal(CANVAS_ORIGIN, DEFAULT_CANVAS_ORIGIN, "renderer mapping tracks the connector's Canvas origin");
  assert.equal(GITLAB_ORIGIN, UW_GITLAB_ORIGIN, "renderer mapping tracks the connector's GitLab origin");
  const file = (extension: string) => ({ kind: "file" as const, path: "/docs/x", extension, fallbackUrl: "https://canvas.wisc.edu/courses/1/files/2" });
  assert.deepEqual([".pdf", ".PPTX", ".csv", ".docx", ".md"].map(ext => destinationOf(file(ext)).category), ["pdf", "slides", "spreadsheet", "document", "document"]);
  assert.notEqual(destinationOf(file(".pdf")).icon, destinationOf(file(".docx")).icon, "a PDF and a document never share one glyph");
  assert.equal(destinationOf(file(".pdf")).opensIn, "app");
  const web = (url: string) => destinationOf({ kind: "web", url });
  assert.equal(web("https://canvas.wisc.edu/courses/1/assignments/3").category, "canvas");
  assert.equal(web("https://git.doit.wisc.edu/cs400/project-3/-/blob/main/README.md").category, "gitlab");
  // Look-alike hosts and other schools' Canvas stay generic; the host is shown, never a borrowed name.
  for (const url of ["https://canvas.wisc.edu.evil.test/x", "http://canvas.wisc.edu/x", "https://canvas.example.edu/x", "https://gitlab.com/a/b"]) assert.equal(web(url).category, "web", url);
  assert.equal(web("https://www.example.org/a").name, "www.example.org");
  assert.equal(web("not a url").name, "Destination unavailable");
  assert.equal(destinationPhrase({ role: "material", target: file(".pdf") }), "Saved PDF in its usual app");
  assert.equal(destinationPhrase({ role: "instructions", target: { kind: "web", url: "https://canvas.wisc.edu/courses/1/assignments/3" } }), "Canvas page in your browser, opens in front");
  assert.equal(destinationPhrase({ role: "material", target: { kind: "web", url: "https://example.org/a" } }), "Page on example.org in your browser");
});

test("summary deduplicates by destination category and keeps every resource", () => {
  const groups = destinationGroups(set.items);
  // Fixture set: a saved PDF and two pages on a non-UW Canvas host.
  assert.deepEqual(groups.map(group => [group.category, group.count, group.resourceIds]), [["pdf", 1, ["slides"]], ["web", 2, ["reading", "essay"]]]);
  assert.equal(destinationSummary(groups), "1 PDF and 2 pages on canvas.example.edu");
  assert.equal(groups.reduce((sum, group) => sum + group.resourceIds.length, 0), set.items.length);
  assert.doesNotMatch(destinationSummary(groups), /open|all/i);
});

test("real core preview is bound to the source account and the reviewed hash; dry run is not a document open", async () => {
  const store = createStore(":memory:");
  const batch = (accountScope: string, resources: object[]) => captureBatchSchema.parse({
    source: { id: `canvas-${accountScope}`, label: "Synthetic Canvas", kind: "canvas", accountScope, courseId: "101", scope: "assignments" },
    observedAt: "2026-09-26T18:00:00Z", complete: true, status: "ok", resources,
  });
  const core = createCore(store, { fixture: batch("fixture", []) });
  const base = { courseId: "101", courseName: "Course 101", deadlines: [], points: null, submitted: null };
  const links = ["https://canvas.wisc.edu/courses/101/files/7", "https://git.doit.wisc.edu/cs101/project", "https://canvas.wisc.edu/courses/101/pages/other-account"];
  store.ingest(batch("student-a", [
    { ...base, externalId: "p3", kind: "assignment", title: "Project 3", url: "https://canvas.wisc.edu/courses/101/assignments/3", text: "See the handout and repo.", links, points: 40, submitted: false },
    { ...base, externalId: "handout", kind: "material", title: "Handout", url: links[0], text: "Handout.", contentType: "application/pdf", document: { localPath: "/data/documents/101/aa", extractionStatus: "ok", pages: [] } },
    { ...base, externalId: "repo", kind: "material", title: "Project repo", url: links[1], text: "Repo." },
  ]));
  // Same course ID and a directly linked URL, but captured under a different account.
  store.ingest(batch("student-b", [{ ...base, externalId: "other", kind: "material", title: "Other account page", url: links[2], text: "Other." }]));
  linkExactEvidence(store);
  const id = store.resources().find(resource => resource.externalId === "p3")!.id;
  const preview = (await core.execute({ type: "work-set", id })).workSet!;
  assert.deepEqual(preview.items.map(item => item.title), ["Handout", "Project repo", "Project 3"]);
  assert.ok(!JSON.stringify(preview).includes("Other account"), "another account's material never enters the preview");
  assert.deepEqual(preview.items.map(item => destinationOf(item.target).category), ["pdf", "gitlab", "canvas"]);

  // Launch is bound to the reviewed preview: a different hash is refused and maps to the "changed" recovery.
  assert.throws(() => selectWorkRetry(preview, "b".repeat(64)), (error: Error) => classifyLaunchError(error).kind === "changed");

  const calls: string[] = [];
  const host: WorkLaunchHost = {
    async openExternal(url) { calls.push(url); }, async openPath(path) { calls.push(path); return ""; },
    async materialize(path, extension) { return `${path}${extension}`; }, async realpath(path) { return path; },
    documentsRoot: "/data/documents", separator: "/", now: () => new Date("2026-09-27T15:00:00Z"),
  };
  const dry = outcomeFromReceipt(preview, await launchWorkSet(preview, { ...host, dryRun: true }));
  assert.deepEqual(calls, [], "verification mode hands nothing to the operating system");
  assert.equal(summaryLine(dry), "Verification mode: nothing opened. 3 of 3 would be sent.");
  const real = outcomeFromReceipt(preview, await launchWorkSet(preview, host));
  assert.equal(calls.length, 3);
  // A handoff is reported as sent to an app or browser, never as the document being open or read.
  assert.deepEqual(real.items.map(item => stateLabel(item.state)), ["Sent to its usual app", "Sent to your browser", "Sent to your browser"]);
  for (const item of real.items) assert.doesNotMatch(stateLabel(item.state), /open|read|loaded|done/i);
});

test("coming back after a real handoff restores focus to the saved control only when nothing else holds focus", () => {
  resetStore();
  const focused: string[] = [];
  const control = (key: string) => ({ dataset: { focusKey: key }, isConnected: true, focus: () => focused.push(key), scrollIntoView: () => {} });
  const nodes = [control("work-other"), control("work-essay")];
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), {
    visibilityState: "visible", activeElement: null as unknown, body: {},
    querySelectorAll: () => nodes,
  });
  Object.assign(globalThis, { window: win, document: doc, requestAnimationFrame: (run: () => void) => run() });
  try {
    const stop = subscribe(() => {});
    putOutcome("essay", outcomeFromReceipt(set, receipt({ opened: [{ resourceId: "essay", title: "Essay 2", via: "browser" }] })), { anchor: "work-essay", awaitingReturn: true, left: false });
    win.dispatchEvent(new Event("focus"));
    assert.deepEqual(focused, [], "no return without leaving first");
    win.dispatchEvent(new Event("blur"));
    doc.activeElement = doc.body;
    win.dispatchEvent(new Event("focus"));
    assert.deepEqual(focused, ["work-essay"], "focus returns to the control that started the launch");
    assert.ok(getEntry("essay")?.returnedAt);
    // The student already moved on to something else: their focus is kept.
    putOutcome("essay", getEntry("essay")!.outcome, { awaitingReturn: true, left: false });
    win.dispatchEvent(new Event("blur"));
    doc.activeElement = { isConnected: true };
    win.dispatchEvent(new Event("focus"));
    assert.deepEqual(focused, ["work-essay"]);
    stop();
  } finally {
    for (const key of ["window", "document", "requestAnimationFrame"]) Reflect.deleteProperty(globalThis, key);
  }
});


test("destination identity rejects credentialed and non-web URLs and preserves unknown hosts", () => {
  const web = (url: string) => destinationOf({ kind: "web", url });
  assert.equal(web("https://CANVAS.WISC.EDU:443/path").icon, "canvas");
  for (const url of ["https://user:secret@canvas.wisc.edu/a", "https://canvas.wisc.edu@evil.test/a", "ftp://canvas.wisc.edu/a", "javascript:alert(1)", "not a URL"]) {
    const d = web(url);
    assert.equal(d.category, "web");
    assert.equal(d.name, "Destination unavailable", url);
    assert.doesNotMatch(JSON.stringify(d), /secret|user:/);
  }
  for (const url of ["https://canvas.wisc.edu.evil.test/a", "https://git.doit.wisc.edu.evil.test/a", "https://canvas.wısc.edu/a", "https://canvas.wisc.edu:8443/a"]) assert.equal(web(url).category, "web", url);
  assert.equal(web("https://www.reading.example:8443/chapter?private=1").name, "www.reading.example:8443");
  const urls = ["https://one.example/a", "https://two.example/a", "https://one.example/b"];
  const groups = destinationGroups(urls.map((url, i) => ({ resourceId: String(i), target: {kind: "web", url} })));
  assert.equal(groups.length, 2);
  assert.equal(destinationSummary(groups), "2 pages on one.example and 1 page on two.example");
  assert.equal(destinationPhrase({role: "material", target: {kind: "web", url: "file:///secret"}}), "Destination unavailable");
});
