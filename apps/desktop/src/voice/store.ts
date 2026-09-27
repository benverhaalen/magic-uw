// owner: voice. main's side of voice input: the model files on disk. The download runs
// only when the renderer asks after the student agreed in the app (one explicit button), fetches the
// pinned revision from Hugging Face over https, and keeps a file only when its size and SHA-256 match
// the manifest. Nothing here runs at start-up, and the renderer can read back only manifest files.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  VOICE_MODEL_FILES, VOICE_MODEL_ID, VOICE_MODEL_LICENSE, VOICE_RUNTIME_FILE, isVoiceFileName, voiceFileUrl,
  type VoiceModelFile,
} from "./manifest";
import type { VoiceModelStatus } from "@magic/contracts";

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface VoiceStore {
  status(): Promise<VoiceModelStatus>;
  /** Downloads whatever is missing. Only for the student's explicit "Download" in the app. */
  download(): Promise<VoiceModelStatus>;
  /** A model file (after download) or the bundled runtime. Refuses every other name. */
  file(name: unknown): Promise<Uint8Array>;
  remove(): Promise<VoiceModelStatus>;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** `modelDir`: under userData. `runtimeDir`: where the build copied the WebAssembly runtime. */
export function createVoiceStore(modelDir: string, runtimeDir: string, fetchImpl: Fetch = fetch): VoiceStore {
  const pathOf = (file: VoiceModelFile) => join(modelDir, ...file.path.split("/"));
  async function present(file: VoiceModelFile) {
    try { return (await stat(pathOf(file))).size === file.bytes; } catch { return false; }
  }
  async function status(): Promise<VoiceModelStatus> {
    const found = await Promise.all(VOICE_MODEL_FILES.map(present));
    const bytes = VOICE_MODEL_FILES.reduce((sum, file, i) => sum + (found[i] ? file.bytes : 0), 0);
    return { downloaded: found.every(Boolean), bytes, model: VOICE_MODEL_ID, license: VOICE_MODEL_LICENSE };
  }
  let running: Promise<VoiceModelStatus> | null = null;
  async function fetchAll(): Promise<VoiceModelStatus> {
    for (const file of VOICE_MODEL_FILES) {
      if (await present(file)) continue;
      const response = await fetchImpl(voiceFileUrl(file.path));
      if (!response.ok) throw new Error(`The voice model download stopped (${file.path}: HTTP ${response.status}). Nothing was kept from this file.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256)
        throw new Error(`The voice model file ${file.path} did not match the expected version, so it was not kept.`);
      const target = pathOf(file);
      await mkdir(dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.part`;
      await writeFile(temp, bytes);
      await rename(temp, target);
    }
    return status();
  }
  return {
    status,
    download() {
      running ??= fetchAll().finally(() => { running = null; });
      return running;
    },
    async file(name) {
      if (!isVoiceFileName(name)) throw new Error("Unknown voice file.");
      if (name === VOICE_RUNTIME_FILE) return new Uint8Array(await readFile(join(runtimeDir, VOICE_RUNTIME_FILE)));
      const file = VOICE_MODEL_FILES.find((entry) => entry.path === name)!;
      const bytes = new Uint8Array(await readFile(pathOf(file)));
      if (bytes.byteLength !== file.bytes) throw new Error("The voice model on this device is incomplete. Download it again.");
      return bytes;
    },
    async remove() {
      await rm(modelDir, { recursive: true, force: true });
      return status();
    },
  };
}
