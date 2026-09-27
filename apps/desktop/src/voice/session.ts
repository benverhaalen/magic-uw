import { randomUUID } from 'node:crypto';
import type { IntentCommandResult } from '@magic/contracts';
import type { VoiceRequestContext } from './types';
export interface VoiceDispatch { (text: string, context: VoiceRequestContext, operation: {signal: AbortSignal; current(): boolean; operationId: string}): Promise<IntentCommandResult> }
import { sameVoiceToken, type VoiceAudio, type VoiceContext, type VoiceEvent, type VoiceReason, type VoiceReceipt, type VoiceState, type VoiceToken } from './types';

export interface VoiceTransport {
  start(signal: AbortSignal, disconnected?: () => void): Promise<void>;
  transcribe(audio: VoiceAudio, signal: AbortSignal): Promise<string>;
  close(): void;
}
interface Live { token: VoiceToken; context: VoiceContext; abort: AbortController; transport: VoiceTransport; busy: boolean; seen: Set<string> }

/** One owner for renderer Stop, native Stop, sign-out, crash, and transport loss. */
export class VoiceSession {
  private epoch = 0;
  private live: Live | null = null;
  private state: VoiceState = { phase: 'idle', token: null };
  constructor(private readonly options: {
    context(): VoiceContext;
    dispatch: VoiceDispatch;
    transport(): VoiceTransport;
    requestMicrophone(): Promise<boolean>;
    event(event: VoiceEvent): void;
  }) {}
  status(): VoiceState { return this.state; }
  private publish(state: VoiceState): VoiceState {
    this.state = state;
    this.options.event({ type: 'state', state });
    return state;
  }
  allowsMicrophone(): boolean { return !!this.live && this.current(this.live) && this.state.phase !== 'unavailable'; }
  private current(live: Live): boolean {
    const now = this.options.context();
    return this.live === live && !live.abort.signal.aborted && now.allowed && now.account === live.context.account && now.revision === live.context.revision;
  }
  async start(): Promise<VoiceState> {
    if (this.live && this.current(this.live)) return this.state;
    if (this.live) this.stop();
    const context = this.options.context();
    if (!context.allowed) return this.publish({ phase: 'unavailable', token: null, reason: 'context-changed' });
    const live: Live = { token: { sessionId: randomUUID(), epoch: ++this.epoch }, context: { ...context }, abort: new AbortController(), transport: this.options.transport(), busy: false, seen: new Set() };
    this.live = live;
    this.publish({ phase: 'starting', token: live.token });
    try {
      // Permission is requested only after the explicit start gesture, never on app boot.
      const permitted = await this.options.requestMicrophone();
      if (!this.current(live)) { if (this.live === live) this.stop('context-changed'); return this.state; }
      if (!permitted) return this.stop('permission-denied');
      await live.transport.start(live.abort.signal, () => { if (this.live === live) this.stop('disconnected'); });
      if (!this.current(live)) { if (this.live === live) this.stop('context-changed'); return this.state; }
      // Renderer calls ready only once its actual capture stream is running.
      return this.state;
    } catch {
      return this.live === live ? this.stop('transport-unavailable') : this.state;
    }
  }
  ready(token: VoiceToken): VoiceState {
    const live = this.live;
    if (!live || !sameVoiceToken(live.token, token)) return this.state;
    if (!this.current(live)) return this.stop('context-changed');
    return this.publish({ phase: 'listening', token: live.token });
  }
  stop(reason: VoiceReason = 'stopped'): VoiceState {
    const old = this.live;
    // Invalidate first, synchronously. Abort handlers may themselves invoke callbacks.
    this.live = null;
    ++this.epoch;
    const state = this.publish({ phase: reason === 'stopped' ? 'idle' : 'unavailable', token: null, ...(reason === 'stopped' ? {} : { reason }) });
    old?.abort.abort();
    old?.transport.close();
    return state;
  }
  async transcribe(audio: VoiceAudio): Promise<VoiceReceipt> {
    const live = this.live;
    if (!live || !sameVoiceToken(live.token, audio.token)) return { status: 'stopped' };
    if (!this.current(live)) { this.stop('context-changed'); return { status: 'context-changed' }; }
    if (live.busy) return { status: 'busy' };
    if (audio.voicedMs < 240) return { status: 'silence' };
    if (this.state.phase !== 'listening') return { status: 'busy' };
    if (audio.durationMs > 30_000 || audio.bytes.byteLength > 2_000_000) { this.stop('too-long'); return { status: 'stopped' }; }
    const operationId = audio.turn?.operationId ?? randomUUID();
    if (live.seen.has(operationId)) return { status: "busy", operationId };
    live.seen.add(operationId);
    if (live.seen.size > 256) { this.stop("too-long"); return { status: "stopped" }; }
    live.busy = true;
    this.publish({ phase: 'transcribing', token: live.token });
    try {
      const text = (await live.transport.transcribe(audio, live.abort.signal)).trim();
      if (!this.current(live)) {
        if (this.live === live) { this.stop('context-changed'); return { status: 'context-changed', operationId }; }
        return { status: 'stopped', operationId };
      }
      if (!text) return { status: 'silence', operationId };
      if (text.length > 2000) { this.stop('too-long'); return { status: 'stopped', operationId }; }
      this.options.event({ type: 'transcript', token: live.token, operationId, text });
      // Revalidate after event callbacks, immediately before the only effect dispatch.
      if (!this.current(live)) {
        if (this.live === live) this.stop('context-changed');
        return { status: 'stopped', operationId };
      }
      this.publish({ phase: 'working', token: live.token });
      const result = await this.options.dispatch(text, audio.turn?.context ?? {}, { signal: live.abort.signal, current: () => this.current(live), operationId });
      if (!this.current(live)) { if (this.live === live) this.stop('context-changed'); return { status: 'stopped', operationId }; }
      this.options.event({ type: 'result', token: live.token, operationId, text, result });
      return { status: 'dispatched', operationId };
    } catch {
      if (this.live === live) this.stop('transport-unavailable');
      return { status: 'stopped', operationId };
    } finally {
      live.busy = false;
      if (this.current(live)) this.publish({ phase: 'listening', token: live.token });
    }
  }
}
