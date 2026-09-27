/**
 * Compares two benchmark runs of different rules without new Jev calls.
 *   pnpm exec tsx evals/notifications/compare.ts --before <run with --jev> --after <code-only run> --out <dir>
 * "after" supplies the new code level for every item (joined by id); "before" supplies the
 * recorded Jev answer. Jev's own level is re-derived from the recorded kind, probabilities and
 * action score with the shipped thresholds, keeping "urgent" only where the before run's rules
 * made it urgent (affects is not re-evaluated). Writes b9_rules_comparison.csv.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { JEV_THRESHOLDS } from "@magic/domain";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i < 0) throw new Error(`--${n} is required.`);
  return resolve(process.argv[i + 1]!);
};
const before = arg("before"), after = arg("after"), out = arg("out");
function readCsv(dir: string, name: string) {
  const [head, ...lines] = readFileSync(join(dir, name), "utf8").trim().split("\n");
  const cols = head!.split(",");
  return lines.map((line) => {
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
    return Object.fromEntries(cols.map((c, k) => [c, cells[k] ?? ""])) as Record<string, string>;
  });
}
const RANK: Record<string, number> = { "": 0, none: 0, ignore: 0, suppressed: 0, info: 1, important: 2, urgent: 3 };
const LEVEL = ["suppressed", "info", "important", "urgent"];
const max = (a: string, b: string) => LEVEL[Math.max(RANK[a] ?? 0, RANK[b] ?? 0)]!;
const ANN_RAISE = ["deadline_or_schedule_change", "exam_logistics", "action_required", "grade_or_feedback_released"];
const MAIL_RAISE = ["interview_or_job", "deadline_or_action_required", "schedule_change_or_cancellation", "advisor_or_academic_standing"];
const MAIL_INFO = ["campus_event", "club_or_org_update", "course_related"];
function jevLevel(r: Record<string, string>, corpus: "ann" | "mail") {
  if (!r.jev_kind || r.jev_error) return "suppressed";
  const gated = Number(r.jev_top) >= JEV_THRESHOLDS.kindMinP && Number(r.jev_margin) >= JEV_THRESHOLDS.kindMinMargin;
  const acts = Number(r.jev_action) >= JEV_THRESHOLDS.yes;
  const raise = corpus === "ann" ? ANN_RAISE : MAIL_RAISE;
  if (raise.includes(r.jev_kind) && (gated || acts)) return r.final_level === "urgent" ? "urgent" : "important";
  if (corpus === "mail" && MAIL_INFO.includes(r.jev_kind) && (gated || acts)) return "info";
  return "suppressed";
}
function metrics(pairs: [string, string][]) {
  const badge = (l: string) => (RANK[l] ?? 0) >= 2;
  const tp = pairs.filter(([a, b]) => badge(a) && badge(b)).length;
  const fp = pairs.filter(([a, b]) => !badge(a) && badge(b)).length;
  const fn = pairs.filter(([a, b]) => badge(a) && !badge(b)).length;
  const p = tp / (tp + fp || 1), r = tp / (tp + fn || 1);
  const norm = (s: string) => LEVEL[RANK[s] ?? 0];
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { n: pairs.length, exact_accuracy: r3(pairs.filter(([a, b]) => norm(a) === norm(b)).length / (pairs.length || 1)), badge_precision: r3(p), badge_recall: r3(r), badge_f1: r3((2 * p * r) / (p + r || 1)), badge_share: r3(pairs.filter(([, b]) => badge(b)).length / (pairs.length || 1)) };
}
const rows: Record<string, unknown>[] = [];
for (const [file, key, corpus, label] of [
  ["b5_synthetic_announcements.csv", "id", "ann", "synthetic announcements"],
  ["b6_synthetic_email.csv", "id", "mail", "synthetic email"],
  ["b2_announcements_real.csv", "bench_id", "ann", "P02 real announcements (unlabeled)"],
] as const) {
  const oldRows = readCsv(before, file);
  const newRows = readCsv(after, file);
  // Runs before bench_id became stable generated different ids for real rows; fall back to a
  // composite key and compare only the rows that key identifies uniquely in both runs.
  const sameIds = newRows.some((r) => oldRows.some((o) => o[key] === r[key]));
  const keyOf = (r: Record<string, string>) => (sameIds ? r[key]! : `${r.course}|${r.age_days}|${r.raw_chars}`);
  const unique = (rows: Record<string, string>[]) => {
    const n = new Map<string, number>();
    for (const r of rows) n.set(keyOf(r), (n.get(keyOf(r)) ?? 0) + 1);
    return rows.filter((r) => n.get(keyOf(r)) === 1);
  };
  const old = new Map(unique(oldRows).map((r) => [keyOf(r), r]));
  const now = unique(newRows).filter((r) => old.has(keyOf(r)));
  const joined = now.map((r) => {
    const o = old.get(keyOf(r))!;
    return { label: r.label ?? "", oldCode: o.code_level ?? "", newCode: r.code_level!, oldFinal: o.final_level || o.code_level || "", jev: jevLevel(o, corpus) };
  });
  const variants: [string, (j: (typeof joined)[number]) => string][] = [
    ["rules v1 · code only", (j) => j.oldCode],
    ["rules v1 · code + Jev", (j) => j.oldFinal],
    ["rules v2 · code only", (j) => j.newCode],
    ["rules v2 · code + Jev (estimated)", (j) => max(j.newCode, j.jev)],
  ];
  for (const [name, pick] of variants) {
    const pairs = joined.map((j) => [j.label, pick(j)] as [string, string]);
    rows.push({ rules: name, corpus: label, ...(label.includes("unlabeled") ? { n: pairs.length, badge_share: metrics(pairs).badge_share } : metrics(pairs)) });
  }
}
const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
writeFileSync(join(out, "b9_rules_comparison.csv"), [cols.join(","), ...rows.map((r) => cols.map((c) => r[c] ?? "").join(","))].join("\n") + "\n");
console.table(rows);
