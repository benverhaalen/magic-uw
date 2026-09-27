/**
 * Renders a scored run in the reporting template of the benchmark-validity brief: every number
 * with n, a 95% interval, the machine and model, the git SHA and date, the exact command, the
 * frozen case files, the corpus tier, who judged it, and what it cannot show.
 */
import type { Report } from "./metrics";
import { formatRate, type Rate } from "./stats";

export interface RunMeta {
  schema: "magic-item-eval/1";
  suite: string;
  mode: "offline" | "live";
  command: string;
  git: { sha: string; dirty: boolean };
  startedAt: string;
  durationMs: number;
  machine: Record<string, unknown>;
  client: string;
  models: string[];
  tiers: string[];
  cases: { dir: string; frozen: "verified" | string[] };
  thresholdsSha256: string;
  plantedSha256: string;
  courses: { id: string; family: string; tier: string }[];
}

const CANNOT_SHOW: Record<"offline" | "live", string> = {
  offline:
    "Offline items come from a rule-based offline model that follows the prompt literally, not a language model: these numbers measure the app's code (the pack path, checks, pipeline, cache and store), not the quality of any model's writing. Planted defects and gold topics are builder-written, not independent.",
  live:
    "One client and model on one date over the listed corpora; code metrics only (no human or LLM rating), no planted defects and no false-drop labels (those are measured offline). OCW text is public and may be in the model's training data (contamination not ruled out).",
};

export function renderMarkdown(meta: RunMeta, report: Report): string {
  const lines: string[] = [];
  const r = (x: Rate) => formatRate(x);
  lines.push(`# Item-quality run: ${meta.suite} (${meta.mode})`, "");
  lines.push(`- **Commit:** ${meta.git.sha}${meta.git.dirty ? " (dirty tree)" : ""}; **date:** ${meta.startedAt}; **duration:** ${(meta.durationMs / 1000).toFixed(1)} s`);
  lines.push(`- **Measured by:** \`${meta.command}\``);
  lines.push(`- **Client and model:** ${meta.client}; models reported: ${meta.models.join(", ") || "none"}`);
  lines.push(`- **Machine:** ${String(meta.machine.cpuModel)} (${String(meta.machine.cores)} cores), ${String(meta.machine.platform)}, Node ${String(meta.machine.node)}`);
  lines.push(`- **Corpus tier:** ${meta.tiers.join(", ")}; courses: ${meta.courses.map((c) => `${c.id} (${c.family})`).join(", ")}`);
  lines.push(`- **Case files:** ${meta.cases.dir} (${meta.cases.frozen === "verified" ? "frozen manifest verified" : `FROZEN MISMATCH: ${meta.cases.frozen.join("; ")}`}); thresholds sha256 ${meta.thresholdsSha256.slice(0, 16)}; planted sha256 ${meta.plantedSha256.slice(0, 16)}`);
  lines.push(`- **Compared against:** internal only, no comparative claim made`);
  lines.push(`- **Judge:** code-computed metrics (thresholds.json, registered before the first scored run)`);
  lines.push(`- **What this cannot show:** ${CANNOT_SHOW[meta.mode]}`, "");
  lines.push("## Pre-registered metrics", "");
  lines.push("| Metric | Result (k/n; Wilson 95% CI) | Threshold | Verdict |", "|---|---|---|---|");
  for (const row of report.rows) {
    const th = row.threshold ? (row.threshold.min !== undefined ? `>= ${row.threshold.min}` : row.threshold.max !== undefined ? `<= ${row.threshold.max}` : "diagnostic") : "none";
    lines.push(`| ${row.id} | ${r(row.rate)}${row.note ? ` (${row.note})` : ""} | ${th} | ${row.verdict} |`);
  }
  if (report.failures.length) {
    lines.push("", "## Pack runs that did not complete", "");
    for (const f of report.failures) lines.push(`- ${f.unit}: ${f.status}: ${f.message}`);
  }
  lines.push("", "## Subject fit (per course, whole-course scope)", "");
  if (!report.subjectFit.length) lines.push("No course with a known subject family.");
  for (const f of report.subjectFit) {
    lines.push(`- **${f.course}** (${f.family}): ${f.pass ? "pass" : "FAIL"}`);
    for (const c of f.checks) lines.push(`  - ${c.pass ? "pass" : "FAIL"}: ${c.rule}${c.detail ? ` (${c.detail})` : ""}`);
  }
  lines.push("", "## Planted defects", "");
  if (!report.planted.length) lines.push("None planted in this run.");
  else {
    lines.push("| Defect | Needs a judge | Expected stage | n | Caught | Dropped at the expected stage |", "|---|---|---|---|---|---|");
    for (const p of report.planted) lines.push(`| ${p.id} | ${p.requiresJudge ? "yes (not run offline)" : "no"} | ${p.expectedStage ?? "-"} | ${p.n} | ${p.caught} | ${p.atExpectedStage} |`);
  }
  lines.push("", "## Items per course", "", "| Course | Family | Tier | Written | Stored | Dropped by stage |", "|---|---|---|---|---|---|");
  for (const c of report.perCourse) lines.push(`| ${c.course} | ${c.family} | ${c.tier} | ${c.generated} | ${c.accepted} | ${Object.entries(c.dropped).map(([k, v]) => `${k} ${v}`).join(", ") || "-"} |`);
  if (report.falseDrops.length) {
    lines.push("", "## Offline-model items dropped (correctness drops are false drops; cue-flaw drops count in flawRate)", "");
    for (const d of report.falseDrops.slice(0, 40)) lines.push(`- ${d.course} ${d.pack}: ${d.stage}: ${d.reason} ("${d.stem}")`);
  }
  lines.push("", "## Diagnostics (no threshold)", "", "```json", JSON.stringify(report.diagnostics, (k, v) => (k === "passageUse" ? undefined : v), 2), "```", "");
  return lines.join("\n");
}

export function failedRows(report: Report): string[] {
  return report.rows.filter((r) => r.verdict === "missed").map((r) => r.id);
}
