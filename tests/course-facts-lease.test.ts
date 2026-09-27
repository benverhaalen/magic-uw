// Model-backed kinds lease for 180 s and renew every 60 s while the call runs: a 90-second call is
// not re-leased by another worker, and a crashed holder's lease still expires. Synthetic data.
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { captureBatchSchema } from "@magic/contracts";
import { createDrain } from "../packages/core/src/drain";
import { COURSE_FACTS_LEASE_MS, createCourseFactsJob } from "../packages/core/src/course-facts/job";

const t0 = Date.parse("2026-09-27T12:00:00.000Z");
const iso = (ms: number) => new Date(t0 + ms).toISOString();
function setup() {
  const store = createStore(":memory:");
  store.ingest(
    captureBatchSchema.parse({
      source: { id: "syl", label: "Syllabus", kind: "canvas", accountScope: "a", courseId: "c", scope: "syllabus" },
      observedAt: iso(0),
      status: "ok",
      complete: true,
      resources: [{ externalId: "syllabus", kind: "material", courseId: "c", courseName: "Synthetic", title: "Syllabus", url: "https://canvas.example.edu/courses/c/assignments/syllabus", text: "Grading\nEssays 40%" }],
    }),
  );
  const inputHash = store.courseInventoryHash({ accountScope: "a", courseId: "c" });
  assert.ok(store.enqueueSubject({ kind: "course.facts", subjectKind: "course", subjectId: "a:c", inputHash, sourceId: "syl" }, iso(0)));
  return store;
}

test("a 90-second call holds its 180 s lease (renewed by heartbeat); another worker can't lease it", async () => {
  const store = setup();
  let clock = 0;
  const now = () => iso(clock);
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    const drain = createDrain({
      store,
      now,
      leaseMsByKind: { "course.facts": COURSE_FACTS_LEASE_MS },
      handlers: {
        "course.facts": async (_job, context) => {
          resolve();
          await new Promise<void>((r) => (release = r));
          // The handler's heartbeat renews from the (fake) current time.
          assert.equal(context.heartbeat(), true);
        },
      },
    });
    void drain.run().then((report) => (finished = report));
  });
  let finished: { done: number } | undefined;
  await started;
  const job = store.jobs().find((j) => j.kind === "course.facts")!;
  assert.equal(job.leaseUntil, iso(COURSE_FACTS_LEASE_MS), "leased for 180 s, not the default 60 s");
  clock = 90_000; // 90 s into the call: another worker tries.
  assert.equal(store.lease(now(), 60_000, ["course.facts"]), undefined);
  clock = 170_000; // the heartbeat at 170 s extends the lease to 350 s
  release();
  await new Promise((r) => setTimeout(r, 20));
  clock = 200_000;
  assert.equal(store.lease(now(), 60_000, ["course.facts"]), undefined);
  assert.equal(finished?.done, 1, "the holder finished the job");
  store.close();
});

test("a crashed handler's lease still expires and another worker takes the job", () => {
  const store = setup();
  const held = store.lease(iso(0), 60_000, ["course.facts"])!;
  assert.ok(store.renewLease!(held, iso(0), COURSE_FACTS_LEASE_MS));
  // The holder crashes: no heartbeat, no finish.
  assert.equal(store.lease(iso(179_000), 60_000, ["course.facts"]), undefined);
  const taken = store.lease(iso(181_000), 60_000, ["course.facts"]);
  assert.equal(taken?.id, held.id);
  assert.equal(store.renewLease!(held, iso(182_000), COURSE_FACTS_LEASE_MS), false, "the old holder's token no longer renews");
  store.close();
});

test("the course.facts handler declares the 180 s lease and renews through its heartbeat", async () => {
  const store = setup();
  let beats = 0;
  const handler = createCourseFactsJob({ runner: () => null, heartbeatMs: 5 });
  assert.equal(handler.leaseMs, COURSE_FACTS_LEASE_MS);
  const job = store.jobs().find((j) => j.kind === "course.facts")!;
  const outcome = await handler.run(job, {
    store,
    now: () => iso(0),
    signal: new AbortController().signal,
    heartbeat: () => (beats++, true),
  });
  assert.equal(outcome.status, "done");
  store.close();
});
