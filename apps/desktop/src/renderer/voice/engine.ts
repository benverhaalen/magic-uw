// owner: voice. The transcription core, shared by the renderer's voice worker and its
// headless check: transformers.js runs Whisper on the WebAssembly backend from bytes it is handed. It has
// no network by construction: model files come from an in-memory cache filled by main's verified copy,
// the runtime binary is passed in, and any other request is answered "not found" without a socket.
import { VOICE_MODEL_FILES, VOICE_MODEL_ID, VOICE_MODEL_REVISION } from "../../voice/manifest";

/** The part of @huggingface/transformers this uses (injected so a headless check can load the web build). */
export interface TransformersLib {
  env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    useBrowserCache: boolean;
    useCustomCache: boolean;
    useWasmCache?: boolean;
    customCache: unknown;
    backends: { onnx: { wasm?: { wasmBinary?: ArrayBufferLike | Uint8Array; wasmPaths?: unknown; numThreads?: number; proxy?: boolean } } };
    /** The library's own fetch for hub files and runtimes. */
    fetch: (input: string, init?: unknown) => Promise<Response>;
  };
  pipeline(task: "automatic-speech-recognition", model: string, options: Record<string, unknown>): Promise<unknown>;
}

type Transcribe = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;

/**
 * The cache key transformers.js uses for a hub file is its remote URL; this maps it back to a manifest
 * path. Some of the library's reads ask for the `main` revision whatever the pipeline was given; every
 * answer is main's verified copy of the pinned revision, so the revision segment is not trusted either way.
 */
export function manifestPathOf(key: unknown): string | null {
  const url = typeof key === "string" ? key : key && typeof key === "object" && "url" in key ? String((key as { url: unknown }).url) : "";
  const marker = `/${VOICE_MODEL_ID}/resolve/`;
  const at = url.indexOf(marker);
  if (at < 0) return null;
  const rest = url.slice(at + marker.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const path = decodeURIComponent(rest.slice(slash + 1).split(/[?#]/)[0]!);
  return VOICE_MODEL_FILES.some((file) => file.path === path) ? path : null;
}

/** Removes Whisper's non-speech markers ("[BLANK_AUDIO]", "(music)") and tidies spacing. */
export function cleanTranscript(text: string): string {
  return text.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

export async function createTranscriber(lib: TransformersLib, files: ReadonlyMap<string, Uint8Array>, runtime: Uint8Array) {
  for (const file of VOICE_MODEL_FILES) if (!files.has(file.path)) throw new Error(`Voice model file missing: ${file.path}`);
  const { env } = lib;
  env.allowLocalModels = false;
  env.allowRemoteModels = true; // Required by the library's config check; the fetch below never leaves the process.
  env.useBrowserCache = false;
  env.useWasmCache = false;
  env.useCustomCache = true;
  env.customCache = {
    async match(key: unknown) {
      const path = manifestPathOf(key);
      const bytes = path ? files.get(path) : undefined;
      return bytes ? new Response(bytes.slice(), { headers: { "content-length": String(bytes.byteLength) } }) : undefined;
    },
    async put() { /* the verified copy on disk is the cache */ },
  };
  const wasm = env.backends.onnx.wasm;
  if (!wasm) throw new Error("The WebAssembly runtime is unavailable.");
  wasm.wasmBinary = runtime;
  wasm.wasmPaths = undefined; // The bundled factory; nothing is fetched from a CDN.
  wasm.numThreads = 1; // No cross-origin isolation in the app window, so no shared memory.
  wasm.proxy = false;
  // Anything outside the manifest (optional configs) is "not found"; no request leaves the process.
  env.fetch = async () => new Response(null, { status: 404 });
  const run = (await lib.pipeline("automatic-speech-recognition", VOICE_MODEL_ID, { revision: VOICE_MODEL_REVISION, dtype: "q8", device: "wasm" })) as Transcribe;
  return async (audio: Float32Array): Promise<string> => {
    const out = await run(audio, { chunk_length_s: 30 });
    return cleanTranscript((Array.isArray(out) ? out.map((part) => part.text).join(" ") : out.text) ?? "");
  };
}
