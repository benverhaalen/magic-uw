import { randomUUID } from 'node:crypto';
import type { IntentCommandResult } from '@magic/contracts';
import type { VoiceRequestContext } from './types';
export interface VoiceDispatch { (text: string, context: VoiceRequestContext, operation: {signal: AbortSignal; current(): boolean; operationId: string}): Promise<IntentCommandResult> }
import { sameVoiceToken, type VoiceAudio, type VoiceContext, type VoiceEvent, type VoiceReason, type VoiceReceipt, type VoiceState, type VoiceToken, type VoiceTurn } from './types';
import type { StreamingSTTEvent } from './native-streaming-adapter';

export interface VoiceTransport {
  start(signal: AbortSignal, disconnected?: () => void): Promise<void>;
  transcribe(audio: VoiceAudio, signal: AbortSignal): Promise<string>;
  close(): void;
}
/** owner: voice-plan. One utterance's on-device streaming recognizer (the Apple helper's `NativeStreamingSTT`). */
export interface StreamingRecognizer {
  start(session: string, locale?: string, signal?: AbortSignal): Promise<'speech-transcriber' | 'local-whisper'>;
  pushPCM(frame: Int16Array): boolean;
  end(): void;
  stop(): void;
}
/** One utterance's helper. It is matched to its audio by the turn's operationId, attached on first speech. */
interface Stream { stt: StreamingRecognizer; mode: 'starting' | 'ready' | 'fallback'; turn?: VoiceTurn; latest: string; finalized: boolean; inputEnded: boolean; ended: Promise<string | null>; settle(text: string | null): void }
interface Live { token: VoiceToken; context: VoiceContext; abort: AbortController; transport: VoiceTransport; busy: boolean; seen: Set<string>; /** owner: voice-plan */ whisper: Promise<boolean> | null; streams: Stream[]; capturing: Stream | null; streaming: 'ready' | 'fallback' | null }
const MAX_STREAMS = 4; // one capturing plus the renderer's three outstanding turns

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
    /**
     * owner: voice-plan. The on-device streaming recognizer, when its helper is installed. One is started per
     * utterance, only after the Start click; partials are display-only and only its finalized text dispatches.
     */
    streaming?(onEvent: (event: StreamingSTTEvent) => void): StreamingRecognizer | null;
    /** How long a finished utterance waits for the helper's finalized text before local Whisper transcribes it. */
    streamEndTimeoutMs?: number;
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
    const live: Live = { token: { sessionId: randomUUID(), epoch: ++this.epoch }, context: { ...context }, abort: new AbortController(), transport: this.options.transport(), busy: false, seen: new Set(), whisper: null, streams: [], capturing: null, streaming: null };
    this.live = live;
    this.publish({ phase: 'starting', token: live.token });
    try {
      // Permission is requested only after the explicit start gesture, never on app boot.
      const permitted = await this.options.requestMicrophone();
      if (!this.current(live)) { if (this.live === live) this.stop('context-changed'); return this.state; }
      if (!permitted) return this.stop('permission-denied');
      const whisper = live.transport.start(live.abort.signal, () => { if (this.live === live) this.stop('disconnected'); });
      if (this.options.streaming) {
        // owner: voice-plan. With the streaming helper installed, local Whisper (the fallback) loads in the
        // background, so its cold start no longer delays Listening; a fallback turn waits for it.
        live.whisper = whisper.then(() => true, () => false);
        return this.state;
      }
      await whisper;
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
    // owner: voice-plan: every helper dies with the session; its late partial/final events are already fenced.
    for (const stream of old?.streams ?? []) { stream.finalized = true; stream.stt.stop(); stream.settle(null); }
    old?.abort.abort();
    old?.transport.close();
    return state;
  }
  /** owner: voice-plan. True only while this session's latest utterance helper actually reported ready. */
  streamingReady(): boolean { return !!this.live && this.current(this.live) && this.live.streaming === 'ready'; }
  /**
   * owner: voice-plan. Starts the on-device recognizer for the next utterance (after the Start click; the
   * renderer's one microphone stream feeds it). An earlier helper that heard no speech is ended; one that
   * did has its input closed, so its finalized text is ready when that utterance is transcribed.
   */
  async beginStream(token: VoiceToken): Promise<'ready' | 'fallback'> {
    const live = this.live;
    if (!live || !sameVoiceToken(live.token, token) || !this.current(live) || !this.options.streaming) return 'fallback';
    for (const old of [...live.streams]) if (!old.turn || old.mode === 'fallback') this.dropStream(live, old); else this.endInput(live, old);
    while (live.streams.length >= MAX_STREAMS) this.dropStream(live, live.streams[0]!);
    let settle!: (text: string | null) => void;
    const ended = new Promise<string | null>(resolve => { settle = resolve; });
    const stream = { mode: 'starting', latest: '', finalized: false, inputEnded: false, ended, settle } as Stream;
    const stt = this.options.streaming(event => this.streamEvent(live, stream, event));
    if (!stt) return 'fallback';
    stream.stt = stt;
    live.streams.push(stream); live.capturing = stream;
    const backend = await stt.start(randomUUID(), 'en_US', live.abort.signal).catch(() => 'local-whisper' as const);
    if (this.live !== live || !live.streams.includes(stream)) return 'fallback';
    if (backend === 'speech-transcriber' && stream.mode !== 'fallback') {
      stream.mode = 'ready';
      if (live.capturing === stream) live.streaming = 'ready';
      return 'ready';
    }
    this.fallBack(live, stream);
    return 'fallback';
  }
  /**
   * owner: voice-plan. One mono 16 kHz Int16 frame for the capturing utterance. The turn is attached once, on
   * first speech; partials wait for it. False means this utterance falls back to local Whisper.
   */
  pushStream(token: VoiceToken, frame: Int16Array, turn?: VoiceTurn): boolean {
    const live = this.live;
    if (!live || !sameVoiceToken(live.token, token) || !this.current(live)) return false;
    const stream = live.capturing;
    if (!stream || stream.mode === 'fallback' || stream.inputEnded) return false;
    if (turn && !stream.turn && !live.streams.some(s => s.turn?.operationId === turn.operationId)) {
      stream.turn = turn;
      this.partial(live, stream);
    }
    return stream.stt.pushPCM(frame);
  }
  /**
   * owner: voice-plan. The utterance is complete: its helper's finalized text is the transcript and the only
   * text dispatched. Without it (no helper, fallback, empty or late), local Whisper transcribes the same audio.
   */
  endStream(audio: VoiceAudio): Promise<VoiceReceipt> {
    const live = this.live;
    const stream = live && audio.turn ? live.streams.find(s => s.turn?.operationId === audio.turn!.operationId) : undefined;
    const release = () => { if (live && stream) this.dropStream(live, stream); };
    return this.finish(audio, async current => {
      if (stream && stream.mode !== 'fallback') {
        this.endInput(current, stream);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const text = await Promise.race([stream.ended, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), this.options.streamEndTimeoutMs ?? 5_000); })]);
        clearTimeout(timer);
        stream.finalized = true;
        if (text?.trim()) { release(); return { text, transcription: 'speech-transcriber' }; }
      }
      release();
      return this.whisper(current, audio);
    }, release);
  }
  async transcribe(audio: VoiceAudio): Promise<VoiceReceipt> {
    // An utterance the renderer sends whole (its stream fell back) ends any helper still holding its turn.
    const live = this.live, stream = live && audio.turn ? live.streams.find(s => s.turn?.operationId === audio.turn!.operationId) : undefined;
    if (live && stream) this.dropStream(live, stream);
    return this.finish(audio, current => this.whisper(current, audio));
  }
  private async whisper(live: Live, audio: VoiceAudio): Promise<{ text: string; transcription: 'local-whisper' }> {
    if (live.whisper && !(await live.whisper)) throw new Error('local transcription unavailable');
    return { text: await live.transport.transcribe(audio, live.abort.signal), transcription: 'local-whisper' };
  }
  private streamEvent(live: Live, stream: Stream, event: StreamingSTTEvent): void {
    if (this.live !== live || !live.streams.includes(stream)) return;
    if (event.type === 'partial' || event.type === 'final') {
      // The complete current hypothesis: finalized segments plus the volatile tail, which the next one replaces.
      stream.latest = `${event.finalText}${event.type === 'partial' ? event.text : ''}`.trim().slice(-2000);
      this.partial(live, stream);
    } else if (event.type === 'ended') { stream.finalized = true; stream.settle(event.text); }
    else if (event.type === 'fallback') this.fallBack(live, stream);
    else if (event.type === 'stopped') stream.settle(null);
  }
  /** Display only: never history, never dispatch. Suppressed once the utterance is final or the session changed. */
  private partial(live: Live, stream: Stream): void {
    if (!stream.turn || !stream.latest || stream.finalized || !this.current(live)) return;
    this.options.event({ type: 'transcript-partial', token: live.token, operationId: stream.turn.operationId, text: stream.latest });
  }
  private fallBack(live: Live, stream: Stream): void {
    stream.mode = 'fallback';
    if (live.capturing === stream) live.streaming = 'fallback';
    stream.settle(null);
  }
  private endInput(live: Live, stream: Stream): void {
    if (live.capturing === stream) live.capturing = null;
    if (stream.inputEnded) return;
    stream.inputEnded = true;
    if (stream.mode !== 'fallback') stream.stt.end();
  }
  private dropStream(live: Live, stream: Stream): void {
    live.streams = live.streams.filter(s => s !== stream);
    if (live.capturing === stream) live.capturing = null;
    stream.finalized = true;
    stream.stt.stop();
    stream.settle(null);
  }
  private async finish(audio: VoiceAudio, recognize: (live: Live) => Promise<{ text: string; transcription: 'speech-transcriber' | 'local-whisper' }>, early: () => void = () => {}): Promise<VoiceReceipt> {
    const live = this.live;
    const refuse = (receipt: VoiceReceipt) => { early(); return receipt; };
    if (!live || !sameVoiceToken(live.token, audio.token)) return refuse({ status: 'stopped' });
    if (!this.current(live)) { this.stop('context-changed'); return refuse({ status: 'context-changed' }); }
    if (live.busy) return refuse({ status: 'busy' });
    if (audio.voicedMs < 240) return refuse({ status: 'silence' });
    if (this.state.phase !== 'listening') return refuse({ status: 'busy' });
    if (audio.durationMs > 30_000 || audio.bytes.byteLength > 2_000_000) { this.stop('too-long'); return refuse({ status: 'stopped' }); }
    const operationId = audio.turn?.operationId ?? randomUUID();
    if (live.seen.has(operationId)) return refuse({ status: "busy", operationId });
    live.seen.add(operationId);
    if (live.seen.size > 256) { this.stop("too-long"); return refuse({ status: "stopped" }); }
    live.busy = true;
    this.publish({ phase: 'transcribing', token: live.token });
    try {
      const recognized = await recognize(live);
      const text = recognized.text.trim(), transcription = recognized.transcription;
      if (!this.current(live)) {
        if (this.live === live) { this.stop('context-changed'); return { status: 'context-changed', operationId }; }
        return { status: 'stopped', operationId };
      }
      if (!text) return { status: 'silence', operationId, transcription };
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
      return { status: 'dispatched', operationId, transcription };
    } catch {
      if (this.live === live) this.stop('transport-unavailable');
      return { status: 'stopped', operationId };
    } finally {
      live.busy = false;
      if (this.current(live)) this.publish({ phase: 'listening', token: live.token });
    }
  }
}
