/**
 * Headless performance harness: `pnpm magic:perf --suite baseline`.
 * Writes .data/perf/<git sha>/baseline.json and baseline.md (gitignored).
 * Exit codes: 0 done · 1 no recorded git SHA (or a run failure) · 2 usage (unknown suite).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem, type as osType, release, version as osVersion, arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { canvasFirstSync, runBaseline } from "./baseline";
import { renderMarkdown } from "./report";
import { documentStage } from "./documents"; // owner: acquisition
import { privacyStage } from "./privacy"; // owner: privacy

/** `canvas`: only the first full Canvas sync (T17), for quick before/after runs. */
/** `documents` (owner: acquisition): the course-file stage, earlier loop against the app's. */
/** `privacy` (owner: privacy): the protection pass against its absolute budgets on this machine. */
const SUITES = ["baseline", "canvas", "documents", "privacy"] as const;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseSuite(argv: string[]): string | undefined {
  const index = argv.indexOf("--suite");
  if (index >= 0) return argv[index + 1];
  const inline = argv.find((a) => a.startsWith("--suite="));
  return inline ? inline.slice("--suite=".length) : "baseline";
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function machine() {
  const db = new DatabaseSync(":memory:");
  const sqlite = String((db.prepare("select sqlite_version() as v").get() as { v: string }).v);
  db.close();
  const cpu = cpus();
  return {
    os: { platform: platform(), type: osType(), release: release(), version: osVersion(), arch: arch() },
    cpuModel: cpu[0]?.model.trim() ?? "unknown",
    cores: cpu.length,
    ramBytes: totalmem(),
    node: process.version,
    sqlite,
  };
}

async function main() {
  const suite = parseSuite(process.argv.slice(2));
  if (!suite || !(SUITES as readonly string[]).includes(suite)) {
    console.error(`magic:perf: unknown suite "${suite ?? ""}". Known suites: ${SUITES.join(", ")}.`);
    process.exitCode = 2;
    return;
  }
  let sha: string;
  try {
    sha = git(["rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`unexpected output "${sha}"`);
  } catch (error) {
    console.error(
      "magic:perf: refusing to run: no recorded git SHA (`git rev-parse HEAD` failed). A baseline must be tied to a commit.",
      error instanceof Error ? `\n  ${error.message.split("\n")[0]}` : "",
    );
    process.exitCode = 1;
    return;
  }
  const dirty = git(["status", "--porcelain", "--untracked-files=normal"]).length > 0;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const { metrics, recording } =
    suite === "canvas"
      ? { metrics: { canvasFirstSync: await canvasFirstSync() }, recording: undefined }
      : suite === "documents"
        ? { metrics: { documentStage: await documentStage() }, recording: undefined }
        : suite === "privacy"
          ? { metrics: { privacy: privacyStage() }, recording: undefined }
        : await runBaseline();
  const report = {
    schema: "magic-perf/1",
    suite,
    git: { sha, dirty },
    machine: machine(),
    startedAt,
    durationMs: Number((performance.now() - started).toFixed(1)),
    plan: "docs/plans/2026-09-26-backend-optimization/plan.md §1",
    data: "synthetic only: packages/connectors/src/canvas-fixture.ts responses and evals/perf/synthetic.ts corpus; no network",
    metrics,
  };
  const out = join(root, ".data", "perf", sha);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${suite}.json`), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(out, `${suite}.md`), renderMarkdown(report));
  if (recording) writeFileSync(join(out, "canvas-replay.json"), JSON.stringify(recording, null, 2) + "\n");
  console.log(`magic:perf ${suite}: wrote ${join(out, `${suite}.json`)}${dirty ? " (dirty tree)" : ""}`);
}

main().catch((error) => {
  console.error("magic:perf: run failed:", error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
