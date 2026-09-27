// Opt-in (MAGIC_VOICE_REAL=1): real local Whisper on synthesized speech, then the shared intent router.
// Audio comes from macOS `say`, encoded to WebM/Opus like the renderer's MediaRecorder output. This is a
// labeled test fixture, not a microphone capture, and it launches no Electron or browser. It proves the
// transcription worker and dispatch pieces work on this Mac; it does not prove mic permission or latency.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCore } from "@magic/core";
import { CONSENT_DISCLOSURE_VERSION } from "@magic/domain";
import { createIntentRouter } from "../packages/core/src/intent/index";
import { LocalWhisperTransport, localWhisperConfig } from "../apps/desktop/src/voice/local-whisper";
import { createInteractiveDispatch } from "../apps/desktop/src/voice/intent-dispatch";
import { NOW, TZ, workspace } from "./intent-fixtures";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { createClaudeBackend, type CliCommand, type ModelRunner, type RunRequest } from "../packages/runner/src/index";
import { createPackRuntime } from "../packages/packs/core/src/index";

const real = process.env.MAGIC_VOICE_REAL === "1";

function speech(text: string): ArrayBuffer {
  const dir = mkdtempSync(join(tmpdir(), "voice-real-"));
  execFileSync("say", ["-o", join(dir, "a.aiff"), text]);
  execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-i", join(dir, "a.aiff"), "-c:a", "libopus", "-ar", "48000", "-ac", "1", join(dir, "a.webm")]);
  const bytes = readFileSync(join(dir, "a.webm"));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

test("spoken 'open calendar' → local Whisper transcript → shared router → page navigation", { skip: !real && "set MAGIC_VOICE_REAL=1" }, async () => {
  const config = await localWhisperConfig();
  assert.ok(config, "model file present at MAGIC_VOICE_MODEL_FILE or ~/.cache/whisper/base.pt");
  const transport = new LocalWhisperTransport(config!);
  const session = new AbortController();
  const started = Date.now();
  await transport.start(session.signal);
  const warm = Date.now() - started;
  const bytes = speech("Open calendar.");
  const t0 = Date.now();
  const text = await transport.transcribe({ token: { sessionId: "s", epoch: 1 }, bytes, mimeType: "audio/webm", durationMs: 1500, voicedMs: 1200 }, session.signal);
  const asr = Date.now() - t0;
  assert.match(text, /open (the )?calendar/i, `heard: ${text}`);

  const { store, batches } = workspace();
  const router = createIntentRouter({ store, runner: () => null, now: () => NOW, timeZone: TZ });
  const core = createCore(store, { fixture: batches[0]!, now: () => NOW, timeZone: TZ, seams: { intent: router } });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const dispatch = createInteractiveDispatch((command, signal) => core.execute(command as never, signal as never));
  const t1 = Date.now();
  const result = await dispatch(text.trim(), { view: "today" }, { signal: new AbortController().signal, current: () => true, operationId: "op1" });
  const route = Date.now() - t1;
  assert.equal(result.status, "ran", JSON.stringify(result));
  assert.equal(result.status === "ran" && result.action, "page.open");
  assert.deepEqual(result.status === "ran" && (result.result as { navigate?: unknown }).navigate, { view: "calendar" });
  assert.equal(result.path, "code", "ordinary navigation needs no model call");
  console.log(`# receipt: worker-ready ${warm} ms, whisper ${asr} ms, router ${route} ms, heard "${text.trim()}"`);

  // Stop: aborting the session kills the worker; a transcription in flight rejects instead of resolving late.
  const pending = transport.transcribe({ token: { sessionId: "s", epoch: 1 }, bytes, mimeType: "audio/webm", durationMs: 1500, voicedMs: 1200 }, session.signal);
  const s0 = Date.now();
  session.abort();
  await assert.rejects(pending, /stopped/);
  console.log(`# receipt: stop→reject ${Date.now() - s0} ms`);
});

test("spoken course question → Whisper → same router → grounded ask with task mode, scope and policy in its system prompt", { skip: !real && "set MAGIC_VOICE_REAL=1" }, async () => {
  const config = await localWhisperConfig();
  const transport = new LocalWhisperTransport(config!);
  const session = new AbortController();
  await transport.start(session.signal);
  const text = await transport.transcribe({ token: { sessionId: "s", epoch: 1 }, bytes: speech("What does a recursive method need?"), mimeType: "audio/webm", durationMs: 2500, voicedMs: 2000 }, session.signal);
  session.abort();
  assert.match(text, /recursive method/i, `heard: ${text}`);
  // The model is the repo's fake CLI (no provider call); the prompt it receives is the real one.
  const probe = workspace().store;
  const notes = probe.resources().find((r) => r.title === "Recursion notes")!;
  const pid = `p${probe.passages(notes.id)[0]!.pid}`;
  const here = dirname(fileURLToPath(import.meta.url));
  const fake: CliCommand = { file: process.execPath, prefixArgs: [join(here, "fixtures", "fake-cli", "fake-cli.mjs"), "claude"] };
  const dir = mkdtempSync(join(tmpdir(), "voice-real-ask-"));
  await mkdir(join(dir, "work"));
  const env = { FAKE_CLI_LOG: join(dir, "log.jsonl"), FAKE_CLI_STATE: join(dir, "state"), FAKE_CLI_RESPONSES: JSON.stringify([{ output: { found: true, sentences: [{ text: "It needs a base case.", citations: [{ sourceId: pid, quote: "Every recursive method needs a base case." }] }] } }]) };
  const inner = createPackRuntime(createClaudeBackend({ command: fake, workDir: join(dir, "work"), env }), { dailyBackgroundTokens: 1_000_000 }).runner;
  const requests: RunRequest<unknown>[] = [];
  const runner: ModelRunner = { client: inner.client, run: (r) => (requests.push(r as RunRequest<unknown>), inner.run(r)) };
  const { store, batches } = workspace();
  const router = createIntentRouter({ store, runner: () => runner, now: () => NOW, timeZone: TZ });
  const core = createCore(store, { fixture: batches[0]!, now: () => NOW, timeZone: TZ, seams: { intent: router } });
  await core.execute({ type: "consent", value: { action: "grant", recipient: "claude", disclosureVersion: CONSENT_DISCLOSURE_VERSION } });
  const dispatch = createInteractiveDispatch((command, signal) => core.execute(command as never, signal as never));
  const result = await dispatch(text.trim(), { view: "course", courseId: "acct:c400" }, { signal: new AbortController().signal, current: () => true, operationId: "op2" });
  console.log(`# receipt: heard "${text.trim()}" → ${result.status}${result.status === "ran" ? ` ${result.action}` : ""}`);
  assert.equal(result.status, "answer", JSON.stringify(result));
  const ask = requests.find((q) => /Task mode:/.test(q.systemPrompt));
  assert.ok(ask, "the grounded ask was the producer");
  assert.match(ask!.systemPrompt, /Task mode: concept\. Help boundary: coaching\./);
  assert.match(ask!.systemPrompt, /COMPSCI400[^\n]*\[acct\/c400\]: coaching/);
  assert.doesNotMatch(ask!.systemPrompt, /ECON101|PHILOS101/, "course context kept the scope to CS 400");
});
