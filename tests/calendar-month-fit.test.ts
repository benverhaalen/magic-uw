import test from 'node:test';
import assert from 'node:assert/strict';
import { monthVisibleItemCount } from '../apps/desktop/src/renderer/calendar/month-fit';
import { visibleDates } from '../apps/desktop/src/renderer/calendar/model';
test('4/5/6 week months preserve every date while preview capacity follows available row height', () => {
  assert.equal(visibleDates('2027-02-01', 'month').length,28);
  assert.equal(visibleDates('2026-09-01', 'month').length,35);
  assert.equal(visibleDates('2026-11-01', 'month').length,42);
  assert.equal(monthVisibleItemCount(30,65),0);
  assert.equal(monthVisibleItemCount(30,112),1);
  assert.equal(monthVisibleItemCount(30,150),2);
  assert.equal(monthVisibleItemCount(2,125),2);
  assert.equal(monthVisibleItemCount(0,65),0);
});
test('preview plus full-day disclosure stay inside rows, including enlarged text', () => {
  for (const rem of [16,32]) for (let height=4*rem;height<=400;height+=.5) for (const total of [0,1,2,3,30]) {
    const count=monthVisibleItemCount(total,height,rem);
    assert.ok(count>=0 && count<=total && count<=2);
    const used=2.125*rem+count*2.6875*rem+(count<total?1.6875*rem:0);
    assert.ok(used<=height+.001,JSON.stringify({height,total,count,rem}));
  }
});
