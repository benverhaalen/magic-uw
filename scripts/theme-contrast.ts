/**
 * Theme contrast from the shipped tokens. Resolves docs/design/tokens.css for a theme (light or
 * dark: the light-dark() branch) and an accent (the [data-accent] block over :root), then measures
 * WCAG 2.2 contrast for the pairs the system promises. Gradients are measured at every stop and
 * between stops; translucent colours are composited over their stated base.
 *
 * `pnpm exec tsx scripts/theme-contrast.ts` prints the tables recorded in docs/design/theming.md.
 * tests/theme-contrast.test.ts fails when a required pair drops below its threshold.
 */
import { readFileSync } from "node:fs";

export type Theme = "light" | "dark";
export const ACCENT_IDS = ["blue", "rose", "coral", "plum"] as const;
export type AccentId = (typeof ACCENT_IDS)[number];
export const DEFAULT_ACCENT: AccentId = "blue";

type Rgba = [number, number, number, number];

export function readTokens(path = new URL("../docs/design/tokens.css", import.meta.url)): string {
  return readFileSync(path, "utf8");
}

/** Declarations per top-level rule, in file order. @media blocks only hold color-scheme and are skipped. */
function blocks(css: string): { selectors: string[]; decls: Map<string, string> }[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  const out: { selectors: string[]; decls: Map<string, string> }[] = [];
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = new Map<string, string>();
    for (const d of m[2]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls.set(d[1]!, d[2]!.trim());
    out.push({ selectors: m[1]!.split(",").map((s) => s.trim()), decls });
  }
  return out;
}

/** Custom properties in effect on the root for an accent: :root rules, then that accent's block. */
export function tokenScope(css: string, accent: AccentId = DEFAULT_ACCENT): Map<string, string> {
  const scope = new Map<string, string>();
  const accentSelector = `[data-accent="${accent}"]`;
  for (const block of blocks(css)) {
    const applies = block.selectors.includes(":root") || (accent !== DEFAULT_ACCENT && block.selectors.includes(accentSelector));
    if (applies) for (const [k, v] of block.decls) scope.set(k, v);
  }
  return scope;
}

/** A token's value with var() and light-dark() resolved for the theme. */
export function resolve(scope: Map<string, string>, name: string, theme: Theme, depth = 0): string {
  if (depth > 20) throw new Error(`alias cycle at ${name}`);
  const raw = scope.get(name.startsWith("--") ? name : `--${name}`);
  if (raw === undefined) throw new Error(`unknown token ${name}`);
  let value = raw.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_, ref: string, fallback?: string) =>
    scope.has(ref) ? resolve(scope, ref, theme, depth + 1) : (fallback ?? ""));
  value = value.replace(/light-dark\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)/g, (_, light: string, dark: string) => (theme === "light" ? light : dark));
  return value;
}

export function parseHex(hex: string): Rgba {
  const h = hex.replace("#", "");
  const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  return [n(0), n(2), n(4), full.length === 8 ? n(6) : 1];
}
const over = (top: Rgba, base: Rgba): Rgba => [0, 1, 2].map((i) => top[i]! * top[3] + base[i]! * (1 - top[3])).concat(1) as Rgba;
const mix = (a: Rgba, b: Rgba, t: number): Rgba => [0, 1, 2, 3].map((i) => a[i]! + (b[i]! - a[i]!) * t) as Rgba;
const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: Rgba) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
export function ratio(a: Rgba, b: Rgba): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}
export const toHex = (c: Rgba) => "#" + c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");

/** Every colour a value paints: flat colours, or gradient stops plus points between them. */
export function samples(value: string, base?: Rgba): Rgba[] {
  const stops = [...value.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => parseHex(m[0]));
  if (!stops.length) throw new Error(`no colour in ${value}`);
  const flat = stops.map((s) => (s[3] < 1 ? (base ? over(s, base) : s) : s));
  if (!/gradient/.test(value)) return flat;
  const out: Rgba[] = [];
  flat.forEach((s, i) => {
    out.push(s);
    const next = flat[i + 1];
    if (next) for (let t = 0.125; t < 1; t += 0.125) out.push(mix(s, next, t));
  });
  return out;
}

export type Requirement = "text" | "large" | "ui" | "advisory" | "exempt";
export const MINIMUM: Record<Requirement, number> = { text: 4.5, large: 3, ui: 3, advisory: 0, exempt: 0 };
export interface Pair {
  label: string;
  fg: string;
  bg: string[];
  need: Requirement;
  /** Base under translucent colours; defaults to the workspace surface. */
  base?: string;
  /** Composite this translucent token over each background before measuring (selected rows). */
  overlay?: string;
  why?: string;
  /** A measured failure recorded for the operator instead of silently changing an accepted value. */
  exception?: { theme: Theme; reason: string };
}
export interface Measured extends Pair { theme: Theme; min: number; worst: string; pass: boolean; fgHex: string; bgHex: string }

const SURFACES = ["magic-surface-workspace", "magic-surface-raised", "magic-surface-quiet"];

/** Pairs that hold in every accent: surfaces, identity, study, schedule, status, shell. */
export const BASE_PAIRS: Pair[] = [
  ...["magic-ink", "magic-ink-prose", "magic-ink-muted-strong", "magic-ink-muted", "magic-ink-link", "magic-ink-feedback", "magic-ink-error"].map(
    (fg): Pair => ({ label: fg, fg, bg: SURFACES, need: "text" })),
  { label: "tag ink on tag fill", fg: "magic-ink-tag-candidate", bg: ["magic-fill-tag-candidate"], need: "text" },
  { label: "avatar initial", fg: "magic-ink-avatar", bg: ["magic-fill-avatar"], need: "text" },
  { label: "identity rose", fg: "magic-ink-identity-rose", bg: ["magic-fill-identity-rose"], need: "text" },
  { label: "identity blue", fg: "magic-ink-identity-blue", bg: ["magic-fill-identity-blue"], need: "text" },
  { label: "identity coral", fg: "magic-ink-identity-coral", bg: ["magic-fill-identity-coral"], need: "text" },
  { label: "study", fg: "magic-ink-study", bg: ["magic-fill-study", "magic-fill-study-secondary"], need: "text" },
  { label: "schedule event", fg: "magic-ink-schedule-event", bg: ["magic-fill-schedule-event"], need: "text" },
  { label: "warning status", fg: "magic-ink-status-warning-candidate", bg: ["magic-fill-status-warning-candidate", ...SURFACES], need: "text" },
  { label: "error status", fg: "magic-ink-status-error-candidate", bg: ["magic-fill-status-error-candidate", ...SURFACES], need: "text" },
  { label: "link on link backing", fg: "magic-ink-link", bg: ["magic-fill-link-candidate"], need: "text" },
  { label: "today marker date", fg: "magic-ink-today-marker", bg: ["magic-fill-today-marker"], need: "text" },
  { label: "shell text", fg: "magic-ink-on-shell", bg: ["magic-fill-shell"], need: "text" },
  { label: "shell text, selected row", fg: "magic-ink-on-shell", bg: ["magic-fill-shell"], overlay: "magic-fill-shell-selected", need: "text" },
  { label: "shell secondary text", fg: "magic-ink-on-shell-secondary", bg: ["magic-fill-shell"], need: "text",
    exception: { theme: "light", reason: "accepted v3 values; only the design lab uses this ink, over the radial highlight" } },
  { label: "calendar event", fg: "magic-ink-schedule-event", bg: ["magic-fill-calendar-event"], need: "text" },
  { label: "calendar deadline", fg: "magic-ink-identity-coral", bg: ["magic-fill-calendar-deadline"], need: "text" },
  { label: "sources coral row", fg: "magic-ink-identity-coral", bg: ["magic-fill-tint-coral"], need: "text" },
  { label: "sources blue row", fg: "magic-ink-identity-blue", bg: ["magic-fill-tint-blue"], need: "text" },
  { label: "sources rose row", fg: "magic-ink-identity-rose", bg: ["magic-fill-tint-rose"], need: "text" },
  { label: "sources amber row", fg: "magic-ink-study", bg: ["magic-fill-tint-amber"], need: "text" },
  { label: "sources row action", fg: "magic-ink", bg: ["magic-fill-tint-coral-action", "magic-fill-tint-blue-action", "magic-fill-tint-rose-action", "magic-fill-tint-amber-action"], need: "text" },
  { label: "field boundary", fg: "magic-line-field", bg: SURFACES, need: "ui" },
  { label: "focus on shell", fg: "magic-focus-on-shell", bg: ["magic-fill-shell"], need: "ui" },
  { label: "current-time line", fg: "magic-accent-current-time", bg: SURFACES, need: "ui" },
  { label: "quiet separator", fg: "magic-line-quiet", bg: SURFACES, need: "advisory", why: "decorative grouping; spacing and alignment carry structure" },
  { label: "disabled text", fg: "magic-ink-disabled", bg: ["magic-fill-disabled"], need: "exempt", why: "WCAG 1.4.3 exempts inactive controls" },
];

/** Hue palette read by deadline emphasis: ink never fades, so every fill it can sit on counts. */
export const HUES = ["rose", "coral", "orange", "yellow", "lime", "green", "teal", "blue", "indigo", "purple", "magenta", "neutral"] as const;
export const HUE_PAIRS: Pair[] = HUES.map((h) => ({
  label: `hue ${h}`, fg: `magic-hue-${h}-ink`, bg: [`magic-hue-${h}-strong`, `magic-hue-${h}-pale`, "magic-surface-quiet"], need: "text" }));

/** Pairs that move with the accent: command fill and text, secondary, confirmation, focus, selection. */
export const ACCENT_PAIRS: Pair[] = [
  { label: "action text", fg: "magic-ink-action", bg: ["magic-fill-action"], need: "text" },
  { label: "action text, hover", fg: "magic-ink-action", bg: ["magic-fill-action-hover"], need: "text" },
  { label: "secondary text", fg: "magic-ink-secondary", bg: ["magic-fill-secondary", "magic-fill-secondary-hover", ...SURFACES], need: "text" },
  { label: "confirmation text", fg: "magic-ink-confirmation", bg: ["magic-fill-confirmation"], need: "text" },
  { label: "selected text", fg: "magic-ink", bg: ["magic-fill-selection"], need: "text" },
  { label: "calendar study block", fg: "magic-ink-action", bg: ["magic-fill-calendar-study"], need: "text" },
  { label: "focus ring", fg: "magic-focus", bg: [...SURFACES, "magic-fill-confirmation"], need: "ui" },
];

export function measure(css: string, pairs: Pair[], theme: Theme, accent: AccentId = DEFAULT_ACCENT): Measured[] {
  const scope = tokenScope(css, accent);
  const value = (t: string) => resolve(scope, t, theme);
  return pairs.map((pair) => {
    const base = samples(value(pair.base ?? "magic-surface-workspace"))[0]!;
    let min = Infinity, worst = "", fgHex = "", bgHex = "";
    for (const bgToken of pair.bg) {
      let backs = samples(value(bgToken), base);
      if (pair.overlay) { const top = samples(value(pair.overlay))[0]!; backs = backs.map((b) => over(top, b)); }
      for (const bg of backs) for (const fg of samples(value(pair.fg), bg)) {
        const r = ratio(fg, bg);
        if (r < min) { min = r; worst = bgToken; fgHex = toHex(fg); bgHex = toHex(bg); }
      }
    }
    return { ...pair, theme, min, worst, fgHex, bgHex, pass: min >= MINIMUM[pair.need] };
  });
}

/** Every measurement the system promises, per theme and accent. */
export function measureAll(css = readTokens()) {
  const rows: { theme: Theme; accent: AccentId | "all"; results: Measured[] }[] = [];
  for (const theme of ["light", "dark"] as const) {
    rows.push({ theme, accent: "all", results: measure(css, [...BASE_PAIRS, ...HUE_PAIRS], theme) });
    for (const accent of ACCENT_IDS) rows.push({ theme, accent, results: measure(css, ACCENT_PAIRS, theme, accent) });
  }
  return rows;
}

const fmt = (n: number) => n.toFixed(2);
const need = (m: Measured) => (m.need === "advisory" ? "advisory" : m.need === "exempt" ? "exempt" : `${MINIMUM[m.need]}:1 ${m.need === "ui" ? "non-text" : m.need}`);

export function markdown(css = readTokens()): string {
  const all = measureAll(css);
  const out: string[] = [];
  const base = (t: Theme) => all.find((r) => r.theme === t && r.accent === "all")!.results;
  out.push("| Pair (foreground on backgrounds) | Requirement | Light min | Dark min | Worst background (light / dark) |", "| --- | --- | --- | --- | --- |");
  base("light").forEach((l, i) => {
    const d = base("dark")[i]!;
    const flag = (m: Measured) => (m.pass ? fmt(m.min) : `**${fmt(m.min)} fails**${m.exception?.theme === m.theme ? " (recorded exception)" : ""}`);
    out.push(`| ${l.label} | ${need(l)} | ${flag(l)} | ${flag(d)} | ${l.worst.replace("magic-", "")} / ${d.worst.replace("magic-", "")} |`);
  });
  out.push("", "| Accent | Theme | " + ACCENT_PAIRS.map((p) => `${p.label} (${MINIMUM[p.need]}:1)`).join(" | ") + " |", "| --- | --- | " + ACCENT_PAIRS.map(() => "---").join(" | ") + " |");
  for (const accent of ACCENT_IDS) for (const theme of ["light", "dark"] as const) {
    const r = all.find((x) => x.theme === theme && x.accent === accent)!.results;
    out.push(`| ${accent}${accent === DEFAULT_ACCENT ? " (default)" : ""} | ${theme} | ` + r.map((m) => (m.pass ? fmt(m.min) : `**${fmt(m.min)} fails**`)).join(" | ") + " |");
  }
  return out.join("\n");
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/theme-contrast.ts")) {
  console.log(markdown());
}
