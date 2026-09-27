/**
 * The baseline for `pnpm semester`: a typical AI study tool (a Projects / NotebookLM-style
 * notebook). The student uploads every course source; a question is answered from them; a quiz
 * or a deck is generated once per topic and saved (reviews are free); there is no local
 * structured data, so dates, counts and scores come from the model reading the sources. The
 * prompt is built from the same synthetic semester and its size counted (tokens = ceil(chars / 4),
 * stated, not a tokenizer). How the size is billed (whole context, prompt caching, retrieval) is
 * modelled per variant in ./model.ts.
 *
 * `--live` runs each prompt once through the student's own Claude Code, set up exactly as our
 * runner's one-shot call (packages/runner/src/claude.ts claudeOneShotArgs): our system prompt
 * from a file (instruction + sources), the question alone on stdin, tools off, no MCP, project and
 * local settings only, no saved session, spawned without a shell, from one fixed folder so the
 * sources prefix can be read from the provider's cache.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliEnvironment, resolveCli, runProcess, type CliCommand } from "../../packages/runner/src/process";
import { HASHING, percentNear, semesterWorkspace, TZ } from "./workspace";

export const LIVE_MODEL = "claude-sonnet-5";
export const LIVE_CAP_USD = 15;

export interface TypicalAction {
  id: number;
  question: string;
  /** Model calls per generation (quizzes and cards) or per use (everything else). */
  calls: number;
  /** A stated estimate of the reply's length in tokens (the typical tool's generated text). */
  outputTokensEstimate: number;
  check: (answer: string) => boolean;
  expectation: string;
}

/**
 * Row 1's check: the three titles due Sep 28–Oct 4 are named, and no line asserts Homework 4 as
 * due this week. Homework 4 was due Oct 7 before the move and Oct 9 after it, both outside the
 * week, so a line that mentions it with either date, or says it is not due / moved / next week,
 * is correct; a line that mentions it with neither is read as listing it as due this week.
 */
export function dueThisWeekCorrect(answer: string): boolean {
  const lower = answer.toLowerCase();
  if (!["problem set 2", "homework 3", "essay 1"].every((t) => lower.includes(t))) return false;
  const outsideWeek = /oct(?:ober)?\.?\s*(?:7|8|9|10)\b|next week|not (?:due|this week)|isn't due|no longer|moved|outside|later|instead/i;
  return answer
    .split(/\n|(?<=\.)\s+/)
    .filter((line) => /homework 4\b/i.test(line))
    .every((line) => outsideWeek.test(line));
}

/** The ten questions as the student types them into the notebook, with a code check on the reply. */
export function typicalActions(needOnFinal: number): TypicalAction[] {
  const has = (a: string, ...xs: (string | RegExp)[]) => xs.every((x) => (typeof x === "string" ? a.toLowerCase().includes(x.toLowerCase()) : x.test(a)));
  const numbered = (a: string) => a.split("\n").filter((l) => /^\s*(?:\*\*)?(?:Q(?:uestion)?\s*)?\d{1,2}[.):]/i.test(l)).length;
  const quotesNotes = (a: string) => HASHING.some((s) => a.includes(s.slice(0, 40)));
  return [
    { id: 1, question: "What's due this week?", calls: 1, outputTokensEstimate: 80, expectation: "Problem Set 2, Homework 3 and Essay 1; Homework 4 not listed as due this week (it was due Oct 7 and is now due Oct 9, both after Oct 4)", check: dueThisWeekCorrect },
    { id: 2, question: "What changed since yesterday?", calls: 1, outputTokensEstimate: 80, expectation: "Homework 4 moved to Friday Oct 9; a new announcement", check: (a) => has(a, "Homework 4", /Oct(?:ober)?\.? 9|Friday/) },
    { id: 3, question: "Explain hash tables from lecture, quoting the lecture notes.", calls: 1, outputTokensEstimate: 250, expectation: "an explanation with at least one verbatim quote from the Lecture 5 notes", check: (a) => has(a, "bucket", "collision") && quotesNotes(a) },
    { id: 4, question: "Quiz me on hash tables: write 5 numbered multiple-choice questions with the answers.", calls: 1, outputTokensEstimate: 450, expectation: "5 numbered questions", check: (a) => numbered(a) >= 5 },
    { id: 5, question: "Make 20 numbered flashcards (front and back) on hash tables for me to review.", calls: 1, outputTokensEstimate: 900, expectation: "20 numbered cards", check: (a) => numbered(a) >= 20 },
    { id: 6, question: "Find the slides for hashing.", calls: 1, outputTokensEstimate: 60, expectation: "names Lecture 5 slides: Hashing", check: (a) => has(a, "Lecture 5 slides") },
    { id: 7, question: "When and where is the midterm, and what's on it?", calls: 1, outputTokensEstimate: 80, expectation: "Oct 15, 7:15–9:15 PM, Room 1240 CS; lectures 1–6", check: (a) => has(a, /October 15|Oct\.? 15/, "1240", /hashing/i) },
    { id: 8, question: "What do I need on the final for a B if I get 80 on the midterm?", calls: 1, outputTokensEstimate: 150, expectation: `${needOnFinal}% ±1 (homework 93%, midterm 80, weights 30/30/40, B = 83)`, check: (a) => percentNear(a, needOnFinal) },
    { id: 9, question: "Summarize the new announcement.", calls: 1, outputTokensEstimate: 100, expectation: "Homework 4 now due Friday Oct 9; autograder fix; office hours in Room 1207", check: (a) => has(a, /Oct(?:ober)?\.? 9|Friday/, "1207") },
    { id: 10, question: "Open the email from my TA about the regrade.", calls: 1, outputTokensEstimate: 80, expectation: "names the TA's regrade email (a notebook can't open mail; it can only point to a pasted copy)", check: (a) => has(a, "regrade", /46\s*\/\s*50|46 out of 50/) },
  ];
}

const localDate = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Everything a student would upload: each course's syllabus, notes, slides and readings, every
 * assignment page (due date, points, score), the announcements, and the inbox pasted in.
 */
export function typicalSources(): string {
  const { store } = semesterWorkspace();
  const out: string[] = [];
  for (const r of store.resources()) {
    if (r.deleted || r.kind === "course") continue;
    const lines = [`## ${r.kind === "message" && r.mail ? "Email" : r.kind === "message" ? "Announcement" : r.kind === "assignment" ? "Assignment" : "Material"}: ${r.title} (${r.courseName})`];
    if (r.kind === "assignment") {
      if (r.dueAt) lines.push(`Due: ${localDate(r.dueAt)}`);
      if (r.points !== null && r.points !== undefined) lines.push(`Points: ${r.points}`);
      const sub = (r as { submission?: { score?: number | null } | null }).submission;
      if (sub?.score !== null && sub?.score !== undefined) lines.push(`Score: ${sub.score}/${r.points}`);
      const group = (r as { assignmentGroup?: { weight?: number } }).assignmentGroup;
      if (group?.weight !== undefined) lines.push(`Assignment group weight: ${group.weight}%`);
    }
    if (r.mail) lines.push(`From: ${r.mail.fromName ?? ""} · ${localDate(r.mail.receivedAt)}`);
    if (r.kind === "message" && !r.mail && r.createdAt) lines.push(`Posted: ${localDate(r.createdAt)}`);
    if (r.text) lines.push(r.text);
    out.push(lines.join("\n"));
  }
  store.close();
  return out.join("\n\n");
}

/** The byte-stable prefix: the instruction and every source. The question follows on its own. */
export function typicalSystem(sources: string): string {
  return [
    "You are a study assistant. Answer the student's question using only the sources below. Today is Monday, September 28, 2026, 10:00 AM (America/Chicago).",
    `<sources>\n${sources}\n</sources>`,
  ].join("\n\n");
}

export interface TypicalRow {
  id: number;
  question: string;
  /** Characters and tokens of the byte-stable prefix (instruction + sources) and of the question. */
  prefixChars: number;
  prefixTokens: number;
  questionTokens: number;
  /** prefixTokens + questionTokens: what one call sends before any caching discount. */
  tokens: number;
  outputTokensEstimate: number;
  calls: number;
  expectation: string;
  live: LiveResult | null;
}
export interface LiveResult {
  status: "ok" | "failed" | "skipped_cap";
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  numTurns?: number;
  correct?: boolean;
  error?: string;
}

/** The fixed folder every live call runs from: the same cwd each time keeps the CLI's prefix stable. */
const LIVE_DIR = join(tmpdir(), "magic-semester-live");

/** Our runner's one-shot argv without a schema (the notebook answers in free text). */
export function typicalArgs(prefixPath: string): string[] {
  return ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "project,local", "--no-session-persistence", "--system-prompt-file", prefixPath, "--model", LIVE_MODEL];
}

function liveCommand(): CliCommand | null {
  const override = process.env.SEMESTER_CLAUDE;
  return override ? { file: override, prefixArgs: [] } : resolveCli("claude");
}

/** One plain model call set up as our runner's: system prompt from a file, question on stdin, no shell. */
export async function claudeOnce(prefixPath: string, question: string): Promise<LiveResult & { answer?: string }> {
  const command = liveCommand();
  if (!command) return { status: "failed", error: "claude CLI not found" };
  const started = performance.now();
  try {
    const { code, stdout, stderr } = await runProcess(command, typicalArgs(prefixPath), { stdin: question, cwd: LIVE_DIR, env: cliEnvironment(), timeoutMs: 180_000 });
    const latencyMs = performance.now() - started;
    let parsed: { is_error?: boolean; result?: string; total_cost_usd?: number; num_turns?: number; usage?: Record<string, number> } | null = null;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      parsed = null;
    }
    if (!parsed || code !== 0 || parsed.is_error) return { status: "failed", latencyMs, error: (parsed?.result ?? stderr ?? stdout).slice(0, 300) || `exit ${code}` };
    // Tools are off: a tool-less answer is one turn. More turns means the call wasn't what it claims.
    if ((parsed.num_turns ?? 1) > 1) return { status: "failed", latencyMs, numTurns: parsed.num_turns, error: `expected a tool-less single turn, got ${parsed.num_turns} turns` };
    const u = parsed.usage ?? {};
    return {
      status: "ok", latencyMs, answer: parsed.result ?? "", costUsd: parsed.total_cost_usd ?? 0, numTurns: parsed.num_turns ?? 1,
      inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    };
  } catch (error) {
    return { status: "failed", latencyMs: performance.now() - started, error: (error as Error).message };
  }
}

/** Token counts always; with `live`, one real call per action (or the listed ids) until the cumulative cost reaches the cap. */
export async function runTypical(needOnFinal: number, live: boolean, only?: number[]): Promise<{ rows: TypicalRow[]; sourcesChars: number; liveCostUsd: number; liveNote: string }> {
  const sources = typicalSources();
  const system = typicalSystem(sources);
  let prefixPath = "";
  if (live) {
    mkdirSync(LIVE_DIR, { recursive: true });
    prefixPath = join(LIVE_DIR, "sources.md");
    writeFileSync(prefixPath, system);
  }
  const rows: TypicalRow[] = [];
  let spent = 0;
  let note = live ? "" : "Live check not run (pass --live to run it; it spends the student's Claude usage).";
  for (const a of typicalActions(needOnFinal)) {
    const prefixTokens = Math.ceil(system.length / 4);
    const questionTokens = Math.ceil(a.question.length / 4);
    const row: TypicalRow = {
      id: a.id, question: a.question, prefixChars: system.length, prefixTokens, questionTokens, tokens: prefixTokens + questionTokens,
      outputTokensEstimate: a.outputTokensEstimate, calls: a.calls, expectation: a.expectation, live: null,
    };
    if (live && (!only || only.includes(a.id))) {
      if (spent >= LIVE_CAP_USD) row.live = { status: "skipped_cap" };
      else {
        const r = await claudeOnce(prefixPath, a.question);
        spent += r.costUsd ?? 0;
        const { answer, ...rest } = r;
        row.live = { ...rest, ...(r.status === "ok" ? { correct: a.check(answer ?? "") } : {}) };
        if (r.status === "failed" && !note) note = `The live call failed: ${r.error}`;
      }
    }
    rows.push(row);
  }
  return { rows, sourcesChars: sources.length, liveCostUsd: Math.round(spent * 10000) / 10000, liveNote: note };
}
