// owner: voice-plan. On-device streaming speech through the host session, the typed bridge and the renderer
// microphone: live partial replacement, final-only dispatch, Whisper fallback, stale tokens and Stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { VoiceSession, type StreamingRecognizer, type VoiceTransport } from '../apps/desktop/src/voice/session';
import { createVoiceBridge } from '../apps/desktop/src/voice/bridge';
import { isPcmFrame, isVoiceTurn } from '../apps/desktop/src/voice/policy';
import { NativeStreamingSTT, type StreamingSTTEvent } from '../apps/desktop/src/voice/native-streaming-adapter';
import { VoiceMicrophone, type MicrophoneEnvironment } from '../apps/desktop/src/renderer/voice/microphone';
import type { VoiceAudio, VoiceBridge, VoiceEvent, VoiceReceipt, VoiceToken, VoiceTurn } from '../apps/desktop/src/voice/types';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const frame = () => new Int16Array(3200);

class FakeHelper implements StreamingRecognizer {
  started: string[] = []; frames = 0; ended = 0; stopped = 0;
  constructor(readonly emit: (event: StreamingSTTEvent) => void, private readonly backend: 'speech-transcriber' | 'local-whisper', private readonly accept = () => true) {}
  session = '';
  async start(session: string) { this.session = session; this.started.push(session); return this.backend; }
  pushPCM() { if (!this.accept()) { this.emit({ type: 'fallback', session: this.session, backend: 'local-whisper', reason: 'frame-overrun' }); return false; } this.frames++; return true; }
  end() { this.ended++; }
  stop() { this.stopped++; this.emit({ type: 'stopped', session: this.session }); }
  partial(text: string, finalText = '') { this.emit({ type: 'partial', session: this.session, text, display: text.slice(-100), finalText, isFinal: false }); }
  final(text: string, finalText: string) { this.emit({ type: 'final', session: this.session, text, display: finalText.slice(-100), finalText, isFinal: true }); }
  finish(text: string) { this.emit({ type: 'ended', session: this.session, text }); }
}

function host(options: { backend?: 'speech-transcriber' | 'local-whisper'; accept?: () => boolean; whisperText?: string; endTimeoutMs?: number; whisperStart?: Promise<void>; dispatch?: (text: string, signal: AbortSignal) => Promise<unknown> } = {}) {
  const events: VoiceEvent[] = [], dispatched: string[] = [], helpers: FakeHelper[] = [], whisper: VoiceAudio[] = [];
  const transport: VoiceTransport = { start: () => options.whisperStart ?? Promise.resolve(), transcribe: async audio => { whisper.push(audio); return options.whisperText ?? 'open calendar'; }, close() {} };
  const session = new VoiceSession({
    context: () => ({ account: 'a', revision: '1', allowed: true }),
    dispatch: async (text, _context, operation) => { dispatched.push(text); await options.dispatch?.(text, operation.signal); return { status: 'ran', action: 'page.open', operationId: operation.operationId } as never; },
    transport: () => transport,
    requestMicrophone: async () => true,
    event: event => events.push(event),
    streaming: emit => { const h = new FakeHelper(emit, options.backend ?? 'speech-transcriber', options.accept); helpers.push(h); return h; },
    streamEndTimeoutMs: options.endTimeoutMs ?? 1_000,
  });
  const partials = () => events.filter((e): e is Extract<VoiceEvent, { type: 'transcript-partial' }> => e.type === 'transcript-partial').map(e => e.text);
  const finals = () => events.filter((e): e is Extract<VoiceEvent, { type: 'transcript' }> => e.type === 'transcript').map(e => e.text);
  return { session, events, dispatched, helpers, whisper, partials, finals };
}
async function listening(h: ReturnType<typeof host>) {
  const started = await h.session.start();
  return h.session.ready(started.token!).token!;
}
const turn = (operationId: string): VoiceTurn => ({ operationId, context: {} });
const audio = (token: VoiceToken, t?: VoiceTurn): VoiceAudio => ({ token, turn: t, bytes: new ArrayBuffer(8), mimeType: 'audio/webm', durationMs: 2_000, voicedMs: 900 });

test('live partials replace the hypothesis, wait for the turn, and only the helper final dispatches', async () => {
  const h = host();
  const token = await listening(h);
  assert.equal(h.session.streamingReady(), false, 'no helper before the utterance begins');
  assert.equal(await h.session.beginStream(token), 'ready');
  assert.equal(h.session.streamingReady(), true);
  const helper = h.helpers[0]!;
  assert.equal(h.session.pushStream(token, frame()), true);
  helper.partial('open');
  assert.deepEqual(h.partials(), [], 'held until the turn is attached on first speech');
  assert.equal(h.session.pushStream(token, frame(), turn('op-1')), true);
  helper.partial('open cal');
  helper.final('Open calendar.', 'Open calendar.');
  assert.deepEqual(h.partials(), ['open', 'open cal', 'Open calendar.']);
  assert.deepEqual(h.dispatched, [], 'partials and interim finals never dispatch');
  const receipt = h.session.endStream(audio(token, turn('op-1')));
  await tick();
  assert.equal(helper.ended, 1, 'the helper is told the utterance ended');
  helper.finish('Open calendar.');
  helper.partial('late words');
  assert.deepEqual(await receipt, { status: 'dispatched', operationId: 'op-1', transcription: 'speech-transcriber' });
  assert.deepEqual(h.dispatched, ['Open calendar.']);
  assert.deepEqual(h.finals(), ['Open calendar.']);
  assert.equal(h.partials().includes('late words'), false, 'no partial after the final transcript');
  assert.equal(h.whisper.length, 0, 'Whisper is not used when the helper finalized text');
  h.session.stop();
});

test('a helper without the installed model falls back to Whisper, labeled, with one dispatch', async () => {
  const h = host({ backend: 'local-whisper' });
  const token = await listening(h);
  assert.equal(await h.session.beginStream(token), 'fallback');
  assert.equal(h.session.streamingReady(), false);
  assert.equal(h.session.pushStream(token, frame(), turn('op-1')), false);
  assert.deepEqual(await h.session.endStream(audio(token, turn('op-1'))), { status: 'dispatched', operationId: 'op-1', transcription: 'local-whisper' });
  assert.deepEqual(h.dispatched, ['open calendar']);
  assert.equal(h.whisper.length, 1);
  h.session.stop();
});

test('frame overrun mid-utterance switches that utterance to Whisper without a double dispatch', async () => {
  let accepted = 0;
  const h = host({ accept: () => ++accepted <= 2 });
  const token = await listening(h);
  await h.session.beginStream(token);
  assert.equal(h.session.pushStream(token, frame(), turn('op-1')), true);
  assert.equal(h.session.pushStream(token, frame()), true);
  assert.equal(h.session.pushStream(token, frame()), false, 'backpressure: the renderer stops streaming this utterance');
  assert.equal(h.session.streamingReady(), false, 'capability no longer claims streaming');
  assert.equal((await h.session.endStream(audio(token, turn('op-1')))).transcription, 'local-whisper');
  assert.deepEqual(h.dispatched, ['open calendar']);
  h.session.stop();
});

test('a helper that never finalizes in time falls back to Whisper for the same audio', async () => {
  const h = host({ endTimeoutMs: 20 });
  const token = await listening(h);
  await h.session.beginStream(token);
  h.session.pushStream(token, frame(), turn('op-1'));
  const receipt = await h.session.endStream(audio(token, turn('op-1')));
  assert.equal(receipt.transcription, 'local-whisper');
  assert.equal(h.helpers[0]!.stopped, 1, 'the late helper is stopped');
  assert.deepEqual(h.dispatched, ['open calendar']);
  h.session.stop();
});

test('stale tokens cannot begin, feed or finish a stream in a newer session', async () => {
  const h = host();
  const old = await listening(h);
  h.session.stop();
  const token = await listening(h);
  assert.equal(await h.session.beginStream(old), 'fallback');
  assert.equal(h.helpers.length, 0, 'no helper is started for a stale session');
  await h.session.beginStream(token);
  assert.equal(h.session.pushStream(old, frame(), turn('op-1')), false);
  assert.deepEqual(await h.session.endStream(audio(old, turn('op-1'))), { status: 'stopped' });
  assert.deepEqual(h.dispatched, []);
  h.session.stop();
});

test('Stop kills every helper, suppresses late partials and final text, and aborts the action', async () => {
  let aborted: AbortSignal | null = null;
  const h = host({ dispatch: (_text, signal) => { aborted = signal; return new Promise(() => {}); } });
  const token = await listening(h);
  await h.session.beginStream(token);
  const first = h.helpers[0]!;
  h.session.pushStream(token, frame(), turn('op-1'));
  first.partial('open');
  const pending = h.session.endStream(audio(token, turn('op-1')));
  await tick();
  first.finish('Open calendar.');
  await tick();
  assert.deepEqual(h.dispatched, ['Open calendar.']);
  await h.session.beginStream(token); // the next utterance's helper prepares while the action runs
  const second = h.helpers[1]!;
  h.session.pushStream(token, frame(), turn('op-2'));
  const before = h.events.length;
  h.session.stop();
  assert.equal(second.stopped, 1, 'the capturing helper is killed synchronously');
  assert.equal(aborted!.aborted, true, 'the running plan/action chain is aborted');
  second.partial('more words');
  second.finish('more words');
  assert.equal(h.events.slice(before).some(e => e.type !== 'state'), false, 'nothing but the stopped state after Stop');
  assert.deepEqual(await h.session.endStream(audio(token, turn('op-2'))), { status: 'stopped' });
  void pending;
});

test('a silent capture helper is ended when the next utterance begins; one with speech keeps finishing', async () => {
  const h = host();
  const token = await listening(h);
  await h.session.beginStream(token);
  await h.session.beginStream(token);
  assert.equal(h.helpers[0]!.stopped, 1, 'no speech: helper ended');
  h.session.pushStream(token, frame(), turn('op-1'));
  await h.session.beginStream(token);
  assert.equal(h.helpers[1]!.stopped, 0);
  assert.equal(h.helpers[1]!.ended, 1, 'speech: its input is closed so the final text is ready early');
  h.session.stop();
});

test('with the helper installed, a cold Whisper load no longer delays Listening; a fallback waits for it', async () => {
  let loaded!: () => void;
  const h = host({ backend: 'local-whisper', whisperStart: new Promise<void>(resolve => { loaded = resolve; }) });
  const token = await listening(h);
  assert.equal(h.session.status().phase, 'listening');
  await h.session.beginStream(token);
  const receipt = h.session.endStream(audio(token, turn('op-1')));
  await tick();
  assert.equal(h.whisper.length, 0, 'Whisper not used before it loaded');
  loaded();
  assert.equal((await receipt).transcription, 'local-whisper');
  h.session.stop();
});

test('typed host bridge: streaming calls use their own channels and pass the frame through unchanged', async () => {
  const calls: unknown[][] = [];
  const bridge = createVoiceBridge({ invoke: async (...args: unknown[]) => { calls.push(args); return true; }, on: (() => {}) as never, removeListener: (() => {}) as never });
  const token = { sessionId: 's', epoch: 1 }, pcm = new Int16Array([1, -2, 3]);
  await bridge.beginStreamingTurn!(token);
  await bridge.pushStreamingPCM!(token, pcm);
  await bridge.pushStreamingPCM!(token, pcm, turn('op-1'));
  await bridge.endStreamingTurn!(audio(token, turn('op-1')));
  assert.deepEqual(calls.map(c => c[0]), ['magic:voice-stream-begin', 'magic:voice-stream-push', 'magic:voice-stream-push', 'magic:voice-stream-end']);
  assert.equal(calls[1]![2], pcm);
  assert.equal(calls[1]![3], null);
  assert.deepEqual(calls[2]![3], turn('op-1'));
  assert.equal(isPcmFrame(new Int16Array(3200)), true);
  assert.equal(isPcmFrame(new Int16Array(3201)), false);
  assert.equal(isPcmFrame(new Float32Array(10)), false);
  assert.equal(isVoiceTurn({ operationId: 'bad id!', context: {} }), false);
});

// Renderer: the one microphone stream feeds the helper; its finished utterance is ended through the host.
function renderer(push: (frame: Int16Array, turn?: VoiceTurn) => boolean | Promise<boolean> = () => true) {
  let listener: ((event: VoiceEvent) => void) | undefined, now = 0, amplitude = .05, frameId = 0, sequence = 0;
  const frames = new Map<number, FrameRequestCallback>(), order: string[] = [], pushes: { frame: Int16Array; turn?: VoiceTurn }[] = [], ended: VoiceAudio[] = [], whole: VoiceAudio[] = [];
  const taps: { frame(pcm: Int16Array): void; finished: number; closed: number }[] = [];
  class Recorder extends EventTarget {
    state = 'inactive'; start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; const e = new Event('dataavailable'); Object.defineProperty(e, 'data', { value: new Blob([new Uint8Array(4)]) }); this.dispatchEvent(e); this.dispatchEvent(new Event('stop')); }
  }
  const bridge: VoiceBridge = {
    capabilities: async () => ({ microphone: true, transcription: 'speech-transcriber', externalControl: false, streamingSpeech: true }),
    start: async () => { order.push('start'); return { phase: 'starting', token: { sessionId: 's' + ++sequence, epoch: sequence } }; },
    ready: async token => { order.push('ready'); return { phase: 'listening', token }; },
    stop: async () => ({ phase: 'idle', token: null }),
    transcribe: async a => { whole.push(a); return { status: 'dispatched' } as VoiceReceipt; },
    onEvent: fn => { listener = fn; return () => { listener = undefined; }; },
    beginStreamingTurn: async () => { order.push('begin'); return 'ready'; },
    pushStreamingPCM: async (_token, f, t) => { pushes.push({ frame: f, turn: t }); return push(f, t); },
    endStreamingTurn: async a => { ended.push(a); return { status: 'dispatched', transcription: 'speech-transcriber' }; },
  };
  const env = {
    getUserMedia: async () => { order.push('getUserMedia'); return { getTracks: () => [{ stop() {}, addEventListener() {} }] }; },
    audioContext: () => ({ sampleRate: 48_000, createAnalyser: () => ({ fftSize: 1024, getFloatTimeDomainData: (s: Float32Array) => s.fill(amplitude) }), createMediaStreamSource: () => ({ connect() {}, disconnect() {} }), resume: async () => {}, close: async () => {} }),
    recorder: () => new Recorder(),
    frame: (fn: FrameRequestCallback) => { frames.set(++frameId, fn); return frameId; }, cancelFrame: (id: number) => frames.delete(id), now: () => now,
    pcmTap: (_c: unknown, _s: unknown, cb: (pcm: Int16Array) => void) => { const tap = { finished: 0, closed: 0, frame: (pcm: Int16Array) => { if (!tap.closed) cb(pcm); }, finish() { if (!tap.closed) { tap.closed++; tap.finished++; cb(new Int16Array(10)); } }, close() { tap.closed++; } }; taps.push(tap); return tap; },
  } as unknown as MicrophoneEnvironment;
  let op = 0;
  const mic = new VoiceMicrophone(bridge, () => {}, () => {}, env, () => ({ operationId: `op-${++op}`, context: {} }));
  const step = (ms = 100, amp = .05) => { now += ms; amplitude = amp; const entry = [...frames].at(-1); if (entry) { frames.delete(entry[0]); entry[1](now); } };
  return { mic, order, pushes, ended, whole, taps, step, emit: (e: VoiceEvent) => listener?.(e) };
}

test('renderer: the helper begins right after the click, the turn is attached once, and the utterance ends through the host', async () => {
  const r = renderer();
  await r.mic.start();
  assert.deepEqual(r.order, ['start', 'begin', 'getUserMedia', 'ready'], 'begin runs in parallel with getUserMedia, before Listening');
  const tap = r.taps[0]!;
  tap.frame(frame());
  assert.equal(r.pushes[0]!.turn, undefined, 'no turn before speech');
  r.step(); // speech detected: the turn is captured
  tap.frame(frame()); tap.frame(frame());
  assert.equal(r.pushes.filter(p => p.turn).length, 1, 'the turn is attached exactly once');
  for (let i = 0; i < 3; i++) r.step();
  r.step(1900, 0);
  await tick(); await tick();
  assert.equal(tap.finished, 1, 'the tail frame is flushed before the end');
  assert.equal(r.ended.length, 1);
  assert.equal(r.whole.length, 0, 'a streamed utterance is not also sent to Whisper');
  assert.equal(r.ended[0]!.turn?.operationId, r.pushes.find(p => p.turn)!.turn!.operationId);
  assert.equal(r.order.filter(x => x === 'begin').length, 2, 'the next utterance begins its own helper');
  await r.mic.stop();
});

test('renderer: a refused frame closes the tap and that utterance goes to local Whisper; Stop closes the tap', async () => {
  const r = renderer(() => false);
  await r.mic.start();
  const tap = r.taps[0]!;
  r.step();
  tap.frame(frame());
  await tick();
  assert.equal(tap.closed > 0, true, 'backpressure closes this utterance tap');
  for (let i = 0; i < 3; i++) r.step();
  r.step(1900, 0);
  await tick(); await tick();
  assert.equal(r.whole.length, 1);
  assert.equal(r.ended.length, 0);
  const next = r.taps[1]!;
  await r.mic.stop();
  assert.equal(next.closed > 0, true);
  const count = r.pushes.length;
  next.frame(frame());
  assert.equal(r.pushes.length, count, 'no frame after Stop');
});

// Real helper, headless: synthetic PCM from a file (no microphone), paced at 200 ms, through the real adapter
// and the host session. Runs only when both paths are given (e.g. the Sol6 lane's say-generated sample).
const HELPER = process.env.VOICE_STREAM_HELPER, PCM = process.env.VOICE_STREAM_PCM;
test('real SpeechTranscriber helper: live partials, then one final dispatch', { skip: !(HELPER && PCM && existsSync(HELPER) && existsSync(PCM)) && 'set VOICE_STREAM_HELPER and VOICE_STREAM_PCM' }, async () => {
  const events: VoiceEvent[] = [], dispatched: string[] = [], marks: Record<string, number> = {};
  const t0 = performance.now(), mark = (k: string) => { marks[k] ??= Math.round(performance.now() - t0); };
  const session = new VoiceSession({
    context: () => ({ account: 'a', revision: '1', allowed: true }),
    dispatch: async (text, _c, op) => { mark('dispatch'); dispatched.push(text); return { status: 'ran', action: 'page.open', operationId: op.operationId } as never; },
    transport: () => ({ start: async () => {}, transcribe: async () => { throw new Error('Whisper must not be used'); }, close() {} }),
    requestMicrophone: async () => true,
    event: e => { if (e.type === 'transcript-partial') mark('firstPartial'); events.push(e); },
    streaming: emit => new NativeStreamingSTT(HELPER!, emit),
  });
  const token = session.ready((await session.start()).token!).token!;
  assert.equal(await session.beginStream(token), 'ready'); mark('ready');
  const pcm = readFileSync(PCM!);
  for (let offset = 0, i = 0; offset < pcm.length; offset += 6400, i++) {
    const bytes = pcm.subarray(offset, offset + 6400);
    const samples = new Int16Array(bytes.length / 2);
    for (let j = 0; j < samples.length; j++) samples[j] = bytes.readInt16LE(j * 2);
    assert.equal(session.pushStream(token, samples, i === 0 ? turn('real-1') : undefined), true);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  mark('audioEnd');
  const receipt = await session.endStream(audio(token, turn('real-1')));
  const partials = events.filter(e => e.type === 'transcript-partial').map(e => (e as { text: string }).text);
  console.log(JSON.stringify({ marks, partials: partials.length, distinctPartials: new Set(partials).size, final: dispatched[0] }));
  assert.equal(receipt.status, 'dispatched');
  assert.equal(receipt.transcription, 'speech-transcriber');
  assert.ok(new Set(partials).size >= 2, 'the hypothesis changed while audio streamed');
  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0]!, /launch/i);
  session.stop();
});
