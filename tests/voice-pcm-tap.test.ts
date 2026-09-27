import test from 'node:test';
import assert from 'node:assert/strict';
import { MicPcmTap } from '../apps/desktop/src/renderer/voice/pcm-tap';

test('PCM tap shares the current source and emits only bounded input frames with silent output', () => {
  const emitted: Int16Array[] = [];
  let handler: ((event: AudioProcessingEvent) => void) | null = null, sourceConnects = 0, sourceDisconnects = 0, processorDisconnects = 0;
  const processor = {
    get onaudioprocess() { return handler; }, set onaudioprocess(value: typeof handler) { handler = value; },
    connect() {}, disconnect() { processorDisconnects++; },
  } as unknown as ScriptProcessorNode;
  const context = { sampleRate: 48_000, destination: {}, createScriptProcessor: () => processor } as unknown as AudioContext;
  const source = { connect: () => { sourceConnects++; }, disconnect: () => { sourceDisconnects++; } } as unknown as MediaStreamAudioSourceNode;
  const tap = new MicPcmTap(context, source, frame => emitted.push(frame));
  const output = new Float32Array(2048).fill(1);
  const event = { inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.25) }, outputBuffer: { getChannelData: () => output } } as unknown as AudioProcessingEvent;
  for (let i = 0; i < 10; i++) processor.onaudioprocess?.call(processor, event);
  assert.equal(sourceConnects, 1);
  assert.ok(output.every(value => value === 0));
  assert.equal(emitted.length, 2);
  assert.ok(emitted.every(frame => frame.length <= 3200 && frame.every(value => value > 0)));
  tap.finish();
  assert.equal(sourceDisconnects, 1);
  assert.equal(processorDisconnects, 1);
  const count = emitted.length;
  assert.equal(handler, null);
  tap.finish();
  assert.equal(emitted.length, count);
});
