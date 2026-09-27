import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { captureBatchSchema } from "@magic/contracts";
import { gitlabProjectsForCourse } from "../packages/connectors/src/gitlab";
import fixture from "../fixtures/course.json";

// The synthetic sample course: account "synthetic", course "sample-101".
async function withCore(fn: (core: ReturnType<typeof createCore>) => Promise<void>) {
  const core = createCore(createStore(":memory:"), { fixture: captureBatchSchema.parse(fixture) });
  try {
    await core.execute({ type: "fixture" });
    await fn(core);
  } finally {
    await core.close();
  }
}
const link = (url: string, courseId = "sample-101") =>
  ({ type: "gitlab-link", accountScope: "synthetic", courseId, url }) as const;

test("a pasted UW GitLab link is saved as that course's project", async () => {
  await withCore(async (core) => {
    const result = await core.execute(link("https://git.doit.wisc.edu/cs400-f26/team-7/p1/-/tree/main"));
    assert.deepEqual(
      result.snapshot.gitlabLinks?.map(({ accountScope, courseId, projectPath }) => ({ accountScope, courseId, projectPath })),
      [{ accountScope: "synthetic", courseId: "sample-101", projectPath: "cs400-f26/team-7/p1" }],
    );
    assert.match(result.message ?? "", /GitLab project linked/);
  });
});

test("only UW GitLab project links, for a course that exists, are accepted", async () => {
  await withCore(async (core) => {
    for (const bad of [
      "https://github.com/someone/p1",
      "https://git.doit.wisc.edu/users/someone",
      "https://git.doit.wisc.edu/lonely",
      "not a url",
    ])
      await assert.rejects(core.execute(link(bad)), /UW GitLab project/, bad);
    await assert.rejects(core.execute(link("https://git.doit.wisc.edu/a/b", "no-such-course")), /course/);
    const { snapshot } = await core.execute({ type: "snapshot" });
    assert.deepEqual(snapshot.gitlabLinks ?? [], []);
  });
});

test("linking twice keeps one entry; unlinking and deleting local data remove it", async () => {
  await withCore(async (core) => {
    await core.execute(link("https://git.doit.wisc.edu/a/b"));
    const twice = await core.execute(link("https://git.doit.wisc.edu/a/b/-/merge_requests"));
    assert.equal(twice.snapshot.gitlabLinks?.length, 1);
    const removed = await core.execute({ type: "gitlab-unlink", accountScope: "synthetic", courseId: "sample-101", projectPath: "a/b" });
    assert.deepEqual(removed.snapshot.gitlabLinks ?? [], []);
    await core.execute(link("https://git.doit.wisc.edu/a/b"));
    const purged = await core.execute({ type: "purge", confirmation: "DELETE LOCAL DATA" });
    assert.deepEqual(purged.snapshot.gitlabLinks ?? [], []);
  });
});

test("a refresh reads discovered and manually linked projects for the course, once each", () => {
  const manual = [
    { accountScope: "synthetic", courseId: "sample-101", projectPath: "a/manual", addedAt: "2026-09-27T06:00:00.000Z" },
    { accountScope: "synthetic", courseId: "sample-101", projectPath: "a/found", addedAt: "2026-09-27T06:00:00.000Z" },
    { accountScope: "synthetic", courseId: "other", projectPath: "x/other-course", addedAt: "2026-09-27T06:00:00.000Z" },
    { accountScope: "someone-else", courseId: "sample-101", projectPath: "y/other-account", addedAt: "2026-09-27T06:00:00.000Z" },
  ];
  assert.deepEqual(
    gitlabProjectsForCourse(["https://git.doit.wisc.edu/a/found/-/blob/main/README.md", "https://example.com/x"], manual, {
      accountScope: "synthetic",
      courseId: "sample-101",
    }),
    ["a/found", "a/manual"],
  );
});
