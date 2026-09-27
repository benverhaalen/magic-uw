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
  assert.deepEqual(steps.map((s) => s.id), ["consent", "uw", "client", "appearance", "connections", "done"]);
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
