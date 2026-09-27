import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import type { Store } from "@magic/contracts";
import { createIngestion } from "../apps/desktop/src/ingestion";
import { createSyntheticCanvasUniversity } from "../packages/connectors/src/canvas-fixture";
import { MaterialReadError, type PublicClient } from "../packages/connectors/src/network";
import {
  refreshEvidenceSuggestions,
  FUZZY_LINK_VERSION,
} from "../packages/core/src/fuzzy-links";

const origin = "https://canvas.wisc.edu";
/** Every public read is refused: this test exercises Canvas ingestion only, with no network. */
const offline: PublicClient = {
  isCanvas: (url: string) => new URL(url).origin === origin,
  async get() {
    throw new MaterialReadError("not_found");
  },
  async text() {
    throw new MaterialReadError("not_found");
  },
  async feed() {
    throw new MaterialReadError("not_found");
  },
  async signedDownload() {
    throw new MaterialReadError("not_found");
  },
} as unknown as PublicClient;

const fuzzyJudgments = (store: Store) =>
  store
    .judgments()
    .filter((j) => j.questionVersion === FUZZY_LINK_VERSION)
    .map((j) => `${j.key}@${j.createdAt}`)
    .sort();

test("a normal sync proposes supporting material with no student action; an unchanged sync rescores nothing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-fuzzy-ingestion-"));
  const store = createStore(join(directory, "coursework.sqlite"));
  let date = new Date("2026-09-26T17:00:00Z");
  const university = createSyntheticCanvasUniversity({ origin, rateLimit: false });
  store.setIngestionSettings({
    ...store.ingestionSettings(),
    jitterRatio: 0,
    quietHours: { enabled: false, start: 1, end: 6 },
  });
  const runtime = createIngestion(store, {
    directory,
    client: offline,
    now: () => date,
    async canvasFetch(url, init) {
      const response = await university.fetch(url, init);
      if (new URL(url).pathname !== "/api/v1/courses/101/assignments" || !response.ok) return response;
      const rows = (await response.json()) as Array<{ id: number; description: string }>;
      // Prose that names the spec page, with no URL: only a fuzzy match can connect them.
      for (const row of rows)
        if (row.id === 1099)
          row.description =
            "<p>Read the Full assignment specification first. Explain the method, show your steps, and cite course evidence.</p>";
      return new Response(JSON.stringify(rows), { status: response.status, headers: response.headers });
    },
    async secrets(operation) {
      if (operation === "list") return {};
    },
  });
  try {
    const first = await runtime.tick("manual");
    assert.equal(first?.action, "refreshed");
    const suggestions = store.links().filter((l) => l.id.startsWith("fuzzy:"));
    assert.ok(suggestions.length > 0, "a normal sync produced no suggestions");
    assert.ok(suggestions.every((l) => l.type === "supports" && l.status === "proposed"));
    const byId = new Map(store.resources().map((r) => [r.id, r]));
    const sources = new Map(store.sources().map((s) => [s.id, s]));
    const target = suggestions.find(
      (l) => byId.get(l.toId)?.courseId === "101" && byId.get(l.toId)?.externalId === "1099",
    );
    assert.equal(byId.get(target!.fromId)!.title, "Full assignment specification");
    // Never the student's own feedback, and never an account-level summary copy.
    for (const l of suggestions) {
      assert.ok(!byId.get(l.fromId)!.submission);
      assert.ok(!sources.get(byId.get(l.toId)!.sourceId)!.scope.startsWith("account-"));
    }
    // Material already linked exactly is never duplicated as a suggestion.
    const exact = new Set(
      store.links().filter((l) => l.type === "specifies").map((l) => `${l.fromId}>${l.toId}`),
    );
    assert.ok(exact.size > 0);
    assert.ok(!suggestions.some((l) => exact.has(`${l.fromId}>${l.toId}`)));
    // Hundreds of generic synthetic assignments with exact links or no distinctive text abstain:
    // the only suggestion is the prose-only relation above.
    assert.deepEqual(suggestions.map((l) => l.id), [target!.id]);
    for (const l of suggestions) assert.equal(byId.get(l.fromId)!.courseId, byId.get(l.toId)!.courseId);
    assert.ok(
      !store.syncRuns()[0]!.diagnostics?.some((d) => d.code === "evidence_suggestions_failed"),
    );

    // Drain any work deferred by the per-pass caps (the synthetic course 105 has 205 assignments).
    for (let i = 0; i < 10 && store.syncRuns()[0]!.diagnostics?.some((d) => d.code === "evidence_suggestions_deferred"); i++) {
      date = new Date(date.getTime() + 60_000);
      await runtime.tick("manual");
    }
    assert.ok(!store.syncRuns()[0]!.diagnostics?.some((d) => d.code === "evidence_suggestions_deferred"));
    const settled = fuzzyJudgments(store);
    const links = JSON.stringify(store.links());

    // Unchanged data: the full read runs again, but no assignment is rescored.
    date = new Date(date.getTime() + 60_000);
    const again = await runtime.tick("manual");
    assert.equal(again?.action, "refreshed");
    assert.deepEqual(fuzzyJudgments(store), settled, "an unchanged sync rescored assignments");
    assert.equal(JSON.stringify(store.links()), links);
    const report = refreshEvidenceSuggestions(store, { now: date.toISOString() });
    assert.equal(report.rescored, 0);
    assert.equal(report.unchanged, report.assignments);
  } finally {
    await runtime.stop?.();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the suggestion pass is incremental, capped by count and time, and rescans only changed courses", () => {
  const store = createStore(":memory:");
  try {
    const source = (courseId: string, scope: string) => ({
      id: `acct:${courseId}:${scope}`,
      label: "Synthetic",
      kind: "canvas" as const,
      accountScope: "acct",
      courseId,
      scope,
    });
    let clock = 0;
    const observed = () => new Date(Date.UTC(2099, 0, 1, 0, 0, ++clock)).toISOString();
    const resource = (courseId: string, externalId: string, kind: "assignment" | "material", title: string, text: string) => ({
      externalId,
      kind,
      courseId,
      courseName: courseId,
      title,
      url: `https://canvas.example.test/courses/${courseId}/${kind}/${externalId}`,
      text,
      deadlines: [],
      points: null,
      submitted: null,
      policy: { mode: "unknown" as const, evidence: "" },
    });
    const ingest = (courseId: string, scope: string, resources: ReturnType<typeof resource>[]) =>
      store.ingest({ source: source(courseId, scope), observedAt: observed(), complete: true, status: "ok", resources });
    for (const c of ["c1", "c2"]) {
      ingest(c, "assignments", Array.from({ length: 6 }, (_, i) => resource(c, `a${i}`, "assignment", `Lab ${i + 1} enzyme kinetics`, `Measure enzyme kinetics for lab ${i + 1} using the Enzyme kinetics lab guide.`)));
      ingest(c, "pages", [resource(c, "p1", "material", "Enzyme kinetics lab guide", "Guide to measure enzyme kinetics for each lab: Michaelis-Menten rate measurements.")]);
    }
    const now = "2099-01-02T00:00:00.000Z";
    // Count cap: 12 assignments need scoring, only 5 may run.
    const capped = refreshEvidenceSuggestions(store, { now, maxAssignments: 5 });
    assert.deepEqual([capped.assignments, capped.rescored, capped.deferred, capped.unchanged], [12, 5, 7, 0]);
    assert.ok(capped.suggested > 0);
    // Time cap: a clock already past the budget starts nothing new.
    let t = 0;
    const timed = refreshEvidenceSuggestions(store, { now, budgetMs: 10, clock: () => (t += 20) });
    assert.equal(timed.rescored, 0);
    assert.equal(timed.deferred, 7);
    const rest = refreshEvidenceSuggestions(store, { now });
    assert.deepEqual([rest.rescored, rest.unchanged], [7, 5]);
    assert.equal(refreshEvidenceSuggestions(store, { now }).rescored, 0);
    // One course's material changes: only that course's assignments are rescored.
    ingest("c1", "pages", [resource("c1", "p1", "material", "Enzyme kinetics lab guide", "Revised guide to measure enzyme kinetics for each lab with Lineweaver-Burk plots.")]);
    const changed = refreshEvidenceSuggestions(store, { now });
    assert.deepEqual([changed.rescored, changed.unchanged], [6, 6]);
    // One assignment's own text changes: only it is rescored.
    ingest("c2", "assignments", Array.from({ length: 6 }, (_, i) => resource("c2", `a${i}`, "assignment", `Lab ${i + 1} enzyme kinetics`, i === 0 ? "Measure enzyme kinetics at two temperatures using the Enzyme kinetics lab guide." : `Measure enzyme kinetics for lab ${i + 1} using the Enzyme kinetics lab guide.`)));
    const own = refreshEvidenceSuggestions(store, { now });
    assert.deepEqual([own.rescored, own.unchanged], [1, 11]);
    // Excluded courses are skipped entirely.
    assert.equal(refreshEvidenceSuggestions(store, { now, include: (r) => r.courseId === "c1" }).assignments, 6);
  } finally {
    store.close();
  }
});
