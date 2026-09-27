import test from 'node:test';
import assert from 'node:assert/strict';
import { rollingTranscript, visibleTranscript } from '../apps/desktop/src/renderer/voice/rolling-transcript';

test('rolling transcript contains only actual recognized text', () => {
  assert.equal(rollingTranscript('', ''), '');
  assert.equal(rollingTranscript('', '  Open Wikipedia  '), 'Open Wikipedia');
  assert.equal(rollingTranscript('Open Wikipedia', '   '), 'Open Wikipedia');
  assert.equal(rollingTranscript('Open Wikipedia', 'and find Apollo 11'), 'Open Wikipedia and find Apollo 11');
});

test('rolling transcript retains last 100 Unicode characters', () => {
  const text = rollingTranscript('🙂'.repeat(120), 'Apollo 11');
  assert.equal(Array.from(text).length, 100);
  assert.ok(text.endsWith('Apollo 11'));
  assert.equal(rollingTranscript('', 'a'.repeat(150)), 'a'.repeat(100));
});

test('volatile partial replaces its own tail and final text is appended only once', () => {
  const finalized = rollingTranscript('', 'Open Wikipedia');
  assert.equal(visibleTranscript(finalized, 'and find Apol'), 'Open Wikipedia and find Apol');
  assert.equal(visibleTranscript(finalized, 'and find Apollo 11'), 'Open Wikipedia and find Apollo 11');
  const afterFinal = rollingTranscript(finalized, 'and find Apollo 11');
  assert.equal(visibleTranscript(afterFinal, ''), 'Open Wikipedia and find Apollo 11');
  const tail = visibleTranscript('🙂'.repeat(120), 'Apollo 11');
  assert.equal(Array.from(tail).length, 100);
  assert.ok(tail.endsWith('Apollo 11'));
});
