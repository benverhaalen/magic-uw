import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const architecture = read("docs/course-backend-architecture.md");
const headings = [...architecture.matchAll(/^#{1,6} (.+)$/gm)].map((match) => match[1].trim());

function slug(heading: string): string {
  return heading.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
}

test("links into the architecture doc land on an existing heading", () => {
  const anchors = new Set(headings.map(slug));
  const files = ["README.md", ...readdirSync(join(root, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`)];
  const broken: string[] = [];
  for (const file of files) {
    for (const match of read(file).matchAll(/course-backend-architecture\.md#([\w-]+)/g)) {
      if (!anchors.has(match[1])) broken.push(`${file}: #${match[1]}`);
    }
  }
  assert.deepEqual(broken, []);
});

test("benchmarks cite architecture sections that exist on this branch", () => {
  // Citations of an earlier revision name the commit ("at `699e386`") and are not matched here.
  const sections = new Set(headings.map((heading) => /^(\d+(?:\.\d+)?)[. ]/.exec(heading)?.[1]).filter(Boolean));
  const cited = [...read("docs/benchmarks.md").matchAll(/(?:`docs\/course-backend-architecture\.md`|architecture) §(\d+(?:\.\d+)?)/g)].map((match) => match[1]);
  assert.ok(cited.length > 0);
  assert.deepEqual(cited.filter((section) => !sections.has(section)), []);
});
