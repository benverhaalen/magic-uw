// From the observed-executor lane (voice-jev-observed-executor/test/observed-actions.test.ts), import path only changed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createJevActionJudge, NativeObservedActions, ObservedActionController, type BrowserObservation, type ActionChoice } from '../apps/desktop/src/voice/observed-actions';

const page: BrowserObservation = {
  bundleId: 'org.mozilla.firefox', pid: 123, windowNumber: 9, title: 'Wikipedia', url: 'https://en.wikipedia.org/',
  focusedRole: 'AXWebArea', focusedTitle: 'Wikipedia', text: 'Free encyclopedia',
  candidates: [{path: [0, 2], role: 'AXLink', title: 'Apollo 11', targetURL: 'https://en.wikipedia.org/wiki/Apollo_11'}]
};
function setup(choice: string, snapshots: BrowserObservation[] = [page, page, {...page, url: 'https://en.wikipedia.org/wiki/Apollo_11', title: 'Apollo 11'}]) {
  const requests: Record<string, unknown>[] = [];
  const native = {run: async (request: Record<string, unknown>) => {
    requests.push(request);
    const observation = snapshots.shift();
    return observation ? {status: 'observed' as const, observation} : {status: 'unavailable' as const, reason: 'none'};
  }, stop: () => 'stopped'} as unknown as NativeObservedActions;
  const browser = {run: async () => ({status: 'observed' as const, phase: 'observed' as const, target: {bundleId: page.bundleId, pid: page.pid, url: page.url, title: page.title}, context: {id: 'course-a'}}), stop: () => {}};
  const judge = {choose: async (): Promise<ActionChoice> => ({id: choice, probability: .9, model: 'jev-1.13.0'})};
  return {controller: new ObservedActionController(native, browser, judge), requests};
}
const input = () => ({goal: 'Find Apollo 11', context: {id: 'course-a'}, signal: new AbortController().signal, current: () => true});
test('observed HTTPS link binds target, reobserves, and verifies destination', async () => {
  const {controller, requests} = setup('link_0');
  const result = await controller.step(input());
  assert.equal(result.status, 'observed');
  assert.equal(result.after?.url, 'https://en.wikipedia.org/wiki/Apollo_11');
  assert.deepEqual(requests.map(x => x.action), ['observe', 'observe', 'click']);
  assert.deepEqual(requests[2]?.path, [0, 2]);
});
test('changed observation aborts before click', async () => {
  const changed = {...page, title: 'Other page'};
  const {controller, requests} = setup('link_0', [page, changed]);
  const result = await controller.step(input());
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(requests.map(x => x.action), ['observe', 'observe']);
});
test('consequential link needs exact-turn confirmation', async () => {
  const risky = {...page, candidates: [{path: [0], role: 'AXLink' as const, title: 'Delete account', targetURL: 'https://example.com/delete'}]};
  const {controller, requests} = setup('link_0', [risky]);
  const result = await controller.step(input());
  assert.equal(result.status, 'needs_confirmation');
  assert.deepEqual(requests.map(x => x.action), ['observe']);
});
test('Stop prevents a queued action after Jev choice', async () => {
  const {controller, requests} = setup('link_0');
  controller.stop();
  const result = await controller.step(input());
  assert.equal(result.status, 'stopped');
  assert.equal(requests.length, 0);
});
test('Jev request is real TypeSafe Choice shape and validates the answer', async () => {
  let body: any;
  const fetcher: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({model: 'jev-1.13.0', answers: {action: {type: 'choice', choice: 'handoff', probabilities: {handoff: .8, read: .2}, confidence: .8}}}), {status: 200});
  };
  const result = await createJevActionJudge('test-key', fetcher).choose('Find Apollo 11', page, [
    {id: 'handoff', action: 'handoff', label: 'Handoff'}, {id: 'read', action: 'read', label: 'Read'}], [], new AbortController().signal);
  assert.equal(result.id, 'handoff');
  assert.equal(body.model, 'jev-1.13.0');
  assert.equal(body.questions.action.type, 'choice');
  assert.match(body.questions.action.instructions, /untrusted evidence/);
});
test('Stop during pending Jev answer aborts model signal and executes no action', async () => {
  const requests: Record<string, unknown>[] = [];
  const native = {run: async (request: Record<string, unknown>) => {requests.push(request); return {status: 'observed' as const, observation: page};}, stop: () => 'stopped'} as unknown as NativeObservedActions;
  let resolveChoice!: (value: ActionChoice) => void;
  let modelSignal: AbortSignal | undefined;
  const judge = {choose: async (_goal: string, _page: BrowserObservation | null, _offers: unknown, _recent: unknown, signal: AbortSignal) => {
    modelSignal = signal;
    return new Promise<ActionChoice>(resolve => {resolveChoice = resolve;});
  }};
  const browser = {run: async () => {throw new Error('unexpected open');}, stop: () => {}};
  const controller = new ObservedActionController(native, browser, judge);
  const pending = controller.step(input());
  while (!resolveChoice) await new Promise(resolve => setImmediate(resolve));
  controller.stop();
  assert.equal(modelSignal?.aborted, true);
  resolveChoice({id: 'link_0', probability: 1, model: 'jev-1.13.0'});
  const result = await pending;
  assert.equal(result.status, 'stopped');
  assert.deepEqual(requests.map(x => x.action), ['observe']);
});
