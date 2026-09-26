import test from "node:test";
import assert from "node:assert/strict";
import { resolveDeadline, maySend } from "@magic/domain";
import { defaultPrivacy, type DeadlineClaim } from "@magic/contracts";
const claim = (
  value: string,
  kind: DeadlineClaim["kind"] = "due",
): DeadlineClaim => ({
  value,
  kind,
  quote: "fixture date",
  authority: "structured",
  scopeConfirmed: true,
});
test("conflicting dates retain uncertainty and conservative planning", () => {
  const r = resolveDeadline([
    claim("2026-09-28T05:00:00Z"),
    claim("2026-09-29T05:00:00Z"),
    claim("2026-09-30T05:00:00Z", "lock"),
  ]);
  assert.equal(r.dueAt, null);
  assert.equal(r.planningAt, "2026-09-28T05:00:00.000Z");
  assert.equal(r.conflict, true);
});
test("default privacy blocks every hosted recipient", () => {
  for (const r of ["jev", "chatgpt", "claude", "gemini"])
    assert.equal(maySend(defaultPrivacy, r, ["course_text"]).allowed, false);
  assert.equal(maySend(defaultPrivacy, "local", ["course_text"]).allowed, true);
});
