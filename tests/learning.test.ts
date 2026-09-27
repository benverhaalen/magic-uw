import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema, type LearningSession, type LearningSessionRepository, type LearningActivity, type LearningSource } from "@magic/contracts";
import { createLearningService, eligibleLearningSource, type LearningBackendPorts } from "../apps/desktop/src/learning-service";
import { buildExplanationRequest, payloadDigest } from "../packages/packs/learning-session";
import fixture from "../fixtures/course.json";
const batch = captureBatchSchema.parse(fixture);
/** Synthetic repository implements the projection's optimistic-write contract only.
 * These tests do not claim integration with Nate's unpublished v7 repository. */
function syntheticRepository(): LearningSessionRepository {
  const sessions = new Map<string, LearningSession>();
  return {
    learningSession: id => structuredClone(sessions.get(id)),
    learningSessions: resourceId => [...sessions.values()].filter(s => s.resourceId === resourceId).map(s => structuredClone(s)),
    putLearningSession(session, expected) {
      const previous = sessions.get(session.id);
      assert.equal(previous?.revision ?? null, expected);
      assert.equal(session.revision, expected === null ? 0 : expected + 1);
      if (previous) assert.deepEqual(session.events.slice(0, previous.events.length), previous.events);
      sessions.set(session.id, structuredClone(session));
    },
  };
}
function setup() {
  const store = createStore(":memory:");
  store.ingest({ ...batch, resources: [...batch.resources, { externalId: "permitted-material", kind: "material", courseId: batch.source.courseId, courseName: "Synthetic course", title: "Concepts", url: "https://canvas.wisc.edu/courses/1/pages/concepts", text: "Evidence supports a claim. Explain the relationship between a claim and its supporting observation.", deadlines: [] }] });
  const resource = store.resources().find(r => r.kind === "assignment")!;
  const material = store.resources().find(r => r.externalId === "permitted-material")!;
  const core = createCore(store, { fixture: batch });
  const context = { context: (id: string, recipient: "local") => ({ ...core.context(id, recipient), resourceIds: [resource.id, material.id] }) };
  const sessions = syntheticRepository(), items = new Map<string, LearningActivity>();
  let selections = 0, packCalls = 0, gradeCalls = 0;
  let seenSources: LearningSource[] = [];
  function item(sources: LearningSource[], format: LearningActivity["format"] = "practice") {
    seenSources = sources;
    const source = sources.find(s => s.resourceId === material.id)!;
    const quote = source.text.slice(0, 24), id = `synthetic-item-${++selections}`;
    const activity: LearningActivity = { id, model: "synthetic-prepared", digest: "fixture-v1", createdAt: "2026-09-26T12:00:00Z", format, title: "Evidence", content: "Consider a fresh example.", prompt: `Which observation supports claim ${selections}?`, reason: "The supplied material introduces evidence.", citations: [{ resourceId: source.resourceId, contentHash: source.contentHash, quote, start: 0, end: quote.length }] };
    items.set(id, activity); return activity;
  }
  const ports: LearningBackendPorts = {
    sessions,
    study: { selectPrepared: i => item(i.sources), hint: id => ({ text: "Look for an observation.", citations: items.get(id)!.citations }), grade: ({ activityId, answer }) => { gradeCalls++; return { text: `Synthetic check inspected ${answer.length} characters; no readiness claim.`, citations: items.get(activityId)!.citations }; } },
    packs: { explain: async request => {
      packCalls++;
      const sources = request.payload.sources.map(s => ({ ...s, observedAt: "2026-09-26T12:00:00Z", url: "https://example.org", complete: false, status: "ok" }));
      return { activity: item(sources, "explanation"), requestHash: request.payloadHash, receipt: { id: "synthetic-receipt", payloadHash: request.payloadHash, status: "sent" } };
    } },
  };
  const service = createLearningService(store, context, ports);
  const start = (mode: "practice" | "explain" = "practice", operationId: string = mode) => service.start("request", { resourceId: resource.id, inputHash: resource.contentHash, operationId, mode });
  return { store, resource, material, context, ports, service, start, counts: () => ({ packCalls, gradeCalls }), sources: () => seenSources };
}

test("missing canonical bindings fail explicitly; constructing the service adds no tables or model calls", async () => {
  const f = setup(), service = createLearningService(f.store, f.context);
  assert.throws(() => service.list(f.resource.id), /not connected in this build/);
  await assert.rejects(service.start("s", { resourceId: f.resource.id, inputHash: f.resource.contentHash, operationId: "start" }), /not connected in this build/);
  assert.equal("learningSession" in f.store, false); f.store.close();
});

test("prepared answer, hint, skip, next and resume never invoke a model or explanation pack", async () => {
  const f = setup(); let state = await f.start();
  state = f.service.saveDraft({ sessionId: state.session.id, revision: state.session.revision, draft: "My draft" });
  assert.equal(f.service.get(state.session.id).session.draft, "My draft");
  state = await f.service.act("h", { sessionId: state.session.id, revision: state.session.revision, operationId: "h", action: "hint" });
  const request = { sessionId: state.session.id, revision: state.session.revision, operationId: "a", action: "answer" as const, answer: "学".repeat(4000) };
  state = await f.service.act("a", request);
  assert.equal(state.session.events.find(e => e.kind === "answer")?.text, request.answer);
  assert.equal(state.session.events.find(e => e.kind === "answer")?.assistance, "hinted");
  assert.ok(state.session.events.at(-1)?.citations?.length);
  await f.service.act("retry", request); assert.equal(f.counts().gradeCalls, 1);
  state = await f.service.act("n", { sessionId: state.session.id, revision: state.session.revision, operationId: "n", action: "next" });
  state = await f.service.act("skip", { sessionId: state.session.id, revision: state.session.revision, operationId: "skip", action: "skip" });
  const resumed = createLearningService(f.store, f.context, f.ports).get(state.session.id);
  assert.deepEqual(resumed.session.events, state.session.events);
  assert.equal(f.counts().packCalls, 0); assert.equal(f.store.attempts().length, 0); f.store.close();
});

test("explicit explanation alone invokes pack, requires receipt and excludes student history", async () => {
  const f = setup();
  const state = await f.start("explain"); assert.equal(f.counts().packCalls, 1);
  assert.equal(state.session.events[0].assistance, "exposed");
  f.ports.study.grade = () => undefined;
  const saved = await f.service.act("reflect", { sessionId: state.session.id, revision: state.session.revision, operationId: "reflect", action: "answer", answer: "My reflection" });
  assert.match(saved.session.events.at(-1)!.text, /remains ungraded/);
  assert.equal(f.counts().packCalls, 1);
  f.ports.packs.explain = async () => ({ activity: state.session.activities[0], requestHash: "bad", receipt: { id: "", payloadHash: "bad", status: "sent" } });
  await assert.rejects(f.start("explain", "bad-receipt"), /receipt/); f.store.close();
});

test("open or ambiguously closed assignments are excluded; submission alone does not close work", () => {
  const f = setup(), r = f.resource, at = Date.parse("2026-09-26T12:00:00Z");
  assert.equal(eligibleLearningSource({ ...r, deadlines: [] }, at), false);
  assert.equal(eligibleLearningSource({ ...r, kind: "message" }, at), false);
  assert.equal(eligibleLearningSource({ ...r, kind: "event" }, at), false);
  assert.equal(eligibleLearningSource({ ...r, deadlines: [{ kind: "due", value: "2026-09-25T12:00:00Z", authority: "structured", quote: "", scopeConfirmed: true }] }, at), true);
  assert.equal(eligibleLearningSource({ ...r, deadlines: [{ kind: "due", value: "2026-09-25T12:00:00Z", authority: "structured", quote: "", scopeConfirmed: true }, { kind: "lock", value: "2026-10-01T12:00:00Z", authority: "structured", quote: "", scopeConfirmed: true }] }, at), false);
  f.store.close();
});

test("stale evidence preserves drafts and blocks actions; cancellation rejects a late explanation", async () => {
  const f = setup(); const state = await f.start();
  f.store.ingest({ ...batch, complete: false, status: "partial", observedAt: "2026-09-28T12:00:00Z", resources: batch.resources.map(r => ({ ...r, text: r.text + " Changed" })) });
  assert.equal(f.service.get(state.session.id).availability, "stale");
  assert.equal(f.service.saveDraft({ sessionId: state.session.id, revision: state.session.revision, draft: "Preserved" }).session.draft, "Preserved");
  await assert.rejects(f.service.act("h", { sessionId: state.session.id, revision: 1, operationId: "h", action: "hint" })); f.store.close();
  const second = setup(), original = second.ports.packs.explain;
  let release!: () => void;
  second.ports.packs.explain = async (request, signal) => { await new Promise<void>(resolve => { release = resolve; }); return original(request, signal); };
  const pending = second.start("explain"); second.service.cancel(); release(); await assert.rejects(pending);
  assert.equal(second.ports.sessions.learningSessions(second.resource.id).length, 0); second.store.close();
});

test("pack budget counts maximal Unicode bytes, preserves full goal and exposes only sent excerpts", () => {
  for (const char of ["x", "学", "😀"]) {
    const sources: LearningSource[] = Array.from({ length: 6 }, (_, i) => ({ resourceId: `r${i}`, contentHash: "hash", title: char.repeat(160), text: char.repeat(2100), observedAt: "2026-09-26T12:00:00Z", url: "https://example.org", status: "ok", complete: true }));
    const goal = char.repeat(char === "😀" ? 500 : 1000);
    const request = buildExplanationRequest({ accountScope: "private", courseId: "course" }, goal, "unknown", sources);
    assert.ok(Buffer.byteLength(JSON.stringify(request.payload)) <= 10000);
    assert.equal(request.payload.goal, goal); assert.ok(request.payload.sources.length);
    assert.equal(request.payloadHash, payloadDigest(request.payload));
    assert.ok(!JSON.stringify(request.payload).includes("private"));
    assert.equal("answer" in request.payload, false); assert.equal("observations" in request.payload, false);
  }
});

test("planned repeat across sessions is allowed and marked exposed; current-session duplicate is rejected", async () => {
  const f = setup(); const first = await f.start();
  const repeated = first.session.activities[0];
  f.ports.study.selectPrepared = () => repeated;
  let next = await f.start("practice", "planned-repeat");
  assert.equal(next.session.events[0].assistance, "exposed");
  next = await f.service.act("answer", { sessionId: next.session.id, revision: next.session.revision, operationId: "answer", action: "answer", answer: "Seen before" });
  assert.equal(next.session.events.find(e => e.kind === "answer")?.assistance, "exposed");
  const duplicate = await f.service.act("next", { sessionId: next.session.id, revision: next.session.revision, operationId: "next", action: "next" });
  assert.equal(duplicate.session.activities.length, 1); assert.equal(duplicate.session.events.at(-1)?.kind, "failure");
  f.store.close();
});

test("restricted policy blocks ports and excluded access blocks historical reads", async () => {
  const f = setup(), state = await f.start();
  const restricted = createLearningService(f.store, { context: (id, recipient) => {
    const manifest = f.context.context(id, recipient); return { ...manifest, effectivePolicy: { ...manifest.effectivePolicy!, mode: "restricted" } };
  } }, f.ports);
  await assert.rejects(restricted.start("blocked", { resourceId: f.resource.id, inputHash: f.resource.contentHash, operationId: "blocked", mode: "explain" }), /policy/);
  assert.equal(f.counts().packCalls, 0);
  const excluded = createLearningService(f.store, { context: (id, recipient) => ({ ...f.context.context(id, recipient), allowed: false, reason: "Course excluded" }) }, f.ports);
  assert.throws(() => excluded.get(state.session.id), /excluded/); f.store.close();
});

test("open-assignment source never reaches prepared or explanation inputs; foreign and fabricated citations fail", async () => {
  const f = setup();
  // Force a no-date assignment: submitted state cannot substitute for closure.
  f.store.ingest({ ...batch, complete: false, status: "partial", observedAt: "2026-09-28T12:00:00Z", resources: batch.resources.map(r => ({ ...r, deadlines: [] })) });
  const current = f.store.resource(f.resource.id)!;
  const request = { resourceId: current.id, inputHash: current.contentHash, operationId: "new" };
  const state = await f.service.start("new", request);
  assert.ok(f.sources().every(s => s.resourceId !== current.id));
  assert.ok(f.sources().some(s => s.resourceId === f.material.id));
  f.ports.study.selectPrepared = () => ({ ...state.session.activities[0], id: "bad", prompt: "New question", citations: [{ ...state.session.activities[0].citations[0], resourceId: current.id }] });
  await assert.rejects(f.service.start("bad", { ...request, operationId: "bad" }), /citations/);
  f.store.close();
});

test("canonical scrubbed wire receipts bind separately to the original request", async () => {
  const f = setup(), original = f.ports.packs.explain;
  f.ports.packs.explain = async (request, signal) => {
    const result = await original(request, signal);
    return { ...result, receipt: { ...result.receipt, payloadHash: "different-scrubbed-wire-payload-hash" } };
  };
  const state = await f.start("explain"); assert.equal(state.session.activities.length, 1);
  f.ports.packs.explain = async (request, signal) => ({ ...await original(request, signal), requestHash: "wrong-request" });
  await assert.rejects(f.start("explain", "wrong-request"), /receipt/); f.store.close();
});
