// The client-model course extractor and the `course.facts` job: the egress path (grant, scrub with quotes
// mapped back, receipt, preview), exact-span quotes, the once-per-syllabus-change cache, the local
// fallback and section chunking. Synthetic course text only.
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { captureBatchSchema, defaultPrivacy, type CourseExtractionBatch } from "@magic/contracts";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { createModelRunner, RunnerError, type BackendCall } from "../packages/runner/src/index";
import { egressFor } from "../packages/core/src/egress";
import {
  COURSE_FACTS_JOB,
  callGroups,
  createCourseFactsJob,
  runCourseFacts,
  sectionChunks,
} from "../packages/core/src/course-facts/index";
import { memoryArtifactStore, memoryLedgerStore } from "../packages/packs/core/src/index";

const course = { accountScope: "account-private", courseId: "c" };
const syllabus = [
  "Course Syllabus",
  "AI Policy",
  "Jo Park may use AI tools only for brainstorming.",
  "Grading",
  "Essays 40%",
  "Exams",
  "The midterm is October 20.",
].join("\n");
let tick = 0;
function ingest(store: ReturnType<typeof createStore>, text: string) {
  store.ingest(
    captureBatchSchema.parse({
      source: { id: "pages", kind: "fixture", label: "pages", scope: "pages", ...course },
      observedAt: new Date(Date.parse("2026-09-26T12:00:00Z") + tick++ * 1000).toISOString(),
      status: "ok",
      complete: true,
      resources: [{ externalId: "syl", kind: "material", courseId: "c", courseName: "Synthetic Philosophy", title: "Course Syllabus", url: "https://canvas.example.edu/courses/c/pages/syllabus", text }],
    }),
  );
}
function setup(options: { mode?: "local_only" | "selective_cloud" } = {}) {
  const store = createStore(":memory:");
  store.setPrivacy({ ...defaultPrivacy, mode: options.mode ?? "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  store.setConsent!({ action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION }, "2026-09-26T12:00:00Z");
  store.recordAutoIdentity({ accountScope: course.accountScope, courseId: "c", authors: ["Jo Park"] });
  ingest(store, syllabus);
  const calls: BackendCall[] = [];
  let respond: (call: BackendCall) => unknown = () => ({
    facts: [
      { kind: "ai_policy", sourceId: "s0", quote: "[STUDENT_1] may use AI tools only for brainstorming.", label: "AI use" },
      { kind: "grading", sourceId: "s0", quote: "Essays 40%", label: "Grade weights" },
      { kind: "assessment", sourceId: "s0", quote: "The midterm is on Mars.", label: "Invented" },
      { kind: "topic", sourceId: "s0", quote: "STUDENT_1] may use", label: "Splits a placeholder" },
    ],
  });
  const runner = createModelRunner({
    backend: {
      client: "claude",
      async call(call) {
        calls.push(call);
        return { value: respond(call), usage: { in: 10, cached: 0, out: 10 }, model: "synthetic" };
      },
    },
  });
  const artifacts = memoryArtifactStore();
  const ledger = memoryLedgerStore();
  const deps = { runner: () => runner, artifacts, ledger, now: () => new Date("2026-09-27T12:00:00Z") };
  const profile = () => store.courseIntelligence().find((p) => p.courseId === "c")!;
  return { store, calls, deps, profile, respond: (fn: typeof respond) => void (respond = fn) };
}

test("client route: scrubbed call with a receipt; exact quotes mapped back; invented and split quotes dropped", async () => {
  const x = setup();
  const run = await runCourseFacts(x.store, course, x.deps);
  assert.equal(run.route, "client");
  assert.equal(run.status, "applied");
  assert.equal(x.calls.length, 1);
  assert.ok(!JSON.stringify(x.calls).includes("Jo Park"), "the student's name never leaves");
  assert.ok(x.calls[0]!.input.includes("[STUDENT_1] may use AI tools"));
  const receipt = x.store.receipts().find((r) => r.status === "sent" && r.recipient === "claude")!;
  assert.match(receipt.purpose, /course facts/);
  assert.deepEqual(receipt.resourceIds, run.syllabusResourceIds);
  const p = x.profile();
  const model = p.claims.filter((c) => c.method === "client_model");
  assert.deepEqual(model.map((c) => [c.kind, c.value]).sort(), [
    ["ai_policy", "Jo Park may use AI tools only for brainstorming."],
    ["grading", "Essays 40%"],
  ]);
  for (const c of model) {
    const e = c.evidence[0]!;
    assert.equal(x.store.resource(e.resourceId)!.text.slice(e.start!, e.end!), e.quote);
    assert.equal(c.policyMode ?? "unknown", "unknown", "a quote is not an interpretation");
  }
  assert.equal(p.extraction?.coverage?.rejectedCandidates, 2);
  assert.equal(p.extraction?.coverage?.status, "partial");
  x.store.close();
});

test("once per syllabus change: an unchanged syllabus is a 0-token cache hit; a change calls again", async () => {
  const x = setup();
  await runCourseFacts(x.store, course, x.deps);
  const again = await runCourseFacts(x.store, course, x.deps);
  assert.equal(x.calls.length, 1);
  assert.equal(again.status, "unchanged");
  ingest(x.store, `${syllabus}\nExams are closed book.`);
  const changed = await runCourseFacts(x.store, course, x.deps);
  assert.equal(changed.status, "applied");
  assert.equal(x.calls.length, 2);
  assert.ok(x.profile().claims.some((c) => c.method === "client_model"));
  x.store.close();
});

test("always preview holds the send for the student; a refused grant is blocked with a receipt", async () => {
  const x = setup();
  x.store.setPrivacy({ ...x.store.privacy(), alwaysPreview: true });
  const held = await runCourseFacts(x.store, course, x.deps);
  assert.equal(held.status, "blocked");
  assert.equal(x.calls.length, 0);
  assert.equal(egressFor(x.store).pending().length, 1);
  x.store.close();

  const y = setup();
  y.store.setConsent!({ action: "revoke", recipient: "claude" }, "2026-09-26T13:00:00Z");
  const refused = await runCourseFacts(y.store, course, y.deps);
  assert.equal(refused.status, "blocked");
  assert.equal(y.calls.length, 0);
  assert.ok(y.store.receipts().some((r) => r.status === "blocked"));
  y.store.close();
});

test("fully local mode (or no client) uses the local extractor with the selected syllabus", async () => {
  const x = setup({ mode: "local_only" });
  let seen: string[] | undefined;
  const local = {
    version: "course-extraction.local.v1",
    async extract(input: { inputHash: string; syllabusResourceIds?: string[] }): Promise<CourseExtractionBatch> {
      seen = input.syllabusResourceIds;
      return { inputHash: input.inputHash, extractorVersion: "course-extraction.local.v1:m:d", candidates: [] };
    },
  };
  const run = await runCourseFacts(x.store, course, { ...x.deps, local });
  assert.equal(run.route, "local");
  assert.equal(x.calls.length, 0);
  assert.deepEqual(seen, run.syllabusResourceIds);
  assert.equal(seen?.length, 1);
  x.store.close();
});

test("the course.facts job retries a paused (usage limit) run and finishes a blocked one", async () => {
  const x = setup();
  x.respond(() => {
    throw new RunnerError("usage_limit");
  });
  const job = createCourseFactsJob(x.deps);
  assert.equal(job.kind, COURSE_FACTS_JOB);
  const context = { store: x.store, now: () => "2026-09-27T12:00:00Z", signal: new AbortController().signal };
  const fake = { subjectId: "account-private:c" } as never;
  assert.equal((await job.run(fake, context)).status, "retry");
  x.store.setPrivacy({ ...x.store.privacy(), alwaysPreview: true });
  assert.equal((await job.run(fake, context)).status, "done");
  x.store.close();
});

test("chunks: at most 40k characters per call, split between sections, offsets exact", () => {
  const sections = Array.from({ length: 20 }, (_, i) => `Grading\n${`Section ${i} line of policy text. `.repeat(160)}`);
  const text = sections.join("\n");
  const chunks = sectionChunks({ id: "r", contentHash: "h", text });
  assert.ok(chunks.length >= 3);
  for (const c of chunks) {
    assert.ok(c.text.length <= 40_000);
    assert.equal(text.slice(c.start, c.start + c.text.length), c.text);
    assert.ok(c.start === 0 || c.text.startsWith("Grading"), "a chunk starts at a section heading");
  }
  assert.equal(chunks.map((c) => c.text).join("").replace(/\s/g, "").length, text.replace(/\s/g, "").length);
  const long = `Intro\n${"A paragraph of prose that keeps going. ".repeat(40)}\n\n`.repeat(80);
  const split = sectionChunks({ id: "r", contentHash: "h", text: long });
  assert.ok(split.every((c) => c.text.length <= 40_000 && long.slice(c.start, c.start + c.text.length) === c.text));
  assert.ok(callGroups(split).every((g) => g.reduce((n, c) => n + c.text.length, 0) <= 40_000));
});
