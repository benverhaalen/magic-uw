// owner: voice. The transcription worker: Whisper on WebAssembly, off the page's thread.
// It receives main's verified model files and the bundled runtime from the page and never fetches.
import * as transformers from "@huggingface/transformers";
import { createTranscriber, type TransformersLib } from "./engine";

export type VoiceWorkerRequest =
  | { type: "load"; files: [string, Uint8Array][]; runtime: Uint8Array }
  | { type: "transcribe"; id: number; audio: Float32Array };
export type VoiceWorkerReply =
  | { type: "ready" }
  | { type: "text"; id: number; text: string }
  | { type: "error"; id: number | null; message: string };

const scope = self as unknown as { onmessage: ((event: MessageEvent<VoiceWorkerRequest>) => void) | null; postMessage(reply: VoiceWorkerReply): void };
let transcribe: ((audio: Float32Array) => Promise<string>) | null = null;
const failure = (error: unknown) => (error instanceof Error && error.message.length < 300 ? error.message : "Voice input could not run.");

scope.onmessage = async ({ data }) => {
  if (data.type === "load") {
    try {
      transcribe = await createTranscriber(transformers as unknown as TransformersLib, new Map(data.files), data.runtime);
      scope.postMessage({ type: "ready" });
    } catch (error) {
      scope.postMessage({ type: "error", id: null, message: failure(error) });
    }
  } else if (data.type === "transcribe") {
    if (!transcribe) return scope.postMessage({ type: "error", id: data.id, message: "The voice model is not loaded yet." });
    try {
      scope.postMessage({ type: "text", id: data.id, text: await transcribe(data.audio) });
    } catch (error) {
      scope.postMessage({ type: "error", id: data.id, message: failure(error) });
    }
  }
};
