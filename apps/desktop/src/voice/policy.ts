import type { VoiceAudio, VoiceToken } from './types';
import { intentCommandSchema } from '@magic/contracts';

export const isToken = (value: unknown): value is VoiceToken => !!value && typeof value === 'object' && typeof (value as VoiceToken).sessionId === 'string' && (value as VoiceToken).sessionId.length < 100 && Number.isSafeInteger((value as VoiceToken).epoch);
export function isVoiceAudio(value: unknown): value is VoiceAudio {
  if (!value || typeof value !== 'object') return false;
  const audio = value as VoiceAudio;
  return (!audio.turn || (typeof audio.turn.operationId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(audio.turn.operationId) && intentCommandSchema.shape.context.safeParse(audio.turn.context).success)) && isToken(audio.token) && audio.bytes instanceof ArrayBuffer && audio.bytes.byteLength > 0 && audio.bytes.byteLength <= 2_000_000 && audio.mimeType === 'audio/webm' && Number.isFinite(audio.durationMs) && audio.durationMs >= 0 && audio.durationMs <= 30_000 && Number.isFinite(audio.voicedMs) && audio.voicedMs >= 0 && audio.voicedMs <= audio.durationMs;
}
export function microphonePermission(owner: { getURL(): string }, rendererURL: string, active: boolean, sender: { getURL(): string } | null, permission: string, details: { isMainFrame?: boolean; requestingUrl?: string; mediaType?: string; mediaTypes?: string[] }): boolean {
  return active && sender === owner && permission === 'media' && owner.getURL() === rendererURL && details.isMainFrame === true && details.requestingUrl === rendererURL && (details.mediaTypes ? details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio' : details.mediaType === 'audio');
}
