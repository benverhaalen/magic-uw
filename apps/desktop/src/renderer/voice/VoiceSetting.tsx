// owner: voice. The Data & AI row for voice input: the one place the student agrees to the model
// download, sees what is on disk and can remove it. Uses the settings page's existing section markup.
import type { LocalDictation } from "./useLocalDictation";
import { NEEDS_MODEL_REASON, VOICE_MODEL_MB } from "./useLocalDictation";
import { shortcutLabel } from "./rules";

export function VoiceSetting({ dictation, mac }: { dictation: LocalDictation; mac: boolean }) {
  const { state, model, reason } = dictation;
  if (state === "unavailable") return null;
  const ready = !!model?.downloaded;
  return <section className="settings-section" id="voice-input">
    <h2>Voice input</h2>
    <p>
      Speak instead of typing: press {shortcutLabel(mac, "voice")} to open chat and talk. A small speech-to-text model
      (Whisper tiny, English) turns your voice into text on this computer. Your voice is never sent anywhere.
    </p>
    {ready ? <>
      <p className="small muted">Voice model on this computer · {Math.round((model?.bytes ?? 0) / 1_000_000)} MB · {model?.license}.</p>
      <div className="inline-actions">
        <button className="subtle-button" disabled={state === "listening" || state === "processing"} onClick={() => void dictation.remove()}>Remove voice model</button>
      </div>
    </> : <>
      <p className="small muted">
        Voice needs a one-time {VOICE_MODEL_MB} MB download from Hugging Face ({model?.model ?? "onnx-community/whisper-tiny.en"},
        {" "}{model?.license ?? "Apache-2.0"}). Nothing downloads until you choose Download; the files are checked before they are kept.
      </p>
      <div className="inline-actions">
        <button className="button" disabled={state === "downloading"} onClick={() => void dictation.download()}>
          {state === "downloading" ? "Downloading…" : `Download ${VOICE_MODEL_MB} MB`}
        </button>
      </div>
    </>}
    {reason && reason !== NEEDS_MODEL_REASON && state !== "listening" ? <p className="small attention-text" role="status">{reason}</p> : null}
  </section>;
}
