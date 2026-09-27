// owner: floating-chat. Pure geometry and input rules for the floating chat. The custom element only
// adapts these to the DOM, so every rule here is testable without a browser.

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export const CORNERS: readonly Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
export const DEFAULT_CORNER: Corner = "bottom-right";

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Rect { left: number; top: number; right: number; bottom: number }

/** A press that travels less than this (CSS px) is a click; this far or more is a drag. */
export const DRAG_THRESHOLD = 5;
/** Gap between the launcher and the panel it opens. */
export const PANEL_GAP = 10;
export const PANEL_DEFAULT: Size = { width: 380, height: 520 };
export const PANEL_MIN: Size = { width: 300, height: 320 };
export const PANEL_MAX: Size = { width: 640, height: 820 };
/** One keyboard resize step. */
export const RESIZE_STEP = 24;

export const isLeft = (c: Corner) => c.endsWith("left");
export const isTop = (c: Corner) => c.startsWith("top");
export const cornerOf = (top: boolean, left: boolean): Corner => `${top ? "top" : "bottom"}-${left ? "left" : "right"}`;
export const cornerName = (c: Corner) => c.replace("-", " ");

/**
 * One press on the launcher or the panel header. Movement below the threshold never counts; once a
 * press passes it, it stays a drag even if the pointer comes back.
 */
export interface Press { start: Point; dragging: boolean }
export const beginPress = (start: Point): Press => ({ start, dragging: false });
export function movePress(press: Press, now: Point, threshold = DRAG_THRESHOLD): Press {
  if (press.dragging) return press;
  return Math.hypot(now.x - press.start.x, now.y - press.start.y) >= threshold ? { ...press, dragging: true } : press;
}
export const endPress = (press: Press): "click" | "drag" => (press.dragging ? "drag" : "click");

/** The corner of the window nearest to a point (the launcher's centre on release). */
export function nearestCorner(point: Point, view: Size): Corner {
  return cornerOf(point.y < view.height / 2, point.x < view.width / 2);
}

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** A tall region at a window side (a sidebar): it narrows the frame instead of pushing up or down. */
export const isSideColumn = (r: Rect, view: Size) => r.bottom - r.top >= view.height / 2 && r.right - r.left < view.width / 2;
/** The horizontal frame left between side columns. */
export function horizontalBounds(view: Size, inset: number, avoid: readonly Rect[]): { left: number; right: number } {
  let left = inset, right = view.width - inset;
  for (const r of avoid) {
    if (!isSideColumn(r, view)) continue;
    if ((r.left + r.right) / 2 < view.width / 2) left = Math.max(left, r.right + inset);
    else right = Math.min(right, r.left - inset);
  }
  return { left, right };
}

/**
 * Where the launcher sits in a corner: inset from the window edges and beside any side column, then
 * moved vertically off any other avoided region it would cover (the shell header, a bottom bar).
 */
export function cornerPoint(corner: Corner, view: Size, box: Size, inset: number, avoid: readonly Rect[] = []): Point {
  const frame = horizontalBounds(view, inset, avoid);
  const x = isLeft(corner) ? frame.left : frame.right - box.width;
  let y = isTop(corner) ? inset : view.height - inset - box.height;
  const bars = avoid.filter((r) => !isSideColumn(r, view));
  // A few passes settle stacked regions (for example a bar directly above another).
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const r of bars) {
      if (!overlaps(x, x + box.width, r.left, r.right) || !overlaps(y, y + box.height, r.top, r.bottom)) continue;
      const next = isTop(corner) ? r.bottom + inset : r.top - inset - box.height;
      if (next !== y) { y = next; moved = true; }
    }
    if (!moved) break;
  }
  return { x: clamp(x, 0, view.width - box.width), y: clamp(y, 0, view.height - box.height) };
}

/** Arrow keys move the launcher between corners: left/right change the side, up/down the edge. */
export function cornerForKey(corner: Corner, key: string): Corner | null {
  if (key === "ArrowLeft") return isLeft(corner) ? null : cornerOf(isTop(corner), true);
  if (key === "ArrowRight") return isLeft(corner) ? cornerOf(isTop(corner), false) : null;
  if (key === "ArrowUp") return isTop(corner) ? null : cornerOf(true, isLeft(corner));
  if (key === "ArrowDown") return isTop(corner) ? cornerOf(false, isLeft(corner)) : null;
  return null;
}

/** Vertical room for the panel within a horizontal band, below the top regions and above the bottom ones. */
export function verticalBounds(left: number, right: number, view: Size, inset: number, avoid: readonly Rect[]): { top: number; bottom: number } {
  let top = inset, bottom = view.height - inset;
  for (const r of avoid) {
    if (isSideColumn(r, view) || !overlaps(left, right, r.left, r.right)) continue;
    if ((r.top + r.bottom) / 2 < view.height / 2) top = Math.max(top, r.bottom + inset);
    else bottom = Math.min(bottom, r.top - inset);
  }
  return { top, bottom };
}

export interface PanelPlacement {
  x: number; y: number; width: number; height: number;
  /** CSS transform-origin in px, at the launcher's centre, so the panel grows out of it. */
  origin: string;
}
/**
 * The panel opens beside the launcher's corner: above it for bottom corners, below it for top corners,
 * aligned to the same side. Its size is the student's chosen size, fitted to the room available.
 */
export function placePanel(corner: Corner, dock: Rect, view: Size, want: Size, inset: number, avoid: readonly Rect[] = []): PanelPlacement {
  const frame = horizontalBounds(view, inset, avoid);
  const span = Math.max(0, frame.right - frame.left);
  const width = clamp(want.width, Math.min(PANEL_MIN.width, span), Math.min(PANEL_MAX.width, span));
  const x = clamp(isLeft(corner) ? dock.left : dock.right - width, frame.left, frame.right - width);
  const room = verticalBounds(x, x + width, view, inset, avoid);
  let y: number, height: number;
  if (isTop(corner)) {
    y = dock.bottom + PANEL_GAP;
    height = clamp(want.height, Math.min(PANEL_MIN.height, room.bottom - y), Math.min(PANEL_MAX.height, room.bottom - y));
  } else {
    const bottom = dock.top - PANEL_GAP;
    height = clamp(want.height, Math.min(PANEL_MIN.height, bottom - room.top), Math.min(PANEL_MAX.height, bottom - room.top));
    y = bottom - height;
  }
  height = Math.max(0, height);
  const originX = (dock.left + dock.right) / 2 - x;
  const originY = (dock.top + dock.bottom) / 2 - y;
  return { x, y, width, height, origin: `${Math.round(originX)}px ${Math.round(originY)}px` };
}

/**
 * Resizing from the grip, which sits on the panel's free corner (away from the launcher). Dragging the
 * grip away from the launcher grows the panel.
 */
export function resizeBy(corner: Corner, start: Size, dx: number, dy: number): Size {
  const width = start.width + (isLeft(corner) ? dx : -dx);
  const height = start.height + (isTop(corner) ? dy : -dy);
  return { width: clamp(width, PANEL_MIN.width, PANEL_MAX.width), height: clamp(height, PANEL_MIN.height, PANEL_MAX.height) };
}
/** Arrow keys on the grip move it one step in that direction. */
export function resizeForKey(corner: Corner, size: Size, key: string, step = RESIZE_STEP): Size | null {
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key];
  return d ? resizeBy(corner, size, d[0]!, d[1]!) : null;
}

/** What a key does on the launcher. Enter and Space are the button's own click. */
export type LauncherKey = { kind: "move"; corner: Corner } | { kind: "close" } | null;
export function launcherKey(key: string, corner: Corner, open: boolean): LauncherKey {
  if (key === "Escape") return open ? { kind: "close" } : null;
  const next = cornerForKey(corner, key);
  return next ? { kind: "move", corner: next } : null;
}

/** Motion for a snap: animated along the drawer curve, or instant for reduced motion. */
export function snapMotion(reduced: boolean): { animate: boolean; settle: boolean } {
  return reduced ? { animate: false, settle: false } : { animate: true, settle: true };
}

// Persistence. localStorage can be missing, full or blocked; every access is wrapped.
export interface KeyValue { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const STORAGE_KEYS = {
  corner: "magic.floatingChat.corner",
  size: "magic.floatingChat.size",
  intro: "magic.floatingChat.introSeen",
  enabled: "magic.floatingChat.enabled",
} as const;
export function safeStorage(): KeyValue | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}
function read(storage: KeyValue | null, key: string): string | null {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}
function write(storage: KeyValue | null, key: string, value: string): boolean {
  try { storage?.setItem(key, value); return !!storage; } catch { return false; }
}
export function readCorner(storage: KeyValue | null): Corner {
  const value = read(storage, STORAGE_KEYS.corner);
  return (CORNERS as readonly string[]).includes(value ?? "") ? (value as Corner) : DEFAULT_CORNER;
}
export const writeCorner = (storage: KeyValue | null, corner: Corner) => write(storage, STORAGE_KEYS.corner, corner);
export function readSize(storage: KeyValue | null): Size {
  try {
    const parsed: unknown = JSON.parse(read(storage, STORAGE_KEYS.size) ?? "null");
    if (parsed && typeof parsed === "object" && "width" in parsed && "height" in parsed) {
      const { width, height } = parsed as { width: unknown; height: unknown };
      if (typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height))
        return { width: clamp(width, PANEL_MIN.width, PANEL_MAX.width), height: clamp(height, PANEL_MIN.height, PANEL_MAX.height) };
    }
  } catch { /* unreadable value: use the default */ }
  return PANEL_DEFAULT;
}
export const writeSize = (storage: KeyValue | null, size: Size) => write(storage, STORAGE_KEYS.size, JSON.stringify({ width: Math.round(size.width), height: Math.round(size.height) }));
export const readIntroSeen = (storage: KeyValue | null) => read(storage, STORAGE_KEYS.intro) === "1";
export const writeIntroSeen = (storage: KeyValue | null) => write(storage, STORAGE_KEYS.intro, "1");
/** The "Floating chat: on/off" setting. Default on; only an explicit "off" turns it off. */
export const readEnabled = (storage: KeyValue | null) => read(storage, STORAGE_KEYS.enabled) !== "off";
export const writeEnabled = (storage: KeyValue | null, on: boolean) => write(storage, STORAGE_KEYS.enabled, on ? "on" : "off");
