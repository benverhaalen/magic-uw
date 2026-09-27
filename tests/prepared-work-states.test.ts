import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ResourceView, WorkLaunchReceipt, WorkSet } from "@magic/contracts";
import {
  launchLabel, noticeLine, outcomeFromError, outcomeFromReceipt, pageViewApplies, retryableIds, sendingOutcome, slotView, summaryLine, type LaunchOutcome,
} from "../apps/desktop/src/renderer/prepared-work/launch-model";
import { getEntry, patchEntry, putOutcome, resetStore } from "../apps/desktop/src/renderer/prepared-work/session-store";
import type { PreparedWorkController } from "../apps/desktop/src/renderer/prepared-work/usePreparedWork";

// packages/ui has its own tsconfig without react-jsx, so tsx compiles it with classic JSX.
Object.assign(globalThis, { React });
// The component imports its stylesheets; Node has no CSS loader, so they load as empty modules here.
registerHooks({ load: (url, context, next) => url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context) });
const { WorkView } = await import("../apps/desktop/src/renderer/prepared-work/PreparedWork");

const UW = "https://canvas.wisc.edu/courses/1";
const set: WorkSet = {
  previewHash: "a".repeat(64), assignmentId: "essay", assignmentTitle: "Essay 2", contentHash: "c",
  items: [
    { resourceId: "slides", title: "Week 3 slides", role: "material", reason: "Linked from the assignment.", target: { kind: "file", path: "/docs/x", extension: ".pdf", fallbackUrl: `${UW}/files/1` } },
    { resourceId: "reading", title: "Reading", role: "material", reason: "Accepted match.", target: { kind: "web", url: "https://example.org/reading" } },
    { resourceId: "essay", title: "Essay 2", role: "instructions", reason: "Assignment instructions and submission page.", target: { kind: "web", url: `${UW}/assignments/1` } },
  ],
  held: [], notes: [],
};
const updated: WorkSet = { ...set, previewHash: "b".repeat(64), items: set.items.slice(1) };
const receipt = (patch: Partial<WorkLaunchReceipt>): WorkLaunchReceipt => ({
  assignmentId: "essay", assignmentTitle: "Essay 2", at: "2026-09-27T15:42:00Z", mode: "opened", opened: [], failed: [], held: [], notes: [], ...patch,
});
const wrap = (message: string) => new Error(`Error invoking remote method 'magic:start-work': Error: ${message}`);
const CHANGED = "Prepared work changed. Review the updated destinations before opening.";
const resource = { id: "essay", title: "Essay 2" } as ResourceView;

function controller(patch: Partial<PreparedWorkController> = {}): PreparedWorkController {
  const current = patch.set === undefined ? set : patch.set;
  const outcome = patch.outcome ?? null;
  const earlier = !!(outcome && current && outcome.previewHash !== current.previewHash);
  return {
    prepare: current ? { kind: "ready", set: current } : { kind: "loading" }, set: current, outcome, earlier, pending: false, canLaunch: !!current, returnedAt: null,
    failedIds: outcome && !earlier ? retryableIds(outcome) : [],
    launch: async () => {}, retryFailed: () => {}, refresh: () => {}, dismiss: () => {}, acknowledgeReturn: () => {},
    ...patch,
  } as PreparedWorkController;
}
Object.assign(globalThis, { window: { magic: { startWork: async () => receipt({}) } } });

const summary = createElement("span", { className: "home-work-summary" }, createElement("span", { className: "home-work-name" }, "Essay 2"), createElement("span", { className: "home-work-due" }, "Tomorrow"));
const trailing = createElement("a", { className: "home-work-details", href: "#/resource/essay", "aria-label": "Details: Essay 2" });
function tile(work: PreparedWorkController, extra: { onSetup?: () => void; onInspect?: () => void; action?: boolean } = {}) {
  const props = extra.action ? { action: true } : { compact: { className: "tone-1", summary, description: "Course 101, due Tomorrow 5 PM", trailing } };
  return renderToStaticMarkup(createElement(WorkView, { resource, refreshKey: "r", work, anchor: extra.action ? "start-essay" : "work-essay", onInspect: extra.onInspect ?? (() => {}), onSetup: extra.onSetup, ...props }));
}
function detail(work: PreparedWorkController, onSetup?: () => void) {
  return renderToStaticMarkup(createElement(WorkView, { resource, refreshKey: "r", work, anchor: "start-work-essay", onSetup }));
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/** Every tile state keeps one slot, beside the target and before the trailing control, with nothing below the card. */
function assertStableTile(html: string) {
  assert.equal(html.match(/home-work-status-slot/g)?.length, 1, "exactly one reserved slot");
  const card = html.indexOf("home-work-card"), button = html.indexOf("</button>"), slot = html.indexOf("home-work-status-slot"), details = html.indexOf("home-work-details");
  assert.ok(card < button && button < slot && slot < details, "order: card > target, slot, trailing");
  // No control nested in the launch target.
  const target = html.slice(html.indexOf("<button"), button);
  assert.doesNotMatch(target.slice(1), /<button|<a |<details/, "launch target contains no nested control");
  assert.doesNotMatch(html, /magic-prepared__outcome|magic-start-work__receipt/, "no outcome sibling paragraphs");
  assert.equal(html.match(/role="status"/g)?.length, 1, "the only live status is inside the slot");
  const after = html.slice(html.lastIndexOf("</div>") + 6);
  assert.doesNotMatch(after, /<p|<ul/, "nothing rendered below the card");
}
const slotText = (html: string) => text(html.slice(html.indexOf("home-work-status-slot"), html.indexOf('<a class="home-work-details')).replace(/^[^>]*>/, ""));

test("cross-surface: a busy reply while this list is still sending never replaces the in-flight outcome", () => {
  const sending = sendingOutcome(set, null);
  const busy = outcomeFromError(set, wrap("Prepared work is already opening."), sending);
  assert.equal(busy, sending, "the in-flight outcome is kept as is");
  assert.match(summaryLine(busy), /^Sending 3 items/);
  assert.doesNotMatch(summaryLine(busy), /Nothing was sent/);
  // The shared flag every surface reads while one of them launches.
  resetStore();
  putOutcome("essay", sending, { launching: true });
  assert.equal(getEntry("essay")?.launching, true);
  putOutcome("essay", outcomeFromReceipt(set, receipt({ opened: set.items.map(item => ({ resourceId: item.resourceId, title: item.title, via: "browser" as const })) })), { launching: false });
  assert.equal(getEntry("essay")?.launching, false);
  // The second surface renders the shared pending state, not an enabled launch.
  const html = tile(controller({ outcome: sending, pending: true }));
  assertStableTile(html);
  assert.match(html, /aria-busy="true"/);
  assert.equal(slotText(html), "Sending…");
});

test("hash change partway through a receipt: reload, no retry of the dead list, earlier sends stay visible", () => {
  const first = outcomeFromReceipt(set, receipt({
    opened: [{ resourceId: "reading", title: "Reading", via: "browser" }],
    failed: [{ resourceId: "slides", title: "Week 3 slides", reason: CHANGED }, { resourceId: "essay", title: "Essay 2", reason: CHANGED }],
  }));
  assert.equal(first.problem?.kind, "changed", "a changed receipt is a reload signal, not a retryable failure");
  assert.deepEqual(retryableIds(first), [], "no per-row retry for a list that no longer exists");
  // Before the reload lands: no retry offered on the tile or the detail rows.
  assert.doesNotMatch(tile(controller({ outcome: first })), /Retry|Try again/);
  assert.doesNotMatch(detail(controller({ outcome: first })), /Try sending/);
  // After the reload: the new list is on screen and the earlier sends remain readable.
  const after = controller({ set: updated, outcome: first });
  const html = tile(after);
  assertStableTile(html);
  assert.match(html, /aria-label="Review updated list: Essay 2"/, "the tile routes to review instead of re-sending Reading");
  assert.match(text(html), /Earlier attempt sent Reading\./);
  assert.match(slotText(html), /^Changed Review/);
  const page = text(detail(after));
  assert.match(page, /Earlier attempt sent Reading\./);
  assert.match(page, /Week 3 slides|Reading/, "updated rows are listed, not dropped");
});

test("return is acknowledged by the surface that showed it and never scrolls on mount", () => {
  resetStore();
  putOutcome("essay", outcomeFromReceipt(set, receipt({ opened: [{ resourceId: "essay", title: "Essay 2", via: "browser" }] })), { returnedAt: "2026-09-27T15:50:00Z" });
  patchEntry("essay", { returnedAt: null });
  assert.equal(getEntry("essay")?.returnedAt, null, "acknowledged cue does not return on the next visit");
  const source = readFileSync(new URL("../apps/desktop/src/renderer/prepared-work/PreparedWork.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /scrollIntoView/, "no component scroll can override Back's restored place");
  assert.match(source, /useEffect\(\(\) => \(\) => work\.acknowledgeReturn\(\), \[\]\)/, "acknowledged on leaving the surface");
});

test("rendered tile states replace the status in place with a short remedy and inspectable details", () => {
  const partial = outcomeFromReceipt(set, receipt({
    opened: [{ resourceId: "slides", title: "Week 3 slides", via: "browser_fallback" }, { resourceId: "essay", title: "Essay 2", via: "browser" }],
    failed: [{ resourceId: "reading", title: "Reading", reason: "Only ordinary web links can be opened." }],
    notes: ["Week 3 slides: opened the original because the saved copy is no longer on this device."],
  }));
  const states: Record<string, { html: string; slot: RegExp }> = {
    idle: { html: tile(controller()), slot: /^$/ },
    retry: { html: tile(controller({ outcome: partial })), slot: /^1 not sent Retry 1/ },
    unknown: { html: tile(controller({ outcome: outcomeFromError(set, new Error("Render frame was disposed"), null) })), slot: /^Not sure/ },
    fallback: { html: tile(controller({ outcome: outcomeFromReceipt(set, receipt({ opened: [{ resourceId: "slides", title: "Week 3 slides", via: "browser_fallback" }, { resourceId: "reading", title: "Reading", via: "browser" }, { resourceId: "essay", title: "Essay 2", via: "browser" }], notes: ["Week 3 slides: opened the original because the saved copy is no longer on this device."] })) })), slot: /^Sent/ },
    setup: { html: tile(controller({ outcome: outcomeFromError(set, wrap("Finish the setup step before My Magic UW connects to UW."), null) }), { onSetup: () => {} }), slot: /^Needs setup Finish setup/ },
    busy: { html: tile(controller({ outcome: outcomeFromError(set, wrap("Prepared work is already opening."), null) })), slot: /^Busy Try again/ },
    unavailable: { html: tile(controller({ set: null, prepare: { kind: "error", problem: { kind: "unknown", message: "Magic could not prepare this work.", raw: "IPC timeout after 30000ms" } } })), slot: /^Unavailable/ },
  };
  for (const [name, { html, slot }] of Object.entries(states)) {
    assertStableTile(html);
    assert.match(slotText(html), slot, name);
    const visible = text(html.slice(html.indexOf("home-work-status-slot"), html.search(/<details|<a class="home-work-details/)).replace(/^[^>]*>/, ""));
    assert.doesNotMatch(visible, /opened|loaded|\bdone\b|complete/i, `${name}: the visible state never claims open or done`);
  }
  assert.match(states.idle!.html, /magic-prepared-slot__marks/, "idle slot shows destination marks");
  assert.match(states.retry!.html, /aria-label="1 not sent\. Try it again"/);
  assert.match(text(states.retry!.html), /Reading: Not sent: only ordinary web links can be opened\./);
  assert.match(text(states.unknown!.html), /Magic could not confirm what opened/);
  assert.match(text(states.unknown!.html), /Technical detail: Render frame was disposed/, "raw error only inside details");
  assert.doesNotMatch(slotText(states.unknown!.html), /Try again|Retry|Open all/, "unknown offers no one-click resend that could duplicate tabs");
  assert.match(text(states.fallback!.html), /Week 3 slides: Sent the original to your browser\./);
  assert.doesNotMatch(states.setup!.html, /Refresh destinations/, "setup never offers a useless refresh");
  assert.doesNotMatch(states.setup!.html, /role="note"/, "setup with a route shows no details that only repeat it");
  const noRoute = tile(controller({ outcome: outcomeFromError(set, wrap("Finish the setup step before My Magic UW connects to UW."), null) }));
  assert.match(slotText(noRoute), /^Needs setup$/);
  assert.doesNotMatch(noRoute, /Refresh destinations|Finish setup<\/button>/);
  assert.match(states.unavailable!.html, /aria-label="View assignment: Essay 2"/, "a failed preparation routes to the saved detail");
  assert.match(text(states.unavailable!.html), /Technical detail: IPC timeout after 30000ms/);
  assert.match(slotText(states.unavailable!.html), /^Unavailable Retry/);
  for (const html of Object.values(states).map(state => state.html)) {
    const panel = html.slice(html.indexOf('role="note"'));
    assert.doesNotMatch(panel.slice(0, panel.indexOf("</details>")), /<button/, "info panels carry phrasing only, no buttons");
  }
});

test("rendered detail: flat rows, one fallback line, setup route, conditional Canvas disclosure", () => {
  const fallback = outcomeFromReceipt(set, receipt({
    opened: [{ resourceId: "slides", title: "Week 3 slides", via: "browser_fallback" }, { resourceId: "essay", title: "Essay 2", via: "browser" }],
    failed: [{ resourceId: "reading", title: "Reading", reason: "Only ordinary web links can be opened." }],
    notes: ["Week 3 slides: opened the original because the saved copy is no longer on this device."],
  }));
  const page = text(detail(controller({ outcome: fallback })));
  assert.equal(page.match(/Saved copy not used/g)?.length, 1, "fallback reason stated once");
  assert.equal(page.match(/Sent the original to your browser/g)?.length, 1);
  assert.match(page, /Try again/, "real per-row failure keeps its inline retry");
  assert.match(page, /Canvas may record a page view\./);
  const web: WorkSet = { ...set, items: [{ ...set.items[1]! }, { ...set.items[2]!, target: { kind: "web", url: "https://canvas.example.edu/a/1" } }] };
  assert.doesNotMatch(text(detail(controller({ set: web }))), /page view/, "no Canvas disclosure without a UW Canvas target or fallback");
  const setup = detail(controller({ set: null, prepare: { kind: "error", problem: { kind: "setup", message: "Finish the UW connection setup step before Magic opens course pages.", raw: "" } } }), () => {});
  assert.match(setup, /Finish setup/);
  assert.doesNotMatch(setup, /Refresh destinations/);
  const css = readFileSync(new URL("../apps/desktop/src/renderer/prepared-work/PreparedWork.css", import.meta.url), "utf8");
  assert.doesNotMatch(css.match(/\.magic-prepared__list \{[^}]*\}/)![0], /background|surface-raised/, "rows are not an inner card");
});

test("literal action names and shell notice", () => {
  const only: WorkSet = { ...set, items: [set.items[2]!] };
  assert.equal(launchLabel(only), "Open assignment");
  assert.equal(launchLabel({ items: [set.items[0]!] }), "Open PDF");
  assert.equal(launchLabel(set), "Start work");
  assert.match(tile(controller({ set: only })), /aria-label="Open assignment: Essay 2"/);
  const action = tile(controller({ set: only }), { action: true });
  assert.match(action, /Open assignment/);
  assert.doesNotMatch(action, /<small>/, "a single page shows no prepared-work subtitle");
  assert.match(text(tile(controller(), { action: true })), /^Start work Sends 1 PDF, 1 web page and 1 Canvas page/);
  assert.equal(pageViewApplies(set), true);
  const all = outcomeFromReceipt(set, receipt({ opened: set.items.map(item => ({ resourceId: item.resourceId, title: item.title, via: "browser" as const })) }));
  assert.equal(noticeLine(all), "Essay 2: sent 3 items to your browser and apps.");
  assert.equal(noticeLine(outcomeFromReceipt(set, receipt({ opened: [{ resourceId: "essay", title: "Essay 2", via: "browser" }] }))), null, "anything unconfirmed stays local, not a notice");
  assert.equal(slotView({ outcome: all, earlier: false, pending: false, prepareError: null, canSetup: false, canReview: false }).text, "Sent");
});

// Keep the stub from leaking into other files in the same process.
test.after(() => { Reflect.deleteProperty(globalThis, "window"); resetStore(); });
export type { LaunchOutcome };
