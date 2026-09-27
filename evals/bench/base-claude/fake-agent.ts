/**
 * The fake CLI for dry runs: speaks Claude Code's stream-json so the runner, caps, parsing, scoring
 * and report are exercised without spending model usage. Ingest mode crawls the synthetic replica
 * through the bench proxy and writes the target database with two deliberate, realistic mistakes
 * (files reachable only through links are missed; the orientation site is marked current), then
 * attempts one write so the dry run shows the proxy blocking it. Task mode answers from
 * BENCH_FAKE_ANSWER. Env: BENCH_FAKE_MODE, BENCH_FAKE_TARGET, BENCH_FAKE_COOKIE, BENCH_FAKE_PROXY.
 */
import http from "node:http";
import { crawlGold } from "./gold";
import { goldToRows } from "./score";
import { TABLES } from "./schema";
import { replicaTransport } from "./transport";
import { DatabaseSync } from "node:sqlite";

const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const usage = (n: number) => ({ input_tokens: 400 * n, cache_read_input_tokens: 9000 * n, cache_creation_input_tokens: 1200, output_tokens: 300 * n });

async function main() {
  const mode = process.env.BENCH_FAKE_MODE ?? "ingest";
  emit({ type: "system", subtype: "init", model: "fake-model", mcp_servers: [{ name: "fake", status: "connected" }], tools: [] });
  if (mode === "task") {
    emit({ type: "assistant", message: { usage: usage(1) } });
    const answer = JSON.parse(process.env.BENCH_FAKE_ANSWER ?? "{}");
    emit({ type: "result", subtype: "success", total_cost_usd: 0.012, num_turns: 2, result: JSON.stringify(answer), structured_output: answer });
    return;
  }
  const target = process.env.BENCH_FAKE_TARGET!, cookie = process.env.BENCH_FAKE_COOKIE!, proxy = process.env.BENCH_FAKE_PROXY;
  const transport = replicaTransport({ origin: target, target, cookie, ...(proxy ? { proxy } : {}) });
  const gold = await crawlGold(transport, { filesSampledPerCourse: 100 });
  const rows = goldToRows(gold);
  const linkOnly = new Set(gold.files.filter((f) => f.reachableVia.length === 1 && f.reachableVia[0] === "link").map((f) => f.id));
  rows.files = rows.files.filter((f) => !linkOnly.has(f.id));
  for (const c of rows.courses) if (/orientation/i.test(c.name)) c.is_current = 1;
  const db = new DatabaseSync("canvas.sqlite");
  db.exec("BEGIN");
  for (const table of TABLES) {
    const list = rows[table] as unknown as Record<string, unknown>[];
    for (const row of list) {
      const cols = Object.keys(row);
      db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(
        ...cols.map((k) => (row[k] === undefined ? null : (row[k] as string | number | null))),
      );
    }
    emit({ type: "assistant", message: { usage: usage(1) } });
  }
  db.exec("COMMIT");
  db.close();
  // One write attempt through the proxy (a quiz start): the proxy must answer 403.
  if (proxy) {
    const course = gold.courses.find((c) => c.current)!;
    const p = new URL(proxy), t = new URL(target);
    const status = await new Promise<number>((resolve) => {
      const req = http.request({ host: p.hostname, port: Number(p.port), method: "POST", path: `${t.origin}/courses/${course.id}/assignments/1/submissions`, headers: { host: t.host, cookie } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", () => resolve(0));
      req.end("submission[body]=x");
    });
    emit({ type: "assistant", message: { usage: usage(1) }, note: `write attempt answered ${status}` });
  }
  emit({ type: "result", subtype: "success", total_cost_usd: 0.42, num_turns: TABLES.length + 2, result: TABLES.map((t) => `${t}: ${(rows[t] as unknown[]).length}`).join(", ") });
}
main().catch((error) => {
  emit({ type: "result", subtype: "error_during_execution", total_cost_usd: 0, num_turns: 0, result: String(error) });
  process.exitCode = 1;
});
