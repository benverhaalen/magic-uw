import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "@magic/storage";
import { resourceInputSchema, type ResourceInput } from "@magic/contracts";
import { evidenceFor, linkExactEvidence } from "../packages/core/src/evidence";

test("exact file aliases preserve independent uses and invalidate both changed endpoints", () => {
  const store = createStore(":memory:");
  let clock = Date.parse("2026-09-26T18:00:00Z");
  const assignment = (id: string, links: string[]) =>
    resourceInputSchema.parse({
      externalId: id,
      kind: "assignment",
      courseId: "1",
      courseName: "Course",
      title: id,
      url: `https://canvas.wisc.edu/courses/1/assignments/${id}`,
      text: "Assignment instructions",
      links,
    });
  const file = (id: string, text: string) =>
    resourceInputSchema.parse({
      externalId: id,
      kind: "material",
      courseId: "1",
      courseName: "Course",
      title: id,
      url: `https://canvas.wisc.edu/courses/1/files/${id}`,
      text,
    });
  const save = (scope: string, resources: ResourceInput[]) =>
    store.ingest({
      source: {
        id: scope,
        label: scope,
        kind: "canvas",
        accountScope: "a",
        courseId: "1",
        scope,
      },
      observedAt: new Date(clock += 1000).toISOString(),
      complete: true,
      status: "ok",
      resources,
    });
  try {
    save("assignments", [
      assignment("a", [
        "https://canvas.wisc.edu/files/9/download",
        "https://canvas.wisc.edu/courses/1/files/10/preview",
      ]),
      assignment("b", ["https://canvas.wisc.edu/files/9/preview"]),
      assignment("foreign", ["https://canvas.wisc.edu/courses/2/files/9"]),
    ]);
    save("documents", [
      file("9", "First reading"),
      file("10", "Second reading"),
    ]);
    const get = (id: string) =>
      store.resources().find((r) => r.externalId === id)!;
    linkExactEvidence(store);
    assert.equal(evidenceFor(store).supporting(get("a")).length, 2);
    assert.equal(evidenceFor(store).supporting(get("b")).length, 1);
    assert.equal(evidenceFor(store).supporting(get("foreign")).length, 0);
    save("documents", [
      file("9", "Changed reading"),
      file("10", "Second reading"),
    ]);
    assert.equal(
      evidenceFor(store).supporting(get("a")).length,
      1,
      "changed material invalidates its old association",
    );
    linkExactEvidence(store);
    save("assignments", [
      assignment("a", ["https://canvas.wisc.edu/files/9"]),
      assignment("b", ["https://canvas.wisc.edu/files/9/preview"]),
      assignment("foreign", ["https://canvas.wisc.edu/courses/2/files/9"]),
    ]);
    assert.equal(
      evidenceFor(store).supporting(get("a")).length,
      0,
      "changed use invalidates its previous associations",
    );
    linkExactEvidence(store);
    assert.deepEqual(
      evidenceFor(store)
        .supporting(get("a"))
        .map((r) => r.externalId),
      ["9"],
    );
    assert.deepEqual(
      evidenceFor(store)
        .supporting(get("b"))
        .map((r) => r.externalId),
      ["9"],
    );
  } finally {
    store.close();
  }
});
