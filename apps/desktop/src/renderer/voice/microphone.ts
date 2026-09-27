import { MicPcmTap } from './pcm-tap';
import { sameVoiceToken, type VoiceAudio, type VoiceBridge, type VoiceEvent, type VoiceReason, type VoiceState, type VoiceToken, type VoiceTurn } from '../../voice/types';

export interface MicrophoneView extends VoiceState { levels: number[]; capturing?: boolean; queuedTurns?: number; capturePaused?: boolean }
export interface MicrophoneEnvironment {
  getUserMedia(): Promise<MediaStream>;
  audioContext(): AudioContext;
  recorder(stream: MediaStream): MediaRecorder;
  frame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
  now(): number;
  /** owner: voice-plan: a PCM tap on the one already-permitted stream (never a second microphone). */
  pcmTap?(context: AudioContext, source: MediaStreamAudioSourceNode, frame: (pcm: Int16Array) => void): { finish(): void; close(): void };
}
const browserEnvironment: MicrophoneEnvironment = {
  getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }),
  audioContext: () => new AudioContext(),
  recorder: stream => new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32_000 }),
  frame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id), now: () => performance.now(),
  pcmTap: (context, source, frame) => new MicPcmTap(context, source, frame),
};
/** owner: voice-plan. How long Listening waits for the first utterance's helper, so the capability check sees it. */
const STREAM_READY_WAIT_MS = 1_500;

/** Real input capture with bounded utterances. There is no synthetic level source. */
export class VoiceMicrophone {
  private generation = 0;
  private token: VoiceToken | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private recorder: MediaRecorder | null = null;
  private frameId: number | null = null;
  private analyser: AnalyserNode | null = null;
  private queue: { audio: VoiceAudio; streamed: boolean }[] = [];
  /** owner: voice-plan: the first utterance's helper, begun right after the click in parallel with getUserMedia. */
  private early: Promise<'ready' | 'fallback'> | null = null;
  private tap: { finish(): void; close(): void } | null = null;
  private sending = false;
  private readonly maxOutstandingTurns = 3;
  private unsub: (() => void) | null = null;
  private view: MicrophoneView = { phase: 'idle', token: null, levels: [] };
  constructor(private readonly bridge: VoiceBridge, private readonly changed: (view: MicrophoneView) => void,
    private readonly event: (event: VoiceEvent) => void = () => {}, private readonly env = browserEnvironment, private readonly turn: () => VoiceTurn | undefined = () => undefined) {
    this.unsub = bridge.onEvent(event => {
      if (event.type === 'state') {
        if (!event.state.token) { this.cleanup(); this.publish({ ...event.state, levels: [] }); }
        // Start establishes ownership from its return value; old sessions cannot attach themselves.
        else if (sameVoiceToken(this.token, event.state.token)) this.publish({ ...event.state, levels: this.view.levels, capturing: this.view.capturing, queuedTurns: this.view.queuedTurns, capturePaused: this.view.capturePaused });
      } else if (sameVoiceToken(this.token, event.token)) this.event(event);
    });
  }
  private publish(view: MicrophoneView): void { this.view = view; this.changed(view); }
  async start(): Promise<void> {
    if (this.view.phase === 'starting' || this.token) return;
    const generation = ++this.generation;
    this.publish({ phase: 'starting', token: null, levels: [] });
    try {
      const state = await this.bridge.start();
      if (generation !== this.generation) return;
      if (!state.token || state.phase === 'unavailable' || state.phase === 'idle') { this.publish({ ...state, levels: [] }); return; }
      this.token = state.token;
      const streaming = this.streams();
      this.early = streaming ? streaming.begin(state.token).catch(() => 'fallback' as const) : null;
      const stream = await this.env.getUserMedia();
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      stream.getTracks().forEach(track => track.addEventListener('ended', () => { if (generation === this.generation) void this.stop('device-unavailable'); }));
      const context = this.env.audioContext(); this.context = context;
      const analyser = context.createAnalyser(); analyser.fftSize = 1024; this.analyser = analyser;
      this.source = context.createMediaStreamSource(stream); this.source.connect(analyser);
      await context.resume();
      if (generation !== this.generation) return;
      if (this.early) { let timer: ReturnType<typeof setTimeout> | undefined; await Promise.race([this.early, new Promise(resolve => { timer = setTimeout(resolve, STREAM_READY_WAIT_MS); })]); clearTimeout(timer); }
      if (generation !== this.generation) return;
      const ready = await this.bridge.ready(state.token);
      if (generation !== this.generation) return;
      if (!sameVoiceToken(ready.token, this.token)) { this.cleanup(); return; }
      this.publish({ ...ready, levels: [] });
      this.captureTurn(generation, analyser);
    } catch (error) {
      if (generation !== this.generation) return;
      const reason = error instanceof DOMException && error.name === 'NotAllowedError' ? 'permission-denied' : 'device-unavailable';
      await this.stop(reason);
    }
  }
  private captureTurn(generation: number, analyser: AnalyserNode): void {
    if (!this.stream || !this.token || generation !== this.generation) return;
    if (this.queue.length + Number(this.sending) >= this.maxOutstandingTurns) {
      this.publish({ ...this.view, capturing: false, capturePaused: true, levels: [], queuedTurns: this.queue.length });
      return;
    }
    const token = this.token, chunks: Blob[] = [];
    let sent = false;
    let turn: VoiceTurn | undefined;
    const recorder = this.env.recorder(this.stream); this.recorder = recorder;
    let started = this.env.now(), lastFrame = started, lastSpeech = started, voicedMs = 0, heardSpeech = false, byteSize = 0;
    // owner: voice-plan. On-device streaming for this utterance: frames from the same stream, the turn attached
    // once on first speech. A `false` push or a fallback begin sends this utterance to local Whisper instead.
    const streaming = this.streams();
    const live = { on: !!streaming && !!this.context && !!this.source, turnSent: false };
    if (streaming && live.on) {
      const begun = this.early ?? streaming.begin(token).catch(() => 'fallback' as const); this.early = null;
      const tap = this.env.pcmTap!(this.context!, this.source!, pcm => {
        if (!live.on || generation !== this.generation || !sameVoiceToken(token, this.token)) return;
        const attach = heardSpeech && turn && !live.turnSent ? turn : undefined;
        if (attach) live.turnSent = true;
        void streaming.push(token, pcm, attach).then(ok => { if (!ok) { live.on = false; tap.close(); } }, () => { live.on = false; tap.close(); });
      });
      this.tap?.close(); this.tap = tap;
      void begun.then(result => { if (result !== 'ready') { live.on = false; tap.close(); } });
    }
    const samples = new Float32Array(analyser.fftSize);
    recorder.addEventListener('dataavailable', event => { if (generation !== this.generation || !sameVoiceToken(token, this.token) || this.recorder !== recorder) return; if (event.data.size) { chunks.push(event.data); byteSize += event.data.size; if (byteSize > 2_000_000) void this.stop('too-long'); } });
    recorder.addEventListener('error', () => { if (!sent && this.recorder === recorder && sameVoiceToken(token, this.token) && generation === this.generation) void this.stop('disconnected'); });
    recorder.addEventListener('stop', () => {
      if (sent || generation !== this.generation || !sameVoiceToken(token, this.token) || this.recorder !== recorder) return;
      sent = true;
      if (this.frameId !== null) this.env.cancelFrame(this.frameId); this.frameId = null;
      const durationMs = this.env.now() - started;
      if (!heardSpeech || voicedMs < 240) { this.tap?.close(); this.captureTurn(generation, analyser); return; }
      this.tap?.finish(); // the last short frame, in order before the host is asked for the final text
      const streamed = live.on && live.turnSent;
      this.publish({ ...this.view, capturing: false, levels: [] });
      void new Blob(chunks, { type: 'audio/webm' }).arrayBuffer().then(bytes => {
        if (generation !== this.generation || !sameVoiceToken(token, this.token)) return;
        this.queue.push({ audio: { token, turn, bytes, mimeType: 'audio/webm', durationMs, voicedMs }, streamed });
        this.publish({ ...this.view, queuedTurns: this.queue.length });
        this.pump(generation);
        this.captureTurn(generation, analyser);
      }).catch(() => { if (generation === this.generation) void this.stop('disconnected'); });
    });
    recorder.start(250);
    this.publish({ ...this.view, capturing: true, capturePaused: false, queuedTurns: this.queue.length });
    const sample = () => {
      if (generation !== this.generation || recorder.state !== 'recording') return;
      const now = this.env.now();
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      const elapsed = Math.min(100, Math.max(0, now - lastFrame)); lastFrame = now;
      if (rms > 0.012) { if (!heardSpeech) turn = this.turn(); heardSpeech = true; voicedMs += elapsed; lastSpeech = now; }
      this.publish({ ...this.view, levels: [...this.view.levels.slice(-4), Math.min(1, rms * 8)] });
      // Silence rotates empty buffers without ASR. Never execute a truncated 30-second turn.
      if (now - started >= 29_500 && heardSpeech) { void this.stop('too-long'); return; }
      if ((!heardSpeech && now - started >= 10_000) || (heardSpeech && now - lastSpeech >= 1_800)) { recorder.stop(); return; }
      this.frameId = this.env.frame(sample);
    };
    this.frameId = this.env.frame(sample);
  }
  private pump(generation: number): void {
    if (this.sending || generation !== this.generation || !this.token) return;
    const next = this.queue.shift();
    if (!next) return;
    this.sending = true;
    this.publish({ ...this.view, queuedTurns: this.queue.length });
    // owner: voice-plan: a streamed utterance's final text comes from its helper (Whisper if it has none).
    const finished = next.streamed && this.bridge.endStreamingTurn ? this.bridge.endStreamingTurn(next.audio) : this.bridge.transcribe(next.audio);
    void finished.then(() => {
      if (generation !== this.generation) return;
      this.sending = false;
      this.publish({ ...this.view, queuedTurns: this.queue.length });
      this.pump(generation);
      if (this.view.capturePaused && this.analyser) this.captureTurn(generation, this.analyser);
    }).catch(() => { if (generation === this.generation) void this.stop('disconnected'); });
  }
  async stop(reason: VoiceReason = 'stopped'): Promise<void> {
    this.cleanup();
    this.publish({ phase: reason === 'stopped' ? 'idle' : 'unavailable', token: null, levels: [], ...(reason === 'stopped' ? {} : { reason }) });
    try { await this.bridge.stop(reason); } catch { /* local tracks are already stopped */ }
  }
  private cleanup(): void {
    ++this.generation; this.token = null; this.queue = []; this.sending = false; this.analyser = null;
    this.early = null; this.tap?.close(); this.tap = null; // owner: voice-plan
    if (this.frameId !== null) this.env.cancelFrame(this.frameId); this.frameId = null;
    const recorder = this.recorder; this.recorder = null;
    if (recorder?.state !== 'inactive') { try { recorder?.stop(); } catch { /* already ended */ } }
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    this.source?.disconnect(); this.source = null;
    const context = this.context; this.context = null;
    void context?.close().catch(() => {});
  }
  /** owner: voice-plan: the bridge's streaming calls, when both the host and a PCM tap are available. */
  private streams(): { begin(token: VoiceToken): Promise<'ready' | 'fallback'>; push(token: VoiceToken, frame: Int16Array, turn?: VoiceTurn): Promise<boolean> } | null {
    const { beginStreamingTurn, pushStreamingPCM, endStreamingTurn } = this.bridge;
    if (!beginStreamingTurn || !pushStreamingPCM || !endStreamingTurn || !this.env.pcmTap) return null;
    return { begin: token => beginStreamingTurn.call(this.bridge, token), push: (token, frame, turn) => pushStreamingPCM.call(this.bridge, token, frame, turn) };
  }
  dispose(): void { this.unsub?.(); this.unsub = null; void this.stop(); }
}
