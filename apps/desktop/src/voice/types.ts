import type { IntentCommand, IntentCommandResult } from "@magic/contracts";
import type { AgentReadiness } from "./agent-warmup"; // owner: voice-plan

/** Local voice contracts. No audio, transcript, or provider credential is persisted. */
export type VoicePhase = 'idle' | 'starting' | 'listening' | 'transcribing' | 'working' | 'unavailable';
export type VoiceReason = 'stopped' | 'permission-denied' | 'device-unavailable' | 'transport-unavailable' | 'disconnected' | 'context-changed' | 'too-long';
export interface VoiceToken { sessionId: string; epoch: number }
export interface VoiceContext { account: string; revision: string; allowed: boolean }
export interface VoiceState { phase: VoicePhase; token: VoiceToken | null; reason?: VoiceReason }
export interface VoiceCapabilities { microphone: boolean; transcription: 'local-whisper' | 'speech-transcriber' | null; externalControl: false; streamingSpeech: boolean; /** owner: voice-plan: the connected agent's launch readiness */ agent?: AgentReadiness | null }
export type VoiceRequestContext = NonNullable<IntentCommand['context']>;
export interface VoiceTurn { operationId: string; context: VoiceRequestContext }
export type VoiceEvent =
  | { type: 'state'; state: VoiceState }
  | { type: 'transcript-partial'; token: VoiceToken; operationId: string; text: string }
  | { type: 'transcript'; token: VoiceToken; operationId: string; text: string }
  | { type: 'result'; token: VoiceToken; operationId: string; text: string; result: IntentCommandResult };
export interface VoiceAudio { turn?: VoiceTurn; token: VoiceToken; bytes: ArrayBuffer; mimeType: 'audio/webm'; durationMs: number; voicedMs: number }
export type VoiceReceipt = { status: 'dispatched' | 'no-match' | 'silence' | 'stopped' | 'context-changed' | 'busy'; operationId?: string; /** owner: voice-plan: which recognizer produced the dispatched text */ transcription?: 'speech-transcriber' | 'local-whisper' };
export interface VoiceBridge {
  capabilities(): Promise<VoiceCapabilities>;
  start(): Promise<VoiceState>;
  ready(token: VoiceToken): Promise<VoiceState>;
  stop(reason?: VoiceReason): Promise<VoiceState>;
  transcribe(audio: VoiceAudio): Promise<VoiceReceipt>;
  onEvent(listener: (event: VoiceEvent) => void): () => void;
  /** owner: voice-plan: the connected agent's readiness as it changes (launch, failure, provider change). */
  onAgent?(listener: (agent: AgentReadiness) => void): () => void;
  /**
   * owner: voice-plan. On-device streaming speech, per utterance, after the Start click (BRIDGE-CONTRACT).
   * `begin` starts the helper without opening a microphone; `push` sends mono 16 kHz Int16 frames of at most
   * 3200 samples, attaching the turn once on first speech (false: this utterance uses local Whisper); `end`
   * takes the utterance's complete WebM and resolves after its final text is dispatched, like `transcribe`.
   */
  beginStreamingTurn?(token: VoiceToken): Promise<'ready' | 'fallback'>;
  pushStreamingPCM?(token: VoiceToken, frame: Int16Array, turn?: VoiceTurn): Promise<boolean>;
  endStreamingTurn?(audio: VoiceAudio): Promise<VoiceReceipt>;
}
export const sameVoiceToken = (a: VoiceToken | null, b: VoiceToken | null): boolean => !!a && !!b && a.sessionId === b.sessionId && a.epoch === b.epoch;
