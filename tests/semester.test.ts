// The semester harness (evals/semester) as a regression guard: actions answered by code stay at
// zero model calls, every repeat stays at zero calls (code or cache), and the prompts our model
// paths send stay under recorded caps. Deterministic: the fake CLI plays the model, and nothing
// here asserts on timing. Tokens = ceil(chars / 4), as the harness reports them.
import test from "node:test";
import assert from "node:assert/strict";
import { runOurs } from "../evals/semester/ours";
import { dueThisWeekCorrect } from "../evals/semester/typical";
import { percentNear } from "../evals/semester/workspace";

// Measured at the first run of `pnpm semester` (2026-09-27) plus ~15% headroom. Raise a cap only
// with the reason in the commit; a prompt that grows past one is a cost regression.
const TOKEN_CAPS: Record<number, number> = { 3: 1000, 4: 1500, 5: 1250, 7: 500, 8: 1000, 10: 1900 };
const ZERO_CALL = [1, 2, 6];

test("semester actions: code paths make no model call, repeats make none, and prompts stay under their caps", async () => {
  const rows = await runOurs({ warmRuns: 1 });
  assert.equal(rows.length, 10);
  for (const id of ZERO_CALL) {
    const r = rows.find((x) => x.id === id)!;
    assert.equal(r.path, "code", `${r.action}: ${r.path}`);
    assert.equal(r.calls, 0, `${r.action} made a model call`);
    assert.equal(r.tokens, 0);
    assert.ok(r.correct, `${r.action}: ${r.check}`);
  }
  for (const r of rows) {
    assert.equal(r.repeatCalls, 0, `${r.action}: the repeat called the model`);
    assert.ok(r.calls <= 1, `${r.action}: ${r.calls} calls on the first run`);
  }
  for (const [id, cap] of Object.entries(TOKEN_CAPS)) {
    const r = rows.find((x) => x.id === Number(id))!;
    assert.ok(r.tokens <= cap, `${r.action}: ${r.tokens} tokens > cap ${cap}`);
  }
});

test("semester baseline checks: Homework 4's move isn't a wrong answer, and both sides share the ±1 tolerance", () => {
  const listed = ["Due this week:", "- Problem Set 2 (Tue Sep 29)", "- Homework 3 (Tue Sep 29)", "- Essay 1 (Thu Oct 1)"].join("\n");
  assert.ok(dueThisWeekCorrect(listed));
  assert.ok(dueThisWeekCorrect(`${listed}\nNote: Homework 4 is now due Friday Oct 9 instead of Wednesday Oct 7.`));
  assert.ok(!dueThisWeekCorrect(`${listed}\n- Homework 4`));
  assert.ok(!dueThisWeekCorrect("- Problem Set 2\n- Homework 3"));
  assert.ok(percentNear("You need about 78% on the final.", 77.8));
  assert.ok(percentNear("You need 77.8% on the final.", 77.8));
  assert.ok(!percentNear("You need 83% on the final.", 77.8));
});
