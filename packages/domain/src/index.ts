import type {
  ConsentRecord,
  DeadlineClaim,
  DeadlineResolution,
  PrivacyPreferences,
} from "@magic/contracts";
export function resolveDeadline(claims: DeadlineClaim[]): DeadlineResolution {
  const due = claims.filter((c) => c.kind === "due" && c.scopeConfirmed);
  if (!due.length)
    return {
      dueAt: null,
      planningAt: null,
      conflict: false,
      claims,
      reason: "No confirmed due date in available evidence.",
    };
  const moved = due.filter((c) => c.authority === "explicit_change");
  const considered = moved.length ? moved : due;
  const times = [
    ...new Set(considered.map((c) => new Date(c.value).toISOString())),
  ].sort();
  return {
    dueAt: times.length === 1 ? times[0] : null,
    planningAt: times[0],
    conflict: times.length > 1,
    claims,
    reason:
      times.length > 1
        ? "Dates disagree. Plan for the earlier date until resolved."
        : moved.length
          ? "An explicit, scoped change establishes this due date."
          : "Available scoped claims agree.",
  };
}
// owner: T06. Consent and the send decision (spec G1; tasks.md T06).
/**
 * The disclosure the setup screen and a provider's consent screen show. A record written for
 * another version is not current, so changing the disclosure asks again.
 */
export const CONSENT_DISCLOSURE_VERSION = "setup-2026-09-26";
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
