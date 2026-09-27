import type { VoiceAudio, VoiceToken, VoiceTurn } from './types';
import { intentCommandSchema } from '@magic/contracts';

export const isToken = (value: unknown): value is VoiceToken => !!value && typeof value === 'object' && typeof (value as VoiceToken).sessionId === 'string' && (value as VoiceToken).sessionId.length < 100 && Number.isSafeInteger((value as VoiceToken).epoch);
/** owner: voice-plan: the open page's ids only (course, item, note, view), as a command's context. */
export const isRequestContext = (value: unknown): value is NonNullable<VoiceTurn['context']> => !!value && typeof value === 'object' && intentCommandSchema.shape.context.safeParse(value).success;
export const isVoiceTurn = (turn: unknown): turn is VoiceTurn => !!turn && typeof turn === 'object' && typeof (turn as VoiceTurn).operationId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test((turn as VoiceTurn).operationId) && intentCommandSchema.shape.context.safeParse((turn as VoiceTurn).context).success;
/** owner: voice-plan: one streaming frame, mono 16 kHz Int16, at most 200 ms (the helper's limit). */
export const isPcmFrame = (value: unknown): value is Int16Array => value instanceof Int16Array && value.length > 0 && value.length <= 3200;
export function isVoiceAudio(value: unknown): value is VoiceAudio {
  if (!value || typeof value !== 'object') return false;
  const audio = value as VoiceAudio;
  return (!audio.turn || isVoiceTurn(audio.turn)) && isToken(audio.token) && audio.bytes instanceof ArrayBuffer && audio.bytes.byteLength > 0 && audio.bytes.byteLength <= 2_000_000 && audio.mimeType === 'audio/webm' && Number.isFinite(audio.durationMs) && audio.durationMs >= 0 && audio.durationMs <= 30_000 && Number.isFinite(audio.voicedMs) && audio.voicedMs >= 0 && audio.voicedMs <= audio.durationMs;
}
export function microphonePermission(owner: { getURL(): string }, rendererURL: string, active: boolean, sender: { getURL(): string } | null, permission: string, details: { isMainFrame?: boolean; requestingUrl?: string; mediaType?: string; mediaTypes?: string[] }): boolean {
  return active && sender === owner && permission === 'media' && owner.getURL() === rendererURL && details.isMainFrame === true && details.requestingUrl === rendererURL && (details.mediaTypes ? details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio' : details.mediaType === 'audio');
}
