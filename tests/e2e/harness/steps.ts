/** Named, timed steps; printed as a table and saved beside the trace. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface StepRecord {
  name: string;
  ms: number;
  ok: boolean;
  error?: string;
}

export function createSteps(label: string, options: { onFail?: (name: string) => Promise<string> } = {}) {
  const records: StepRecord[] = [];
  let failureText = "";
  return {
    records,
    async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const started = performance.now();
      try {
        const value = await fn();
        records.push({ name, ms: Math.round(performance.now() - started), ok: true });
        return value;
      } catch (error) {
        records.push({ name, ms: Math.round(performance.now() - started), ok: false, error: error instanceof Error ? error.message.split("\n")[0] : String(error) });
        // What the page showed when the step failed (DOM text, not a screenshot).
        failureText = (await options.onFail?.(name).catch(() => "")) ?? "";
        throw error;
      }
    },
    async report(artifacts: string): Promise<string> {
      const width = Math.max(...records.map((r) => r.name.length), 4);
      const lines = [
        `${label}: ${records.filter((r) => r.ok).length}/${records.length} steps passed, ${records.reduce((n, r) => n + r.ms, 0)} ms`,
        ...records.map((r) => `  ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${String(r.ms).padStart(6)} ms${r.error ? `  ${r.error}` : ""}`),
      ];
      if (failureText) lines.push("  page text at the failure:", ...failureText.split("\n").slice(0, 40).map((l) => `    | ${l}`));
      const text = lines.join("\n");
      await writeFile(join(artifacts, "steps.json"), JSON.stringify({ label, records, failureText }, null, 2)).catch(() => undefined);
      console.log(text);
      return text;
    },
  };
}
