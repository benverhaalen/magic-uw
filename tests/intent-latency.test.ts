// The AI fallback's added latency (the lead's requirement): with a warm pooled session and the
// fake CLI answering in a fixed 800 ms, a code miss that falls back to the model must end within
// 10 ms (p95) of calling the model directly, and a code hit must send nothing.
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
import { NOW, TZ, workspace } from "./intent-fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
const LATENCY_MS = 800;
// 24 interleaved pairs: the nearest-rank p95 is the 23rd of 24, so one scheduling outlier from
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
  const runner = createModelRunner({ backend: pool });
  const make = (extra: { codePath?: boolean; speculation?: "gate" | "race" } = {}) =>
    createIntentRouter({ store, runner: () => runner, now: () => NOW, timeZone: TZ, speculation, ...extra });
  const core = createCore(store, { fixture: batches[0]!, now: () => NOW });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const sent = async () =>
    existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter((l) => JSON.parse(l).event === "message").length : 0;
  const timed = async (router: ReturnType<typeof make>, text: string) => {
    const t0 = performance.now();
    const r: IntentCommandResult = await router.handle({ text }, host, new AbortController().signal);
    return { r, ms: performance.now() - t0 };
  };
  return { pool, make, sent, timed };
}

test("fallback p95 is within 10 ms of AI-only p95; a code hit sends nothing (gate)", { timeout: 180_000 }, async () => {
  const h = await rig("gate");
  try {
    const fallback = h.make();
    const aiOnly = h.make({ codePath: false });
    // Warm the pooled session once (a spawn is not what's measured).
    await h.timed(aiOnly, "zq warm the session up");
    const fb: number[] = [];
    const ai: number[] = [];
    for (let i = 0; i < N; i++) {
      const a = await h.timed(fallback, `zq sort out thing number ${i} for me`);
      assert.equal(a.r.path, "ai", JSON.stringify(a.r));
      assert.equal(a.r.status, "ran");
      fb.push(a.ms);
      const b = await h.timed(aiOnly, `zq sort out other thing ${i} for me`);
      assert.equal(b.r.path, "ai");
      ai.push(b.ms);
    }
    const before = await h.sent();
    const hits: number[] = [];
    for (const text of ["what's due tomorrow", "quiz me on recursion in cs 400", "go to philosophy", "flashcards due for econ", "search for utilitarianism"]) {
      const c = await h.timed(fallback, text);
      assert.equal(c.r.path, "code", text);
      hits.push(c.ms);
    }
    const billed = (await h.sent()) - before;
    const numbers = {
      mode: "gate",
      fakeLatencyMs: LATENCY_MS,
      n: N,
      fallback: { p50: +p50(fb).toFixed(1), p95: +p95(fb).toFixed(1) },
      aiOnly: { p50: +p50(ai).toFixed(1), p95: +p95(ai).toFixed(1) },
      addedP95Ms: +(p95(fb) - p95(ai)).toFixed(1),
      codeHit: { p50: +p50(hits).toFixed(2), p95: +p95(hits).toFixed(2), billedCalls: billed },
    };
    console.log(`INTENT-LATENCY ${JSON.stringify(numbers)}`);
    assert.equal(billed, 0, "a code hit sends nothing to the model");
    assert.ok(p95(fb) <= p95(ai) + 10, `fallback p95 ${p95(fb).toFixed(1)} ms vs AI-only ${p95(ai).toFixed(1)} ms`);
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
