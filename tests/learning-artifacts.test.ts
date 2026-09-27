import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptArtifact, parseDate } from "../packages/learning/src/artifacts";
import { exactValidate, smokeResources } from "./learning-fixtures";

const resources = smokeResources().map((r) => ({ id: r.id, version: 1, contentHash: r.contentHash, text: r.text }));
const ctx = { resources, validate: exactValidate };
const L2 = "syn101-lecture-2";
const SYL = "syn101-syllabus";

test("a study guide keeps quote-valid entries and drops and counts the rest (NB-8)", () => {
  const out = acceptArtifact(
    "study_guide",
    {
      title: "Exam 1 guide",
      sections: [
        { heading: "Recurrences", points: [
          { text: "Merge sort satisfies T(n) = 2T(n/2) + n.", citations: [{ resourceId: L2, quote: "Its running time satisfies T(n) = 2T(n/2) + n." }] },
          { text: "Merge sort is quadratic.", citations: [{ resourceId: L2, quote: "Merge sort runs in quadratic time." }] },
        ] },
        { heading: "Invented", points: [{ text: "A paraphrase.", citations: [{ resourceId: L2, quote: "the tree has log n levels" }] }] },
      ],
    },
    ctx,
  );
  assert.equal(out.removed, 2);
  assert.equal(out.body.sections.length, 1);
  assert.equal(out.body.sections[0]!.points.length, 1);
  assert.equal(out.citations.length, 1);
  const c = out.citations[0]!;
  assert.equal(resources.find((r) => r.id === L2)!.text.slice(c.start, c.end), c.quote);
  assert.equal(c.support, "not_checked");
});

test("faq, glossary and briefing validate the same way; a malformed body throws", () => {
  const faq = acceptArtifact("faq", { items: [
    { question: "What is a collision?", answer: "Two keys in one bucket.", citations: [{ resourceId: "syn101-lecture-3", quote: "When two keys map to the same bucket, the table has a collision." }] },
    { question: "Unknown resource?", answer: "x", citations: [{ resourceId: "nope", quote: "When two keys map to the same bucket" }] },
  ] }, ctx);
  assert.equal(faq.body.items.length, 1);
  assert.equal(faq.removed, 1);
  const glossary = acceptArtifact("glossary", { terms: [{ term: "Load factor", definition: "keys / buckets", citations: [{ resourceId: "syn101-lecture-3", quote: "The load factor alpha is the number of stored keys divided by the number of buckets." }] }] }, ctx);
  assert.equal(glossary.removed, 0);
  assert.throws(() => acceptArtifact("briefing", { items: [{ text: "x" }] }, ctx));
  assert.throws(() => acceptArtifact("faq", { items: [], extra: 1 }, ctx));
});

test("timeline: every date parses and occurs in its entry's quote", () => {
  const out = acceptArtifact("timeline", { entries: [
    { date: "October 8", label: "Exam 1", citations: [{ resourceId: SYL, quote: "Exam 1 is on October 8." }] },
    { date: "November 5", label: "Exam 2", citations: [{ resourceId: SYL, quote: "Exam 2 is on November 5." }] },
  ] }, ctx);
  assert.equal(out.removed, 0);
  assert.equal(out.body.entries.length, 2);
  assert.deepEqual(parseDate("2026-10-08"), { year: 2026, month: 10, day: 8 });
  assert.deepEqual(parseDate("Oct 8, 2026"), { year: 2026, month: 10, day: 8 });
  assert.equal(parseDate("February 30"), null);
  assert.equal(parseDate("next Tuesday"), null);
});

test("negative: a timeline entry whose date isn't in its quote is dropped; so is one whose date doesn't parse", () => {
  const out = acceptArtifact("timeline", { entries: [
    { date: "October 9", label: "Exam 1", citations: [{ resourceId: SYL, quote: "Exam 1 is on October 8." }] },
    { date: "sometime in fall", label: "Exam 1", citations: [{ resourceId: SYL, quote: "Exam 1 is on October 8." }] },
    { date: "October 8", label: "Exam 1", citations: [{ resourceId: SYL, quote: "Exam 1 covers Module 1 and Module 2." }] },
  ] }, ctx);
  assert.equal(out.body.entries.length, 0);
  assert.equal(out.removed, 3);
  assert.equal(out.citations.length, 0, "a dropped entry leaves no citation behind");
});
