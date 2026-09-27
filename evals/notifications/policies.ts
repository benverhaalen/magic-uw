/**
 * Offline policy comparison from a benchmark run's recorded Jev answers (no new calls).
 *   pnpm exec tsx evals/notifications/policies.ts --out <the run's --out folder>
 * For each raise policy it re-decides whether Jev's raise would survive, keeping the level the
 * real rules produced when it does (so "urgent via affects" is preserved), and scores the
 * labeled synthetic corpora plus the badge load on real announcements. Writes
 * b8_policy_comparison.csv. An approximation: affects is not re-evaluated per policy.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const i = process.argv.indexOf("--out");
if (i < 0) throw new Error("--out <run folder> is required.");
const out = resolve(process.argv[i + 1]!);
function readCsv(name: string) {
  const [head, ...lines] = readFileSync(join(out, name), "utf8").trim().split("\n");
  const cols = head!.split(",");
  return lines.map((line) => {
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
    return Object.fromEntries(cols.map((c, k) => [c, cells[k] ?? ""]));
  });
}
const RANK: Record<string, number> = { suppressed: 0, ignore: 0, "": 0, none: 0, info: 1, important: 2, urgent: 3 };
const badge = (l: string) => RANK[l]! >= 2;
type Row = Record<string, string>;
type Policy = { name: string; keep(r: Row, corpus: "announcement" | "email"): boolean };
const ANN_STRONG = ["deadline_or_schedule_change", "exam_logistics", "grade_or_feedback_released"];
const MAIL_STRONG = ["interview_or_job", "schedule_change_or_cancellation", "advisor_or_academic_standing", "deadline_or_action_required"];
const policies: Policy[] = [
  { name: "code only", keep: () => false },
  { name: "code + Jev (shipped)", keep: () => true },
  {
    name: "no action-only raises",
    keep: (r, c) => (c === "announcement" ? ANN_STRONG.includes(r.jev_kind!) : MAIL_STRONG.includes(r.jev_kind!)),
  },
  {
    name: "strict gate (top ≥ 0.85, lead ≥ 0.3)",
    keep: (r) => Number(r.jev_top) >= 0.85 && Number(r.jev_margin) >= 0.3,
  },
  {
    name: "no action-only + strict gate",
    keep: (r, c) =>
      (c === "announcement" ? ANN_STRONG.includes(r.jev_kind!) : MAIL_STRONG.includes(r.jev_kind!)) &&
      Number(r.jev_top) >= 0.85 &&
      Number(r.jev_margin) >= 0.3,
  },
];
const decide = (r: Row, p: Policy, c: "announcement" | "email") => {
  const code = r.code_level ?? "suppressed";
  const final = r.final_level || code;
  const raised = RANK[final]! > RANK[code]!;
  return raised && !p.keep(r, c) ? code : final;
};
function score(rows: Row[], p: Policy, c: "announcement" | "email") {
  const pairs = rows.filter((r) => !r.jev_error).map((r) => [r.label!, decide(r, p, c)] as const);
  const tp = pairs.filter(([a, b]) => badge(a) && badge(b)).length;
  const fp = pairs.filter(([a, b]) => !badge(a) && badge(b)).length;
  const fn = pairs.filter(([a, b]) => badge(a) && !badge(b)).length;
  const precision = tp / (tp + fp || 1), recall = tp / (tp + fn || 1);
  const norm = (s: string) => (s === "ignore" || s === "none" || s === "" ? "suppressed" : s);
  return {
    n: pairs.length,
    exact: pairs.filter(([a, b]) => norm(a) === norm(b)).length / (pairs.length || 1),
    precision, recall, f1: (2 * precision * recall) / (precision + recall || 1),
    badge_share: pairs.filter(([, b]) => badge(b)).length / (pairs.length || 1),
  };
}
const ann = readCsv("b5_synthetic_announcements.csv");
const mail = readCsv("b6_synthetic_email.csv");
const real = readCsv("b2_announcements_real.csv");
const rows: Record<string, unknown>[] = [];
const r3 = (x: number) => Math.round(x * 1000) / 1000;
for (const p of policies) {
  for (const [corpus, data, c] of [["synthetic announcements", ann, "announcement"], ["synthetic email", mail, "email"]] as const) {
    const s = score(data, p, c);
    rows.push({ policy: p.name, corpus, n: s.n, exact_accuracy: r3(s.exact), badge_precision: r3(s.precision), badge_recall: r3(s.recall), badge_f1: r3(s.f1), badge_share: r3(s.badge_share) });
  }
  const realLevels = real.filter((r) => !r.jev_error).map((r) => decide(r, p, "announcement"));
  rows.push({ policy: p.name, corpus: "P02 real announcements (unlabeled)", n: realLevels.length, badge_share: r3(realLevels.filter(badge).length / (realLevels.length || 1)) });
}
const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
writeFileSync(join(out, "b8_policy_comparison.csv"), [cols.join(","), ...rows.map((r) => cols.map((c) => r[c] ?? "").join(","))].join("\n") + "\n");
console.table(rows);
