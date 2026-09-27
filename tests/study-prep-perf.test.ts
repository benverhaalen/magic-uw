// owner: study-prep. `study.prep` answers from the local database well under 100 ms (median of 40
// warm calls; the cold first call is excluded) on a 5,000-resource store with a course map, a
// stated exam scope, material facts and a practice history. The p95 is logged, not gated, for the
// same reason as tests/mastery-perf.test.ts. 0 tokens: no runner exists here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textHash } from "@magic/retrieval";
import { createStore } from "../packages/storage/src/index";
import { syntheticCorpus } from "../evals/perf/synthetic";
import { studyPrepQuery } from "../packages/core/src/study-prep/query";
import type { Concept } from "../packages/learning/src/store";
import type { StudyPrepResult } from "@magic/contracts";

const now = new Date("2026-10-20T15:00:00.000Z");
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.95 * xs.length) - 1]!;
const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

test("study.prep median < 100 ms over 40 warm calls on a 5,000-resource store (0 tokens)", { timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-study-prep-perf-"));
  const store = createStore(join(dir, "workspace.sqlite"), { now: () => now });
  try {
    for (const b of syntheticCorpus(5000, "2026-09-26T15:00:00.000Z").batches) store.ingest(b);
    const course = store.resources().filter((r) => r.courseId === "perf-101");
    const materials = course.filter((r) => r.kind === "material");
    const at = now.toISOString();
    // A syllabus-like material states the exam's scope; the exam is on the course map.
    const syllabus = materials[0]!;
    const quote = syllabus.text.slice(0, 80);
    store.putAssessment({ id: "perf-mid", sourceId: syllabus.sourceId, resourceId: null, kind: "midterm", title: "Midterm 2", date: "2026-11-05", weight: 25, format: null, origin: "syllabus" }, at);
    const scope = store.putAssessmentScope({ id: "perf-scope", assessmentId: "perf-mid", stated: quote, evidence: { resourceId: syllabus.id, version: syllabus.version, quote }, windowStart: "2026-10-01", windowEnd: "2026-11-05", status: "settled", rung: "code" }, at);
    assert.equal(scope.ok, true, JSON.stringify(scope));
    // Terms on 60 materials, as the material pipeline would record them.
    for (const r of materials.slice(0, 60)) {
      const word = r.text.slice(0, r.text.indexOf(" ") > 0 ? r.text.indexOf(" ") : 10);
      const put = store.putMaterialFacts({ resourceId: r.id, textHash: textHash(r.title, r.text), analyzerVersion: "perf.v1", facts: [{ kind: "term", value: word, basis: "text", start: 0, end: word.length }] });
      assert.equal(put.ok, true, JSON.stringify(put));
    }
    // 8 modules × 5 topics, each topic citing two materials; coverage rows put modules 4–6 in scope.
    const learning = store.learning;
    const ref = learning.course("perf-synthetic", "perf-101").id;
    const map: Concept[] = [];
    for (let m = 0; m < 8; m++) {
      map.push({ id: `m${m}`, courseRef: ref, parentId: null, label: `Module ${m + 1}`, kind: "unit", position: m, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "p1", sources: [] });
      for (let t = 0; t < 5; t++) {
        const cite = [materials[(m * 5 + t) * 2]!, materials[(m * 5 + t) * 2 + 1]!].map((r) => ({ resourceId: r.id, contentHash: r.contentHash, start: 0, end: 40, quote: r.text.slice(0, 40), quoteValid: true }));
        map.push({ id: `t${m}-${t}`, courseRef: ref, parentId: `m${m}`, label: `Topic ${m + 1}.${t + 1}`, kind: "concept", position: t, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "p1", sources: cite });
      }
    }
    learning.putConceptMap(ref, map, "p1");
    learning.putCoverage(
      map
        .filter((c) => c.kind === "concept" && ["m3", "m4", "m5"].includes(c.parentId!))
        .map((c) => ({ assessmentId: "perf-mid", conceptId: c.id, basis: "stated" as const, tier: "T2" as const, evidenceResourceId: syllabus.id, start: 0, end: 80, quote, status: "confirmed" as const, decidedByStudent: false })),
    );

    const call = () => studyPrepQuery(store, { view: "study.prep", courseId: "perf-101", assessmentId: "perf-mid" }, at);
    const cold0 = performance.now();
    const first = call();
    const cold = performance.now() - cold0;
    assert.equal(first.status, "ok", JSON.stringify(first).slice(0, 300));
    const ok = first as Extract<StudyPrepResult, { status: "ok" }>;
    assert.equal(ok.overview.topics.length, 15);
    assert.ok(ok.sources.length >= 30, `${ok.sources.length} sources`);
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      const r = call();
      samples.push(performance.now() - t0);
      assert.equal(r.status, "ok");
    }
    console.log(`STUDY-PREP-PERF ${JSON.stringify({ resources: 5000, courseResources: course.length, sources: ok.sources.length, topics: ok.overview.topics.length, coldMs: +cold.toFixed(1), p50Ms: +p50(samples).toFixed(1), p95Ms: +p95(samples).toFixed(1) })}`);
    assert.ok(p50(samples) < 100, `median ${p50(samples).toFixed(1)} ms (p95 ${p95(samples).toFixed(1)} ms, logged only)`);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
