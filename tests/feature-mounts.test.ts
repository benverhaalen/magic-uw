// Regression guard (2026-09-27): a merge that takes one side of a page ("theirs wins") can silently
// drop a feature mounted in it: the GPA panel vanished when My UW was replaced by the designed page.
// Each owner-tagged mount below must stay reachable from the shell; if a page is redesigned, move the
// mount, don't lose it. Add a row when a feature mounts into a shared page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MOUNTS: { feature: string; file: string; pattern: RegExp }[] = [
  { feature: "GPA panel on My UW", file: "apps/desktop/src/renderer/myuw/MyUwPage.tsx", pattern: /<GpaSection\b/ },
  { feature: "Course Analytics tab", file: "apps/desktop/src/renderer/App.tsx", pattern: /<CourseTabs\b/ },
  { feature: "Study & Learn page", file: "apps/desktop/src/renderer/App.tsx", pattern: /<StudyLearnPage\b/ },
  { feature: "Item space host", file: "apps/desktop/src/renderer/App.tsx", pattern: /<ItemSpaceHost\b/ },
  { feature: "Change-driven snapshot refresh", file: "apps/desktop/src/renderer/App.tsx", pattern: /\bonChanged\b/ },
];

for (const m of MOUNTS)
  test(`feature mount stays: ${m.feature}`, () => {
    assert.match(readFileSync(m.file, "utf8"), m.pattern, `${m.feature} is no longer mounted in ${m.file}`);
  });
