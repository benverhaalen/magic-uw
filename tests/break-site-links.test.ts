// Break card B4: a discussion link whose address names the course number was synced as the course's
// own site. Synthetic links through the real hostSignals and decideByCode; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { decideByCode, hostSignals } from "../packages/core/src/site-triage";
import { measureB4 } from "./break-measure";
import { pct } from "./break-cases";

test("B4: a link seen only in a discussion is link_only; the same address from course content still syncs", () => {
  const r = measureB4(hostSignals, decideByCode);
  console.log(`B4 discussion-only synced: ${pct(r.discussionSynced.k, r.discussionSynced.n)}; content synced: ${pct(r.contentSynced.k, r.contentSynced.n)}`);
  assert.equal(r.discussionSynced.k, 0);
  assert.equal(r.contentSynced.k, r.contentSynced.n);
});
