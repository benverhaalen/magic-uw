// owner: data-ai. The Data & AI page's plain-words model: one on/off row per kind of data, the shared
// labels service, and what "Reset My Magic UW" and "Re-run setup" clear and keep. Every row writes the
// same preferences the earlier page wrote (shareCourseText, shareStudentWork, shareGrades,
// shareComments, shareCommunications, jevEnabled, mode); the send gate still checks consent on every
// request, and a newly shared sensitive kind is still previewed first.
import type { ClientsBridge, Command, PrivacyPreferences } from "@magic/contracts";
import { resetClientHealthCache } from "../ai-choice/answering";

export type ShareKey = "shareCourseText" | "shareStudentWork" | "shareGrades" | "shareComments" | "shareCommunications";
export const SHARE_KEYS: readonly ShareKey[] = ["shareCourseText", "shareStudentWork", "shareGrades", "shareComments", "shareCommunications"];

export interface ShareRow {
  id: "materials" | "work" | "messages";
  label: string;
  /** What is sent, to whom, and why it helps. */
  line: string;
  keys: readonly ShareKey[];
}

export const SHARE_ROWS: readonly ShareRow[] = [
  {
    id: "materials",
    label: "Course materials",
    line: "Pages, files and assignment text go to your AI when you ask it to make something, so what it writes matches your course.",
    keys: ["shareCourseText"],
  },
  {
    id: "work",
    label: "Your work and grades",
    line: "Your submissions, scores and grader comments go to your AI when you ask about them, so help fits where you are.",
    keys: ["shareStudentWork", "shareGrades", "shareComments"],
  },
  {
    id: "messages",
    label: "Course messages",
    line: "Announcements and email previews go to your AI and the shared labels service, so what's urgent shows first.",
    keys: ["shareCommunications"],
  },
];

export const PLANNING_ROW = {
  label: "Planning",
  line: "Enrollment and your degree audit stay on this computer. They are never shared.",
} as const;

export const JEV_COPY = {
  heading: "Shared labels",
  sentence: "Short labels (like 'urgent' or 'due date changed') come from our shared service. It sees titles and short previews only.",
  toggle: "Use shared labels",
  available: "Available in this build.",
  unavailable: "Not set up in this build; built-in rules still sort your notifications.",
} as const;

const cloudOn = (privacy: PrivacyPreferences) => privacy.mode === "selective_cloud";

/** A row is on when cloud access is on and any of its kinds is shared (so nothing shared looks off). */
export const shareOn = (privacy: PrivacyPreferences, row: ShareRow): boolean =>
  cloudOn(privacy) && row.keys.some((key) => privacy[key] === true);

export const jevOn = (privacy: PrivacyPreferences): boolean => cloudOn(privacy) && privacy.jevEnabled;

/**
 * Turning something on while all sharing is off: cloud access goes on, and everything the page showed
 * as off is written off, so a value saved earlier can't start sharing unseen.
 */
function leavingLocalOnly(privacy: PrivacyPreferences): Partial<PrivacyPreferences> {
  if (cloudOn(privacy)) return {};
  return { mode: "selective_cloud", jevEnabled: false, hostedProvider: "none", ...Object.fromEntries(SHARE_KEYS.map((key) => [key, false])) };
}

export function sharePatch(privacy: PrivacyPreferences, row: ShareRow, on: boolean): Partial<PrivacyPreferences> {
  const kinds = Object.fromEntries(row.keys.map((key) => [key, on])) as Partial<PrivacyPreferences>;
  return on ? { ...leavingLocalOnly(privacy), ...kinds } : kinds;
}

export function jevPatch(privacy: PrivacyPreferences, on: boolean): Partial<PrivacyPreferences> {
  return on ? { ...leavingLocalOnly(privacy), jevEnabled: true } : { jevEnabled: false };
}

/** "Share nothing": every kind off; your AI choice and the shared labels setting are left as they are. */
export const shareNothingPatch = (): Partial<PrivacyPreferences> =>
  Object.fromEntries(SHARE_KEYS.map((key) => [key, false])) as Partial<PrivacyPreferences>;

// --- Start fresh -------------------------------------------------------------------------------
/** Exactly what "Reset My Magic UW" clears (the purge, the AI client setup and this window's settings). */
export const RESET_CLEARS: readonly string[] = [
  "How My Magic UW connects to your AI, including a separate sign-in made just for it",
  "Your choices on this page and in setup, including appearance",
  "Your agreements, so you are asked again",
  "Synced course data: courses, files, messages, planning records and notes written in My Magic UW",
  "Sign-ins saved in this app (UW, Microsoft, Google), connections for AI agents, and the app's cache",
];
/** What it keeps. */
export const RESET_KEEPS: readonly string[] = [
  "Your sign-ins in Claude Code, Codex and your other AI apps: they live in those apps",
  "Notes you exported to Word or Google Docs, and files outside My Magic UW",
  "Everything at UW itself",
];
export const RECONFIGURE_CLEARS: readonly string[] = [
  "How My Magic UW connects to Claude Code or Codex, and its separate sign-in",
  "Your chosen AI and the saved checks of what is installed",
];
export const RECONFIGURE_KEEPS: readonly string[] = ["Your courses, notes, sign-ins, agreements and sharing choices"];

export const PURGE_COMMAND = { type: "purge", confirmation: "DELETE LOCAL DATA" } as const satisfies Command;

interface KeyStore {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}
/** Removes every My Magic UW key from this window's storage (setup progress, appearance, AI choice). */
export function clearAppStorage(store: KeyStore | null): string[] {
  if (!store) return [];
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key?.startsWith("magic.")) keys.push(key);
  }
  for (const key of keys) store.removeItem(key);
  return keys;
}

export interface StartFreshDeps {
  clients: Pick<ClientsBridge, "reset"> | undefined;
  /** The app's command runner; resolves undefined when the command failed. */
  run: (command: Command) => Promise<unknown>;
  /** Defaults to this window's localStorage and caches; tests pass fakes. */
  clearStorage?: () => void;
  clearHealth?: () => void;
  /** Reloads the window, so setup opens at its first step with nothing remembered. */
  restart?: () => void;
}

function windowStorage(): KeyStore | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/**
 * "Reset My Magic UW": the AI client setup first, then the existing "Delete local data" purge (which
 * also clears saved sign-ins, sessions, connections and agreements), then this window's own settings,
 * then a restart into setup. A failure stops the reset with plain words.
 */
export async function startFresh(deps: StartFreshDeps): Promise<void> {
  if (!deps.clients?.reset) throw new Error("Resetting needs the desktop app.");
  await deps.clients.reset();
  const purged = await deps.run(PURGE_COMMAND);
  if (!purged) throw new Error("Your course data could not be deleted. Your AI setup was reset; try again.");
  (deps.clearStorage ?? (() => { clearAppStorage(windowStorage()); }))();
  (deps.clearHealth ?? resetClientHealthCache)();
  (deps.restart ?? (() => window.location.reload()))();
}

/** Bytes as "12.4 MB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(0, Math.round(bytes / 1000))} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}
