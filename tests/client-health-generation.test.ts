// owner: client-health (D50). One generation end to end in instant mode, composed exactly as the
// worker composes it: clientBackend → the warm Claude pool → the pack runtime → core's pack
// command, against the fake CLI (no network, no credentials). A signed-out client refuses
// before anything is spawned.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "@magic/storage";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { defaultPrivacy, type CaptureBatch, type ClientId, type ResourceInput } from "@magic/contracts";
import { createCodexBackend, type CliCommand } from "../packages/runner/src/index";
import { createPackRuntime } from "../packages/packs/core/src/index";
import { createPackHandler, pooledClaudeBackend } from "../packages/core/src/pack-handler";
import { CLAUDE_REQUIRED_FLAGS, clientBackend, instantWorkDir, profileDir, type CliRunOptions } from "../apps/desktop/src/clients/index";

const here = dirname(fileURLToPath(import.meta.url));
const fake = (id: ClientId): CliCommand | null => (id === "gemini" ? null : { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), id] });
const STACK = "A stack is a last-in, first-out collection of elements.";
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
  resources: [input("r1", "m1", STACK)],
};

async function setup(signedIn: boolean) {
  const store = createStore(":memory:");
  store.ingest(materials);
  store.setPrivacy({ ...defaultPrivacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true });
  const r1 = store.resources().find((r) => r.externalId === "r1")!;
  const pid = `p${store.passages(r1.id)[0]!.pid}`;
  const userData = await mkdtemp(join(tmpdir(), "magic-instant-gen-"));
  const log = join(userData, "log.jsonl");
  const fakeEnv = {
    FAKE_CLI_LOG: log,
    FAKE_CLI_STATE: join(userData, "state"),
    FAKE_CLI_RESPONSES: JSON.stringify([
      { output: { kind: "quiz", data: { items: [{ kind: "tf", stem: "A stack is last-in, first-out.", options: [], statementIsTrue: true, numeric: null, explanation: "The reading says so.", topics: ["Structures"], section: "Linear structures", bloom: "remember", sourceId: pid, quote: STACK }] } } },
    ]),
  };
  // The test harness adds only the fake CLI's own settings to the environment instant mode built.
  const withFake = (o: CliRunOptions) => ({ ...o, env: { ...o.env, ...fakeEnv } });
  const built = await clientBackend(
    "claude",
    {
      userData,
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, USERPROFILE: userData, HOME: userData },
      resolve: fake,
      help: async () => CLAUDE_REQUIRED_FLAGS.join("\n"),
      status: async (_c, mode) => {
        assert.equal(mode, "instant", "the status check reads the student's own configuration");
        return signedIn ? { signedIn: true, method: "subscription", plan: "max" } : { signedIn: false, method: null, plan: null };
      },
      online: async () => true,
    },
    { claude: (o) => pooledClaudeBackend(withFake(o)), codex: (o) => createCodexBackend(withFake(o)) },
    async () => {
      throw new Error("the app's own profile must not be used unless the student opted in");
    },
  );
  assert.ok(built);
  assert.equal(built.mode, "instant");
  const runner = createPackRuntime(built.backend, { dailyBackgroundTokens: 1_000_000 }).runner;
  const handler = createPackHandler({ store, runner: async () => runner });
  const core = createCore(store, { fixture: materials, seams: { pack: handler.pack } });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const spawns = async () =>
    existsSync(log)
      ? (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { event?: string; argv: string[]; cwd: string }).filter((l) => l.event === "spawn")
      : [];
  const run = async () => (await core.execute({ type: "pack", pack: "quiz", scope: { courseId: "SYN101", moduleId: "m1" } })).pack as { status: string; message: string };
  return { userData, run, spawns, built };
}

test("instant mode: a quiz generates through the student's own signed-in client with --safe-mode, in the app's folder", async () => {
  const { userData, run, spawns } = await setup(true);
  const result = await run();
  assert.equal(result.status, "done", result.message);
  const [spawn] = await spawns();
  assert.ok(spawn, "the warm session was started");
  for (const flag of ["-p", "--tools", "--strict-mcp-config", "--no-session-persistence", "--safe-mode"]) assert.ok(spawn.argv.includes(flag), flag);
  assert.equal(spawn.argv[spawn.argv.indexOf("--setting-sources") + 1], "project,local");
  // The child reports its resolved cwd; on macOS the temp dir under /var is /private/var.
  assert.equal(realpathSync(spawn.cwd), realpathSync(instantWorkDir(userData, "claude")));
  for (const a of spawn.argv) assert.ok(!a.includes(profileDir(userData, "claude")), a);
});

test("instant mode, signed out: the pack fails as not signed in and nothing is spawned", async () => {
  const { run, spawns, built } = await setup(false);
  const result = await run();
  assert.notEqual(result.status, "done");
  assert.match(result.message, /isn't signed in/);
  assert.equal((await spawns()).length, 0);
  assert.equal(built.backend.lastHealth()?.state, "not_signed_in");
});
