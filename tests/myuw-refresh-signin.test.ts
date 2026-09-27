// owner: onboarding-recovery (My UW refresh). Synthetic planning source rows and fake bridges only:
// no UW responses, accounts, sessions, Electron window or browser. Main's reuse is exercised with
// the real singleFlight and bringSignInForward composed as main composes them (openSignIn).
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CommandResult, PlanningSourceHealth, SignInOutcome, SignInService, Snapshot, StoredPlanningRecord } from "@magic/contracts";
import { projectMyUw, refreshOutcome } from "../apps/desktop/src/renderer/myuw/model";
import { progressText, refreshPlanningWithSignIn, signInNeeded, type RefreshProgress } from "../apps/desktop/src/renderer/myuw/refresh-flow";
import { singleFlight } from "../apps/desktop/src/keep-signed-in";
import { bringSignInForward } from "../apps/desktop/src/sign-in-foreground";

Object.assign(globalThis, { React });
registerHooks({ load: (url, context, next) => url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context) });
const { RefreshStep } = await import("../apps/desktop/src/renderer/myuw/RefreshStep");

const account = "uw-account:synthetic";
// Relative to now: the page's freshness horizon uses the real clock.
let clock = Date.now() - 60 * 60_000;
const earlier = new Date(clock - 60 * 60_000).toISOString();
const tick = () => new Date((clock += 1000)).toISOString();

type Row = { id: string; source: PlanningSourceHealth["source"]; key: string; kind?: PlanningSourceHealth["scope"]["kind"] };
const ROWS: Row[] = [
  { id: "enroll-login", source: "uw_enroll", key: "connection:student-info", kind: "student_record" },
  { id: "audit", source: "uw_dars", key: "saved-audits", kind: "audit_program" },
  { id: "myuw", source: "uw_myuw", key: "connection:myuw-session", kind: "student_record" },
];
function row(r: Row, fields: Partial<PlanningSourceHealth> = {}): PlanningSourceHealth {
  return { id: r.id, source: r.source, accountScope: account, scope: { kind: r.kind ?? "student_record", key: r.key }, sourceUrl: "https://enroll.wisc.edu/",
    status: "complete", completeness: "complete", observedAt: earlier, lastSuccessAt: earlier, diagnostics: [], ...fields };
}
const savedAudit = { id: "audit", kind: "audit", localId: "audit:audit", sourceId: "audit", accountScope: account, contentHash: "x", version: 1, deleted: false,
  provenance: { sourceUrl: "https://enroll.wisc.edu/", observedAt: earlier, scope: { kind: "audit_program", key: "saved-audits" } },
  programKey: "synthetic", generatedAt: earlier, catalogTerm: null, coverage: "complete", nodes: [] } as unknown as StoredPlanningRecord;

/** A fake store: saved rows persist; each read re-observes every private source with the session's answer. */
function world(session: { enroll: "ok" | "expired"; myuw: "ok" | "expired" | "forbidden" }, extra: Partial<Record<string, Partial<PlanningSourceHealth>>> = {}) {
  let sources = ROWS.map((r) => row(r));
  const records = [savedAudit];
  const snapshot = (): Snapshot => ({ planning: { records, sources } } as unknown as Snapshot);
  const read = (): CommandResult => {
    const at = tick();
    sources = ROWS.map((r) => {
      const state = r.source === "uw_myuw" ? session.myuw : session.enroll;
      const answer: Partial<PlanningSourceHealth> = state === "ok"
        ? { status: "complete", completeness: "complete", lastSuccessAt: at, diagnostics: [] }
        : state === "forbidden"
          ? { status: "blocked", completeness: "unknown", diagnostics: [{ code: "forbidden", message: "Forbidden." }] }
          : { status: "blocked", completeness: "unknown", diagnostics: [{ code: r.source === "uw_myuw" ? "unauthorized" : "login_redirect", message: "Saved records remain available but need verification." }] };
      const previous = sources.find((s) => s.id === r.id)!;
      return { ...previous, ...answer, ...extra[r.id], observedAt: at, lastSuccessAt: answer.lastSuccessAt ?? previous.lastSuccessAt };
    });
    return { snapshot: snapshot() } as CommandResult;
  };
  const before = () => Object.fromEntries(sources.map((s) => [s.id, s.observedAt]));
  return { session, snapshot, read, before };
}

function bridge(w: ReturnType<typeof world>, answer: (service: SignInService) => Promise<SignInOutcome>) {
  const calls: string[] = [];
  return {
    calls,
    syncPlanning: async () => (calls.push("read"), w.read()),
    signInUW: async (service?: SignInService) => (calls.push(`signin:${service}`), answer(service!)),
  };
}

test("existing auth works: Refresh reads in the background with visible progress and opens no window", async () => {
  const w = world({ enroll: "ok", myuw: "ok" });
  const b = bridge(w, async () => assert.fail("no window when UW answers"));
  const seen: RefreshProgress[] = [];
  const before = w.before();
  const result = await refreshPlanningWithSignIn(b, before, (update) => seen.push(update));
  assert.deepEqual(b.calls, ["read"]);
  assert.deepEqual(seen, [{ stage: "reading", after: null }]);
  assert.match(progressText(seen[0]), /^Reading Course Search & Enroll, My UW and your degree audits/);
  const outcome = refreshOutcome(before, projectMyUw(result!.snapshot).sources);
  assert.equal(outcome.current, outcome.checked);
});

test("expired auth: the app's UW window opens, the student finishes (Duo is theirs), and the read resumes", async () => {
  const w = world({ enroll: "expired", myuw: "expired" });
  const b = bridge(w, async () => {
    // The human finishes sign-in in the window; UW now answers for both services (one UW login).
    w.session.enroll = "ok"; w.session.myuw = "ok";
    return { status: "confirmed", service: "enroll" };
  });
  const seen: RefreshProgress[] = [];
  const before = w.before();
  const result = await refreshPlanningWithSignIn(b, before, (update) => seen.push(update));
  assert.deepEqual(b.calls, ["read", "signin:enroll", "read"], "one window, then the read resumes");
  assert.deepEqual(seen.map((s) => s.stage), ["reading", "signin", "reading"]);
  assert.match(progressText(seen[1]), /sign in to Course Search & Enroll\. Finish in the UW window, including Duo/);
  assert.match(progressText(seen[2]), /^Signed in to Course Search & Enroll\. Reading your UW records again/);
  assert.equal(projectMyUw(result!.snapshot).state, "current");
});

test("My UW still expired after the Enroll sign-in gets its own window once; nothing loops", async () => {
  const w = world({ enroll: "expired", myuw: "expired" });
  const b = bridge(w, async (service) => {
    if (service === "enroll") w.session.enroll = "ok"; // My UW's own session stays expired
    return { status: "confirmed", service };
  });
  const result = await refreshPlanningWithSignIn(b, w.before(), () => {});
  assert.deepEqual(b.calls, ["read", "signin:enroll", "read", "signin:myuw", "read"]);
  assert.deepEqual(signInNeeded({}, result!.snapshot), ["myuw"], "still said: My UW needs sign-in");

  const stuck = world({ enroll: "expired", myuw: "ok" });
  const again = bridge(stuck, async (service) => ({ status: "confirmed", service }));
  await refreshPlanningWithSignIn(again, stuck.before(), () => {});
  assert.deepEqual(again.calls, ["read", "signin:enroll", "read"], "a service is asked once per Refresh, never in a loop");
});

test("closing the UW window stops the refresh; saved records stay; Refresh again opens a fresh window", async () => {
  const w = world({ enroll: "expired", myuw: "ok" });
  const b = bridge(w, async (service) => ({ status: "cancelled", service }));
  const seen: RefreshProgress[] = [];
  const before = w.before();
  const result = await refreshPlanningWithSignIn(b, before, (update) => seen.push(update));
  assert.deepEqual(b.calls, ["read", "signin:enroll"], "no read after the window was closed");
  const stopped = seen.at(-1)!;
  assert.equal(stopped.stage, "stopped");
  assert.match(progressText(stopped), /closed before Course Search & Enroll confirmed sign-in\. Saved records are unchanged; Refresh to try again\./);
  const model = projectMyUw(result!.snapshot);
  assert.equal(model.audits.length, 1, "the saved audit is still shown");
  assert.equal(model.audits[0].staleReason, "unconfirmed", "…and marked as needing verification, not current");
  const outcome = refreshOutcome(before, model.sources);
  assert.ok(outcome.current < outcome.checked && outcome.problems.length > 0, "never all complete");

  await refreshPlanningWithSignIn(b, w.before(), () => {});
  assert.deepEqual(b.calls.slice(2), ["read", "signin:enroll"], "retry asks again");

  const failed = bridge(world({ enroll: "expired", myuw: "ok" }), async () => { throw new Error("Sign-in requires your interaction; headless mode will not open a window."); });
  const last: RefreshProgress[] = [];
  await refreshPlanningWithSignIn(failed, {}, (update) => last.push(update));
  assert.match(progressText(last.at(-1)!), /headless mode will not open a window\. Saved records are unchanged\./);
});

test("partial failure without a sign-in problem opens nothing and names the unread sources", async () => {
  const w = world({ enroll: "ok", myuw: "forbidden" }, { audit: { status: "failed", completeness: "unknown", diagnostics: [{ code: "refresh_failed", message: "x" }] } });
  const b = bridge(w, async () => assert.fail("forbidden or failed reads are not sign-in"));
  const before = w.before();
  const result = await refreshPlanningWithSignIn(b, before, () => {});
  assert.deepEqual(b.calls, ["read"]);
  const outcome = refreshOutcome(before, projectMyUw(result!.snapshot).sources);
  assert.deepEqual(outcome.problems.map((s) => s.state).sort(), ["blocked", "failed"]);
  assert.equal(projectMyUw(result!.snapshot).audits.length, 1, "saved audit kept through a failed read");
});

test("only sources read in this refresh count: an older blocked row opens nothing", () => {
  const w = world({ enroll: "ok", myuw: "ok" });
  const stale = { planning: { records: [], sources: [row(ROWS[0], { status: "blocked", diagnostics: [{ code: "unauthorized", message: "x" }] })] } } as unknown as Snapshot;
  assert.deepEqual(signInNeeded({ "enroll-login": earlier }, stale), []);
  assert.deepEqual(signInNeeded({}, stale), ["enroll"]);
  assert.deepEqual(signInNeeded({}, w.snapshot()), []);
});

test("a second request while the UW window is open brings that window forward; it is never duplicated", async () => {
  // Main's openSignIn: `if (signInFlight.pending) bringSignInForward(signIn); return signInFlight.run(() => signInWindow(...))`.
  const flight = singleFlight<boolean>();
  const log: string[] = [];
  let created = 0, close!: (confirmed: boolean) => void;
  let current: { minimized: boolean } | null = null;
  const win = {
    isDestroyed: () => current === null,
    isMinimized: () => current?.minimized ?? false,
    restore: () => { log.push("restore"); current!.minimized = false; },
    show: () => log.push("show"),
    focus: () => log.push("focus"),
  };
  const openSignIn = () => {
    if (flight.pending) bringSignInForward(win);
    return flight.run(() => { created++; current = { minimized: false }; return new Promise<boolean>((resolve) => (close = (ok) => { current = null; resolve(ok); })); });
  };
  const first = openSignIn();
  await Promise.resolve();
  current!.minimized = true; // the student minimized it
  const second = openSignIn(); // "Show UW window", or Refresh from another page
  assert.equal(created, 1);
  assert.deepEqual(log, ["restore", "show", "focus"]);
  close(true);
  assert.deepEqual(await Promise.all([first, second]), [true, true], "both callers get the one window's answer");
  assert.equal(bringSignInForward(null), false);
  openSignIn();
  await Promise.resolve();
  assert.equal(created, 2, "after it closed, the next request opens a new one");
});

test("rendered status: each stage's text in the page's status region, the window button only while waiting", () => {
  const render = (step: RefreshProgress | null, pending: boolean, canSignIn = true) =>
    renderToStaticMarkup(createElement(RefreshStep, { step, pending, canSignIn, show: () => {} }));
  assert.equal(render(null, true), "");
  assert.match(render({ stage: "reading", after: null }, true), /Reading Course Search &amp; Enroll, My UW and your degree audits…/);
  const waiting = render({ stage: "signin", service: "enroll" }, true);
  assert.match(waiting, /Finish in the UW window, including Duo/);
  assert.match(waiting, /<button type="button" class="myuw-quiet">Show UW window<\/button>/);
  assert.doesNotMatch(render({ stage: "signin", service: "enroll" }, true, false), /Show UW window/, "no window button without the desktop bridge");
  assert.match(render({ stage: "reading", after: "myuw" }, true), /Signed in to My UW\. Reading your UW records again…/);
  assert.equal(render({ stage: "reading", after: null }, false), "", "progress clears when the refresh ends");
  assert.match(render({ stage: "stopped", service: "enroll", outcome: { status: "cancelled", service: "enroll" } }, false), /Saved records are unchanged; Refresh to try again\./);
});

test("contract: the real planning sync marks an expired UW session with the codes Refresh keys on", async () => {
  const { syncUwPlanning } = await import("../packages/connectors/src/uw-planning-sync");
  const expired = (code: string) => ({ status: "needs_sign_in" as const, code, bytes: 0, elapsedMs: 0, schemaVerified: false as const });
  const result = await syncUwPlanning({
    accountSeed: "synthetic-installation-seed-0000000000000000",
    http: { read: async (request) => request.kind === "public-terms" || request.kind === "subjects-map" ? { status: "ok" as const, data: {}, bytes: 0, elapsedMs: 0, schemaVerified: false as const } : expired(request.kind === "myuw-session" ? "unauthorized" : "login_redirect") },
  });
  const codes = Object.fromEntries(result.invalidated.map((row) => [row.source, `${row.status}:${row.code}`]));
  assert.deepEqual(codes, { uw_myuw: "blocked:unauthorized", uw_enroll: "blocked:login_redirect", uw_dars: "blocked:login_redirect" });
  // The worker writes each invalidated code into the source row's diagnostics (worker.ts refreshPlanning).
  const at = new Date(Date.now() + 1000).toISOString();
  const rows = result.invalidated.map((row, i) => ({ ...ROWS[i % ROWS.length], id: `r${i}`, source: row.source }))
    .map((r, i) => row(r as Row, { status: result.invalidated[i].status, observedAt: at, diagnostics: [{ code: result.invalidated[i].code, message: "x" }] }));
  assert.deepEqual(signInNeeded({}, { planning: { records: [], sources: rows } } as unknown as Snapshot), ["enroll", "myuw"]);
});
