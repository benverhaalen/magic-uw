// The benchmark harness's own checks (evals/bench/base-claude): the gold crawler against the replica's
// truth, the scorer, the proxy's read-only policy, the task checker and the client stream parser.
import assert from "node:assert/strict";
import test from "node:test";
import { crawlGold } from "../evals/bench/base-claude/gold";
import { REPLICA_LOGIN, startReplica } from "../evals/bench/base-claude/replica-server";
import { replicaTransport } from "../evals/bench/base-claude/transport";
import { goldToRows, scoreRows } from "../evals/bench/base-claude/score";
import { decide, UW_POLICY } from "../evals/bench/base-claude/proxy";
import { checkAnswer, generateTasks, wrongAnswer } from "../evals/bench/base-claude/tasks";
import { foldLine, codexArgs, claudeArgs } from "../evals/bench/base-claude/clients";

async function tinyGold() {
  const replica = await startReplica({ scale: "tiny", anchor: new Date("2026-09-27T00:00:00Z") });
  const login = await fetch(`${replica.url}/login`, { method: "POST", body: new URLSearchParams(REPLICA_LOGIN), redirect: "manual" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const gold = await crawlGold(replicaTransport({ origin: replica.url, target: replica.url, cookie }), { now: replica.account.now });
  return { replica, gold };
}

test("bench gold: the independent crawl equals the replica's truth, and reads nothing it may not", async () => {
  const { replica, gold } = await tinyGold();
  try {
    const truth = await replica.truth();
    const strip = (g: typeof gold) => ({ ...g, capturedAt: "", crawl: g.crawl.filesListHidden });
    assert.deepEqual(strip(gold), strip(truth));
    assert.equal(gold.courses.filter((c) => c.current).length, 2);
    assert.ok(gold.courses.some((c) => c.restricted && !c.current));
    assert.equal(gold.crawl.filesListHidden, 1);
    assert.deepEqual(replica.stats.writes, []);
  } finally {
    await replica.close();
  }
});

test("bench score: a perfect database passes; wrong current courses, dates and missing files fail", async () => {
  const { replica, gold } = await tinyGold();
  await replica.close();
  assert.equal(scoreRows(gold, goldToRows(gold)).pass, true);
  const rows = goldToRows(gold);
  rows.courses.find((c) => !gold.courses.find((g) => g.id === c.id)!.current)!.is_current = 1;
  rows.assignments[0]!.due_at = "2030-01-01T00:00:00Z";
  rows.files = rows.files.slice(2);
  const score = scoreRows(gold, rows);
  assert.equal(score.pass, false);
  assert.equal(score.courses.wrongCurrent, 1);
  assert.equal(score.assignments.dueMismatch, 1);
  assert.equal(score.files.missing, 2);
});

test("bench proxy: GET only after sign-in; LTI, quiz take and logout always blocked", () => {
  const d = (phase: "signin" | "locked", method: string, host: string, path: string, body?: string) => decide(UW_POLICY, phase, { method, host, path, body });
  assert.equal(d("signin", "POST", "login.wisc.edu", "/idp/profile/SAML2"), undefined);
  assert.equal(d("signin", "POST", "canvas.wisc.edu", "/login/saml"), undefined);
  assert.equal(d("signin", "POST", "canvas.wisc.edu", "/courses/1/assignments/2/submissions"), "write_during_signin");
  assert.equal(d("locked", "GET", "canvas.wisc.edu", "/api/v1/courses"), undefined);
  assert.equal(d("locked", "POST", "canvas.wisc.edu", "/courses/1/assignments/2/submissions"), "write");
  assert.equal(d("locked", "PUT", "canvas.wisc.edu", "/api/v1/courses/1"), "write");
  assert.equal(d("locked", "POST", "login.wisc.edu", "/idp/x"), "write");
  assert.equal(d("locked", "GET", "canvas.wisc.edu", "/courses/1/external_tools/5"), "lti_launch");
  assert.equal(d("locked", "GET", "canvas.wisc.edu", "/courses/1/quizzes/3/take"), "quiz_take");
  assert.equal(d("locked", "GET", "canvas.wisc.edu", "/logout"), "logout");
  assert.equal(d("locked", "POST", "canvas.wisc.edu", "/api/graphql", '{"query":"query { course { name } }"}'), undefined);
  assert.equal(d("locked", "POST", "canvas.wisc.edu", "/api/graphql", '{"query":"mutation { createSubmission }"}'), "write");
  assert.equal(d("locked", "GET", "evil.example", "/page"), "host_not_allowed");
  assert.equal(d("locked", "GET", "du11hjcvx0uqb.cloudfront.net", "/dist/app.js"), undefined);
});

test("bench tasks: 60 checkable tasks; the expected answer passes and a wrong one fails", async () => {
  const replica = await startReplica({ scale: "full", anchor: new Date("2026-09-27T00:00:00Z") });
  try {
    const gold = await replica.truth({ filesSampledPerCourse: 0 });
    const tasks = generateTasks(gold);
    assert.equal(tasks.length, 60);
    assert.equal(new Set(tasks.map((t) => t.family)).size, 10);
    for (const task of tasks) {
      assert.equal(checkAnswer(task, task.expected, gold).correct, true, task.id);
      assert.equal(checkAnswer(task, wrongAnswer(task), gold).correct, false, task.id);
    }
  } finally {
    await replica.close();
  }
});

test("bench clients: stream parsing and argv keep the clean-install flags", () => {
  const s = { tokens: { input: 0, cachedInput: 0, cacheCreation: 0, output: 0 }, turns: 0, model: null, mcpConnected: null, reportedUsd: null, subtype: null, text: null, structured: null };
  foldLine("claude", JSON.stringify({ type: "system", subtype: "init", model: "m", mcp_servers: [{ status: "connected" }] }), s);
  foldLine("claude", JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 } } }), s);
  foldLine("claude", JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.5, num_turns: 3, structured_output: { a: 1 } }), s);
  assert.deepEqual([s.tokens.input, s.tokens.cachedInput, s.tokens.output, s.reportedUsd, s.turns, s.mcpConnected], [110, 100, 5, 0.5, 3, true]);
  const c = { ...s, tokens: { input: 0, cachedInput: 0, cacheCreation: 0, output: 0 }, turns: 0 };
  foldLine("codex", JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } }), c);
  assert.deepEqual([c.tokens.input, c.tokens.cachedInput, c.tokens.output, c.turns], [1000, 800, 50, 1]);
  const claude = claudeArgs({ model: "claude-sonnet-5", budgetUsd: 10, mcpConfigPath: "m.json", mcpNames: ["playwright"] });
  for (const f of ["--strict-mcp-config", "--disable-slash-commands", "--max-budget-usd", "--setting-sources"]) assert.ok(claude.includes(f), f);
  assert.ok(!claude.includes("--safe-mode"), "--safe-mode drops --mcp-config servers");
  const codex = codexArgs({ model: "gpt-6-sol", cwd: ".", mcp: [{ name: "playwright", command: "node", args: ["cli.js"] }] });
  for (const f of ["--ignore-user-config", "--ephemeral", "computer_use"]) assert.ok(codex.includes(f), f);
});
