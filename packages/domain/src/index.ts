import type {
  ConsentRecord,
  DeadlineClaim,
  DeadlineEvidenceClaim,
  DeadlineOrigin,
  DeadlineResolution,
  PrivacyPreferences,
  UnresolvedDeadlineMention,
} from "@magic/contracts";
export * from "./today-rail";
export * from "./work";
export * from "./course-label";
export * from "./changes";
export * from "./notifications";
import { zonedDate } from "./deadline-extraction";
export * from "./deadline-extraction";

/**
 * Authority order, strongest first. An explicit change (e.g. a later instructor
 * announcement saying "extended to ...") sits below Canvas's structured field
 * but above every other prose source, which it supersedes with a visible note.
 * Disagreement with Canvas is never overridden: it stays a conflict and planning
 * uses the earlier date.
 */
export const DEADLINE_AUTHORITY: ReadonlyArray<DeadlineOrigin | "explicit_change"> = [
  "canvas",
  "explicit_change",
  "assignment_text",
  "announcement",
  "syllabus",
  "page",
  "calendar",
  "title",
];
const LABEL: Record<DeadlineOrigin | "explicit_change", string> = {
  canvas: "Canvas due date",
  explicit_change: "announced change",
  assignment_text: "assignment description",
  announcement: "announcement",
  syllabus: "syllabus",
  page: "course page",
  calendar: "calendar feed",
  title: "title (lowest authority)",
};
const originOf = (c: DeadlineEvidenceClaim): DeadlineOrigin =>
  c.origin ??
  (c.authority === "title"
    ? "title"
    : c.authority === "explicit_change"
      ? "announcement"
      : c.authority === "document"
        ? "assignment_text"
        : "canvas");
const tierOf = (c: DeadlineEvidenceClaim) =>
  c.authority === "explicit_change"
    ? 1
    : DEADLINE_AUTHORITY.indexOf(originOf(c));
const basisOf = (c: DeadlineEvidenceClaim) =>
  c.authority === "explicit_change" ? "explicit_change" : originOf(c);
const iso = (v: string) => new Date(v).toISOString();
const dayKeys = new Map<string, string>();
/** America/Chicago calendar day; memoized because Intl formatting dominates pairwise comparison. */
const dayKey = (v: string) => {
  let key = dayKeys.get(v);
  if (key === undefined) {
    const d = zonedDate(v);
    key = `${d.y}-${d.m}-${d.d}`;
    if (dayKeys.size > 20_000) dayKeys.clear();
    dayKeys.set(v, key);
  }
  return key;
};
/** Same instant, or the same America/Chicago day when either side has no time of day. */
function agree(a: DeadlineEvidenceClaim, b: DeadlineEvidenceClaim) {
  return a.precision === "day" || b.precision === "day"
    ? dayKey(a.value) === dayKey(b.value)
    : iso(a.value) === iso(b.value);
}
const chicagoDisplay = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const show = (v: string) => chicagoDisplay.format(new Date(v));
const describe = (c: DeadlineEvidenceClaim) =>
  `${LABEL[basisOf(c)]}: ${c.precision === "day" ? `${dayKey(c.value)} (no time stated)` : show(c.value)}`;
/** Groups agreeing claims: timed claims by instant; a day-only claim joins a timed group on its day. */
function clusters(claims: DeadlineEvidenceClaim[]) {
  const timed = new Map<string, DeadlineEvidenceClaim[]>();
  const byDay = new Map<string, DeadlineEvidenceClaim[]>();
  const days: DeadlineEvidenceClaim[] = [];
  for (const c of claims) {
    if (c.precision === "day") {
      days.push(c);
      continue;
    }
    const k = iso(c.value);
    let group = timed.get(k);
    if (!group) {
      timed.set(k, (group = []));
      if (!byDay.has(dayKey(k))) byDay.set(dayKey(k), group);
    }
    group.push(c);
  }
  const dayOnly = new Map<string, DeadlineEvidenceClaim[]>();
  for (const c of days) {
    const k = dayKey(c.value);
    const group = byDay.get(k) ?? dayOnly.get(k) ?? [];
    if (!group.length) dayOnly.set(k, group);
    group.push(c);
  }
  return [...timed.values(), ...dayOnly.values()];
}
const representative = (group: DeadlineEvidenceClaim[]) =>
  group.find((c) => c.precision !== "day") ?? group[0]!;

export function resolveDeadline(
  claims: DeadlineEvidenceClaim[],
  unresolved: UnresolvedDeadlineMention[] = [],
): DeadlineResolution {
  const notes: string[] = [];
  for (const c of claims)
    if (c.kind === "due" && !c.scopeConfirmed)
      notes.push(`Not used: ${describe(c)} is not confirmed to apply to this item.`);
  for (const u of unresolved)
    notes.push(`Unresolved ${u.kind} mention in ${LABEL[u.origin]} (“${u.span.text.slice(0, 160)}”): ${u.reason}`);
  const locks = claims.filter((c) => c.kind === "lock" && c.scopeConfirmed);
  const lockTier = Math.min(...locks.map(tierOf));
  const lockTop = clusters(locks.filter((c) => tierOf(c) === lockTier));
  const lockAt = lockTop.length === 1 ? iso(representative(lockTop[0]!).value) : null;
  const due = claims.filter((c) => c.kind === "due" && c.scopeConfirmed);
  if (!due.length)
    return {
      dueAt: null,
      planningAt: null,
      conflict: false,
      claims,
      reason: unresolved.some((u) => u.kind === "due")
        ? "No confirmed due date. A deadline is mentioned but its date cannot be determined from the source."
        : "No confirmed due date in available evidence.",
      preferredAt: null,
      basis: null,
      notes,
      unresolved,
      lockAt,
    };

  // Later changes replace earlier ones only when both post times are known.
  const superseded = new Set<DeadlineEvidenceClaim>();
  const changes = due.filter((c) => c.authority === "explicit_change");
  for (const a of changes)
    for (const b of changes)
      if (a !== b && a.statedAt && b.statedAt && b.statedAt > a.statedAt && !agree(a, b) && !superseded.has(a)) {
        superseded.add(a);
        notes.push(`Superseded: ${describe(a)} was replaced by a later change (${describe(b)}).`);
      }
  const live = changes.filter((c) => !superseded.has(c));
  const liveGroups = clusters(live);
  if (liveGroups.length === 1) {
    const change = representative(liveGroups[0]!);
    for (const c of due)
      if (tierOf(c) > 1 && !agree(c, change) && !superseded.has(c)) {
        superseded.add(c);
        notes.push(
          `Superseded: ${describe(c)} is replaced by the announced change to ${show(change.value)}${
            change.supersedes && dayKey(change.supersedes) === dayKey(c.value) ? " (the change names this date as the old one)" : ""
          }.`,
        );
      }
    for (const c of due)
      if (tierOf(c) === 0 && !agree(c, change))
        notes.push(
          change.supersedes && dayKey(change.supersedes) === dayKey(c.value)
            ? `Canvas still lists ${show(c.value)}, the date an announced change moved to ${show(change.value)}. Planning uses the earlier date until Canvas reflects the change.`
            : `Canvas lists ${show(c.value)} but an announced change says ${show(change.value)}.`,
        );
  } else if (liveGroups.length > 1)
    notes.push("Announced changes disagree and their order is unknown; none supersedes the others.");

  const active = due
    .filter((c) => !superseded.has(c))
    .sort((a, b) => tierOf(a) - tierOf(b));
  const topTier = tierOf(active[0]!);
  const topGroups = clusters(active.filter((c) => tierOf(c) === topTier));
  const preferred = topGroups.length === 1 ? representative(topGroups[0]!) : null;
  const disagreeing = preferred ? active.filter((c) => !agree(c, preferred)) : active;
  const conflict = !preferred || disagreeing.length > 0;
  for (const c of preferred ? disagreeing : [])
    if (!(liveGroups.length === 1 && c.authority === "explicit_change"))
      notes.push(`Disagrees: ${describe(c)} vs. ${describe(preferred!)}.`);
  for (const c of active)
    if (c.inference === "year_from_term" || c.inference === "year_from_source_date")
      notes.push(`Year inferred ${c.inference === "year_from_term" ? "from the course term" : "from the source's own date"} for ${describe(c)}.`);
    else if (c.inference === "relative_to_post")
      notes.push(`Relative day resolved from the announcement's post time for ${describe(c)}.`);
  // Conservative planning: earliest remaining claim; a day-only claim yields to a timed claim on the same day.
  const timedDays = new Set(active.filter((c) => c.precision !== "day").map((c) => dayKey(c.value)));
  const planning = active
    .filter((c) => c.precision !== "day" || !timedDays.has(dayKey(c.value)))
    .map((c) => iso(c.value))
    .sort();
  const basis = preferred ? basisOf(preferred) : null;
  const reason = conflict
    ? preferred
      ? `Dates disagree. Plan for the earlier date until resolved. The strongest source (${LABEL[basisOf(preferred)]}) says ${show(preferred.value)}.`
      : "Dates disagree. Plan for the earlier date until resolved."
    : preferred!.precision === "day"
      ? `Due ${dayKey(preferred!.value)} per ${LABEL[basisOf(preferred!)]}; no time of day is stated.`
      : basis === "explicit_change"
        ? "An explicit, scoped change establishes this due date."
        : basis === "title"
          ? "Only the item's title states this date (lowest authority). Confirm it in the source."
          : "Available scoped claims agree.";
  return {
    dueAt: !conflict && preferred!.precision !== "day" ? iso(preferred!.value) : null,
    planningAt: planning[0] ?? null,
    conflict,
    claims,
    reason,
    preferredAt: preferred ? iso(preferred.value) : null,
    basis,
    notes,
    unresolved,
    lockAt,
  };
}
// owner: T06. Consent and the send decision (spec G1; tasks.md T06).
/**
 * The disclosure the setup screen and a provider's consent screen show. A record written for
 * another version is not current, so changing the disclosure asks again.
 */
// T30: bumped for the Outlook (Microsoft Graph) line, OUTLOOK_GRAPH_DISCLOSURE in contracts.
export const CONSENT_DISCLOSURE_VERSION = "setup-2026-09-26-outlook";
/**
 * Storage attaches the consent records to `privacy()` under this registered symbol as a
 * non-enumerable, frozen property. Spread, JSON, structured clone (IPC) and zod parsing all
 * drop it, so the `privacy` command can never write consent and the renderer never receives
 * it through `snapshot.privacy`. `Symbol.for` lets storage (which does not depend on this
 * package) use the same key.
 */
export const consentRecordsKey: unique symbol = Symbol.for("magic.consentRecords");
export type PrivacyWithConsents = PrivacyPreferences & {
  readonly [consentRecordsKey]?: readonly ConsentRecord[];
};
/** Returns preferences carrying `records` the way storage does; for callers and tests. */
export function withConsents(
  p: PrivacyPreferences,
  records: readonly ConsentRecord[],
): PrivacyWithConsents {
  return Object.defineProperty({ ...p }, consentRecordsKey, {
    value: Object.freeze([...records]),
    enumerable: false,
  }) as PrivacyWithConsents;
}
export function consentsOf(p: PrivacyWithConsents): readonly ConsentRecord[] {
  const records = p[consentRecordsKey];
  return Array.isArray(records) ? records : [];
}
/** True only for a record of this recipient with the current disclosure version. */
export function hasCurrentConsent(
  records: readonly Pick<ConsentRecord, "recipient" | "disclosureVersion">[] | undefined,
  recipient: ConsentRecord["recipient"],
): boolean {
  return (records ?? []).some(
    (r) =>
      r.recipient === recipient &&
      r.disclosureVersion === CONSENT_DISCLOSURE_VERSION,
  );
}
const sendCategories = [
  "course_text",
  "student_work",
  "grades",
  "comments",
  "communications",
  "planning",
  "holds",
  "audit",
];
/** Degree plans, holds and audits never leave the device, whatever the flags say. */
const deviceOnlyCategories = ["planning", "holds", "audit"];
const hostedRecipients = [
  "jev",
  "chatgpt",
  "codex",
  "claude",
  "gemini",
  "openrouter",
] as const;
export function maySend(
  p: PrivacyWithConsents,
  recipient: string,
  categories: string[],
): { allowed: boolean; reason: string } {
  if (categories.some((category) => !sendCategories.includes(category)))
    return {
      allowed: false,
      reason: "This data category has no sharing permission.",
    };
  if (recipient === "local")
    return { allowed: true, reason: "Processed on this device." };
  if (categories.some((category) => deviceOnlyCategories.includes(category)))
    return {
      allowed: false,
      reason: "Degree plans, holds and audits never leave this device.",
    };
  if (!(hostedRecipients as readonly string[]).includes(recipient))
    return { allowed: false, reason: "This recipient is not supported." };
  if (p.mode === "local_only")
    return { allowed: false, reason: "Fully local processing is enabled." };
  if (recipient === "jev" && !p.jevEnabled)
    return { allowed: false, reason: "Hosted Jev judgments are disabled." };
  if (recipient !== "jev" && p.hostedProvider !== recipient)
    return { allowed: false, reason: "This hosted AI has not been selected." };
  if (
    !hasCurrentConsent(
      consentsOf(p),
      recipient as (typeof hostedRecipients)[number],
    )
  )
    return {
      allowed: false,
      reason: "You have not agreed to share data with this service yet.",
    };
  if (categories.includes("course_text") && !p.shareCourseText)
    return { allowed: false, reason: "Sharing course text is disabled." };
  if (categories.includes("student_work") && !p.shareStudentWork)
    return { allowed: false, reason: "Sharing student work is disabled." };
  if (categories.includes("grades") && !p.shareGrades)
    return { allowed: false, reason: "Sharing grades is disabled." };
  if (categories.includes("comments") && !p.shareComments)
    return { allowed: false, reason: "Sharing grader comments is disabled." };
  if (categories.includes("communications") && !p.shareCommunications)
    return { allowed: false, reason: "Sharing communications is disabled." };
  return {
    allowed: true,
    reason: "Allowed by your current data-sharing settings.",
  };
}
// end owner: T06

export * from "./calendar-coverage";

export * from "./course-policy";
