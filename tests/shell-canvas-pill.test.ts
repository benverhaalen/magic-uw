// owner: onboarding-recovery. The upper-right Canvas pill's words, and the brand's optical offset
// recomputed from the shipped Karma file. Synthetic source rows only; no DOM, browser or Electron.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SourceHealth, Snapshot } from "@magic/contracts";
import { CANVAS_PILL_LABELS, canvasAccountStates, canvasPill } from "../apps/desktop/src/renderer/canvas-pill";

const now = new Date("2026-09-27T15:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const connection = (fields: Partial<SourceHealth> = {}): SourceHealth => ({
  id: "canvas:c:status", label: "Canvas · connection", kind: "canvas", accountScope: "connection:c", courseId: "connection", scope: "connection",
  status: "ok", complete: true, lastAttemptAt: minutesAgo(5), lastSuccessAt: minutesAgo(5), resourceCount: 0, ...fields,
});
const course = (fields: Partial<SourceHealth> = {}): SourceHealth => ({
  id: `canvas:acct-a:101:${fields.scope ?? "assignments"}`, label: "Synthetic 101 · assignments", kind: "canvas", accountScope: "acct-a", courseId: "101", scope: "assignments",
  status: "ok", complete: true, lastAttemptAt: minutesAgo(5), lastSuccessAt: minutesAgo(5), resourceCount: 3, ...fields,
});
const snap = (sources: SourceHealth[], fixtureMode = false) => ({ sources, syncRuns: [], planning: undefined, fixtureMode }) as unknown as Pick<Snapshot, "sources" | "syncRuns" | "planning" | "fixtureMode">;
const state = (sources: SourceHealth[], o: Partial<{ online: boolean; signInStage: "idle" | "signin" | "checking"; fixture: boolean }> = {}) =>
  canvasPill(snap(sources, o.fixture), { now, online: o.online ?? true, signInStage: o.signInStage ?? "idle" });

test("state table (one account): 'Up to Date' only when Canvas was reachable, complete and read fresh", () => {
  const fresh = [connection(), course()];
  const table: Array<[string, ReturnType<typeof state>, string | null, string | null]> = [
    ["reachable, complete, fresh", state(fresh), "Up to Date", "sources"],
    ["sign-in window open", state(fresh, { signInStage: "signin" }), "Signing in…", null],
    ["reading after sign-in", state(fresh, { signInStage: "checking" }), "Refreshing…", null],
    ["a read in progress", state([connection(), course({ status: "partial", complete: false, progress: { phase: "reading", completed: 2 } })]), "Refreshing…", null],
    ["an interrupted read (old 'reading' batch)", state([connection(), course({ status: "partial", complete: false, lastAttemptAt: minutesAgo(40), progress: { phase: "reading", completed: 2 } })]), "Partly read", "sources"],
    ["offline", state(fresh, { online: false }), "Offline", "sources"],
    ["session expired", state([connection({ status: "needs_sign_in", complete: false }), course({ status: "needs_sign_in", complete: false })]), "Sign in to", "signin"],
    ["partial read", state([connection(), course({ status: "partial", complete: false })]), "Partly read", "sources"],
    ["last check failed", state([connection({ status: "error", complete: false }), course()]), "Can’t reach", "sources"],
    ["read, but over a day ago", state([connection({ lastSuccessAt: minutesAgo(26 * 60) }), course({ lastSuccessAt: minutesAgo(26 * 60) })]), "Out of date", "sources"],
    ["sample data", state(fresh, { fixture: true }), null, null],
    ["no Canvas yet", state([]), null, null],
  ];
  for (const [name, pill, label, action] of table) {
    assert.equal(pill?.label ?? null, label, name);
    assert.equal(pill?.action ?? null, action, name);
  }
  assert.equal(table.filter(([, pill]) => pill?.label === "Up to Date").length, 1, "exactly one row may say Up to Date");
});

// Two saved accounts, A and B. No authoritative "current" account exists in the renderer, so no
// ordering by recency may pick one: every relevant account must be reachable and fresh.
const acct = (scope: string, courseId: string, fields: Partial<SourceHealth> = {}) =>
  course({ id: `canvas:${scope}:${courseId}:${fields.scope ?? "assignments"}`, accountScope: scope, courseId, ...fields });
const failures: Array<[string, Partial<SourceHealth>, string]> = [
  ["expired", { status: "needs_sign_in", complete: false }, "Sign in to"],
  // The Sources rule: one failed course read is "partly read"; "Can’t reach" is a failed connection check.
  ["course read failed", { status: "error", complete: false }, "Partly read"],
  ["partly read", { status: "partial", complete: false }, "Partly read"],
  ["never read (unknown)", { status: "ok", complete: true, lastSuccessAt: null }, "Out of date"],
  ["read over a day ago", { lastSuccessAt: minutesAgo(26 * 60) }, "Out of date"],
];

test("two accounts: a newer success never hides an older account's failure", () => {
  const newerOk = acct("acct-a", "101", { lastAttemptAt: minutesAgo(1), lastSuccessAt: minutesAgo(1) });
  for (const [name, fields, label] of failures) {
    const olderBad = acct("acct-b", "202", { lastAttemptAt: minutesAgo(90), ...fields });
    assert.equal(state([connection(), newerOk, olderBad])?.label, label, `older account ${name}, newer ok`);
    assert.equal(state([connection(), olderBad, newerOk])?.label, label, `order of rows does not matter (${name})`);
    // …and the reverse: the older account fine, the newer one failing.
    const newerBad = acct("acct-b", "202", { lastAttemptAt: minutesAgo(1), ...fields });
    const olderOk = acct("acct-a", "101", { lastAttemptAt: minutesAgo(90), lastSuccessAt: minutesAgo(90) });
    assert.equal(state([connection(), olderOk, newerBad])?.label, label, `newer account ${name}, older ok`);
  }
  // Offline outranks any account state; it never reads as Up to Date.
  assert.equal(state([connection(), newerOk, acct("acct-b", "202")], { online: false })?.label, "Offline");
  // Both accounts genuinely fine.
  assert.equal(state([connection(), newerOk, acct("acct-b", "202", { lastAttemptAt: minutesAgo(90), lastSuccessAt: minutesAgo(90) })])?.label, "Up to Date");
  assert.deepEqual(canvasAccountStates(snap([connection(), newerOk, acct("acct-b", "202", { status: "error", complete: false })]), now).map((a) => [a.accountScope, a.state]),
    [["acct-a", "connected"], ["acct-b", "partial"]], "each account is judged on its own rows (a failed course read is partial)");
});

test("single account: genuine success is Up to Date; the connection row alone is judged too", () => {
  assert.equal(state([connection(), acct("acct-a", "101")])?.label, "Up to Date");
  assert.equal(state([connection()])?.label, "Up to Date", "connection verified, no course rows yet");
  assert.equal(state([connection({ status: "needs_sign_in", complete: false }), acct("acct-a", "101")])?.label, "Sign in to", "a shared connection row that expired expires every account");
});

test("relevance: an account whose course sites are all left out doesn't hold the pill back; an included one does", () => {
  const site = (scope: string, courseId: string, included: boolean) => ({
    source: acct(scope, courseId, { scope: "course", id: `canvas:${scope}:${courseId}:course` }),
    resource: { id: `r-${scope}-${courseId}`, kind: "course", sourceId: `canvas:${scope}:${courseId}:course`, courseId, deleted: false, courseName: `Synthetic ${courseId}`, course: { selection: { included } } },
  });
  const a = site("acct-a", "101", true);
  const bLeftOut = site("acct-b", "202", false), bIncluded = site("acct-b", "202", true);
  const oldExpired = acct("acct-b", "202", { status: "needs_sign_in", complete: false, lastAttemptAt: minutesAgo(3000) });
  const withResources = (rows: ReturnType<typeof site>[], extra: SourceHealth[]) =>
    canvasPill({ ...snap([connection(), ...rows.map((r) => r.source), ...extra]), resources: rows.map((r) => r.resource) }, { now, online: true, signInStage: "idle" });
  assert.equal(withResources([a, bLeftOut], [oldExpired])?.label, "Up to Date", "left-out sites stay out of Today and AI context");
  assert.equal(withResources([a, bIncluded], [oldExpired])?.label, "Sign in to", "an included site on the other account counts");
});

test("no layout shift: the pill keeps its fixed 124px slot and every label fits beside the Canvas mark", () => {
  const css = readFileSync(new URL("../apps/desktop/src/renderer/desktop.css", import.meta.url), "utf8");
  assert.match(css, /\.desktop-chrome \.desktop-canvas-action \{[^}]*width: 124px; flex: 0 0 124px;/);
  // 124 − 22 padding − 18 mark − 8 gap = 76px for 12px Geist text: about 11 characters.
  for (const label of CANVAS_PILL_LABELS) assert.ok(label.length <= 11, label);
});

test("brand: the offset in desktop.css is Karma's own cap-centre correction (no stale upward nudge)", () => {
  const font = readFileSync(new URL("../packages/ui/assets/fonts/Karma-Medium.ttf", import.meta.url));
  const tables = new Map<string, number>();
  for (let i = 0, n = font.readUInt16BE(4); i < n; i++) tables.set(font.toString("latin1", 12 + i * 16, 16 + i * 16), font.readUInt32BE(20 + i * 16));
  const upm = font.readUInt16BE(tables.get("head")! + 18);
  const ascent = font.readInt16BE(tables.get("hhea")! + 4), descent = -font.readInt16BE(tables.get("hhea")! + 6);
  const capHeight = font.readInt16BE(tables.get("OS/2")! + 88);
  // Line box 1.4em; half-leading + ascent = baseline; the caps' centre sits capHeight/2 above it.
  const baseline = (1.4 - (ascent + descent) / upm) / 2 + ascent / upm;
  const offset = 0.7 - (baseline - capHeight / upm / 2);
  const css = readFileSync(new URL("../apps/desktop/src/renderer/desktop.css", import.meta.url), "utf8");
  const rule = css.match(/\.desktop-chrome \.desktop-brand \{[^}]*\}/)![0];
  assert.doesNotMatch(rule, /translateY\(-/, "the stale upward transform is gone");
  const applied = Number(rule.match(/translateY\(([\d.]+)em\)/)![1]);
  assert.ok(Math.abs(applied - offset) < 0.005, `applied ${applied}em vs computed ${offset.toFixed(3)}em`);
});
