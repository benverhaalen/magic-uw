import type {
  ApiKeyStatus,
  ClientHealth,
  ClientId,
  ClientMode,
  ClientsBridge,
  ClientStatus,
  ConsentRecord,
  ResourceView,
  Snapshot,
  SourceHealth,
} from "@magic/contracts";

/**
 * T81 onboarding model: pure logic for the first-run flow, kept free of React and CSS so it
 * can be unit-tested. owner: client-health (D50, D51): the step order is consent → UW sign-in →
 * client (with health and mode) → appearance → optional connections → done, and the client
 * types now come from the contracts (T80 is integrated).
 */
export type { ClientId, ClientStatus, ClientsBridge };

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
    installUrl: "https://code.claude.com/docs/en/setup",
  },
  codex: {
    name: "Codex",
    provider: "OpenAI",
    plan: "ChatGPT plan",
    recipient: "codex",
    installUrl: "https://developers.openai.com/codex/cli",
  },
  gemini: {
    name: "Gemini",
    provider: "Google",
    plan: "Google AI Studio key",
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
 * The client to recommend (D35 order: Claude Code, then Codex, then Gemini): the first one that
 * is ready, else the first installed one, else Gemini (a key needs no install).
 */
export function recommendedClient(health: Partial<Record<ClientId, ClientHealth>>): ClientId {
  const ready = clientOrder.find((id) => health[id]?.state === "ok");
  if (ready) return ready;
  const installed = clientOrder.find((id) => id !== "gemini" && health[id] && health[id]!.state !== "not_installed");
  return installed ?? "gemini";
}
/** Health from T80's status alone, for a main without `clients.health` (isolated profile, no instant check). */
export function healthFromStatus(status: ClientStatus, checkedAt = new Date().toISOString()): ClientHealth {
  const gemini = status.id === "gemini";
  const state: ClientHealth["state"] = gemini
    ? "not_signed_in"
    : !status.installed || status.problem
      ? "not_installed"
      : status.signedIn === true
        ? "ok"
        : status.signedIn === false
          ? "not_signed_in"
          : "installed";
  return {
    id: status.id,
    state,
    mode: gemini ? "api_key" : "isolated",
    source: "status",
    instant: { available: false },
    modes: gemini ? ["api_key"] : ["isolated"],
    ...(status.version ? { version: status.version } : {}),
    ...(status.plan ? { plan: status.plan } : {}),
    checkedAt,
  };
}
/** Whether a tile can be picked: an installed CLI, or Gemini (its key needs no install). */
export const selectable = (id: ClientId, health: ClientHealth | undefined): boolean =>
  id === "gemini" || (!!health && health.state !== "not_installed");

/**
 * The browser-preview fixture (no `window.magic.clients`). Always labelled as a preview in the
 * UI; its sign-in "completes" a few seconds after the terminal opens so the flow can be walked.
 * Claude Code is signed in and offers instant mode; Codex only its own profile.
 */
export function createPreviewClients(signInDelayMs = 4000): ClientsBridge {
  const statuses: Record<ClientId, ClientStatus> = {
    claude: { id: "claude", installed: true, version: "2.1.283", profileReady: false, signedIn: false, isolated: true },
    codex: { id: "codex", installed: true, version: "0.156.1", profileReady: false, signedIn: false, isolated: true },
    gemini: { id: "gemini", installed: false, profileReady: false, signedIn: false, isolated: false, installUrl: clientInfo.gemini.installUrl },
  };
  const modes: Partial<Record<ClientId, ClientMode>> = {};
  let key: ApiKeyStatus = { stored: false, inEnvironment: false };
  const openedAt = new Map<ClientId, number>();
  const signedIn = (id: ClientId) => {
    const opened = openedAt.get(id);
    return opened !== undefined && Date.now() - opened >= signInDelayMs;
  };
  const health = async (id: ClientId, mode?: ClientMode): Promise<ClientHealth> => {
    const checkedAt = new Date().toISOString();
    if (id === "gemini")
      return { id, state: key.stored ? "ok" : "not_signed_in", mode: "api_key", source: "key", instant: { available: false, reason: "Gemini runs only with your own API key." }, modes: ["api_key"], checkedAt };
    const instant =
      id === "claude"
        ? { available: true }
        : { available: false, reason: "Codex always adds your personal AGENTS.md to every request, so the app uses its own Codex profile instead." };
    const chosen = mode ?? modes[id] ?? (instant.available ? "instant" : "isolated");
    const m = chosen === "instant" && instant.available ? "instant" : "isolated";
    const ok = m === "instant" || signedIn(id);
    return {
      id,
      state: ok ? "ok" : "not_signed_in",
      mode: m,
      source: "status",
      instant,
      modes: instant.available ? ["instant", "isolated"] : ["isolated"],
      version: statuses[id].version,
      ...(ok && id === "claude" ? { plan: "pro" } : {}),
      checkedAt,
    };
  };
  return {
    detect: async () => clientOrder.map((id) => ({ ...statuses[id] })),
    prepare: async (id) => {
      statuses[id].profileReady = true;
      return { ...statuses[id] };
    },
    authStatus: async (id) => ({ ...statuses[id], signedIn: signedIn(id), method: signedIn(id) ? "subscription" : undefined }),
    choose: async () => undefined,
    health,
    setMode: async (id, mode) => {
      modes[id] = mode;
      return health(id, mode);
    },
    geminiKey: {
      status: async () => key,
      save: async (value) => {
        if (!/^[A-Za-z0-9_-]{20,200}$/.test(value.trim())) throw new Error("That doesn't look like a Gemini API key.");
        key = { ...key, stored: true };
        return key;
      },
      remove: async () => (key = { ...key, stored: false }),
    },
    terminal: {
      open: async (id) => {
        openedAt.set(id, Date.now());
        return { sessionId: `preview-${id}` };
      },
      write: () => undefined,
      resize: () => undefined,
      close: async () => undefined,
      onData: () => () => undefined,
      onExit: () => () => undefined,
    },
  };
}

// --- Steps and resume ---------------------------------------------------------------------------
export type StepId = "consent" | "uw" | "client" | "appearance" | "connections" | "done";
export const steps: readonly { id: StepId; label: string }[] = [
  { id: "consent", label: "Agreement" },
  { id: "uw", label: "UW sign-in" },
  { id: "client", label: "Your AI" },
  { id: "appearance", label: "Appearance" },
  { id: "connections", label: "Connections" },
  { id: "done", label: "Your workspace" },
];

/** How the UW step ended. Only `confirmed` counts as signed in (FDB-002); `skipped` is the student's choice. */
export type UwProgress = "not_started" | "confirmed" | "cancelled" | "failed" | "skipped";
/** What the flow remembers between launches. Step state only: no coursework, keys or sessions. */
export interface OnboardingProgress {
  started: boolean;
  uw: UwProgress;
  /** The chosen client, or "later" when the student chose Set up later. */
  client: ClientId | "later" | null;
  clientConnected: boolean;
  appearanceDone: boolean;
  connectionsDone: boolean;
  done: boolean;
}
export const emptyProgress: OnboardingProgress = {
  started: false,
  uw: "not_started",
  client: null,
  clientConnected: false,
  appearanceDone: false,
  connectionsDone: false,
  done: false,
};
export const progressKey = "magic.onboarding.v2";
/** T81's record; read once so a student mid-setup keeps their place. */
export const legacyProgressKey = "magic.onboarding.v1";

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
const uwValues: readonly UwProgress[] = ["not_started", "confirmed", "cancelled", "failed", "skipped"];
function parseClient(value: unknown): OnboardingProgress["client"] {
  return value === "later" || clientOrder.includes(value as ClientId) ? (value as OnboardingProgress["client"]) : null;
}
export function readProgress(store: KeyValueStore | null = defaultStore()): OnboardingProgress {
  try {
    const raw = store?.getItem(progressKey);
    if (raw) {
      const value = JSON.parse(raw) as Partial<OnboardingProgress>;
      const client = parseClient(value.client);
      return {
        started: value.started === true,
        uw: uwValues.includes(value.uw as UwProgress) ? (value.uw as UwProgress) : "not_started",
        client,
        clientConnected: value.clientConnected === true && client !== null && client !== "later",
        appearanceDone: value.appearanceDone === true,
        connectionsDone: value.connectionsDone === true,
        done: value.done === true,
      };
    }
    const legacy = store?.getItem(legacyProgressKey);
    if (!legacy) return { ...emptyProgress };
    const old = JSON.parse(legacy) as { welcomed?: unknown; client?: unknown; clientConnected?: unknown; done?: unknown };
    const client = parseClient(old.client);
    return {
      ...emptyProgress,
      started: old.welcomed === true,
      client,
      clientConnected: old.clientConnected === true && client !== null && client !== "later",
      done: old.done === true,
    };
  } catch {
    return { ...emptyProgress };
  }
}
export function writeProgress(progress: OnboardingProgress, store: KeyValueStore | null = defaultStore()): void {
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
export function needsOnboarding(snapshot: Snapshot, progress: OnboardingProgress, hasConsent: ConsentCheck): boolean {
  if (progress.done) return false;
  const started = progress.started || progress.client !== null;
  const populated = snapshot.resources.some((resource) => !resource.deleted);
  if (!started && populated && uwConsented(snapshot, hasConsent)) return false;
  return true;
}

/** The first step still incomplete; a relaunch mid-setup resumes here. */
export function firstIncompleteStep(snapshot: Snapshot, progress: OnboardingProgress, hasConsent: ConsentCheck): StepId {
  if (!uwConsented(snapshot, hasConsent)) return "consent";
  const readSomething = snapshot.sources.length > 0;
  if (!readSomething && progress.uw !== "confirmed" && progress.uw !== "skipped") return "uw";
  if (progress.client === null || (progress.client !== "later" && !progress.clientConnected)) return "client";
  if (!progress.appearanceDone) return "appearance";
  if (!progress.connectionsDone) return "connections";
  return "done";
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
