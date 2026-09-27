// owner: mastery (D57). `course.mastery` stays within 30 ms (p95) on a 5,000-resource store with a
// realistic practice history, through the worker's own references port. 0 tokens: no runner exists here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../packages/storage/src/index";
import { syntheticCorpus, prng } from "../evals/perf/synthetic";
import { createPipelineReferences } from "../packages/core/src/graph/references-port";
import { createLearningRouter, type StudyContext } from "../packages/learning/src/router";
import { newCard, review } from "../packages/learning/src/fsrs";
import type { Concept, LearningAttempt } from "../packages/learning/src/store";
import type { CourseMasteryData } from "../packages/learning/src/mastery";

const now = new Date("2026-10-20T15:00:00.000Z");
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.95 * xs.length) - 1]!;
const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

test("course.mastery p95 ≤ 30 ms on a 5,000-resource store (0 tokens)", { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "magic-mastery-perf-"));
  const owner = createStore(join(dir, "workspace.sqlite"), { now: () => now });
  try {
    for (const b of syntheticCorpus(5000, "2026-09-26T15:00:00.000Z").batches) owner.ingest(b);
    const learning = owner.learning;
    const course = owner.resources().filter((r) => r.courseId === "perf-101");
    const materials = course.filter((r) => r.kind === "material");
    const assignments = course.filter((r) => r.kind === "assignment");
    const ref = learning.course("perf-synthetic", "perf-101").id;
    // 8 modules × 5 topics; each topic cites two materials.
    const map: Concept[] = [];
    for (let m = 0; m < 8; m++) {
      map.push({ id: `m${m}`, courseRef: ref, parentId: null, label: `Module ${m + 1}`, kind: "unit", position: m, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "p1", sources: [] });
      for (let t = 0; t < 5; t++)
        map.push({ id: `t${m}-${t}`, courseRef: ref, parentId: `m${m}`, label: `Topic ${m + 1}.${t + 1}`, kind: "concept", position: t, origin: "code", status: "active", mergedInto: null, studentLabel: null, mapVersion: "p1", sources: [] });
    }
    learning.putConceptMap(ref, map, "p1");
    const topics = map.filter((c) => c.kind === "concept");
    // 4 items per topic (2 families: MC + typed), each quoting its material.
    const random = prng(91);
    let n = 0;
    for (const [i, t] of topics.entries()) {
      for (const f of [0, 1]) {
        const mat = materials[(i * 2 + f) % materials.length]!;
        const quote = mat.text.slice(0, 60);
        for (const kind of ["mc", "typed"] as const) {
          const id = `i-${t.id}-${f}-${kind}`;
          learning.putItem(
            {
              id, version: 1, courseRef: ref, familyId: `${t.id}-${f}`, kind, stem: `Question ${++n}?`,
              options: kind === "mc" ? [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }] : null,
              key: kind === "mc" ? "a" : "answer", keyIdeas: kind === "typed" ? [{ idea: "answer", synonyms: [], required: true }] : [],
              explanation: null, tempting: {}, bloom: "understand", bPrior: kind === "mc" ? -0.5 : 0.5, tier: "T4", sourceTerm: null,
              origin: "generated", status: "active", statusReason: null, generator: null, createdAt: now.toISOString(),
            },
            [{ resourceId: mat.id, contentHash: mat.contentHash, textHash: "x", start: 0, end: quote.length, quote, quoteValid: true }],
            [{ conceptId: t.id, weight: 1, primary: true }],
            ["policy", "schema", "quote", "flaws", "near_duplicate", "tags"].map((check) => ({ check, method: "code" as const, outcome: "pass" as const, createdAt: now.toISOString() })),
          );
        }
      }
    }
    // 2,400 answers over 30 days, and 80 cards with 400 reviews.
    for (let k = 0; k < 2400; k++) {
      const t = topics[Math.floor(random() * topics.length)]!;
      const f = Math.floor(random() * 2);
      const kind = random() < 0.5 ? "mc" : "typed";
      const at = new Date(now.getTime() - Math.floor(random() * 30 * 86_400_000));
      const right = random() < 0.7;
      const a: LearningAttempt = {
        id: `att-${k}`, courseRef: ref, itemId: `i-${t.id}-${f}-${kind}`, itemVersion: 1, sourceResourceId: null, primaryConceptId: t.id,
        correct: right, assistance: "none", seenBefore: false, confidence: null, createdAt: at.toISOString(), format: kind, mode: "test",
        response: null, score: right ? 1 : 0, gradingMethod: "code", responseMs: 5000, conceptTags: [{ conceptId: t.id, weight: 1, primary: true }],
        sessionId: `s-${k % 300}`, localDay: at.toISOString().slice(0, 10),
      };
      learning.addAttempt(a);
    }
    for (const [i, t] of topics.entries()) {
      for (const f of [0, 1]) {
        let card = newCard({ id: `card-${t.id}-${f}`, itemId: `i-${t.id}-${f}-typed`, courseRef: ref, conceptId: t.id }, new Date(now.getTime() - 30 * 86_400_000));
        for (let r = 0; r < 5; r++) {
          const at = new Date(now.getTime() - (30 - r * 5 - (i % 4)) * 86_400_000);
          const rv = review(card, (random() < 0.8 ? 3 : 1) as 1 | 3, at, { id: `rv-${t.id}-${f}-${r}`, reviewMs: 3000, localDay: at.toISOString().slice(0, 10) });
          learning.putCard(rv.card);
          learning.addReview(rv.review);
          card = rv.card;
        }
      }
    }
    const texts = materials.map((r) => ({ id: r.id, contentHash: r.contentHash, text: r.text, title: r.title, url: r.url, observedAt: r.observedAt, eligible: true }));
    const context = (anchor: string): StudyContext => ({
      resourceId: anchor, accountScope: "perf-synthetic", courseId: "perf-101", inputHash: "in", contextHash: "ctx",
      label: "Perf", availability: "current", reason: "Ready", resources: texts,
    });
    const router = createLearningRouter({
      store: learning,
      resolveContext: (id) => (id === assignments[0]!.id ? context(id) : null),
      now: () => now,
      analyticsReferences: () => createPipelineReferences(owner),
      coursework: () => owner,
    });
    const signal = new AbortController().signal;
    const call = () => router.handle({ op: "course.mastery", courseId: "perf-101", anchorIds: [assignments[0]!.id] }, signal);
    const cold0 = performance.now();
    const first = await call();
    const cold = performance.now() - cold0;
    assert.equal(first.status, "ok", first.message);
    const data = first.data as CourseMasteryData;
    assert.equal(data.total, 40);
    assert.equal(data.modules.length, 8);
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      const res = await call();
      samples.push(performance.now() - t0);
      assert.equal(res.status, "ok");
    }
    console.log(`MASTERY-PERF ${JSON.stringify({ resources: 5000, courseResources: course.length, topics: 40, answers: 2400, reviews: 400, coldMs: +cold.toFixed(1), p50Ms: +p50(samples).toFixed(1), p95Ms: +p95(samples).toFixed(1) })}`);
    assert.ok(p95(samples) <= 30, `p95 ${p95(samples).toFixed(1)} ms`);
  } finally {
    owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
