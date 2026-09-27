// owner: voice. Pure rules for local dictation, testable without a browser: when listening stops on
// its own, the chat shortcuts, and plain words for a microphone failure.

/** Input level (RMS of the time-domain signal) that counts as speech. */
export const SPEECH_LEVEL = 0.02;
/** After speech, this much quiet ends listening. */
export const PAUSE_MS = 1500;
/** With no speech at all, listening ends after this long. */
export const NO_SPEECH_MS = 8000;
/** Whisper reads 30-second windows; one dictation is at most one window. */
export const MAX_LISTEN_MS = 30000;

export interface Listening { startedAt: number; heardAt: number | null }
export type ListenStop = "pause" | "no_speech" | "limit";
export const beginListening = (now: number): Listening => ({ startedAt: now, heardAt: null });

/** One level sample. Returns the next state and, when listening should end, why. */
export function listenStep(state: Listening, now: number, level: number): { state: Listening; stop: ListenStop | null } {
  const next = level >= SPEECH_LEVEL ? { ...state, heardAt: now } : state;
  if (now - next.startedAt >= MAX_LISTEN_MS) return { state: next, stop: "limit" };
  if (next.heardAt === null) return { state: next, stop: now - next.startedAt >= NO_SPEECH_MS ? "no_speech" : null };
  return { state: next, stop: now - next.heardAt >= PAUSE_MS ? "pause" : null };
}

/** Root-mean-square level of one analyser frame, 0..1. */
export function rms(frame: ArrayLike<number>): number {
  if (!frame.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  return Math.min(1, Math.sqrt(sum / frame.length));
}

export interface KeyLike { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; isComposing?: boolean }
/**
 * The in-app shortcuts. `mod` is Cmd on a Mac and Ctrl elsewhere.
 * - mod+Shift+Space: open the chat and start listening.
 * - mod+K: open the chat with the composer focused.
 */
export function chatShortcut(event: KeyLike, mac: boolean): "voice" | "compose" | null {
  if (event.isComposing || event.altKey) return null;
  const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!mod) return null;
  if (event.shiftKey && (event.code === "Space" || event.key === " ")) return "voice";
  if (!event.shiftKey && event.key.toLowerCase() === "k") return "compose";
  return null;
}
export const shortcutLabel = (mac: boolean, which: "voice" | "compose") =>
  which === "voice" ? (mac ? "Cmd+Shift+Space" : "Ctrl+Shift+Space") : mac ? "Cmd+K" : "Ctrl+K";

/** Plain words for a microphone failure. */
export function micError(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "The microphone was not allowed. Allow microphone access for My Magic UW in your computer's privacy settings, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found.";
  if (name === "NotReadableError") return "The microphone is in use by another app.";
  return error instanceof Error && error.message.length < 200 ? error.message : "Voice input could not start.";
}
