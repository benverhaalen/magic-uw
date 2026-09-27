import test from 'node:test';
import assert from 'node:assert/strict';
import { Pcm16Framer } from '../apps/desktop/src/renderer/voice/pcm-framer';

test('48 kHz microphone chunks become bounded ordered 16 kHz mono frames', () => {
  const framer = new Pcm16Framer(48_000);
  const frames: Int16Array[] = [];
  for (let i = 0; i < 24; i++) frames.push(...framer.push(new Float32Array(1000).fill(i % 2 ? 0.5 : -0.5)));
  assert.equal(frames.length, 2);
  assert.ok(frames.every(frame => frame.length === 3200));
  assert.ok(frames[0]!.some(value => value < 0));
  assert.ok(frames[0]!.some(value => value > 0));
  const tail = framer.finish();
  assert.ok(tail && tail.length > 0 && tail.length <= 3200);
  assert.equal(frames.reduce((n, frame) => n + frame.length, 0) + tail.length, 8000);
});

test('44.1 kHz chunks preserve continuity and clamp to valid S16LE range', () => {
  const framer = new Pcm16Framer(44_100, 1600);
  const frames = [...framer.push(new Float32Array(11_025).fill(2))];
  const tail = framer.finish();
  const samples = frames.flatMap(frame => Array.from(frame)).concat(Array.from(tail ?? []));
  assert.ok(samples.length >= 3999 && samples.length <= 4000);
  assert.ok(samples.every(sample => sample === 32767));
});
