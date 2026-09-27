/** Assertions over what the app passed to the (fake) clients. */
import assert from "node:assert/strict";
import { join, relative, sep } from "node:path";
import { FORBIDDEN_ENV, type FakeCall } from "./fresh-system";

const pairs = (argv: string[], flag: string) => argv.flatMap((a, i) => (a === flag ? [argv[i + 1]] : []));
/** argv for a message: long values (inline schemas) shortened. */
export const shortArgv = (argv: string[]) => argv.map((a) => (a.length > 80 ? `<${a.length} chars>` : a === "" ? '""' : a)).join(" ");

/** Claude instant mode: the runner's spec argv plus --safe-mode (apps/desktop/src/clients/instant.ts). */
export function expectClaudeInstantArgv(argv: string[]): void {
  assert.ok(argv.includes("--safe-mode"), `--safe-mode missing: ${shortArgv(argv)}`);
  assert.deepEqual(pairs(argv, "--tools"), [""], "tools must be off (--tools \"\")");
  assert.ok(argv.includes("--strict-mcp-config"), "--strict-mcp-config missing");
  assert.ok(argv.includes("--no-session-persistence"), "--no-session-persistence missing");
  assert.deepEqual(pairs(argv, "--setting-sources"), ["project,local"], "user settings must not load");
  assert.equal(pairs(argv, "--model").length, 1, "an explicit model is passed");
  for (const banned of ["--dangerously-skip-permissions", "--bare", "--mcp-config", "--add-dir", "--allowedTools"])
    assert.ok(!argv.includes(banned), `${banned} must never be passed`);
}

/** Codex instant mode: spec argv plus the instant overrides; only listed tool features are disabled. */
export function expectCodexInstantArgv(argv: string[], listedToolFeatures: string[]): void {
  assert.equal(argv[0], "exec");
  for (const flag of ["--skip-git-repo-check", "--ephemeral", "--ignore-rules", "--ignore-user-config", "--json"])
    assert.ok(argv.includes(flag), `${flag} missing: ${shortArgv(argv)}`);
  assert.deepEqual(pairs(argv, "-s"), ["read-only"], "read-only sandbox");
  const configs = pairs(argv, "-c");
  assert.ok(configs.includes('web_search="disabled"'), "web search off");
  assert.ok(configs.includes("project_doc_max_bytes=0"), "project docs off");
  assert.ok(configs.some((c) => c.startsWith("model_instructions_file=")), "the app's own instructions file");
  assert.deepEqual(pairs(argv, "--disable").sort(), [...listedToolFeatures].sort(), "every listed tool feature, and only those, is disabled");
  for (const banned of ["--dangerously-bypass-approvals-and-sandbox", "--full-auto", "--yolo"])
    assert.ok(!argv.includes(banned), `${banned} must never be passed`);
}

/** No API-key, provider or app variable in any client's environment (names only). */
export function expectCleanEnv(calls: FakeCall[]): void {
  for (const call of calls) {
    const bad = call.env.filter((name) => FORBIDDEN_ENV.test(name));
    assert.deepEqual(bad, [], `${call.client} ${call.kind} (${call.argv.slice(0, 3).join(" ")}) received ${bad.join(", ")}`);
  }
}

/** Instant-mode runs start in the app's own work folder, never the student's. */
export function expectInstantCwd(calls: FakeCall[], userData: string): void {
  for (const call of calls.filter((c) => c.kind === "run" || c.kind === "session" || c.kind === "status")) {
    const rel = relative(join(userData, "clients"), call.cwd);
    assert.ok(!rel.startsWith("..") && rel.split(sep)[0] !== "", `${call.client} ${call.kind} ran in ${call.cwd}`);
  }
}

/** The app never starts a client sign-in and never opens an interactive client on its own. */
export function expectNoLogin(calls: FakeCall[]): void {
  const started = calls.filter((c) => c.kind === "login" || c.kind === "interactive");
  assert.deepEqual(started.map((c) => `${c.client} ${c.argv.join(" ")}`), [], "no sign-in or interactive session was started");
}
