import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import type { CaptureBatch, ResourceInput } from "@magic/contracts";
import { createStudyContextResolver } from "../apps/desktop/src/learning-context";
const at = (n = 0) => new Date(Date.UTC(2090, 0, 1, 0, 0, n)).toISOString();
const input = (
  id: string,
  kind: ResourceInput["kind"] = "material",
  extra: Partial<ResourceInput> = {},
): ResourceInput => ({
  externalId: id,
  kind,
  courseId: "course",
  courseName: "Synthetic course",
  title: `Synthetic ${id}`,
  text: "Synthetic supporting explanation.",
  url: `https://canvas.example.test/${id}`,
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "coaching", evidence: "Synthetic coaching policy" },
  ...extra,
});
function batch(
  id: string,
  resources: ResourceInput[],
  n = 0,
  accountScope = "account",
  courseId = "course",
): CaptureBatch {
  return {
    source: {
      id,
      kind: "canvas",
      accountScope,
      courseId,
      scope: id,
      label: "Synthetic source",
    },
    observedAt: at(n),
    complete: true,
    status: "ok",
    resources,
  };
}
function setup() {
  const store = createStore(":memory:");
  const targetBatch = batch("assignments", [
    input("target", "assignment", { points: 10, submitted: true }),
  ]);
  const materialBatch = batch("materials", [input("reading")]);
  store.ingest(targetBatch);
  store.ingest(materialBatch);
  const core = createCore(store, { fixture: targetBatch });
  const target = store.resources().find((r) => r.externalId === "target")!;
  const reading = store.resources().find((r) => r.externalId === "reading")!;
  const link = () => {
    const r = store.resource(reading.id)!;
    store.putLink({
      id: "link",
      fromId: r.id,
      toId: target.id,
      type: "specifies",
      reason: "Synthetic course source pointer",
      status: "accepted",
      inputHash: r.contentHash,
    });
  };
  link();
  return {
    store,
    core,
    target,
    reading,
    targetBatch,
    materialBatch,
    link,
    resolve: createStudyContextResolver(store, core),
  };
}
test("study context reads actual core manifest: open graded assignment stays out, eligible supporting material stays in", () => {
  const { store, core, target, reading, resolve } = setup();
  try {
    assert.ok(
      core.context(target.id, "local").resourceIds.includes(reading.id),
    );
    const context = resolve(target.id)!;
    assert.equal(context.availability, "current");
    assert.equal(context.accountScope, "account");
    assert.equal(context.inputHash, target.contentHash);
    assert.deepEqual(
      context.resources.map((r) => r.id),
      [reading.id],
    );
    assert.equal(store.receipts().length, 0);
    assert.equal(resolve(reading.id), null);
    assert.equal(resolve("missing"), null);
  } finally {
    store.close();
  }
});
test("course exclusion denies saved session context, and account/course evidence injection is filtered", () => {
  const { store, core, target, resolve } = setup();
  try {
    store.ingest(
      batch("other-account", [input("foreign-account")], 0, "other-account"),
    );
    store.ingest(
      batch(
        "other-course",
        [input("foreign-course", "material", { courseId: "other-course" })],
        0,
        "account",
        "other-course",
      ),
    );
    const foreign = store
      .resources()
      .filter((r) => r.externalId.startsWith("foreign"));
    // The real core already scopes evidence. A widened manifest must not defeat
    // the resolver's own scope boundary either.
    const widened = createStudyContextResolver(store, {
      context(id, recipient) {
        const manifest = core.context(id, recipient);
        return {
          ...manifest,
          resourceIds: [...manifest.resourceIds, ...foreign.map((r) => r.id)],
        };
      },
    });
    assert.equal(
      widened(target.id)!.resources.some((r) =>
        foreign.some((f) => f.id === r.id),
      ),
      false,
    );
    store.setCourseOverride({
      accountScope: "account",
      courseId: "course",
      included: false,
    });
    assert.equal(core.context(target.id, "local").allowed, false);
    assert.equal(resolve(target.id), null);
    store.setCourseOverride({
      accountScope: "account",
      courseId: "course",
      included: true,
    });
    assert.ok(resolve(target.id));
  } finally {
    store.close();
  }
});
test("restricted policy blocks activity and supporting source failures make context stale without erasing sources", () => {
  const { store, target, reading, targetBatch, materialBatch, link, resolve } =
    setup();
  try {
    const current = resolve(target.id)!;
    store.ingest({
      ...materialBatch,
      observedAt: at(1),
      complete: false,
      status: "partial",
      resources: [],
    });
    const stale = resolve(target.id)!;
    assert.equal(stale.availability, "stale");
    assert.ok(stale.resources.some((r) => r.id === reading.id));
    assert.notEqual(stale.contextHash, current.contextHash);
    assert.equal(stale.inputHash, current.inputHash);
    store.ingest({ ...materialBatch, observedAt: at(2) });
    link();
    assert.equal(resolve(target.id)!.availability, "current");
    store.ingest({
      ...targetBatch,
      observedAt: at(3),
      resources: [
        {
          ...targetBatch.resources[0]!,
          policy: { mode: "restricted", evidence: "Synthetic no-AI policy" },
        },
      ],
    });
    const blocked = resolve(target.id)!;
    assert.equal(blocked.availability, "blocked");
    assert.match(blocked.reason ?? "", /restricts/);
  } finally {
    store.close();
  }
});
test("inputHash pins assignment, contextHash additionally pins material and privacy; capture timestamp alone is stable", () => {
  const { store, target, targetBatch, materialBatch, link, resolve } = setup();
  try {
    const initial = resolve(target.id)!;
    store.ingest({ ...materialBatch, observedAt: at(1) });
    link();
    assert.equal(resolve(target.id)!.contextHash, initial.contextHash);
    store.ingest({
      ...materialBatch,
      observedAt: at(2),
      resources: [
        { ...materialBatch.resources[0]!, text: "Changed synthetic evidence." },
      ],
    });
    link();
    const materialChanged = resolve(target.id)!;
    assert.equal(materialChanged.inputHash, initial.inputHash);
    assert.notEqual(materialChanged.contextHash, initial.contextHash);
    store.setPrivacy({
      ...store.privacy(),
      shareStudentWork: !store.privacy().shareStudentWork,
    });
    const settingsChanged = resolve(target.id)!;
    assert.equal(settingsChanged.inputHash, initial.inputHash);
    assert.notEqual(settingsChanged.contextHash, materialChanged.contextHash);
    store.ingest({
      ...targetBatch,
      observedAt: at(3),
      resources: [
        {
          ...targetBatch.resources[0]!,
          text: "Changed assignment directions.",
        },
      ],
    });
    const targetChanged = resolve(target.id)!;
    assert.notEqual(targetChanged.inputHash, initial.inputHash);
    assert.notEqual(targetChanged.contextHash, settingsChanged.contextHash);
  } finally {
    store.close();
  }
});
test("assignment eligibility follows lock then due, unknown dates remain open even when submitted", () => {
  const { store, core, target } = setup();
  try {
    const deadline = (kind: "lock" | "due", value: string) => ({
      kind,
      value,
      quote: "Synthetic deadline",
      authority: "structured" as const,
      scopeConfirmed: true,
    });
    const items = [
      input("closed", "assignment", {
        deadlines: [deadline("due", "2000-01-01T00:00:00Z")],
      }),
      input("future", "assignment", {
        submitted: true,
        deadlines: [deadline("due", "2999-01-01T00:00:00Z")],
      }),
      input("lock-open", "assignment", {
        deadlines: [
          deadline("due", "2000-01-01T00:00:00Z"),
          deadline("lock", "2999-01-01T00:00:00Z"),
        ],
      }),
      input("lock-closed", "assignment", {
        deadlines: [
          deadline("lock", "2000-01-01T00:00:00Z"),
          deadline("due", "2999-01-01T00:00:00Z"),
        ],
      }),
      input("no-date", "assignment", { submitted: true }),
    ];
    store.ingest(batch("more-assignments", items));
    const candidates = store
      .resources()
      .filter((r) => items.some((i) => i.externalId === r.externalId));
    const resolve = createStudyContextResolver(store, {
      context(id, recipient) {
        const m = core.context(id, recipient);
        return {
          ...m,
          resourceIds: [...m.resourceIds, ...candidates.map((r) => r.id)],
        };
      },
    });
    const ids = new Set(resolve(target.id)!.resources.map((r) => r.id));
    for (const r of candidates)
      assert.equal(
        ids.has(r.id),
        ["closed", "lock-closed"].includes(r.externalId),
        r.externalId,
      );
  } finally {
    store.close();
  }
});
