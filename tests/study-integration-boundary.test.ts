import test from "node:test";
import assert from "node:assert/strict";
import type { Store } from "@magic/contracts";
import { prepGenerate, ask, prepQuery, openExternal } from "../apps/desktop/src/renderer/study-prep/api";
import { courseScope } from "../packages/core/src/study-prep/scope";

test("temporary Study hold makes zero producing calls but preserves local query and source opening", async () => {
  let produced = 0, queried = 0, opened = 0;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { magic: {
    execute: async () => { produced++; throw new Error("producer must remain held"); },
    query: async () => { queried++; return { view: "study.prep" }; },
    openExternal: async () => { opened++; },
  } } });
  try {
    assert.equal((await prepGenerate(["guide"], { courseId: "c", itemId: "i" })).status, "unavailable");
    assert.ok((await ask({ courseId: "c", itemId: "i" }, "Explain this")).unavailable);
    await prepQuery({ courseId: "c" }); await openExternal("https://example.test/material");
    assert.deepEqual({ produced, queried, opened }, { produced: 0, queried: 1, opened: 1 });
  } finally { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); }
});

test("unscoped Study lookup rejects duplicated course IDs across accounts", () => {
  const store = (rows: { courseId: string; accountScope: string }[]) => ({ sources: () => rows }) as Store;
  assert.equal(courseScope(store([{ courseId: "c", accountScope: "a" }, { courseId: "c", accountScope: "a" }]), "c"), "a");
  assert.equal(courseScope(store([{ courseId: "c", accountScope: "a" }, { courseId: "c", accountScope: "b" }]), "c"), null);
  assert.equal(courseScope(store([]), "c"), null);
});
