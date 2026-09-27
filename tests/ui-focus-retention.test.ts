import test from 'node:test';
import assert from 'node:assert/strict';
import { DisabledFocusHold } from '../packages/ui/src/focus-retention';

type Control = { name: string; disabled: boolean; connected: boolean };
const control = (name: string): Control => ({ name, disabled: false, connected: true });
const settle = (hold: DisabledFocusHold<Control>, idle = true) => hold.settle(c => c.disabled, c => c.connected, idle);

test('a focused control disabled by a busy flag gets focus back when it is enabled again', () => {
  const hold = new DisabledFocusHold<Control>(), refresh = control('refresh');
  hold.focused(refresh);
  refresh.disabled = true; hold.departed(refresh, true);
  assert.equal(settle(hold), null, 'nothing to restore while it stays disabled');
  refresh.disabled = false;
  assert.equal(settle(hold), refresh);
  assert.equal(settle(hold), null, 'restores once');
});

test('user or page focus changes, pointer presses and ordinary departure are never overridden', () => {
  const hold = new DisabledFocusHold<Control>(), refresh = control('refresh'), other = control('other');
  hold.focused(refresh); refresh.disabled = true; settle(hold);
  hold.focused(other); refresh.disabled = false;
  assert.equal(settle(hold), null, 'page moved focus during the operation');

  hold.focused(refresh); refresh.disabled = true; settle(hold);
  hold.pointed(); refresh.disabled = false;
  assert.equal(settle(hold), null, 'pointer press elsewhere');

  hold.focused(refresh); hold.departed(refresh, false); refresh.disabled = true; settle(hold); refresh.disabled = false;
  assert.equal(settle(hold), null, 'focus had already left before it was disabled');
});

test('focus that is no longer idle or a removed control is left alone', () => {
  const hold = new DisabledFocusHold<Control>(), refresh = control('refresh');
  hold.focused(refresh); refresh.disabled = true; settle(hold); refresh.disabled = false;
  assert.equal(settle(hold, false), null, 'something else already holds focus');

  hold.focused(refresh); refresh.disabled = true; settle(hold);
  refresh.connected = false; refresh.disabled = false;
  assert.equal(settle(hold), null, 'unmounted while busy');
});
