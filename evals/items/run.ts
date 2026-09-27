/**
 * The item-quality harness (measurement plan MT4): `pnpm eval:items --suite <smoke|offline|live>`.
 *
 *   smoke    offline, two synthetic courses, whole-course scope (what CI runs, small n)
 *   offline  offline, four synthetic courses by subject family, whole-course and per-material
 *            scopes, plus the local OCW corpus when present (never committed)
 *   live     the student's own signed-in client (the app's isolated profile); no planted items
 *
 * Live options: --user-data <the app's userData folder> [--client claude|codex]
 *               [--db <workspace.sqlite> --course <courseId>] (a real course, on a temp copy)
 * Common:       [--corpus synthetic|ocw|all] [--ocw <dir>] [--out <dir>]
 *
 * Writes .data/evals/items/<sha>/<suite>-<time>/{report.json,report.md,items.jsonl} (gitignored).
 * Exit codes: 0 every threshold met · 1 a threshold missed or a run failure · 2 usage · 3 refused.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeBackend, createCodexBackend, type CliCommand, type ModelBackend } from "../../packages/runner/src/index";
import { pooledClaudeBackend } from "../../packages/core/src/pack-handler";
import { isProfileReady, profileEnv, readClientSettings, resolveClient, workDir } from "../../apps/desktop/src/clients/profiles";
import { verify } from "../freeze";
import { CASES_DIR, DEFAULT_OCW_DIR, ocwCourses, syntheticCourses } from "./corpus";
import { inspectCourse, resetOfflineRotation, runHarness, type CourseCase, type HarnessOptions, type HarnessResult } from "./harness";
import { loadThresholds, score, THRESHOLDS_PATH, type Report } from "./metrics";
import { loadDefects } from "./planted";
import { failedRows, renderMarkdown, type RunMeta } from "./report";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FAKE_CLI = join(root, "tests", "fixtures", "fake-cli", "fake-cli.mjs");
export const SUITES = ["smoke", "offline", "live"] as const;
export type Suite = (typeof SUITES)[number];

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path, "utf8").replace(/\r\n/g, "\n")).digest("hex");

/** The fake CLI as the student's client: it answers with whatever the harness put in its env. */
export function offlineBackend(env: Record<string, string>): ModelBackend {
  const work = mkdtempSync(join(tmpdir(), "item-eval-"));
  const command: CliCommand = { file: process.execPath, prefixArgs: [FAKE_CLI, "claude"] };
  return createClaudeBackend({ command, workDir: work, env });
}

export interface SuiteRun {
  result: HarnessResult;
  report: Report;
  courses: CourseCase[];
  mode: "offline" | "live";
  client: string;
}

/** Runs an offline suite in-process (the CI test calls this). */
export async function runOffline(suite: "smoke" | "offline", options: { corpus?: string; ocwDir?: string; log?: (s: string) => void } = {}): Promise<SuiteRun> {
  resetOfflineRotation();
  const corpus = options.corpus ?? (suite === "smoke" ? "synthetic" : "all");
  const courses = [
    ...(corpus !== "ocw" ? syntheticCourses(suite === "smoke" ? ["computing", "languages"] : undefined) : []),
    ...(corpus !== "synthetic" && suite === "offline" ? ocwCourses(options.ocwDir ?? DEFAULT_OCW_DIR) : []),
  ];
  const defects = loadDefects(CASES_DIR);
  const harness: HarnessOptions = {
    courses,
    packs: ["cards", "quiz"],
    counts: { quiz: 12, cards: 12 },
    scopes: suite === "smoke" ? "course" : "course+modules",
    backend: { kind: "offline", fake: offlineBackend, plantsPerCall: 3, defects, probeUnparseable: true },
    log: options.log,
  };
  const result = await runHarness(harness);
  return { result, report: score(result, defects, "offline"), courses, mode: "offline", client: "offline model via the fake CLI (tests/fixtures/fake-cli)" };
}

async function liveBackend(argv: string[]): Promise<{ backend: () => ModelBackend; recipient: "claude" | "codex"; client: string } | string> {
  const userData = arg(argv, "user-data");
  if (!userData) return "--user-data is required for a live run: the app's userData folder holding clients/<client>/ (the app-owned, signed-in profile).";
  const chosen = (arg(argv, "client") ?? (await readClientSettings(userData)).chosen) as "claude" | "codex" | undefined;
  if (chosen !== "claude" && chosen !== "codex") return "Choose --client claude or --client codex (or pick one in the app first).";
  if (!(await isProfileReady(chosen, userData))) return `The ${chosen} profile under ${userData} is not set up. Sign in inside the app first; this harness never signs in.`;
  const command = resolveClient(chosen, { userData });
  if (!command) return `The ${chosen} CLI was not found on this machine.`;
  const env = Object.fromEntries(Object.entries(profileEnv(chosen, { userData })).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])));
  const options = { command, workDir: workDir(userData, chosen), env };
  // The same backends the app's worker uses (apps/desktop/src/worker.ts).
  return { backend: () => (chosen === "claude" ? pooledClaudeBackend(options) : createCodexBackend(options)), recipient: chosen, client: `${chosen} (app profile at ${userData})` };
}

async function runLive(argv: string[], log: (s: string) => void): Promise<SuiteRun | string> {
  const live = await liveBackend(argv);
  if (typeof live === "string") return live;
  const corpus = arg(argv, "corpus") ?? "all";
  const db = arg(argv, "db");
  let courses: CourseCase[];
  if (db) {
    const courseId = arg(argv, "course");
    if (!courseId) return "--db needs --course <courseId>.";
    // Read from a temp copy; the student's database is never opened for writing.
    const found = inspectCourse(resolve(db), courseId);
    if (!found) return `No course ${courseId} in ${db}.`;
    // A placeholder batch carries the ids; the store copy already holds the course.
    courses = [
      {
        id: courseId,
        family: found.family,
        tier: "private",
        dbPath: resolve(db),
        gold: [],
        batch: { source: { id: "db", kind: "canvas", accountScope: found.accountScope, courseId, scope: "course", label: "workspace copy" }, observedAt: new Date().toISOString(), complete: true, status: "ok", resources: [] },
      },
    ];
  } else
    courses = [
      ...(corpus !== "ocw" ? syntheticCourses() : []),
      ...(corpus !== "synthetic" ? ocwCourses(arg(argv, "ocw") ?? DEFAULT_OCW_DIR) : []),
    ];
  const defects = loadDefects(CASES_DIR);
  const result = await runHarness({
    courses,
    packs: ["cards", "quiz"],
    counts: { quiz: Number(arg(argv, "quiz-count") ?? 8), cards: Number(arg(argv, "cards-count") ?? 10) },
    scopes: "course",
    backend: { kind: "live", backend: live.backend, recipient: live.recipient },
    log,
  });
  return { result, report: score(result, defects, "live"), courses, mode: "live", client: live.client };
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function writeRun(run: SuiteRun, meta: RunMeta, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), JSON.stringify({ meta, report: run.report }, null, 2));
  writeFileSync(join(outDir, "report.md"), renderMarkdown(meta, run.report));
  // Stored items for the blind rubric export (evals/items/blind.ts). Course text stays in .data.
  const lines = run.result.items
    .filter((i) => i.stored && !i.planted)
    .flatMap((i) => [i.stored!, ...i.derived].map((s) => ({ course: i.course, family: i.family, tier: i.tier, pack: i.pack, mode: run.mode, generator: s.item.generator, item: { id: s.item.id, kind: s.item.kind, stem: s.item.stem, options: s.item.options, key: s.item.key, unit: s.item.unit ?? null }, quote: s.sources[0]?.quote ?? null })));
  writeFileSync(join(outDir, "items.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
}

async function main(argv: string[]): Promise<number> {
  const suite = (arg(argv, "suite") ?? "offline") as Suite;
  if (!SUITES.includes(suite)) {
    console.error(`eval:items: unknown suite "${suite}". Known suites: ${SUITES.join(", ")}.`);
    return 2;
  }
  let sha: string;
  try {
    sha = git(["rev-parse", "HEAD"]);
  } catch {
    console.error("eval:items: refusing to run: no recorded git SHA. A result must be tied to a commit.");
    return 3;
  }
  const dirty = git(["status", "--porcelain", "--untracked-files=normal"]).length > 0;
  const frozen = verify(CASES_DIR);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const log = (s: string) => console.log(s);
  const run = suite === "live" ? await runLive(argv, log) : await runOffline(suite, { corpus: arg(argv, "corpus"), ocwDir: arg(argv, "ocw"), log });
  if (typeof run === "string") {
    console.error(`eval:items: ${run}`);
    return 3;
  }
  loadThresholds();
  const meta: RunMeta = {
    schema: "magic-item-eval/1",
    suite,
    mode: run.mode,
    command: `pnpm eval:items ${argv.join(" ")}`.trim(),
    git: { sha, dirty },
    startedAt,
    durationMs: performance.now() - started,
    machine: { platform: `${platform()} ${release()}`, cpuModel: cpus()[0]?.model.trim() ?? "unknown", cores: cpus().length, ramBytes: totalmem(), node: process.version },
    client: run.client,
    models: run.result.models,
    tiers: [...new Set(run.courses.map((c) => c.tier))],
    cases: { dir: "evals/items/cases", frozen: frozen.length ? frozen : "verified" },
    thresholdsSha256: sha256(THRESHOLDS_PATH),
    plantedSha256: sha256(join(CASES_DIR, "planted.json")),
    courses: run.courses.map((c) => ({ id: c.id, family: c.family, tier: c.tier })),
  };
  const outDir = resolve(arg(argv, "out") ?? join(root, ".data", "evals", "items", sha.slice(0, 12), `${suite}-${startedAt.replace(/[:.]/g, "-")}`));
  writeRun(run, meta, outDir);
  console.log(renderMarkdown(meta, run.report));
  console.log(`\nWrote ${outDir}`);
  if (frozen.length) {
    console.error(`eval:items: the case files changed since they were frozen: ${frozen.join("; ")}`);
    return 1;
  }
  const missed = failedRows(run.report);
  if (missed.length) console.error(`eval:items: missed: ${missed.join(", ")}`);
  return missed.length ? 1 : 0;
}

if (process.argv[1] && /run\.ts$/.test(process.argv[1]) && /items/.test(process.argv[1]))
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
