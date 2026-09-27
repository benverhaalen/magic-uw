/**
 * fix/sync-events: the whole desktop ingestion on the live-shaped synthetic account
 * (evals/perf/sync-account.ts) with no latency: what each trigger reads. No network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runSyncAccount } from "../evals/perf/sync-account";

test("no rereads: no URL twice in a run, a relaunch probes only, refresh isn't a full read, a steady tick is two requests", { timeout: 600_000 }, async () => {
  const { scenarios } = await runSyncAccount({ latencyMs: 0, derivation: false });
  const by = (name: string) => scenarios.find((s) => s.name === name)!;
  for (const s of scenarios) assert.deepEqual(s.duplicates, {}, `${s.name} read a URL twice`);
  const first = by("first sync after sign-in");
  assert.equal(first.coursesRead.current, 6);
  assert.equal(first.coursesRead.shells + first.coursesRead.past, 0, "old and org courses are never read");
  // A full read reads every current course's assignment list; a warm read reads only the moved ones.
  const fullRead = (s: (typeof scenarios)[number]) => (s.byEndpoint["/api/v1/courses/:id/assignments"] ?? 0) >= 6;
  const relaunch = by("second launch within the freshness window");
  assert.equal(fullRead(relaunch), false, "a relaunch within the window is not a full read");
  assert.deepEqual(
    Object.keys(relaunch.byEndpoint).filter((e) => !e.startsWith("/feeds/")).sort(),
    ["/api/v1/users/self/todo", "/api/v1/users/self/upcoming_events"],
  );
  assert.equal(fullRead(by("manual refresh within a minute")), false);
  assert.equal(fullRead(by("manual refresh (steady)")), false);
  assert.equal(by("steady hot tick (+5 min)").requests, 2);
  const moved = by("teacher moves one due date");
  assert.equal(fullRead(moved), false);
  assert.equal(moved.coursesRead.current, 1, "only the course whose item moved is read");
  assert.equal(fullRead(by("six-hour backstop")), true);
});
