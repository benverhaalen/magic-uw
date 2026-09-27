// Data & AI, redesigned: "Your AI" (who answers, with each client's status), one on/off row per kind
// of data, "Before sharing", the shared labels service, and Start fresh. The send gate itself is
// unchanged (egress, consent and privacy tests cover it); these check that every control writes the
// same preference the earlier page wrote, that Reset clears and keeps exactly what it says, and that
// the page's words carry no internal names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultPrivacy, type ClientHealth, type Command, type PrivacyPreferences } from "@magic/contracts";
import { SHARING_OPTIONS, sharingOf, sharingPatch } from "../apps/desktop/src/renderer/ai-choice/sharing";
import { SharingChoice } from "../apps/desktop/src/renderer/ai-choice/SharingChoice";
import { aiChoiceOf, aiChoicePatch, statusLine } from "../apps/desktop/src/renderer/ai-choice/answering";
import { SEPARATE_SIGN_IN, YourAiChoice, shownChoices } from "../apps/desktop/src/renderer/ai-choice/YourAiChoice";
import {
  JEV_COPY, PLANNING_ROW, PURGE_COMMAND, RECONFIGURE_CLEARS, RECONFIGURE_KEEPS, RESET_CLEARS, RESET_KEEPS, SHARE_ROWS,
  clearAppStorage, jevOn, jevPatch, shareNothingPatch, shareOn, sharePatch, sizeWords, startFresh,
} from "../apps/desktop/src/renderer/data-ai/model";
import { StartFresh, uwStatus } from "../apps/desktop/src/renderer/data-ai/sections";
import { localDataBytes } from "../apps/desktop/src/local-data";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const cloud: PrivacyPreferences = { ...defaultPrivacy, mode: "selective_cloud" };
const hosted: PrivacyPreferences = { ...cloud, hostedProvider: "claude" };
const row = (id: string) => SHARE_ROWS.find((r) => r.id === id)!;
const health = (state: ClientHealth["state"], extra: Partial<ClientHealth> = {}): ClientHealth => ({
  id: "claude", state, mode: "instant", source: "status", instant: { available: true }, modes: ["instant", "isolated"], checkedAt: "2026-09-27T12:00:00.000Z", ...extra,
});

test("your AI: a hosted choice selects it with cloud access on; this computer and Off both clear the hosted AI", () => {
  assert.deepEqual(aiChoicePatch(defaultPrivacy, "claude"), { hostedProvider: "claude", mode: "selective_cloud" });
  assert.equal(aiChoicePatch(hosted, "claude"), null);
  assert.deepEqual(aiChoicePatch(hosted, "codex"), { hostedProvider: "codex", mode: "selective_cloud" });
  assert.deepEqual(aiChoicePatch(hosted, "local"), { hostedProvider: "none" });
  assert.deepEqual(aiChoicePatch(hosted, "off"), { hostedProvider: "none" });
  assert.equal(aiChoicePatch(defaultPrivacy, "off"), null);
  assert.equal(aiChoiceOf({ ...hosted, mode: "local_only" }, false), "off", "a hosted pick with all sharing off is not answering");
  assert.deepEqual(shownChoices("off", false), ["claude", "codex", "off"], "this computer shows only once found");
  assert.deepEqual(shownChoices("off", true), ["claude", "codex", "local", "off"]);
  assert.deepEqual(shownChoices("gemini", false), ["claude", "codex", "gemini", "off"], "Gemini only while it is the saved choice");
});

test("your AI: each card says Connected, Signed out (Sign in), Not installed, or Usage limit with its reset time", () => {
  assert.deepEqual(statusLine(health("ok")), { text: "Connected", tone: "ok", action: null });
  assert.equal(statusLine(health("not_signed_in")).text, "Signed out");
  assert.equal(statusLine(health("not_signed_in")).action, "sign_in");
  assert.equal(statusLine(health("installed")).action, "sign_in");
  assert.deepEqual(statusLine(health("not_installed")), { text: "Not installed", tone: "problem", action: "install" });
  assert.equal(statusLine(health("usage_limited", { resetsAt: "3 pm" })).text, "Usage limit (resets 3 pm)");
  assert.match(statusLine(health("usage_limited", { resetsAt: "2026-09-27T20:00:00.000Z" })).text, /^Usage limit \(resets \d{1,2}:00/);
  assert.equal(statusLine(health("usage_limited")).text, "Usage limit");
  assert.equal(statusLine(null).text, "Not checked");
  const html = renderToStaticMarkup(React.createElement(YourAiChoice, { privacy: hosted, busy: false, onChange: () => {}, onSignIn: () => {}, openExternal: () => {} }));
  for (const name of ["Claude Code", "Codex", "Off"]) assert.ok(html.includes(`<strong>${name}</strong>`), name);
  assert.ok(!html.includes("On this computer</strong>"), "shown only once found");
  assert.ok(!html.includes("Gemini</strong>"));
  assert.equal(SEPARATE_SIGN_IN.sentence.split(/[.;] /).length, 2, "the Advanced toggle has one sentence (two clauses)");
});

test("before sharing: ask the first time (default) or every time, mapped onto alwaysPreview; there is no 'don't ask'", () => {
  assert.equal(sharingOf(defaultPrivacy), "first_time");
  assert.equal(sharingOf({ alwaysPreview: true }), "every_time");
  assert.deepEqual(sharingPatch(defaultPrivacy, "every_time"), { alwaysPreview: true });
  assert.deepEqual(sharingPatch({ alwaysPreview: true }, "first_time"), { alwaysPreview: false });
  assert.equal(sharingPatch(defaultPrivacy, "first_time"), null, "no change, no save");
  assert.deepEqual(SHARING_OPTIONS.map((o) => o.label), ["Ask the first time for each kind", "Ask every time"]);
  const html = renderToStaticMarkup(React.createElement(SharingChoice, { privacy: { ...defaultPrivacy, alwaysPreview: true }, disabled: false, onChange: () => {} }));
  assert.equal((html.match(/type="radio"/g) ?? []).length, 2);
  assert.ok(!/Don.t ask/.test(html));
  assert.match(html, /selected-mode"><input type="radio"[^>]*checked=""[^>]*\/><span><strong>Ask every time/);
});

test("what you share: each row writes the same preferences the earlier page wrote", () => {
  assert.deepEqual(SHARE_ROWS.map((r) => [r.label, r.keys]), [
    ["Course materials", ["shareCourseText"]],
    ["Your work and grades", ["shareStudentWork", "shareGrades", "shareComments"]],
    ["Course messages", ["shareCommunications"]],
  ]);
  assert.deepEqual(sharePatch(cloud, row("materials"), true), { shareCourseText: true });
  assert.deepEqual(sharePatch(cloud, row("work"), false), { shareStudentWork: false, shareGrades: false, shareComments: false });
  assert.deepEqual(sharePatch(cloud, row("messages"), true), { shareCommunications: true });
  assert.equal(shareOn({ ...cloud, shareGrades: true }, row("work")), true, "anything shared shows as on");
  assert.equal(shareOn({ ...defaultPrivacy, shareCourseText: true }, row("materials")), false, "all sharing off shows off");
  // Turning one kind on while all sharing is off: cloud access goes on and nothing else starts unseen.
  const stale: PrivacyPreferences = { ...defaultPrivacy, shareCourseText: true, shareGrades: true, jevEnabled: true, hostedProvider: "codex" };
  const next = { ...stale, ...sharePatch(stale, row("messages"), true) };
  assert.equal(next.mode, "selective_cloud");
  assert.equal(next.shareCommunications, true);
  for (const key of ["shareCourseText", "shareGrades", "shareStudentWork", "shareComments", "jevEnabled"] as const) assert.equal(next[key], false, key);
  assert.equal(next.hostedProvider, "none");
  assert.deepEqual(shareNothingPatch(), { shareCourseText: false, shareStudentWork: false, shareGrades: false, shareComments: false, shareCommunications: false });
  assert.match(PLANNING_ROW.line, /never shared/);
  const app = read("apps/desktop/src/renderer/App.tsx");
  assert.match(app, /onChange=\{\(checked\) => void update\(sharePatch\(value, row, checked\)\)\}/, "rows save through the consent-checking update");
  assert.match(app, /if \(missingConsents\(next, snapshot\.consents\)\.length\)\n\s+return onConsent\(next\);/);
});

test("shared labels: on or off through jevEnabled, and whether this build has it", () => {
  assert.equal(jevOn({ ...cloud, jevEnabled: true }), true);
  assert.equal(jevOn({ ...defaultPrivacy, jevEnabled: true }), false);
  assert.deepEqual(jevPatch(cloud, true), { jevEnabled: true });
  assert.deepEqual(jevPatch(cloud, false), { jevEnabled: false });
  assert.equal(jevPatch(defaultPrivacy, true).mode, "selective_cloud");
  assert.match(JEV_COPY.sentence, /titles and short previews only/);
  const app = read("apps/desktop/src/renderer/App.tsx");
  assert.match(app, /snapshot\.gatewayConfigured \? JEV_COPY\.available : JEV_COPY\.unavailable/);
});

test("reset: clears the AI setup, then purges, then this window's settings, then restarts into setup", async () => {
  const calls: string[] = [];
  const commands: Command[] = [];
  const deps = {
    clients: { reset: async () => { calls.push("clients.reset"); } },
    run: async (command: Command) => { calls.push("run"); commands.push(command); return {}; },
    clearStorage: () => calls.push("storage"),
    clearHealth: () => calls.push("health"),
    restart: () => calls.push("restart"),
  };
  await startFresh(deps);
  assert.deepEqual(calls, ["clients.reset", "run", "storage", "health", "restart"]);
  assert.deepEqual(commands, [PURGE_COMMAND]);
  assert.deepEqual(PURGE_COMMAND, { type: "purge", confirmation: "DELETE LOCAL DATA" }, "the same purge as Delete local data");
  // A failed purge stops before anything else is forgotten.
  calls.length = 0;
  await assert.rejects(startFresh({ ...deps, run: async () => { calls.push("run"); return undefined; } }), /could not be deleted/);
  assert.deepEqual(calls, ["clients.reset", "run"]);
  calls.length = 0;
  await assert.rejects(startFresh({ ...deps, clients: { reset: async () => { throw new Error("disk busy"); } } }), /disk busy/);
  assert.deepEqual(calls, []);
  await assert.rejects(startFresh({ ...deps, clients: undefined }), /desktop app/);
});

test("reset: this window forgets only My Magic UW's own keys", () => {
  const map = new Map([["magic.onboarding.v2", "{}"], ["magic.appearance.v1", "{}"], ["magic.yourAi.local", "on"], ["other.key", "x"]]);
  const store = { get length() { return map.size; }, key: (i: number) => [...map.keys()][i] ?? null, removeItem: (k: string) => { map.delete(k); } };
  assert.deepEqual(clearAppStorage(store).sort(), ["magic.appearance.v1", "magic.onboarding.v2", "magic.yourAi.local"]);
  assert.deepEqual([...map.keys()], ["other.key"]);
  assert.deepEqual(clearAppStorage(null), []);
});

test("reset: the confirmation lists exactly what is cleared and kept, and Cancel comes first", () => {
  for (const words of ["connects to your AI", "choices", "agreements", "Synced course data", "cache"]) assert.ok(RESET_CLEARS.some((l) => l.includes(words)), words);
  assert.ok(RESET_KEEPS.some((l) => /sign-ins in Claude Code, Codex/.test(l) && /live in those apps/.test(l)));
  assert.ok(RESET_KEEPS.some((l) => /Word or Google Docs/.test(l)));
  assert.ok(RECONFIGURE_KEEPS.some((l) => /courses, notes, sign-ins, agreements and sharing choices/.test(l)));
  assert.ok(RECONFIGURE_CLEARS.some((l) => /chosen AI/.test(l)));
  const html = renderToStaticMarkup(React.createElement(StartFresh, { disabled: false, onReset: async () => {}, onReconfigure: async () => {} }));
  assert.match(html, /Reset My Magic UW…/);
  assert.match(html, /Re-run setup only…/);
  assert.match(html, /<dialog[^>]*aria-labelledby="reset-title"[^>]*aria-describedby="reset-clears reset-keeps"/);
  for (const line of [...RESET_CLEARS, ...RESET_KEEPS]) assert.ok(html.includes(line.replace(/'/g, "&#x27;")), line);
  const dialog = html.slice(html.indexOf('aria-labelledby="reset-title"'));
  assert.ok(dialog.indexOf(">Cancel<") < dialog.indexOf(">Reset and start over<"), "the safe choice first, and it takes focus");
  // Start fresh sits at the bottom of the page, after the local data section.
  const app = read("apps/desktop/src/renderer/App.tsx");
  assert.ok(app.indexOf("<LocalData ") < app.indexOf("<StartFresh "));
  assert.match(app, /onReset=\{\(\) => startFresh\(\{ clients: window\.magic\.clients, run \}\)/);
});

test("connected accounts and local data: plain status words", async () => {
  assert.equal(uwStatus({ sources: [] }), "not_connected");
  assert.equal(uwStatus({ sources: [{ kind: "canvas", status: "needs_sign_in" }] as never }), "signed_out");
  assert.equal(uwStatus({ sources: [{ kind: "canvas", status: "ok" }] as never }), "signed_in");
  assert.equal(sizeWords(12_400_000), "12.4 MB");
  assert.equal(sizeWords(3_000), "3 KB");
  const dir = mkdtempSync(join(tmpdir(), "local-data-"));
  try {
    writeFileSync(join(dir, "workspace.sqlite"), "x".repeat(100));
    mkdirSync(join(dir, "documents", "a"), { recursive: true });
    writeFileSync(join(dir, "documents", "a", "f.pdf"), "y".repeat(50));
    writeFileSync(join(dir, "Cookies"), "z".repeat(1000));
    assert.equal(await localDataBytes(dir), 150, "the app's own data only, not the browser's files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("copy: the page's words carry no internal names", () => {
  const app = read("apps/desktop/src/renderer/App.tsx");
  const page = app.slice(app.indexOf("function Privacy("), app.indexOf("// end owner: data-ai"));
  const jsxText = [...page.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]!.trim()).filter(Boolean);
  assert.ok(jsxText.length > 15 && jsxText.some((t) => t.includes("See exactly what was sent")), "the scan reads the page's text");
  const html = [
    renderToStaticMarkup(React.createElement(StartFresh, { disabled: false, onReset: async () => {}, onReconfigure: async () => {} })),
    renderToStaticMarkup(React.createElement(SharingChoice, { privacy: defaultPrivacy, disabled: false, onChange: () => {} })),
    renderToStaticMarkup(React.createElement(YourAiChoice, { privacy: hosted, busy: false, onChange: () => {}, onSignIn: () => {}, openExternal: () => {} })),
  ].join(" ").replace(/<[^>]+>/g, " ");
  const sections = read("apps/desktop/src/renderer/data-ai/sections.tsx");
  const sectionText = [...sections.matchAll(/>([^<>{}]+)</g), ...sections.matchAll(/"([A-Z][^"]{6,})"/g)].map((m) => m[1]!);
  const copy = [
    ...jsxText, html, ...sectionText,
    ...SHARE_ROWS.flatMap((r) => [r.label, r.line]), PLANNING_ROW.label, PLANNING_ROW.line, ...Object.values(JEV_COPY),
    ...SHARING_OPTIONS.flatMap((o) => [o.label, o.sentence]), SEPARATE_SIGN_IN.label, SEPARATE_SIGN_IN.sentence,
    ...RESET_CLEARS, ...RESET_KEEPS, ...RECONFIGURE_CLEARS, ...RECONFIGURE_KEEPS,
  ].join("\n");
  for (const banned of [/\bJev\b/i, /\bpacks?\b/i, /\bscopes?\b/i, /\bmodes?\b/i, /\bTypeSafe\b/, /\bgateway\b/i, /\bselective\b/i, /\blocal[_ ]only\b/i, /\bhostedProvider\b/])
    assert.doesNotMatch(copy, banned, String(banned));
});
