import test from "node:test";
import assert from "node:assert/strict";
import { requirePlanSave } from "../apps/desktop/src/renderer/today-plan-save";
import type { Command } from "@magic/contracts";

const command: Command = { type: "day-plan-remove", key: "suggestion", date: "2026-09-29" };
test("Today plan adapter passes the exact command and acknowledged result through", async () => {
  const receipt = { snapshot: { dayPlan: [] } };
  assert.equal(await requirePlanSave(async received => {
    assert.equal(received, command);
    return receipt;
  }, command), receipt);
});
test("Today plan adapter rejects swallowed failures and globally blocked operations", async () => {
  for (const result of [undefined, null, false]) {
    await assert.rejects(requirePlanSave(async () => result, command), /not saved/);
  }
});
test("Today plan adapter retains a rejected save for the local recovery handler", async () => {
  const error = new Error("Save failed");
  await assert.rejects(requirePlanSave(async () => { throw error; }, command), cause => cause === error);
});
