// Study guides, step 2: personalisation is pure code. Weak topics first, weak and untested
// marked, "Common confusions for you" from item text with quotes kept, "Study this next", and
// the cached document unchanged. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { personalizeConceptMap, personalizeGuide, type ConceptMapDoc, type GuideDoc, type PersonalSignals } from "../packages/packs/guide/src/index";

const src = (resourceId: string, start: number, quote: string) => ({ sourceId: "p1", quote, resourceId, start, end: start + quote.length });
const section = (id: string, topic: string) => ({
  id,
  title: `${topic} section`,
  topics: [topic],
  columns: null,
  blocks: [{ id: `${id}b0`, kind: "point" as const, topic, heading: null, text: `${topic} text`, expression: null, result: null, date: null, cells: null, source: src("r1", 10, `${topic} quote`), computed: null }],
});
const GUIDE: GuideDoc = { kind: "guide", title: "Guide", sections: [section("s0", "Stacks"), section("s1", "Queues"), section("s2", "Hashing"), section("s3", "Heaps")] };
const anchor = (resourceId: string, start: number) => ({ resourceId, start, end: start + 12, quote: "anchor quote" });
const signals = (over: Partial<PersonalSignals> = {}): PersonalSignals => ({
  states: [
    { conceptId: "c-stack", label: "Stacks", state: "solid" },
    { conceptId: "c-queue", label: "Queues", state: "iffy" },
    { conceptId: "c-hash", label: "Hashing", state: "getting_there" },
  ],
  pairs: [],
  distractors: [],
  labels: { "c-stack": "Stacks", "c-queue": "Queues", "c-hash": "Hashing" },
  resources: { r1: { version: 3, title: "Synthetic reading" } },
  anchors: { "c-queue": anchor("r1", 50) },
  ...over,
});

test("sections reorder weak first, then developing, untested, solid; each is marked", () => {
  const v = personalizeGuide(GUIDE, signals());
  assert.deepEqual(v.sections.map((s) => [s.topics[0], s.mark]), [["Queues", "weak"], ["Hashing", "developing"], ["Heaps", "untested"], ["Stacks", "solid"]]);
  assert.deepEqual(v.summary, { weak: 1, developing: 1, untested: 1, solid: 1 });
});

test("study this next: weak before developing before untested, each anchored (map anchor, else the guide's own quote), at most 3", () => {
  const v = personalizeGuide(GUIDE, signals());
  assert.deepEqual(v.studyNext.map((n) => [n.label, n.mark]), [["Queues", "weak"], ["Hashing", "developing"], ["Heaps", "untested"]]);
  assert.deepEqual(v.studyNext[0]!.anchor, { resourceId: "r1", version: 3, start: 50, end: 62, label: "Synthetic reading", valid: true });
  assert.equal(v.studyNext[1]!.quote, "Hashing quote", "no map anchor: the guide block's grounded span");
  assert.deepEqual(v.studyNext[0]!.quick, { op: "practice.quick", conceptId: "c-queue", minutes: 5 });
});

test("common confusions for you: pairs and distractors from item text, with their quotes; none without evidence", () => {
  const none = personalizeGuide(GUIDE, signals());
  assert.deepEqual(none.confusions, []);
  const v = personalizeGuide(
    GUIDE,
    signals({
      pairs: [{ asked: "c-queue", answeredAs: "c-stack", count: 3, anchors: { asked: [anchor("r1", 50)], answeredAs: [anchor("r1", 0)] }, compare: ["q1", "q2"], evidenceIds: ["a1", "a2", "a3"] }],
      distractors: [
        { itemId: "q1", optionId: "b", optionText: "A stack", count: 2, tempting: null, anchors: [anchor("r1", 80)], evidenceIds: ["a1", "a2"], stem: "Which collection is first-in, first-out?", conceptId: "c-queue" },
        { itemId: "q9", optionId: "c", optionText: "Other", count: 4, tempting: null, anchors: [anchor("r1", 80)], evidenceIds: [], stem: "Out of scope", conceptId: "c-graph" },
      ],
    }),
  );
  assert.deepEqual(v.confusions.map((c) => [c.kind, c.text]), [
    ["confusable_pair", "You answered Queues questions as Stacks 3 times."],
    ["frequent_distractor", 'On "Which collection is first-in, first-out?" you chose "A stack" 2 times.'],
  ]);
  assert.equal(v.confusions[0]!.quotes.length, 2);
  assert.deepEqual(v.confusions[0]!.compare, ["q1", "q2"]);
});

test("the cached document is never changed, and the same inputs give the same view", () => {
  const before = JSON.stringify(GUIDE);
  const a = personalizeGuide(GUIDE, signals());
  a.sections[0]!.blocks[0]!.source.quote = "mutated";
  assert.equal(JSON.stringify(GUIDE), before);
  assert.deepEqual(personalizeGuide(GUIDE, signals()), personalizeGuide(GUIDE, signals()));
});

test("concept map: nodes marked; the student's confusions add personal confused_with edges", () => {
  const map: ConceptMapDoc = {
    kind: "conceptmap",
    title: "Map",
    nodes: [
      { id: "n1", label: "Stacks", source: src("r1", 0, "Stacks quote"), reason: null },
      { id: "n2", label: "Queues", source: null, reason: "a topic on the course map" },
    ],
    edges: [],
  };
  const v = personalizeConceptMap(map, signals({ pairs: [{ asked: "c-queue", answeredAs: "c-stack", count: 2, anchors: { asked: [anchor("r1", 50)], answeredAs: [] }, compare: [], evidenceIds: [] }] }));
  assert.deepEqual(v.nodes.map((n) => [n.label, n.mark]), [["Stacks", "solid"], ["Queues", "weak"]]);
  assert.deepEqual(v.edges.map((e) => [e.from, e.to, e.kind, e.personal]), [["n2", "n1", "confused_with", true]]);
  assert.deepEqual(map.edges, [], "the artifact's edges are untouched");
});
