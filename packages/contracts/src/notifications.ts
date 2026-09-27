import { z } from "zod";

/**
 * Notifications: code decides every level from stored changes. Jev may only raise a course
 * message (announcement or discussion) from info to important or urgent; it never lowers,
 * hides or dismisses anything, and it never sees grades, comments or planning records.
 */
export const MESSAGE_TRIAGE_QUESTION_VERSION = "message.triage.v1";
export const MESSAGE_KINDS = [
  "deadline_or_schedule_change",
  "exam_logistics",
  "action_required",
  "grade_or_feedback_released",
  "new_material_posted",
  "general_information",
  "other",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
/** At most this many upcoming assessments are offered as "does this message affect it?" candidates. */
export const MESSAGE_TRIAGE_MAX_UPCOMING = 10;

/** The complete state sent to Jev. Built by an explicit allowlist in core; nothing else leaves. */
export const messageTriageStateSchema = z
  .object({
    course: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    text: z.string().max(4000),
    upcoming: z
      .array(
        z
          .object({
            key: z.string().regex(/^a[0-9]$/),
            title: z.string().min(1).max(300),
            due: z.string().max(100),
          })
          .strict(),
      )
      .max(MESSAGE_TRIAGE_MAX_UPCOMING)
      // Each key names one "affects" question, so keys must be unique.
      .refine(
        (items) => new Set(items.map((u) => u.key)).size === items.length,
        "Upcoming keys must be unique.",
      ),
  })
  .strict();
export type MessageTriageState = z.infer<typeof messageTriageStateSchema>;

const probability = z.number().finite().min(0).max(1);
export const messageTriageResultSchema = z
  .object({
    kind: z.enum(MESSAGE_KINDS),
    kindProbabilities: z.record(z.enum(MESSAGE_KINDS), probability),
    /** Noul probability that the message asks the student to do something by a time. */
    actionRequired: probability,
    /** Noul probability per offered upcoming key (a0..a9) that the message changes that task. */
    affects: z.record(z.string().regex(/^a[0-9]$/), probability),
    model: z.string().min(1).max(100),
    questionVersion: z.literal(MESSAGE_TRIAGE_QUESTION_VERSION),
  })
  .strict()
  .refine(
    (v) =>
      MESSAGE_KINDS.every((k) => v.kindProbabilities[k] !== undefined) &&
      Math.abs(
        Object.values(v.kindProbabilities).reduce((a, b) => a + b, 0) - 1,
      ) <= 0.02 &&
      v.kindProbabilities[v.kind] >=
        Math.max(...Object.values(v.kindProbabilities)),
    "Invalid message triage distribution.",
  );
export type MessageTriageResult = z.infer<typeof messageTriageResultSchema>;

/** What core stores in the judgment cache: the answer plus which offered key meant which task. */
export interface MessageTriageJudgment {
  result: MessageTriageResult;
  upcoming: { key: string; resourceId: string; title: string }[];
}

/**
 * Email triage (mail.triage.v1). Code has already categorised the sender; Jev sees only the
 * code's sender role, the subject and Outlook's own ≤255-character preview — never a sender
 * name or address — and, for mail code matched to a course, that course's upcoming work.
 */
export const MAIL_TRIAGE_QUESTION_VERSION = "mail.triage.v1";
export const MAIL_KINDS = [
  "interview_or_job",
  "deadline_or_action_required",
  "schedule_change_or_cancellation",
  "advisor_or_academic_standing",
  "campus_event",
  "club_or_org_update",
  "course_related",
  "newsletter_or_promotion",
  "other",
] as const;
export type MailKind = (typeof MAIL_KINDS)[number];
/** The code's sender role (from MailMetadata.category), in words Jev can read. */
export const MAIL_SENDER_ROLES = [
  "course staff",
  "academic advisor",
  "university office",
  "student organization or mailing list",
  "meeting invitation",
  "unknown sender",
] as const;
export const mailTriageStateSchema = z
  .object({
    role: z.enum(MAIL_SENDER_ROLES),
    subject: z.string().min(1).max(500),
    preview: z.string().max(255),
    course: z.string().max(200).optional(),
    upcoming: messageTriageStateSchema.shape.upcoming,
  })
  .strict();
export type MailTriageState = z.infer<typeof mailTriageStateSchema>;
export const mailTriageResultSchema = z
  .object({
    kind: z.enum(MAIL_KINDS),
    kindProbabilities: z.record(z.enum(MAIL_KINDS), probability),
    actionRequired: probability,
    affects: z.record(z.string().regex(/^a[0-9]$/), probability),
    model: z.string().min(1).max(100),
    questionVersion: z.literal(MAIL_TRIAGE_QUESTION_VERSION),
  })
  .strict()
  .refine(
    (v) =>
      MAIL_KINDS.every((k) => v.kindProbabilities[k] !== undefined) &&
      Math.abs(
        Object.values(v.kindProbabilities).reduce((a, b) => a + b, 0) - 1,
      ) <= 0.02 &&
      v.kindProbabilities[v.kind] >=
        Math.max(...Object.values(v.kindProbabilities)),
    "Invalid mail triage distribution.",
  );
export type MailTriageResult = z.infer<typeof mailTriageResultSchema>;
export interface MailTriageJudgment {
  result: MailTriageResult;
  upcoming: { key: string; resourceId: string; title: string }[];
}

export type NotificationLevel = "urgent" | "important" | "info";
export type NotificationReason =
  | "due_earlier"
  | "due_later"
  | "due_added"
  | "due_removed"
  | "cutoff_changed"
  | "new_assignment"
  | "new_assignments"
  | "instructions_changed"
  | "graded"
  | "feedback"
  | "missing"
  | "removed"
  | "restored"
  | "announcement"
  | "new_material"
  | "event_changed"
  | "event_cancelled"
  | "sign_in"
  | "source_stale"
  | "email";

export interface AppNotification {
  /** Stable for the same evidence: reason + subject + latest change id. New evidence → new id. */
  id: string;
  level: NotificationLevel;
  reason: NotificationReason;
  title: string;
  detail?: string;
  courseName?: string;
  resourceId?: string;
  sourceId?: string;
  observedAt: string;
  changeIds: string[];
  read: boolean;
  evidence?: { before?: string; after?: string; quote?: string };
  /** Email only: the sender's display name and the code's reason for its category (local only). */
  from?: string;
  senderReason?: string;
  /** Present only when Jev raised the level; the base level code chose is kept for display. */
  raisedBy?: {
    by: "jev";
    from: NotificationLevel;
    kind: MessageKind | MailKind;
    affects: string[];
    model: string;
  };
  count?: number;
}

export interface NotificationFeed {
  items: AppNotification[];
  /** Unread urgent + important items. Info never counts toward the badge. */
  unread: number;
  /** Latest successful read across connected sources; null when nothing has succeeded. */
  checkedAt: string | null;
  /** True when some source is signed out, failing or stale, so "nothing new" cannot be claimed. */
  degraded: boolean;
  /** Whether message triage can currently run, and why not. */
  triage: { status: "on" | "off" | "unavailable"; reason: string };
}

export const notificationStateSchema = z
  .object({
    readIds: z.array(z.string().min(1).max(600)).max(1000),
    dismissedIds: z.array(z.string().min(1).max(600)).max(1000),
  })
  .strict();
export type NotificationState = z.infer<typeof notificationStateSchema>;
export const emptyNotificationState: NotificationState = {
  readIds: [],
  dismissedIds: [],
};
