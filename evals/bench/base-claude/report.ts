/**
 * The Markdown report: counts, rates, timings, tokens and cost only. No course names, titles, text
 * or ids, so it can be shared after the operator reviews it.
 */
import type { Score } from "./score";
import { bootstrap, type Failure } from "./tasks";
import type { Tokens } from "./clients";

export interface IngestResult {
  schema: "bench-result/1";
  part: "A";
  side: "ours" | "baseline";
  label: string;
  client: string;
  model: string;
  run: number;
  startedAt: string;
  git: string;
  preregistration: string;
  source: "live" | "synthetic";
  wallMs: number;
  agendaUsableMs: number | null;
  requests: number;
  blockedWrites: number;
  tokens: Tokens;
  usd: number | null;
  usdEstimated: boolean;
  turns: number;
  attempts: number;
  stoppedBy?: string;
  score: Score;
  repeat?: { wallMs: number; requests: number; tokens: number; usd: number | null; pass: boolean; changesPicked?: string };
}
export interface TrialResult { taskId: string; family: string; correct: boolean; failure?: Failure; wallMs: number; usd: number | null; tokens: number }
export interface TaskRunResult {
  schema: "bench-tasks/1"; part: "B"; client: string; model: string; condition: "browser" | "ours"; source: "live" | "synthetic";
  git: string; preregistration: string; trials: TrialResult[];
}

const s = (ms: number | null | undefined) => (ms === null || ms === undefined ? "n/a" : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number | null, estimated = false) => (x === null ? "n/a" : `$${x.toFixed(2)}${estimated ? " (est.)" : ""}`);
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function renderReport(input: { ingest: IngestResult[]; tasks: TaskRunResult[]; goldCounts?: Record<string, number>; note?: string }): string {
  const lines: string[] = ["# Ingestion and agent-task benchmark", ""];
  if (input.note) lines.push(input.note, "");
  if (input.goldCounts) lines.push(`Gold: ${Object.entries(input.goldCounts).map(([key, v]) => `${key} ${v}`).join(", ")}.`, "");
  if (input.ingest.length) {
    lines.push("## Part A: ingestion head-to-head", "",
      "| Side | Model | Run | Pass | Agenda-usable | Complete | Requests | Tokens in / cached / out | Cost | Assignments recall | Due exact | Points exact | Modules / items recall | Pages recall / text F1 | Files recall / text / sampled F1 | Syllabus | Wrong current | Extra rows | Blocked writes | Repeat sync |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const r of input.ingest) {
      const sc = r.score;
      const extra = sc.assignments.extra + sc.modules.extra + sc.items.extra + sc.pages.extra + sc.files.extra + sc.groups.extra;
      const repeat = r.repeat ? `${s(r.repeat.wallMs)}, ${r.repeat.requests} req, ${k(r.repeat.tokens)} tok, ${usd(r.repeat.usd)}${r.repeat.changesPicked ? `, changes ${r.repeat.changesPicked}` : ""}, ${r.repeat.pass ? "pass" : "fail"}` : "n/a";
      lines.push(`| ${r.side === "ours" ? "ours" : r.client} | ${r.model} | ${r.run} | ${r.score.pass ? "PASS" : "fail"} | ${s(r.agendaUsableMs)} | ${s(r.wallMs)}${r.stoppedBy ? ` (${r.stoppedBy} cap)` : ""} | ${r.requests} | ${k(r.tokens.input)} / ${k(r.tokens.cachedInput)} / ${k(r.tokens.output)} | ${usd(r.usd, r.usdEstimated)} | ${pct(sc.assignments.recall)} | ${pct(sc.assignments.dueExact)} | ${pct(sc.assignments.pointsExact)} | ${pct(sc.modules.recall)} / ${pct(sc.items.recall)} | ${pct(sc.pages.recall)} / ${sc.pages.textF1Mean.toFixed(2)} | ${pct(sc.files.recall)} / ${pct(sc.files.textPresent)} / ${sc.files.sampledF1Mean.toFixed(2)} | ${sc.syllabus.present}/${sc.syllabus.gold} | ${sc.courses.wrongCurrent + sc.courses.currentMissing} | ${extra} | ${r.blockedWrites} | ${repeat} |`);
    }
    lines.push("", "Failed checks per run:", "");
    for (const r of input.ingest) {
      const failed = r.score.checks.filter((c) => !c.pass);
      lines.push(`- ${r.label}: ${failed.length ? failed.map((c) => `${c.name} = ${c.value} (needs ${c.threshold})`).join("; ") : "none"}`);
    }
    lines.push("");
  }
  if (input.tasks.length) {
    lines.push("## Part B: academic agent tasks", "", "| Client | Model | Condition | Trials | pass@1 [95% CI] | Cost per correct | Median latency | Failures |", "|---|---|---|---|---|---|---|---|");
    for (const t of input.tasks) {
      const correct = t.trials.filter((x) => x.correct).length;
      const ci = bootstrap(t.trials.map((x) => (x.correct ? 1 : 0)));
      const spend = t.trials.every((x) => x.usd !== null) ? t.trials.reduce((a, x) => a + (x.usd ?? 0), 0) : null;
      const latency = [...t.trials.map((x) => x.wallMs)].sort((a, b) => a - b)[Math.floor(t.trials.length / 2)] ?? null;
      const failures: Record<string, number> = {};
      for (const x of t.trials) if (x.failure) failures[x.failure] = (failures[x.failure] ?? 0) + 1;
      lines.push(`| ${t.client} | ${t.model} | ${t.condition} | ${t.trials.length} | ${pct(ci.mean)} [${pct(ci.low)}, ${pct(ci.high)}] | ${spend === null ? "n/a" : correct ? usd(spend / correct) : "no correct answers"} | ${s(latency)} | ${Object.entries(failures).map(([key, v]) => `${key} ${v}`).join(", ") || "none"} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
