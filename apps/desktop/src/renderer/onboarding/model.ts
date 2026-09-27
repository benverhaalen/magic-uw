import type { ConsentRecord, ResourceView, Snapshot, SourceHealth } from "@magic/contracts";

/**
 * T81 onboarding model: pure logic for the first-run flow, kept free of React and CSS so it
 * can be unit-tested. The client bridge types below are a local copy of the T80 contract
 * (`wave-b/T80`); the lead replaces them with the contracts type at integration.
 */

// --- Local copy of the T80 IPC contract -----------------------------------------------------
export type ClientId = "claude" | "codex" | "gemini";
export interface ClientStatus {
  id: ClientId;
  installed: boolean;
  version?: string;
  profileReady: boolean;
  signedIn: boolean | "unknown";
  method?: "subscription" | "api-key" | "unknown";
  isolated: boolean;
  installUrl?: string;
}
export interface ClientsBridge {
  detect(): Promise<ClientStatus[]>;
  prepare(id: ClientId): Promise<unknown>;
  authStatus(id: ClientId): Promise<ClientStatus>;
  choose(id: ClientId): Promise<unknown>;
  terminal: {
    open(id: ClientId, purpose: "signin" | "session"): Promise<{ sessionId: string }>;
    write(sessionId: string, data: string): unknown;
    resize(sessionId: string, cols: number, rows: number): unknown;
    close(sessionId: string): unknown;
    onData(sessionId: string, listener: (data: string) => void): unknown;
    onExit(sessionId: string, listener: (code: number | null) => void): unknown;
  };
}
// ----------------------------------------------------------------------------------------------

export const clientOrder: readonly ClientId[] = ["claude", "codex", "gemini"];
export const clientInfo: Record<
  ClientId,
  { name: string; provider: string; plan: string; recipient: ConsentRecord["recipient"]; installUrl: string }
> = {
  claude: {
    name: "Claude Code",
    provider: "Anthropic",
    plan: "Claude plan",
    recipient: "claude",
    installUrl: "https://docs.claude.com/en/docs/claude-code/setup",
  },
  codex: {
    name: "Codex",
    provider: "OpenAI",
    plan: "ChatGPT plan",
    recipient: "codex",
    installUrl: "https://developers.openai.com/codex/cli",
  },
  gemini: {
    name: "Gemini CLI",
    provider: "Google",
    plan: "Google account",
    recipient: "gemini",
    installUrl: "https://github.com/google-gemini/gemini-cli",
  },
};

/** Sorts detected statuses into the fixed tile order and fills a tile for a client the bridge omitted. */
export function orderedClients(statuses: readonly ClientStatus[]): ClientStatus[] {
  return clientOrder.map(
    (id) =>
      statuses.find((status) => status.id === id) ?? {
        id,
        installed: false,
        profileReady: false,
        signedIn: false,
        isolated: false,
      },
  );
}

/**
 * The browser-preview fixture (no `window.magic.clients`). Always labelled as a preview in the
 * UI; its sign-in "completes" a few seconds after the terminal opens so the flow can be walked.
 */
export function createPreviewClients(signInDelayMs = 4000): ClientsBridge {
  const statuses: Record<ClientId, ClientStatus> = {
    claude: { id: "claude", installed: true, version: "2.1.283", profileReady: false, signedIn: false, isolated: true },
    codex: { id: "codex", installed: true, version: "0.156.1", profileReady: false, signedIn: false, isolated: true },
    gemini: {
      id: "gemini",
      installed: false,
      profileReady: false,
      signedIn: false,
      isolated: true,
      installUrl: clientInfo.gemini.installUrl,
    },
  };
  const openedAt = new Map<ClientId, number>();
  return {
    detect: async () => clientOrder.map((id) => ({ ...statuses[id] })),
    prepare: async (id) => {
      statuses[id].profileReady = true;
    },
    authStatus: async (id) => {
      const opened = openedAt.get(id);
      const signedIn = opened !== undefined && Date.now() - opened >= signInDelayMs;
      return { ...statuses[id], signedIn, method: signedIn ? "subscription" : undefined };
    },
    choose: async () => undefined,
    terminal: {
      open: async (id) => {
        openedAt.set(id, Date.now());
        return { sessionId: `preview-${id}` };
      },
      write: () => undefined,
      resize: () => undefined,
      close: () => undefined,
      onData: () => undefined,
      onExit: () => undefined,
    },
  };
}

// --- Steps and resume ---------------------------------------------------------------------------
export type StepId = "welcome" | "ai" | "connect" | "uw" | "populating";
export const steps: readonly { id: StepId; label: string }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "ai", label: "Your AI" },
  { id: "connect", label: "Connect" },
  { id: "uw", label: "UW" },
  { id: "populating", label: "Your workspace" },
];

/** What the flow remembers between launches. Step state only: no coursework, keys or sessions. */
export interface OnboardingProgress {
  welcomed: boolean;
  /** The chosen client, or "later" when the student chose Set up later. */
  client: ClientId | "later" | null;
  clientConnected: boolean;
  uwStarted: boolean;
  done: boolean;
}
export const emptyProgress: OnboardingProgress = {
  welcomed: false,
  client: null,
  clientConnected: false,
  uwStarted: false,
  done: false,
};
export const progressKey = "magic.onboarding.v1";

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
export function readProgress(store: KeyValueStore | null = defaultStore()): OnboardingProgress {
  try {
    const raw = store?.getItem(progressKey);
    if (!raw) return { ...emptyProgress };
    const value = JSON.parse(raw) as Partial<OnboardingProgress>;
    const client =
      value.client === "later" || clientOrder.includes(value.client as ClientId)
        ? (value.client as OnboardingProgress["client"])
        : null;
    return {
      welcomed: value.welcomed === true,
      client,
      clientConnected: value.clientConnected === true && client !== null && client !== "later",
      uwStarted: value.uwStarted === true,
      done: value.done === true,
    };
  } catch {
    return { ...emptyProgress };
  }
}
export function writeProgress(
  progress: OnboardingProgress,
  store: KeyValueStore | null = defaultStore(),
): void {
  try {
    store?.setItem(progressKey, JSON.stringify(progress));
  } catch {
    // Storage full or unavailable: the flow still works for this launch.
  }
}

/** `hasCurrentConsent` from the domain package, injected so this module stays dependency-light. */
export type ConsentCheck = (
  records: readonly ConsentRecord[] | undefined,
  recipient: ConsentRecord["recipient"],
) => boolean;
function uwConsented(snapshot: Snapshot, hasConsent: ConsentCheck): boolean {
  return hasConsent(snapshot.consents, "uw");
}

/**
 * Onboarding shows on first run and while setup is incomplete. A workspace that already has
 * UW agreement and coursework from before this flow existed is treated as set up.
 */
export function needsOnboarding(
  snapshot: Snapshot,
  progress: OnboardingProgress,
  hasConsent: ConsentCheck,
): boolean {
  if (progress.done) return false;
  const started = progress.welcomed || progress.client !== null;
  const populated = snapshot.resources.some((resource) => !resource.deleted);
  if (!started && populated && uwConsented(snapshot, hasConsent)) return false;
  return true;
}

/** The first step still incomplete; a relaunch mid-setup resumes here. */
export function firstIncompleteStep(
  snapshot: Snapshot,
  progress: OnboardingProgress,
  hasConsent: ConsentCheck,
): StepId {
  if (!progress.welcomed) return "welcome";
  if (progress.client === null) return "ai";
  if (progress.client !== "later" && !progress.clientConnected) return "connect";
  const hasSources = snapshot.sources.length > 0;
  if (!hasSources && (!uwConsented(snapshot, hasConsent) || !progress.uwStarted)) return "uw";
  return "populating";
}

// --- Populating summary ------------------------------------------------------------------------
export type SourceState = "reading" | "ready" | "partial" | "failed";
export interface SourceLine {
  id: string;
  label: string;
  state: SourceState;
  /** Plain-words status, always present. */
  status: string;
  /** Why it is partial or failed; absent when ready. */
  reason?: string;
  detail?: string;
}
export interface PopulateSummary {
  sources: SourceLine[];
  counts: { label: string; count: number }[];
  total: number;
  reading: boolean;
  /** "empty" when nothing is connected; "issues" when any source is partial or failed. */
  outcome: "empty" | "reading" | "ready" | "issues";
}

const reasons: Record<Exclude<SourceHealth["status"], "ok">, string> = {
  partial: "Some pages could not be read. What was read is saved.",
  needs_sign_in: "UW asked you to sign in again.",
  error: "It could not be read this time. Try again from Sources.",
  inaccessible: "Your account cannot open it.",
  not_published: "The instructor has not published it yet.",
  needs_attention: "Something in it needs a look in Sources.",
};
const kindWords: { kind: ResourceView["kind"]; one: string; many: string }[] = [
  { kind: "course", one: "course", many: "courses" },
  { kind: "assignment", one: "assignment", many: "assignments" },
  { kind: "material", one: "reading or file", many: "readings and files" },
  { kind: "event", one: "calendar event", many: "calendar events" },
  { kind: "message", one: "announcement or message", many: "announcements and messages" },
];

function sourceLine(source: SourceHealth, busy: boolean): SourceLine {
  const progress = source.progress;
  const inFlight =
    progress !== undefined && (progress.total === undefined || progress.completed < progress.total);
  const found = `${source.resourceCount} ${source.resourceCount === 1 ? "item" : "items"} found`;
  if (inFlight || (busy && source.status === "ok" && !source.complete))
    return {
      id: source.id,
      label: source.label,
      state: "reading",
      status: "Reading",
      detail: progress
        ? `${progress.phase}${progress.total ? `, ${progress.completed} of ${progress.total}` : ""}`
        : found,
    };
  if (source.status === "ok" && source.complete)
    return { id: source.id, label: source.label, state: "ready", status: "Done", detail: found };
  if (source.status === "ok" || source.status === "partial")
    return {
      id: source.id,
      label: source.label,
      state: "partial",
      status: "Partly read",
      reason: reasons.partial,
      detail: found,
    };
  return {
    id: source.id,
    label: source.label,
    state: "failed",
    status: source.status === "needs_sign_in" ? "Sign in needed" : "Not read",
    reason: reasons[source.status],
    detail: source.resourceCount > 0 ? `${found} earlier` : undefined,
  };
}

export function summarize(snapshot: Snapshot, busy: boolean): PopulateSummary {
  const sources = snapshot.sources.map((source) => sourceLine(source, busy));
  const live = snapshot.resources.filter((resource) => !resource.deleted);
  const counts = kindWords
    .map(({ kind, one, many }) => {
      const count = live.filter((resource) => resource.kind === kind).length;
      return { label: count === 1 ? one : many, count };
    })
    .filter((entry) => entry.count > 0);
  const reading = busy || sources.some((line) => line.state === "reading");
  const issues = sources.some((line) => line.state === "partial" || line.state === "failed");
  const outcome =
    sources.length === 0 && !busy ? "empty" : reading ? "reading" : issues ? "issues" : "ready";
  return { sources, counts, total: live.length, reading, outcome };
}
