import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { anchorSide, LATERAL_FROM_OPACITY, MOTION_EASE, MOTION_MS, PAGE_SHIFT_PX, pageDirection, pageEnterPlan, playPageEnter, PAGE_MOTION_ATTRIBUTE } from '../packages/ui/src/motion';

test('history travel keeps its arrow direction; a push compares hierarchy depth', () => {
  assert.equal(pageDirection(0, 1, 'push'), 'forward', 'Home to a course');
  assert.equal(pageDirection(1, 2, 'push'), 'forward', 'course to assignment');
  assert.equal(pageDirection(1, 0, 'push'), 'back', 'All courses from a course page returns');
  assert.equal(pageDirection(1, 1, 'push'), 'lateral', 'one course to another');
  assert.equal(pageDirection(0, 0, 'push'), 'lateral', 'Home to Calendar');
  assert.equal(pageDirection(0, 2, 'back'), 'back');
  assert.equal(pageDirection(2, 0, 'forward'), 'forward');
});

test('directional entrances travel a little, fade from nothing, and never scale text', () => {
  const forward = pageEnterPlan('forward')!, back = pageEnterPlan('back')!;
  assert.deepEqual(forward.keyframes, [{ opacity: 0, transform: `translateX(${PAGE_SHIFT_PX}px)` }, { opacity: 1, transform: 'none' }]);
  assert.equal(back.shift, -PAGE_SHIFT_PX);
  assert.equal(forward.options.duration, MOTION_MS.page);
  assert.equal(forward.options.easing, MOTION_EASE.out);
  assert.equal(forward.options.fill, 'none', 'no transform lingers after the entrance');
  assert.ok(MOTION_MS.page < 300);
  for (const plan of [forward, back, pageEnterPlan('lateral')!]) assert.doesNotMatch(JSON.stringify(plan.keyframes), /scale|blur/);
});

test('same-level changes and reduced motion only fade, starting readable', () => {
  for (const plan of [pageEnterPlan('lateral')!, pageEnterPlan('forward', { reduced: true })!, pageEnterPlan('back', { reduced: true })!]) {
    assert.deepEqual(plan.keyframes, [{ opacity: LATERAL_FROM_OPACITY }, { opacity: 1 }]);
    assert.equal(plan.shift, 0);
    assert.equal(plan.options.duration, MOTION_MS.pageLateral);
  }
});

test('an interrupted entrance continues from its visible opacity with less travel, never restarting', () => {
  const plan = pageEnterPlan('back', { carriedOpacity: 0.7 })!;
  assert.equal(plan.from, 0.7);
  assert.equal(plan.shift, -3.6);
  assert.equal(plan.options.duration, 60);
  assert.equal(pageEnterPlan('forward', { carriedOpacity: 0.97 }), null, 'almost settled: just show it');
  assert.equal(pageEnterPlan('lateral', { carriedOpacity: 0.2 })!.from, LATERAL_FROM_OPACITY, 'never dips below the lateral floor');
});

type Fake = { keyframes: Keyframe[]; options: KeyframeAnimationOptions; playState: string; cancelled: boolean; progress: number | null };
function fakePane(count: number) {
  const made: Fake[] = [], attrs = new Set<string>();
  const child = (isStatic = false) => ({
    hasAttribute: (name: string) => isStatic && name === 'data-motion-static',
    animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      let settle!: () => void, fail!: (e: Error) => void;
      const finished = new Promise<void>((resolve, reject) => { settle = resolve; fail = reject; });
      const fake: Fake & { finished: Promise<void>; effect: unknown; cancel(): void; finish(): void } = {
        keyframes, options, playState: 'running', cancelled: false, progress: 0, finished,
        effect: { getComputedTiming: () => ({ progress: fake.progress }) },
        cancel() { fake.cancelled = true; fake.playState = 'idle'; fail(new Error('cancelled')); },
        finish() { fake.playState = 'finished'; settle(); },
      };
      made.push(fake); return fake;
    },
  });
  const pane = {
    children: [...Array.from({ length: count }, () => child()), child(true)],
    setAttribute: (name: string) => attrs.add(name), removeAttribute: (name: string) => attrs.delete(name),
  };
  return { pane: pane as unknown as HTMLElement, made, attrs };
}

test('a newer navigation cancels the running entrance and carries its opacity; nothing queues', () => {
  const { pane, made, attrs } = fakePane(2);
  playPageEnter(pane, 'forward', false);
  assert.equal(made.length, 2, 'static children (launcher) are not animated');
  assert.ok(attrs.has(PAGE_MOTION_ATTRIBUTE), 'rightward travel guards the horizontal scrollbar');
  made.forEach(fake => { fake.progress = 0.6; });
  playPageEnter(pane, 'back', false);
  assert.ok(made.slice(0, 2).every(fake => fake.cancelled), 'previous entrance cancelled');
  assert.equal(made.length, 4);
  assert.equal(made[2]!.keyframes[0]!.opacity, 0.6, 'continues from the visible opacity');
  assert.ok(!attrs.has(PAGE_MOTION_ATTRIBUTE), 'leftward travel needs no guard');
});

test('reduced motion plays opacity only', () => {
  const { pane, made } = fakePane(1);
  playPageEnter(pane, 'forward', true);
  assert.deepEqual(made[0]!.keyframes, [{ opacity: LATERAL_FROM_OPACITY }, { opacity: 1 }]);
});

test('an anchored panel knows whether it opened below or above its trigger', () => {
  assert.equal(anchorSide({ top: 100, bottom: 128 }, { top: 134, bottom: 300 }), 'below');
  assert.equal(anchorSide({ top: 700, bottom: 728 }, { top: 500, bottom: 694 }), 'above');
});

test('motion.css mirrors the token values, names its properties and ships reduced motion', () => {
  const css = readFileSync(new URL('../packages/ui/src/motion/motion.css', import.meta.url), 'utf8');
  const value = (name: string) => css.match(new RegExp(`--magic-motion-${name}:\\s*([^;]+);`))?.[1]?.trim();
  assert.equal(value('ease-out'), MOTION_EASE.out);
  assert.equal(value('ease-drawer'), MOTION_EASE.drawer);
  assert.equal(value('overlay-enter'), `${MOTION_MS.overlayEnter}ms`);
  assert.equal(value('overlay-exit'), `${MOTION_MS.overlayExit}ms`);
  assert.equal(value('disclosure'), `${MOTION_MS.disclosure}ms`);
  assert.equal(value('drawer'), `${MOTION_MS.drawer}ms`);
  assert.ok(MOTION_MS.overlayExit < MOTION_MS.overlayEnter, 'closing snaps faster than opening');
  assert.doesNotMatch(css, /transition(-property)?:\s*all/);
  assert.doesNotMatch(css, /\bease-in\b(?!-out)/);
  assert.doesNotMatch(css, /scale\(/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
