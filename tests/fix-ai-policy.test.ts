// Fix 1 (AI-path audit): packs and guides read the same effective course policy as tutoring,
// so a syllabus AI restriction in the course profile blocks generation even when the
// resource's own policy is "unknown".
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { defaultPrivacy, type CaptureBatch, type CourseIntelligence, type ResourceInput } from "@magic/contracts";
import { createPackHandler } from "../packages/core/src/pack-handler";

const input = (id: string): ResourceInput => ({
  externalId: id,
  kind: "material",
  courseId: "SYN101",
  courseName: "Synthetic Data Structures",
  title: `Synthetic ${id}`,
  text: "A stack is a last-in, first-out collection of elements. A queue is first-in, first-out.",
  url: `https://canvas.example.test/${id}`,
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "unknown", evidence: "" },
  module: { id: "m1" },
});
const batch: CaptureBatch = {
  source: { id: "materials", kind: "canvas", accountScope: "acct", courseId: "SYN101", scope: "materials", label: "Synthetic" },
  observedAt: "2090-01-01T00:00:00.000Z",
  complete: true,
  status: "ok",
  resources: [input("reading")],
};

function setup(restricted: boolean) {
  const store = createStore(":memory:");
  store.ingest(batch);
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  const profile: CourseIntelligence = {
    id: "ci1", accountScope: "acct", courseId: "SYN101", courseName: "Synthetic Data Structures", version: 1, compilerVersion: "t",
    inputHash: "h", compiledAt: "2090-01-01T00:00:00.000Z", unknowns: [], conflicts: [], dependencies: [],
    claims: restricted
      ? [{ id: "c1", kind: "ai_policy", scope: "course", label: "AI policy", value: "No AI tools may be used.", method: "literal", policyMode: "restricted", evidence: [] }]
      : [],
  };
  (store as unknown as { courseIntelligence: () => CourseIntelligence[] }).courseIntelligence = () => [profile];
  let runnerCalls = 0;
  const handler = createPackHandler({ store, runner: async () => { runnerCalls++; return null; } });
  return { store, handler, runnerCalls: () => runnerCalls };
}

test("fix-ai-policy: a syllabus restriction in the profile blocks the quiz, cards and guide packs when the resource policy is unknown", async () => {
  const s = setup(true);
  try {
    for (const name of ["quiz", "cards", "guide"]) {
      const r = (await s.handler.pack(name, { courseId: "SYN101" }, new AbortController().signal)) as { status: string };
      assert.equal(r.status, "blocked", `${name} must be blocked by the profile's restriction`);
    }
    assert.equal(s.runnerCalls(), 0, "no client is even asked for");
  } finally {
    s.store.close();
  }
});

test("fix-ai-policy: without a restriction the same course is not blocked", async () => {
  const s = setup(false);
  try {
    const r = (await s.handler.pack("quiz", { courseId: "SYN101" }, new AbortController().signal)) as { status: string };
    assert.notEqual(r.status, "blocked");
  } finally {
    s.store.close();
  }
});
