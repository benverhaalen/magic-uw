// Source status in plain categories: a student sees Canvas, UW enrollment, Outlook, Notes and Course
// websites with "Up to date", "Updating", "Some files couldn't be read", "Sign in again", never internal
// endpoint names or diagnostic codes. States come from the same source health as before; problems stay.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SourceHealth, Snapshot } from "@magic/contracts";
import { describeSources, sourceCategory, sourceCourseName } from "@magic/domain";
import { categorizeSummary, summarize } from "../apps/desktop/src/renderer/onboarding/model";
import { buildSourcesModel, connectionStateWords } from "../apps/desktop/src/renderer/sources/model";
import { developerMode } from "../apps/desktop/src/renderer/developer";

// Synthetic source health only.
const NOW = new Date("2026-09-27T15:00:00Z");
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();
const src = (id: string, fields: Partial<SourceHealth>): SourceHealth => ({
  id, label: "Example 101 · course", kind: "canvas", accountScope: "acct", courseId: "c1", scope: "course", status: "ok",
  lastAttemptAt: at(1), lastSuccessAt: at(1), complete: true, resourceCount: 3, ...fields,
});
const snap = (sources: SourceHealth[], extra: Partial<Snapshot> = {}) => ({
  resources: [], sources, privacy: {} as Snapshot["privacy"], links: [], jobs: [], receipts: [], attempts: [], fixtureMode: false,
  gatewayConfigured: false, generatedAt: NOW.toISOString(), consents: [], ...extra,
}) as Snapshot;
const timeLimit: SourceHealth["diagnostics"] = [{ code: "scope_time_limit", path: [] }];
// The operator's case: account endpoints and a course website crawl, partly read at the time limit.
const reported = [
  src("course", { label: "Example 101 · course" }),
  src("assignments", { label: "Example 101 · assignments", scope: "assignments" }),
  src("modules", { label: "Example 101 · modules", scope: "modules" }),
  src("todo", { label: "Canvas account · todo", courseId: "account", scope: "todo", status: "partial", complete: false, diagnostics: timeLimit }),
  src("events", { label: "Canvas account · upcoming-events", courseId: "account", scope: "upcoming-events", status: "partial", complete: false, diagnostics: timeLimit }),
  src("activity", { label: "Canvas account · activity", courseId: "account", scope: "activity", status: "partial", complete: false, diagnostics: timeLimit }),
  src("web", { label: "Example 101 course websites", kind: "web", scope: "course_websites", status: "partial", complete: false, diagnostics: timeLimit }),
];
const RAW = /todo|to-do|activity|upcoming|events|account|time limit|scope_|partial:/i;

test("each internal source kind maps to one plain category", () => {
  assert.equal(sourceCategory({ kind: "canvas", courseId: "account" }), "canvas");
  assert.equal(sourceCategory({ kind: "kaltura", courseId: "c1" }), "canvas");
  assert.equal(sourceCategory({ kind: "web", courseId: "c1" }), "websites");
  assert.equal(sourceCategory({ kind: "site", courseId: "c1" }), "websites");
  assert.equal(sourceCategory({ kind: "gitlab", courseId: "c1" }), "websites");
  assert.equal(sourceCategory({ kind: "calendar", courseId: "outlook-calendar" }), "outlook");
  assert.equal(sourceCategory({ kind: "mail", courseId: "outlook-mail" }), "outlook");
  assert.equal(sourceCategory({ kind: "notes", courseId: "c1" }), "notes");
  assert.equal(sourceCourseName({ label: "CHEM 142 · assignments", courseId: "c1", scope: "assignments" }), "CHEM 142");
  assert.equal(sourceCourseName({ label: "CHEM 142 course websites", courseId: "c1", scope: "course_websites" }), "CHEM 142");
  assert.equal(sourceCourseName({ label: "Canvas account · todo", courseId: "account", scope: "todo" }), null);
  assert.equal(describeSources(reported.slice(3)), "Canvas and Course websites (Example 101)");
});

test("the workspace step shows one plain line per category, with Retry, and the raw lines only as parts", () => {
  const s = snap(reported);
  const lines = categorizeSummary(s, summarize(s, false));
  assert.deepEqual(lines.map((l) => [l.label, l.status, l.action]), [
    ["Canvas", "Some parts couldn't be read", "retry"],
    ["Course websites", "Some parts couldn't be read", "retry"],
  ]);
  for (const line of lines) for (const text of [line.label, line.status, line.reason ?? "", line.detail ?? ""]) assert.doesNotMatch(text, RAW, text);
  assert.ok(lines[0]!.parts.some((p) => /todo/.test(p.label)), "the per-endpoint lines are kept for developer details");
  assert.equal(lines[0]!.why, "Canvas took too long to answer; the rest is read on the next refresh.", "the cause, phrased for students");
});

test("friendly states: up to date, updating, sign in again, files, and UW enrollment", () => {
  const ok = snap([src("course", {}), src("assignments", { scope: "assignments" }), src("modules", { scope: "modules" })]);
  assert.deepEqual(categorizeSummary(ok, summarize(ok, false)).map((l) => l.status), ["Up to date"]);
  const reading = snap([src("course", { complete: false, progress: { phase: "assignments", completed: 1, total: 4 } as SourceHealth["progress"] })]);
  assert.deepEqual(categorizeSummary(reading, summarize(reading, true)).map((l) => l.status), ["Updating"]);
  const signedOut = snap([src("course", { status: "needs_sign_in", complete: false })]);
  assert.deepEqual(categorizeSummary(signedOut, summarize(signedOut, false)).map((l) => [l.status, l.action]), [["Sign in again", "sign-in"]]);
  const files = snap([src("course", {}), src("assignments", { scope: "assignments" }), src("modules", { scope: "modules" }), src("f1", { scope: "file:9", status: "error", complete: false })]);
  assert.deepEqual(categorizeSummary(files, summarize(files, false)).map((l) => l.status), ["Some files couldn't be read"]);
  const uw = snap([], { planning: { records: [], sources: [{ id: "p1", source: "uw_enroll", accountScope: "a", scope: { kind: "enrollment" }, sourceUrl: "https://example.test", status: "complete", completeness: "complete", observedAt: at(1), lastSuccessAt: at(1), diagnostics: [] }] } as unknown as Snapshot["planning"] });
  assert.deepEqual(categorizeSummary(uw, summarize(uw, false)).map((l) => [l.label, l.status]), [["UW enrollment", "Up to date"]]);
});

test("Sources: course websites are one row; state words are plain; files-only problems say files", () => {
  const model = buildSourcesModel({ sources: [...reported, src("web2", { label: "Other 202 course websites", kind: "web", courseId: "c2", scope: "course_websites" })] }, { now: NOW, outlook: { icsConnected: false } });
  const websites = model.connections.filter((c) => c.name === "Course websites");
  assert.deepEqual(websites.map((c) => c.records), [3], "a Canvas course's own website stays in its Canvas row; the rest is one row");
  const standalone = buildSourcesModel({ sources: [src("w1", { label: "A course websites", kind: "web", courseId: "x1", scope: "course_websites" }), src("w2", { label: "B course websites", kind: "web", courseId: "x2", scope: "course_websites", status: "partial", complete: false })] }, { now: NOW, outlook: { icsConnected: false } });
  const rows = standalone.connections.filter((c) => c.id.startsWith("category:"));
  assert.deepEqual(rows.map((c) => [c.name, connectionStateWords(c)]), [["Course websites", "Some parts couldn't be read"]]);
  assert.doesNotMatch(rows[0]!.headline, RAW);
  const canvas = model.connections.find((c) => c.id === "canvas")!;
  assert.equal(connectionStateWords(canvas), "Some parts couldn't be read");
  assert.equal(connectionStateWords(canvas, true), "Updating");
  const filesOnly = buildSourcesModel({ sources: [src("course", {}), src("f", { scope: "file:1", status: "partial", complete: false })] }, { now: NOW, outlook: { icsConnected: false } }).connections.find((c) => c.id === "canvas")!;
  assert.equal(connectionStateWords(filesOnly), "Some files couldn't be read");
  assert.equal(connectionStateWords({ ...filesOnly, state: "needs_sign_in" }), "Sign in again");
  assert.equal(connectionStateWords({ ...filesOnly, state: "connected" }), "Up to date");
});

test("notifications name categories and courses, never endpoints", async () => {
  const { buildNotifications } = await import("@magic/domain");
  const failing = reported.slice(3).map((s) => ({ ...s, status: "error" as const }));
  const feed = buildNotifications({
    changes: [], resources: [], sources: failing, baselineReadIds: [], included: () => true, triage: {}, mailTriage: {},
    triageStatus: { status: "on", reason: "Ready." }, state: { readIds: [], dismissedIds: [] }, now: NOW.toISOString(), timeZone: "America/Chicago",
  });
  const stale = feed.items.find((n) => n.reason === "source_stale")!;
  assert.equal(stale.detail, "Updates may be missing from Canvas and Course websites (Example 101)");
  assert.equal(stale.count, 4, "every failing source still counts");
});

test("raw per-endpoint lists are developer details only", () => {
  assert.equal(developerMode(), false, "off unless this device turned it on");
  const page = readFileSync(new URL("../apps/desktop/src/renderer/sources/SourcesPage.tsx", import.meta.url), "utf8");
  assert.equal((page.match(/developerMode\(\)/g) ?? []).length >= 4, true, "course sections, Outlook notes, planning sources and other notes");
  const onboarding = readFileSync(new URL("../apps/desktop/src/renderer/onboarding/Onboarding.tsx", import.meta.url), "utf8");
  assert.match(onboarding, /categories\.length > 0 && developerMode\(\) \? \(\n\s+<details className="onb-note">\n\s+<summary>Details<\/summary>/);
});
