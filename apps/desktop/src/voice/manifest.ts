// owner: voice. The one speech-to-text model voice input may use, pinned to an exact
// Hugging Face revision with every file's size and SHA-256. main downloads these files only after the
// student agrees to the one-time download in the app, and refuses any file that does not match.
// Transcription runs locally in the renderer (transformers.js, WebAssembly); audio never leaves the device.
//
// Model: onnx-community/whisper-tiny.en, the ONNX export of openai/whisper-tiny.en (Apache-2.0 on its
// model card; the ONNX repository states no separate licence). Library: @huggingface/transformers
// (Apache-2.0) with onnxruntime-web (MIT). Recorded in docs/tool-evaluation.md.

export const VOICE_MODEL_ID = "onnx-community/whisper-tiny.en";
export const VOICE_MODEL_REVISION = "2575352d61be1bf7225cf8f8b268a4678025fc58";
export const VOICE_MODEL_LICENSE = "Apache-2.0 (openai/whisper-tiny.en)";

export interface VoiceModelFile { path: string; bytes: number; sha256: string }

/** Exactly what the transformers.js speech pipeline reads for this model at dtype q8. */
export const VOICE_MODEL_FILES: readonly VoiceModelFile[] = [
  { path: "config.json", bytes: 2197, sha256: "251ea843b5901a99efa58c0b99b8052c6019aa3e7d2baf46693a1128ff606233" },
  { path: "generation_config.json", bytes: 1646, sha256: "7b2e8451ed5f118e75fdd991409d72119d21d2fef1eba9723f68fb9c57fe5dc9" },
  { path: "preprocessor_config.json", bytes: 339, sha256: "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d" },
  { path: "tokenizer.json", bytes: 2405679, sha256: "5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0" },
  { path: "tokenizer_config.json", bytes: 282662, sha256: "93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c" },
  { path: "onnx/encoder_model_quantized.onnx", bytes: 10124993, sha256: "e93ec822f16a8fd264e7de972ad17d615ea7334b75a52d54c50c2e18dd503a25" },
  { path: "onnx/decoder_model_merged_quantized.onnx", bytes: 30718858, sha256: "c0592d0749413c960569e1c7fb806b060d5d18f3ebad4a95cbf9a77dc6e9be52" },
];

export const VOICE_MODEL_BYTES = VOICE_MODEL_FILES.reduce((sum, file) => sum + file.bytes, 0);
/** Rounded for the consent sentence ("a one-time 44 MB download"). */
export const VOICE_MODEL_MB = Math.round(VOICE_MODEL_BYTES / 1_000_000);

/** The WebAssembly runtime ships with the app (copied beside the renderer at build); never downloaded. */
export const VOICE_RUNTIME_FILE = "ort-wasm-simd-threaded.asyncify.wasm";

export const voiceFileUrl = (path: string) =>
  `https://huggingface.co/${VOICE_MODEL_ID}/resolve/${VOICE_MODEL_REVISION}/${path}`;

/** A name the renderer may ask main for: one of the model files, or the runtime. Nothing else. */
export function isVoiceFileName(value: unknown): value is string {
  return typeof value === "string" && (value === VOICE_RUNTIME_FILE || VOICE_MODEL_FILES.some((file) => file.path === value));
}

/** `downloaded`: every model file is on this device and matched its hash when it was saved. */
export type { VoiceModelStatus } from "@magic/contracts";
