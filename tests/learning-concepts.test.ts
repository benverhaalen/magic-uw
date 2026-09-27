import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptMap,
  applyEdits,
  candidates,
  conceptId,
  displayLabel,
  proposalFromCandidates,
  rebuildMap,
} from "../packages/learning/src/concepts";
import { validateTags } from "../packages/learning/src/tags";
import { COURSE, exactValidate, smokeResources } from "./learning-fixtures";

const resources = smokeResources();

function codeMap(version = "m1", res = resources) {
  const result = acceptMap(proposalFromCandidates(candidates(res)), { courseRef: COURSE, resources: res, validate: exactValidate, mapVersion: version });
  assert.equal(result.ok, true, result.errors.join("; "));
  return result.concepts;
}

test("candidates lists syllabus schedule headings and lecture titles, each with a source quote", () => {
  const c = candidates(resources);
  const units = c.filter((x) => x.kind === "unit").map((x) => x.label);
  assert.deepEqual(units, ["Asymptotic analysis", "Recurrences", "Hashing"]);
  const lectures = c.filter((x) => x.reason === "lecture");
  assert.deepEqual(lectures.map((x) => x.label), ["Asymptotic analysis", "Recurrences", "Hashing"]);
  for (const x of c) assert.ok(x.quote && resources.find((r) => r.id === x.resourceId)!.text.includes(x.quote), x.label);
  const moduleRes = { id: "mod-9", kind: "material", title: "Module 9: Graphs", text: "Module 9: Graphs and traversal", contentHash: "h", module: { position: 9 } };
  assert.ok(candidates([moduleRes]).some((x) => x.reason === "module" && x.label === "Graphs"));
});

test("acceptMap validates quotes and structure; an unquoted concept is kept as origin model with no source", () => {
  const map = codeMap();
  assert.ok(map.filter((c) => c.kind === "unit").length >= 1);
  for (const c of map) {
    assert.equal(c.origin, "code");
    assert.equal(c.sources.length, 1);
    assert.equal(c.sources[0]!.quoteValid, true);
  }
  const result = acceptMap(
    { units: [{ label: "Hashing", resourceId: "syn101-syllabus", quote: "Module 3: Hashing (weeks 5-6).", concepts: [
      { label: "Cuckoo hashing", resourceId: "syn101-lecture-3", quote: "Cuckoo hashing uses two tables.", origin: "model" },
      { label: "Load factor", resourceId: "syn101-lecture-3", quote: "The load factor alpha is the number of stored keys", origin: "model" },
    ] }] },
    { courseRef: COURSE, resources, validate: exactValidate, mapVersion: "m1" },
  );
  const cuckoo = result.concepts.find((c) => c.label === "Cuckoo hashing")!;
  assert.equal(cuckoo.origin, "model");
  assert.deepEqual(cuckoo.sources, []);
  assert.deepEqual(result.unsourced, [cuckoo.id]);
  assert.equal(result.concepts.find((c) => c.label === "Load factor")!.sources.length, 1);
  assert.equal(acceptMap({ units: [] }, { courseRef: COURSE, resources, validate: exactValidate, mapVersion: "m1" }).ok, false);
});

test("negative: a rebuild never drops or overwrites a student edit (KM-1)", () => {
  const first = codeMap("m1");
  const rec = conceptId(COURSE, "unit", "Recurrences");
  const hash = conceptId(COURSE, "concept", "Hashing");
  const own = { ...first[0]!, id: `${COURSE}#concept:my-own`, label: "Amortised analysis", origin: "student" as const, sources: [] };
  const edits = [
    { conceptId: rec, edit: { kind: "rename" as const, label: "Solving recurrences" } },
    { conceptId: hash, edit: { kind: "hide" as const } },
  ];
  const edited = applyEdits([...first, own], edits);
  // Rebuild from material where the syllabus no longer lists Module 2, with the edit log re-applied.
  const changed = resources.map((r) => (r.id === "syn101-syllabus" ? { ...r, text: r.text.replace("Module 2: Recurrences (weeks 3-4).\n", "") } : r));
  const rebuilt = rebuildMap(edited, codeMap("m2", changed), edits);
  const byId = new Map(rebuilt.map((c) => [c.id, c]));
  assert.equal(displayLabel(byId.get(rec)!), "Solving recurrences", "a renamed unit that the new map dropped is kept");
  assert.equal(byId.get(hash)!.status, "hidden");
  assert.ok(byId.has(own.id), "a student-made concept survives");
  // Restore still works after the rebuild.
  const restored = applyEdits(rebuilt, [{ conceptId: hash, edit: { kind: "restore" } }]);
  assert.equal(restored.find((c) => c.id === hash)!.status, "active");
});

test("validateTags requires 1–3 concepts of the same course with exactly one primary", () => {
  const map = codeMap();
  const [a, b] = map.filter((x) => x.kind === "concept").concat(map.filter((x) => x.kind === "unit")).map((x) => x.id);
  const ok = validateTags([{ conceptId: a!, primary: true }, { conceptId: b!, primary: false }], COURSE, map);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.tags.map((t) => t.weight), [1, 0.5]);
});

test("negative: 0 tags, 4 tags, an unknown ID, another course's ID and two primaries are each rejected (KM-2)", () => {
  const map = codeMap();
  const ids = map.map((x) => x.id);
  const other = { ...map[0]!, id: "other:X#concept:x", courseRef: "other:X" };
  const cases: [string, { conceptId: string; primary: boolean }[]][] = [
    ["0 tags", []],
    ["4 tags", ids.slice(0, 4).map((id, i) => ({ conceptId: id, primary: i === 0 }))],
    ["unknown", [{ conceptId: `${COURSE}#concept:nope`, primary: true }]],
    ["other course", [{ conceptId: other.id, primary: true }]],
    ["two primaries", [{ conceptId: ids[0]!, primary: true }, { conceptId: ids[1]!, primary: true }]],
    ["no primary", [{ conceptId: ids[0]!, primary: false }]],
  ];
  for (const [name, tags] of cases) assert.equal(validateTags(tags, COURSE, [...map, other]).ok, false, name);
});
