// Fake `claude` and `codex` executables for the fresh-system E2E harness (Tier 1).
//
// They implement only what My Magic UW calls: `--version`, `--help` / `exec --help`,
// `features list`, the sign-in status commands, and the run modes (Claude one-shot JSON,
// Claude stream-json sessions, `codex exec --json`). Each call is recorded to calls.jsonl
// (argv, env variable NAMES only, cwd, stdin size, files this fake itself wrote), so tests
// assert the exact configuration the app passed.
//
// The app hands a client an allowlisted environment (no custom variables survive), so the
// scenario and the log live beside the entry script: <fake-bin>/scenario.json and
// <fake-bin>/calls.jsonl. The launcher writes a fresh fake-bin per run.
//
// Messages are the clients' own, as listed in apps/desktop/src/clients/health.ts
// (HEALTH_EVIDENCE); where a message was only found in a binary, this is its only exercise.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CLAUDE_FLAGS = [
  "--print", "--output-format", "--input-format", "--json-schema", "--tools", "--strict-mcp-config",
  "--setting-sources", "--no-session-persistence", "--safe-mode", "--system-prompt", "--system-prompt-file",
  "--model", "--verbose",
];
const CODEX_EXEC_FLAGS = [
  "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
  "--output-schema", "--sandbox", "--disable", "--config", "--json", "--model",
];
const CODEX_FEATURES = [
  ["shell_tool", "stable", "true"], ["unified_exec", "stable", "true"], ["apps", "stable", "true"],
  ["plugins", "experimental", "false"], ["memories", "experimental", "false"], ["multi_agent", "experimental", "false"],
  ["web_search_request", "stable", "true"], ["view_image", "stable", "true"], ["image_generation", "under development", "false"],
  ["old_removed_feature", "removed", "false"],
];

/** Default messages per failure, as each client states them. */
const CLAUDE_FAILURES = {
  usage_limit: (s) => `You've hit your limit · resets ${s.resetsAt ?? "3pm (America/Chicago)"}`,
  model_unavailable: (_s, model) =>
    `There's an issue with the selected model (${model}). It may not exist or you may not have access to it. Run --model to pick a different model.`,
  offline: () => "API Error: Connection error.",
  not_signed_in: () => "Not logged in · Please run /login",
  plan_insufficient: () => "Credit balance is too low",
};
const CODEX_FAILURES = {
  usage_limit: (s) =>
    `You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at ${s.resetsAt ?? "3:05 PM"}.`,
  plan_insufficient: () => "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus)",
  model_unavailable: (_s, model) => `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
  offline: () => "stream disconnected - retrying sampling request",
  not_signed_in: () => "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
};

const here = dirname(process.argv[1]);
const readScenario = () => {
  try {
    return JSON.parse(readFileSync(join(here, "scenario.json"), "utf8"));
  } catch {
    return {};
  }
};

function record(entry) {
  appendFileSync(join(here, "calls.jsonl"), `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`);
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argValue = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const allValues = (argv, flag) => argv.flatMap((a, i) => (a === flag && i + 1 < argv.length ? [argv[i + 1]] : []));

/** The client's own home, as the real client resolves it. */
function clientHome(client) {
  const own = client === "claude" ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return own || join(home, client === "claude" ? ".claude" : ".codex");
}
/**
 * A sign-in lives in the client's home. The student's home carries the scenario's sign-in; a
 * different home (the app's own profile, via CLAUDE_CONFIG_DIR / CODEX_HOME) starts signed out,
 * as the real clients do, unless the scenario says that profile was signed in.
 */
function authFor(client, spec) {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const student = join(home, client === "claude" ? ".claude" : ".codex");
  const own = clientHome(client);
  const isStudentHome = own.toLowerCase() === student.toLowerCase();
  if (isStudentHome) return spec.auth;
  return spec.profileAuth ?? "signed_out";
}
/**
 * What the real clients do on every run: they update a cache in their own home. The file is
 * listed in the call record so the home check can tell the client's writes from the app's.
 */
function clientWrite(client, spec) {
  if (spec.writesHome === false) return [];
  const dir = join(clientHome(client), "fake-client-cache");
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "last-run.json");
    writeFileSync(path, JSON.stringify({ at: Date.now() }));
    return [path];
  } catch {
    return [];
  }
}

// --- Output synthesis ---------------------------------------------------------------------------

/** Passages as the app formats them (packages/packs/core/src/format.ts buildPrompt). */
function passagesOf(text) {
  const out = [];
  const re = /<passage id="([^"]+)">\n([\s\S]*?)\n<\/passage>/g;
  let m;
  while ((m = re.exec(text))) out.push({ id: m[1], text: m[2] });
  return out;
}
function firstListed(text, heading) {
  const i = text.indexOf(heading);
  if (i < 0) return null;
  const m = /\n- (.+)/.exec(text.slice(i + heading.length));
  return m && m[1] !== "(none yet)" ? m[1].trim().slice(0, 80) : null;
}
/** Sentences that are quotable verbatim (12..400 chars) from a passage. */
function sentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 24 && s.length <= 400 && /[A-Za-z]{5,}/.test(s));
}
/** Grounded cards: each is a cloze on a verbatim sentence, blanking its longest word. */
function cardsFor(input) {
  const count = Math.max(1, Math.min(40, Number(/Write (\d+) flashcards/.exec(input)?.[1] ?? 5)));
  const topic = firstListed(input, "Topics already on the course map") ?? "Course reading";
  const section = firstListed(input, "Sections already on the course map") ?? "Module 1";
  const cards = [];
  for (const p of passagesOf(input))
    for (const s of sentences(p.text)) {
      if (cards.length >= count) break;
      const word = s.match(/[A-Za-z]{5,}/g).sort((a, b) => b.length - a.length)[0];
      cards.push({ kind: "cloze", front: s.slice(0, 600), back: word, topics: [topic], section, sourceId: p.id, quote: s });
    }
  return { cards };
}

/** A schema-valid instance of a JSON Schema (draft-7 subset the packs use). */
function instance(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 12) return null;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) return instance(variants[0], depth + 1);
  const type = Array.isArray(schema.type) ? (schema.type.includes("null") ? "null" : schema.type[0]) : schema.type;
  switch (type) {
    case "null":
      return null;
    case "object": {
      const out = {};
      for (const key of schema.required ?? Object.keys(schema.properties ?? {}))
        out[key] = instance(schema.properties?.[key] ?? {}, depth + 1);
      return out;
    }
    case "array":
      return Array.from({ length: schema.minItems ?? 0 }, () => instance(schema.items ?? {}, depth + 1));
    case "string": {
      const min = schema.minLength ?? 0;
      const text = "fake answer";
      return (text.length >= min ? text : text.padEnd(min, "x")).slice(0, schema.maxLength ?? 400);
    }
    case "integer":
    case "number":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}

/** The output for one ask: cards grounded in the passages when the schema is the cards pack's. */
function outputFor(schema, input, spec) {
  if (spec.output !== undefined) return spec.output;
  if (schema?.properties?.cards) return cardsFor(input);
  return instance(schema);
}
const tokensOf = (text) => Math.ceil(text.length / 4);

// --- Claude Code --------------------------------------------------------------------------------

function claudeHelp(spec) {
  const missing = new Set(spec.missingFlags ?? []);
  const lines = CLAUDE_FLAGS.filter((f) => !missing.has(f)).map((f) => `  ${f} <value>    (fake)`);
  return `Usage: claude [options] [command] [prompt]\n\nOptions:\n${lines.join("\n")}\n\nCommands:\n  auth    Manage authentication\n`;
}
function claudeStatus(spec) {
  const email = { email: "student@example.test", orgName: "Example Org" };
  switch (authFor("claude", spec) ?? "max") {
    case "signed_out":
      return { code: 1, out: { loggedIn: false, authMethod: "none", apiProvider: "firstParty" } };
    case "api_key":
      return { code: 0, out: { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" } };
    case "unknown":
      return { code: 0, raw: "Something went wrong reading your status." };
    default:
      return { code: 0, out: { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", ...email, subscriptionType: spec.auth ?? "max" } };
  }
}
function claudeResult(spec, schema, input, model, started) {
  const failure = spec.run && spec.run !== "ok" ? CLAUDE_FAILURES[spec.run]?.(spec, model) : null;
  const usage = { input_tokens: tokensOf(input), cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  if (failure)
    return { type: "result", subtype: "success", is_error: true, duration_ms: Date.now() - started, result: failure, usage: { ...usage, input_tokens: 0 } };
  const value = outputFor(schema, input, spec);
  const text = JSON.stringify(value);
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: Date.now() - started,
    result: text,
    structured_output: value,
    usage: { ...usage, output_tokens: tokensOf(text) },
    modelUsage: { [`fake-${model}`]: {} },
  };
}

async function claude(argv, spec) {
  if (argv[0] === "--version" || argv[0] === "-v") {
    record({ client: "claude", kind: "version", argv, env: envNames(), cwd: process.cwd() });
    process.stdout.write(`${spec.version ?? "2.1.283"} (Claude Code)\n`);
    return 0;
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    record({ client: "claude", kind: "help", argv, env: envNames(), cwd: process.cwd() });
    process.stdout.write(claudeHelp(spec));
    return 0;
  }
  if (argv[0] === "auth" && argv[1] === "status") {
    record({ client: "claude", kind: "status", argv, env: envNames(), cwd: process.cwd() });
    const s = claudeStatus(spec);
    process.stdout.write(s.raw ?? `${JSON.stringify(s.out, null, 2)}\n`);
    return s.code;
  }
  if (argv[0] === "auth" || argv[0] === "login" || argv[0] === "/login" || argv[0] === "setup-token") {
    // The app must never start a sign-in in instant mode; the record makes that assertable.
    record({ client: "claude", kind: "login", argv, env: envNames(), cwd: process.cwd() });
    process.stdout.write("fake: sign-in started\n");
    return 0;
  }
  const unknown = argv.find((a) => (spec.missingFlags ?? []).includes(a));
  if (unknown) {
    record({ client: "claude", kind: "rejected", argv, env: envNames(), cwd: process.cwd() });
    process.stderr.write(`error: unknown option '${unknown}'\n`);
    return 1;
  }
  if (!argv.includes("-p") && !argv.includes("--print")) {
    record({ client: "claude", kind: "interactive", argv, env: envNames(), cwd: process.cwd() });
    process.stdout.write("fake: interactive session\n");
    return 0;
  }
  const model = argValue(argv, "--model") ?? "default";
  let schema = null;
  try {
    schema = JSON.parse(argValue(argv, "--json-schema") ?? "null");
  } catch {
    schema = null;
  }
  const promptFile = argValue(argv, "--system-prompt-file");
  const systemPrompt = promptFile && existsSync(promptFile) ? readFileSync(promptFile, "utf8") : "";
  const wrote = clientWrite("claude", spec);

  if (argValue(argv, "--input-format") === "stream-json") {
    // Warm session: one result line per user message, until stdin closes.
    record({ client: "claude", kind: "session", argv, env: envNames(), cwd: process.cwd(), wrote, systemPromptBytes: systemPrompt.length });
    process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", model: `fake-${model}`, tools: [], mcp_servers: [] })}\n`);
    let buffer = "";
    let queue = Promise.resolve();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        queue = queue.then(async () => {
          const started = Date.now();
          let text = "";
          try {
            text = JSON.parse(line).message.content.map((c) => c.text ?? "").join("");
          } catch {
            return;
          }
          const s = { ...spec, ...readScenario().claude };
          const pack = /pack=([a-z][a-z0-9-]*)\.v\d+/.exec(text)?.[1];
          record({ client: "claude", kind: "ask", argv: [], env: [], cwd: process.cwd(), pack, stdinBytes: text.length });
          if (s.delayMs) await sleep(s.delayMs);
          // The pool's union schema: {kind, data: anyOf[...]} with kind's enum in the same order.
          const ids = schema?.properties?.kind?.enum ?? [];
          const variants = schema?.properties?.data?.anyOf ?? (schema?.properties?.data ? [schema.properties.data] : []);
          const at = Math.max(0, ids.indexOf(pack));
          const inner = claudeResult(s, variants[at] ?? null, `${systemPrompt}\n${text}`, model, started);
          if (!inner.is_error) {
            inner.structured_output = { kind: ids[at] ?? pack, data: inner.structured_output };
            inner.result = JSON.stringify(inner.structured_output);
          }
          process.stdout.write(`${JSON.stringify(inner)}\n`);
        });
      }
    });
    await new Promise((resolve) => process.stdin.on("end", resolve));
    await queue;
    return 0;
  }

  const started = Date.now();
  const input = await readStdin();
  record({ client: "claude", kind: "run", argv, env: envNames(), cwd: process.cwd(), wrote, stdinBytes: input.length, systemPromptBytes: systemPrompt.length });
  if (spec.delayMs) await sleep(spec.delayMs);
  const result = claudeResult(spec, schema, `${systemPrompt}\n${input}`, model, started);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.is_error ? 1 : 0;
}

// --- Codex -------------------------------------------------------------------------------------

function codexHelp(spec) {
  const missing = new Set(spec.missingFlags ?? []);
  const lines = CODEX_EXEC_FLAGS.filter((f) => !missing.has(f)).map((f) => `      ${f} <VALUE>    (fake)`);
  return `Run Codex non-interactively\n\nUsage: codex exec [OPTIONS] [PROMPT]\n\nOptions:\n${lines.join("\n")}\n`;
}
function codexEvents(spec, schema, input, model) {
  const failure = spec.run && spec.run !== "ok" ? CODEX_FAILURES[spec.run]?.(spec, model ?? "gpt-default") : null;
  const lines = [{ type: "thread.started", thread_id: "fake-thread" }, { type: "turn.started" }];
  if (failure) {
    lines.push({ type: "error", message: failure }, { type: "turn.failed", error: { message: failure } });
    return { lines, code: 1 };
  }
  const text = JSON.stringify(outputFor(schema, input, spec));
  lines.push(
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text } },
    { type: "turn.completed", usage: { input_tokens: tokensOf(input), cached_input_tokens: 0, output_tokens: tokensOf(text) } },
  );
  return { lines, code: 0 };
}

async function codex(argv, spec) {
  if (argv[0] === "--version" || argv[0] === "-V") {
    record({ client: "codex", kind: "version", argv, env: envNames(), cwd: process.cwd() });
    process.stdout.write(`codex-cli ${spec.version ?? "0.156.1"}\n`);
    return 0;
  }
  if (argv[0] === "exec" && (argv[1] === "--help" || argv[1] === "-h")) {
    record({ client: "codex", kind: "help", argv, env: envNames(), cwd: process.cwd() });
    process.stdout.write(codexHelp(spec));
    return 0;
  }
  if (argv[0] === "features" && argv[1] === "list") {
    record({ client: "codex", kind: "features", argv, env: envNames(), cwd: process.cwd() });
    process.stdout.write(CODEX_FEATURES.map((r) => r.join("  ")).join("\n") + "\n");
    return 0;
  }
  if (argv[0] === "login" && argv[1] === "status") {
    record({ client: "codex", kind: "status", argv, env: envNames(), cwd: process.cwd() });
    const auth = authFor("codex", spec) ?? "chatgpt";
    if (auth === "signed_out") {
      process.stderr.write("Not logged in\n");
      return 1;
    }
    process.stderr.write(auth === "api_key" ? "Logged in using an API key - sk-fake***\n" : "Logged in using ChatGPT\n");
    return 0;
  }
  if (argv[0] === "login" || argv[0] === "logout") {
    record({ client: "codex", kind: "login", argv, env: envNames(), cwd: process.cwd() });
    process.stdout.write("fake: sign-in started\n");
    return 0;
  }
  if (argv[0] !== "exec") {
    record({ client: "codex", kind: "interactive", argv, env: envNames(), cwd: process.cwd() });
    process.stdout.write("fake: interactive session\n");
    return 0;
  }
  const unknown = argv.find((a) => (spec.missingFlags ?? []).includes(a));
  const listed = new Set(CODEX_FEATURES.filter((r) => r[1] !== "removed").map((r) => r[0]));
  const badFeature = allValues(argv, "--disable").find((f) => !listed.has(f));
  const input = await readStdin();
  const wrote = clientWrite("codex", spec);
  record({ client: "codex", kind: "run", argv, env: envNames(), cwd: process.cwd(), wrote, stdinBytes: input.length });
  if (unknown) {
    process.stderr.write(`error: unexpected argument '${unknown}' found\n`);
    return 2;
  }
  if (badFeature) {
    process.stderr.write(`Unknown feature flag: ${badFeature}\n`);
    return 1;
  }
  // Codex 0.156.1 refuses a folder outside a git repository without this flag (observed).
  if (!argv.includes("--skip-git-repo-check")) {
    process.stderr.write("Not inside a trusted directory and --skip-git-repo-check was not specified.\n");
    return 1;
  }
  const schemaPath = argValue(argv, "--output-schema");
  let schema = null;
  try {
    schema = schemaPath ? JSON.parse(readFileSync(schemaPath, "utf8")) : null;
  } catch {
    schema = null;
  }
  if (spec.delayMs) await sleep(spec.delayMs);
  const { lines, code } = codexEvents(spec, schema, input, argValue(argv, "-m") ?? argValue(argv, "--model"));
  process.stdout.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return code;
}

/** Variable names only: values can hold secrets and are never recorded. */
const envNames = () => Object.keys(process.env).sort();

export async function main(client) {
  const scenario = readScenario();
  const spec = scenario[client] ?? {};
  const argv = process.argv.slice(2);
  const code = client === "claude" ? await claude(argv, spec) : await codex(argv, spec);
  process.exitCode = code;
}
