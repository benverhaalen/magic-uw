import { Component, createRef, type ReactNode } from 'react';
import { MOTION_EASE, MOTION_MS } from '../../../../../packages/ui/src/motion/tokens';

type Box = { top: number; left: number; height: number; opacity: number };
type Region = { node: HTMLElement; box: Box; children: Map<HTMLElement, Box> };
type Snapshot = Region[];
const DURATION = MOTION_MS.disclosure;
const EASING = MOTION_EASE.out;
const box = (node: HTMLElement): Box => {
  const rect = node.getBoundingClientRect();
  return { top: rect.top, left: rect.left, height: rect.height, opacity: Number(getComputedStyle(node).opacity) };
};

/** Measure before React changes the DOM, then animate the retained nodes in their final layout.
 * No snapshots/clones of interactive DOM and no delayed data or completion-state changes.
 * The height animations participate in flow; subsequent sections and the scrollbar follow them.
 */
export class HomeMotion extends Component<{ children: ReactNode }> {
  private root = createRef<HTMLDivElement>();
  private running = new Set<Animation>();
  private clipped = new Map<HTMLElement, string>();
  private media: MediaQueryList | undefined;
  private stop = () => {
    for (const animation of this.running) animation.cancel();
    this.running.clear();
    for (const [node, overflow] of this.clipped) node.style.overflow = overflow;
    this.clipped.clear();
  };
  componentDidMount() {
    this.media = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.media.addEventListener('change', this.stop);
    window.addEventListener('resize', this.stop);
  }
  componentWillUnmount() {
    this.stop();
    this.media?.removeEventListener('change', this.stop);
    window.removeEventListener('resize', this.stop);
  }
  getSnapshotBeforeUpdate(): Snapshot {
    const root = this.root.current;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>('.home-briefing, .home-upcoming > .home-work-list')).map(node => ({
      node, box: box(node), children: new Map(Array.from(node.children)
        .filter((child): child is HTMLElement => child instanceof HTMLElement)
        .flatMap(child => {
          const aside = child.querySelector<HTMLElement>('.magic-handled-briefing__aside');
          return aside ? [[child, box(child)] as const, [aside, box(aside)] as const] : [[child, box(child)] as const];
        })),
    }));
  }
  componentDidUpdate(_previous: Readonly<{ children: ReactNode }>, _state: unknown, snapshot: Snapshot) {
    // Snapshot captured the current animated positions. Cancel only after capturing, so a reversal
    // starts at what the student can see rather than replaying an old endpoint.
    this.stop();
    if (this.media?.matches || !this.root.current) return;
    const regions = snapshot.filter(region => region.node.isConnected);
    // Read all target geometry before starting any layout-affecting height animation.
    const targets = regions.map(region => ({ region, target: box(region.node), children: Array.from(region.node.children)
      .filter((child): child is HTMLElement => child instanceof HTMLElement)
      .map(child => ({ node: child, target: box(child), aside: child.querySelector<HTMLElement>('.magic-handled-briefing__aside') })) }));
    const asideTargets = new Map<HTMLElement, Box>();
    for (const { children } of targets) for (const child of children) if (child.aside) asideTargets.set(child.aside, box(child.aside));
    for (const { region, target, children } of targets) {
      if (Math.abs(region.box.height - target.height) > .5) {
        // Clip only the work list: open evidence popovers in Briefing must remain accessible.
        if (region.node.classList.contains('home-work-list')) {
          this.clipped.set(region.node, region.node.style.overflow);
          region.node.style.overflow = 'clip';
        }
        this.play(region.node, [{ height: `${region.box.height}px` }, { height: `${target.height}px` }], () => {
          const overflow = this.clipped.get(region.node);
          if (overflow !== undefined) { region.node.style.overflow = overflow; this.clipped.delete(region.node); }
        });
      }
      for (const child of children) {
        const old = region.children.get(child.node);
        const dy = old ? (old.top - region.box.top) - (child.target.top - target.top) : 0;
        const dx = old ? (old.left - region.box.left) - (child.target.left - target.left) : 0;
        if (old && (Math.abs(dx) > .5 || Math.abs(dy) > .5)) {
          this.play(child.node, [{ transform: `translate(${dx}px, ${dy}px)`, opacity: old.opacity }, { transform: 'none', opacity: 1 }]);
        } else if (!old || old.opacity < .99) {
          this.play(child.node, [{ opacity: old?.opacity ?? .65 }, { opacity: 1 }]);
        }
        if (child.aside) {
          const oldAside = region.children.get(child.aside), end = asideTargets.get(child.aside)!;
          if (oldAside) {
            // The passage itself may also be moving. Subtract that travel from the nested aside.
            const x = (oldAside.left - region.box.left) - (end.left - target.left) - dx;
            const y = (oldAside.top - region.box.top) - (end.top - target.top) - dy;
            if (Math.abs(x) > .5 || Math.abs(y) > .5) this.play(child.aside, [{ transform: `translate(${x}px, ${y}px)` }, { transform: 'none' }]);
          }
        }
      }
    }
  }
  private play(node: HTMLElement, keyframes: Keyframe[], done?: () => void) {
    if (typeof node.animate !== 'function') { done?.(); return; }
    const animation = node.animate(keyframes, { duration: DURATION, easing: EASING, fill: 'none' });
    this.running.add(animation);
    void animation.finished.then(() => {
      if (this.running.delete(animation)) done?.();
    }, () => { this.running.delete(animation); });
  }
  render() { return <div ref={this.root} className="home-reading" data-home-motion>{this.props.children}</div>; }
}
