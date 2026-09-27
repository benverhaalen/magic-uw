/**
 * `pnpm semester [--live [--only=1,2]]`: per everyday action, what our system costs against a
 * typical AI study tool on the synthetic semester, then the per-semester projection for low / mid /
 * high use (./model.ts). Writes evals/semester/out/semester.json and semester.md (gitignored).
 * Headless and CI-safe without --live (no network, no credentials: the student's model is the fake
 * CLI). --live sends the baseline's prompts once each (or only the listed actions) through the
 * local `claude` CLI, set up as our runner's one-shot call, stopping at LIVE_CAP_USD.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { oneTimeCosts, runOurs, warmBurst, WARM_RUNS, type OurRow } from "./ours";
import { LIVE_CAP_USD, LIVE_MODEL, runTypical, type TypicalRow } from "./typical";
import { ASSUME, LEVELS, project, SYSTEMS, usageMix, type Level, type ProjectionInput, type SystemTotal } from "./model";
import { expectedFinalForB } from "./workspace";

const out = join(dirname(fileURLToPath(import.meta.url)), "out");
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const money = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

function actionTable(ours: OurRow[], typical: TypicalRow[]): string {
  const yes = (b: boolean | undefined) => (b === undefined ? "–" : b ? "yes" : "no");
  const head = "| # | Action | Entry point | Ours path (first → identical repeat) | Calls | Prompt tokens one-shot (prefix + input) | Warm-pool first turn | Est. output | Checks pass¹ | Plain command bar² | Code-path ms (first / warm)³ | Typical prompt tokens (prefix + question) | Typical est. output | Typical live |";
  const rule = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const lines = ours.map((o) => {
    const t = typical.find((x) => x.id === o.id)!;
    const live = t.live?.status === "ok" ? t.live : null;
    const liveCell = live ? `${money(live.costUsd!)}, ${Math.round(live.latencyMs!)} ms, in ${live.inputTokens} + cache w ${live.cacheCreationTokens} / r ${live.cacheReadTokens}, out ${live.outputTokens}, correct ${yes(live.correct)}` : t.live ? t.live.status : "not run";
    const latency = o.latencyKind === "code" ? `${o.firstMs} / ${o.warmMedianMs}` : `– (fake CLI) / ${o.warmMedianMs} ${o.entry === "pack handler + bar" ? "serving the saved set (code)" : "identical-repeat cache hit"}`;
    return `| ${o.id} | ${o.action} | ${o.entry} | ${o.path} → ${o.repeatPath} | ${o.calls} | ${o.tokens ? `${o.tokens} (${o.prefixTokens} + ${o.inputTokens})` : "0"} | ${o.pooled ? `${o.pooled.prefixTokens + o.pooled.inputTokens} (${o.pooled.prefixTokens} + ${o.pooled.inputTokens})` : "–"} | ${o.outputTokens || "–"} | ${yes(o.correct)}${o.calls ? " (code-side; model scripted)" : ""} | ${o.plainBar ?? "same"} | ${latency} | ${t.tokens} (${t.prefixTokens} + ${t.questionTokens}) | ${t.outputTokensEstimate} | ${liveCell} |`;
  });
  return [head, rule, ...lines].join("\n");
}

function projectionTable(totals: Record<Level, SystemTotal[]>): string {
  const head = "| System | Level | Model tokens / semester | $ at list price | Zero-token share of uses | Median latency per use |";
  const rule = "|---|---|---|---|---|---|";
  const lines: string[] = [];
  for (const s of SYSTEMS)
    for (const level of LEVELS) {
      const t = totals[level].find((x) => x.system === s.id)!;
      lines.push(`| ${s.label} | ${level} | ${fmt(t.tokens)} (in ${fmt(t.bill.fresh + t.bill.write + t.bill.read)}, of which cache reads ${fmt(t.bill.read)}; out ${fmt(t.bill.out)}) | ${money(t.usd)} | ${pct(t.zeroTokenShare)} | ${t.medianLatencyMs === null ? t.medianNote : `${t.medianLatencyMs} ms (${t.medianNote})`} |`);
    }
  return [head, rule, ...lines].join("\n");
}

async function main() {
  const live = process.argv.includes("--live");
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const only = onlyArg ? onlyArg.slice(7).split(",").map(Number) : undefined;
  const started = performance.now();
  const ours = await runOurs();
  const burst = await warmBurst();
  const oneTime = oneTimeCosts();
  const typical = await runTypical(expectedFinalForB(), live, only);
  const input: ProjectionInput = { ours, typical: typical.rows, burst: burst.turns };
  const headline = (id: number) => id !== 8 && id !== 9; // ours fails 8 and 9: excluded on both sides
  const all = () => true;
  const totals = (include: (id: number) => boolean, extra: Partial<ProjectionInput> = {}) =>
    Object.fromEntries(LEVELS.map((l) => [l, SYSTEMS.map((s) => project(l, s.id, { ...input, ...extra }, include))])) as Record<Level, SystemTotal[]>;
  const headlineTotals = totals(headline);
  const allTotals = totals(all);
  const scaleTotals = totals(headline, { corpusTokens: ASSUME.scaleCorpusTokens });

  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    method: {
      tokens: "tokens = ceil(characters / 4): an approximation, not a tokenizer. Ours counts every character that reached the fake CLI (system-prompt file + JSON schema + stdin); the baseline counts its prefix (instruction + sources) and question.",
      output: "Output tokens are estimates on both sides: ours is the size of the scripted reply (the shape the pack's schema forces); the baseline's is a stated length per action (typical.ts outputTokensEstimate). Neither is a live measurement.",
      latency: `Only code-path latency is measured (first run, then the median of ${WARM_RUNS} warm runs, in-process). A model-path first run spawns the fake CLI (a Node process), so it is left blank: it is not model time. The warm median of a model row is an identical-repeat cache hit, shown only as that, and is not comparable to a model call.`,
      correctness: "Code rows (1, 2, 6, 9) are checked end to end. On model rows the fake CLI returns scripted answers built to pass, so 'checks pass' covers only what code controls (evidence sent, quotes verified, IDs, dates, grading). It is not a head-to-head answer-quality comparison.",
      typical: `A Projects/NotebookLM-style notebook, in three billing variants (whole context; + prompt caching; retrieval + caching). The live check runs ${LIVE_MODEL} through claude -p with our runner's one-shot flags, capped at $${LIVE_CAP_USD}.`,
    },
    ours,
    warmBurst: burst,
    oneTime,
    typical: typical.rows,
    typicalSourcesChars: typical.sourcesChars,
    live: { ran: live, only: only ?? null, costUsd: typical.liveCostUsd, note: typical.liveNote },
    assumptions: ASSUME,
    usageMix: usageMix(),
    projection: { headline: headlineTotals, allActions: allTotals, scale: scaleTotals },
    elapsedMs: Math.round(performance.now() - started),
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "semester.json"), JSON.stringify(report, null, 2));

  const mid = (t: Record<Level, SystemTotal[]>, id: string) => t.mid.find((x) => x.system === id)!;
  const md = [
    `# Semester actions: ours vs a typical AI study tool`,
    "",
    `Generated ${report.generatedAt} · ${report.node} · ${Math.round(report.elapsedMs / 1000)} s`,
    "",
    "## Per semester (actions 1–7 and 10; 8 and 9 excluded on both sides because ours doesn't answer them)",
    "",
    projectionTable(headlineTotals),
    "",
    `Mid usage, headline: ours one-shot ${fmt(mid(headlineTotals, "ours-oneshot").tokens)} tokens (${money(mid(headlineTotals, "ours-oneshot").usd)}), warm pool ${fmt(mid(headlineTotals, "ours-warm-spread").tokens)}–${fmt(mid(headlineTotals, "ours-warm-burst").tokens)}; typical ${fmt(mid(headlineTotals, "typical-whole").tokens)} whole context, ${fmt(mid(headlineTotals, "typical-cached").tokens)} cached (${money(mid(headlineTotals, "typical-cached").usd)}), ${fmt(mid(headlineTotals, "typical-retrieval").tokens)} retrieval.`,
    "",
    "### All ten actions (ours' unanswered 8 and 9 included at what they spend)",
    "",
    projectionTable(allTotals),
    "",
    `### Scale sensitivity: a ${ASSUME.scaleCorpusTokens.toLocaleString("en-US")}-token corpus (assumed), headline actions`,
    "",
    projectionTable(scaleTotals),
    "",
    "## One-time costs",
    `- Ours, first sync: ${oneTime.studentModelCalls} student model calls. Pipeline jobs ${oneTime.pipelineJobs.join(", ")} are code; ${oneTime.stubJobs.join(", ")} is a stub, never enqueued. Jev (our gateway, not the student's model): ${oneTime.jevCalls} assignment-kind judgments for ${oneTime.assignments} synthetic assignments, once per title and text. ${oneTime.basis}`,
    "- Typical: uploading sources is not billed to the student as model tokens (not measured).",
    "",
    "## Per action",
    "",
    actionTable(ours, typical.rows),
    "",
    "¹ Model rows: the scripted model can't be wrong, so only code-controlled checks can fail. ² The same words typed in the command bar with no course open (or, for 4 and 5, the bar's own generation). ³ Code paths only; a model row's first time is a fake-CLI spawn and is blank, and its warm figure is an identical-repeat cache hit (rows 3, 7, 8, 10) or code serving the saved quiz or deck (rows 4, 5).",
    "",
    `Warm pool burst (5 asks, one course, one session): billed input per turn ${burst.turns.map((t) => t.billedInputTokens).join(", ")} tokens (prefix ${burst.turns[0]?.prefixTokens ?? 0} with the union schema; history carried); ${burst.spawns} session start(s).`,
    `Typical sources: ${typical.sourcesChars} characters (${Math.ceil(typical.sourcesChars / 4)} tokens).`,
    `Live baseline: ${live ? `ran${only ? ` for ${only.join(", ")}` : ""}, $${typical.liveCostUsd}` : "not run"}. ${typical.liveNote}`,
    "",
    "## Method",
    ...Object.values(report.method).map((m) => `- ${m}`),
    "",
    "## Usage mix (uses per day: low / mid / high)",
    ...usageMix().map((m) => `- ${m.id}. ${m.action}: ${m.perDay.low.toFixed(2)} / ${m.perDay.mid.toFixed(2)} / ${m.perDay.high.toFixed(2)} (${m.label}). ${m.basis}`),
    "",
    "## Assumptions",
    ...Object.entries(ASSUME).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## Checks and notes",
    ...ours.flatMap((o) => [`- **${o.id}. ${o.action}** (\`${o.utterance}\`, ${o.entry}): ${o.check}`, ...o.notes.map((n) => `  - ${n}`)]),
    ...typical.rows.map((t) => `- Typical ${t.id}: expects ${t.expectation}${t.live?.error ? `; live error: ${t.live.error}` : ""}`),
    "",
  ].join("\n");
  writeFileSync(join(out, "semester.md"), md);
  process.stdout.write(`${md}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
