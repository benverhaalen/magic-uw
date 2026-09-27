import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import {
  captureBatchSchema,
  commandSchema,
  defaultPrivacy,
  learningRequestSchema,
  type Command,
  type LearningRequest,
} from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import fixture from "../fixtures/course.json";
import {
  createJobRegistry,
  enqueueOnSave,
  type JobHandler,
} from "../packages/core/src/jobs/registry";
import { defaultJobRegistry } from "../packages/core/src/jobs/default-registry";
import { createLearningRouter } from "../packages/learning/src/router";

const batch = captureBatchSchema.parse(fixture);

// An unknown Command is a type error: `pnpm check` compiles this file, so the directive below
// fails the check if a variant named "unknown" ever joins the union.
// @ts-expect-error: not a Command variant
const notACommand: Command = { type: "unknown" };
void notACommand;

test("every Command variant has a case in core's switch, which ends in a never check", () => {
  const source = readFileSync("packages/core/src/index.ts", "utf8");
  assert.match(source, /const unhandled: never = command;/);
  const types = commandSchema.options.map((o) => o.shape.type.value);
  for (const type of [
    "map",
    "correct",
    "pack",
    "ui_event",
    "workspace",
    "learning",
  ])
    assert.ok(types.includes(type as never), type);
  for (const type of types)
    assert.ok(source.includes(`case "${type}"`), `core has no case for ${type}`);
  assert.equal(commandSchema.safeParse({ type: "confirm" }).success, false);
  assert.equal(commandSchema.safeParse({ type: "unknown" }).success, false);
});

test("the seam commands parse strictly", () => {
  const ok: unknown[] = [
    { type: "map", courseId: "101" },
    {
      type: "correct",
      value: {
        subject: "scope",
        assessmentId: "a1",
        target: { kind: "module", id: "m1" },
        action: "exclude",
      },
    },
    {
      type: "correct",
      value: { subject: "role", resourceId: "r1", role: "slides", tier: "core" },
    },
    { type: "pack", pack: "course-pass", scope: { courseId: "101" } },
    { type: "ui_event", value: { kind: "expand_all", subject: "course:101" } },
    { type: "workspace", value: { verb: "due", days: 7 } },
    {
      type: "learning",
      request: {
        op: "practice.target",
        courseId: "101",
        topicIds: ["t1"],
        mode: "test",
        count: 10,
      },
    },
    {
      type: "learning",
      request: {
        op: "practice.assessmentQuiz",
        courseId: "101",
        assessmentId: "midterm",
        length: 20,
      },
    },
  ];
  for (const value of ok) assert.ok(commandSchema.safeParse(value).success, JSON.stringify(value));
  const bad: unknown[] = [
    { type: "map", courseId: "101", extra: true },
    { type: "ui_event", value: { kind: "confirm", subject: "x" } },
    { type: "pack", pack: "Bad Name", scope: { courseId: "101" } },
    { type: "learning", request: { op: "practice.unknown", courseId: "101" } },
    {
      type: "learning",
      request: { op: "notebook.ask", courseId: "101", question: "x".repeat(2001) },
    },
    {
      type: "learning",
      request: { op: "practice.assessmentQuiz", courseId: "101", assessmentId: "a", length: 100 },
    },
  ];
  for (const value of bad)
    assert.equal(commandSchema.safeParse(value).success, false, JSON.stringify(value));
});

test("the learning channel reaches the router stub, which answers not_built", async () => {
  const seen: LearningRequest[] = [];
  const stub = createLearningRouter();
  const core = createCore(createStore(":memory:"), {
    fixture: batch,
    seams: {
      learning: {
        handle(request, signal) {
          seen.push(request);
          return stub.handle(request, signal);
        },
      },
    },
  });
  const request = learningRequestSchema.parse({
    op: "practice.assessmentQuiz",
    courseId: "101",
    assessmentId: "midterm",
    length: 12,
  });
  const result = await core.execute({ type: "learning", request });
  assert.deepEqual(seen, [request]);
  assert.equal(result.learning?.op, "practice.assessmentQuiz");
  assert.equal(result.learning?.status, "not_built");
  assert.ok(result.snapshot);
  await core.close();
});

test("absent seams answer honestly and change nothing", async () => {
  const store = createStore(":memory:");
  const core = createCore(store, { fixture: batch });
  const learning = await core.execute({
    type: "learning",
    request: { op: "knowledge.state", courseId: "101" },
  });
  assert.equal(learning.learning?.status, "not_built");
  assert.match((await core.execute({ type: "map", courseId: "101" })).message ?? "", /isn't built/);
  const correction = await core.execute({
    type: "correct",
    value: { subject: "role", resourceId: "r1", role: "reading" },
  });
  assert.match(correction.message ?? "", /nothing was changed/);
  assert.match(
    (await core.execute({ type: "pack", pack: "cards", scope: { courseId: "101" } })).message ?? "",
    /isn't built/,
  );
  const event = await core.execute({
    type: "ui_event",
    value: { kind: "open", subject: "r1" },
  });
  assert.equal(event.message, undefined);
  await core.close();
});

test("a late learning result is discarded after purge", async () => {
  let release!: () => void;
  const core = createCore(createStore(":memory:"), {
    fixture: batch,
    seams: {
      learning: {
        async handle(request, signal) {
          await new Promise<void>((resolve) => {
            release = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { op: request.op, status: "ok" };
        },
      },
    },
  });
  const pending = core.execute({
    type: "learning",
    request: { op: "study.path", courseId: "101" },
  });
  await new Promise((r) => setImmediate(r));
  await core.execute({ type: "purge", confirmation: "DELETE LOCAL DATA" });
  release();
  await assert.rejects(pending, /nothing was kept/);
  await core.close();
});

test("the workspace command resolves due items and open links by code; https only", async () => {
  const store = createStore(":memory:");
  const core = createCore(store, {
    fixture: batch,
    now: () => new Date("2026-09-20T12:00:00Z"),
    // The sample is rebased to the local today (main's fixture-dates); pin the zone.
    timeZone: "America/Chicago",
  });
  await core.execute({ type: "fixture" });
  const assignments = store.resources().filter((r) => r.kind === "assignment");
  assert.ok(assignments.length > 0);
  const due = await core.execute({ type: "workspace", value: { verb: "due", days: 60 } });
  assert.equal(due.workspace?.status, "ok");
  assert.equal(due.workspace?.items?.length, 4);
  assert.equal(due.workspace?.items?.[0]?.dueAt, "2026-09-21T04:59:00.000Z");
  for (const item of due.workspace?.items ?? []) {
    assert.ok(item.dueAt >= "2026-09-20T12:00:00Z");
    assert.ok(Date.parse(item.dueAt) <= Date.parse("2026-11-19T12:00:00Z"));
  }
  const sorted = [...(due.workspace?.items ?? [])].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  assert.deepEqual(due.workspace?.items, sorted);
  const target = store.resources().find((r) => r.url.startsWith("https:"))!;
  const open = await core.execute({
    type: "workspace",
    value: { verb: "open", resourceId: target.id },
  });
  assert.equal(open.workspace?.status, "ok");
  assert.equal(open.workspace?.url, new URL(target.url).href);
  const missing = await core.execute({
    type: "workspace",
    value: { verb: "open", resourceId: "nope" },
  });
  assert.equal(missing.workspace?.status, "unresolved");
  const quiz = await core.execute({
    type: "workspace",
    value: { verb: "quiz", courseId: "101", text: "chapter 3" },
  });
  assert.equal(quiz.workspace?.status, "not_built");
  await core.close();
});

test("the job registry refuses duplicates and bad kinds; stubs are known but never enqueued", () => {
  const registry = defaultJobRegistry();
  assert.deepEqual(registry.kinds().sort(), [
    "card.resource",
    "compile.course",
    "link.resource",
    "passages.resource",
  ]);
  assert.deepEqual(registry.readyKinds(), []);
  assert.throws(() =>
    registry.register({ ...registry.get("card.resource")! }),
  );
  assert.throws(() =>
    createJobRegistry([{ ...registry.get("card.resource")!, kind: "Bad kind" }]),
  );
  const store = createStore(":memory:");
  store.ingest(batch);
  const before = store.jobs().length;
  assert.equal(enqueueOnSave(store, registry, batch.source.id, new Date().toISOString()), 0);
  assert.equal(store.jobs().length, before);
});

test("save → enqueue: a saved capture enqueues each ready kind once per content hash, and the drain runs it", async () => {
  const ran: string[] = [];
  const handler: JobHandler = {
    kind: "passages.resource",
    subject: "resource",
    owner: "test",
    ready: true,
    onSave: (r) => r.kind === "assignment" || r.kind === "material",
    async run(job) {
      ran.push(job.resourceId);
      return { status: "done" };
    },
  };
  const store = createStore(":memory:");
  const core = createCore(store, {
    fixture: batch,
    jobs: createJobRegistry([handler]),
    gateway: {
      async evaluate() {
        throw new Error("offline");
      },
    },
  });
  await core.execute({ type: "fixture" });
  const expected = store
    .resources()
    .filter((r) => r.kind === "assignment" || r.kind === "material").length;
  const queued = () => store.jobs().filter((j) => j.kind === "passages.resource");
  assert.ok(expected > 0);
  assert.equal(queued().length, expected);
  // A re-save of the same content adds nothing: the store keys a job by kind, resource and hash.
  core.saved(batch.source.id);
  assert.equal(queued().length, expected);
  // The drain is gated like Jev today (T10's lease(kinds[]) lifts it); open the gate and it runs.
  await core.execute({
    type: "consent",
    value: { action: "grant", recipient: "jev", disclosureVersion: CONSENT_DISCLOSURE_VERSION },
  });
  await core.execute({
    type: "privacy",
    value: { ...defaultPrivacy, mode: "selective_cloud", jevEnabled: true, shareCourseText: true },
  });
  await core.settled();
  assert.equal(ran.length, expected);
  assert.ok(queued().every((j) => j.status === "done"));
  await core.close();
});
