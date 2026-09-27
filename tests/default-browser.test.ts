import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DefaultBrowserTransport } from '../apps/desktop/src/voice/default-browser.ts';

const helper = fileURLToPath(new URL('./fixtures/default-browser-fake-helper.cjs', import.meta.url));
chmodSync(helper, 0o755);

test('opening requires observation and read retains origin context', async () => {
  const transport = new DefaultBrowserTransport<{ course: string }>(helper);
  const signal = new AbortController();
  const opened = await transport.run({ action: 'open', url: 'https://example.com' }, { course: 'CS 400' }, signal.signal, () => true);
  assert.equal(opened.status, 'observed');
  assert.equal(opened.target?.url, 'https://example.com/');
  const read = await transport.run({ action: 'read' }, { course: 'CS 400' }, signal.signal, () => true);
  assert.equal(read.status, 'observed');
  assert.equal(read.text, 'Page text');
  assert.equal(read.context.course, 'CS 400');
});

test('Stop after dispatch is unknown and blocks stale observation', async () => {
  process.env.FAKE_MODE = 'after';
  const transport = new DefaultBrowserTransport<string>(helper);
  const action = transport.run({ action: 'open', url: 'https://example.com' }, 'item-1', new AbortController().signal, () => true);
  await new Promise(resolve => setTimeout(resolve, 250));
  const stop = transport.stop();
  const receipt = await action;
  assert.equal(stop.status, 'unknown');
  assert.equal(receipt.status, 'unknown');
  const read = await transport.run({ action: 'read' }, 'item-1', new AbortController().signal, () => true);
  assert.equal(read.status, 'unavailable');
  delete process.env.FAKE_MODE;
});

test('pre-dispatch cancellation has no observed or dispatched effect', async () => {
  process.env.FAKE_MODE = 'before';
  const transport = new DefaultBrowserTransport<string>(helper);
  const controller = new AbortController();
  const action = transport.run({ action: 'open', url: 'https://example.com' }, 'item-1', controller.signal, () => true);
  controller.abort();
  const receipt = await action;
  assert.equal(receipt.status, 'stopped');
  assert.equal(receipt.phase, 'pre_dispatch');
  delete process.env.FAKE_MODE;
});

test('unsupported mutating page action never reaches helper', async () => {
  const transport = new DefaultBrowserTransport<string>(helper);
  const result = await transport.run({ action: 'back' }, 'item-1', new AbortController().signal, () => true);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.phase, 'pre_dispatch');
});

test('missing packaged native helper returns unavailable', async () => {
  const transport = new DefaultBrowserTransport<string>('/missing/default-browser-helper');
  const result = await transport.run({ action: 'open', url: 'https://example.com' }, 'item-1', new AbortController().signal, () => true);
  assert.equal(result.status, 'unavailable');
});
