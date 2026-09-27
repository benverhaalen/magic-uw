// Fix 4 (AI-path audit): the worker's generation route wraps the Claude backend in the warm
// session pool, so a second pack call reuses the live session instead of a cold start.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { defaultPrivacy, type CaptureBatch, type ResourceInput } from "@magic/contracts";
import type { CliCommand } from "../packages/runner/src/index";
import { createPackRuntime } from "../packages/packs/core/src/index";
import { createPackHandler, generationKinds, pooledClaudeBackend } from "../packages/core/src/pack-handler";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
const STACK = "A stack is a last-in, first-out collection of elements.";
const QUEUE = "A queue is a first-in, first-out collection of elements.";
const input = (id: string, module: string, text: string): ResourceInput => ({
  externalId: id,
  kind: "material",
  courseId: "SYN101",
  courseName: "Synthetic Data Structures",
  title: `Synthetic ${id}`,
  text,
  url: `https://canvas.example.test/${id}`,
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "coaching", evidence: "Synthetic: AI help is allowed for practice." },
  module: { id: module },
});
const materials: CaptureBatch = {
  source: { id: "materials", kind: "canvas", accountScope: "acct", courseId: "SYN101", scope: "materials", label: "Synthetic" },
  observedAt: "2090-01-01T00:00:00.000Z",
  complete: true,
  status: "ok",
  resources: [input("r1", "m1", STACK), input("r2", "m2", QUEUE)],
};
const item = (pid: string, quote: string, stem: string) => ({
  kind: "tf", stem, options: [], statementIsTrue: true, numeric: null, explanation: "The reading says so.",
  topics: ["Structures"], section: "Linear structures", bloom: "remember", sourceId: pid, quote,
});

test("fix-ai-pool: the generation pool covers every pack, and a second quiz call reuses the warm session (one spawn)", async () => {
  assert.deepEqual(Object.keys(generationKinds()).sort(), ["briefing", "cards", "compare", "conceptmap", "faq", "guide", "quiz", "timeline"]);
  const store = createStore(":memory:");
  store.ingest(materials);
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  const [r1, r2] = ["r1", "r2"].map((x) => store.resources().find((r) => r.externalId === x)!);
  const p1 = `p${store.passages(r1!.id)[0]!.pid}`;
  const p2 = `p${store.passages(r2!.id)[0]!.pid}`;
  const dir = await mkdtemp(join(tmpdir(), "fix-ai-pool-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const log = join(dir, "log.jsonl");
  const env = {
    FAKE_CLI_LOG: log,
    FAKE_CLI_STATE: join(dir, "state"),
    FAKE_CLI_RESPONSES: JSON.stringify([
      { output: { kind: "quiz", data: { items: [item(p1, STACK, "A stack is last-in, first-out.")] } } },
      { output: { kind: "quiz", data: { items: [item(p2, QUEUE, "A queue is first-in, first-out.")] } } },
    ]),
  };
  const pool = pooledClaudeBackend({ command: fake, workDir, env });
  const runner = createPackRuntime(pool, { dailyBackgroundTokens: 1_000_000 }).runner;
  const handler = createPackHandler({ store, runner: async () => runner });
  const core = createCore(store, { fixture: materials, seams: { pack: handler.pack } });
  try {
    await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
    const run = async (moduleId: string) =>
      (await core.execute({ type: "pack", pack: "quiz", scope: { courseId: "SYN101", moduleId } })).pack as { status: string; message: string };
    const a = await run("m1");
    assert.equal(a.status, "done", a.message);
    const b = await run("m2");
    assert.equal(b.status, "done", b.message);
    const lines = existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { event?: string }) : [];
    assert.equal(lines.filter((l) => l.event === "spawn").length, 1, "one process served both calls");
    assert.equal(lines.filter((l) => l.event === "message").length, 2);
  } finally {
    await pool.close();
    await core.close();
  }
});
