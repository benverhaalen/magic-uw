// The account avatar and its card: the wizard-head image (kept identical to the team's avatar change so
// the two merge cleanly), the card's facts from the snapshot alone, and which AI answers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultPrivacy, type ClientHealth, type Snapshot, type SourceHealth } from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { accountSummary } from "../apps/desktop/src/renderer/account/summary";
import { AccountCard } from "../apps/desktop/src/renderer/account/AccountCard";
import { aiChoiceOf, answering } from "../apps/desktop/src/renderer/ai-choice/answering";

// Synthetic source health only; no real course or account data.
const NOW = new Date("2026-09-27T15:00:00Z");
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();
const source = (fields: Partial<SourceHealth> = {}): SourceHealth => ({
  id: "canvas:acct:c1:course:canvas", label: "Example Course 101", kind: "canvas", accountScope: "acct", courseId: "c1", scope: "course",
  status: "ok", lastAttemptAt: at(1), lastSuccessAt: at(1), complete: true, resourceCount: 4, ...fields,
});
const snap = (sources: SourceHealth[], extra: Partial<Snapshot> = {}): Snapshot => ({
  resources: [], sources, privacy: defaultPrivacy, links: [], jobs: [], receipts: [], attempts: [], fixtureMode: false,
  gatewayConfigured: false, generatedAt: NOW.toISOString(), ...extra,
});
const agreed = [{ recipient: "claude" as const, disclosureVersion: CONSENT_DISCLOSURE_VERSION, grantedAt: "2026-09-27T12:00:00.000Z" }];
const hosted = { ...defaultPrivacy, mode: "selective_cloud" as const, hostedProvider: "claude" as const };
const health = (patch: Partial<ClientHealth> = {}): ClientHealth => ({
  id: "claude", state: "ok", mode: "instant", source: "status", instant: { available: true }, modes: ["instant", "isolated"], checkedAt: NOW.toISOString(), ...patch,
});

test("the avatar is the marketing wizard head, with the same markup and CSS as the team's avatar change", () => {
  const shell = readFileSync(new URL("../apps/desktop/src/renderer/DesktopShell.tsx", import.meta.url), "utf8");
  assert.match(shell, /const defaultAvatar = new URL\('\.\.\/\.\.\/\.\.\/\.\.\/marketing\/logo\/head-color\.svg', import\.meta\.url\)\.href;/);
  assert.match(shell, /<span className="desktop-avatar" aria-hidden="true"><img src=\{defaultAvatar\} alt=""\/><\/span>/);
  const css = readFileSync(new URL("../apps/desktop/src/renderer/desktop.css", import.meta.url), "utf8");
  assert.match(css, /\/\* Existing marketing wizard head is the default account image, never a title logo\. \*\/\n\.desktop-avatar img \{ width: 28px; height: 30px; object-fit: contain; display: block; \}/);
  assert.ok(readFileSync(new URL("../marketing/logo/head-color.svg", import.meta.url), "utf8").includes("<svg"), "the asset exists");
});

test("the card is a described, non-modal popover: hover and focus open it, Escape closes it, a click still opens settings", () => {
  const shell = readFileSync(new URL("../apps/desktop/src/renderer/DesktopShell.tsx", import.meta.url), "utf8");
  assert.match(shell, /aria-describedby=\{renderAccount \? `\$\{ACCOUNT_CARD_ID\}-name \$\{ACCOUNT_CARD_ID\}-facts`/);
  assert.match(shell, /popover="manual" role="group" aria-label="Account"/);
  assert.match(shell, /onMouseEnter=\{showCard\} onMouseLeave=\{hideCardSoon\} onFocus=\{showCard\} onBlur=\{leaveFocus\} onKeyDown=\{escapeCard\}/);
  assert.match(shell, /event\.key !== 'Escape'/);
  assert.match(shell, /onNavigate\('privacy'\)/);
});

test("nothing connected: not signed in, Canvas not connected, no sources", () => {
  assert.deepEqual(accountSummary(snap([]), NOW), { name: "Your workspace", uw: "Not signed in", canvas: "Not connected", sources: "None yet" });
  assert.equal(accountSummary(snap([], { fixtureMode: true }), NOW).name, "Sample student");
});

test("signed in: the last confirmed sign-in and the Canvas read time come from saved source health", () => {
  const s = accountSummary(snap([source()]), NOW);
  assert.match(s.uw, /^Signed in · last confirmed today at /);
  assert.match(s.canvas, /^Up to date · Checked today at /);
  assert.equal(s.sources, "1 source");
  const ended = accountSummary(snap([source({ status: "needs_sign_in", complete: false, lastSuccessAt: at(30) })]), NOW);
  assert.match(ended.uw, /^Sign in again · last confirmed /);
  assert.match(ended.canvas, /^Sign in again · /);
});

test("which AI answers follows the send gate: selected, cloud on and agreed; mode and plan from client health", () => {
  assert.equal(aiChoiceOf(defaultPrivacy, false), "off");
  assert.equal(aiChoiceOf(defaultPrivacy, true), "local");
  assert.equal(aiChoiceOf({ ...hosted, mode: "local_only" }, false), "off", "cloud off: a hosted AI cannot answer");
  assert.deepEqual(answering(hosted, agreed, false, health({ plan: "max" })), { choice: "claude", ready: true, label: "Claude Code · instant", detail: "Max plan" });
  assert.equal(answering(hosted, [], false, null).ready, false, "no agreement");
  const limited = answering(hosted, agreed, false, health({ state: "usage_limited" }));
  assert.equal(limited.ready, false);
  assert.equal(limited.detail, "Usage limit reached");
  assert.equal(answering(defaultPrivacy, [], true, null).label, "On this computer (Ollama)");
  assert.equal(answering(defaultPrivacy, [], false, null).label, "No AI chosen");
});

test("the card renders every fact and the settings link", () => {
  const html = renderToStaticMarkup(React.createElement(AccountCard, { snapshot: snap([source()], { privacy: hosted, consents: agreed }), open: false, onOpenSettings: () => {} }));
  for (const text of ["Your workspace", "UW sign-in", "Canvas", "Your AI", "Claude Code", "Connected", "1 source", "Data &amp; AI settings"]) assert.ok(html.includes(text), text);
  assert.match(html, /id="desktop-account-card-facts"/);
});
