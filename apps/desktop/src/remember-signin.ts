// owner: T05e. "Remember my sign-in" (plan D39, spec A1): the decisions and the encrypted file,
// apart from main.ts so they can be tested without Electron. main.ts wires them to the sign-in
// window; signin-preload.ts is the only code that touches UW's login form.
//
// The NetID and password live only in memory while they cross, and in one file encrypted by the
// OS (safeStorage: DPAPI on Windows, the Keychain on macOS). Nothing here logs, and nothing here
// returns the credential except `load()`, whose one caller is main's fill answer.
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { NETID_LOGIN_ORIGIN, type RememberedSignIn } from "./signin-page";
export {
  NETID_FORM,
  NETID_LOGIN_ORIGIN,
  isNetIdLoginPage,
  type RememberedSignIn,
  type SignInPageState,
} from "./signin-page";

/** The encrypted file, in the app's data folder. */
export const REMEMBERED_SIGNIN_FILE = "remembered-signin.enc";
/** An automatic sign-in after a sync finds the session expired happens at most this often. */
export const AUTO_SIGN_IN_SPACING_MS = 15 * 60_000;

/**
 * The build switch (D39). Under a UW licence the app becomes "UW-Madison business" and KB 59262
 * no longer allows it to store the password, so that build sets MAGIC_REMEMBER_SIGNIN=off.
 * scripts/build.ts bakes the value into the bundle; a runtime variable can't turn it back on.
 */
export function rememberSignInBuildEnabled(flag: string | undefined): boolean {
  return flag !== "off";
}

export type RememberAvailability =
  | { state: "off" }
  | { state: "unavailable"; reason: string }
  | { state: "available" };
export const UNAVAILABLE_ENCRYPTION =
  "This computer isn't offering My Magic UW protected storage, so your sign-in can't be saved.";
export const UNAVAILABLE_LINUX_KEYRING =
  "No system keyring is available to My Magic UW (only plain-text storage), so your sign-in can't be saved.";
/** Linux backends that are a real keyring. Anything else (basic_text, unknown) can't save. */
export const LINUX_KEYRING_BACKENDS: readonly string[] = Object.freeze([
  "gnome_libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
]);
/**
 * Offered only when the build allows it; savable only when safeStorage can encrypt and, on Linux,
 * the backend is one of LINUX_KEYRING_BACKENDS (Electron safe-storage docs).
 */
export function rememberAvailability(input: {
  buildEnabled: boolean;
  encryptionAvailable: boolean;
  platform: string;
  linuxBackend?: string;
}): RememberAvailability {
  if (!input.buildEnabled) return { state: "off" };
  if (!input.encryptionAvailable)
    return { state: "unavailable", reason: UNAVAILABLE_ENCRYPTION };
  if (input.platform === "linux" && !LINUX_KEYRING_BACKENDS.includes(input.linuxBackend ?? ""))
    return { state: "unavailable", reason: UNAVAILABLE_LINUX_KEYRING };
  return { state: "available" };
}

/** A capture from the form, checked against the form's own limits (maxlength 50 and 127). */
export function parseSignIn(value: unknown): RememberedSignIn | null {
  if (!value || typeof value !== "object") return null;
  const { netid, password } = value as Record<string, unknown>;
  if (typeof netid !== "string" || typeof password !== "string") return null;
  const id = netid.trim();
  if (!/^[^\s\u0000-\u001f\u007f]{1,50}$/.test(id)) return null;
  if (password.length < 1 || password.length > 127 || /[\u0000\r\n]/.test(password)) return null;
  return { netid: id, password };
}

export interface SignInEncryption {
  available(): boolean;
  encrypt(value: string): Uint8Array;
  decrypt(value: Uint8Array): string;
}
/** One encrypted file. Every write replaces it whole; forget removes it. */
export function createRememberedSignInStore(path: string, encryption: SignInEncryption) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  /** Removes the file and any temporary file a write left behind (remembered-signin.enc.*.tmp). */
  async function forget() {
    await rm(path, { force: true });
    const folder = dirname(path),
      prefix = `${basename(path)}.`;
    let names: string[] = [];
    try {
      names = await readdir(folder);
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
        .map((name) => rm(join(folder, name), { force: true })),
    );
  }
  return {
    save(value: RememberedSignIn): Promise<void> {
      return serial(async () => {
        const checked = parseSignIn(value);
        if (!checked) throw new Error("That sign-in can't be saved.");
        if (!encryption.available()) throw new Error(UNAVAILABLE_ENCRYPTION);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(
            temporary,
            encryption.encrypt(JSON.stringify({ v: 1, ...checked })),
            { mode: 0o600, flag: "wx" },
          );
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    },
    /** The saved sign-in, or null. An unreadable or undecryptable file is removed, never retried. */
    load(): Promise<RememberedSignIn | null> {
      return serial(async () => {
        if (!encryption.available()) return null;
        let bytes: Buffer;
        try {
          bytes = await readFile(path);
        } catch {
          return null;
        }
        try {
          const value: unknown = JSON.parse(encryption.decrypt(bytes));
          const parsed =
            value && typeof value === "object" && (value as { v?: unknown }).v === 1
              ? parseSignIn(value)
              : null;
          if (parsed) return parsed;
        } catch {
          /* falls through to forget */
        }
        await forget();
        return null;
      });
    },
    /** Whether a file exists. It never decrypts, so it never asks the macOS Keychain. */
    saved(): Promise<boolean> {
      return serial(async () => {
        try {
          return (await stat(path)).isFile();
        } catch {
          return false;
        }
      });
    },
    forget(): Promise<void> {
      return serial(forget);
    },
  };
}
export type RememberedSignInStore = ReturnType<typeof createRememberedSignInStore>;

/**
 * One automatic sign-in per window, and no retry loop (D39 safety). Phases:
 * - ready: the window was opened by the app with a saved sign-in; the first NetID form is filled
 * - submitted: filled and submitted once; waiting to see whether UW accepted it
 * - accepted: the window left the NetID login host (to Duo or to the service): the password was
 *   right, and from here Duo is the student's own step
 * - failed: the NetID form came back, the submit failed to load, or the window closed before the
 *   password was accepted. The caller clears the saved sign-in and shows the normal sign-in
 * - off: a manual window, or nothing saved: never fills
 */
export type AutoSignInPhase = "off" | "ready" | "submitted" | "accepted" | "failed";
export function createAutoSignIn(automatic: boolean) {
  let phase: AutoSignInPhase = automatic ? "ready" : "off";
  return {
    get phase() {
      return phase;
    },
    /** The NetID form is on screen in the top frame. */
    formShown(haveSaved: boolean): "fill" | "failed" | "none" {
      if (phase === "ready") {
        if (!haveSaved) {
          phase = "off";
          return "none";
        }
        phase = "submitted";
        return "fill";
      }
      if (phase === "submitted") {
        phase = "failed";
        return "failed";
      }
      return "none";
    },
    /** The saved sign-in couldn't be read after all: nothing was filled, so nothing can fail. */
    abandon(): void {
      if (phase === "submitted" || phase === "ready") phase = "off";
    },
    /** The top frame navigated. Leaving the NetID login host after the submit means UW accepted it. */
    navigated(url: string): void {
      if (phase !== "submitted") return;
      try {
        if (new URL(url).origin !== NETID_LOGIN_ORIGIN) phase = "accepted";
      } catch {
        /* an unparsable URL proves nothing */
      }
    },
    /** The top frame failed to load while the submit was pending. */
    loadFailed(): "failed" | "none" {
      if (phase !== "submitted") return "none";
      phase = "failed";
      return "failed";
    },
    /** The window closed. */
    closed(confirmed: boolean): "failed" | "none" {
      if (phase !== "submitted" || confirmed) return "none";
      phase = "failed";
      return "failed";
    },
  };
}

/**
 * The automatic sign-in's cadence record, kept in the session settings file so it survives a
 * restart (keep-signed-in.ts, `autoSignIn`).
 * - blocked: an automatic window closed without a confirmed sign-in (for example UW accepted the
 *   password but the student didn't finish Duo). One automatic attempt per expired session: no
 *   further automatic attempt until a confirmed sign-in or the student's own "Sign in again".
 * - lastAt: when the last automatic window opened (ms since the epoch), for the spacing.
 */
export interface AutoSignInRecord {
  blocked: boolean;
  lastAt: number | null;
}
export const emptyAutoSignInRecord: Readonly<AutoSignInRecord> = Object.freeze({
  blocked: false,
  lastAt: null,
});
/** A missing or malformed record reads as empty. */
export function parseAutoSignInRecord(raw: unknown): AutoSignInRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { blocked, lastAt } = raw as Record<string, unknown>;
  if (typeof blocked !== "boolean") return undefined;
  return {
    blocked,
    lastAt:
      typeof lastAt === "number" && Number.isFinite(lastAt) && lastAt >= 0 ? lastAt : null,
  };
}
export type AutoSignInEvent =
  /** The app opened an automatic (filling) window. */
  | { kind: "opened"; at: number }
  /** A sign-in window closed; `automatic` says whether the app opened it to fill. */
  | { kind: "closed"; automatic: boolean; confirmed: boolean }
  /** The student asked to sign in themselves ("Sign in again", Sign in to UW). */
  | { kind: "student-sign-in" };
export function nextAutoSignInRecord(
  record: AutoSignInRecord,
  event: AutoSignInEvent,
): AutoSignInRecord {
  if (event.kind === "opened") return { ...record, lastAt: event.at };
  if (event.kind === "student-sign-in") return { ...record, blocked: false };
  if (event.confirmed) return { ...record, blocked: false };
  if (event.automatic) return { ...record, blocked: true };
  return record;
}

/** Input in the last minute, while one of the app's windows has focus. */
export const PRESENT_IDLE_SECONDS = 60;
/**
 * "Present" for a zero-touch renewal: someone used the keyboard or mouse in the last minute, the
 * screen isn't locked, and one of the app's own windows has focus.
 */
export function studentAtKeyboard(input: {
  idleSeconds: number;
  appFocused: boolean;
  locked: boolean;
  headless: boolean;
}): boolean {
  return (
    !input.headless &&
    !input.locked &&
    input.appFocused &&
    Number.isFinite(input.idleSeconds) &&
    input.idleSeconds >= 0 &&
    input.idleSeconds < PRESENT_IDLE_SECONDS
  );
}

/**
 * Whether the app opens the sign-in window by itself to fill the saved sign-in: after a sync's
 * confirmed expiry, and at launch. Only with the feature on and a sign-in saved, only with the
 * student at the keyboard, never headless, never over an open sign-in window, never while the
 * record is blocked, and at most once per AUTO_SIGN_IN_SPACING_MS. A clock that went backwards
 * (now before lastAt) refuses too.
 */
export function autoSignInWanted(input: {
  availability: RememberAvailability;
  saved: boolean;
  present: boolean;
  headless: boolean;
  signInOpen: boolean;
  record: AutoSignInRecord;
  now: number;
}): boolean {
  const { lastAt, blocked } = input.record;
  return (
    input.availability.state === "available" &&
    input.saved &&
    input.present &&
    !input.headless &&
    !input.signInOpen &&
    !blocked &&
    (lastAt === null ||
      (input.now >= lastAt && input.now - lastAt >= AUTO_SIGN_IN_SPACING_MS))
  );
}

/** The sign-in window's capture message, as main accepts it. */
export type SignInCapture = { remember: false } | { remember: true; signIn: RememberedSignIn };
export function parseCapture(value: unknown): SignInCapture | null {
  if (!value || typeof value !== "object") return null;
  const remember = (value as { remember?: unknown }).remember;
  if (remember === false) return { remember: false };
  if (remember !== true) return null;
  const signIn = parseSignIn((value as { signIn?: unknown }).signIn);
  return signIn ? { remember: true, signIn } : null;
}
// end owner: T05e
