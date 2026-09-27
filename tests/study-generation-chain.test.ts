// The Study producing chain end to end, headless: the item space's own calls
// (renderer/study-prep/api.ts) → the preload bridge's `execute` → core's `pack` / `learning`
// commands → the pack handler → the student's (fake) Claude Code CLI. Privacy is the state the
// setup's "Your AI" choice writes: selective_cloud, Claude, consent granted, course text shared.
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
import { defaultPrivacy, type LearningRequest } from "@magic/contracts";
import { createClaudeBackend, type CliCommand } from "../packages/runner/src/index";
import { createPackRuntime } from "../packages/packs/core/src/index";
import { createPackHandler } from "../packages/core/src/pack-handler";
import { ask, prepGenerate } from "../apps/desktop/src/renderer/study-prep/api";
import { materialsBatch, NOW, passageId, signalsFixture } from "./study-prep-fixture";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
const NYQUIST = "A signal band-limited to B Hz can be recovered from its samples when the sampling rate fs is greater than 2B.";
const ALIASING = "Sampling below the Nyquist rate causes aliasing: high frequencies appear as low ones.";

test("Study generation and the scoped ask reach the student's Claude Code through the bridge", async () => {
  const f = signalsFixture(createStore(":memory:"));
  const store = f.store;
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  const sampling = passageId(store, f.ids.sampling!);
  const cards = { cards: [
    { kind: "term", front: "Nyquist rate", back: "$2B$", topics: ["Sampling theorem"], section: "Module 4: Sampling", sourceId: sampling, quote: NYQUIST },
    { kind: "term", front: "Aliasing", back: "High frequencies appear as low ones", topics: ["Aliasing"], section: "Module 4: Sampling", sourceId: sampling, quote: ALIASING },
  ] };
  const dir = await mkdtemp(join(tmpdir(), "study-chain-"));
  await mkdir(join(dir, "work"));
  const log = join(dir, "log.jsonl");
  const env = { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify([{ output: { guide: null, quiz: null, cards, exam: null, problems: null, outline: null } }]) };
  const runner = createPackRuntime(createClaudeBackend({ command: fake, workDir: join(dir, "work"), env }), { dailyBackgroundTokens: 1_000_000 }).runner;
  const handler = createPackHandler({ store, runner: () => runner, now: () => NOW });
  // As the worker wires it: `notebook.ask` goes to the pack handler's scoped ask.
  const learning = { handle: (request: LearningRequest, signal: AbortSignal) => handler.studyPrep.ask(request as Extract<LearningRequest, { op: "notebook.ask" }>, signal) };
  const core = createCore(store, { fixture: materialsBatch(), seams: { pack: handler.pack, learning } });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const calls = async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter((l) => JSON.parse(l).argv).length : 0);

  const executed: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { magic: {
    execute: (command: { type: string }) => { executed.push(command.type); return core.execute(command as Parameters<typeof core.execute>[0]); },
  } } });
  try {
    const made = await prepGenerate(["cards"], { courseId: "SIG203", itemId: "a-mid2" });
    assert.equal(made.status, "done", made.message);
    assert.equal(await calls(), 1, "one call to the student's client");
    const answer = await ask({ courseId: "SIG203", itemId: "a-mid2", resourceIds: [f.ids.sampling!] }, "What is the DTFT of a sequence?");
    assert.equal(answer.unavailable, undefined, answer.unavailable);
    assert.equal(answer.notFound, true, "outside the ticked sources: answered by code, no call");
    assert.deepEqual(executed, ["pack", "learning"]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window");
    store.close();
  }
});
