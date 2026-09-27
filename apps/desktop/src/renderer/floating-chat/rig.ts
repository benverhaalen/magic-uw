// owner: floating-chat. The wizard's animation state machine. One rig drives one inline copy of
// wizard.svg: the loops and the hover wave are CSS keyframes inside the SVG (keyed on data-state), and
// the one-shots (answered burst, error tilt, snap settle) are Web Animations sequenced here.
// Budget: at most two parts move at once, every one-shot is at most 1.2 s, transforms and opacity only.
// Reduced motion shows a static wizard; the host shows `wizardLabel(state)` as text instead.

export type WizardState = "idle" | "hover" | "listening" | "thinking" | "answered" | "error" | "settle";
export const WIZARD_STATES: readonly WizardState[] = ["idle", "hover", "listening", "thinking", "answered", "error", "settle"];

/** Held until another base state is set. */
type Base = "idle" | "listening" | "thinking";
/** Played once, then the base shows again. `settle` plays on the whole figure without replacing the state. */
type Shot = "hover" | "answered" | "error";
export interface WizardModel { base: Base; shot: Shot | null }
export type WizardPlay = Shot | "settle" | null;

export const WIZARD_IDLE: WizardModel = { base: "idle", shot: null };
/** One-shot lengths. The hover wave and its sparkles are timed in wizard.svg; keep these in step. */
export const WIZARD_SHOT_MS = { hover: 1100, answered: 800, error: 1000, settle: 360 } as const;

const isBase = (s: WizardState): s is Base => s === "idle" || s === "listening" || s === "thinking";

/**
 * The next model for a requested state, and the one-shot to play. Rules:
 * a base state replaces the base and cancels a hover wave (a result shot still finishes);
 * hover waves only from a quiet idle; answered and error always play (a newer one replaces the older);
 * settle plays without changing what is shown.
 */
export function wizardNext(model: WizardModel, requested: WizardState): { model: WizardModel; play: WizardPlay } {
  if (isBase(requested)) return { model: { base: requested, shot: model.shot === "hover" ? null : model.shot }, play: null };
  if (requested === "settle") return { model, play: "settle" };
  if (requested === "hover") {
    if (model.base !== "idle" || model.shot) return { model, play: null };
    return { model: { ...model, shot: "hover" }, play: "hover" };
  }
  return { model: { ...model, shot: requested }, play: requested };
}
/** A one-shot finished. Only the shot that is still current clears. */
export function wizardDone(model: WizardModel, shot: Shot): WizardModel {
  return model.shot === shot ? { ...model, shot: null } : model;
}
/** What the SVG shows (its data-state). */
export function wizardShown(model: WizardModel): Exclude<WizardState, "settle"> {
  return model.shot ?? model.base;
}
/** Text for reduced motion (and for anyone who cannot see the figure). Null when nothing is happening. */
export function wizardLabel(shown: WizardState): string | null {
  return shown === "listening" ? "Listening" : shown === "thinking" ? "Thinking" : shown === "answered" ? "Answered" : shown === "error" ? "Couldn't answer" : null;
}
/** Parts moving at once per shown state, for the two-at-once budget (checked by tests). */
export const WIZARD_MOVING: Record<Exclude<WizardState, "settle">, readonly string[]> = {
  idle: ["hat", "eyes"],
  hover: ["arm", "sparkles"],
  listening: ["glow", "eyes"],
  thinking: ["sparkles", "eyes"],
  answered: ["sparkles"],
  error: ["head"],
};

/** Web Animations for the one-shots, as data so tests can check the budget. */
export function wizardShotPlan(shot: "answered" | "error" | "settle") {
  const out = { duration: 0, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "none" as const };
  if (shot === "settle") return {
    target: "#wizard",
    keyframes: [{ transform: "scale(1)" }, { transform: "scale(1.07, 0.9)", offset: 0.3 }, { transform: "scale(0.97, 1.04)", offset: 0.65 }, { transform: "scale(1)" }],
    options: { ...out, duration: WIZARD_SHOT_MS.settle },
  };
  if (shot === "error") return {
    target: "#head",
    keyframes: [{ transform: "rotate(0)" }, { transform: "rotate(-9deg)", offset: 0.25 }, { transform: "rotate(-9deg)", offset: 0.7 }, { transform: "rotate(0)" }],
    options: { ...out, duration: WIZARD_SHOT_MS.error },
  };
  // Each spark travels out from the wand tip, flares and fades; staggered 50 ms.
  return {
    target: ".s",
    keyframes: [{ opacity: 0, transform: "scale(0)" }, { opacity: 1, transform: "scale(1.3)", offset: 0.35 }, { opacity: 0, transform: "scale(0.5)" }],
    options: { ...out, duration: WIZARD_SHOT_MS.answered - 150 },
    stagger: 50,
  };
}

export interface WizardRig {
  setState(state: WizardState): void;
  /** Dictation input level 0..1 from the real analyser while listening; null returns to the slow pulse. */
  setLevel(level: number | null): void;
  readonly shown: Exclude<WizardState, "settle">;
  destroy(): void;
}
export interface WizardRigOptions {
  /** Reads the current preference; defaults to the media query. */
  reducedMotion?: () => boolean;
  /** Called whenever the shown state changes (hosts use it for the reduced-motion label). */
  onChange?: (shown: Exclude<WizardState, "settle">) => void;
}

/** Drives one inline wizard.svg. Pauses while the window is hidden or not focused. */
export function createWizardRig(svg: SVGSVGElement, options: WizardRigOptions = {}): WizardRig {
  const win = svg.ownerDocument.defaultView;
  const reduced = options.reducedMotion ?? (() => win?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false);
  let model = WIZARD_IDLE;
  const running = new Set<Animation>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let paused = false;

  const render = () => {
    const shown = wizardShown(model);
    if (svg.dataset.state !== shown) svg.dataset.state = shown;
    options.onChange?.(shown);
  };
  const finish = (shot: Shot) => { model = wizardDone(model, shot); render(); };
  const later = (ms: number, run: () => void) => {
    const t = setTimeout(() => { timers.delete(t); run(); }, ms);
    timers.add(t);
  };
  const animate = (shot: "answered" | "error" | "settle", done: () => void) => {
    const plan = wizardShotPlan(shot);
    const targets = Array.from(svg.querySelectorAll<SVGElement>(plan.target));
    if (!targets.length || typeof targets[0]!.animate !== "function") return done();
    const list = targets.map((node, i) => {
      node.style.willChange = "transform, opacity";
      const a = node.animate(plan.keyframes, { ...plan.options, delay: "stagger" in plan ? i * plan.stagger! : 0 });
      running.add(a);
      if (paused) a.pause();
      return a;
    });
    Promise.all(list.map((a) => a.finished)).then(() => {
      targets.forEach((node) => node.style.removeProperty("will-change"));
      list.forEach((a) => running.delete(a));
      done();
    }, () => {
      targets.forEach((node) => node.style.removeProperty("will-change"));
      list.forEach((a) => running.delete(a));
    });
  };

  const play = (what: WizardPlay) => {
    if (!what) return;
    if (reduced()) {
      // No movement: the label carries answered/error for a moment, then idle again.
      if (what === "answered" || what === "error") later(1200, () => finish(what));
      else if (what === "hover") finish("hover");
      return;
    }
    if (what === "hover") return later(WIZARD_SHOT_MS.hover, () => finish("hover"));
    if (what === "settle") {
      svg.setAttribute("data-settling", "");
      return animate("settle", () => svg.removeAttribute("data-settling"));
    }
    // A newer result shot replaces a running one.
    for (const a of running) a.cancel();
    running.clear();
    animate(what, () => finish(what));
  };

  const syncPause = () => {
    const doc = svg.ownerDocument;
    const next = doc.hidden || !doc.hasFocus();
    if (next === paused) return;
    paused = next;
    svg.toggleAttribute("data-paused", paused);
    for (const a of running) paused ? a.pause() : a.play();
  };
  win?.addEventListener("blur", syncPause);
  win?.addEventListener("focus", syncPause);
  svg.ownerDocument.addEventListener("visibilitychange", syncPause);
  syncPause();
  render();

  return {
    setState(state) {
      const next = wizardNext(model, state);
      model = next.model;
      render();
      play(next.play);
    },
    setLevel(level) {
      if (level == null || !Number.isFinite(level)) {
        svg.removeAttribute("data-level");
        svg.style.removeProperty("--level");
        return;
      }
      svg.setAttribute("data-level", "");
      svg.style.setProperty("--level", String(Math.max(0, Math.min(1, level))));
    },
    get shown() { return wizardShown(model); },
    destroy() {
      win?.removeEventListener("blur", syncPause);
      win?.removeEventListener("focus", syncPause);
      svg.ownerDocument.removeEventListener("visibilitychange", syncPause);
      for (const a of running) a.cancel();
      running.clear();
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
