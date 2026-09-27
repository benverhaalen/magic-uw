import type { CaptureDiagnostic, PlanningSourceHealth, Snapshot, SourceHealth, SyncRun } from "@magic/contracts";

// owner: sources page. Pure projection of saved source health into connections the student manages.
// Rules: unknown, stale or partial coverage is never reported as complete; raw labels stay available.

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const OUTLOOK_CALENDAR_COURSE_ID = "outlook-calendar";
const ACCOUNT_COURSES = new Set(["connection", "account"]);

export type ReadState = "complete" | "limited" | "partial" | "restricted" | "needs_sign_in" | "error" | "not_checked";
export type ConnectionState = "connected" | "partial" | "stale" | "needs_sign_in" | "error" | "not_connected" | "sample";

export interface ScopeCoverage {
  id: string;
  scope: string;
  kind: SourceHealth["kind"];
  state: ReadState;
  records: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  notes: string[];
}
export interface CourseCoverage {
  key: string;
  accountScope: string;
  courseId: string;
  /** The source's own course name, unmodified. */
  rawName: string;
  /** A concise display label when one is known; otherwise the raw name. */
  label: string;
  state: ReadState;
  records: number;
  /** Oldest successful read among this course's sections: the conservative freshness. */
  oldestSuccessAt: string | null;
  newestAttemptAt: string | null;
  scopes: ScopeCoverage[];
  needsGitLab: boolean;
}
export interface Connection {
  id: string;
  name: string;
  /** Short account line under the name. */
  accountShort: string;
  account: string;
  /** What this connection actually reads, from its supported capability. */
  covers: string;
  /** Short freshness phrase for the collapsed row. */
  freshness: string;
  state: ConnectionState;
  /** What the row cannot say itself; empty when the state and freshness already say it all. */
  headline: string;
  newestAttemptAt: string | null;
  /** Newest successful read, used for staleness. */
  newestSuccessAt: string | null;
  oldestSuccessAt: string | null;
  records: number;
  courses: CourseCoverage[];
  sources: ScopeCoverage[];
  notes: string[];
}
/** A concise label keyed like the domain courseKey: `${accountScope}:${courseId}`. */
export interface CourseLabel { key: string; label: string }

const readRank: Record<ReadState, number> = { needs_sign_in: 6, error: 5, partial: 4, restricted: 3, not_checked: 2, limited: 1, complete: 0 };
export const readLabels: Record<ReadState, string> = {
  complete: "Complete",
  limited: "Some sections unavailable",
  partial: "Partial",
  restricted: "Access restricted",
  needs_sign_in: "Sign in needed",
  error: "Could not read",
  not_checked: "Not checked",
};

export function readState(source: Pick<SourceHealth, "status" | "complete" | "lastSuccessAt">): ReadState {
  switch (source.status) {
    case "needs_sign_in": return "needs_sign_in";
    case "error": return "error";
    case "inaccessible":
    case "not_published": return "restricted";
    case "partial":
    case "needs_attention": return "partial";
    case "ok": return source.complete ? "complete" : "partial";
    default: return "not_checked";
  }
}

const diagnosticText: Record<string, string> = {
  host_rate_limited: "Canvas asked Magic to slow down. The rest is read on a later check.",
  scope_time_limit: "Reading this section stopped at its time limit.",
  record_limit: "This section has more records than one read allows.",
  response_byte_limit: "A response was too large to save.",
  cancelled: "The read was stopped before it finished.",
  unauthorized: "Canvas asked for sign-in.",
  needs_sign_in: "Canvas asked for sign-in.",
  not_found: "Canvas reported this section as missing.",
  refresh_failed: "The refresh did not finish.",
  unexpected_redirect: "Canvas redirected unexpectedly, often because a session ended.",
  account_recheck_failed: "The account check did not finish.",
  recurrence_truncated: "Some repeating events were shortened to a reading limit.",
  recurrence_not_expanded: "Some repeating events could not be expanded.",
};
export function describeDiagnostic(diagnostic: Pick<CaptureDiagnostic, "code">): string {
  return diagnosticText[diagnostic.code] ?? `Read note: ${diagnostic.code.replaceAll("_", " ")}`;
}

function scopeOf(source: SourceHealth): ScopeCoverage {
  const notes = [...new Set((source.diagnostics ?? []).map(describeDiagnostic))];
  return {
    id: source.id,
    scope: source.scope,
    kind: source.kind,
    state: readState(source),
    records: source.resourceCount,
    lastAttemptAt: source.lastAttemptAt || null,
    lastSuccessAt: source.lastSuccessAt,
    notes,
  };
}
function worst(states: ReadState[]): ReadState {
  return states.reduce<ReadState>((a, b) => (readRank[b] > readRank[a] ? b : a), states.length ? "complete" : "not_checked");
}
const newest = (values: (string | null)[]) => values.filter((v): v is string => !!v).sort().at(-1) ?? null;
const oldest = (values: (string | null)[]) => {
  if (values.some((v) => !v)) return null; // one never-read section means no complete read yet
  return values.filter((v): v is string => !!v).sort()[0] ?? null;
};
/** When every section was last read in full; null while any section's latest read is incomplete. */
const fullReadAt = (scopes: ScopeCoverage[]) =>
  scopes.every((s) => s.state === "complete" || s.state === "restricted") ? oldest(scopes.map((s) => s.lastSuccessAt)) : null;
/** The raw course name from a source label such as "Course name · assignments". */
export function rawCourseName(source: SourceHealth): string {
  const suffix = ` · ${source.scope}`;
  return source.label.endsWith(suffix) ? source.label.slice(0, -suffix.length) : source.label;
}

function courseState(scopes: ScopeCoverage[]): ReadState {
  const course = scopes.find((s) => s.scope === "course");
  if (course?.state === "restricted") return "restricted";
  const states = scopes.map((s) => s.state);
  const w = worst(states);
  // A hidden or unpublished section is normal; it does not make the rest of the course partial.
  if (w === "restricted") return "limited";
  return w;
}

export function buildCourses(sources: SourceHealth[], labels: CourseLabel[] = []): CourseCoverage[] {
  const groups = new Map<string, SourceHealth[]>();
  for (const s of sources) {
    if (s.kind === "fixture" || ACCOUNT_COURSES.has(s.courseId) || s.courseId === OUTLOOK_CALENDAR_COURSE_ID) continue;
    if (!["canvas", "web", "calendar", "gitlab", "kaltura", "feed"].includes(s.kind)) continue;
    const key = JSON.stringify([s.accountScope, s.courseId]);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  // Only groups anchored by a Canvas course read belong to the Canvas connection.
  return [...groups.entries()]
    .filter(([, group]) => group.some((s) => s.kind === "canvas"))
    .map(([key, group]) => {
      const canvas = group.find((s) => s.kind === "canvas" && s.scope === "course") ?? group.find((s) => s.kind === "canvas")!;
      const scopes = group.map(scopeOf).sort((a, b) => readRank[b.state] - readRank[a.state] || a.scope.localeCompare(b.scope));
      const rawName = rawCourseName(canvas);
      const label = labels.find((l) => l.key === `${canvas.accountScope}:${canvas.courseId}`)?.label || rawName;
      return {
        key,
        accountScope: canvas.accountScope,
        courseId: canvas.courseId,
        rawName,
        label,
        state: courseState(scopes),
        records: group.reduce((n, s) => n + s.resourceCount, 0),
        oldestSuccessAt: fullReadAt(scopes),
        newestAttemptAt: newest(group.map((s) => s.lastAttemptAt)),
        scopes,
        needsGitLab: group.some((s) => s.kind === "gitlab" && s.status === "needs_sign_in"),
      };
    })
    .sort((a, b) => readRank[b.state] - readRank[a.state] || a.label.localeCompare(b.label));
}

export function isStale(at: string | null, now: Date): boolean {
  if (!at) return true;
  const t = Date.parse(at);
  return Number.isNaN(t) || now.getTime() - t > STALE_AFTER_MS;
}

/** "Checked today at 2:14 PM", or the last successful read when the newest attempt failed. */
export function freshnessPhrase(attempt: string | null, success: string | null, now: Date): string {
  if (!attempt && !success) return "Never checked";
  if (success && (!attempt || success >= attempt)) return `Checked ${formatWhen(success, now)}`;
  return success ? `Last full read ${formatWhen(success, now)}` : `Tried ${formatWhen(attempt, now)}, never read in full`;
}

export function formatWhen(value: string | null, now: Date): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "at an unknown time";
  const sameDay = date.toDateString() === now.toDateString();
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  if (sameDay) return `today at ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `yesterday at ${time}`;
  const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }).format(date);
  return `${day} at ${time}`;
}

function canvasConnection(sources: SourceHealth[], labels: CourseLabel[], now: Date): Connection {
  const canvas = sources.filter((s) => s.kind === "canvas");
  const courses = buildCourses(sources, labels);
  const accountSources = canvas.filter((s) => ACCOUNT_COURSES.has(s.courseId)).map(scopeOf);
  const all = [...accountSources, ...courses.flatMap((c) => c.scopes)];
  const newestAttemptAt = newest(canvas.map((s) => s.lastAttemptAt));
  const newestSuccessAt = newest(canvas.map((s) => s.lastSuccessAt));
  const accounts = new Set(canvas.filter((s) => !s.accountScope.startsWith("connection:")).map((s) => s.accountScope));
  const notes: string[] = [];
  if (accounts.size > 1) notes.push("Coursework from more than one Canvas account is saved on this device.");
  const incomplete = courses.filter((c) => ["partial", "error", "not_checked", "needs_sign_in"].includes(c.state)).length;
  const base = {
    id: "canvas",
    name: "Canvas",
    accountShort: "UW NetID",
    account: "UW NetID session in the app's own browser. It stays on this device.",
    covers: "Courses, assignments, announcements, pages, files and due dates",
    freshness: freshnessPhrase(newestAttemptAt, newestSuccessAt, now),
    newestAttemptAt,
    newestSuccessAt,
    oldestSuccessAt: fullReadAt(all),
    records: canvas.reduce((n, s) => n + s.resourceCount, 0) + courses.reduce((n, c) => n + c.scopes.filter((s) => s.kind !== "canvas").reduce((m, s) => m + s.records, 0), 0),
    courses,
    sources: accountSources,
    notes,
  };
  if (!canvas.length) return { ...base, state: "not_connected", headline: "" };
  // Only Canvas's own session decides this; a course GitLab sign-in is reported on its course.
  if (all.some((s) => s.kind === "canvas" && s.state === "needs_sign_in"))
    return { ...base, state: "needs_sign_in", headline: `Last successful read ${formatWhen(newestSuccessAt, now)}. Saved coursework is still here.` };
  const connection = accountSources.find((s) => s.scope === "connection");
  if (connection?.state === "error" || (all.length > 0 && all.every((s) => s.state === "error")))
    return { ...base, state: "error", headline: `The last check did not finish (${formatWhen(newestAttemptAt, now)}). Saved coursework is still here.` };
  if (incomplete > 0)
    return { ...base, state: "partial", headline: `${incomplete} of ${courses.length} ${courses.length === 1 ? "course" : "courses"} ${incomplete === 1 ? "was" : "were"} not read completely.` };
  if (isStale(newestSuccessAt, now))
    return { ...base, state: "stale", headline: `Last successful read ${formatWhen(newestSuccessAt, now)}. Coursework may have changed since.` };
  return { ...base, state: "connected", headline: `${courses.length} ${courses.length === 1 ? "course" : "courses"} read${courses.some((c) => c.state === "limited") ? ", some sections unavailable" : " completely"}.` };
}

export interface OutlookFacts {
  /** Published calendar (ICS) link saved; null when the bridge cannot tell. */
  icsConnected: boolean | null;
  /** Microsoft sign-in (Graph) state when this build supports it. */
  graph?: { state: "not_set_up" | "not_connected" | "connected" | "needs_uw_approval" | "expired" | "error"; lastSyncAt: string | null; messages: number; events: number } | null;
}
function outlookConnection(sources: SourceHealth[], facts: OutlookFacts, now: Date): Connection {
  const ics = sources.filter((s) => s.kind === "calendar" && s.courseId === OUTLOOK_CALENDAR_COURSE_ID && !s.scope.startsWith("graph_"));
  const graph = sources.filter((s) => s.scope.startsWith("graph_"));
  const scoped = [...ics, ...graph].map(scopeOf);
  const newestAttemptAt = newest([...ics, ...graph].map((s) => s.lastAttemptAt));
  const newestSuccessAt = newest([...[...ics, ...graph].map((s) => s.lastSuccessAt), facts.graph?.lastSyncAt ?? null]);
  const graphAvailable = Boolean(facts.graph && facts.graph.state !== "not_set_up");
  const base = {
    id: "outlook",
    name: "Outlook",
    accountShort: graphAvailable ? "UW Microsoft account" : "Published calendar link",
    account: graphAvailable ? "Your UW Microsoft account, read through the app's own sign-in." : "Your published Outlook calendar link, stored encrypted on this device.",
    covers: graphAvailable
      ? "Calendar events, mail previews, OneNote pages and linked OneDrive files"
      : "Meetings and appointments: titles, times and locations",
    freshness: freshnessPhrase(newestAttemptAt, newestSuccessAt, now),
    newestAttemptAt,
    newestSuccessAt,
    oldestSuccessAt: fullReadAt(scoped),
    records: scoped.reduce((n, s) => n + s.records, 0),
    courses: [],
    sources: scoped,
    notes: [] as string[],
  };
  const g = facts.graph?.state;
  const connected = facts.icsConnected === true || g === "connected";
  if (g === "expired") return { ...base, state: "needs_sign_in", headline: "Microsoft sign-in ended. Saved meetings and mail may be out of date." };
  if (g === "needs_uw_approval") return { ...base, state: "error", headline: "UW has not approved Microsoft access for this app yet. Nothing new is read." };
  if (g === "error") return { ...base, state: "error", headline: "The Microsoft connection reported a problem. Saved items are unchanged." };
  if (!connected) {
    if (facts.icsConnected === null && !g) return { ...base, state: "not_connected", headline: "Connection status is not available in this build." };
    return { ...base, state: "not_connected", headline: "" };
  }
  if (scoped.some((s) => s.state === "error" || s.state === "partial" || s.state === "needs_sign_in"))
    return { ...base, state: "partial", headline: "Part of the calendar could not be read." };
  if (!scoped.length && !facts.graph?.lastSyncAt) return { ...base, state: "stale", headline: "Connected. Not read yet; refresh to add your meetings." };
  if (isStale(newestSuccessAt, now)) return { ...base, state: "stale", headline: `Last successful read ${formatWhen(newestSuccessAt, now)}. Meetings may have changed since.` };
  return { ...base, state: "connected", headline: "" };
}

const planningNames: Record<PlanningSourceHealth["source"], string> = {
  uw_public: "UW public course data",
  uw_enroll: "Enroll",
  uw_myuw: "MyUW",
  uw_dars: "Degree audit",
  madgrades: "Madgrades",
  normalized_import: "Imported planning file",
};
function planningConnection(planning: PlanningSourceHealth[], now: Date): Connection {
  const sources: ScopeCoverage[] = planning.map((p) => ({
    id: p.id,
    scope: `${planningNames[p.source]} · ${p.scope.kind.replaceAll("_", " ")}`,
    kind: "web",
    state: p.status === "complete" ? "complete" : p.status === "partial" ? "partial" : p.status === "blocked" ? "restricted" : "error",
    records: 0,
    lastAttemptAt: p.observedAt,
    lastSuccessAt: p.lastSuccessAt,
    notes: p.diagnostics.map((d) => d.message),
  }));
  const newestAttemptAt = newest(sources.map((s) => s.lastAttemptAt));
  const newestSuccessAt = newest(sources.map((s) => s.lastSuccessAt));
  const base = { id: "myuw", name: "UW planning", accountShort: "UW NetID", account: "Your UW student record, degree audit and public course data.", covers: "Student record, degree audit, planned courses and public class data", freshness: freshnessPhrase(newestAttemptAt, newestSuccessAt, now), newestAttemptAt, newestSuccessAt, oldestSuccessAt: fullReadAt(sources), records: 0, courses: [], sources, notes: [] };
  if (!sources.length) return { ...base, state: "not_connected", headline: "" };
  const bad = sources.filter((s) => s.state !== "complete").length;
  if (bad) return { ...base, state: "partial", headline: `${bad} of ${sources.length} planning sources are incomplete.` };
  if (isStale(newestSuccessAt, now)) return { ...base, state: "stale", headline: `Last successful read ${formatWhen(newestSuccessAt, now)}. Planning details may have changed.` };
  return { ...base, state: "connected", headline: "" };
}

function otherConnections(sources: SourceHealth[], claimed: Set<string>, now: Date): Connection[] {
  return sources
    .filter((s) => !claimed.has(s.id))
    .map((s) => {
      const scope = scopeOf(s);
      const sample = s.kind === "fixture";
      const state: ConnectionState = sample ? "sample" : scope.state === "complete" ? (isStale(s.lastSuccessAt, now) ? "stale" : "connected") : scope.state === "needs_sign_in" ? "needs_sign_in" : scope.state === "error" ? "error" : "partial";
      return {
        id: `source:${s.id}`,
        name: sample ? "Sample course" : s.label,
        accountShort: sample ? "Synthetic" : "Saved on this device",
        account: sample ? "Synthetic data, not from your school." : "Saved from an import or a linked page on this device.",
        covers: sample ? "Synthetic course records for trying the app" : `${s.resourceCount} saved ${s.resourceCount === 1 ? "record" : "records"}`,
        freshness: freshnessPhrase(s.lastAttemptAt, s.lastSuccessAt, now),
        state,
        headline: sample ? `${s.resourceCount} sample records.` : `${readLabels[scope.state]}. Last successful read ${formatWhen(s.lastSuccessAt, now)}.`,
        newestAttemptAt: s.lastAttemptAt,
        newestSuccessAt: s.lastSuccessAt,
        oldestSuccessAt: s.lastSuccessAt,
        records: s.resourceCount,
        courses: [],
        sources: [scope],
        notes: scope.notes,
      };
    });
}

export interface SourcesModel {
  connections: Connection[];
  summary: string;
  attention: Connection | null;
  runs: RunLine[];
}
export interface RunLine { id: string; when: string; trigger: string; result: string; detail: string; tone: "ok" | "attention" }

const triggerLabels: Record<SyncRun["action"], string> = { manual: "You refreshed", background: "Automatic check", calendar: "Calendar check", external: "Outside request", import: "Import" };
const runLabels: Record<SyncRun["status"], string> = { ok: "Finished", unchanged: "No changes", partial: "Partly read", needs_sign_in: "Stopped, sign-in needed", error: "Did not finish", cancelled: "Stopped" };

export function buildRuns(runs: SyncRun[] = [], now: Date, limit = 5): RunLine[] {
  return [...runs]
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))
    .slice(0, limit)
    .map((run) => {
      const seconds = run.stats?.durationMs != null ? Math.max(1, Math.round(run.stats.durationMs / 1000)) : null;
      return {
        id: run.id,
        when: formatWhen(run.finishedAt, now),
        trigger: triggerLabels[run.action],
        result: runLabels[run.status],
        detail: [run.sourceCount != null ? `${run.sourceCount} ${run.sourceCount === 1 ? "section" : "sections"}` : "", seconds != null ? `${seconds}s` : ""].filter(Boolean).join(", "),
        tone: run.status === "ok" || run.status === "unchanged" ? "ok" : "attention",
      };
    });
}

const attentionOrder: ConnectionState[] = ["needs_sign_in", "error", "partial", "stale"];

export function buildSourcesModel(
  snapshot: Pick<Snapshot, "sources" | "syncRuns" | "planning">,
  options: { now: Date; outlook: OutlookFacts; labels?: CourseLabel[] },
): SourcesModel {
  const { now } = options;
  const canvas = canvasConnection(snapshot.sources, options.labels ?? [], now);
  const outlook = outlookConnection(snapshot.sources, options.outlook, now);
  const planning = planningConnection(snapshot.planning?.sources ?? [], now);
  const claimed = new Set<string>([
    ...snapshot.sources.filter((s) => s.kind === "canvas").map((s) => s.id),
    ...canvas.courses.flatMap((c) => c.scopes.map((s) => s.id)),
    ...outlook.sources.map((s) => s.id),
  ]);
  const others = otherConnections(snapshot.sources, claimed, now);
  const connections = [canvas, outlook, planning, ...others];
  const live = connections.filter((c) => c.state !== "not_connected" && c.state !== "sample");
  const attention = attentionOrder.map((state) => live.find((c) => c.state === state)).find(Boolean) ?? null;
  const summary = !live.length
    ? connections.some((c) => c.state === "sample")
      ? "Only sample data is saved. Nothing is read from your school yet."
      : "Nothing is connected yet. Sign in to UW to read your courses."
    : `${live.length} ${live.length === 1 ? "source" : "sources"} connected. ${attention ? statusSentence(attention) : "Everything was read on the last check."}`;
  return { connections, summary, attention, runs: buildRuns(snapshot.syncRuns, now) };
}

function statusSentence(c: Connection): string {
  switch (c.state) {
    case "needs_sign_in": return `${c.name} needs sign-in; saved items are still here.`;
    case "error": return `${c.name} could not be checked; saved items are still here.`;
    case "partial": return `${c.name} was not read completely.`;
    case "stale": return `${c.name} has not been read recently.`;
    default: return "";
  }
}
