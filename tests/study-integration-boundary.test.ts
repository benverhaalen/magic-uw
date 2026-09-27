import test from "node:test";
import assert from "node:assert/strict";
import type { Store } from "@magic/contracts";
import { courseScope } from "../packages/core/src/study-prep/scope";

// The temporary renderer hold on Study generation and Ask (a719430) is lifted; the producing
// chain is covered end to end in study-generation-chain.test.ts.

test("unscoped Study lookup rejects duplicated course IDs across accounts", () => {
  const store = (rows: { courseId: string; accountScope: string }[]) => ({ sources: () => rows }) as Store;
  assert.equal(courseScope(store([{ courseId: "c", accountScope: "a" }, { courseId: "c", accountScope: "a" }]), "c"), "a");
  assert.equal(courseScope(store([{ courseId: "c", accountScope: "a" }, { courseId: "c", accountScope: "b" }]), "c"), null);
  assert.equal(courseScope(store([]), "c"), null);
});
