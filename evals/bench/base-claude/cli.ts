/**
 * pnpm bench:base <command> [options]. See README.md for the fairness rules and the run order.
 *
 *   setup                     install the pinned Playwright MCP into the tools folder; print versions
 *   preflight --client claude zero-spend check of the baseline's Claude flags (API pointed at a closed port)
 *   session                   operator-present: proxy + bench browser; sign in once; keeps the session
 *   gold                      the independent gold, through the session
 *   ours [--runs 3] [--mode session|app] [--repeat]
 *   baseline --client claude|codex --model <id> [--runs 3] --budget <usd> --timeout <min> [--repeat]
 *   tasks --clients claude:claude-opus-5-5,codex:gpt-6-astra --conditions browser,ours [--trials 10]
 *   report                    results/*.json -> report.md (counts and timings only)
 *   dry-run [--scale tiny|full] [--with-ours]   synthetic replica + fake CLI, zero spend
 *
 * Live outputs go to <main checkout>/research/bench/live-<date>/ (git-ignored; checked before writing).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Cdp, clearCache, findChrome, launchChrome, resetTabs } from "./cdp";
import { runAgent, type AgentRun, type ClientSpec, type McpServerSpec, type Prices } from "./clients";
import { crawlGold, goldCounts, type Gold } from "./gold";
import { exportOurs, runOursApp, runOursSession, type OursRun } from "./ours";
import { continuePrompt, ingestionPrompt, repeatPrompt, taskPrompt, type TaskCondition } from "./prompts";
import { proxyCertificate, proxyControl, startProxy, UW_POLICY } from "./proxy";
import { renderReport, type IngestResult, type TaskRunResult, type TrialResult } from "./report";
import { REPLICA_LOGIN, startReplica } from "./replica-server";
import { createTargetDb, readTargetDb, snapshotDb } from "./schema";
import { agendaUsableMs, changesPickedUp, scoreRows, type Snapshot } from "./score";
import { checkAnswer, generateTasks, sampleTasks, wrongAnswer, type Task } from "./tasks";
import { hash32 } from "./text";
import { browserTransport, replicaTransport, type CanvasTransport } from "./transport";
import { prepareOursMcp } from "./mcp-ours";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const ORIGIN = "https://canvas.wisc.edu";
const PLAYWRIGHT_MCP = "0.0.82"; // Apache-2.0, checked 2026-09-27
/** API list prices per million tokens (input, cached input, output). Codex: platform.openai.com, via the roster (2026-09-23). Claude runs report their own cost. */
const PRICES: Prices = {
  "gpt-6-astra": { input: 10, cachedInput: 1, output: 50 },
  "gpt-6-sol": { input: 2, cachedInput: 0.2, output: 10 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 },
  "fake-model": { input: 1, cachedInput: 0.1, output: 5 },
};

const argv = process.argv.slice(2).filter((a) => a !== "--");
const command = argv[0] ?? "help";
const opt = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : fallback;
};
const flag = (name: string) => argv.includes(`--${name}`);
const log = (line: string) => process.stderr.write(`[bench] ${line}\n`);
const git = (args: string[], cwd = root) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const today = () => new Date().toISOString().slice(0, 10);
const prereg = () => createHash("sha256").update(readFileSync(join(here, "preregistration.md"))).digest("hex").slice(0, 16);

function mainCheckout(): string {
  return resolve(root, git(["rev-parse", "--git-common-dir"]), "..");
}
/** The live output folder; refuses one git would track. */
function liveDir(): string {
  const dir = resolve(opt("out") ?? join(mainCheckout(), "research", "bench", `live-${opt("date") ?? today()}`));
  mkdirSync(dir, { recursive: true });
  const probe = join(dir, ".bench-ignore-check");
  writeFileSync(probe, "");
  const ignored = spawnSync("git", ["check-ignore", "-q", probe], { cwd: mainCheckout() }).status === 0;
  rmSync(probe, { force: true });
  if (!ignored) throw new Error(`${dir} is not git-ignored; live results must stay out of git (use research/ or pass --out to an ignored folder)`);
  return dir;
}
const toolsDir = () => join(mainCheckout(), "research", "bench", ".tools");
const pwCli = () => join(toolsDir(), "pw-mcp", "node_modules", "@playwright", "mcp", "cli.js");
const tsxCli = () => join(root, "node_modules", "tsx", "dist", "cli.mjs");
const ask = async (question: string) => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
};
const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
};

interface SessionInfo { wsUrl: string; httpEndpoint: string; controlPort: number; proxyPort: number; pid: number; lockedAt: string }
function session(dir: string): SessionInfo {
  const file = join(dir, "session.json");
  if (!existsSync(file)) throw new Error("No bench session: run `pnpm bench:base session` in another terminal first.");
  return JSON.parse(readFileSync(file, "utf8")) as SessionInfo;
}

// ------------------------------------------------------------------------------------------ setup
function setup() {
  const dir = join(toolsDir(), "pw-mcp");
  mkdirSync(dir, { recursive: true });
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--prefix", dir, "--no-save", "--no-audit", "--no-fund", `@playwright/mcp@${PLAYWRIGHT_MCP}`], { stdio: "inherit", shell: process.platform === "win32" });
  const version = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" }).stdout?.trim() || "not found";
  log(`playwright-mcp ${PLAYWRIGHT_MCP} at ${pwCli()} (${existsSync(pwCli()) ? "ok" : "missing"})`);
  log(`claude ${version(process.env.BENCH_CLAUDE ?? "claude", ["--version"])}; codex ${version(process.env.BENCH_CODEX ?? "codex", ["--version"])}`);
  log(`chrome ${findChrome() ?? "not found (set BENCH_CHROME)"}`);
}

// ------------------------------------------------------------------------------------------ preflight
/** Zero spend: the API base points at a closed local port, so no request reaches Anthropic; the init message is read and the process stopped. */
async function preflight() {
  if ((opt("client") ?? "claude") !== "claude") {
    log("Codex has no zero-spend init check; its argv is in clients.ts (codexArgs). The first real run's JSONL shows whether the MCP tools were called.");
    return;
  }
  const work = mkdtempSync(join(tmpdir(), "bench-preflight-"));
  const { claudeArgs, CLAUDE_ENV, clientCommand } = await import("./clients");
  const mcpConfig = join(work, "mcp.json");
  writeJson(mcpConfig, { mcpServers: { playwright: { command: process.execPath, args: [pwCli(), "--cdp-endpoint", "http://127.0.0.1:9"] } } });
  const child = spawn(clientCommand("claude"), [...claudeArgs({ model: opt("model", "claude-sonnet-5")!, budgetUsd: 0.01, mcpConfigPath: mcpConfig, mcpNames: ["playwright"] })], {
    cwd: work, env: { ...process.env, ...CLAUDE_ENV, ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }, stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdin.end("preflight");
  let buffer = "";
  const init = await new Promise<Record<string, unknown> | undefined>((done) => {
    const timer = setTimeout(() => done(undefined), 60_000);
    child.stdout.on("data", (c: Buffer) => {
      buffer += c.toString();
      for (const line of buffer.split("\n")) {
        try {
          const j = JSON.parse(line) as Record<string, unknown>;
          if (j.type === "system" && j.subtype === "init") {
            clearTimeout(timer);
            done(j);
          }
        } catch {}
      }
    });
  });
  child.kill();
  rmSync(work, { recursive: true, force: true });
  if (!init) throw new Error("preflight: no init message within 60 s");
  const servers = (init.mcp_servers ?? []) as Array<{ name: string; status: string }>;
  const plugins = ((init.plugins ?? []) as Array<{ path?: string; name: string }>).filter((p) => p.path !== "builtin").map((p) => p.name);
  const report = {
    version: init.claude_code_version, model: init.model, mcp: servers, mcpTools: ((init.tools ?? []) as string[]).filter((t) => t.startsWith("mcp__")).length,
    userPlugins: plugins, skills: (init.skills as unknown[] | undefined)?.length ?? 0, agents: init.agents,
  };
  console.log(JSON.stringify(report, null, 2));
  const ok = servers.some((s) => s.name === "playwright" && s.status === "connected") && !plugins.length && report.skills === 0;
  log(ok ? "preflight ok: clean install with the browser tools" : "preflight FAILED: see the report above");
  if (!ok) process.exitCode = 1;
}

// ------------------------------------------------------------------------------------------ session
async function sessionHolder() {
  const dir = liveDir();
  const chrome = findChrome();
  if (!chrome) throw new Error("Chrome or Edge not found; set BENCH_CHROME.");
  const cert = proxyCertificate(join(toolsDir(), "cert"));
  const proxy = await startProxy({ policy: UW_POLICY, cert, log: join(dir, "proxy-log.jsonl"), phase: "signin" });
  const profile = mkdtempSync(join(tmpdir(), "bench-browser-"));
  const browser = await launchChrome({ executable: chrome, userDataDir: profile, headless: false, proxy: `http://127.0.0.1:${proxy.port}`, spki: cert.spki, startUrl: `${ORIGIN}/` });
  const cleanup = async () => {
    rmSync(join(dir, "session.json"), { force: true });
    await browser.close();
    await proxy.close();
    rmSync(profile, { recursive: true, force: true });
  };
  process.on("SIGINT", () => void cleanup().then(() => process.exit(0)));
  const signIn = async () => {
    proxy.setPhase("signin");
    log("Sign in to Canvas in the bench browser window (NetID, then Duo). Writes are allowed only to the sign-in hosts until the dashboard loads.");
    await Promise.race([new Promise((r) => proxy.once("dashboard", r)), ask("…or press Enter here once the Canvas dashboard shows. ")]);
    const probe = await browserTransport(browser.wsUrl, ORIGIN);
    const r = await probe.get(`${ORIGIN}/api/v1/users/self/profile`);
    await probe.close();
    if (r.status !== 200) throw new Error(`sign-in check: profile read returned ${r.status}`);
    proxy.setPhase("locked");
    writeJson(join(dir, "session.json"), { wsUrl: browser.wsUrl, httpEndpoint: browser.httpEndpoint, controlPort: proxy.controlPort, proxyPort: proxy.port, pid: process.pid, lockedAt: new Date().toISOString() } satisfies SessionInfo);
    log(`Signed in; the proxy is now read-only (GET/HEAD). Session held in ${join(dir, "session.json")}.`);
  };
  await signIn();
  for (;;) {
    const answer = (await ask("[r] sign in again  [s] proxy state  [q] quit: ")).toLowerCase();
    if (answer === "q") break;
    if (answer === "r") await signIn();
    if (answer === "s") console.log(JSON.stringify({ phase: proxy.phase(), counters: proxy.counters() }));
  }
  await cleanup();
}

// ------------------------------------------------------------------------------------------ gold
async function gold() {
  const dir = liveDir();
  const s = session(dir);
  await proxyControl(s.controlPort).mark("gold");
  const t = await browserTransport(s.wsUrl, ORIGIN);
  try {
    const g = await crawlGold(t, { log });
    writeJson(join(dir, "gold.json"), g);
    log(`gold: ${JSON.stringify(goldCounts(g))}`);
  } finally {
    await t.close();
    await proxyControl(s.controlPort).mark("idle");
  }
}
const loadGold = (dir: string) => JSON.parse(readFileSync(join(dir, "gold.json"), "utf8")) as Gold;

// ------------------------------------------------------------------------------------------ Part A helpers
function ingestResult(base: Omit<IngestResult, "schema" | "part" | "git" | "preregistration" | "agendaUsableMs" | "score">, g: Gold, targetDb: string, timeline: Snapshot[]): IngestResult {
  const { rows, problems } = readTargetDb(targetDb);
  return { schema: "bench-result/1", part: "A", git: git(["rev-parse", "HEAD"]), preregistration: prereg(), ...base, agendaUsableMs: agendaUsableMs(g, timeline), score: scoreRows(g, rows, problems) };
}

/** One baseline ingestion: empty target DB in a fresh folder, the agent, a DB poll for the timeline. */
async function baselineRun(o: {
  spec: ClientSpec; run: number; dir: string; g: Gold; origin: string; mcp: (work: string) => McpServerSpec[]; budget: number; timeoutMs: number;
  repeat?: { budget: number; timeoutMs: number; before?: () => Promise<unknown> | unknown; goldAfter?: () => Promise<Gold> };
  mark?: (label: string) => Promise<void>; counters?: (label: string) => Promise<{ requests: number; blocked: number }>;
  fake?: (work: string) => { command: string; args: string[]; env: Record<string, string> }; source: "live" | "synthetic"; codexHome?: string; beforeRun?: () => Promise<void>;
}): Promise<IngestResult> {
  const label = `${o.spec.client}-${o.spec.model}-run${o.run}`;
  const work = join(o.dir, "work", label);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const db = join(work, "canvas.sqlite");
  createTargetDb(db);
  const toolsNote = "Tools: your browser tools; a shell with Node 24 (node:sqlite is built in) and Python 3 with pip (you may install packages into this folder). The sqlite3 command-line tool may not be installed.";
  const ctx = { origin: o.origin, today: o.g.now.slice(0, 10), dbFile: "canvas.sqlite", tools: toolsNote };
  const timeline: Snapshot[] = [];
  const started = Date.now();
  const poll = setInterval(() => {
    try {
      const copy = join(work, ".poll.sqlite");
      rmSync(copy, { force: true });
      snapshotDb(db, copy);
      const { rows } = readTargetDb(copy);
      timeline.push({ ms: Date.now() - started, counts: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, (v as unknown[]).length])), assignments: rows.assignments.map((a) => [a.id, a.due_at, a.points_possible]) });
    } catch {}
  }, 15_000);
  await o.beforeRun?.();
  await o.mark?.(label);
  const incomplete = () => {
    try {
      const { rows } = readTargetDb(db);
      return !rows.assignments.length || !rows.files.length || !rows.modules.length;
    } catch {
      return true;
    }
  };
  let agent: AgentRun;
  try {
    agent = await runAgent(
      { spec: o.spec, cwd: work, prompt: ingestionPrompt(ctx), mcp: o.mcp(work), budgetUsd: o.budget, timeoutMs: o.timeoutMs, prices: PRICES, logDir: join(o.dir, "logs"), label, codexHome: o.codexHome, ...(o.fake ? { fake: o.fake(work) } : {}) },
      { incomplete, prompt: continuePrompt(ctx) },
    );
  } finally {
    clearInterval(poll);
  }
  const counters = (await o.counters?.(label)) ?? { requests: 0, blocked: 0 };
  const final = join(o.dir, "dbs", `${label}.sqlite`);
  mkdirSync(dirname(final), { recursive: true });
  rmSync(final, { force: true });
  snapshotDb(db, final);
  timeline.push({ ms: Date.now() - started, counts: {}, assignments: readTargetDb(final).rows.assignments.map((a) => [a.id, a.due_at, a.points_possible]) });
  const last = agent.attempts[agent.attempts.length - 1]!;
  const result = ingestResult({
    side: "baseline", label, client: o.spec.client, model: last.model ?? o.spec.model, run: o.run, startedAt: new Date(started).toISOString(), source: o.source,
    wallMs: agent.wallMs, requests: counters.requests, blockedWrites: counters.blocked, tokens: agent.tokens, usd: agent.usd, usdEstimated: agent.usdEstimated,
    turns: agent.turns, attempts: agent.attempts.length, ...(last.stoppedBy ? { stoppedBy: last.stoppedBy } : {}),
  }, o.g, final, timeline);
  if (o.repeat) {
    await o.repeat.before?.();
    await o.mark?.(`${label}-repeat`);
    const again = await runAgent({ spec: o.spec, cwd: work, prompt: repeatPrompt(ctx), mcp: o.mcp(work), budgetUsd: o.repeat.budget, timeoutMs: o.repeat.timeoutMs, prices: PRICES, logDir: join(o.dir, "logs"), label: `${label}-repeat`, codexHome: o.codexHome, ...(o.fake ? { fake: o.fake(work) } : {}) });
    const rc = (await o.counters?.(`${label}-repeat`)) ?? { requests: 0, blocked: 0 };
    const g2 = (await o.repeat.goldAfter?.()) ?? o.g;
    const rows = readTargetDb(db).rows;
    result.repeat = { wallMs: again.wallMs, requests: rc.requests, tokens: again.tokens.input + again.tokens.output, usd: again.usd, pass: scoreRows(g2, rows).pass };
    result.blockedWrites += rc.blocked;
  }
  await o.mark?.("idle");
  writeJson(join(o.dir, "results", `${label}.json`), result);
  log(`${label}: ${result.score.pass ? "PASS" : "fail"} in ${Math.round(result.wallMs / 1000)} s, ${result.usd === null ? "cost n/a" : `$${result.usd}`}`);
  return result;
}

const playwrightMcp = (httpEndpoint: string) => (work: string): McpServerSpec[] => [
  { name: "playwright", command: process.execPath, args: [pwCli(), "--cdp-endpoint", httpEndpoint, "--output-dir", work] },
];

// ------------------------------------------------------------------------------------------ ours / baseline (live)
async function oursLive() {
  const dir = liveDir();
  const g = loadGold(dir);
  const runs = Number(opt("runs", "3"));
  for (let run = 1; run <= runs; run++) {
    const label = `ours-run${run}`;
    const work = join(dir, "work", label);
    rmSync(work, { recursive: true, force: true });
    let r: OursRun, requests: number, blocked = 0;
    if (opt("mode", "session") === "app") {
      r = await runOursApp({ root, directory: work, prompt: async (m) => void (await ask(`${m} `)), timeoutMs: 40 * 60_000, log });
      requests = r.requests;
    } else {
      const s = session(dir);
      const control = proxyControl(s.controlPort);
      const cdp = await Cdp.connect(s.wsUrl);
      await clearCache(cdp);
      cdp.close();
      await control.mark(label);
      const transport = await browserTransport(s.wsUrl, ORIGIN);
      try {
        r = await runOursSession({ transport, directory: work, repeat: flag("repeat"), log, beforeRepeat: () => control.mark(`${label}-repeat`) });
      } finally {
        await transport.close();
      }
      const state = await control.state();
      requests = state.runs[label]?.requests ?? r.requests;
      blocked = (state.runs[label]?.blocked ?? 0) + (state.runs[`${label}-repeat`]?.blocked ?? 0);
      await control.mark("idle");
    }
    const result = ingestResult({
      side: "ours", label, client: "ours", model: "none (code-first)", run, startedAt: new Date().toISOString(), source: "live", wallMs: r.syncMs, requests, blockedWrites: blocked,
      tokens: { input: r.tokens.input, cachedInput: r.tokens.cached, cacheCreation: 0, output: r.tokens.output }, usd: 0, usdEstimated: false, turns: 0, attempts: 1,
    }, g, r.targetDb, r.timeline);
    if (r.repeat) result.repeat = { wallMs: r.repeat.wallMs, requests: r.repeat.requests, tokens: r.repeat.tokens, usd: 0, pass: scoreRows(g, readTargetDb(r.repeat.targetDb).rows).pass };
    writeJson(join(dir, "results", `${label}.json`), result);
    log(`${label}: ${result.score.pass ? "PASS" : "fail"} in ${Math.round(r.syncMs / 1000)} s, ${requests} requests`);
  }
}

async function baselineLive() {
  const dir = liveDir();
  const g = loadGold(dir);
  const s = session(dir);
  if (!existsSync(pwCli())) throw new Error("Playwright MCP is not installed: run `pnpm bench:base setup`.");
  const spec: ClientSpec = { client: (opt("client") ?? "claude") as ClientSpec["client"], model: opt("model") ?? "claude-sonnet-5" };
  const control = proxyControl(s.controlPort);
  const minutes = (x: string | undefined, d: number) => Number(x ?? d) * 60_000;
  for (let run = 1; run <= Number(opt("runs", "3")); run++)
    await baselineRun({
      spec, run, dir, g, origin: ORIGIN, source: "live", mcp: playwrightMcp(s.httpEndpoint),
      budget: Number(opt("budget", "25")), timeoutMs: minutes(opt("timeout"), 40), codexHome: opt("codex-home"),
      ...(flag("repeat") ? { repeat: { budget: Number(opt("repeat-budget", "10")), timeoutMs: minutes(opt("repeat-timeout"), 20) } } : {}),
      mark: (label) => control.mark(label),
      counters: async (label) => (await control.state()).runs[label] ?? { requests: 0, blocked: 0 },
      beforeRun: async () => {
        const cdp = await Cdp.connect(s.wsUrl);
        await clearCache(cdp);
        await resetTabs(cdp);
        cdp.close();
      },
    });
}

// ------------------------------------------------------------------------------------------ Part B
async function runTrials(o: {
  dir: string; g: Gold; tasks: Task[]; spec: ClientSpec; condition: TaskCondition; origin: string; source: "live" | "synthetic";
  mcp: (work: string) => McpServerSpec[]; budget: number; timeoutMs: number; beforeTrial?: () => Promise<void>;
  fake?: (task: Task) => { command: string; args: string[]; env: Record<string, string> }; codexHome?: string;
}): Promise<TaskRunResult> {
  const trials: TrialResult[] = [];
  for (const task of o.tasks) {
    const label = `${o.spec.client}-${o.spec.model}-${o.condition}-${task.id}`;
    const work = join(o.dir, "work", "tasks", label);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    await o.beforeTrial?.();
    const run = await runAgent({
      spec: o.spec, cwd: work, prompt: taskPrompt({ origin: o.origin, condition: o.condition, question: task.question, today: o.g.now.slice(0, 10) }),
      mcp: o.mcp(work), budgetUsd: o.budget, timeoutMs: o.timeoutMs, prices: PRICES, logDir: join(o.dir, "logs", "tasks"), label, jsonSchema: task.schema,
      codexHome: o.codexHome, ...(o.fake ? { fake: o.fake(task) } : {}),
    });
    const a = run.attempts[0]!;
    let answer = a.structured;
    if (!answer && a.resultText) try { answer = JSON.parse(a.resultText.replace(/^```(?:json)?|```$/g, "").trim()); } catch {}
    const checked = checkAnswer(task, answer, o.g);
    const failure = checked.correct ? undefined : a.stoppedBy === "wall" ? "timeout" : a.stoppedBy ? "budget" : a.mcpConnected === false ? "tool_error" : a.exitCode !== 0 && !answer ? "agent_error" : checked.failure;
    trials.push({ taskId: task.id, family: task.family, correct: checked.correct, ...(failure ? { failure } : {}), wallMs: run.wallMs, usd: run.usd, tokens: run.tokens.input + run.tokens.output });
  }
  const result: TaskRunResult = { schema: "bench-tasks/1", part: "B", client: o.spec.client, model: o.spec.model, condition: o.condition, source: o.source, git: git(["rev-parse", "HEAD"]), preregistration: prereg(), trials };
  writeJson(join(o.dir, "results", `tasks-${o.spec.client}-${o.spec.model}-${o.condition}.json`), result);
  return result;
}

async function tasksLive() {
  const dir = liveDir();
  const g = loadGold(dir);
  const tasks = generateTasks(g);
  writeJson(join(dir, "tasks.json"), tasks);
  const sample = sampleTasks(tasks, Number(opt("trials", "10")));
  const specs = (opt("clients") ?? "claude:claude-opus-5-5,claude:claude-sonnet-5,codex:gpt-6-astra,codex:gpt-6-sol").split(",").map((x) => {
    const [client, model] = x.split(":");
    return { client, model } as ClientSpec;
  });
  const conditions = (opt("conditions") ?? "browser,ours").split(",") as TaskCondition[];
  const oursDb = opt("ours-db") ?? join(dir, "work", "ours-run1", "workspace.sqlite");
  const lanes: Promise<unknown>[] = [];
  // Two lanes at most: browser trials in sequence (one agent drives the shared browser at a time),
  // and the MCP condition, which needs no browser, alongside.
  if (conditions.includes("browser")) {
    const s = session(dir);
    const control = proxyControl(s.controlPort);
    lanes.push((async () => {
      for (const spec of specs)
        await runTrials({ dir, g, tasks: sample, spec, condition: "browser", origin: ORIGIN, source: "live", mcp: playwrightMcp(s.httpEndpoint),
          budget: Number(opt("budget-per-trial", "3")), timeoutMs: Number(opt("timeout-per-trial", "10")) * 60_000, codexHome: opt("codex-home"),
          beforeTrial: async () => {
            const cdp = await Cdp.connect(s.wsUrl);
            await resetTabs(cdp);
            cdp.close();
            await control.mark(`tasks-${spec.client}-${spec.model}`);
          } });
    })());
  }
  if (conditions.includes("ours"))
    lanes.push((async () => {
      for (const spec of specs) {
        const prepared = prepareOursMcp({ sourceDb: oursDb, dir: join(dir, "mcp"), recipient: spec.client === "codex" ? "codex" : "claude" });
        await runTrials({ dir, g, tasks: sample, spec, condition: "ours", origin: ORIGIN, source: "live",
          mcp: () => [{ name: "magic", command: process.execPath, args: [tsxCli(), join(here, "mcp-ours.ts"), "--db", prepared.db, "--grant", prepared.grant] }],
          budget: Number(opt("budget-per-trial", "3")), timeoutMs: Number(opt("timeout-per-trial", "10")) * 60_000, codexHome: opt("codex-home") });
      }
    })());
  await Promise.all(lanes);
}

// ------------------------------------------------------------------------------------------ report
function report(dir = opt("dir") ? resolve(opt("dir")!) : liveDir()) {
  const files = existsSync(join(dir, "results")) ? readdirSync(join(dir, "results")).filter((f) => f.endsWith(".json")) : [];
  const all = files.map((f) => JSON.parse(readFileSync(join(dir, "results", f), "utf8")) as IngestResult | TaskRunResult);
  const md = renderReport({
    ingest: all.filter((x): x is IngestResult => x.part === "A").sort((a, b) => a.label.localeCompare(b.label)),
    tasks: all.filter((x): x is TaskRunResult => x.part === "B"),
    ...(existsSync(join(dir, "gold.json")) ? { goldCounts: goldCounts(loadGold(dir)) } : {}),
    note: `Source: ${all[0]?.source ?? "n/a"}. Pre-registration ${prereg()}. Counts and timings only.`,
  });
  writeFileSync(join(dir, "report.md"), md);
  console.log(md);
}

// ------------------------------------------------------------------------------------------ dry run
async function dryRun() {
  const dir = resolve(opt("out") ?? join(root, ".data", "bench", `dry-${Date.now()}`));
  mkdirSync(dir, { recursive: true });
  const replica = await startReplica({ scale: (opt("scale") ?? "tiny") as "tiny" | "full", ...(opt("ocw") ? { ocwDir: opt("ocw") } : {}) });
  const cert = proxyCertificate(join(root, ".data", "bench", ".cert"));
  const host = new URL(replica.url).host;
  const proxy = await startProxy({ policy: { canvasHosts: [host], loginHosts: [], fileHosts: [] }, cert, log: join(dir, "proxy-log.jsonl"), phase: "signin" });
  try {
    // The operator's sign-in, simulated (a direct POST /login to the replica), then the proxy locks.
    const login = await fetch(`${replica.url}/login`, { method: "POST", body: new URLSearchParams(REPLICA_LOGIN), redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    proxy.setPhase("locked");
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    proxy.mark("gold");
    const g = await crawlGold(replicaTransport({ origin: replica.url, target: replica.url, cookie, proxy: proxyUrl }), { log, now: replica.account.now });
    writeJson(join(dir, "gold.json"), g);
    const truth = await replica.truth();
    if (!isDeepStrictEqual({ ...g, capturedAt: "", crawl: 0 }, { ...truth, capturedAt: "", crawl: 0 })) throw new Error("dry run: the gold crawl differs from the replica's truth");
    log(`gold == replica truth: ${JSON.stringify(goldCounts(g))}`);
    const fakeCommand = (env: Record<string, string>) => ({ command: process.execPath, args: [tsxCli(), join(here, "fake-agent.ts")], env });
    const base = { BENCH_FAKE_TARGET: replica.url, BENCH_FAKE_COOKIE: cookie, BENCH_FAKE_PROXY: proxyUrl };
    let changes: ReturnType<typeof replica.mutate> = [];
    const results: IngestResult[] = [];
    for (const [client, model] of [["fake", "fake-claude"], ["fake", "fake-codex"]] as const)
      results.push(await baselineRun({
        spec: { client, model }, run: 1, dir, g: await replica.truth(), origin: replica.url, source: "synthetic", mcp: () => [], budget: 5, timeoutMs: 5 * 60_000,
        fake: () => fakeCommand({ ...base, BENCH_FAKE_MODE: "ingest" }),
        mark: async (label) => proxy.mark(label), counters: async (label) => proxy.counters(label),
        repeat: { budget: 2, timeoutMs: 5 * 60_000, before: () => { if (!changes.length) changes = replica.mutate(); }, goldAfter: () => replica.truth() },
      }));
    for (const r of results) {
      const picked = changesPickedUp(await replica.truth(), readTargetDb(join(dir, "work", r.label, "canvas.sqlite")).rows, changes);
      r.repeat = { ...r.repeat!, changesPicked: `${picked.picked}/${picked.total}` };
      writeJson(join(dir, "results", `${r.label}.json`), r);
    }
    if (flag("with-ours")) {
      const work = join(dir, "work", "ours-run1");
      const r = await runOursSession({ transport: replicaTransport({ origin: ORIGIN, target: replica.url, cookie, proxy: proxyUrl }), directory: work, localExtractor: false, log });
      const result = ingestResult({ side: "ours", label: "ours-run1", client: "ours", model: "none (code-first)", run: 1, startedAt: new Date().toISOString(), source: "synthetic", wallMs: r.syncMs, requests: r.requests, blockedWrites: 0, tokens: { input: 0, cachedInput: 0, cacheCreation: 0, output: 0 }, usd: 0, usdEstimated: false, turns: 0, attempts: 1 }, await replica.truth(), r.targetDb, r.timeline);
      writeJson(join(dir, "results", "ours-run1.json"), result);
      void exportOurs;
    }
    // Part B, synthetic: the fake answers 7 in 10 tasks correctly (deterministic by task id).
    const g2 = await replica.truth();
    const sample = sampleTasks(generateTasks(g2), Number(opt("trials", "10")));
    await runTrials({
      dir, g: g2, tasks: sample, spec: { client: "fake", model: "fake-claude" }, condition: "browser", origin: replica.url, source: "synthetic", mcp: () => [], budget: 1, timeoutMs: 60_000,
      fake: (task) => fakeCommand({ BENCH_FAKE_MODE: "task", BENCH_FAKE_ANSWER: JSON.stringify(hash32(task.id) % 10 < 7 ? task.expected : wrongAnswer(task)) }),
    });
    if (replica.stats.writes.length) throw new Error(`dry run: ${replica.stats.writes.length} write(s) reached the replica: ${replica.stats.writes.join(", ")}`);
    log(`writes reaching the replica: 0; blocked by the proxy: ${Object.values(results).reduce((a, r) => a + r.blockedWrites, 0)}`);
    report(dir);
    log(`dry run written to ${dir}`);
  } finally {
    await proxy.close();
    await replica.close();
  }
}

const commands: Record<string, () => unknown> = {
  setup, preflight, session: sessionHolder, gold, ours: oursLive, baseline: baselineLive, tasks: tasksLive, report: () => report(), "dry-run": dryRun,
};
const run = commands[command];
if (!run) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
  process.exitCode = command === "help" ? 0 : 2;
} else
  Promise.resolve(run()).catch((error: unknown) => {
    log(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  });
