// Fixes 2 and 3 (AI-path audit): Jev judgments are keyed and queued on the text hash, so a grade
// or submission change reuses the judgment at 0 budget; code decides unambiguous assignment
// kinds from Canvas `submissionTypes`, and only ambiguous items go to Jev with a trimmed payload.
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { defaultPrivacy, type CaptureBatch, type ResourceInput } from "@magic/contracts";

const jevConsent = { type: "consent" as const, value: { action: "grant" as const, recipient: "jev" as const, disclosureVersion: CONSENT_DISCLOSURE_VERSION } };
const enabled = { ...defaultPrivacy, mode: "selective_cloud" as const, jevEnabled: true, shareCourseText: true };
const judgment = {
  kind: "essay" as const,
  probabilities: { essay: 0.97, problem_set: 0.005, quiz: 0.005, exam: 0.005, discussion: 0.005, project: 0.005, reading: 0.005, other: 0 },
  model: "synthetic-model",
  questionVersion: "assignment.kind.v1" as const,
};
const assignment = (i: number, over: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId: `a${i}`,
  kind: "assignment",
  courseId: "SYN200",
  courseName: "Synthetic Writing",
  title: `Assignment ${i}`,
  text: `Write about topic ${i}. ${"Long synthetic body text. ".repeat(400)}`,
  url: `https://canvas.example.test/a${i}`,
  deadlines: [],
  points: 10,
  submitted: false,
  policy: { mode: "coaching", evidence: `AI may explain concepts. ${"Policy detail. ".repeat(200)}` },
  ...over,
});
const batch = (resources: ResourceInput[], observedAt = "2090-01-01T00:00:00.000Z"): CaptureBatch => ({
  source: { id: "assignments", kind: "canvas", accountScope: "acct", courseId: "SYN200", scope: "assignments", label: "Synthetic" },
  observedAt,
  complete: true,
  status: "ok",
  resources,
});

async function run(resources: ResourceInput[]) {
  const store = createStore(":memory:");
  const payloads: { title: string; text: string; policy: string }[] = [];
  const core = createCore(store, {
    fixture: batch(resources),
    gateway: { async evaluate(p) { payloads.push(p); return judgment; } },
  });
  await core.execute({ type: "fixture" });
  await core.execute(jevConsent);
  await core.execute({ type: "privacy", value: enabled });
  await core.settled();
  return { store, core, payloads };
}

test("fix-ai-judgments: a grade or submission change reuses the text-hash judgment at 0 Jev budget; the old label stays visible", async () => {
  const { store, core, payloads } = await run([assignment(1)]);
  try {
    assert.equal(payloads.length, 1);
    const id = store.resources()[0]!.id;
    const label = () => core.snapshot().resources.find((r) => r.id === id)?.kindLabel;
    assert.equal(label(), "essay");
    const before = store.resources()[0]!.contentHash;
    store.ingest(batch([assignment(1, { submitted: true, submission: { workflowState: "graded", score: 9, grade: "9" } })], "2090-01-02T00:00:00.000Z"));
    assert.notEqual(store.resources()[0]!.contentHash, before, "the grade changed the content hash");
    await core.execute({ type: "enrich", id });
    await core.settled();
    assert.equal(payloads.length, 1, "no second Jev call for the same title and text");
    assert.equal(label(), "essay", "the judgment is still shown after the grade change");
    // A text change is a new question.
    store.ingest(batch([assignment(1, { text: "Solve problems 1-10 from chapter 3." })], "2090-01-03T00:00:00.000Z"));
    await core.execute({ type: "enrich", id });
    await core.settled();
    assert.equal(payloads.length, 2);
  } finally {
    await core.close();
  }
});

/** A synthetic 100-assignment course: 30 quizzes, 20 discussions, 50 uploads or text entries. */
const course = (withTypes: boolean): ResourceInput[] =>
  Array.from({ length: 100 }, (_, i) => {
    const types = i < 30 ? ["online_quiz"] : i < 50 ? ["discussion_topic"] : i % 2 ? ["online_upload"] : ["online_text_entry", "online_upload"];
    return assignment(i, withTypes ? { submissionTypes: types } : {});
  });

test("fix-ai-judgments: code decides quiz and discussion from submissionTypes; Jev calls on a 100-assignment course drop, payloads are trimmed", async (t) => {
  const before = await run(course(false));
  const after = await run(course(true));
  try {
    t.diagnostic(`Jev calls on the synthetic 100-assignment course: before ${before.payloads.length}, after ${after.payloads.length}`);
    assert.equal(before.payloads.length, 100, "without submission types every assignment is ambiguous");
    assert.equal(after.payloads.length, 50, "only the 50 upload/text-entry items reach Jev");
    const labels = after.core.snapshot().resources.map((r) => r.kindLabel);
    assert.equal(labels.filter((l) => l === "quiz").length, 30);
    assert.equal(labels.filter((l) => l === "discussion").length, 20);
    for (const p of after.payloads) {
      assert.ok(p.text.length <= 2000, `text trimmed to about 2,000 characters (got ${p.text.length})`);
      assert.ok(p.policy.length <= 500, `the item's policy is clipped (got ${p.policy.length})`);
    }
  } finally {
    await before.core.close();
    await after.core.close();
  }
});
