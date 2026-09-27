/**
 * Every AI event, end to end on synthetic data, through the real worker (apps/desktop/src/worker.ts)
 * and the student's connected Claude Code: study prep, packs and guides, page-approach, notes fill,
 * and the drain's course.facts and agenda.estimate jobs.
 *
 *   pnpm tsx scripts/verify-ai-events.ts --fake   the repo's fake Claude CLI (tests/e2e/fake-cli)
 *   pnpm tsx scripts/verify-ai-events.ts --live   the real `claude` on this machine (plan usage)
 *
 * The worker is loaded in this process with a stand-in for Electron's parentPort, and each event is
 * sent as the message main posts for the renderer's bridge call (`magic:execute` → `command`,
 * `magic:intent-run` → a `command` of type "command" with the interactive allowlist). A command
 * slower than main's 30 s request timeout fails, since main would reject it. Setup's state is
 * applied first: the synthetic fixture, consent for uw, jev and claude, Claude Code chosen, and
 * the "Your AI" privacy (selective_cloud, claude, course text shared). No window, no sign-in, no
 * real coursework: a new temp user-data folder per run, deleted afterwards (MAGIC_VERIFY_KEEP=1 keeps it).
 */
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const mode = process.argv.includes("--live") ? "live" : process.argv.includes("--fake") ? "fake" : null;
if (!mode) {
  console.error("Usage: pnpm tsx scripts/verify-ai-events.ts --fake|--live");
  process.exit(2);
}
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// main.ts execute(): a generation command (pack, learning, notes) is cut at GENERATION_TIMEOUT_MS.
const MAIN_TIMEOUT_MS = 2 * 180_000 + 30_000;
const isWindows = process.platform === "win32";

const root = await mkdtemp(join(tmpdir(), "magic-verify-ai-"));
const userData = join(root, "user-data");
await mkdir(userData, { recursive: true });
process.env.MAGIC_DB_PATH = join(userData, "workspace.sqlite");
delete process.env.MAGIC_GATEWAY_URL; // no Jev relay: every event here is the student's client
const fakeBin = join(root, "fake-bin");
const fakeLog = join(fakeBin, "calls.jsonl");

if (mode === "fake") {
  // As the e2e harness does: a fresh home (so the real ~/.local/bin/claude.exe isn't found), the
  // fake as an npm-style shim with node.exe beside it, and PATH = the shim folder + system folders.
  const home = join(root, "home");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  const fake = join(REPO, "tests", "e2e", "fake-cli", "fake.mjs");
  await writeFile(join(fakeBin, "scenario.json"), JSON.stringify({ claude: { version: "2.1.283", auth: "max", run: "ok" }, codex: { installed: false } }));
  await writeFile(join(fakeBin, "claude.mjs"), `import { main } from ${JSON.stringify(pathToFileURL(fake).href)};\nawait main("claude");\n`);
  if (isWindows) {
    await writeFile(join(fakeBin, "claude.cmd"), ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0",
      'IF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")', '"%_prog%"  "%dp0%\\claude.mjs" %*', ""].join("\r\n"));
    await link(process.execPath, join(fakeBin, "node.exe")).catch(() => copyFile(process.execPath, join(fakeBin, "node.exe")));
    const sys = process.env.SystemRoot || "C:\\Windows";
    process.env.PATH = [fakeBin, join(sys, "System32"), sys].join(delimiter);
  } else {
    const { chmod } = await import("node:fs/promises");
    await writeFile(join(fakeBin, "claude"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$(dirname "$0")/claude.mjs" "$@"\n`);
    await chmod(join(fakeBin, "claude"), 0o755);
    process.env.PATH = [fakeBin, "/usr/bin", "/bin"].join(delimiter);
  }
  for (const k of ["HOME", "USERPROFILE"]) process.env[k] = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.LOCALAPPDATA = join(home, "AppData", "Local");
}
const fakeCalls = () =>
  existsSync(fakeLog)
    ? readFileSync(fakeLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string }).filter((c) => c.kind === "run" || c.kind === "session" || c.kind === "ask").length
    : 0;

// ---- The worker, with Electron's parentPort stood in ----
type Message = { kind: string; id?: string; [key: string]: unknown };
const toWorker = new EventEmitter();
const fromWorker = new EventEmitter();
const port = {
  on: (event: string, listener: (e: { data: Message }) => void) => void toWorker.on(event, listener),
  postMessage: (message: Message) => void setImmediate(() => fromWorker.emit("message", message)),
};
Object.assign(process, { parentPort: port });
Object.assign(globalThis, { __dirname: join(REPO, "apps", "desktop", "dist") });
const send = (data: Message) => toWorker.emit("message", { data });
// Main's host reads (source-fetch, ai-key, planning...): refused, as with no network or sign-in.
const HOST_READS = new Set(["source-fetch", "ai-key", "madgrades-read", "planning-public-read", "planning-refresh", "source-secret", "graph-state", "notes-google"]);
fromWorker.on("message", (m: Message) => {
  if (m.id && HOST_READS.has(m.kind)) send({ kind: "source-response", id: m.id, error: "unavailable" });
});
const ready = new Promise<void>((done) => fromWorker.on("message", (m: Message) => m.kind === "ready" && done()));
await import(pathToFileURL(join(REPO, "apps", "desktop", "src", "worker.ts")).href);
await ready;
send({ kind: "privacy-key", secret: randomBytes(32).toString("base64") });

function call(message: Message, timeoutMs = MAIN_TIMEOUT_MS + 10_000): Promise<{ result?: any; error?: string; ms: number }> {
  const id = randomUUID();
  const started = performance.now();
  return new Promise((done) => {
    const timer = setTimeout(() => {
      fromWorker.off("message", listen);
      send({ kind: "cancel-command", id });
      done({ error: `no answer in ${timeoutMs / 1000} s`, ms: performance.now() - started });
    }, timeoutMs);
    const listen = (m: Message) => {
      if (m.kind !== "response" || m.id !== id) return;
      clearTimeout(timer);
      fromWorker.off("message", listen);
      done({ result: m.result, ...(typeof m.error === "string" ? { error: m.error } : {}), ms: performance.now() - started });
    };
    fromWorker.on("message", listen);
    send({ ...message, id });
  });
}
const command = (value: unknown) => call({ kind: "command", command: value });
async function must(value: unknown) {
  const r = await command(value);
  if (r.error) throw new Error(`setup ${JSON.stringify(value).slice(0, 80)}: ${r.error}`);
  return r.result;
}

// ---- Setup's state ----
const { CONSENT_DISCLOSURE_VERSION } = await import("../packages/domain/src/index");
const { chooseClient } = await import("../apps/desktop/src/clients/profiles");
await must({ type: "fixture" });
for (const recipient of ["uw", "jev", "claude"]) await must({ type: "consent", value: { action: "grant", recipient, disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
await chooseClient("claude", userData); // main's clients.choose (Onboarding "Your AI")
const snap = (await must({ type: "snapshot" })).snapshot;
await must({ type: "privacy", value: { ...snap.privacy, mode: "selective_cloud", hostedProvider: "claude", shareCourseText: true } });
await call({ kind: "query", query: { view: "summary" } }); // the first query schedules the intent index
send({ kind: "presence", present: true });

const resources = (await must({ type: "snapshot" })).snapshot.resources as { id: string; externalId?: string; title: string; courseId: string; sourceId: string }[];
// The three-course synthetic sample (fixtures/sample-courses.json, 18d639c): MATH 240's items.
const byTitle = (t: string, externalId?: string) => {
  const r = resources.find((x) => x.title === t && (!externalId || x.externalId === externalId));
  if (!r) throw new Error(`fixture item missing: ${t}`);
  return r;
};
const COURSE = "math-240";
const essay = byTitle("Problem Set 4: Induction");
const reading = byTitle("Reading 4: Strong induction and well-ordering");
const slides = byTitle("Lecture 7 slides: Mathematical induction");
const midterm = byTitle("Midterm 1", "math240-midterm1"); // the assignment, not the gradebook group

// ---- The events ----
interface Row { event: string; path: string; pass: boolean; ms: number; detail: string }
const rows: Row[] = [];
async function event(name: string, path: string, run: () => Promise<{ result?: any; error?: string; ms: number }>, judge: (result: any, calls: number) => [boolean, string], expectCall = true) {
  const before = fakeCalls();
  let r: { result?: any; error?: string; ms: number };
  try { r = await run(); } catch (error) { r = { error: error instanceof Error ? error.message : String(error), ms: 0 }; }
  const calls = fakeCalls() - before;
  let [pass, detail] = r.error ? [false, `error: ${r.error}`] : judge(r.result, calls);
  if (pass && r.ms > MAIN_TIMEOUT_MS) [pass, detail] = [false, `${detail}; over main's ${MAIN_TIMEOUT_MS / 1000} s generation timeout`];
  if (pass && mode === "fake" && expectCall && calls === 0) [pass, detail] = [false, `${detail}; the client was never called`];
  if (pass && mode === "fake" && !expectCall && calls > 0) [pass, detail] = [false, `${detail}; the client was called (${calls}) for a code path`];
  rows.push({ event: name, path, pass, ms: Math.round(r.ms), detail });
  console.error(`${pass ? "PASS" : "FAIL"} ${name} (${Math.round(r.ms)} ms): ${detail}`);
}
const tok = (t: { in: number; cached: number; out: number } | null | undefined) => (t ? `${t.in}+${t.cached}c/${t.out}` : "-");

// Chat (intent-run) and the voice planner are out of this script's scope: chat is being rebuilt
// separately, and voice is left alone.

// 1. Study & Learn / study prepper (execute pack study-prep-<kind>; learning notebook.ask)
const judgePack = (c: any): [boolean, string] => {
  const p = c?.pack;
  if (!p) return [false, `no pack result: ${c?.message ?? ""}`];
  const counts = p.counts ? ` counts=${JSON.stringify(p.counts)}` : "";
  // Fake mode checks the wiring: the fake's placeholder output (only its cards are grounded) is expected to
  // be rejected by the content checks, which is still a typed answer from the client.
  const ok = p.status === "done" || p.status === "ok" || (mode === "fake" && p.status === "needs_student");
  return [ok, `${p.status} tokens=${tok(p.tokens)} cached=${p.cached}${counts} ${String(p.message ?? "").slice(0, 140)}`];
};
for (const kind of ["cards", "quiz", "exam", "guide", "outline", "problems"] as const)
  await event(`study: ${kind}`, `execute pack study-prep-${kind}`, () => command({ type: "pack", pack: `study-prep-${kind}`, scope: { courseId: COURSE, assessmentId: kind === "exam" || kind === "quiz" ? midterm.id : essay.id } }), judgePack);
await event("study: Ask", "execute learning notebook.ask", () => command({ type: "learning", request: { op: "notebook.ask", courseId: COURSE, question: "What does the inductive step have to show?", scope: { assessmentId: essay.id, resourceIds: [reading.id] } } }), (c) => {
  const l = c?.learning;
  const d = l?.data ?? {};
  const ok = l?.status === "ok" && !d.unavailable && (mode === "fake" || (d.notFound !== true && typeof d.text === "string" && d.text.length > 0));
  return [ok, `${l?.status} citations=${d.citations?.length ?? 0} notFound=${d.notFound} ${d.unavailable ?? l?.message ?? ""}`.slice(0, 200)];
});

// 2. Workspace / course pages: page-approach and a guide (briefing).
await event("page: approach", "execute pack page-approach", () => command({ type: "pack", pack: "page-approach", scope: { courseId: COURSE, assessmentId: essay.id } }), judgePack);
await event("guide: briefing", "execute pack briefing", () => command({ type: "pack", pack: "briefing", scope: { courseId: COURSE } }), judgePack);

// 3. Notes fill from slides (execute notes notes.create → notes.fill)
await event("notes: fill from slides", "execute notes notes.fill", async () => {
  const created = await command({ type: "notes", reply: "result", request: { op: "notes.create", courseId: COURSE, accountScope: "synthetic", title: "Lecture 7 notes" } });
  const noteId = created.result?.notes?.note?.id;
  if (!noteId) return { error: `notes.create: ${created.error ?? JSON.stringify(created.result?.notes ?? {}).slice(0, 160)}`, ms: created.ms };
  return command({ type: "notes", reply: "result", request: { op: "notes.fill", noteId, resourceIds: [slides.id] } });
}, (c) => {
  const n = c?.notes;
  return [n?.status === "ok", `${n?.status} ${n?.message ?? n?.reason ?? ""} suggestions=${n?.note?.suggestions?.length ?? n?.suggestions?.length ?? "-"}`.slice(0, 200)];
});

// 4. The drain's course jobs. The sample's syllabus is an item in its assignments batch, not a
// syllabus tab, so a synthetic syllabus tab is imported (execute import) for course.facts to read.
// Each job passes when it is done and a receipt shows the send reached Claude Code.
{
  const syllabus = [
    "Course Summary:",
    "MATH 240 meets Mondays, Wednesdays and Fridays, 11:00-11:50 AM, in Room 120 (synthetic).",
    "Instructor: Dr. Example. Office hours: Wednesdays 2-4 PM in Room 330.",
    "Grading: problem sets 30%, quizzes 10%, midterm 1 20%, midterm 2 20%, final exam 20%.",
    "Late work: 10% off per day, up to three days; after that it is not accepted.",
    "AI policy: you may use AI to explain concepts and ask questions, but it must not write any part of a submission.",
    "Textbook: Discrete Mathematics (synthetic reference).",
    ...Array.from({ length: 6 }, (_, i) => `Week ${i + 1}: readings, a problem set and a short quiz are due before class.`),
  ].join("\n");
  const imported = await command({ type: "import", batch: {
    source: { id: "sample-syllabus", label: "Sample syllabus · synthetic", kind: "fixture", accountScope: "synthetic", courseId: COURSE, scope: "syllabus" },
    observedAt: new Date().toISOString(), complete: true, status: "ok",
    resources: [{ externalId: "syllabus-tab", kind: "material", courseId: COURSE, courseName: "MATH 240: Introduction to Discrete Mathematics", title: "Syllabus", url: "https://example.org/math-240/syllabus", text: syllabus }],
  } });
  if (imported.error) console.error(`syllabus import: ${imported.error}`);
  const db = new DatabaseSync(process.env.MAGIC_DB_PATH!, { readOnly: true });
  const started = performance.now();
  const PURPOSE: Record<string, RegExp> = { "course.facts": /course facts|syllabus|course rules/i, "agenda.estimate": /estimate how long/i };
  const jobs = () => db.prepare("SELECT kind, status, attempts, error FROM jobs WHERE kind IN ('course.facts','agenda.estimate')").all() as { kind: string; status: string; attempts: number; error: string | null }[];
  const receipts = () => (db.prepare("SELECT purpose FROM receipts WHERE recipient = 'claude'").all() as { purpose: string }[]).map((r) => r.purpose);
  const settled = () => {
    const js = jobs();
    return js.length > 0 && js.every((j) => j.status === "done" || j.status === "failed" || j.status === "dead") && Object.values(PURPOSE).every((p) => receipts().some((r) => p.test(r)));
  };
  while (performance.now() - started < 240_000 && !settled()) await new Promise((r) => setTimeout(r, 2_000));
  const ms = Math.round(performance.now() - started);
  const sent = receipts();
  for (const kind of ["course.facts", "agenda.estimate"]) {
    const js = jobs().filter((j) => j.kind === kind);
    const receipt = sent.filter((r) => PURPOSE[kind]!.test(r));
    const pass = js.length > 0 && js.every((j) => j.status === "done") && receipt.length > 0;
    rows.push({ event: `job: ${kind}`, path: "drain → registered job → runner", pass, ms,
      detail: `${js.length ? js.map((j) => `${j.status} attempts=${j.attempts}${j.error ? ` ${j.error.slice(0, 100)}` : ""}`).join("; ") : "never enqueued"}; claude receipts=${receipt.length}` });
  }
  db.close();
}

// ---- Report ----
console.log(`\nAI events (${mode === "live" ? "live: the real claude CLI" : "fake: tests/e2e/fake-cli"}), user data ${root}\n`);
const w = [34, 40, 5, 8];
console.log(["event".padEnd(w[0]!), "path".padEnd(w[1]!), "ok".padEnd(w[2]!), "ms".padStart(w[3]!), "detail"].join(" | "));
for (const r of rows) console.log([r.event.padEnd(w[0]!), r.path.slice(0, w[1]).padEnd(w[1]!), (r.pass ? "PASS" : "FAIL").padEnd(w[2]!), String(r.ms).padStart(w[3]!), r.detail].join(" | "));
const failed = rows.filter((r) => !r.pass).length;
console.log(`\n${rows.length - failed}/${rows.length} passed (${mode})`);
send({ kind: "shutdown" });
await new Promise((r) => setTimeout(r, 1_500));
if (!process.env.MAGIC_VERIFY_KEEP) await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
process.exit(failed ? 1 : 0);
