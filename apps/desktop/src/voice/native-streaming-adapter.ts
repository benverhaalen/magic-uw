import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** Additive boundary for the mic owner. PCM is mono 16 kHz signed 16-bit LE, at most 200 ms per push. */
export type StreamingSTTEvent =
  | { type: 'ready'; session: string; backend: 'speech-transcriber'; locale: string; sampleRate: 16000; channels: 1; sampleFormat: 's16le'; maxFrameSamples: 3200 }
  | { type: 'partial' | 'final'; session: string; text: string; display: string; finalText: string; isFinal: boolean }
  | { type: 'ended'; session: string; text: string }
  | { type: 'fallback'; session: string; backend: 'local-whisper'; reason: string }
  | { type: 'stopped'; session: string };

type HelperEvent = StreamingSTTEvent | { type: 'ack'; session: string; seq: number } | { type: 'protocol-error' };
type Frame = { type: 'audio'; session: string; seq: number; pcm: string };
const MAX_PENDING_FRAMES = 4; // one in flight plus at most three queued (800 ms total)
const MAX_OUTPUT_LINE = 16_000;

/** One helper per user-started session. No microphone, permission, network, or asset download is done here. */
export class NativeStreamingSTT {
  private child: ChildProcessWithoutNullStreams | null = null;
  private session: string | null = null;
  private queue: Frame[] = [];
  private inFlight: Frame | null = null;
  private nextSeq = 0;
  private endRequested = false;
  private endedInput = false;
  private closed = true;
  private startResolve: ((backend: 'speech-transcriber' | 'local-whisper') => void) | null = null;
  private startReject: ((error: Error) => void) | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private output = '';
  private abortSignal: AbortSignal | null = null;
  private abortHandler = () => this.stop();

  constructor(private readonly executable: string, private readonly onEvent: (event: StreamingSTTEvent) => void) {}

  start(session: string, locale = 'en_US', signal?: AbortSignal): Promise<'speech-transcriber' | 'local-whisper'> {
    if (!this.closed || !session || session.length > 128 || signal?.aborted) return Promise.reject(new Error('invalid-start'));
    this.closed = false; this.session = session; this.nextSeq = 0; this.endRequested = false; this.endedInput = false;
    this.queue = []; this.inFlight = null; this.output = '';
    const child = spawn(this.executable, [], { stdio: 'pipe', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    this.child = child;
    this.abortSignal = signal ?? null;
    signal?.addEventListener('abort', this.abortHandler, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.readOutput(chunk));
    child.stderr.resume(); // Never log transcript or helper internals.
    child.stdin.on('error', () => this.fail('helper-disconnected'));
    child.once('error', () => this.fail('helper-disconnected'));
    child.once('exit', () => this.fail('helper-disconnected'));
    return new Promise((resolve, reject) => {
      this.startResolve = resolve; this.startReject = reject;
      this.startTimer = setTimeout(() => this.fail('startup-timeout'), 10_000);
      this.write({ type: 'start', session, locale });
    });
  }

  /** false means capture must stop this native path and switch explicitly to whole-turn local Whisper. */
  pushPCM(frame: Int16Array): boolean {
    if (this.closed || !this.session || this.endedInput || frame.length < 1 || frame.length > 3200 || this.queue.length + Number(!!this.inFlight) >= MAX_PENDING_FRAMES) {
      if (!this.closed) this.fail('frame-overrun');
      return false;
    }
    // Copy now: an AudioWorklet may reuse its transfer buffer.
    const bytes = Buffer.allocUnsafe(frame.length * 2);
    for (let i = 0; i < frame.length; i++) bytes.writeInt16LE(frame[i]!, i * 2);
    this.queue.push({ type: 'audio', session: this.session, seq: this.nextSeq++, pcm: bytes.toString('base64') });
    this.pump();
    return true;
  }

  /** Drain accepted frames and publish an ended event containing only finalized text. */
  end(): void {
    if (this.closed || !this.session || this.endedInput) return;
    this.endedInput = true; this.endRequested = true; this.pump();
  }

  /** Synchronous event fence and process kill. No partial/final is delivered after this returns. */
  stop(): void {
    if (this.closed) return;
    const session = this.session;
    this.closed = true; this.session = null; this.queue = []; this.inFlight = null;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    this.abortSignal?.removeEventListener('abort', this.abortHandler);
    this.abortSignal = null;
    const child = this.child; this.child = null;
    child?.kill('SIGKILL');
    this.startReject?.(new Error('stopped')); this.startResolve = null; this.startReject = null;
    if (session) this.onEvent({ type: 'stopped', session });
  }

  private write(message: object): void {
    if (!this.closed && this.child && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private pump(): void {
    if (this.closed || !this.session || this.inFlight) return;
    const frame = this.queue.shift();
    if (frame) { this.inFlight = frame; this.write(frame); return; }
    if (this.endRequested) { this.endRequested = false; this.write({ type: 'end', session: this.session }); }
  }

  private readOutput(chunk: string): void {
    if (this.closed) return;
    this.output += chunk;
    if (this.output.length > MAX_OUTPUT_LINE * 2) { this.fail('invalid-output'); return; }
    let newline: number;
    while (!this.closed && (newline = this.output.indexOf('\n')) >= 0) {
      const line = this.output.slice(0, newline); this.output = this.output.slice(newline + 1);
      if (line.length > MAX_OUTPUT_LINE) { this.fail('invalid-output'); return; }
      let event: HelperEvent;
      try { event = JSON.parse(line) as HelperEvent; } catch { this.fail('invalid-output'); return; }
      if (!event || typeof event !== 'object' || !('session' in event) || event.session !== this.session) {
        this.fail('invalid-output'); return;
      }
      if (event.type === 'ack') {
        if (!this.inFlight || event.seq !== this.inFlight.seq) { this.fail('invalid-ack'); return; }
        this.inFlight = null; this.pump(); continue;
      }
      if (event.type === 'ready') {
        if (!this.startResolve || event.backend !== 'speech-transcriber' || event.sampleRate !== 16000 || event.maxFrameSamples !== 3200) { this.fail('invalid-ready'); return; }
        this.resolveStart('speech-transcriber'); this.onEvent(event); continue;
      }
      if (event.type === 'fallback') {
        if (event.backend !== 'local-whisper') { this.fail('invalid-fallback'); return; }
        this.resolveStart('local-whisper'); this.onEvent(event); this.stop(); continue;
      }
      if (event.type === 'partial' || event.type === 'final') {
        if (typeof event.text !== 'string' || typeof event.display !== 'string' || typeof event.finalText !== 'string' || event.display.length > 100 || event.finalText.length > 10_000 || event.isFinal !== (event.type === 'final')) { this.fail('invalid-transcript'); return; }
        this.onEvent(event); continue;
      }
      if (event.type === 'ended') {
        if (typeof event.text !== 'string' || event.text.length > 10_000) { this.fail('invalid-transcript'); return; }
        this.onEvent(event); this.stop(); continue;
      }
      this.fail('invalid-output'); return;
    }
  }

  private resolveStart(backend: 'speech-transcriber' | 'local-whisper'): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    this.startResolve?.(backend); this.startResolve = null; this.startReject = null;
  }

  private fail(reason: string): void {
    if (this.closed) return;
    const session = this.session!;
    this.resolveStart('local-whisper');
    this.onEvent({ type: 'fallback', session, backend: 'local-whisper', reason });
    this.stop();
  }
}
