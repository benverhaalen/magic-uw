// The pack seam carries the count the student asked for into the prompt (the command bar's
// "make 12 cards …"); without one, the pack's default applies. Synthetic course, fake CLI.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { defaultPrivacy, type CaptureBatch, type ResourceInput } from "@magic/contracts";
import { createClaudeBackend, type CliCommand } from "../packages/runner/src/index";
import { createPackRuntime } from "../packages/packs/core/src/index";
import { createPackHandler, DEFAULT_COUNT } from "../packages/core/src/pack-handler";

const here = dirname(fileURLToPath(import.meta.url));
const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
const TEXT = "A stack is a last-in, first-out collection of elements. A queue is a first-in, first-out collection of elements.";
const input = (id: string, kind: ResourceInput["kind"], extra: Partial<ResourceInput> = {}): ResourceInput => ({
  externalId: id,
  kind,
  courseId: "SYN101",
  courseName: "Synthetic Data Structures",
  title: `Synthetic ${id}`,
  text: TEXT,
  url: `https://canvas.example.test/${id}`,
  deadlines: [],
  points: null,
  submitted: null,
  policy: { mode: "coaching", evidence: "Synthetic: AI help is allowed for practice." },
  ...extra,
});
const batch = (id: string, resources: ResourceInput[]): CaptureBatch => ({
  source: { id, kind: "canvas", accountScope: "acct", courseId: "SYN101", scope: id, label: "Synthetic" },
  observedAt: "2090-01-01T00:00:00.000Z",
  complete: true,
  status: "ok",
  resources,
});

test("the pack seam's count reaches the prompt; no count keeps the pack default", { timeout: 60_000 }, async () => {
  const store = createStore(":memory:");
  const assignments = batch("assignments", [input("target", "assignment", { text: "Synthetic homework prompt.", points: 10 })]);
  store.ingest(assignments);
  store.ingest(batch("materials", [input("reading", "material")]));
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  const dir = await mkdtemp(join(tmpdir(), "pack-count-"));
  const workDir = join(dir, "work");
  await mkdir(workDir);
  const log = join(dir, "log.jsonl");
  const env = { FAKE_CLI_LOG: log, FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify([{ output: { cards: [] } }]) };
  const runner = createPackRuntime(createClaudeBackend({ command: fake, workDir, env }), { dailyBackgroundTokens: 1_000_000 }).runner;
  const handler = createPackHandler({ store, runner: () => runner });
  const core = createCore(store, { fixture: assignments, seams: { pack: handler.pack } });
  try {
    await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
    const stdins = async () => (existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { stdin: string }).stdin) : []);
    await handler.pack("cards", { courseId: "SYN101" }, new AbortController().signal, { count: 12 });
    await handler.pack("cards", { courseId: "SYN101", topicIds: [] }, new AbortController().signal);
    const sent = await stdins();
    assert.ok(sent.length >= 2, `${sent.length} calls`);
    assert.ok(sent[0]!.includes("Write 12 flashcards"), "the asked-for count");
    assert.ok(sent.at(-1)!.includes(`Write ${DEFAULT_COUNT.cards} flashcards`), "the pack default");
  } finally {
    await core.close();
    await rm(dir, { recursive: true, force: true });
  }
});
