import assert from "node:assert/strict";
import test from "node:test";
import { projectCourseLabel, COURSE_LABEL_RULE_VERSION, type CourseLabelInput } from "../packages/domain/src/course-label.js";

const input = (name = "ASTRO101: Principles of Stellar Ecology (001) FA26", code = "FA26 ASTRO 101 001"): CourseLabelInput => ({
  resource: { id: "resource-1", sourceId: "source-1", courseId: "course-1", kind: "course", courseName: name,
    course: { courseCode: code, termId: "term-1", termName: "Fall 2026" }, version: 3, contentHash: "hash-3" },
  source: { id: "source-1", accountScope: "account-1", courseId: "course-1" },
});

test("verified wrapper yields recognizable title/code with exact reversible provenance", () => {
  const source = input();
  const before = structuredClone(source);
  const label = projectCourseLabel(source);
  assert.equal(label.displayTitle, "Principles of Stellar Ecology");
  assert.equal(label.displayCode, "ASTRO 101");
  assert.equal(label.method, "verified-wrapper");
  assert.equal(label.ruleVersion, COURSE_LABEL_RULE_VERSION);
  assert.deepEqual(label.identity, { accountScope: "account-1", courseId: "course-1" });
  assert.deepEqual(label.context, { section: "001", termToken: "FA26", termId: "term-1", termName: "Fall 2026" });
  assert.deepEqual(label.evidence, { resourceId: "resource-1", sourceId: "source-1", version: 3, contentHash: "hash-3" });
  for (const span of label.removedSpans) assert.equal(label.rawName.slice(span.start, span.end), span.text);
  assert.equal(label.removedSpans[0].text + label.displayTitle + label.removedSpans[1].text, label.rawName);
  assert.deepEqual(source, before);
});

test("meaningful inner colons, parentheses, Unicode and repeated spaces remain intact", () => {
  for (const title of ["Cities: Power and Place (Urban Worlds)", "Diseño y memoria 🪐", "A  B: C (001) FA26", "X"]) {
    const label = projectCourseLabel(input(`HIST240: ${title} (002) SP25`, "SP25 HIST 240 002"));
    assert.equal(label.displayTitle, title);
    assert.equal(label.context.termToken, "SP25"); // Older term is displayed, never filtered.
    assert.equal(label.removedSpans[1].start, label.rawName.length - " (002) SP25".length);
  }
});

test("subject, number, section, and term disagreements preserve raw source exactly", () => {
  for (const code of ["FA26 PHYS 101 001", "FA26 ASTRO 102 001", "FA26 ASTRO 101 002", "SP26 ASTRO 101 001"]) {
    const source = input(undefined, code);
    const label = projectCourseLabel(source);
    assert.equal(label.displayTitle, source.resource.courseName);
    assert.equal(label.reason, "metadata-mismatch");
    assert.equal(label.displayCode, undefined);
    assert.deepEqual(label.removedSpans, []);
    assert.deepEqual(label.identity, { accountScope: "account-1", courseId: "course-1" });
  }
});

test("unknown, crosslisted, multiple-section, whitespace and absent metadata fail closed", () => {
  const cases = [
    input("ASTRO/PHYS101: Shared title (001) FA26"),
    input(undefined, "FA26 ASTRO/PHYS 101 001"),
    input(undefined, "FA26 ASTRO 101 001/002"),
    input("COMP SCI101: Title (001) FA26", "FA26 COMP SCI 101 001"),
    input("ASTRO101: Shared title (001/002) FA26"),
    input("ASTRO101:  Leading space (001) FA26"),
    input(" ASTRO101: Title (001) FA26"),
    input("ASTRO101: Title (001) FA26\n"),
    input("ASTRO101: Title (001) SU26", "SU26 ASTRO 101 001"),
    input("Unknown: meaningful (parenthesis)"),
  ];
  const missing = input(); delete missing.resource.course; cases.push(missing);
  for (const source of cases) {
    const label = projectCourseLabel(source);
    assert.equal(label.method, "raw");
    assert.equal(label.displayTitle, source.resource.courseName);
    assert.deepEqual(label.removedSpans, []);
    assert.deepEqual(label.identity, { accountScope: "account-1", courseId: "course-1" });
  }
});

test("source/account join must be valid and assignment names are not course metadata", () => {
  for (const patch of [{ id: "other-source" }, { courseId: "other-course" }, { accountScope: "" }]) {
    const source = input(); Object.assign(source.source, patch);
    const label = projectCourseLabel(source);
    assert.equal(label.reason, "source-mismatch");
    assert.equal(label.identity, null);
    assert.equal(label.displayTitle, source.resource.courseName);
  }
  const source = input(); source.resource.kind = "assignment";
  assert.equal(projectCourseLabel(source).reason, "not-course");
  assert.deepEqual(projectCourseLabel(source).identity, { accountScope: "account-1", courseId: "course-1" });
});

test("same compact title never merges accounts, sections or source revisions", () => {
  const first = input();
  const otherAccount = input(); otherAccount.source.accountScope = "account-2";
  const otherSection = input("ASTRO101: Principles of Stellar Ecology (002) FA26", "FA26 ASTRO 101 002");
  otherSection.resource.courseId = otherSection.source.courseId = "course-2";
  const labels = [first, otherAccount, otherSection].map(projectCourseLabel);
  assert.equal(new Set(labels.map(label => label.displayTitle)).size, 1);
  assert.equal(new Set(labels.map(label => JSON.stringify(label.identity))).size, 3);
  assert.notEqual(labels[0].context.section, labels[2].context.section);
  const changed = structuredClone(first);
  changed.resource.courseName = "ASTRO101: New meaningful name (001) FA26";
  changed.resource.version++; changed.resource.contentHash = "changed-hash";
  assert.deepEqual(projectCourseLabel(changed).identity, labels[0].identity);
  assert.notDeepEqual(projectCourseLabel(changed).evidence, labels[0].evidence);
});
