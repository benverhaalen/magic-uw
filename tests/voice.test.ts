// Local dictation: when listening stops, the shortcuts, the microphone permission, the pinned model
// manifest and main's download store, and the engine's no-network file mapping. Pure and file-system
// checks only; the model itself is exercised by a headless run of voice/engine.ts (see the adoption note).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginListening, chatShortcut, listenStep, micError, rms, MAX_LISTEN_MS, NO_SPEECH_MS, PAUSE_MS } from "../apps/desktop/src/renderer/voice/rules";
import { cleanTranscript, manifestPathOf } from "../apps/desktop/src/renderer/voice/engine";
import { allowsVoiceMic } from "../apps/desktop/src/voice/permission";
import { createVoiceStore } from "../apps/desktop/src/voice/store";
import { VOICE_MODEL_BYTES, VOICE_MODEL_FILES, VOICE_MODEL_ID, VOICE_MODEL_MB, VOICE_MODEL_REVISION, VOICE_RUNTIME_FILE, isVoiceFileName, voiceFileUrl } from "../apps/desktop/src/voice/manifest";

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}, code?: string) =>
  ({ key: k, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

test("listening ends after a pause following speech, after silence, or at the 30 s window", () => {
  let s = beginListening(0);
  assert.equal(listenStep(s, 1000, 0.001).stop, null, "quiet start keeps listening");
  s = listenStep(s, 1200, 0.2).state;
  assert.equal(listenStep(s, 1200 + PAUSE_MS - 1, 0.001).stop, null);
  assert.equal(listenStep(s, 1200 + PAUSE_MS, 0.001).stop, "pause");
  assert.equal(listenStep(beginListening(0), NO_SPEECH_MS, 0).stop, "no_speech");
  let talking = beginListening(0);
  for (let t = 0; t < MAX_LISTEN_MS; t += 500) talking = listenStep(talking, t, 0.3).state;
  assert.equal(listenStep(talking, MAX_LISTEN_MS, 0.3).stop, "limit");
  assert.equal(rms([]), 0);
  assert.ok(Math.abs(rms([0.5, -0.5, 0.5, -0.5]) - 0.5) < 1e-9);
});

test("shortcuts: mod+K opens the chat, mod+Shift+Space dictates; Cmd on a Mac, Ctrl elsewhere", () => {
  assert.equal(chatShortcut(key("k", { ctrlKey: true }), false), "compose");
  assert.equal(chatShortcut(key("K", { ctrlKey: true }), false), "compose");
  assert.equal(chatShortcut(key(" ", { ctrlKey: true, shiftKey: true }, "Space"), false), "voice");
  assert.equal(chatShortcut(key("k", { metaKey: true }), true), "compose");
  assert.equal(chatShortcut(key(" ", { metaKey: true, shiftKey: true }, "Space"), true), "voice");
  assert.equal(chatShortcut(key("k", { metaKey: true }), false), null, "Windows: the Windows key is not the modifier");
  assert.equal(chatShortcut(key("k", { ctrlKey: true }), true), null, "Mac: Ctrl+K stays the text field's own");
  assert.equal(chatShortcut(key("k", { ctrlKey: true, altKey: true }), false), null);
  assert.equal(chatShortcut(key("k", { ctrlKey: true, shiftKey: true }), false), null);
  assert.equal(chatShortcut({ ...key("k", { ctrlKey: true }), isComposing: true }, false), null);
  assert.match(micError(Object.assign(new Error("x"), { name: "NotAllowedError" })), /not allowed/);
});

test("the app window grants only the microphone, audio only, to its own page", () => {
  const page = "file:///C:/app/dist/renderer/index.html";
  const ok = { fromAppWindow: true, permission: "media", mediaTypes: ["audio"], requestingUrl: page, isMainFrame: true };
  assert.equal(allowsVoiceMic(ok, page), true);
  assert.equal(allowsVoiceMic({ ...ok, requestingUrl: `${page}#resource/1` }, page), true, "the same page with a hash");
  assert.equal(allowsVoiceMic({ ...ok, mediaTypes: ["audio", "video"] }, page), false, "no camera");
  assert.equal(allowsVoiceMic({ ...ok, mediaTypes: ["video"] }, page), false);
  assert.equal(allowsVoiceMic({ ...ok, mediaTypes: [] }, page), false);
  assert.equal(allowsVoiceMic({ ...ok, permission: "notifications" }, page), false);
  assert.equal(allowsVoiceMic({ ...ok, fromAppWindow: false }, page), false, "UW or Outlook windows never get it");
  assert.equal(allowsVoiceMic({ ...ok, requestingUrl: "https://canvas.wisc.edu/" }, page), false);
  assert.equal(allowsVoiceMic({ ...ok, requestingUrl: `${page}.evil.html` }, page), false);
  assert.equal(allowsVoiceMic({ ...ok, isMainFrame: false }, page), false);
  const main = readFileSync(new URL("../apps/desktop/src/main.ts", import.meta.url), "utf8");
  assert.match(main, /setPermissionRequestHandler\(\s*\(wc, permission, callback, details\) => \{[\s\S]*?callback\(allowsVoiceMic\(/);
});

test("the model is pinned: one revision, every file sized and hashed, about 44 MB, and the runtime ships with the app", () => {
  assert.equal(VOICE_MODEL_ID, "onnx-community/whisper-tiny.en");
  assert.match(VOICE_MODEL_REVISION, /^[0-9a-f]{40}$/);
  for (const file of VOICE_MODEL_FILES) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/, file.path);
    assert.equal(voiceFileUrl(file.path), `https://huggingface.co/${VOICE_MODEL_ID}/resolve/${VOICE_MODEL_REVISION}/${file.path}`);
  }
  assert.equal(VOICE_MODEL_BYTES, 43536374);
  assert.equal(VOICE_MODEL_MB, 44);
  assert.equal(isVoiceFileName(VOICE_RUNTIME_FILE), true);
  for (const bad of ["../secrets.json", "onnx/../../x", "config.json/..", "", 3, null]) assert.equal(isVoiceFileName(bad), false, String(bad));
});

test("main's store: nothing is fetched to report status; a mismatched download is not kept; only manifest files are readable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-"));
  try {
    const calls: string[] = [];
    const store = createVoiceStore(join(dir, "model"), join(dir, "runtime"), async (url) => {
      calls.push(url);
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("not the model").buffer as ArrayBuffer };
    });
    assert.deepEqual(await store.status(), { downloaded: false, bytes: 0, model: VOICE_MODEL_ID, license: "Apache-2.0 (openai/whisper-tiny.en)" });
    assert.deepEqual(calls, [], "status never downloads");
    await assert.rejects(store.download(), /did not match the expected version/);
    assert.equal(calls.length, 1, "stops at the first bad file");
    assert.equal(existsSync(join(dir, "model", "config.json")), false, "nothing kept");
    await assert.rejects(store.file("../../etc/passwd"), /Unknown voice file/);
    await assert.rejects(store.file("config.json"), /ENOENT|incomplete/);
    const failing = createVoiceStore(join(dir, "m2"), join(dir, "runtime"), async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) }));
    await assert.rejects(failing.download(), /HTTP 503/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the engine answers only manifest files, for any revision the library asks for, and strips non-speech markers", () => {
  const base = `https://huggingface.co/${VOICE_MODEL_ID}/resolve`;
  assert.equal(manifestPathOf(`${base}/${VOICE_MODEL_REVISION}/config.json`), "config.json");
  assert.equal(manifestPathOf(`${base}/main/onnx/encoder_model_quantized.onnx`), "onnx/encoder_model_quantized.onnx");
  assert.equal(manifestPathOf({ url: `${base}/main/tokenizer.json` }), "tokenizer.json");
  assert.equal(manifestPathOf(`${base}/main/processor_config.json`), null, "not in the manifest");
  assert.equal(manifestPathOf("https://huggingface.co/other/model/resolve/main/config.json"), null);
  assert.equal(cleanTranscript(" [BLANK_AUDIO]  What is due (music) this week? "), "What is due this week?");
  const engine = readFileSync(new URL("../apps/desktop/src/renderer/voice/engine.ts", import.meta.url), "utf8");
  assert.match(engine, /env\.fetch = async \(\) => new Response\(null, \{ status: 404 \}\);/, "the library's own fetch never reaches the network");
  assert.match(engine, /wasm\.wasmBinary = runtime;/);
});

test("the renderer can compile WebAssembly but still connects only to itself; downloads happen in main", () => {
  const html = readFileSync(new URL("../apps/desktop/index.html", import.meta.url), "utf8");
  assert.match(html, /script-src 'self' 'wasm-unsafe-eval';/);
  assert.match(html, /connect-src 'self';/);
});
