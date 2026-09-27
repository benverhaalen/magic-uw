// owner: client-health (D50). The remediation component renders every health state with its
// plain cause, the exact next step and the actions that step needs.
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ClientHealth, ClientHealthState, ClientId, ClientMode } from "../packages/contracts/src/index.ts";
import { ClientHealthNotice } from "../apps/desktop/src/renderer/onboarding/ClientHealthNotice.tsx";
import { healthCopy } from "../apps/desktop/src/renderer/onboarding/health-copy.ts";

const states: ClientHealthState[] = ["installed", "not_installed", "not_signed_in", "plan_insufficient", "usage_limited", "model_unavailable", "offline", "ok"];
const health = (id: ClientId, state: ClientHealthState, mode: ClientMode = id === "gemini" ? "api_key" : "instant", extra: Partial<ClientHealth> = {}): ClientHealth => ({
  id,
  state,
  mode,
  source: "status",
  instant: { available: mode === "instant" },
  modes: id === "gemini" ? ["api_key"] : ["instant", "isolated"],
  checkedAt: "2026-09-27T00:00:00.000Z",
  ...extra,
});
const noop = () => undefined;
const handlers = {
  onQuickChat: async () => "session",
  onCheckAgain: noop,
  onSwitch: noop,
  onUseProfile: noop,
  onAddKey: noop,
  openExternal: noop,
};
const render = (h: ClientHealth, props: Partial<Parameters<typeof ClientHealthNotice>[0]> = {}) =>
  renderToStaticMarkup(createElement(ClientHealthNotice, { health: h, ...handlers, ...props }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

test("every state renders its title, cause and next step, marked with the state", () => {
  for (const id of ["claude", "codex"] as const)
    for (const state of states) {
      const h = health(id, state);
      const html = render(h);
      const copy = healthCopy(h, { chat: true });
      assert.match(html, new RegExp(`data-health-state="${state}"`));
      assert.ok(text(html).includes(copy.title), `${id}/${state}: ${copy.title}`);
      assert.ok(text(html).includes(copy.cause), `${id}/${state}: cause`);
      if (state !== "ok") assert.ok(text(html).includes(copy.next), `${id}/${state}: next step`);
      assert.match(html, state === "ok" ? /role="status"/ : copy.tone === "problem" ? /role="alert"/ : /role="status"/);
    }
});

test("the plan notice says exactly what to do, with the provider's own upgrade page", () => {
  const claude = text(render(health("claude", "plan_insufficient")));
  assert.match(claude, /Claude Code needs a Pro or Max plan, or an API key/);
  assert.match(claude, /Upgrade your plan, or switch to Codex\./);
  assert.match(render(health("claude", "plan_insufficient")), /claude\.ai/);
  const codex = text(render(health("codex", "plan_insufficient")));
  assert.match(codex, /switch to Claude Code\./);
  assert.match(render(health("codex", "plan_insufficient")), /chatgpt\.com/);
});

test("a usage limit shows the reset time the client stated, or says it didn't", () => {
  assert.match(text(render(health("claude", "usage_limited", "instant", { resetsAt: "3pm (America/Chicago)" }))), /resets 3pm \(America\/Chicago\)/);
  assert.match(text(render(health("codex", "usage_limited"))), /didn't say when/);
});

test("Quick chat is offered where checking the account helps, and never for Gemini", () => {
  for (const state of ["installed", "plan_insufficient", "model_unavailable"] as const)
    assert.match(render(health("claude", state)), /Quick chat/, state);
  assert.doesNotMatch(render(health("claude", "offline")), /Quick chat/);
  assert.doesNotMatch(render(health("gemini", "not_signed_in")), /Quick chat/);
  assert.doesNotMatch(render(health("claude", "installed"), { onQuickChat: undefined }), /Quick chat/);
});

test("signed out: instant mode points to the app's own profile; Gemini asks for a key", () => {
  const instant = text(render(health("claude", "not_signed_in", "instant")));
  assert.match(instant, /Sign in here/);
  assert.match(instant, /your settings stay as they are/);
  const gemini = text(render(health("gemini", "not_signed_in")));
  assert.match(gemini, /Paste an API key/);
  assert.match(gemini, /Google AI Studio/);
});

test("compact ok is one line; nothing renders a button without its handler", () => {
  const html = renderToStaticMarkup(createElement(ClientHealthNotice, { health: health("claude", "ok", "instant", { plan: "max" }), compact: true }));
  assert.match(text(html), /Signed in with Max\. Your own Claude Code, as it is\./);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(ClientHealthNotice, { health: health("codex", "not_installed") })), /<button/);
});
