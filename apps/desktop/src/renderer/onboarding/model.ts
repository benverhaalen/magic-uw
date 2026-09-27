import { currentEnrollment, type EnrolledClass } from "../../../../../packages/domain/src/enrollment-match";
import { SOURCE_CATEGORIES, SOURCE_CATEGORY_ORDER, sourceCategory, type SourceCategory } from "../../../../../packages/domain/src/source-categories";
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
/**
 * owner: client-detection. When exactly one command-line client is installed, it is the one to
 * use; the chooser is skipped (operator: "Claude Code is the best choice"; D35 order otherwise,
 * via `recommendedClient`, so Claude Code wins when both are signed in). Gemini needs a key the
 * student chooses to add, so it is never picked for them.
 */
export function autoPick(health: Partial<Record<ClientId, ClientHealth>>): ClientId | null {
  const installed = clientOrder.filter((id) => id !== "gemini" && health[id] && health[id]!.state !== "not_installed");
  return installed.length === 1 ? installed[0] : null;
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
 * UI. Instant is the default: the sample Claude Code is signed in on "this computer", the sample
 * Codex isn't. The opt-in separate sign-in "completes" a few seconds after its terminal opens.
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
        : { available: true, note: "Codex adds your personal AGENTS.md to each request. My Magic UW still checks every answer." };
    const m = (mode ?? modes[id] ?? "instant") === "isolated" ? "isolated" : "instant";
    const ok = m === "instant" ? id === "claude" : signedIn(id);
    return {
      id,
      state: ok ? "ok" : "not_signed_in",
      mode: m,
      source: "status",
      instant,
      modes: ["instant", "isolated"],
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
export type StepId = "consent" | "uw" | "courses" | "client" | "appearance" | "connections" | "done";
export const steps: readonly { id: StepId; label: string }[] = [
  { id: "consent", label: "Agreement" },
  { id: "uw", label: "UW sign-in" },
  { id: "courses", label: "Your courses" },
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
  /** fix/current-courses-only: the student chose which courses to sync. */
  coursesDone: boolean;
  appearanceDone: boolean;
  connectionsDone: boolean;
  done: boolean;
}
export const emptyProgress: OnboardingProgress = {
  started: false,
  coursesDone: false,
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
        coursesDone: value.coursesDone === true,
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
  if (!progress.coursesDone && snapshot.ingestionSettings?.awaitingCourseChoice) return "courses";
  if (progress.client === null || (progress.client !== "later" && !progress.clientConnected)) return "client";
  if (!progress.appearanceDone) return "appearance";
  if (!progress.connectionsDone) return "connections";
  return "done";
}

// --- Course chooser (fix/current-courses-only) ------------------------------------------------
/**
 * One detected Canvas course the student can toggle. "this-term": Canvas's current term (or the
 * student's UW enrollment names it), pre-checked. "other": term-less or organization sites, and
 * courses whose term hasn't started, unchecked. Past and nameless courses are never listed.
 * The reason strings are canvas-selection.ts COURSE_REASONS.
 */
export interface CourseChoice {
  id: string;
  accountScope: string;
  courseId: string;
  name: string;
  term: string | null;
  group: "this-term" | "other";
  checked: boolean;
  /** Which source placed it: the student's UW enrollment, or Canvas's term dates (the fallback). */
  decidedBy: "enrollment" | "canvas";
}
const THIS_TERM = ["This term", "Matches your UW enrollment this term"];
const ENROLLMENT = ["Matches your UW enrollment this term", "Not in your UW enrollment this term"];
/**
 * The student's enrolled classes this term (Course Search & Enroll) that no stored Canvas course
 * matches: shown as "No Canvas course found". Empty when planning has no current enrollment.
 */
export function enrolledWithoutCanvas(snapshot: Snapshot, now: Date): EnrolledClass[] {
  const enrollment = currentEnrollment(snapshot.planning?.records ?? [], now);
  if (!enrollment) return [];
  const matched = new Set<string>();
  for (const r of snapshot.resources)
    if (r.kind === "course" && !r.deleted && r.course) {
      const found = enrollment.match({ course_code: r.course.courseCode ?? null, name: r.courseName });
      if (found) matched.add(found.courseKey);
    }
  return enrollment.classes.filter((c) => !matched.has(c.courseKey));
}
const PAST = [
  "Past course: its term ended",
  "Course concluded",
  "Completed enrollment catalog; course metadata only",
  "Course has not been published",
  "No active student enrollment",
];
export function courseChoices(snapshot: Snapshot): CourseChoice[] {
  const sources = new Map(snapshot.sources.map((s) => [s.id, s]));
  const overrides = new Map(
    (snapshot.courseOverrides ?? []).map((o) => [`${o.accountScope}|${o.courseId}`, o.included]),
  );
  const seen = new Set<string>();
  const out: CourseChoice[] = [];
  for (const r of snapshot.resources) {
    const source = sources.get(r.sourceId);
    if (r.kind !== "course" || r.deleted || !r.course || source?.kind !== "canvas" || source.scope !== "course") continue;
    const reasons = r.course.selection?.reasons ?? [];
    const nameless = r.course.accessRestricted === true || /(name unavailable)$/.test(r.courseName);
    const past = r.course.accessState === "concluded" || reasons.some((reason) => PAST.includes(reason));
    if (nameless || past) continue;
    const key = `${source.accountScope}|${r.courseId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const group = reasons.some((reason) => THIS_TERM.includes(reason)) ? "this-term" : "other";
    const override = overrides.get(key);
    out.push({
      id: r.id,
      accountScope: source.accountScope,
      courseId: r.courseId,
      name: r.courseName,
      term: r.course.termName ?? null,
      group,
      checked: override ?? r.course.selection?.included === true,
      decidedBy: reasons.some((reason) => ENROLLMENT.includes(reason)) ? "enrollment" : "canvas",
    });
  }
  return out.sort((a, b) => (a.group === b.group ? a.name.localeCompare(b.name) : a.group === "this-term" ? -1 : 1));
}

// --- Populating summary ------------------------------------------------------------------------
export type SourceState = "reading" | "ready" | "partial" | "failed";
/** One thing the student can do about a line: sign in again, read it again, or see why. */
export type SourceAction = "sign-in" | "retry" | "why";
export interface SourceLine {
  id: string;
  label: string;
  state: SourceState;
  /** Plain-words status, always present. */
  status: string;
  /** Why it is partial or failed; absent when ready. */
  reason?: string;
  detail?: string;
  action?: SourceAction;
  /** The longer explanation behind "Why?". */
  why?: string;
}
export interface PopulateSummary {
  sources: SourceLine[];
  counts: { label: string; count: number }[];
  total: number;
  reading: boolean;
  /** Course files still arriving (read in the background; the workspace is usable meanwhile). */
  filesArriving: number;
  /** Course lists Canvas doesn't show students (a hidden Pages or Files tab): normal, not an issue. */
  hiddenLists: number;
  /**
   * "empty": nothing connected. "ready": every included course has its assignments and modules
   * read (files may still be arriving). "issues": a source the student included wasn't fully read.
   */
  outcome: "empty" | "reading" | "ready" | "issues";
}

const reasons: Record<Exclude<SourceHealth["status"], "ok">, string> = {
  partial: "Some of it could not be read. What was read is saved.",
  needs_sign_in: "UW asked you to sign in again.",
  error: "It could not be read this time.",
  inaccessible: "Your account cannot open it.",
  not_published: "The instructor has not published it yet.",
  needs_attention: "It changed in a way that needs a look before it replaces what was saved.",
};
const whys: Partial<Record<string, string>> = {
  record_count_drop: "Far fewer items came back than last time, so the earlier copy was kept instead of deleting it.",
  key_text_loss: "Most of the text came back empty, so the earlier copy was kept.",
  date_coverage_loss: "Most due dates came back missing, so the earlier copy was kept.",
  scope_time_limit: "Canvas took too long to answer; the rest is read on the next refresh.",
  rate_limit_exhausted: "Canvas asked the app to slow down; the rest is read on the next refresh.",
  page_limit: "The list was longer than one refresh reads; the rest is read on the next refresh.",
  request_failed: "The connection to Canvas failed; the rest is read on the next refresh.",
  http_failure: "Canvas answered with an error; the rest is read on the next refresh.",
};
const actionFor = (status: SourceHealth["status"]): SourceAction | undefined =>
  status === "needs_sign_in" ? "sign-in" : status === "error" || status === "partial" ? "retry" : status === "needs_attention" ? "why" : undefined;
const kindWords: { kind: ResourceView["kind"]; one: string; many: string }[] = [
  { kind: "course", one: "course", many: "courses" },
  { kind: "assignment", one: "assignment", many: "assignments" },
  { kind: "material", one: "reading or file", many: "readings and files" },
  { kind: "event", one: "calendar event", many: "calendar events" },
  { kind: "message", one: "announcement or message", many: "announcements and messages" },
];
/** Course lists a student may simply not be shown (Canvas answers 401/403/404 for a hidden tab). */
const LIST_SCOPES = new Set(["pages", "files", "folders", "quizzes", "discussions", "assignment-groups", "submissions", "announcements", "syllabus", "modules", "calendar-discovery"]);
const isFileScope = (scope: string) => /^(?:file|document):/.test(scope);

function sourceLine(source: SourceHealth, busy: boolean): SourceLine {
  const progress = source.progress;
  // A read with no total can't say it's done, so only a running sync keeps an unfinished source in flight.
  // Canvas batches carry no total and a terminal phase ("complete", "inaccessible"), so progress alone isn't.
  const inFlight =
    progress !== undefined &&
    (progress.total === undefined
      ? busy && !source.complete && (source.status === "ok" || source.status === "partial")
      : progress.completed < progress.total);
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
  const why = source.diagnostics?.map((d) => whys[d.code]).find(Boolean);
  if (source.status === "ok" || source.status === "partial")
    return {
      id: source.id,
      label: source.label,
      state: "partial",
      status: "Partly read",
      reason: reasons.partial,
      detail: found,
      action: "retry",
      ...(why ? { why } : {}),
    };
  return {
    id: source.id,
    label: source.label,
    state: "failed",
    status: source.status === "needs_sign_in" ? "Sign in needed" : "Not read",
    reason: reasons[source.status],
    detail: source.resourceCount > 0 ? `${found} earlier` : undefined,
    ...(actionFor(source.status) ? { action: actionFor(source.status) } : {}),
    ...(why ? { why } : {}),
  };
}

export function summarize(snapshot: Snapshot, busy: boolean): PopulateSummary {
  // The student's course choices: a course they excluded, and Canvas's nameless rows, are not issues.
  const sourceById = new Map(snapshot.sources.map((s) => [s.id, s]));
  const overrides = new Map((snapshot.courseOverrides ?? []).map((o) => [`${o.accountScope}|${o.courseId}`, o.included]));
  const courseRows = new Map<string, ResourceView>();
  for (const r of snapshot.resources) {
    const source = sourceById.get(r.sourceId);
    if (r.kind === "course" && !r.deleted && r.course && source?.scope === "course") courseRows.set(`${source.accountScope}|${r.courseId}`, r);
  }
  const included = (key: string) => {
    const row = courseRows.get(key);
    if (!row) return true;
    if (row.course?.accessRestricted || /\(name unavailable\)$/.test(row.courseName)) return false;
    return overrides.get(key) ?? row.course?.selection?.included ?? true;
  };
  const lines: SourceLine[] = [];
  const files = new Map<string, { done: number; arriving: number; failed: number; name: string }>();
  let hiddenLists = 0;
  for (const source of snapshot.sources) {
    const key = `${source.accountScope}|${source.courseId}`;
    if (source.kind === "canvas" && courseRows.has(key) && !included(key)) continue;
    if (source.status === "inaccessible" && (LIST_SCOPES.has(source.scope) || isFileScope(source.scope))) {
      hiddenLists++; // not available to students: fine, and not a partial read
      continue;
    }
    if (isFileScope(source.scope)) {
      const entry = files.get(key) ?? { done: 0, arriving: 0, failed: 0, name: courseRows.get(key)?.courseName ?? "Course" };
      const deferred = source.diagnostics?.some((d) => d.code === "file_budget_deferred");
      if (source.status === "ok" && source.complete) entry.done++;
      else if (deferred || source.progress || (busy && source.status === "ok")) entry.arriving++;
      else entry.failed++;
      files.set(key, entry);
      continue;
    }
    lines.push(sourceLine(source, busy));
  }
  for (const [key, entry] of files)
    lines.push({
      id: `files:${key}`,
      label: `${entry.name} · course files`,
      state: entry.arriving ? "reading" : entry.failed ? "partial" : "ready",
      status: entry.arriving ? "Still coming in" : entry.failed ? "Partly read" : "Done",
      detail: `${entry.done} of ${entry.done + entry.arriving + entry.failed} read`,
      ...(!entry.arriving && entry.failed
        ? { reason: `${entry.failed} ${entry.failed === 1 ? "file" : "files"} could not be read.`, action: "why" as const,
            why: "Some files could not be downloaded or have no readable text (a scan, a video). Each one is listed in Sources with its cause." }
        : {}),
    });
  const live = snapshot.resources.filter((resource) => !resource.deleted);
  const counts = kindWords
    .map(({ kind, one, many }) => {
      const count = live.filter((resource) => resource.kind === kind).length;
      return { label: count === 1 ? one : many, count };
    })
    .filter((entry) => entry.count > 0);
  const nonFile = lines.filter((line) => !line.id.startsWith("files:"));
  const issues = nonFile.some((line) => line.state === "partial" || line.state === "failed");
  const reading = busy || lines.some((line) => line.state === "reading");
  // Ready once every included course has its assignments and modules read; files may follow.
  const includedCourses = [...courseRows.keys()].filter(included);
  const read = (key: string, scope: string) =>
    snapshot.sources.some((s) => `${s.accountScope}|${s.courseId}` === key && s.scope === scope && (s.status === "ok" ? s.complete : s.status === "inaccessible"));
  const coursesReady =
    includedCourses.length > 0 && includedCourses.every((key) => read(key, "assignments") && read(key, "modules"));
  const filesArriving = [...files.values()].reduce((sum, entry) => sum + entry.arriving, 0);
  const outcome =
    lines.length === 0 && !busy
      ? "empty"
      : coursesReady && !issues
        ? "ready"
        : nonFile.some((line) => line.state === "reading") || (busy && !coursesReady)
          ? "reading"
          : issues
            ? "issues"
            : "ready";
  return { sources: lines, counts, total: live.length, reading, filesArriving, hiddenLists, outcome };
}

// --- Plain categories (owner: source-categories) ------------------------------------------------
/**
 * One line per category a student recognises (Canvas, UW enrollment, Outlook, Notes, Course
 * websites), built from `summarize`'s own per-source lines so both agree on what is excluded, hidden,
 * reading, partial or failed. The raw lines stay in `parts` for the developer details.
 */
export interface CategoryLine extends SourceLine {
  category: SourceCategory;
  parts: SourceLine[];
}
const rank: Record<SourceState, number> = { ready: 0, reading: 1, partial: 2, failed: 3 };
export function categorizeSummary(snapshot: Pick<Snapshot, "sources" | "planning">, summary: Pick<PopulateSummary, "sources">): CategoryLine[] {
  const byId = new Map(snapshot.sources.map((s) => [s.id, s]));
  const groups = new Map<SourceCategory, SourceLine[]>();
  for (const line of summary.sources) {
    const source = byId.get(line.id);
    const category: SourceCategory = line.id.startsWith("files:") || !source ? "canvas" : sourceCategory(source);
    groups.set(category, [...(groups.get(category) ?? []), line]);
  }
  for (const p of snapshot.planning?.sources ?? []) {
    const signIn = p.diagnostics.some((d) => /sign.?in/i.test(`${d.code} ${d.message}`));
    const line: SourceLine = p.status === "complete"
      ? { id: p.id, label: p.source, state: "ready", status: "Done" }
      : p.status === "partial"
        ? { id: p.id, label: p.source, state: "partial", status: "Partly read", reason: reasons.partial, action: "retry" }
        : { id: p.id, label: p.source, state: "failed", status: signIn ? "Sign in needed" : "Not read", reason: signIn ? reasons.needs_sign_in : reasons.error, action: signIn ? "sign-in" : "retry" };
    groups.set("uw", [...(groups.get("uw") ?? []), line]);
  }
  return SOURCE_CATEGORY_ORDER.filter((category) => groups.has(category)).map((category) => {
    const parts = groups.get(category)!;
    const base = { id: `category:${category}`, category, label: SOURCE_CATEGORIES[category].name, parts };
    const worst = parts.reduce((w, part) => (rank[part.state] > rank[w] ? part.state : w), "ready" as SourceState);
    const problems = parts.filter((part) => part.state === "partial" || part.state === "failed");
    const signIn = problems.find((part) => part.action === "sign-in");
    if (signIn) return { ...base, state: "failed", status: "Sign in again", reason: signIn.reason, action: "sign-in" };
    if (problems.length) {
      const filesOnly = problems.every((part) => part.id.startsWith("files:"));
      const none = problems.length === parts.length && problems.every((part) => part.state === "failed");
      const why = problems.map((part) => part.why).find(Boolean);
      return {
        ...base, state: worst, action: "retry",
        status: filesOnly ? "Some files couldn't be read" : none ? "Couldn't be read" : "Some parts couldn't be read",
        reason: filesOnly ? problems.map((part) => part.reason).find(Boolean) : none ? reasons.error : reasons.partial,
        ...(why ? { why } : {}),
      };
    }
    if (worst === "reading") return { ...base, state: "reading", status: "Updating" };
    return { ...base, state: "ready", status: "Up to date" };
  });
}
