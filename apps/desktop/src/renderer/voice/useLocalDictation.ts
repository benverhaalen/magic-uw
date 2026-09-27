// owner: voice. Local dictation as a reusable module, with no UI of its own: speech is recorded in this
// window, turned into text by a local Whisper model in a worker, and handed to the caller. Nothing about
// the audio leaves the computer. The model is on disk only after the student pressed Download in
// Data & AI (VoiceSetting); until then `state` is "needs_model" and `start()` records nothing.
//
// A chat surface uses it directly (start, stop, transcript, state) or through `launcherVoice()`, which
// has the shape the shell's ConversationLauncher takes for its mic.
import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceBridge, VoiceModelStatus } from "@magic/contracts";
import type { LauncherVoice } from "../conversation-launcher";
import { VOICE_MODEL_FILES, VOICE_MODEL_MB, VOICE_RUNTIME_FILE } from "../../voice/manifest";
import { beginListening, listenStep, micError, rms } from "./rules";
import type { VoiceWorkerReply, VoiceWorkerRequest } from "./worker";

export { VOICE_MODEL_MB };
export type DictationState = "unavailable" | "needs_model" | "downloading" | "ready" | "starting" | "listening" | "processing";
export const NEEDS_MODEL_REASON = `Voice input needs a one-time ${VOICE_MODEL_MB} MB download. Download it in Data & AI, under Voice input.`;

/** One worker per window, loaded on the first dictation after the model is on disk. */
let worker: Worker | null = null;
let loaded: Promise<void> | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve(text: string): void; reject(error: Error): void }>();

function loadWorker(bridge: VoiceBridge): Promise<void> {
  loaded ??= (async () => {
    const [runtime, ...files] = await Promise.all([bridge.file(VOICE_RUNTIME_FILE), ...VOICE_MODEL_FILES.map((file) => bridge.file(file.path))]);
    const next = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "voice" });
    worker = next;
    await new Promise<void>((resolve, reject) => {
      next.onmessage = ({ data }: MessageEvent<VoiceWorkerReply>) => {
        if (data.type === "ready") resolve();
        else if (data.type === "error" && data.id === null) reject(new Error(data.message));
        else if (data.type === "text") { waiting.get(data.id)?.resolve(data.text); waiting.delete(data.id); }
        else if (data.type === "error") { waiting.get(data.id!)?.reject(new Error(data.message)); waiting.delete(data.id!); }
      };
      next.onerror = () => reject(new Error("Voice input could not start on this computer."));
      const message: VoiceWorkerRequest = { type: "load", files: VOICE_MODEL_FILES.map((file, i): [string, Uint8Array] => [file.path, files[i]!]), runtime: runtime! };
      next.postMessage(message, [runtime!.buffer as ArrayBuffer, ...files.map((f) => f!.buffer as ArrayBuffer)]);
    });
  })().catch((error: unknown) => {
    worker?.terminate();
    worker = null;
    loaded = null;
    throw error;
  });
  return loaded;
}
function transcribe(audio: Float32Array): Promise<string> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker!.postMessage({ type: "transcribe", id, audio } satisfies VoiceWorkerRequest, [audio.buffer as ArrayBuffer]);
  });
}

/** Records until a pause, the time limit or `signal`, then decodes to 16 kHz mono for Whisper. */
async function record(onLevel: (level: number) => void, signal: AbortSignal): Promise<Float32Array> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
  const context = new AudioContext({ sampleRate: 16000 });
  try {
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    recorder.start(250);
    const frame = new Float32Array(analyser.fftSize);
    let state = beginListening(performance.now());
    await new Promise<void>((resolve) => {
      const finish = () => { window.clearInterval(timer); resolve(); };
      const timer = window.setInterval(() => {
        analyser.getFloatTimeDomainData(frame);
        const level = rms(frame);
        onLevel(Math.min(1, level * 8));
        const step = listenStep(state, performance.now(), level);
        state = step.state;
        if (step.stop) finish();
      }, 50);
      if (signal.aborted) finish();
      else signal.addEventListener("abort", finish, { once: true });
    });
    recorder.stop();
    await stopped;
    if (state.heardAt === null) return new Float32Array(0);
    const decoded = await context.decodeAudioData(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer());
    return decoded.getChannelData(0).slice();
  } finally {
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => undefined);
  }
}

export interface LocalDictation {
  state: DictationState;
  /** Why it can't run, or what went wrong last. Plain words for the student. */
  reason: string | null;
  /** Recent input levels in 0..1 from the real analyser, newest last; empty unless listening. */
  levels: readonly number[];
  /** The last transcript, or null. */
  transcript: string | null;
  model: VoiceModelStatus | null;
  /** Starts listening; resolves with the transcript (null when nothing was said, it failed, or no model). */
  start(): Promise<string | null>;
  /** Ends listening now; whatever was said is still transcribed. Never waits on the model. */
  stop(): void;
  /** Only for the student's explicit Download in the app. */
  download(): Promise<void>;
  remove(): Promise<void>;
}

export function useLocalDictation(bridge: VoiceBridge | undefined): LocalDictation {
  const supported = !!bridge && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
  const [model, setModel] = useState<VoiceModelStatus | null>(null);
  const [state, setState] = useState<DictationState>(supported ? "needs_model" : "unavailable");
  const [reason, setReason] = useState<string | null>(supported ? null : "Voice input is available in the desktop app.");
  const [levels, setLevels] = useState<readonly number[]>([]);
  const [transcript, setTranscript] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const modelRef = useRef(model);
  modelRef.current = model;

  useEffect(() => {
    if (!supported) return;
    let live = true;
    bridge!.status().then((status) => {
      if (!live) return;
      setModel(status);
      setState((s) => (s === "needs_model" && status.downloaded ? "ready" : s));
    }).catch(() => undefined);
    return () => { live = false; abort.current?.abort(); };
  }, [bridge, supported]);

  const stop = useCallback(() => abort.current?.abort(), []);
  const start = useCallback(async (): Promise<string | null> => {
    if (!supported) return null;
    if (!modelRef.current?.downloaded) { setState("needs_model"); setReason(NEEDS_MODEL_REASON); return null; }
    if (abort.current) return null;
    const controller = new AbortController();
    abort.current = controller;
    setReason(null);
    try {
      setState("starting");
      await loadWorker(bridge!);
      setState("listening");
      const audio = await record((level) => setLevels((l) => [...l.slice(-23), level]), controller.signal);
      setLevels([]);
      if (!audio.length) { setReason("Nothing was heard. Try again closer to the microphone."); return null; }
      setState("processing");
      const words = await transcribe(audio);
      if (!words) setReason("No words were recognised. Try again.");
      setTranscript(words || null);
      return words || null;
    } catch (error) {
      setReason(micError(error));
      return null;
    } finally {
      setLevels([]);
      setState("ready");
      if (abort.current === controller) abort.current = null;
    }
  }, [bridge, supported]);

  const download = useCallback(async () => {
    if (!bridge) return;
    setState("downloading");
    setReason(null);
    try {
      const status = await bridge.download();
      setModel(status);
      setState(status.downloaded ? "ready" : "needs_model");
      if (!status.downloaded) setReason("The download did not finish.");
    } catch (error) {
      setState("needs_model");
      setReason(error instanceof Error && error.message.length < 300 ? error.message : "The download did not finish.");
    }
  }, [bridge]);

  const remove = useCallback(async () => {
    if (!bridge) return;
    abort.current?.abort();
    worker?.terminate();
    worker = null;
    loaded = null;
    const status = await bridge.remove();
    setModel(status);
    setState("needs_model");
  }, [bridge]);

  return { state, reason, levels, transcript, model, start, stop, download, remove };
}

/** The shape the shell's ConversationLauncher takes for its mic. */
export function launcherVoice(dictation: LocalDictation, onTranscript: (text: string) => void): LauncherVoice {
  const state = dictation.state === "ready" || dictation.state === "starting" || dictation.state === "listening" || dictation.state === "processing" ? dictation.state : "unavailable";
  return {
    state,
    reason: state === "unavailable" ? dictation.reason ?? NEEDS_MODEL_REASON : dictation.reason ?? undefined,
    levels: dictation.levels,
    onStart: () => { void dictation.start().then((text) => { if (text) onTranscript(text); }); },
    onStop: dictation.stop,
  };
}
