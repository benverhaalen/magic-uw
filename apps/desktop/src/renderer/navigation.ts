import { useLayoutEffect, useRef, useState } from 'react';
export type DesktopView = 'today' | 'courses' | 'myuw' | 'calendar' | 'resource' | 'sources' | 'privacy' | 'consent' | 'notebook' | 'practice' | 'insights' | 'settings';
type Place = { view: DesktopView; resourceId: string | null; scroll: number; focus: string | null; anchor: string | null; offset: number };
const initial: Place = { view: 'today', resourceId: null, scroll: 0, focus: null, anchor: null, offset: 0 };
export const resourceHref = (id: string) => `#resource/${encodeURIComponent(id)}`;
export function useDesktopNavigation() {
  const [stack, setStack] = useState<Place[]>([initial]);
  const [index, setIndex] = useState(0);
  const pending = useRef<Place | null>(null);
  const current = stack[index]!;
  function capture(): Place {
    const pane = document.querySelector<HTMLElement>('.desktop-workspace');
    const active = document.activeElement as HTMLElement | null;
    const focus = active?.getAttribute('data-focus-key') ?? (active?.closest('a')?.getAttribute('href') ?? null);
    const anchors = Array.from(pane?.querySelectorAll<HTMLElement>('[data-place-anchor]') ?? []);
    const top = pane?.getBoundingClientRect().top ?? 0;
    const anchor = anchors.find(node => node.getBoundingClientRect().bottom > top);
    return { ...current, scroll: pane?.scrollTop ?? 0, focus, anchor: anchor?.dataset.placeAnchor ?? null, offset: anchor ? anchor.getBoundingClientRect().top - top : 0 };
  }
  function navigate(view: DesktopView, resourceId: string | null = null) {
    if (current.view === view && current.resourceId === resourceId) return;
    const next = { ...initial, view, resourceId };
    const saved = stack.slice(0, index + 1); saved[index] = capture();
    pending.current = next; setStack([...saved, next]); setIndex(saved.length);
  }
  function travel(delta: number) {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= stack.length) return;
    const saved = [...stack]; saved[index] = capture();
    pending.current = saved[nextIndex]!; setStack(saved); setIndex(nextIndex);
  }
  useLayoutEffect(() => {
    const place = pending.current; if (!place) return;
    pending.current = null;
    const pane = document.querySelector<HTMLElement>('.desktop-workspace');
    if (!pane) return;
    const anchor = Array.from(pane.querySelectorAll<HTMLElement>('[data-place-anchor]')).find(node => node.dataset.placeAnchor === place.anchor);
    pane.scrollTop = anchor ? pane.scrollTop + anchor.getBoundingClientRect().top - pane.getBoundingClientRect().top - place.offset : place.scroll;
    const focus = Array.from(document.querySelectorAll<HTMLElement>('[data-focus-key], a[href]')).find(node => node.dataset.focusKey === place.focus || node.getAttribute('href') === place.focus);
    (focus ?? pane.querySelector<HTMLElement>('h1, h2'))?.focus({ preventScroll: true });
  }, [index, current.view, current.resourceId]);
  return { view: current.view, selectedId: current.resourceId, navigate, back: () => travel(-1), forward: () => travel(1), canBack: index > 0, canForward: index < stack.length - 1 };
}
