// owner: exam-prep. The `problems` pack: the model authors step-by-step problems, hints and a worked
// example; code checks them (recompute, restraint, grounding) and stores them as problems. End to
// end through the same path as the other packs: consent, receipt, the student's (fake) client,
// the cache, then exam.solve serving the stored problem with no model call at study time.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { defaultPrivacy, type CaptureBatch, type LearningRequest, type ResourceInput } from "@magic/contracts";
import { createClaudeBackend, type CliCommand, type ModelRunner } from "../packages/runner/src/index";
import { buildPrompt, createPackRuntime } from "../packages/packs/core/src/index";
import { createPackHandler, type PackRunResult } from "../packages/core/src/pack-handler";
import { problemDrafts, problemsOutputSchema, problemsPack } from "../packages/packs/problems/src/index";
import { createLearningRouter, eligibleStudySource, type StudyContext } from "../packages/learning/src/router";
import { storedProblems } from "../packages/learning/src/exam/problems";
import { createExamEvidence } from "../packages/learning/src/exam/evidence";
import type { ExamSessionData } from "../packages/learning/src/exam/types";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
const TEXT = [
  "A car travels 150 km in 2 h, so its average speed is 75 km/h.",
  "To convert km/h to m/s, multiply by 1000 and divide by 3600.",
].join("\n");
const input = (id: string, kind: ResourceInput["kind"], extra: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId: id,
  kind,
  courseId: "SYN220",
  courseName: "Synthetic Computational Physics",
  title: `Synthetic ${id}`,
  text: TEXT,
  url: `https://canvas.example.test/${id}`,
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "coaching", evidence: "Synthetic: AI help is allowed for practice." },
  ...extra,
});
const batch = (id: string, resources: ResourceInput[]): CaptureBatch => ({
  source: { id, kind: "canvas", accountScope: "acct", courseId: "SYN220", scope: id, label: "Synthetic" },
  observedAt: "2090-01-01T00:00:00.000Z",
  complete: true,
  status: "ok",
  resources,
});

const step = (over: Record<string, unknown>) => ({
  prompt: "Average speed in km/h",
  answerKind: "numeric",
  numeric: { value: 75, unit: "km/h", formula: "150 / 2" },
  symbolic: null,
  text: null,
  nudge: "Divide the distance by the time.",
  workedStep: "150 km / 2 h = 75 km/h",
  explainPrompt: null,
  ...over,
});
const problem = (pid: string, over: Record<string, unknown> = {}) => ({
  stem: "A car travels 150 km in 2 h. Find its average speed in km/h and in m/s.",
  format: "numeric",
  bloom: "apply",
  topics: ["Average speed"],
  section: "Kinematics",
  sourceId: pid,
  quote: "A car travels 150 km in 2 h, so its average speed is 75 km/h.",
  steps: [step({}), step({ prompt: "The same speed in m/s", numeric: { value: 20.83, unit: "m/s", formula: "75 * 1000 / 3600" }, nudge: "A kilometre is 1000 m; an hour is 3600 s.", workedStep: "75 × 1000 / 3600 ≈ 20.83 m/s" })],
  workedExample: ["150 km / 2 h = 75 km/h", "75 km/h × 1000 / 3600 ≈ 20.83 m/s"],
  parsons: null,
  ...over,
});

test("problems pack: the schema is strict; drafts carry the authored problem; a missing answer payload is a structural fault", () => {
  const out = { problems: [problem("p1"), problem("p1", { steps: [step({ numeric: null })] })] };
  assert.equal(problemsOutputSchema.safeParse(out).success, true);
  assert.equal(problemsOutputSchema.safeParse({ problems: [{ ...problem("p1"), extra: 1 }] }).success, false);
  const [ok, bad] = problemDrafts(problemsOutputSchema.parse(out));
  assert.equal(ok!.problem, null);
  assert.equal(ok!.solve.steps.length, 2);
  assert.match(bad!.problem!, /step 1 has no answer of its kind/);
  const p = buildPrompt(problemsPack, { courseId: "a:c", course: "C", skeleton: "Course: C", policy: "" }, { count: 2, sections: [], topics: [], focus: [] }, [{ sourceId: "p1", text: TEXT }]);
  assert.match(p.systemPrompt, /never states the step's answer/);
  assert.ok(p.input.startsWith('<passage id="p1">'));
});

test("problems end to end: consent and receipt, one checked call, code drops a nudge that gives the answer away and a wrong formula; exam.solve serves the rest at 0 tokens", async () => {
  const store = createStore(":memory:");
  const assignments = batch("assignments", [input("target", "assignment", { text: "Synthetic homework prompt.", points: 10 })]);
  store.ingest(assignments);
  store.ingest(batch("materials", [input("reading", "material")]));
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  const reading = store.resources().find((r) => r.externalId === "reading")!;
  const target = store.resources().find((r) => r.externalId === "target")!;
  const pid = `p${store.passages(reading.id)[0]!.pid}`;
  const dir = await mkdtemp(join(tmpdir(), "problems-pack-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const log = join(dir, "log.jsonl");
  const responses = [
    {
      output: {
        problems: [
          problem(pid),
          problem(pid, { stem: "What is the car's average speed?", steps: [step({ nudge: "It is 75 km/h." })] }),
          problem(pid, { stem: "Find the speed from the wrong formula.", steps: [step({ numeric: { value: 80, unit: "km/h", formula: "150 / 2" } })] }),
        ],
      },
    },
  ];
  const env = { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify(responses) };
  const runner: ModelRunner = createPackRuntime(createClaudeBackend({ command: fake, workDir, env }), { dailyBackgroundTokens: 1_000_000 }).runner;
  const handler = createPackHandler({ store, runner: () => runner });
  const core = createCore(store, { fixture: assignments, seams: { pack: handler.pack } });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const calls = async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").length : 0);
  try {
    const r = (await core.execute({ type: "pack", pack: "problems", scope: { courseId: "SYN220" } })).pack as PackRunResult;
    assert.equal(r.status, "done", r.message);
    assert.equal(r.counts.generated, 3);
    assert.equal(r.counts.accepted, 1);
    assert.match(r.message, /^1 problems ready; 2 dropped by the checks\.$/);
    assert.equal(r.drops.find((d) => /restraint/.test(d.reason))?.stage, "flaws");
    assert.equal(r.drops.find((d) => /recompute/.test(d.reason))?.stage, "executed");
    assert.ok(store.receipts().some((x) => x.recipient === "claude" && x.status === "sent" && x.categories.includes("course_text")));
    const ref = "acct:SYN220";
    const [p] = storedProblems(store.learning, ref);
    assert.ok(p);
    assert.equal(p.origin, "generated");
    assert.equal(reading.text.slice(p.source.start, p.source.end), p.source.quote, "the quote is the exact span of the source");
    assert.equal((p.steps[1]!.answer as { value: number }).value, 75 * 1000 / 3600, "code keeps the recomputed key");
    assert.ok(p.checks.includes("restraint") && p.checks.includes("recompute"));

    // A repeat is a cache hit: no second call.
    const before = await calls();
    const again = (await core.execute({ type: "pack", pack: "problems", scope: { courseId: "SYN220" } })).pack as PackRunResult;
    assert.equal(again.cached, true);
    assert.equal(await calls(), before);

    // Study time: exam.solve serves the stored problem; every step is checked by code.
    const context = (anchor: string): StudyContext | null =>
      anchor !== target.id
        ? null
        : {
            resourceId: anchor, accountScope: "acct", courseId: "SYN220", inputHash: "i", contextHash: "c", availability: "current", reason: "Ready",
            resources: store.resources().filter((x) => eligibleStudySource(x)).map((x) => ({ id: x.id, contentHash: x.contentHash, text: x.text, title: x.title, url: x.url, observedAt: x.observedAt, eligible: true })),
          };
    const router = createLearningRouter({ store: store.learning, resolveContext: context, examEvidence: () => createExamEvidence(store) });
    const call = (req: Record<string, unknown>) => router.handle(req as LearningRequest, new AbortController().signal);
    const started = await call({ op: "exam.solve", courseId: "SYN220", anchorIds: [target.id], problemIds: [p.id], count: 1, fade: false, operationId: "solve-1" });
    assert.equal(started.status, "ok", started.message);
    const v = (started.data as ExamSessionData).exam;
    const answered = await call({ op: "exam.answer", sessionId: v.id, revision: v.revision, operationId: "a1", questionId: v.questions[0]!.id, stepId: "s1", response: { kind: "number", value: 75, unit: "km/h" }, confidence: 0.67, responseMs: 1000 });
    assert.equal((answered.data as ExamSessionData).exam.questions[0]!.steps[0]!.status, "correct");
    assert.equal(await calls(), before, "no model was called at study time");
  } finally {
    store.close();
  }
});
