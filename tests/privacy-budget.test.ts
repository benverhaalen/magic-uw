/**
 * The privacy cost budgets (the operator: "if privacy really adds latency it has to be miniscule"):
 * - the protection pass: <= 1 ms p95 for a 10 KB teaching text, <= 2 ms for 10 KB personal text,
 *   and a repeated send of the same text (cached by text hash and roster version) close to 0;
 * - encryption at rest: reading 2,000 messages stays within 10% of the unencrypted read, both the
 *   first read after the key arrives and later reads.
 * The command bar's budget (<= 1 ms added dispatch, 0 on a code hit) is in intent-latency.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "@magic/storage";
import { rosterFor } from "../packages/core/src/identity";
import { protectText } from "../packages/core/src/privacy/protect";
import { pseudonymSession } from "../packages/core/src/privacy/pseudonyms";
import { deriveInstallKeys } from "../packages/core/src/privacy/at-rest";

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.95 * xs.length) - 1]!;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const LECTURE =
  "Recursion solves a problem by solving smaller instances of the same problem. Every recursive method needs a base case, and each call must make progress toward it. Consider the factorial: n! = n * (n-1)!, with 0! = 1. Configure the lab VM at 192.168.1.1 and run the tests. ";
const MENTION = "Peer3 Person3 asked about tail calls in office hours; email qz@wisc.edu or call (608) 555-0142 with questions. ";
const POST =
  "Hi Peer4, it's Quentin. I finished the recursion lab and pushed it. My card is 5555 5555 5555 4444 for the club fee, and I live at 1234 Canaryhill Street if you want to study. ";
const tenK = (seed: number, body: string, extra: string, every: number) => {
  let t = `Week ${seed}. `;
  for (let k = 1; t.length < 10240; k++) t += k % every === 0 ? extra : body;
  return t.slice(0, 10240);
};

test("protection pass: <= 1 ms p95 per 10 KB teaching text, <= 2 ms personal; a repeated send costs close to 0", (t) => {
  const store = createStore(":memory:");
  store.recordAutoIdentity({ accountScope: "a", self: { names: ["Quentin Zabrowski"], emails: ["qz@wisc.edu"], netIds: ["qzab"], studentIds: ["9081234567"] } });
  store.recordAutoIdentity({ accountScope: "a", courseId: "c", authors: Array.from({ length: 40 }, (_, i) => `Peer${i} Person${i}`) });
  const roster = rosterFor(store, "c", "a");
  const results: Record<string, number> = {};
  for (const [label, body, extra, cls, budget] of [
    ["teaching", LECTURE, MENTION, "teaching", 1],
    ["personal", POST, MENTION, "personal", 2],
  ] as const) {
    for (let i = 0; i < 30; i++) protectText(tenK(1e6 + i, body, extra, 12), roster, pseudonymSession("warm"), cls); // JIT warm-up
    const cold: number[] = [], cached: number[] = [];
    for (let i = 0; i < 200; i++) {
      const text = tenK(i, body, extra, 12);
      let a = performance.now();
      const first = protectText(text, roster, pseudonymSession("cold"), cls);
      cold.push(performance.now() - a);
      a = performance.now();
      const again = protectText(text, roster, pseudonymSession("again"), cls);
      cached.push(performance.now() - a);
      if (i === 0) assert.equal(again.spans.length, first.spans.length);
    }
    results[`${label}ColdP95Ms`] = +p95(cold).toFixed(3);
    results[`${label}CachedP95Ms`] = +p95(cached).toFixed(3);
    assert.ok(p95(cold) <= budget, `${label}: p95 ${p95(cold).toFixed(3)} ms > ${budget} ms`);
    assert.ok(p95(cached) <= 0.25, `${label} cached: p95 ${p95(cached).toFixed(3)} ms`);
  }
  t.diagnostic(`PRIVACY-BUDGET ${JSON.stringify(results)}`);
  store.close();
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
