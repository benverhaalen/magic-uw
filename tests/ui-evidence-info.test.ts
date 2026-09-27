import test from 'node:test';
import assert from 'node:assert/strict';
import { placeInfoPanel } from '../packages/ui/src/evidence-info';

const viewport = { width: 800, height: 600 }, panel = { width: 320, height: 120 };
const at = (left: number, top: number) => ({ left, top, bottom: top + 28 });

test('opens below the trigger when it fits', () => {
  assert.deepEqual(placeInfoPanel(at(100, 100), panel, viewport), { left: 100, top: 134 });
});

test('flips above near the bottom and clamps inside the right edge', () => {
  assert.deepEqual(placeInfoPanel(at(700, 540), panel, viewport), { left: 468, top: 414 });
});

test('clamps inside the viewport margin when neither side fits', () => {
  const small = { width: 320, height: 240 }, tall = { width: 296, height: 200 };
  assert.deepEqual(placeInfoPanel(at(4, 100), tall, small), { left: 12, top: 28 });
});
