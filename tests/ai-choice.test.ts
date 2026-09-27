// "Your AI" and "Before sharing course data": one choice of who answers, and when the payload preview
// shows, mapped exactly onto the existing privacy preferences. The send gate itself is unchanged
// (egress and consent tests cover it); these check the mapping and that the old panels are gone.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultPrivacy } from "@magic/contracts";
import { SHARING_OPTIONS, sharingOf, sharingPatch } from "../apps/desktop/src/renderer/ai-choice/sharing";
import { SharingChoice } from "../apps/desktop/src/renderer/ai-choice/SharingChoice";
import { YourAiChoice, aiChoicePatch } from "../apps/desktop/src/renderer/ai-choice/YourAiChoice";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const hosted = { ...defaultPrivacy, mode: "selective_cloud" as const, hostedProvider: "claude" as const };

test("before sharing: first time is today's default, every time is always-preview, and 'don't ask' cannot be chosen", () => {
  assert.equal(sharingOf(defaultPrivacy), "first_time");
  assert.equal(sharingOf({ alwaysPreview: undefined }), "first_time", "stored preferences without the field");
  assert.equal(sharingOf({ alwaysPreview: true }), "every_time");
  assert.deepEqual(sharingPatch(defaultPrivacy, "every_time"), { alwaysPreview: true });
  assert.deepEqual(sharingPatch({ alwaysPreview: true }, "first_time"), { alwaysPreview: false });
  assert.equal(sharingPatch(defaultPrivacy, "first_time"), null, "no change, no save");
  assert.equal(sharingPatch(defaultPrivacy, "never"), null, "the send gate always previews a new sensitive kind");
  assert.deepEqual(SHARING_OPTIONS.map((o) => [o.label, o.available]), [
    ["Ask the first time for each kind", true], ["Ask every time", true], ["Don't ask; follow my settings", false],
  ]);
  for (const option of SHARING_OPTIONS) assert.ok(option.sentence.split(/[.:;] /).length <= 3 && option.sentence.length < 170, option.id);
  const html = renderToStaticMarkup(React.createElement(SharingChoice, { privacy: { ...defaultPrivacy, alwaysPreview: true }, disabled: false, onChange: () => {} }));
  assert.equal((html.match(/type="radio"/g) ?? []).length, 3);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 1);
  assert.match(html, /selected-mode"><input type="radio"[^>]*checked=""[^>]*\/><span><strong>Ask every time/);
});

test("your AI: a hosted choice selects it with cloud access on; Ollama and Off both clear the hosted AI", () => {
  assert.deepEqual(aiChoicePatch(defaultPrivacy, "claude"), { hostedProvider: "claude", mode: "selective_cloud" });
  assert.deepEqual(aiChoicePatch({ ...hosted, mode: "local_only" }, "claude"), { hostedProvider: "claude", mode: "selective_cloud" });
  assert.equal(aiChoicePatch(hosted, "claude"), null);
  assert.deepEqual(aiChoicePatch(hosted, "codex"), { hostedProvider: "codex", mode: "selective_cloud" });
  assert.deepEqual(aiChoicePatch(hosted, "local"), { hostedProvider: "none" });
  assert.deepEqual(aiChoicePatch(hosted, "off"), { hostedProvider: "none" });
  assert.equal(aiChoicePatch(defaultPrivacy, "off"), null);
  const html = renderToStaticMarkup(React.createElement(YourAiChoice, { privacy: hosted, busy: false, onChange: () => {} }));
  for (const name of ["Claude Code", "Codex", "Off"]) assert.ok(html.includes(`<strong>${name}</strong>`), name);
  assert.ok(!html.includes("Ollama</strong>"), "Ollama shows only once found");
  assert.ok(!html.includes("Gemini</strong>"), "Gemini shows once ready or chosen");
});

test("the item page asks through chat: no per-item local panel, no recipient picker; the preview follows who answers", () => {
  const app = read("apps/desktop/src/renderer/App.tsx");
  for (const gone of ["Ask locally", "Data preview", "Preview data", "Preferred AI", "<LocalAiPanel", 'htmlFor="recipient"']) assert.ok(!app.includes(gone), gone);
  assert.match(app, /<h3>Before sharing course data<\/h3>/);
  assert.match(app, /See what would be sent/);
  assert.match(app, /const recipient: Recipient = answeringChoice === "local" \|\| answeringChoice === "off" \? "local" : answeringChoice;/);
  assert.match(app, /<section className="settings-section" id="your-ai">/);
  const panel = read("apps/desktop/src/renderer/LocalAiPanel.tsx");
  assert.ok(!panel.includes("localAsk"), "the setup helper never asks a question itself");
});

test("onboarding's chosen client becomes Your AI only once every agreement it needs is current", () => {
  const onboarding = read("apps/desktop/src/renderer/onboarding/Onboarding.tsx");
  assert.match(onboarding, /const next = \{ \.\.\.snapshot\.privacy, hostedProvider: id, mode: "selective_cloud" as const \};\n\s+if \(!missingConsents\(next, snapshot\.consents\)\.length\) await run\(\{ type: "privacy", value: next \}\);/);
});
