/** Renders a perf report as a Markdown table: one row per metric leaf. */
import type { Metric } from "./stats";

type Report = {
  suite: string;
  git: { sha: string; dirty: boolean };
  machine: {
    os: { type: string; release: string; arch: string };
    cpuModel: string;
    cores: number;
    ramBytes: number;
    node: string;
    sqlite: string;
  };
  startedAt: string;
  durationMs: number;
  metrics: Record<string, unknown>;
};

const isMetric = (value: unknown): value is Metric =>
  !!value &&
  typeof value === "object" &&
  "status" in value &&
  ((value as Metric).status === "measured" || (value as Metric).status === "not-measured");

const fmt = (n: unknown) =>
  typeof n === "number" ? (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString("en-US") : String(n)) : String(n);

function rows(node: unknown, path: string[], out: string[][], courses: string[][]) {
  if (isMetric(node)) {
    if (node.status === "not-measured") {
      out.push([path.join("."), `not-measured: ${node.reason}`, "", ""]);
      return;
    }
    const value =
      node.p50 !== undefined
        ? `p50 ${fmt(node.p50)} · p95 ${fmt(node.p95)}`
        : fmt(node.value);
    out.push([path.join("."), value, node.unit, String(node.n)]);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, child] of Object.entries(node)) {
    if (key === "perCourse" && child && typeof child === "object") {
      for (const [course, t] of Object.entries(child as Record<string, Record<string, number>>))
        courses.push([path.join("."), course, fmt(t.requests), fmt(t.bytes), t.spanMs === undefined ? "" : fmt(t.spanMs)]);
      continue;
    }
    rows(child, [...path, key], out, courses);
  }
}

export function renderMarkdown(report: Report): string {
  const table: string[][] = [],
    courses: string[][] = [];
  rows(report.metrics, [], table, courses);
  const m = report.machine;
  const lines = [
    `# Perf ${report.suite}: ${report.git.sha.slice(0, 12)}${report.git.dirty ? " (dirty tree)" : ""}`,
    "",
    `- Commit: \`${report.git.sha}\`, dirty: ${report.git.dirty}`,
    `- Machine: ${m.os.type} ${m.os.release} ${m.os.arch}; ${m.cpuModel}; ${m.cores} cores; ${(m.ramBytes / 2 ** 30).toFixed(1)} GiB RAM`,
    `- Node ${m.node}; SQLite ${m.sqlite}`,
    `- Started ${report.startedAt}; took ${(report.durationMs / 1000).toFixed(1)} s. Synthetic data only; replay transport, no network.`,
    "",
    "| Metric | Value | Unit | n |",
    "|---|---|---|---|",
    ...table.map((r) => `| ${r.map((c) => c.replaceAll("|", "\\|")).join(" | ")} |`),
    "",
    "## Canvas sync per course (last replayed run)",
    "",
    "| Run | Course | Requests | Bytes | Span ms |",
    "|---|---|---|---|---|",
    ...courses.map((r) => `| ${r.join(" | ")} |`),
    "",
  ];
  return lines.join("\n");
}
