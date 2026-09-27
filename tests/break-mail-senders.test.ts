// Break card B2 and B3: course-mail trust. Synthetic senders through the real categorizeMail
// (graph.ts) and buildNotifications (notifications.ts); Jev is a scripted fake judgment.
import test from "node:test";
import assert from "node:assert/strict";
import { buildNotifications } from "../packages/domain/src/notifications";
import { measureB2, measureB3 } from "./break-measure";
import { pct } from "./break-cases";

test("B2: an outside sender whose subject names the course is not course staff and not keyword-urgent", () => {
  const r = measureB2(buildNotifications);
  console.log(`B2 outside labelled Course staff: ${pct(r.outsideAsStaff.k, r.outsideAsStaff.n)}; outside urgent: ${pct(r.outsideUrgent.k, r.outsideUrgent.n)}; staff urgent: ${pct(r.staffUrgent.k, r.staffUrgent.n)}`);
  assert.equal(r.outsideAsStaff.k, 0);
  assert.equal(r.outsideUrgent.k, 0);
  assert.equal(r.staffUrgent.k, r.staffUrgent.n, "a known staff address with the same subject stays urgent");
});

test("B3: a Jev raise moves one level at most and stops at important for a non-staff sender", () => {
  const r = measureB3(buildNotifications);
  console.log(`B3 unknown senders raised to urgent: ${pct(r.unknownUrgent.k, r.unknownUrgent.n)}; staff raised to urgent: ${pct(r.staffUrgent.k, r.staffUrgent.n)}`);
  assert.equal(r.unknownUrgent.k, 0);
  assert.equal(r.staffUrgent.k, r.staffUrgent.n, "course staff mail about a task due soon still reaches urgent");
});
