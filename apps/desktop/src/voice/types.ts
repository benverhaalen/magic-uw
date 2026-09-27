import type { IntentCommand, IntentCommandResult } from "@magic/contracts";

/** Local voice contracts. No audio, transcript, or provider credential is persisted. */
export type VoicePhase = 'idle' | 'starting' | 'listening' | 'processing' | 'unavailable';
export type VoiceReason = 'stopped' | 'permission-denied' | 'device-unavailable' | 'transport-unavailable' | 'disconnected' | 'context-changed' | 'too-long';
export interface VoiceToken { sessionId: string; epoch: number }
export interface VoiceContext { account: string; revision: string; allowed: boolean }
export interface VoiceState { phase: VoicePhase; token: VoiceToken | null; reason?: VoiceReason }
export interface VoiceCapabilities { microphone: boolean; transcription: 'local-whisper' | null; externalControl: false; streamingSpeech: false }
export type VoiceRequestContext = NonNullable<IntentCommand['context']>;
export interface VoiceTurn { operationId: string; context: VoiceRequestContext }
export type VoiceEvent =
  | { type: 'state'; state: VoiceState }
  | { type: 'transcript'; token: VoiceToken; operationId: string; text: string }
  | { type: 'result'; token: VoiceToken; operationId: string; text: string; result: IntentCommandResult };
export interface VoiceAudio { turn?: VoiceTurn; token: VoiceToken; bytes: ArrayBuffer; mimeType: 'audio/webm'; durationMs: number; voicedMs: number }
export type VoiceReceipt = { status: 'dispatched' | 'no-match' | 'silence' | 'stopped' | 'context-changed' | 'busy'; operationId?: string };
export interface VoiceBridge {
  capabilities(): Promise<VoiceCapabilities>;
  start(): Promise<VoiceState>;
  ready(token: VoiceToken): Promise<VoiceState>;
  stop(reason?: VoiceReason): Promise<VoiceState>;
  transcribe(audio: VoiceAudio): Promise<VoiceReceipt>;
  onEvent(listener: (event: VoiceEvent) => void): () => void;
}
export const sameVoiceToken = (a: VoiceToken | null, b: VoiceToken | null): boolean => !!a && !!b && a.sessionId === b.sessionId && a.epoch === b.epoch;
