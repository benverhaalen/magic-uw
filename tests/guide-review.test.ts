// Study guides, step 1: the schema and the code checks (quotes, worked examples, dates,
// comparison shape, concept-map edges). Synthetic passages only.
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  GUIDE_KINDS,
  GUIDE_PACKS,
  datesIn,
  guideCheck,
  recompute,
  reviewConceptMap,
  reviewGuide,
  type ConceptMapOutput,
  type GuideBlockOutput,
  type GuideInput,
  type GuideOutput,
} from "../packages/packs/guide/src/index";
import { strictSchemaIssues } from "../packages/packs/core/src/index";

const P = [
  { sourceId: "p1", text: "A stack is a last-in, first-out collection of elements. A queue is a first-in, first-out collection of elements." },
  { sourceId: "p2", text: "Each list node holds 4 bytes, so 25 nodes use 100 bytes in total. The midterm is on October 14, 2026." },
];
const input = (over: Partial<GuideInput> = {}): GuideInput => ({ kind: "guide", scope: "Module m1", materials: ["Synthetic reading"], topics: ["Stacks", "Queues"], facts: [], dates: [], ...over });
const block = (over: Partial<GuideBlockOutput>): GuideBlockOutput => ({
  kind: "point",
  topic: "Stacks",
  heading: null,
  text: "A stack returns the most recently added element first.",
  expression: null,
  result: null,
  date: null,
  cells: null,
  sourceId: "p1",
  quote: "A stack is a last-in, first-out collection of elements.",
  ...over,
});
const doc = (blocks: GuideBlockOutput[], columns: string[] | null = null): GuideOutput => ({ title: "Synthetic guide", sections: [{ title: "Linear structures", topics: ["Stacks"], columns, blocks }] });

test("every guide kind is a strict pack with a versioned id", () => {
  assert.deepEqual(Object.keys(GUIDE_PACKS).sort(), [...GUIDE_KINDS].sort());
  for (const pack of Object.values(GUIDE_PACKS)) {
    assert.match(pack.version, /^v\d+$/);
    assert.deepEqual(strictSchemaIssues(z.toJSONSchema(pack.schema, { io: "output" })), []);
  }
});

test("quotes: a verbatim quote is kept (with its resource span when code can place it); an invented or wrong-source quote is dropped", () => {
  const r = reviewGuide(
    "guide",
    doc([block({}), block({ quote: "Stacks were invented in 1946." }), block({ sourceId: "p9" }), block({ quote: "A stack" })]),
    input(),
    P,
    (sourceId, quote) => (sourceId === "p1" ? { resourceId: "r1", start: 0, end: quote.length, quote } : null),
  );
  assert.equal(r.stats.generated, 4);
  assert.equal(r.stats.accepted, 1);
  assert.deepEqual(r.stats.quoteChecks, { passed: 1, total: 4 });
  assert.deepEqual(r.drops.map((d) => d.code), ["quote", "quote", "quote"]);
  assert.match(r.drops[0]!.reason, /not found verbatim/);
  assert.match(r.drops[1]!.reason, /not among the passages/);
  assert.match(r.drops[2]!.reason, /shorter than/);
  assert.deepEqual(r.doc.sections[0]!.blocks[0]!.source, { sourceId: "p1", quote: P[0]!.text.slice(0, 55), resourceId: "r1", start: 0, end: 55 });
});

test("worked examples: code recomputes the expression and drops a mismatch", () => {
  assert.deepEqual(recompute("25 * 4 bytes", "100 bytes"), { ok: true, computed: "100 bytes" });
  assert.equal(recompute("10 / 3", "3.33").ok, true, "rounded to the decimals shown");
  assert.equal(recompute("1,000 + 24", "1,024").ok, true, "thousands separators");
  assert.equal(recompute("25 * 4", "120").ok, false);
  assert.equal(recompute("print(1)", "1").ok, false, "only arithmetic evaluates");
  const ex = (expression: string, result: string) => block({ kind: "example", topic: "Memory use", expression, result, sourceId: "p2", quote: "Each list node holds 4 bytes, so 25 nodes use 100 bytes in total." });
  const r = reviewGuide("guide", doc([ex("25 * 4 bytes", "100 bytes"), ex("25 * 4 bytes", "125 bytes"), block({ kind: "example", expression: "25*4", result: null })]), input(), P);
  assert.equal(r.stats.accepted, 1);
  assert.deepEqual(r.stats.arithmetic, { checked: 2, mismatches: 1 });
  assert.deepEqual(r.drops.map((d) => d.code), ["arithmetic", "shape"]);
  assert.equal(r.doc.sections[0]!.blocks[0]!.computed, "100 bytes");
});

test("dates: a timeline date must parse and match a course date or a date in its quote", () => {
  assert.deepEqual(datesIn("The midterm is on October 14, 2026; review Oct. 12 and 10/13."), ["2026-10-14", "--10-12", "--10-13"]);
  const ev = (date: string, quote = "The midterm is on October 14, 2026.") => block({ kind: "event", topic: "Midterm", date, sourceId: "p2", quote });
  const r = reviewGuide(
    "timeline",
    doc([ev("2026-10-14"), ev("2026-10-15"), ev("2026-02-30"), ev("2026-11-02", "Each list node holds 4 bytes, so 25 nodes use 100 bytes in total.")]),
    input({ kind: "timeline", dates: ["2026-11-02"] }),
    P,
  );
  assert.equal(r.stats.accepted, 2, "the quoted date and the canonical date");
  assert.deepEqual(r.stats.dates, { checked: 4, mismatches: 2 });
  assert.deepEqual(r.drops.map((d) => d.code), ["date", "date"]);
  assert.deepEqual(r.doc.sections[0]!.blocks.map((b) => b.date), ["2026-10-14", "2026-11-02"], "sorted by date");
});

test("kinds and shapes: a block outside its kind is dropped; a comparison row needs one cell per column", () => {
  const row = (cells: string[]) => block({ kind: "row", heading: "Order", cells, text: "Which element leaves first." });
  const r = reviewGuide("compare", doc([row(["Last in, first out", "First in, first out"]), row(["LIFO"]), block({ kind: "question", heading: "Why?" })], ["Stack", "Queue"]), input({ kind: "compare" }), P);
  assert.equal(r.stats.accepted, 1);
  assert.deepEqual(r.drops.map((d) => d.code), ["shape", "kind"]);
  const faq = reviewGuide("faq", doc([block({ kind: "question", heading: null })]), input({ kind: "faq" }), P);
  assert.equal(faq.drops[0]!.code, "shape");
  assert.equal(faq.doc.sections.length, 0, "a section with nothing kept is left out");
});

test("concept map: nodes need a quote or a course topic; edges need a quote or a code-derived reason", () => {
  const out: ConceptMapOutput = {
    title: "Map",
    nodes: [
      { id: "n1", label: "Stacks", sourceId: "p1", quote: "A stack is a last-in, first-out collection of elements." },
      { id: "n2", label: "Queues", sourceId: null, quote: null },
      { id: "n3", label: "Linear structures", sourceId: null, quote: null },
      { id: "n4", label: "Invented topic", sourceId: null, quote: null },
    ],
    edges: [
      { from: "n1", to: "n3", kind: "part_of", sourceId: null, quote: null },
      { from: "n2", to: "n1", kind: "confused_with", sourceId: "p1", quote: "A queue is a first-in, first-out collection of elements." },
      { from: "n2", to: "n1", kind: "prerequisite", sourceId: null, quote: null },
      { from: "n1", to: "n4", kind: "part_of", sourceId: null, quote: null },
    ],
  };
  const r = reviewConceptMap(out, input({ kind: "conceptmap", topics: ["Stacks", "Queues", "Linear structures", "Stacks > Linear structures"] }), P);
  assert.deepEqual(r.doc.nodes.map((n) => n.id), ["n1", "n2", "n3"]);
  assert.deepEqual(r.doc.edges.map((e) => [e.from, e.to, e.kind]), [["n1", "n3", "part_of"], ["n2", "n1", "confused_with"]]);
  assert.match(r.doc.edges[0]!.reason!, /course map places Stacks under Linear structures/);
  assert.deepEqual(r.drops.map((d) => d.code), ["node", "edge", "edge"]);
});

test("the pack check asks for a retry only when fewer than half the blocks survive", () => {
  const check = guideCheck<GuideOutput>("guide");
  const ctx = { passages: P };
  assert.deepEqual(check(doc([block({}), block({ quote: "invented text here" })]), input(), ctx), []);
  const errors = check(doc([block({}), block({ quote: "invented text here" }), block({ quote: "more invented text" })]), input(), ctx);
  assert.equal(errors.length, 2);
  assert.deepEqual(check({ title: "x", sections: [] }, input(), ctx), ["nothing was returned"]);
});
