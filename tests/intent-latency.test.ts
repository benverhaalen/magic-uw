// The AI fallback's added latency (the lead's requirement), measured where the app adds it:
// dispatch time, from submit to the moment the model call is handed to the runner's backend.
// With a warm pooled session and the fake CLI answering in a fixed 800 ms, the end-to-end time is
// dominated by that 800 ms and its scheduling jitter, so it is reported, not asserted. Asserted:
// - the fallback's added dispatch time over calling the model directly: <= 2 ms at p95;
// - the privacy pass's added dispatch time (protected vs unprotected fallback): <= 1 ms at p95;
// - a code hit sends nothing and does no protection work.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import type { IntentCommandResult } from "@magic/contracts";
import { createClaudeBackend, createModelRunner, createSessionPool, type CliCommand } from "../packages/runner/src/index";
import { askPack, classifyPack } from "../packages/packs/intent/src/index";
import { createIntentRouter, type IntentHost } from "../packages/core/src/intent/index";
import { intentProtectionWork } from "../packages/core/src/privacy/intent";
import { NOW, TZ, workspace } from "./intent-fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
const LATENCY_MS = 800;
// 24 interleaved rounds: the nearest-rank p95 is the 23rd of 24, so one scheduling outlier from
// other test files running in parallel does not decide the comparison on its own.
const N = 24;
const classify = {
  output: {
    kind: "intent-classify",
    data: { action: "agenda.due", args: { course: null, assignment: null, topics: null, date: "tomorrow", time: null, query: null, kind: null, count: null, scope: null }, confidence: "high", alternatives: null, question: null },
  },
  sleepMs: LATENCY_MS,
};
const host: IntentHost = { workspace: async (v) => ({ verb: v.verb, status: "ok", items: [] }) };
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.95 * xs.length) - 1]!;
const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(0.5 * xs.length) - 1]!;

async function rig(speculation: "gate" | "race" = "gate") {
  const { store, batches } = workspace();
  const dir = await mkdtemp(join(tmpdir(), "intent-latency-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const log = join(dir, "log.jsonl");
  const env = { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify([classify]) };
  const pool = createSessionPool({ command: fake, workDir, env, fallback: createClaudeBackend({ command: fake, workDir, env }), kinds: { [classifyPack.id]: classifyPack.schema, [askPack.id]: askPack.schema } });
  // The dispatch mark: the moment the runner hands the call to the backend (the pool).
  let dispatchedAt = NaN;
  const tapped = Object.assign(Object.create(pool) as typeof pool, {
    call: (call: Parameters<typeof pool.call>[0]) => {
      dispatchedAt = performance.now();
      return pool.call(call);
    },
  });
  const runner = createModelRunner({ backend: tapped });
  const make = (extra: { codePath?: boolean; speculation?: "gate" | "race"; protect?: boolean } = {}) =>
    createIntentRouter({ store, runner: () => runner, now: () => NOW, timeZone: TZ, speculation, ...extra });
  const core = createCore(store, { fixture: batches[0]!, now: () => NOW });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const sent = async () =>
    existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter((l) => JSON.parse(l).event === "message").length : 0;
  const timed = async (router: ReturnType<typeof make>, text: string) => {
    dispatchedAt = NaN;
    const t0 = performance.now();
    const r: IntentCommandResult = await router.handle({ text }, host, new AbortController().signal);
    return { r, ms: performance.now() - t0, dispatchMs: dispatchedAt - t0 };
  };
  return { pool, make, sent, timed };
}

test("fallback adds <= 2 ms p95 of dispatch time over AI-only and privacy <= 1 ms; a code hit sends nothing and does no protection work (gate)", { timeout: 240_000 }, async () => {
  const h = await rig("gate");
  try {
    const fallback = h.make();
    const aiOnly = h.make({ codePath: false });
    const unprotected = h.make({ protect: false });
    // As at launch: each router's index and protection roster are built before the first command.
    for (const r of [fallback, aiOnly, unprotected]) r.ready();
    // Warm the pooled session (a spawn is not what's measured).
    for (const r of [fallback, aiOnly, unprotected]) await h.timed(r, "zq warm the session up");
    const fb = { ms: [] as number[], dispatch: [] as number[] };
    const ai = { ms: [] as number[], dispatch: [] as number[] };
    const bare = { ms: [] as number[], dispatch: [] as number[] };
    for (let i = 0; i < N; i++) {
      // Interleaved, so drift in the machine's load falls on all three alike.
      const round = [
        [fallback, fb, `zq sort out thing number ${i} for me`],
        [aiOnly, ai, `zq sort out other thing ${i} for me`],
        [unprotected, bare, `zq sort out bare thing ${i} for me`],
      ] as const;
      for (const [router, into, text] of round) {
        const a = await h.timed(router, text);
        assert.equal(a.r.path, "ai", JSON.stringify(a.r));
        assert.equal(a.r.status, "ran");
        assert.ok(Number.isFinite(a.dispatchMs), "the call reached the runner");
        into.ms.push(a.ms);
        into.dispatch.push(a.dispatchMs);
      }
    }
    const before = await h.sent();
    const work = intentProtectionWork();
    const hits: number[] = [];
    for (const text of ["what's due tomorrow", "quiz me on recursion in cs 400", "go to philosophy", "flashcards due for econ", "search for utilitarianism"]) {
      const c = await h.timed(fallback, text);
      assert.equal(c.r.path, "code", text);
      hits.push(c.ms);
    }
    const billed = (await h.sent()) - before;
    const hitWork = intentProtectionWork() - work;
    const stats = (xs: number[], d = 1) => ({ p50: +p50(xs).toFixed(d), p95: +p95(xs).toFixed(d) });
    const numbers = {
      mode: "gate",
      fakeLatencyMs: LATENCY_MS,
      n: N,
      dispatch: { fallback: stats(fb.dispatch, 2), aiOnly: stats(ai.dispatch, 2), unprotectedFallback: stats(bare.dispatch, 2) },
      addedDispatchP95Ms: +(p95(fb.dispatch) - p95(ai.dispatch)).toFixed(2),
      privacyDispatchP95Ms: +(p95(fb.dispatch) - p95(bare.dispatch)).toFixed(2),
      endToEnd: { fallback: stats(fb.ms), aiOnly: stats(ai.ms), unprotectedFallback: stats(bare.ms), addedP95Ms: +(p95(fb.ms) - p95(ai.ms)).toFixed(1) },
      codeHit: { ...stats(hits, 2), billedCalls: billed, protectionWork: hitWork },
    };
    console.log(`INTENT-LATENCY ${JSON.stringify(numbers)}`);
    assert.equal(billed, 0, "a code hit sends nothing to the model");
    assert.equal(hitWork, 0, "a code hit does no protection work");
    assert.ok(p95(fb.dispatch) <= p95(ai.dispatch) + 2, `fallback dispatch p95 ${p95(fb.dispatch).toFixed(2)} ms vs AI-only ${p95(ai.dispatch).toFixed(2)} ms`);
    assert.ok(p95(fb.dispatch) <= p95(bare.dispatch) + 1, `protected dispatch p95 ${p95(fb.dispatch).toFixed(2)} ms vs unprotected ${p95(bare.dispatch).toFixed(2)} ms`);
  } finally {
    await h.pool.close();
  }
});

test("race (send at once, abort on a code hit) gains nothing in-process: the synchronous resolver answers before the send leaves", { timeout: 120_000 }, async () => {
  const h = await rig("race");
  try {
    const router = h.make();
    await h.timed(router, "zq warm the session up");
    const before = await h.sent();
    const hits: number[] = [];
    for (const text of ["what's due tomorrow", "quiz me on recursion in cs 400", "go to philosophy"]) {
      const c = await h.timed(router, text);
      assert.equal(c.r.path, "code");
      hits.push(c.ms);
    }
    // Let the aborted sends settle, then count what reached the model.
    await new Promise((r) => setTimeout(r, 300));
    const billed = (await h.sent()) - before;
    const misses: number[] = [];
    for (let i = 0; i < 4; i++) misses.push((await h.timed(router, `zq sort out thing number ${i} for me`)).ms);
    console.log(`INTENT-LATENCY ${JSON.stringify({ mode: "race", codeHits: hits.length, billedCalls: billed, missAfterAbort: { p50: +p50(misses).toFixed(1), p95: +p95(misses).toFixed(1) } })}`);
    // The send's first await resumes only after the synchronous resolver has answered and
    // aborted it, so race bills nothing on a code hit and its misses match gate's latency.
    assert.equal(billed, 0);
  } finally {
    await h.pool.close();
  }
});
