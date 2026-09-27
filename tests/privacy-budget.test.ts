/**
 * The privacy cost budgets (the operator: "if privacy really adds latency it has to be miniscule").
 * Machine-independent: each is a ratio to a reference measured in the same run on the same data.
 * - The protection pass: <= 6.5x (teaching) and <= 16x (personal) a plain scan of the same 10 KB
 *   text with the full detector set, and a repeated send <= 2x. These ratios are the absolute
 *   budgets (1 ms and 2 ms p95, 0.25 ms repeated) over the reference's p95 on the laptop they were
 *   set on; the absolute numbers are reported with the machine named by
 *   `pnpm magic:perf --suite privacy` (evals/perf/privacy.ts).
 * - Encryption at rest: reading 2,000 messages stays within 10% of the unencrypted read, both the
 *   first read after the key arrives and later reads.
 * The command bar's budget (<= 1 ms added dispatch, 0 on a code hit) is in intent-latency.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { deriveInstallKeys } from "../packages/core/src/privacy/at-rest";
import { measureProtection, PROTECTION_BUDGET_RATIO } from "../evals/perf/privacy";

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.95 * xs.length) - 1]!;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

test("protection pass: within 6.5x (teaching) and 16x (personal) of a plain full-detector scan at p95; a repeated send within 2x", (t) => {
  const results: Record<string, number> = {};
  for (const cls of ["teaching", "personal"] as const) {
    const s = measureProtection(cls);
    const ref = p95(s.reference);
    results[`${cls}ReferenceP95Ms`] = +ref.toFixed(3);
    results[`${cls}PassP95Ms`] = +p95(s.cold).toFixed(3);
    results[`${cls}CachedP95Ms`] = +p95(s.cached).toFixed(3);
    results[`${cls}Ratio`] = +(p95(s.cold) / ref).toFixed(2);
    assert.ok(p95(s.cold) <= PROTECTION_BUDGET_RATIO[cls] * ref, `${cls}: pass p95 ${p95(s.cold).toFixed(3)} ms > ${PROTECTION_BUDGET_RATIO[cls]}x reference ${ref.toFixed(3)} ms`);
    assert.ok(p95(s.cached) <= PROTECTION_BUDGET_RATIO.cached * ref, `${cls} cached: p95 ${p95(s.cached).toFixed(3)} ms > ${PROTECTION_BUDGET_RATIO.cached}x reference ${ref.toFixed(3)} ms`);
  }
  t.diagnostic(`PRIVACY-BUDGET ${JSON.stringify(results)}`);
});

test("encryption at rest: reading 2,000 messages stays within 10% of unencrypted, first read after the key and later reads", (t) => {
  const mail = (i: number) => ({
    externalId: `m${i}`, kind: "message" as const, courseId: "outlook-mail", courseName: "Outlook mail", title: `Subject ${i}`, text: "g".repeat(200),
    url: "https://outlook.office.com/mail/", deadlines: [],
    mail: { messageId: `m${i}`, folder: "inbox", fromName: "A B", fromAddress: "a@b.edu", receivedAt: "2026-09-26T12:00:00Z", preview: "p".repeat(255), gist: "g".repeat(200), category: "course" as const, categoryReason: "r" },
  });
  const key = deriveInstallKeys(Buffer.alloc(32, 1)).atRest;
  const reads = (keyed: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "privacy-read-"));
    const file = join(dir, "db.sqlite");
    try {
      let s = createStore(file);
      if (keyed) s.setAtRestKey(key);
      s.ingest({ source: { id: "mail", kind: "mail", label: "m", accountScope: "a", courseId: "outlook-mail", scope: "graph_mail" }, observedAt: "2026-09-26T12:00:00Z", status: "ok", complete: true, resources: Array.from({ length: 2000 }, (_, i) => mail(i)) });
      s.close();
      s = createStore(file);
      s.resources(); // the SQLite page cache warm alike for both
      s.close();
      s = createStore(file);
      const k0 = performance.now();
      if (keyed) s.setAtRestKey(key); // at worker start: seal check and cache warm-up
      const keyMs = performance.now() - k0;
      let a = performance.now();
      const first = s.resources();
      const firstMs = performance.now() - a;
      const later: number[] = [];
      for (let i = 0; i < 9; i++) {
        a = performance.now();
        s.resources();
        later.push(performance.now() - a);
      }
      assert.equal(first.find((r) => r.mail)!.mail!.preview, "p".repeat(255));
      s.close();
      return { keyMs, firstMs, laterMs: median(later) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const rounds = [0, 1, 2].map(() => ({ plain: reads(false), sealed: reads(true) }));
  const firstPlain = median(rounds.map((r) => r.plain.firstMs)), firstSealed = median(rounds.map((r) => r.sealed.firstMs));
  const laterPlain = median(rounds.map((r) => r.plain.laterMs)), laterSealed = median(rounds.map((r) => r.sealed.laterMs));
  const keyMs = median(rounds.map((r) => r.sealed.keyMs));
  t.diagnostic(`PRIVACY-READ ${JSON.stringify({ firstPlain: +firstPlain.toFixed(1), firstSealed: +firstSealed.toFixed(1), laterPlain: +laterPlain.toFixed(1), laterSealed: +laterSealed.toFixed(1), keyArrivalMs: +keyMs.toFixed(1) })}`);
  assert.ok(firstSealed <= firstPlain * 1.1, `first read ${firstSealed.toFixed(1)} ms vs ${firstPlain.toFixed(1)} ms`);
  assert.ok(laterSealed <= laterPlain * 1.1, `later read ${laterSealed.toFixed(1)} ms vs ${laterPlain.toFixed(1)} ms`);
});
