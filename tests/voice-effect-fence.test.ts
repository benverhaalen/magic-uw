/** Synthetic deterministic countertests. No providers, Electron, microphone or external effects. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { workspace, NOW, TZ } from './intent-fixtures';
import { VoiceSession } from '../apps/desktop/src/voice/session';
import { createCore } from '../packages/core/src/index';
import { createIntentRouter } from '../packages/core/src/intent/router';
import { withCourse } from '../packages/core/src/intent/action-args';
import { CONSENT_DISCLOSURE_VERSION } from '../packages/domain/src/index';
import type { ModelRunner, RunResult } from '../packages/runner/src/types';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
const output = { action: 'audit.effect', args: { course: 'CS 400', assignment: null, topics: null, date: null, time: null, query: null, kind: null, count: null, scope: null }, confidence: 'high', alternatives: null, question: null };
function setup() {
  const { store, batches } = workspace();
  store.setConsent!({ action: 'grant', recipient: 'claude', disclosureVersion: CONSENT_DISCLOSURE_VERSION }, NOW.toISOString());
  const entered = deferred<void>(), result = deferred<RunResult<any>>();
  let effects = 0;
  const runner: ModelRunner = { client: 'claude', async run() { entered.resolve(); return result.promise; } };
  const router = createIntentRouter({ store, runner: () => runner, now: () => NOW, timeZone: TZ, codePath: false, actions: [{ name: 'audit.effect', description: 'Synthetic counter only', slots: { course: 'required' }, argsSchema: withCourse, examples: [], async run() { ++effects; return { observed: true }; } }] });
  const abort = new AbortController();
  const run = (allowedActions: string[] = ['audit.effect']) => router.handle({ text: 'Synthetic audit action for CS 400', allowedActions }, { workspace: async () => { throw Error('Unexpected workspace effect'); } }, abort.signal);
  const complete = () => result.resolve({ output, usage: { in: 0, cached: 0, out: 0 }, model: 'synthetic', latencyMs: 0, attempts: 1, client: 'claude', tier: 'pass', escalated: false });
  return { store, fixture: batches[0]!, router, entered: entered.promise, run, complete, abort, effects: () => effects };
}
test('Stop after model entry but before uncooperative late reply prevents action', async () => {
  const f = setup(); const pending = f.run(); await f.entered; f.abort.abort(); f.complete();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(f.effects(), 0);
});
test('allowlist denies consequential synthetic action after classification', async () => {
  const f = setup(); const pending = f.run(['page.open']); await f.entered; f.complete();
  assert.equal((await pending).status, 'unavailable'); assert.equal(f.effects(), 0);
});
test('course inclusion revoked during model wait is checked at action boundary', async () => {
  const f = setup(); const pending = f.run(); await f.entered;
  f.store.setCourseOverride({ accountScope: 'acct', courseId: 'c400', included: false }); f.complete();
  const receipt = await pending; assert.equal(f.effects(), 0, 'cached course index must not authorize an excluded course'); assert.equal(receipt.status, 'unavailable');
});
test('account resources removed during model wait cannot authorize old course', async () => {
  const f = setup(); const pending = f.run(); await f.entered;
  f.store.purge(); f.complete();
  const receipt = await pending; assert.equal(f.effects(), 0, 'cached course index must not authorize purged account resources'); assert.equal(receipt.status, 'unavailable');
});

test('actual core command path propagates policy revocation before the pending action', async () => {
  const f = setup();
  const core = createCore(f.store, { fixture: f.fixture, now: () => NOW, timeZone: TZ, seams: { intent: f.router } });
  const pending = core.execute({ type: 'command', value: { text: 'Synthetic audit action for CS 400', allowedActions: ['audit.effect'] } });
  await f.entered;
  await core.execute({ type: 'consent', value: { action: 'revoke', recipient: 'claude' } });
  f.complete();
  await assert.rejects(pending); assert.equal(f.effects(), 0);
});
test('live authorized synthetic action runs once, proving the effect counter is connected', async () => {
  const f = setup(); const pending = f.run(); await f.entered; f.complete();
  assert.equal((await pending).status, 'ran'); assert.equal(f.effects(), 1);
});

test('actual VoiceSession to core to router propagates Stop before late classified effect', async () => {
  const f = setup();
  const core = createCore(f.store, { fixture: f.fixture, now: () => NOW, timeZone: TZ, seams: { intent: f.router } });
  let results = 0;
  const session = new VoiceSession({
    context: () => ({ account: 'synthetic-account', revision: 'v1', allowed: true }),
    requestMicrophone: async () => true,
    transport: () => ({ start: async () => {}, close() {}, transcribe: async () => 'Synthetic audit action for CS 400' }),
    dispatch: async (text, context, operation) => {
      const result = await core.execute({ type: 'command', value: { text, context, allowedActions: ['audit.effect'] } }, operation.signal);
      return result.command!;
    },
    event: event => { if (event.type === 'result') ++results; },
  });
  const started = await session.start(); session.ready(started.token!);
  const pending = session.transcribe({ token: started.token!, bytes: new ArrayBuffer(5), mimeType: 'audio/webm', durationMs: 2000, voicedMs: 500 });
  await f.entered; session.stop(); f.complete();
  assert.equal((await pending).status, 'stopped'); assert.equal(f.effects(), 0); assert.equal(results, 0);
});
