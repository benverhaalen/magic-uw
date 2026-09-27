import { sameVoiceToken, type VoiceBridge, type VoiceEvent, type VoiceReason, type VoiceState, type VoiceToken, type VoiceTurn } from '../../voice/types';

export interface MicrophoneView extends VoiceState { levels: number[] }
export interface MicrophoneEnvironment {
  getUserMedia(): Promise<MediaStream>;
  audioContext(): AudioContext;
  recorder(stream: MediaStream): MediaRecorder;
  frame(callback: FrameRequestCallback): number;
  cancelFrame(id: number): void;
  now(): number;
}
const browserEnvironment: MicrophoneEnvironment = {
  getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }),
  audioContext: () => new AudioContext(),
  recorder: stream => new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32_000 }),
  frame: callback => requestAnimationFrame(callback), cancelFrame: id => cancelAnimationFrame(id), now: () => performance.now(),
};

/** Real input capture with bounded utterances. There is no synthetic level source. */
export class VoiceMicrophone {
  private generation = 0;
  private token: VoiceToken | null = null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private recorder: MediaRecorder | null = null;
  private frameId: number | null = null;
  private unsub: (() => void) | null = null;
  private view: MicrophoneView = { phase: 'idle', token: null, levels: [] };
  constructor(private readonly bridge: VoiceBridge, private readonly changed: (view: MicrophoneView) => void,
    private readonly event: (event: VoiceEvent) => void = () => {}, private readonly env = browserEnvironment, private readonly turn: () => VoiceTurn | undefined = () => undefined) {
    this.unsub = bridge.onEvent(event => {
      if (event.type === 'state') {
        if (!event.state.token) { this.cleanup(); this.publish({ ...event.state, levels: [] }); }
        // Start establishes ownership from its return value; old sessions cannot attach themselves.
        else if (sameVoiceToken(this.token, event.state.token)) this.publish({ ...event.state, levels: this.view.levels });
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
      const stream = await this.env.getUserMedia();
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      stream.getTracks().forEach(track => track.addEventListener('ended', () => { if (generation === this.generation) void this.stop('device-unavailable'); }));
      const context = this.env.audioContext(); this.context = context;
      const analyser = context.createAnalyser(); analyser.fftSize = 1024;
      this.source = context.createMediaStreamSource(stream); this.source.connect(analyser);
      await context.resume();
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
    const token = this.token, chunks: Blob[] = [];
    let sent = false;
    let turn: VoiceTurn | undefined;
    const recorder = this.env.recorder(this.stream); this.recorder = recorder;
    let started = this.env.now(), lastFrame = started, lastSpeech = started, voicedMs = 0, heardSpeech = false, byteSize = 0;
    const samples = new Float32Array(analyser.fftSize);
    recorder.addEventListener('dataavailable', event => { if (generation !== this.generation || !sameVoiceToken(token, this.token) || this.recorder !== recorder) return; if (event.data.size) { chunks.push(event.data); byteSize += event.data.size; if (byteSize > 2_000_000) void this.stop('too-long'); } });
    recorder.addEventListener('error', () => { if (!sent && this.recorder === recorder && sameVoiceToken(token, this.token) && generation === this.generation) void this.stop('disconnected'); });
    recorder.addEventListener('stop', () => {
      if (sent || generation !== this.generation || !sameVoiceToken(token, this.token) || this.recorder !== recorder) return;
      sent = true;
      if (this.frameId !== null) this.env.cancelFrame(this.frameId); this.frameId = null;
      const durationMs = this.env.now() - started;
      if (!heardSpeech || voicedMs < 240) { this.captureTurn(generation, analyser); return; }
      this.publish({ phase: 'processing', token, levels: [] });
      void new Blob(chunks, { type: 'audio/webm' }).arrayBuffer().then(bytes => {
        if (generation !== this.generation) return null;
        return this.bridge.transcribe({ token, turn, bytes, mimeType: 'audio/webm', durationMs, voicedMs });
      }).then(() => {
        if (generation === this.generation && sameVoiceToken(token, this.token)) {
          this.publish({ phase: 'listening', token, levels: [] }); this.captureTurn(generation, analyser);
        }
      }).catch(() => { if (generation === this.generation) void this.stop('disconnected'); });
    });
    recorder.start(250);
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
  async stop(reason: VoiceReason = 'stopped'): Promise<void> {
    this.cleanup();
    this.publish({ phase: reason === 'stopped' ? 'idle' : 'unavailable', token: null, levels: [], ...(reason === 'stopped' ? {} : { reason }) });
    try { await this.bridge.stop(reason); } catch { /* local tracks are already stopped */ }
  }
  private cleanup(): void {
    ++this.generation; this.token = null;
    if (this.frameId !== null) this.env.cancelFrame(this.frameId); this.frameId = null;
    const recorder = this.recorder; this.recorder = null;
    if (recorder?.state !== 'inactive') { try { recorder?.stop(); } catch { /* already ended */ } }
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    this.source?.disconnect(); this.source = null;
    const context = this.context; this.context = null;
    void context?.close().catch(() => {});
  }
  dispose(): void { this.unsub?.(); this.unsub = null; void this.stop(); }
}
