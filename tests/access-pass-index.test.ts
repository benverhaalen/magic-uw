import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Resource, ResourceInput } from "@magic/contracts";
import { createStore } from "@magic/storage";
import { accessCandidateIndex } from "../apps/desktop/src/ingestion";
import { courseInclusion, courseRowIncluded } from "../packages/core/src/access";

const origin = "https://canvas.wisc.edu";
const row = (id: string, extra: Partial<Resource>): Resource =>
  ({
    id,
    sourceId: `source-${id}`,
    courseId: "1",
    url: `${origin}/courses/1/pages/${id}`,
    deleted: false,
    ...extra,
  }) as Resource;

test("the access index returns exactly the rows the per-space scan did, in the same order", () => {
  const url = `${origin}/courses/1/files/9`;
  const resources = [
    row("a", { url }),
    row("deleted", { url, deleted: true }),
    row("document", { url, document: { fileId: "9", pages: [] } }),
    row("other-course", { url, courseId: "2" }),
    row("by-file-id", { file: { id: "9" } }),
    row("other-file", { file: { id: "8" } }),
    row("b", { url }),
    row("unrelated", {}),
  ];
  // The filter each canvas_session space ran over a full store read before the index.
  const scan = (courseId: string, spaceUrl: string, fileId: string | undefined) =>
    resources.filter(
      (r) =>
        !r.deleted &&
        !r.document &&
        r.courseId === courseId &&
        (r.url === spaceUrl || (fileId && r.file?.id === fileId)),
    );
  const index = accessCandidateIndex(resources);
  for (const [courseId, spaceUrl, fileId] of [
    ["1", url, "9"],
    ["1", url, undefined],
    ["1", `${origin}/courses/1/pages/unrelated`, undefined],
    ["2", url, "9"],
    ["3", url, "9"],
  ] as const)
    assert.deepEqual(
      index(courseId, spaceUrl, fileId).map((r) => r.id),
      scan(courseId, spaceUrl, fileId).map((r) => r.id),
    );
  assert.deepEqual(index("1", url, "9").map((r) => r.id), ["a", "by-file-id", "b"]);
});

test("a per-item course recheck reads one row and agrees with the full inclusion as the course changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-access-row-"));
  const store = createStore(join(directory, "db.sqlite"));
  try {
    const source = { id: "canvas:a:1:course", label: "Course", kind: "canvas", accountScope: "a", courseId: "1", scope: "course" };
    const course = (extra: Partial<ResourceInput["course"]> = {}): ResourceInput => ({
      externalId: "1",
      kind: "course",
      courseId: "1",
      courseName: "Biology 101",
      title: "Biology 101",
      url: `${origin}/courses/1`,
      text: "",
      deadlines: [],
      points: null,
      submitted: null,
      policy: { mode: "unknown", evidence: "" },
      course: { workflowState: "available", ...extra },
    });
    let n = 0;
    const save = (resources: ResourceInput[]) =>
      store.ingest({
        source,
        observedAt: new Date(Date.UTC(2099, 0, 1, 0, n)).toISOString(),
        readId: `read-${n++}`,
        status: "ok",
        complete: true,
        resources,
      });
    save([course()]);
    const captured = store.resources().find((r) => r.kind === "course")!;
    const agree = (expected: boolean) => {
      assert.equal(courseInclusion(store)(captured), expected);
      assert.equal(courseRowIncluded(store, captured), expected);
    };
    agree(true);
    store.setCourseOverride({ accountScope: "a", courseId: "1", included: false }); // excluded mid-run
    agree(false);
    store.setCourseOverride({ accountScope: "a", courseId: "1", included: null });
    agree(true);
    save([course({ accessState: "not_open" })]); // the stored course changed after the run began
    agree(false);
    save([course({ accessState: "open" })]);
    agree(true);
    save([]); // a complete read without it deletes the course row
    assert.equal(courseRowIncluded(store, captured), courseInclusion(store)(captured));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
