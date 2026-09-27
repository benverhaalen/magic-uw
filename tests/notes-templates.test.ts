// Notes: templates, the subject family and suggestTemplate's rules (code only, 0 tokens).
import test from "node:test";
import assert from "node:assert/strict";
import { noteBlockSchema, noteTemplateIds } from "@magic/contracts";
import { subjectFamily, subjectOf, suggestTemplate, templateBlocks, templateInfo } from "../packages/notes/src/templates/index";

test("every template is a typed block schema that validates", () => {
  assert.equal(templateInfo().length, noteTemplateIds.length);
  for (const id of noteTemplateIds) {
    const blocks = templateBlocks(id);
    assert.ok(blocks.length >= 2, id);
    for (const b of blocks) noteBlockSchema.parse(b);
    assert.equal(new Set(blocks.map((b) => b.id)).size, blocks.length, `${id} has unique block ids`);
  }
  assert.deepEqual(
    templateBlocks("cornell").map((b) => b.kind),
    ["cues", "section", "summary"],
  );
  assert.ok(templateBlocks("worked-problem").some((b) => b.kind === "problems"));
  assert.ok(templateBlocks("concept-code-pitfalls").some((b) => b.kind === "code"));
  assert.ok(templateBlocks("lab-notebook").some((b) => b.kind === "procedure"));
  assert.ok(templateBlocks("vocab-grammar").some((b) => b.kind === "grammar"));
});

test("the subject code and title decide the family", () => {
  assert.deepEqual(subjectOf({ courseName: "COMPSCI400: Programming III (001) FA26", courseCode: "FA26 COMPSCI 400 001" }), {
    subject: "COMPSCI",
    catalog: "400",
  });
  assert.deepEqual(subjectOf({ courseName: "ECE 203: Signals, Information, and Computation FA26" }), { subject: "ECE", catalog: "203" });
  const family = (courseName: string, courseCode?: string) => subjectFamily({ courseName, courseCode }).family;
  assert.equal(family("COMPSCI400: Programming III (001) FA26"), "computing");
  assert.equal(family("COMPSCI240: Introduction to Discrete Mathematics (001) FA26"), "math");
  assert.equal(family("ECE 203: Signals, Information, and Computation FA26"), "engineering");
  assert.equal(family("ENGL177: Literature and Popular Culture (001) FA26"), "humanities");
  assert.equal(family("PHILOS101: Introduction to Philosophy (004) FA26"), "humanities");
  assert.equal(family("SPANISH102: Second Semester Spanish"), "languages");
  assert.equal(family("Intro course", "FA26 ACCT I S 100 001"), "business");
  assert.equal(family("PSYCH202: Introduction to Psychology"), "social_science");
  assert.equal(family("Orientation"), "unknown");
});

test("suggestTemplate: lectures by family, discussions and labs by session type", () => {
  const pick = (courseName: string, type: "lecture" | "discussion" | "lab" | "other") => suggestTemplate({ courseName }, { type }).template;
  assert.equal(pick("COMPSCI400: Programming III", "lecture"), "concept-code-pitfalls");
  assert.equal(pick("COMPSCI240: Introduction to Discrete Mathematics", "lecture"), "worked-problem");
  assert.equal(pick("MATH234: Calculus--Functions of Several Variables", "lecture"), "worked-problem");
  assert.equal(pick("PHYSICS201: General Physics", "lecture"), "worked-problem");
  assert.equal(pick("ENGL177: Literature and Popular Culture", "lecture"), "cornell");
  assert.equal(pick("ENGL177: Literature and Popular Culture", "discussion"), "reading-response");
  assert.equal(pick("PSYCH202: Introduction to Psychology", "discussion"), "discussion-prep");
  assert.equal(pick("ECE 203: Signals, Information, and Computation", "lab"), "lab-notebook");
  assert.equal(pick("SPANISH102: Second Semester Spanish", "lab"), "vocab-grammar");
  assert.equal(pick("FINANCE300: Corporate Finance", "lecture"), "case-method");
  assert.equal(pick("Orientation", "other"), "outline");
  assert.match(suggestTemplate({ courseName: "COMPSCI240: Introduction to Discrete Mathematics" }, { type: "lecture" }).reason, /mathematics/);
});
