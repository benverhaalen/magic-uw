// Fix 6 (AI-path audit): a context() build derives each roster once (the outgoing projection
// reuses the scrubber's roster instead of re-reading every resource) and the name matcher is
// compiled once per roster version. Same scrubbed output, fewer store reads.
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore, rosterFor, scrubText } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { defaultPrivacy, type CaptureBatch, type Store } from "@magic/contracts";

const TEXT = "Peer reviewer Sam Rivera (sam.rivera@example.test) said the thesis needs work. Questions go to Elena Ruiz.";
const batch: CaptureBatch = {
  source: { id: "assignments", kind: "canvas", accountScope: "acct", courseId: "SYN300", scope: "assignments", label: "Synthetic" },
  observedAt: "2090-01-01T00:00:00.000Z",
  complete: true,
  status: "ok",
  resources: [
    {
      externalId: "essay",
      kind: "assignment",
      courseId: "SYN300",
      courseName: "Synthetic History",
      title: "Tariff essay",
      text: TEXT,
      url: "https://canvas.example.test/essay",
      deadlines: [],
      points: 10,
      submitted: false,
      policy: { mode: "coaching", evidence: "AI may explain." },
      course: { instructors: ["Elena Ruiz"] },
      submission: { comments: [{ text: "Nice start.", authorName: "Sam Rivera" }] },
    },
  ],
};

test("fix-ai-scrub: context() reads the resources once per roster and returns the same scrubbed payload", async () => {
  const store = createStore(":memory:");
  let reads = 0;
  const counted = new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (key === "resources" && typeof value === "function")
        return (...args: unknown[]) => {
          reads++; if (process.env.DBG_READS) console.log(new Error().stack!.split("\n").slice(2, 4).join(" | "));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as Store;
  const core = createCore(counted as typeof store, { fixture: batch });
  try {
    await core.execute({ type: "fixture" });
    await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
    await core.execute({ type: "privacy", value: { ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true } });
    await core.settled();
    const r = store.resources()[0]!;
    const expected = scrubText(TEXT, rosterFor(store, "SYN300", "acct")).text;
    assert.ok(!expected.includes("Sam Rivera") && expected.includes("Elena Ruiz"));
    reads = 0;
    const m = core.context(r.id, "claude");
    const perContext = reads;
    assert.equal(m.payload.text.split("\n\n")[0], expected, "the same scrubbed text");
    assert.equal(m.citationProjections?.length, 1);
    // Before: 5 reads (evidence, two course-inclusion checks, and the roster twice: the scrubber and
    // the outgoing projection). After: the projection reuses the scrubber's roster.
    assert.equal(perContext, 4, `store.resources() reads per context(): ${perContext}`);
  } finally {
    await core.close();
  }
});
