// Tier 2 cost guard: stands first on PATH as `claude` and `codex` and forwards to the operator's
// real client, so the app runs the real, signed-in client exactly as it would, with four limits:
//   1. the cheapest model is passed explicitly (Claude `--model`, Codex `-m` or low effort),
//   2. a call whose prompt exceeds the input cap is refused before anything is sent,
//   3. at most MAX_CALLS generation calls per client; later ones are refused (this also stops
//      the pack runner's retry-then-escalate path from reaching the strong model),
//   4. a sign-in is never forwarded.
// It records argv, env variable NAMES, latency and the tokens the client itself reports. It never
// reads a credential or a file in the client's home. Config: <dir>/guard.json, written by the test.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(process.argv[1]);
const config = JSON.parse(readFileSync(join(here, "guard.json"), "utf8"));
const log = (entry) => appendFileSync(join(here, "guard.jsonl"), `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`);
const count = (client) => {
  if (!existsSync(join(here, "guard.jsonl"))) return 0;
  return readFileSync(join(here, "guard.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.client === client && e.kind === "call").length;
};
const envNames = () => Object.keys(process.env).sort();
/** The app's allowlisted environment, with the operator's own home, app data and PATH put back. */
const childEnv = () => ({ ...process.env, ...config.restore });
const argValue = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
function withValue(argv, flags, value) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (flags.includes(argv[i])) {
      i++;
      continue;
    }
    out.push(argv[i]);
  }
  return value ? [...out, flags[0], value] : out;
}
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
function run(real, argv, { stdin, onStdout } = {}) {
  const child = spawn(real.file, [...real.prefixArgs, ...argv], { env: childEnv(), stdio: [stdin === undefined ? "inherit" : "pipe", "pipe", "inherit"], windowsHide: true });
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    onStdout?.(chunk.toString("utf8"));
  });
  if (stdin !== undefined) child.stdin.end(stdin);
  return new Promise((resolve) => child.on("close", (code) => resolve({ code: code ?? 1, child })));
}

export async function main(client) {
  const real = config[client];
  let argv = process.argv.slice(2);
  const isLogin = client === "claude" ? argv[0] === "auth" && argv[1] !== "status" : argv[0] === "login" && argv[1] !== "status";
  if (isLogin) {
    log({ client, kind: "refused_login", argv });
    process.stderr.write("e2e guard: a sign-in is never started by the harness.\n");
    process.exitCode = 1;
    return;
  }
  const generation = client === "claude" ? argv.includes("-p") || argv.includes("--print") : argv[0] === "exec" && argv[1] === "-";
  if (!generation) {
    // --version, --help, the status commands, `features list`: forwarded unchanged.
    log({ client, kind: "check", argv, env: envNames(), cwd: process.cwd() });
    const { code } = await run(real, argv);
    process.exitCode = code;
    return;
  }
  // The cheapest tier, passed explicitly.
  if (client === "claude") argv = withValue(argv, ["--model"], config.claude.model);
  else {
    argv = withValue(argv, ["-m", "--model"], config.codex.model || undefined);
    const kept = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "-c" && (argv[i + 1] ?? "").startsWith("model_reasoning_effort")) {
        i++;
        continue;
      }
      kept.push(argv[i]);
    }
    argv = [...kept, "-c", `model_reasoning_effort="${config.codex.effort}"`];
  }
  const promptFile = client === "claude" ? argValue(argv, "--system-prompt-file") : undefined;
  const prefixChars = promptFile && existsSync(promptFile) ? readFileSync(promptFile, "utf8").length : 0;
  const refuse = (reason) => {
    log({ client, kind: "refused", reason, argv: argv.filter((a) => a.length < 200) });
    return `e2e guard: ${reason}`;
  };

  if (argValue(argv, "--input-format") === "stream-json") {
    // Claude's warm session: each input line is one ask; each is checked before it is forwarded.
    log({ client, kind: "session", argv: argv.filter((a) => a.length < 200), env: envNames(), cwd: process.cwd() });
    const child = spawn(real.file, [...real.prefixArgs, ...argv], { env: childEnv(), stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    let started = 0;
    let first = true;
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      buffer += chunk.toString("utf8");
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const e = JSON.parse(line);
          if (e.type === "result") log({ client, kind: "result", ms: Date.now() - started, is_error: !!e.is_error, usage: e.usage ?? null, model: Object.keys(e.modelUsage ?? {})[0] ?? null });
        } catch {}
      }
    });
    let pending = "";
    process.stdin.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      let nl;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl + 1);
        pending = pending.slice(nl + 1);
        const chars = line.length + (first ? prefixChars : 0);
        const reason = count(client) >= config.maxCalls ? `call limit (${config.maxCalls}) reached` : chars > config.capChars ? `input ${chars} chars exceeds the cap of ${config.capChars}` : null;
        if (reason) {
          process.stdout.write(`${JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: refuse(reason) })}\n`);
          continue;
        }
        log({ client, kind: "call", chars });
        first = false;
        started = Date.now();
        child.stdin.write(line);
      }
    });
    process.stdin.on("end", () => child.stdin.end());
    process.exitCode = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? 1)));
    return;
  }

  const input = await readStdin();
  const chars = input.length + prefixChars;
  const reason = count(client) >= config.maxCalls ? `call limit (${config.maxCalls}) reached` : chars > config.capChars ? `input ${chars} chars exceeds the cap of ${config.capChars}` : null;
  if (reason) {
    const text = refuse(reason);
    if (client === "claude") process.stdout.write(`${JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: text })}\n`);
    else process.stdout.write(`${JSON.stringify({ type: "turn.failed", error: { message: text } })}\n`);
    process.exitCode = 1;
    return;
  }
  log({ client, kind: "call", chars, argv: argv.filter((a) => a.length < 200), env: envNames(), cwd: process.cwd() });
  const started = Date.now();
  let out = "";
  const { code } = await run(real, argv, { stdin: input, onStdout: (t) => (out += t) });
  let usage = null;
  let model = null;
  for (const line of out.split(/\r?\n/)) {
    try {
      const e = JSON.parse(line);
      if (client === "claude" && e.type === "result") (usage = e.usage ?? null), (model = Object.keys(e.modelUsage ?? {})[0] ?? null);
      if (client === "codex" && e.type === "turn.completed") usage = e.usage ?? null;
    } catch {}
  }
  log({ client, kind: "result", ms: Date.now() - started, code, usage, model });
  process.exitCode = code;
}
