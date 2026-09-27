import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreparationCache } from '../apps/desktop/src/renderer/prepared-work/prepare-cache';
test('same evidence across surfaces shares one preparation and different items dispatch sequentially', async () => {
  const cache=createPreparationCache<number>(); let calls=0,release!:()=>void; const gate=new Promise<void>(r=>release=r);
  const a=cache.read('account:item:v1',async()=>{calls++;await gate;return 1});
  const duplicate=cache.read('account:item:v1',async()=>{throw Error('duplicate')});
  const b=cache.read('account:other:v1',async()=>{calls++;return 2});
  await Promise.resolve();await Promise.resolve();assert.equal(calls,1);assert.equal(a,duplicate);
  release();assert.deepEqual(await Promise.all([a,b]),[1,2]);assert.equal(calls,2);
  assert.equal(await cache.read('account:item:v1',async()=>99),1);
  assert.equal(await cache.read('account:item:v2',async()=>3),3);
});
test('failure retries and an explicit retry replaces the old preview',async()=>{
  const cache=createPreparationCache<number>();await assert.rejects(cache.read('key',async()=>{throw Error('unavailable')}));
  assert.equal(await cache.read('key',async()=>2),2);assert.equal(await cache.read('key',async()=>3,true),3);
});

test('concurrent explicit retries share the pending replacement', async () => {
  const cache = createPreparationCache<number>();
  await cache.read('key', async () => 1);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const retry = cache.read('key', async () => { calls++; await gate; return 2; }, true);
  const sibling = cache.read('key', async () => { calls++; return 3; }, true);
  assert.equal(retry, sibling);
  release();
  assert.equal(await sibling, 2);
  assert.equal(calls, 1);
});
