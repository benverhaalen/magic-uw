// owner: mastery (D57). "Build my strategy": observations by code; one checked call only on the
// student's click; every number the plan uses must appear in an observation it cites; outcome
// predictions are refused; the observations' hash caches it (0 tokens on a repeat); the grades
// category needs the student's sharing permission; hosted payloads are identity-scrubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../packages/storage/src/index";
import { defaultPrivacy } from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { createModelRunner, type BackendCall } from "../packages/runner/src/index";
import { createPackHandler } from "../packages/core/src/pack-handler";
import { memoryArtifactStore } from "../packages/packs/core/src/index";
import { egressFor } from "../packages/core/src/egress";
import { checkStrategy, numbersIn, observationHash, type Observation } from "../packages/learning/src/strategy/index";
import type { StrategyRunResult } from "../packages/packs/strategy/src/index";

const obs: Observation[] = [
  { id: "o1", kind: "group_trend", text: "Labs: slipping since 3 Oct. Your last 3 scores are below your earlier level (typical 94.5 before, 70 since)." },
  { id: "o2", kind: "overlap", text: "2 weak topics (Heaps: Iffy; Tries: Not seen yet) overlap Final exam, due 14 Dec, in Exams (25% of the grade, as listed in Canvas)." },
];

test("the number check: every number must appear in an observation the action cites", () => {
  assert.deepEqual(numbersIn("typical 94.5 before, 70 since; 3 Oct"), [94.5, 70, 3]);
  assert.deepEqual(checkStrategy({ actions: [{ text: "Redo the last 3 labs' mistakes before the next one.", when: "this week", basedOn: ["o1"] }] }, obs), []);
  assert.deepEqual(checkStrategy({ actions: [{ text: "Drill Heaps and Tries; the final is 25% of the grade.", when: "by 14 Dec", basedOn: ["o2"] }] }, obs), []);
  assert.deepEqual(checkStrategy({ actions: [{ text: "Spend 4 hours on labs.", when: "today", basedOn: ["o1"] }] }, obs), ["action 1 uses the number 4, which its observations don't contain"]);
  assert.deepEqual(checkStrategy({ actions: [{ text: "Drill Heaps; the final is 25% of the grade.", when: "soon", basedOn: ["o1"] }] }, obs), ["action 1 uses the number 25, which its observations don't contain"], "a number from an uncited observation fails");
  assert.deepEqual(checkStrategy({ actions: [{ text: "Review labs.", when: "today", basedOn: ["o9"] }] }, obs), ["action 1 cites o9, which is not an observation"]);
  assert.deepEqual(checkStrategy({ actions: [] }, obs), ["the plan has no actions"]);
  assert.equal(observationHash(obs), observationHash(obs.map((o) => ({ ...o }))));
  assert.notEqual(observationHash(obs), observationHash([obs[0]!]));
});

function setup(opts: { shareGrades?: boolean } = {}) {
  const store = createStore(":memory:");
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true, shareGrades: opts.shareGrades ?? true });
  store.setConsent!({ action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION }, "2026-09-26T12:00:00Z");
  store.recordAutoIdentity({ accountScope: "acct", courseId: "C1", authors: ["Jo Park"] });
  const res = (externalId: string, title: string, extra: Record<string, unknown>) => ({
    externalId, kind: "assignment" as const, courseId: "C1", courseName: "Jo Park's algorithms", title, url: `https://canvas.example.test/courses/C1/assignments/${externalId}`,
    text: "", deadlines: [], policy: { mode: "coaching" as const, evidence: "Practice is allowed." }, ...extra,
  });
  const grp = (externalId: string, title: string, weight: number) => ({
    externalId, kind: "material" as const, courseId: "C1", courseName: "Jo Park's algorithms", title, url: "https://canvas.example.test/courses/C1/assignments",
    text: "", deadlines: [], policy: { mode: "unknown" as const, evidence: "" }, assignmentGroup: { weight, position: 1 },
  });
  const day = (d: number) => new Date(Date.UTC(2026, 8, d, 12)).toISOString();
  const labs = [95, 96, 94, 70, 68, 72].map((p, i) => res(`l${i}`, `Lab ${i + 1}`, { points: 20, assignmentGroupId: "gl", dueAt: day(1 + i * 4), submission: { workflowState: "graded", score: (p * 20) / 100, submittedAt: day(1 + i * 4) }, submitted: true }));
  const quizzes = [88, 90, 86, 91, 89, 90].map((p, i) => res(`q${i}`, `Quiz ${i + 1}`, { points: 10, assignmentGroupId: "gq", dueAt: day(2 + i * 4), submission: { workflowState: "graded", score: p / 10, submittedAt: day(2 + i * 4) }, submitted: true }));
  store.ingest({
    source: { id: "s", kind: "canvas", accountScope: "acct", courseId: "C1", scope: "assignments", label: "Assignments" },
    observedAt: "2026-09-26T12:00:00Z", complete: true, status: "ok",
    resources: [grp("gl", "Labs", 60), grp("gq", "Quizzes", 40), ...labs, ...quizzes],
  });
  const calls: BackendCall[] = [];
  let respond: (call: BackendCall) => unknown = () => ({ actions: [] });
  const runner = createModelRunner({
    backend: { client: "claude", async call(call) { calls.push(call); return { value: respond(call), usage: { in: 100, cached: 0, out: 40 }, model: "synthetic" }; } },
  });
  let withRunner = true;
  const handler = createPackHandler({ store, artifacts: memoryArtifactStore(), runner: () => (withRunner ? runner : null), now: () => new Date("2026-09-26T15:00:00Z") });
  const build = async () => (await handler.pack("strategy", { courseId: "C1" }, new AbortController().signal)) as unknown as StrategyRunResult;
  /** The first send of grades to a service waits for the student to review the exact payload. */
  const review = async () => {
    const held = await build();
    assert.equal(held.status, "blocked");
    assert.match(held.message, /First time sharing grades with this service/);
    assert.equal(calls.length, 0);
    const pending = egressFor(store).pending()[0]!;
    egressFor(store).acknowledge({ id: pending.previewId, payloadHash: pending.payloadHash, decision: "send" }, "2026-09-26T15:00:00Z");
  };
  return { store, calls, build, review, respond: (fn: (call: BackendCall) => unknown) => (respond = fn), noRunner: () => (withRunner = false) };
}

test("Build my strategy: grounded in code's observations, number-checked, cached by their hash, scrubbed", async () => {
  const x = setup();
  try {
    let first!: StrategyRunResult;
    x.respond((call) => {
      // The model sees only the observations; answer from the one about labs.
      const labs = /(o\d+): Labs: slipping/.exec(call.input)![1]!;
      return { actions: [{ text: "Rework the last 3 labs before starting the next one.", when: "this week", basedOn: [labs] }] };
    });
    await x.review();
    first = await x.build();
    assert.equal(first.status, "done", first.message);
    assert.equal(x.calls.length, 1);
    assert.ok(first.observations.some((o) => /^Labs: slipping since 13 Sep\. Your last 3 scores are below your earlier level \(typical 95 before, 70 since\)\.$/.test(o.text)), JSON.stringify(first.observations));
    assert.ok(first.observations.some((o) => /^Quizzes: steady across 6 scored items/.test(o.text)));
    assert.equal(first.actions.length, 1);
    assert.equal(first.cached, false);
    assert.ok(first.tokens.in > 0);
    assert.equal(first.receiptIds.length > 0, true, "a receipt for the send");
    for (const call of x.calls) assert.equal(JSON.stringify(call).includes("Jo Park"), false, "identity scrubbed from the hosted payload");
    // The same observations: a cache hit, no second call, 0 tokens.
    const again = await x.build();
    assert.deepEqual([again.status, again.cached, again.tokens, x.calls.length], ["done", true, { in: 0, cached: 0, out: 0 }, 1]);
    assert.equal(again.observationHash, first.observationHash);
    // Without a client, the cached strategy for these observations still answers.
    x.noRunner();
    assert.deepEqual([(await x.build()).status, x.calls.length], ["done", 1]);
  } finally {
    x.store.close();
  }
});

test("a plan with a number no cited observation has, or a prediction, fails the checks after retry and escalation", async () => {
  const x = setup();
  try {
    x.respond(() => ({ actions: [{ text: "Study 4 hours a day and you will get an A.", when: "every day", basedOn: ["o1"] }] }));
    await x.review();
    const r = await x.build();
    assert.equal(r.status, "needs_student");
    assert.ok(x.calls.length >= 2, "retried or escalated before giving up");
    assert.ok(r.checkErrors!.some((e) => /uses the number 4/.test(e)));
    assert.ok(r.checkErrors!.some((e) => /predicts an outcome/.test(e)));
    assert.equal(r.actions.length, 0, "nothing unchecked is shown");
  } finally {
    x.store.close();
  }
});

test("grades need the student's sharing permission; nothing is sent without it", async () => {
  const x = setup({ shareGrades: false });
  try {
    const r = await x.build();
    assert.equal(r.status, "blocked");
    assert.equal(x.calls.length, 0);
    assert.ok(r.observations.length > 0, "the observations themselves are code and still shown");
  } finally {
    x.store.close();
  }
});
