import test from "node:test";
import assert from "node:assert/strict";
import type { ResourceView, Snapshot, SourceHealth } from "@magic/contracts";
import { hasCurrentConsent, CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import {
  createPreviewClients,
  emptyProgress,
  firstIncompleteStep,
  needsOnboarding,
  orderedClients,
  readProgress,
  summarize,
  writeProgress,
  steps,
  type OnboardingProgress,
} from "../apps/desktop/src/renderer/onboarding/model";
import {
  ACCENTS,
  appearanceKey,
  applyAppearance,
  defaultAppearance,
  readAppearance,
  resolveTheme,
  writeAppearance,
} from "../apps/desktop/src/renderer/appearance";

// Synthetic snapshots only.
function snapshot(parts: Partial<Snapshot> = {}): Snapshot {
  return {
    resources: [],
    sources: [],
    privacy: {} as Snapshot["privacy"],
    links: [],
    jobs: [],
    receipts: [],
    attempts: [],
    fixtureMode: false,
    gatewayConfigured: false,
    generatedAt: "2026-09-26T12:00:00.000Z",
    consents: [],
    ...parts,
  };
}
const uwAgreed = [
  { recipient: "uw" as const, disclosureVersion: CONSENT_DISCLOSURE_VERSION, grantedAt: "2026-09-26T12:00:00.000Z" },
];
function source(parts: Partial<SourceHealth>): SourceHealth {
  return {
    id: "s1",
    label: "Canvas: Synthetic 101",
    kind: "canvas",
    accountScope: "a",
    courseId: "c1",
    scope: "course",
    status: "ok",
    lastAttemptAt: "2026-09-26T12:00:00.000Z",
    lastSuccessAt: "2026-09-26T12:00:00.000Z",
    complete: true,
    resourceCount: 3,
    ...parts,
  };
}
const resource = (kind: ResourceView["kind"], deleted = false) =>
  ({ id: `${kind}-${Math.random()}`, kind, deleted }) as unknown as ResourceView;
const progress = (parts: Partial<OnboardingProgress>) => ({ ...emptyProgress, ...parts });

// owner: client-health (D51): the step order is Agreement → UW sign-in → Your AI → Appearance →
// Connections → done; these three replace T81's Welcome → Your AI → Connect → UW → Populating.
test("first run starts at the agreement; an existing populated, agreed workspace skips onboarding", () => {
  assert.equal(needsOnboarding(snapshot(), emptyProgress, hasCurrentConsent), true);
  assert.equal(firstIncompleteStep(snapshot(), emptyProgress, hasCurrentConsent), "consent");
  // fix/current-courses-only: "Your courses" follows UW sign-in, so the student chooses before the first full read.
  assert.deepEqual(steps.map((s) => s.id), ["consent", "uw", "courses", "client", "appearance", "connections", "done"]);
  const existing = snapshot({ consents: uwAgreed, resources: [resource("assignment")] });
  assert.equal(needsOnboarding(existing, emptyProgress, hasCurrentConsent), false);
  assert.equal(needsOnboarding(existing, progress({ started: true }), hasCurrentConsent), true);
  assert.equal(needsOnboarding(snapshot(), progress({ done: true }), hasCurrentConsent), false);
});

test("a relaunch resumes at the first incomplete step; only a confirmed or skipped UW sign-in moves on", () => {
  const agreed = snapshot({ consents: uwAgreed });
  const at = (s: Snapshot, parts: Partial<OnboardingProgress>) => firstIncompleteStep(s, progress(parts), hasCurrentConsent);
  assert.equal(at(snapshot(), { started: true, client: "claude", clientConnected: true }), "consent");
  assert.equal(at(agreed, { started: true }), "uw");
  // FDB-002: a closed or failed sign-in window is not a sign-in.
  assert.equal(at(agreed, { started: true, uw: "cancelled" }), "uw");
  assert.equal(at(agreed, { started: true, uw: "failed" }), "uw");
  assert.equal(at(agreed, { started: true, uw: "confirmed" }), "client");
  assert.equal(at(agreed, { started: true, uw: "skipped" }), "client");
  assert.equal(at(snapshot({ consents: uwAgreed, sources: [source({})] }), { started: true }), "client");
  assert.equal(at(agreed, { uw: "confirmed", client: "codex" }), "client");
  assert.equal(at(agreed, { uw: "confirmed", client: "codex", clientConnected: true }), "appearance");
  assert.equal(at(agreed, { uw: "confirmed", client: "later" }), "appearance");
  assert.equal(at(agreed, { uw: "confirmed", client: "later", appearanceDone: true }), "connections");
  assert.equal(at(agreed, { uw: "confirmed", client: "later", appearanceDone: true, connectionsDone: true }), "done");
});

test("saved progress round-trips, rejects malformed values, and reads T81's record once", () => {
  const data = new Map<string, string>();
  const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  const saved = progress({ started: true, uw: "confirmed", client: "codex", clientConnected: true, appearanceDone: true });
  writeProgress(saved, store);
  assert.deepEqual(readProgress(store), saved);
  data.set("magic.onboarding.v2", JSON.stringify({ started: "yes", uw: "maybe", client: "other", clientConnected: true }));
  assert.deepEqual(readProgress(store), emptyProgress);
  data.set("magic.onboarding.v2", "{not json");
  assert.deepEqual(readProgress(store), emptyProgress);
  assert.deepEqual(readProgress(null), emptyProgress);
  data.delete("magic.onboarding.v2");
  data.set("magic.onboarding.v1", JSON.stringify({ welcomed: true, client: "claude", clientConnected: true, uwStarted: true, done: false }));
  assert.deepEqual(readProgress(store), progress({ started: true, client: "claude", clientConnected: true }));
});

test("appearance: the choice persists, bad values fall back, and only root attributes are set", () => {
  const data = new Map<string, string>();
  const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  assert.deepEqual(readAppearance(store), defaultAppearance);
  writeAppearance({ theme: "dark", accent: "rose" }, store);
  assert.deepEqual(readAppearance(store), { theme: "dark", accent: "rose" });
  data.set(appearanceKey, JSON.stringify({ theme: "sepia", accent: "#ff00ff" }));
  assert.deepEqual(readAppearance(store), defaultAppearance);
  const attrs = new Map<string, string>();
  const root = { setAttribute: (k: string, v: string) => void attrs.set(k, v) };
  assert.equal(applyAppearance({ theme: "system", accent: "blue" }, root, true), "dark");
  assert.deepEqual(Object.fromEntries(attrs), { "data-theme": "dark", "data-theme-preference": "system", "data-accent": "blue" });
  assert.equal(applyAppearance({ theme: "light", accent: "warm" }, root, true), "light");
  assert.equal(resolveTheme("system", false), "light");
  // Accents are named token references, never colour values.
  for (const a of ACCENTS) assert.match(a.swatch, /^--magic-[a-z-]+$/);
});

test("client tiles keep the fixed order and fill an omitted client as not installed", () => {
  const ordered = orderedClients([
    { id: "codex", installed: true, version: "0.156.1", profileReady: false, signedIn: false, isolated: true },
  ]);
  assert.deepEqual(ordered.map((c) => c.id), ["claude", "codex", "gemini"]);
  assert.equal(ordered[0].installed, false);
  assert.equal(ordered[1].version, "0.156.1");
});

test("the preview fixture reports its sample clients and signs in only after the terminal opens", async () => {
  const clients = createPreviewClients(0);
  const found = await clients.detect();
  assert.deepEqual(
    found.map((c) => [c.id, c.installed, c.version]),
    [
      ["claude", true, "2.1.283"],
      ["codex", true, "0.156.1"],
      ["gemini", false, undefined],
    ],
  );
  assert.equal((await clients.authStatus("claude")).signedIn, false);
  await clients.terminal.open("claude", "signin");
  assert.equal((await clients.authStatus("claude")).signedIn, true);
});

test("populating shows partial and failed sources with a reason, never as all clear", () => {
  const s = snapshot({
    sources: [
      source({ id: "a", status: "ok", complete: true }),
      source({ id: "b", status: "partial", complete: false, resourceCount: 2 }),
      source({ id: "c", status: "needs_sign_in", complete: false, resourceCount: 0 }),
    ],
    resources: [resource("course"), resource("assignment"), resource("assignment"), resource("material", true)],
  });
  const summary = summarize(s, false);
  assert.equal(summary.outcome, "issues");
  assert.deepEqual(summary.sources.map((l) => l.state), ["ready", "partial", "failed"]);
  assert.ok(summary.sources[1].reason && summary.sources[2].reason);
  assert.equal(summary.sources[2].status, "Sign in needed");
  assert.deepEqual(summary.counts, [
    { label: "course", count: 1 },
    { label: "assignments", count: 2 },
  ]);
  assert.equal(summary.total, 3);
});

test("populating reports reading while a source is in flight, and empty with nothing connected", () => {
  const reading = summarize(
    snapshot({ sources: [source({ progress: { phase: "Reading modules", completed: 2, total: 9 } })] }),
    false,
  );
  assert.equal(reading.outcome, "reading");
  assert.equal(reading.sources[0].detail, "Reading modules, 2 of 9");
  assert.equal(summarize(snapshot(), false).outcome, "empty");
  assert.equal(summarize(snapshot(), true).outcome, "reading");
  assert.equal(summarize(snapshot({ sources: [source({})] }), false).outcome, "ready");
});

test("populating treats a finished Canvas batch as done, not reading, whatever its phase says", () => {
  // Canvas progress has no total: phase is "complete" or the terminal status.
  const done = source({ id: "a", status: "ok", complete: true, progress: { phase: "complete", completed: 4 } });
  const shut = source({ id: "b", status: "inaccessible", complete: false, resourceCount: 0, progress: { phase: "inaccessible", completed: 0 } });
  const streaming = source({ id: "c", status: "partial", complete: false, progress: { phase: "reading", completed: 2 } });
  const idle = summarize(snapshot({ sources: [done, shut, streaming] }), false);
  assert.deepEqual(idle.sources.map((l) => l.state), ["ready", "failed", "partial"]);
  assert.equal(idle.outcome, "issues");
  const running = summarize(snapshot({ sources: [done, shut, streaming] }), true);
  assert.deepEqual(running.sources.map((l) => l.state), ["ready", "failed", "reading"]);
});

// fix/current-courses-only: "partly ready" names what wasn't read, why, and one action; excluded
// courses, hidden lists and sources still reading are not issues; files may still be arriving.
function courseRow(courseId: string, included: boolean, name = `Synthetic ${courseId}`): ResourceView {
  return {
    id: `course-${courseId}`, sourceId: `canvas:a:${courseId}:course`, externalId: courseId, kind: "course", courseId, courseName: name,
    title: name, url: `https://canvas.wisc.edu/courses/${courseId}`, text: "", deadlines: [], deleted: false,
    course: { selection: { score: 5, included, reasons: [] } },
  } as unknown as ResourceView;
}
const at = (courseId: string, scope: string, parts: Partial<SourceHealth> = {}) =>
  source({ id: `canvas:a:${courseId}:${scope}`, courseId, scope, ...parts });
const courseSources = (courseId: string) => [at(courseId, "course"), at(courseId, "assignments"), at(courseId, "modules")];

test("populating: ready when assignments and modules are read, with files still coming in", () => {
  const s = snapshot({
    sources: [
      ...courseSources("101"),
      at("101", "file:1", { status: "partial", complete: false, diagnostics: [{ code: "file_budget_deferred", path: [], severity: "warning" }] }),
      at("101", "file:2"),
      at("101", "pages", { status: "inaccessible", complete: false }),
    ],
    resources: [courseRow("101", true)],
  });
  const summary = summarize(s, true);
  assert.equal(summary.outcome, "ready");
  assert.equal(summary.filesArriving, 1);
  assert.equal(summary.hiddenLists, 1, "a Pages list hidden from students is not partial");
  const files = summary.sources.find((l) => l.id.startsWith("files:"))!;
  assert.equal(files.status, "Still coming in");
  assert.equal(files.detail, "1 of 2 read");
  assert.ok(!summary.sources.some((l) => l.state === "partial" || l.state === "failed"));
});

test("populating: an excluded course and a source still reading are not issues", () => {
  const s = snapshot({
    sources: [
      ...courseSources("101"),
      at("201", "course"),
      at("201", "assignments", { status: "error", complete: false }),
      at("201", "modules"),
      at("101", "announcements", { status: "ok", complete: false, progress: { phase: "reading", completed: 1, total: 3 } }),
    ],
    resources: [courseRow("101", true), courseRow("201", false)],
  });
  const summary = summarize(s, false);
  assert.ok(!summary.sources.some((l) => l.id.includes(":201:")), "the excluded course isn't listed");
  assert.equal(summary.sources.find((l) => l.id.endsWith(":announcements"))!.state, "reading");
  assert.equal(summary.outcome, "ready", "assignments and modules of the included course are read");
});

test("populating: each issue names its reason and one action (sign in again, retry, why)", () => {
  const s = snapshot({
    sources: [
      at("101", "course"),
      at("101", "assignments", { status: "needs_sign_in", complete: false }),
      at("101", "modules", { status: "error", complete: false, diagnostics: [{ code: "http_failure", path: [], severity: "error" }] }),
      at("101", "quizzes", { status: "needs_attention", complete: false, diagnostics: [{ code: "record_count_drop", path: [], severity: "error" }] }),
      at("101", "file:9", { status: "error", complete: false }),
    ],
    resources: [courseRow("101", true)],
  });
  const summary = summarize(s, false);
  assert.equal(summary.outcome, "issues");
  const line = (scope: string) => summary.sources.find((l) => l.id.endsWith(`:${scope}`))!;
  assert.equal(line("assignments").action, "sign-in");
  assert.equal(line("modules").action, "retry");
  assert.match(line("modules").why ?? "", /Canvas answered with an error/);
  assert.equal(line("quizzes").action, "why");
  assert.match(line("quizzes").why ?? "", /earlier copy was kept/);
  for (const scope of ["assignments", "modules", "quizzes"]) assert.ok(line(scope).reason, scope);
  const files = summary.sources.find((l) => l.id.startsWith("files:"))!;
  assert.equal(files.state, "partial");
  assert.equal(files.action, "why");
});
