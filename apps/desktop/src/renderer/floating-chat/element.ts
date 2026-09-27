// owner: floating-chat. <magic-floating-chat>: the launcher, the "Click to chat" pill and the panel
// chrome, rendered in a shadow root so page styles cannot reach them. The panel's content is the
// host's own light DOM: `slot="body"` for the conversation, `slot="footer"` for the composer. The
// element owns placement, dragging, snapping, keyboard and the wizard rig; it knows nothing about
// chats. It announces what happened with events (see README.md) and exposes setWizardState().
import wizardSvg from "./wizard.svg?raw";
import css from "./element.css?inline";
import { createWizardRig, wizardLabel, type WizardRig, type WizardState } from "./rig";
import {
  beginPress, cornerName, cornerPoint, endPress, launcherKey, movePress, nearestCorner, placePanel, readCorner, readIntroSeen,
  readSize, resizeBy, resizeForKey, safeStorage, snapMotion, writeCorner, writeIntroSeen, writeSize,
  type Corner, type Point, type Press, type Rect, type Size,
} from "./model";

export const FLOATING_CHAT_TAG = "magic-floating-chat";
export type FloatingChatCloseReason = "toggle" | "escape" | "minimise" | "end";
export type FloatingChatWarmTrigger = "hover" | "open";
export interface FloatingChatEvents {
  "floating-chat-open": CustomEvent<Record<string, never>>;
  "floating-chat-close": CustomEvent<{ reason: FloatingChatCloseReason }>;
  /**
   * Once per session, on the first hover or keyboard focus of the launcher (`trigger: "hover"`) or
   * the first open (`"open"`): warm the chat path now. Cancel it to decline; the next one asks again.
   */
  "floating-chat-warm": CustomEvent<{ trigger: FloatingChatWarmTrigger }>;
  "floating-chat-move": CustomEvent<{ corner: Corner }>;
}

// Lucide 0.468.0 nodes (ISC); attribution: packages/ui/LICENSE.icons.
const glyph = (paths: string) => `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
const MINUS = glyph('<path d="M5 12h14"/>');
const X = glyph('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');

const TEMPLATE = `
<section class="panel" id="panel" role="dialog" aria-modal="false" aria-labelledby="title" inert>
  <header class="head">
    <h2 class="title" id="title">Chat</h2>
    <span class="scope" hidden><span class="scope-value"></span></span>
    <span class="spacer"></span>
    <button type="button" class="icon" data-action="minimise" aria-label="Minimise chat" title="Minimise">${MINUS}</button>
    <button type="button" class="icon" data-action="end" aria-label="Close chat" title="Close">${X}</button>
  </header>
  <div class="body"><slot name="body"></slot></div>
  <div class="foot"><slot name="footer"></slot></div>
  <button type="button" class="grip" aria-label="Resize chat" title="Drag or use the arrow keys to resize"></button>
</section>
<div class="dock">
  <button type="button" class="launcher" aria-label="Open chat" aria-expanded="false" aria-controls="panel" aria-haspopup="dialog">
    <span class="disc"></span><span class="figure">${wizardSvg}</span><span class="state" aria-hidden="true"></span>
  </button>
  <span class="pill" aria-hidden="true">Click to chat</span>
</div>
<p class="sr" role="status" aria-live="polite"></p>`;

const SESSION_WARM = "magic.floatingChat.warmed";
let warmedThisPage = false;
function warmedAlready(): boolean {
  if (warmedThisPage) return true;
  try { return sessionStorage.getItem(SESSION_WARM) === "1"; } catch { return false; }
}
function markWarmed() {
  warmedThisPage = true;
  try { sessionStorage.setItem(SESSION_WARM, "1"); } catch { /* no session storage: the page flag still limits it to once */ }
}

type Drag = { kind: "launcher" | "head"; press: Press; pointerId: number; from: Point }
  | { kind: "grip"; press: Press; pointerId: number; from: Size };

export class MagicFloatingChat extends HTMLElement {
  static observedAttributes = ["scope-label", "avoid"];
  readonly #shadow: ShadowRoot;
  readonly #dock: HTMLElement;
  readonly #launcher: HTMLButtonElement;
  readonly #panel: HTMLElement;
  readonly #head: HTMLElement;
  readonly #grip: HTMLButtonElement;
  readonly #scope: HTMLElement;
  readonly #live: HTMLElement;
  readonly #state: HTMLElement;
  readonly #svg: SVGSVGElement;
  #rig: WizardRig | null = null;
  #storage = safeStorage();
  #corner: Corner = "bottom-right";
  #size: Size = { width: 380, height: 520 };
  #at: Point = { x: 0, y: 0 };
  #open = false;
  #drag: Drag | null = null;
  #suppressClick = false;
  #snapTimer: ReturnType<typeof setTimeout> | null = null;
  #frame = 0;
  #abort: AbortController | null = null;
  /** Avoided regions can change size without a window resize (the sidebar collapses). */
  #observer: ResizeObserver | null = null;

  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: "open" });
    this.#shadow.innerHTML = `<style>${css}</style>${TEMPLATE}`;
    const $ = <T extends Element>(selector: string) => this.#shadow.querySelector<T>(selector)!;
    this.#dock = $(".dock");
    this.#launcher = $(".launcher");
    this.#panel = $(".panel");
    this.#head = $(".head");
    this.#grip = $(".grip");
    this.#scope = $(".scope");
    this.#live = $(".sr");
    this.#state = $(".state");
    this.#svg = $("svg:not(.glyph)");
    // Inside the button the figure is decoration; the button carries the name.
    this.#svg.removeAttribute("role");
    this.#svg.removeAttribute("aria-label");
    this.#svg.setAttribute("aria-hidden", "true");
    this.#svg.setAttribute("focusable", "false");
  }

  connectedCallback() {
    this.#abort = new AbortController();
    const on = <K extends keyof HTMLElementEventMap>(target: EventTarget, type: K, handler: (event: HTMLElementEventMap[K]) => void) =>
      target.addEventListener(type, handler as EventListener, { signal: this.#abort!.signal });
    this.#corner = readCorner(this.#storage);
    this.#size = readSize(this.#storage);
    this.dataset.corner = this.#corner;
    this.toggleAttribute("data-intro", !readIntroSeen(this.#storage));
    this.#rig = createWizardRig(this.#svg, { onChange: (shown) => { this.#state.textContent = wizardLabel(shown) ?? ""; } });

    on(this.#launcher, "pointerdown", (e) => this.#pointerDown(e, "launcher"));
    on(this.#head, "pointerdown", (e) => { if (!(e.target as Element).closest("button")) this.#pointerDown(e, "head"); });
    on(this.#grip, "pointerdown", (e) => this.#pointerDown(e, "grip"));
    for (const node of [this.#launcher, this.#head, this.#grip]) {
      on(node, "pointermove", (e) => this.#pointerMove(e));
      on(node, "pointerup", (e) => this.#pointerUp(e, false));
      on(node, "pointercancel", (e) => this.#pointerUp(e, true));
    }
    on(this.#launcher, "click", () => {
      if (this.#suppressClick) { this.#suppressClick = false; return; }
      this.toggle();
    });
    on(this.#launcher, "pointerenter", (e) => {
      this.#warm("hover");
      if (e.pointerType === "mouse" && !this.#drag) this.#rig?.setState("hover");
    });
    on(this.#launcher, "focus", () => {
      this.#warm("hover");
      if (this.#launcher.matches(":focus-visible")) this.#rig?.setState("hover");
    });
    on(this.#launcher, "keydown", (e) => {
      const action = launcherKey(e.key, this.#corner, this.#open);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      if (action.kind === "close") this.close("escape");
      else this.moveTo(action.corner, { announce: true });
    });
    on(this.#grip, "keydown", (e) => {
      const next = resizeForKey(this.#corner, this.#size, e.key);
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      this.#size = next;
      writeSize(this.#storage, next);
      this.#placePanel();
    });
    on(this.#head, "click", (e) => {
      const action = (e.target as Element).closest<HTMLElement>("[data-action]")?.dataset.action;
      if (action === "minimise") this.close("minimise");
      else if (action === "end") this.close("end");
    });
    // Escape from anywhere in the panel, including the slotted conversation and composer.
    on(this, "keydown", (e) => {
      if (e.key !== "Escape" || e.isComposing || e.defaultPrevented || !this.#open) return;
      e.preventDefault();
      this.close("escape");
    });
    on(window, "resize", () => this.#schedule());
    this.#observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.#schedule());
    requestAnimationFrame(() => { this.#layout(false); this.setAttribute("data-ready", ""); });
  }

  disconnectedCallback() {
    this.#abort?.abort();
    this.#abort = null;
    this.#observer?.disconnect();
    this.#observer = null;
    this.#rig?.destroy();
    this.#rig = null;
    cancelAnimationFrame(this.#frame);
    if (this.#snapTimer) clearTimeout(this.#snapTimer);
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    if (name === "scope-label") {
      this.#scope.hidden = !value;
      this.#scope.querySelector(".scope-value")!.textContent = value ?? "";
      this.#scope.title = value ? `Scope: ${value}` : "";
      this.#scope.setAttribute("aria-label", value ? `Scope: ${value}` : "");
    } else if (name === "avoid") this.#schedule();
  }

  get isOpen() { return this.#open; }
  get corner() { return this.#corner; }

  open() {
    if (this.#open || this.hidden) return;
    this.#open = true;
    this.#placePanel();
    this.setAttribute("open", "");
    this.#panel.inert = false;
    this.#launcher.setAttribute("aria-expanded", "true");
    if (this.hasAttribute("data-intro")) { this.removeAttribute("data-intro"); writeIntroSeen(this.#storage); }
    this.#emit("floating-chat-open", {});
    this.#warm("open");
    requestAnimationFrame(() => {
      const target = this.querySelector<HTMLElement>("[data-autofocus]") ?? this.#shadow.querySelector<HTMLElement>(".head button");
      target?.focus({ preventScroll: true });
    });
  }

  /** `restoreFocus` false when the page hides the element (onboarding): focus stays where the page put it. */
  close(reason: FloatingChatCloseReason = "toggle", restoreFocus = true) {
    if (!this.#open) return;
    this.#open = false;
    this.removeAttribute("open");
    this.#panel.inert = true;
    this.#launcher.setAttribute("aria-expanded", "false");
    this.#emit("floating-chat-close", { reason });
    if (restoreFocus) this.#launcher.focus({ preventScroll: true });
  }

  toggle() { if (this.#open) this.close("toggle"); else this.open(); }

  /** Drives the wizard. The chat host sets thinking/answered/error; a dictation owner sets listening. */
  setWizardState(state: WizardState) { this.#rig?.setState(state); }
  /** Dictation input level 0..1 from the real analyser; null returns to the slow pulse. */
  setWizardLevel(level: number | null) { this.#rig?.setLevel(level); }

  /** Moves the launcher (and the panel with it) to a corner, remembering the choice. */
  moveTo(corner: Corner, options: { announce?: boolean } = {}) {
    const changed = corner !== this.#corner;
    this.#corner = corner;
    this.dataset.corner = corner;
    writeCorner(this.#storage, corner);
    this.#layout(true);
    if (options.announce) this.#live.textContent = changed ? `Chat moved to ${cornerName(corner)}` : `Chat is in the ${cornerName(corner)} corner`;
    if (changed) this.#emit("floating-chat-move", { corner });
  }

  #emit<K extends keyof FloatingChatEvents>(type: K, detail: FloatingChatEvents[K]["detail"]) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /** Once per session. A host that may not warm on this trigger cancels the event, so a later one can ask again. */
  #warm(trigger: FloatingChatWarmTrigger) {
    if (warmedAlready()) return;
    const event = new CustomEvent("floating-chat-warm", { detail: { trigger }, bubbles: true, composed: true, cancelable: true });
    if (this.dispatchEvent(event)) markWarmed();
  }

  #reduced() { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
  #inset() { return parseFloat(getComputedStyle(this).getPropertyValue("--floating-chat-inset")) || 16; }
  #view(): Size { return { width: document.documentElement.clientWidth || window.innerWidth, height: document.documentElement.clientHeight || window.innerHeight }; }
  #box(): Size { return { width: this.#dock.offsetWidth || 60, height: this.#dock.offsetHeight || 72 }; }
  #avoided(): Rect[] {
    const selector = this.getAttribute("avoid");
    if (!selector) return [];
    try {
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const node of nodes) this.#observer?.observe(node);
      return nodes.map((node) => node.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0).map(({ left, top, right, bottom }) => ({ left, top, right, bottom }));
    } catch { return []; }
  }
  #schedule() {
    cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => this.#layout(false));
  }
  #setDock(point: Point) {
    this.#at = point;
    this.#dock.style.transform = `translate3d(${Math.round(point.x)}px, ${Math.round(point.y)}px, 0)`;
  }

  /** Puts the launcher in its corner. `animate` travels there along the drawer curve, then settles. */
  #layout(animate: boolean) {
    if (this.#drag) return;
    const target = cornerPoint(this.#corner, this.#view(), this.#box(), this.#inset(), this.#avoided());
    const motion = snapMotion(this.#reduced());
    const travels = animate && motion.animate && (Math.abs(target.x - this.#at.x) > 1 || Math.abs(target.y - this.#at.y) > 1);
    if (!travels) {
      this.#setDock(target);
      this.#placePanel();
      return;
    }
    this.setAttribute("data-snapping", "");
    this.#setDock(target);
    if (this.#snapTimer) clearTimeout(this.#snapTimer);
    const ms = parseFloat(getComputedStyle(this.#dock).transitionDuration) * 1000 || 220;
    this.#snapTimer = setTimeout(() => {
      this.#snapTimer = null;
      this.#placePanel();
      this.removeAttribute("data-snapping");
      if (motion.settle) this.#rig?.setState("settle");
    }, ms + 20);
  }

  #placePanel() {
    const box = this.#box();
    const dock: Rect = { left: this.#at.x, top: this.#at.y, right: this.#at.x + box.width, bottom: this.#at.y + box.height };
    const p = placePanel(this.#corner, dock, this.#view(), this.#size, this.#inset(), this.#avoided());
    Object.assign(this.#panel.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${p.width}px`, height: `${p.height}px`, transformOrigin: p.origin });
  }

  #pointerDown(e: PointerEvent, kind: Drag["kind"]) {
    if (e.button !== 0 || !e.isPrimary) return;
    this.#suppressClick = false;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const press = beginPress({ x: e.clientX, y: e.clientY });
    this.#drag = kind === "grip" ? { kind, press, pointerId: e.pointerId, from: this.#size } : { kind, press, pointerId: e.pointerId, from: this.#at };
    if (kind !== "launcher") e.preventDefault();
  }

  #pointerMove(e: PointerEvent) {
    const drag = this.#drag;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const was = drag.press.dragging;
    drag.press = movePress(drag.press, { x: e.clientX, y: e.clientY });
    if (!drag.press.dragging) return;
    const dx = e.clientX - drag.press.start.x, dy = e.clientY - drag.press.start.y;
    if (drag.kind === "grip") {
      this.#size = resizeBy(this.#corner, drag.from, dx, dy);
      this.#placePanel();
      return;
    }
    if (!was) this.setAttribute("data-dragging", "");
    const view = this.#view(), box = this.#box();
    this.#setDock({
      x: Math.min(Math.max(drag.from.x + dx, 0), view.width - box.width),
      y: Math.min(Math.max(drag.from.y + dy, 0), view.height - box.height),
    });
  }

  #pointerUp(e: PointerEvent, cancelled: boolean) {
    const drag = this.#drag;
    if (!drag || drag.pointerId !== e.pointerId) return;
    this.#drag = null;
    const node = e.currentTarget as Element;
    if (node.hasPointerCapture(e.pointerId)) node.releasePointerCapture(e.pointerId);
    if (endPress(drag.press) === "click") return;
    if (drag.kind === "grip") { writeSize(this.#storage, this.#size); return; }
    if (drag.kind === "launcher" && !cancelled) this.#suppressClick = true;
    this.removeAttribute("data-dragging");
    const box = this.#box();
    this.moveTo(nearestCorner({ x: this.#at.x + box.width / 2, y: this.#at.y + box.height / 2 }, this.#view()), { announce: true });
  }
}

/** Registers the element once. Safe to call from every entry point. */
export function defineFloatingChat() {
  if (typeof customElements !== "undefined" && !customElements.get(FLOATING_CHAT_TAG)) customElements.define(FLOATING_CHAT_TAG, MagicFloatingChat);
}

/** Drives every mounted wizard (normally one): for a dictation button or a page without a handle. */
export function setWizardState(state: WizardState, level?: number | null) {
  for (const node of Array.from(document.querySelectorAll(FLOATING_CHAT_TAG)))
    if (node instanceof MagicFloatingChat) {
      node.setWizardState(state);
      if (level !== undefined) node.setWizardLevel(level);
    }
}

declare global {
  interface HTMLElementTagNameMap { "magic-floating-chat": MagicFloatingChat }
}
