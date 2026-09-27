// Floating chat: press threshold, corner selection and avoidance, keyboard, persistence, placement,
// reduced motion, the wizard state machine and its motion budget, and the wizard asset contract.
// Pure rules only; the element's DOM behaviour is exercised in a headless browser (see README.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  beginPress, cornerForKey, cornerPoint, endPress, launcherKey, movePress, nearestCorner, placePanel, readCorner, readEnabled,
  readIntroSeen, readSize, resizeBy, resizeForKey, snapMotion, writeCorner, writeEnabled, writeIntroSeen, writeSize,
  DEFAULT_CORNER, DRAG_THRESHOLD, PANEL_DEFAULT, PANEL_GAP, PANEL_MAX, PANEL_MIN, STORAGE_KEYS, type KeyValue, type Rect,
} from "../apps/desktop/src/renderer/floating-chat/model";
import { WIZARD_IDLE, WIZARD_MOVING, WIZARD_SHOT_MS, wizardDone, wizardLabel, wizardNext, wizardShotPlan, wizardShown } from "../apps/desktop/src/renderer/floating-chat/rig";
import { ACCENT_IDS, measure, readTokens } from "../scripts/theme-contrast";

const dir = new URL("../apps/desktop/src/renderer/floating-chat/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const view = { width: 1280, height: 800 };
const box = { width: 60, height: 72 };
const header: Rect = { left: 0, top: 0, right: 1280, bottom: 55 };
const sidebar: Rect = { left: 0, top: 55, right: 234, bottom: 790 };
const bar: Rect = { left: 400, top: 740, right: 900, bottom: 784 };

function memory(initial: Record<string, string> = {}): KeyValue & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}
const broken: KeyValue = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); } };

test("a press under 5px is a click; 5px or more is a drag, and a drag stays a drag", () => {
  assert.equal(DRAG_THRESHOLD, 5);
  let p = beginPress({ x: 100, y: 100 });
  p = movePress(p, { x: 103, y: 103.9 });
  assert.equal(endPress(p), "click", "4.9px diagonal is still a click");
  p = movePress(p, { x: 105, y: 100 });
  assert.equal(endPress(p), "drag", "exactly 5px is a drag");
  p = movePress(p, { x: 100, y: 100 });
  assert.equal(endPress(p), "drag", "coming back does not undo a drag");
  assert.equal(endPress(movePress(beginPress({ x: 0, y: 0 }), { x: 0, y: -4 })), "click");
});

test("release picks the nearest window corner by quadrant", () => {
  assert.equal(nearestCorner({ x: 100, y: 100 }, view), "top-left");
  assert.equal(nearestCorner({ x: 1200, y: 90 }, view), "top-right");
  assert.equal(nearestCorner({ x: 300, y: 700 }, view), "bottom-left");
  assert.equal(nearestCorner({ x: 641, y: 401 }, view), "bottom-right");
});

test("corners sit at the inset, beside the sidebar, and step off the header and a bottom bar", () => {
  assert.deepEqual(cornerPoint("bottom-right", view, box, 16), { x: 1204, y: 712 });
  assert.deepEqual(cornerPoint("top-left", view, box, 16), { x: 16, y: 16 });
  const avoid = [header, sidebar];
  assert.deepEqual(cornerPoint("top-right", view, box, 16, avoid), { x: 1204, y: 71 }, "below the header plus inset");
  assert.deepEqual(cornerPoint("top-left", view, box, 16, avoid), { x: 250, y: 71 }, "beside the sidebar, never over its navigation");
  assert.deepEqual(cornerPoint("bottom-left", view, box, 16, avoid), { x: 250, y: 712 });
  const wide: Rect = { left: 200, top: 740, right: 1280, bottom: 790 };
  assert.deepEqual(cornerPoint("bottom-right", view, box, 16, [wide]), { x: 1204, y: 740 - 16 - 72 }, "above a bottom bar");
  assert.deepEqual(cornerPoint("bottom-right", view, box, 16, [bar]), { x: 1204, y: 712 }, "a bar elsewhere does not move it");
  const tiny = cornerPoint("bottom-right", { width: 50, height: 50 }, box, 16);
  assert.ok(tiny.x >= 0 && tiny.y >= 0, "never off-screen in a tiny window");
});

test("keyboard: arrows move between corners, Escape closes only when open, Enter and Space are the button's click", () => {
  assert.equal(cornerForKey("bottom-right", "ArrowLeft"), "bottom-left");
  assert.equal(cornerForKey("bottom-right", "ArrowUp"), "top-right");
  assert.equal(cornerForKey("top-left", "ArrowRight"), "top-right");
  assert.equal(cornerForKey("top-left", "ArrowDown"), "bottom-left");
  assert.equal(cornerForKey("bottom-left", "ArrowLeft"), null, "already on that side");
  assert.deepEqual(launcherKey("ArrowUp", "bottom-left", false), { kind: "move", corner: "top-left" });
  assert.deepEqual(launcherKey("Escape", "bottom-left", true), { kind: "close" });
  assert.equal(launcherKey("Escape", "bottom-left", false), null);
  for (const key of ["Enter", " ", "Tab"]) assert.equal(launcherKey(key, "bottom-right", true), null);
  const src = read("element.ts");
  assert.match(src, /aria-label="Open chat"/);
  assert.match(src, /aria-expanded="false" aria-controls="panel"/);
  assert.match(src, /key !== "Escape" \|\| e\.isComposing/, "Escape from the slotted composer never closes mid-IME");
});

test("the chosen corner, size and first-launch hint persist, and broken storage falls back", () => {
  const s = memory();
  assert.equal(readCorner(s), DEFAULT_CORNER);
  assert.equal(writeCorner(s, "top-left"), true);
  assert.equal(s.data[STORAGE_KEYS.corner], "top-left");
  assert.equal(readCorner(s), "top-left");
  assert.equal(readCorner(memory({ [STORAGE_KEYS.corner]: "middle" })), DEFAULT_CORNER, "unknown value");
  assert.equal(readCorner(broken), DEFAULT_CORNER);
  assert.equal(writeCorner(broken, "top-left"), false);
  assert.equal(writeCorner(null, "top-left"), false);
  writeSize(s, { width: 999.4, height: 100 });
  assert.deepEqual(readSize(s), { width: PANEL_MAX.width, height: PANEL_MIN.height }, "clamped on read");
  assert.deepEqual(readSize(memory({ [STORAGE_KEYS.size]: "{oops" })), PANEL_DEFAULT);
  assert.deepEqual(readSize(broken), PANEL_DEFAULT);
  assert.equal(readIntroSeen(s), false);
  writeIntroSeen(s);
  assert.equal(readIntroSeen(s), true);
  assert.equal(readEnabled(memory()), false, "floating chat defaults off");
  writeEnabled(s, true);
  assert.equal(readEnabled(s), true);
  writeEnabled(s, false);
  assert.equal(readEnabled(s), false);
  assert.equal(readEnabled(broken), false);
});

test("the panel opens from the launcher's corner, grows out of the launcher, and fits between shell regions", () => {
  const dock: Rect = { left: 1204, top: 712, right: 1264, bottom: 784 };
  const p = placePanel("bottom-right", dock, view, PANEL_DEFAULT, 16, [header]);
  assert.equal(p.x + p.width, dock.right, "right edges align");
  assert.equal(p.y + p.height, dock.top - PANEL_GAP, "sits above the launcher");
  assert.equal(p.origin, `${Math.round(1234 - p.x)}px ${Math.round(748 - p.y)}px`, "origin is the launcher's centre");
  const tall = placePanel("bottom-right", dock, view, { width: 380, height: 2000 }, 16, [header]);
  assert.equal(tall.y, 55 + 16, "never under the header");
  const top = placePanel("top-left", { left: 16, top: 71, right: 76, bottom: 143 }, view, PANEL_DEFAULT, 16, [header]);
  assert.equal(top.x, 16);
  assert.equal(top.y, 143 + PANEL_GAP, "below a top launcher");
  const narrow = placePanel("bottom-right", { left: 264, top: 500, right: 324, bottom: 572 }, { width: 340, height: 600 }, PANEL_DEFAULT, 16);
  assert.ok(narrow.x >= 16 && narrow.x + narrow.width <= 324, "stays inside a narrow window");
  const left = placePanel("bottom-left", { left: 250, top: 712, right: 310, bottom: 784 }, view, PANEL_DEFAULT, 16, [header, sidebar]);
  assert.equal(left.x, 250, "a left panel starts beside the sidebar");
  assert.equal(left.y + left.height, 712 - PANEL_GAP, "the sidebar is not a floor or ceiling");
});

test("resizing grows away from the launcher and stays within limits", () => {
  assert.deepEqual(resizeBy("bottom-right", PANEL_DEFAULT, -40, -30), { width: 420, height: 550 }, "grip top-left: up-left grows");
  assert.deepEqual(resizeBy("top-left", PANEL_DEFAULT, 40, 30), { width: 420, height: 550 }, "grip bottom-right: down-right grows");
  assert.deepEqual(resizeBy("bottom-right", PANEL_DEFAULT, 5000, 5000), PANEL_MIN);
  assert.deepEqual(resizeForKey("bottom-left", PANEL_DEFAULT, "ArrowRight"), { width: 404, height: 520 });
  assert.equal(resizeForKey("bottom-left", PANEL_DEFAULT, "Enter"), null);
});

test("reduced motion: snaps are instant, the SVG and shadow styles drop every animation, the state shows as text", () => {
  assert.deepEqual(snapMotion(true), { animate: false, settle: false });
  assert.deepEqual(snapMotion(false), { animate: true, settle: true });
  assert.match(read("wizard.svg"), /@media \(prefers-reduced-motion:reduce\)\{\*\{animation:none!important;transition:none!important\}\}/);
  const shadow = read("element.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const block = shadow.slice(shadow.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(block, /\.panel, \.pill, :host\(\[data-snapping\]\) \.dock \{ transition: none !important; \}/);
  assert.match(block, /\.state:not\(:empty\) \{ display: block; \}/);
  for (const state of ["listening", "thinking", "answered", "error"] as const) assert.ok(wizardLabel(state), state);
  assert.equal(wizardLabel("idle"), null);
});

test("wizard state machine: bases hold, one-shots return to the base, hover never interrupts work", () => {
  let m = WIZARD_IDLE;
  let r = wizardNext(m, "hover");
  assert.equal(r.play, "hover");
  assert.equal(wizardShown(r.model), "hover");
  m = wizardDone(r.model, "hover");
  assert.equal(wizardShown(m), "idle");
  m = wizardNext(m, "thinking").model;
  assert.equal(wizardNext(m, "hover").play, null, "no wave while thinking");
  r = wizardNext(wizardNext(m, "idle").model, "answered");
  assert.equal(wizardShown(r.model), "answered");
  assert.equal(wizardShown(wizardDone(r.model, "answered")), "idle");
  assert.equal(wizardShown(wizardDone(r.model, "error")), "answered", "only the current shot clears");
  const settle = wizardNext(m, "settle");
  assert.equal(settle.play, "settle");
  assert.equal(wizardShown(settle.model), "thinking", "settle never replaces what is shown");
  assert.equal(wizardShown(wizardNext(wizardNext(WIZARD_IDLE, "hover").model, "listening").model), "listening", "a base cancels a wave");
});

test("wizard budget: two parts at most, one-shots at most 1.2s, transforms and opacity only", () => {
  for (const [state, parts] of Object.entries(WIZARD_MOVING)) assert.ok(parts.length <= 2, state);
  for (const ms of Object.values(WIZARD_SHOT_MS)) assert.ok(ms <= 1200);
  for (const shot of ["answered", "error", "settle"] as const) {
    const plan = wizardShotPlan(shot);
    const last = plan.options.duration + ("stagger" in plan ? plan.stagger! * 3 : 0);
    assert.ok(last <= 1200, `${shot} ends by 1.2s`);
    for (const frame of plan.keyframes) for (const key of Object.keys(frame)) assert.ok(["transform", "opacity", "offset", "easing"].includes(key), `${shot} animates ${key}`);
    assert.equal(plan.options.easing, "linear", `${shot}: the ease is per keyframe, so held poses keep their time`);
  }
  const svg = read("wizard.svg");
  for (const body of svg.matchAll(/@keyframes \w+\{(.*?)\}\}/g)) assert.doesNotMatch(body[1]!, /(?:^|[{;])(?!transform|opacity)[a-z-]+:/, body[0]);
  assert.match(svg, /\[data-paused\] \*\{animation-play-state:paused!important\}/, "paused while hidden or blurred");
});

test("wizard asset: small, layered, rigged at the shoulder, token colours only", () => {
  const svg = read("wizard.svg");
  assert.ok(Buffer.byteLength(svg) < 8 * 1024, `${Buffer.byteLength(svg)} bytes`);
  for (const id of ["wizard", "robe", "head", "hat", "beard", "eyes", "moustache", "nose", "arm", "wand-tip", "glow", "sparkles"]) assert.match(svg, new RegExp(`id="${id}"`), id);
  assert.match(svg, /#arm\{transform-origin:0 100%;/, "arm pivots at the shoulder (the fill box's bottom-left)");
  assert.match(svg, /#wizard,#head,#hat,#eyes,#arm,#sparkles,\.s,#glow\{transform-box:fill-box\}/);
  assert.match(svg, /@keyframes wave\{0%,100%\{transform:rotate\(0\)\}25%\{transform:rotate\(-25deg\)\}50%\{transform:rotate\(10deg\)\}75%\{transform:rotate\(-20deg\)\}\}/);
  assert.equal((svg.match(/class="s"/g) ?? []).length, 4, "four sparkles near the wand tip");
  assert.doesNotMatch(svg, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, "no colour literals");
  assert.doesNotMatch(svg.slice(svg.indexOf("<style>") + 7, svg.indexOf("</style>")), /</, "no markup inside the inline style");
  const tokens = readTokens();
  // The hat and robe follow the student's accent (operator decision, September 27): they read
  // --magic-wizard-outfit, which every accent block sets with light and dark values.
  const outfit = new Set(["--magic-wizard-hat", "--magic-wizard-robe"]);
  for (const [, name] of svg.matchAll(/var\((--magic-wizard-[a-z]+)\)/g)) {
    if (outfit.has(name)) assert.match(tokens, new RegExp(`${name}: var\\(--magic-wizard-outfit\\);`), `${name} follows the accent`);
    else assert.match(tokens, new RegExp(`${name}: light-dark\\(#[0-9a-f]{6}, #[0-9a-f]{6}\\);`), `${name} has light and dark values`);
  }
  assert.equal((tokens.match(/--magic-wizard-outfit: light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\);/g) ?? []).length, 4, "every accent sets the wizard outfit");
});

test("floating chat styles use tokens only", () => {
  for (const file of ["element.css", "floating-chat.css"]) {
    const text = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(text, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|:\s*(white|black)\s*[;}!]/, file);
  }
});

test("wizard parts stay distinct (3:1 non-text), and the figure separates from every accent's disc", () => {
  const css = readTokens();
  const parts = [
    { label: "outline on eye", fg: "magic-wizard-line", bg: ["magic-wizard-eye"], need: "ui" as const },
    { label: "outline on beard", fg: "magic-wizard-line", bg: ["magic-wizard-beard"], need: "ui" as const },
    { label: "outline on hat", fg: "magic-wizard-line", bg: ["magic-wizard-hat"], need: "ui" as const },
    { label: "outline on robe", fg: "magic-wizard-line", bg: ["magic-wizard-robe"], need: "ui" as const },
  ];
  // The silhouette meets the disc through its outline (light) or its pale beard and eyes (dark); one must hold.
  const edges = [
    { label: "outline on disc", fg: "magic-wizard-line", bg: ["magic-fill-action", "magic-fill-action-hover"], need: "ui" as const },
    { label: "beard on disc", fg: "magic-wizard-beard", bg: ["magic-fill-action", "magic-fill-action-hover"], need: "ui" as const },
  ];
  const failures: string[] = [];
  for (const accent of ACCENT_IDS) for (const theme of ["light", "dark"] as const) {
    for (const m of measure(css, parts, theme, accent)) if (!m.pass) failures.push(`${theme}/${accent} ${m.label}: ${m.min.toFixed(2)}`);
    const edge = measure(css, edges, theme, accent);
    if (!edge.some((m) => m.pass)) failures.push(`${theme}/${accent} figure edge: ${edge.map((m) => `${m.label} ${m.min.toFixed(2)}`).join(", ")}`);
  }
  assert.deepEqual(failures, []);
});

test("warm-up: a hover warms only when chat already runs on hosted AI without a preview; otherwise the first open, or never", async () => {
  const { chatWarmPolicy } = await import("../apps/desktop/src/renderer/floating-chat/warm");
  const { defaultPrivacy } = await import("@magic/contracts");
  const { CONSENT_DISCLOSURE_VERSION } = await import("@magic/domain");
  const agreed = [{ recipient: "claude" as const, disclosureVersion: CONSENT_DISCLOSURE_VERSION, grantedAt: "2026-09-27T12:00:00.000Z" }];
  const hosted = { ...defaultPrivacy, mode: "selective_cloud" as const, hostedProvider: "claude" as const, shareCourseText: true };
  assert.equal(chatWarmPolicy(hosted, agreed), "hover");
  assert.equal(chatWarmPolicy({ ...hosted, alwaysPreview: true }, agreed), "open", "always-preview: the student opens before anything warms");
  assert.equal(chatWarmPolicy({ ...hosted, shareCourseText: false }, agreed), "open", "course text not shared: an answer cannot run as asked");
  assert.equal(chatWarmPolicy(defaultPrivacy, agreed), "never", "fully local mode");
  assert.equal(chatWarmPolicy({ ...hosted, mode: "local_only" }, agreed), "never");
  assert.equal(chatWarmPolicy({ ...hosted, hostedProvider: "none" }, agreed), "never");
  assert.equal(chatWarmPolicy(hosted, []), "never", "no agreement with the chosen AI");
  assert.equal(chatWarmPolicy(hosted, [{ ...agreed[0]!, disclosureVersion: "setup-2025-01-01" }]), "never", "an outdated agreement");
  assert.equal(chatWarmPolicy({ ...hosted, hostedProvider: "codex" }, agreed), "never", "agreed to a different AI");
});
