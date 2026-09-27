/**
 * owner: client-health (D51). The student's appearance choice: light, dark or system, and an
 * accent. The design system's integrator owns every colour value (DESIGN.md, tokens.css); this
 * module only stores the choice and sets attributes on the root element, so token rules like
 * `:root[data-theme="dark"]` and `:root[data-accent="rose"]` can apply it. No colour lives here.
 *
 * tokens.css gives every colour a light-dark() pair and recolours command, focus and selection
 * roles per [data-accent]; styles.css maps the accent to the window frame. "warm" keeps the
 * default (blue) command colours with today's shell frame.
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/**
 * Proposed accent set, each previewed with an existing token (reading tokens only). Pending the
 * design integrator: an accepted set and its `[data-accent]` values. "warm" is today's shell.
 */
export const ACCENTS = [
  { id: "warm", label: "Warm", swatch: "--magic-fill-shell" },
  { id: "rose", label: "Rose", swatch: "--magic-fill-identity-rose" },
  { id: "blue", label: "Blue", swatch: "--magic-fill-identity-blue" },
  { id: "coral", label: "Coral", swatch: "--magic-fill-identity-coral" },
] as const;
export type AccentId = (typeof ACCENTS)[number]["id"];

export interface Appearance {
  theme: ThemePreference;
  accent: AccentId;
}
export const defaultAppearance: Appearance = { theme: "system", accent: "warm" };
export const appearanceKey = "magic.appearance.v1";

interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readAppearance(store: KeyValueStore | null = defaultStore()): Appearance {
  try {
    const raw = store?.getItem(appearanceKey);
    if (!raw) return { ...defaultAppearance };
    const value = JSON.parse(raw) as Partial<Appearance>;
    return {
      theme: value.theme === "light" || value.theme === "dark" || value.theme === "system" ? value.theme : defaultAppearance.theme,
      accent: ACCENTS.some((a) => a.id === value.accent) ? (value.accent as AccentId) : defaultAppearance.accent,
    };
  } catch {
    return { ...defaultAppearance };
  }
}
export function writeAppearance(appearance: Appearance, store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.setItem(appearanceKey, JSON.stringify(appearance));
  } catch {
    // Storage unavailable: the choice still applies for this launch.
  }
}

export function resolveTheme(theme: ThemePreference, prefersDark: boolean): ResolvedTheme {
  return theme === "system" ? (prefersDark ? "dark" : "light") : theme;
}

/** Sets `data-theme` (resolved), `data-theme-preference` and `data-accent` on the root. */
export function applyAppearance(
  appearance: Appearance,
  root: { setAttribute(name: string, value: string): void } | null = typeof document === "undefined" ? null : document.documentElement,
  prefersDark: boolean = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches,
): ResolvedTheme {
  const resolved = resolveTheme(appearance.theme, prefersDark);
  root?.setAttribute("data-theme", resolved);
  root?.setAttribute("data-theme-preference", appearance.theme);
  root?.setAttribute("data-accent", appearance.accent);
  return resolved;
}

let unwatch: (() => void) | null = null;
/** Applies the saved choice and follows the OS setting while the preference is "system". */
export function startAppearance(): void {
  const apply = () => applyAppearance(readAppearance());
  apply();
  if (unwatch || typeof matchMedia !== "function") return;
  const query = matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", apply);
  unwatch = () => query.removeEventListener("change", apply);
}
