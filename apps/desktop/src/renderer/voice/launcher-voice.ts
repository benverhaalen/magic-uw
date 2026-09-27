import type { LauncherVoice, LauncherVoiceState } from "../conversation-launcher/ConversationLauncher";

// owner: voice-learning-media lane. Pure mapping from the shared voice session (voice-shared-path
// VoiceMicrophone view + bridge capabilities) to the launcher's controls. It never starts audio.
// Structural types so this leaf does not depend on the voice candidate's module being merged first.

export type VoiceSessionReason = "stopped" | "permission-denied" | "device-unavailable" | "transport-unavailable" | "disconnected" | "context-changed" | "too-long";
export interface VoiceSessionView {
  phase: "idle" | "starting" | "listening" | "transcribing" | "working" | "unavailable";
  reason?: VoiceSessionReason;
  levels: readonly number[];
}

export const VOICE_REASON_TEXT: Record<VoiceSessionReason, string> = {
  stopped: "",
  "permission-denied": "Microphone access is off. Allow it in System Settings, then try again.",
  "device-unavailable": "The microphone is unavailable. Check your input device and try again.",
  "transport-unavailable": "Local speech recognition failed on this Mac. Check setup and try again.",
  disconnected: "Voice stopped because its connection ended. Try again when you're ready.",
  "context-changed": "Voice stopped because your account or permissions changed.",
  "too-long": "That request was too long. Voice stopped without carrying it out. Try a shorter request.",
};
export const VOICE_UNAVAILABLE_TEXT = "Voice isn't available on this Mac yet. You can type instead.";

/**
 * `unavailable` means this Mac lacks the capability (no microphone or local transcription), so the mic
 * explains itself instead of starting. A session that ended with a problem is `error`: the student sees
 * why and can press the mic again. The previous mapping sent both to `unavailable`, which kept a
 * one-off denial or disconnect blocking voice until the launcher remounted.
 */
export function launcherVoice(
  available: boolean,
  view: VoiceSessionView,
  controls: { onStart(): void; onStop(): void },
): LauncherVoice {
  const state: LauncherVoiceState = !available ? "unavailable"
    : view.phase === "idle" ? "ready"
    : view.phase === "unavailable" ? "error"
    : view.phase;
  const reason = state === "unavailable" ? VOICE_UNAVAILABLE_TEXT
    : state === "error" ? (view.reason && VOICE_REASON_TEXT[view.reason]) || "Voice stopped. Try again, or type instead."
    : undefined;
  return { state, reason, levels: state === "listening" ? view.levels : undefined, onStart: controls.onStart, onStop: controls.onStop };
}

/** One short announcement per transition, for the launcher's polite live region. */
export function voiceAnnouncement(previous: LauncherVoiceState, next: LauncherVoiceState): string | null {
  if (previous === next) return null;
  if (next === "starting") return "Starting voice";
  if (next === "listening") return "Listening. Press Escape or Stop voice to stop.";
  if (next === "transcribing") return "Transcribing your speech";
  if (next === "working") return "Working on your request";
  if (next === "ready" && previous !== "unavailable" && previous !== "error") return "Voice stopped";
  return null; // errors are announced by the alert that shows them
}
