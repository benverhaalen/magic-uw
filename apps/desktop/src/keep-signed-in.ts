// owner: T05c. Session state at launch, "Keep me signed in", and the sign-in window's
// self-confirmation (spec A1, plan D33). Pure decisions plus one small main-owned settings
// file; main.ts wires them to Electron. Nothing here sends a request, reads a cookie value,
// writes or restores a cookie, or touches a UW, Duo or Canvas page.
import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { verifyMyUwSession } from "../../../packages/connectors/src/uw-planning-profile";
import type { UwPlanningReadResult } from "../../../packages/connectors/src/uw-planning-http";

export interface SessionSettings {
  /** On by default (P1-D1): closing the window keeps the app running; it starts at login. */
  keepSignedIn: boolean;
  /** Set once a Canvas profile read verifies a sign-in in the app's window. */
  signedInBefore: boolean;
}
export const defaultSessionSettings: Readonly<SessionSettings> = Object.freeze({
  keepSignedIn: true,
  signedInBefore: false,
});

export function parseSessionSettings(raw: unknown): SessionSettings {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    keepSignedIn:
      "keepSignedIn" in value && typeof value.keepSignedIn === "boolean"
        ? value.keepSignedIn
        : defaultSessionSettings.keepSignedIn,
    signedInBefore:
      "signedInBefore" in value && typeof value.signedInBefore === "boolean"
        ? value.signedInBefore
        : defaultSessionSettings.signedInBefore,
  };
}

/** A missing or unreadable file yields the defaults; it never blocks launch. */
export async function readSessionSettings(path: string): Promise<SessionSettings> {
  try {
    return parseSessionSettings(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return { ...defaultSessionSettings };
  }
}

export async function writeSessionSettings(
  path: string,
  settings: SessionSettings,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(parseSessionSettings(settings)), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}

/** Only a cookie's name and domain are ever inspected; never its value. */
export interface CookieFact {
  name: string;
  domain?: string;
}
export function hasCanvasSession(
  cookies: readonly CookieFact[],
  host = "canvas.wisc.edu",
): boolean {
  return cookies.some((cookie) => {
    if (cookie.name !== "canvas_session") return false;
    const domain = (cookie.domain ?? host).replace(/^\./, "").toLowerCase();
    return domain === host || host.endsWith(`.${domain}`);
  });
}

export type LaunchSession =
  | { state: "signed_in" }
  | { state: "first_run" }
  | { state: "sign_in_again"; openSignIn: boolean };
/**
 * Decided from the local cookie store alone (0 network requests). Session cookies do not
 * survive a quit, so a missing canvas_session after a previous sign-in means "Sign in again".
 * A first run opens nothing: the consent step comes first (T06).
 */
export function launchSession(input: {
  cookies: readonly CookieFact[];
  signedInBefore: boolean;
  keepSignedIn: boolean;
  headless: boolean;
}): LaunchSession {
  if (hasCanvasSession(input.cookies)) return { state: "signed_in" };
  if (!input.signedInBefore) return { state: "first_run" };
  return {
    state: "sign_in_again",
    openSignIn: input.keepSignedIn && !input.headless,
  };
}

/** What closing the main window does. */
export function closeAction(input: {
  keepSignedIn: boolean;
  quitting: boolean;
}): "hide" | "close" {
  // Quitting (tray Quit, Cmd+Q, OS shutdown) always closes, which ends the session.
  if (input.quitting) return "close";
  // Keep me signed in: the app stays in the tray (Windows) or the dock (macOS).
  // Off: the window closes and window-all-closed quits, as before.
  return input.keepSignedIn ? "hide" : "close";
}

/** The login item is only ever registered for a packaged build, never the dev Electron binary. */
export function loginItemSettings(input: {
  isPackaged: boolean;
  keepSignedIn: boolean;
}): { openAtLogin: boolean } | null {
  return input.isPackaged ? { openAtLogin: input.keepSignedIn } : null;
}

export function trayWanted(input: {
  keepSignedIn: boolean;
  headless: boolean;
}): boolean {
  return input.keepSignedIn && !input.headless;
}

export type TrayAction = "open" | "signout" | "quit";
export const trayMenu: ReadonlyArray<{ action: TrayAction; label: string }> =
  Object.freeze([
    { action: "open", label: "Open Magic Canvas" },
    { action: "signout", label: "Sign out" },
    { action: "quit", label: "Quit" },
  ]);

/**
 * One sign-in window at a time: a second call while it is open waits for that window's
 * result instead of returning early.
 */
export function singleFlight<T>(): {
  run(start: () => Promise<T>): Promise<T>;
  readonly pending: boolean;
} {
  let current: Promise<T> | undefined;
  return {
    run(start) {
      current ??= Promise.resolve()
        .then(start)
        .finally(() => {
          current = undefined;
        });
      return current;
    },
    get pending() {
      return current !== undefined;
    },
  };
}

export type PlanningSignIn = "myuw" | "enroll";
export function planningProbe(
  service: PlanningSignIn,
): { kind: "myuw-session" } | { kind: "student-info" } {
  return service === "myuw" ? { kind: "myuw-session" } : { kind: "student-info" };
}
/**
 * The My UW and Enroll sign-in windows close themselves once the existing session.json or
 * student-info read confirms the session. Returns a boolean only; the identity is never kept.
 */
export function planningSessionConfirmed(
  service: PlanningSignIn,
  result: UwPlanningReadResult,
): boolean {
  if (result.status !== "ok") return false;
  if (service === "myuw") return verifyMyUwSession(result.data);
  // The same emplid shape uw-planning-sync.ts requires before it releases any row.
  const data = result.data;
  if (!data || typeof data !== "object" || !("personAttributes" in data)) return false;
  const person = data.personAttributes;
  return (
    !!person &&
    typeof person === "object" &&
    "emplid" in person &&
    typeof person.emplid === "string" &&
    /^\d{1,30}$/.test(person.emplid)
  );
}

/**
 * A provisional tray icon drawn in code (BGRA): the brand mark's #282927 rounded square
 * with a light centre, so it needs no asset copy step in the build.
 */
export function trayBitmap(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22,
    centre = (size - 1) / 2,
    dot = size * 0.2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = Math.max(radius - x, 0, x - (size - 1 - radius)),
        dy = Math.max(radius - y, 0, y - (size - 1 - radius));
      if (dx * dx + dy * dy > radius * radius) continue;
      const light = Math.hypot(x - centre, y - centre) <= dot;
      const offset = (y * size + x) * 4;
      pixels[offset] = light ? 0xfa : 0x27; // B
      pixels[offset + 1] = light ? 0xfb : 0x29; // G
      pixels[offset + 2] = light ? 0xfb : 0x28; // R
      pixels[offset + 3] = 0xff; // A
    }
  return pixels;
}
// end owner: T05c
