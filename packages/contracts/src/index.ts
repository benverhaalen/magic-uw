export * from "./course-work";
import type { CourseWorkAdmission } from "./course-work";
import { personalWorkChangeSchema, type PersonalWorkChange, type PersonalWorkDescriptor, type PersonalWorkState, type PersonalWorkEvent } from "./personal-work";
export * from "./personal-work";
import { personalDeadlineChangeSchema, type PersonalDeadlineChange, type PersonalDeadlineEvent, type PersonalDeadlineProjection, type PersonalDeadlineSource } from "./personal-deadlines";
export * from "./personal-deadlines";
import { z } from "zod";
import { personalReportChangeSchema, type PersonalReportChange, type PersonalReportState, type PersonalReportEvent } from "./personal-reports";
export * from "./personal-reports";
import {
  planningCaptureSchema,
  type PlanningCapture,
  type PlanningRecord,
  type PlanningScope,
} from "./planning";
export * from "./planning";
export * from "./course-intelligence";
export * from "./notifications";
import type { NotificationFeed, NotificationState } from "./notifications";
// owner: T05b. The data builder's course core (schema v5) replaces the placeholder module.
export * from "./course-core";
// owner: notes
export * from "./notes";
import { notesRequestSchema, type NotesResult } from "./notes";
// end owner: notes
import type { GraphQuery, GraphResult } from "./course-core"; // owner: pipeline
// owner: page-views
export * from "./page-views";
import { pageViewRequestSchemas, type PageViewResult } from "./page-views";
// end owner: page-views
// owner: study-prep
export * from "./study-prep";
import { ITEM_TYPES, studyPrepRequestSchema, type StudyPrepResult } from "./study-prep";
// end owner: study-prep
import type {
  CourseIntelligence,
  CourseIntelligenceView,
  EffectiveCoursePolicy,
} from "./course-intelligence";
import { identityRosterSchema, citationClaimSchema, type IdentityRoster, type RedactionSummary, type CitationResult, type AutoIdentityState, type AutoIdentityUpdate, type ProtectionCounts } from "./identity";
export * from "./identity";

export const instant = z.iso.datetime({ offset: true });
const id = z.string().min(1).max(256);
export const deadlineClaimSchema = z
  .object({
    value: instant,
    kind: z.enum(["due", "lock", "event"]),
    quote: z.string().max(4000),
    authority: z.enum(["explicit_change", "structured", "document", "title"]),
    scopeConfirmed: z.boolean(),
  })
  .strict();
export type DeadlineClaim = z.infer<typeof deadlineClaimSchema>;
export const policySchema = z
  .object({
    mode: z.enum(["allowed", "coaching", "restricted", "unknown"]),
    evidence: z.string().max(8000),
  })
  .strict();
/** Only public evidence URLs belong in the coursework store; capabilities live in the secret vault. */
export const evidenceUrlSchema = z
  .url()
  .max(4000)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    } // z.url reports invalid syntax without exposing rejected values.
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      [
        ...url.searchParams.keys(),
        ...new URLSearchParams(url.hash.slice(1)).keys(),
      ].some((key) =>
        /token|password|cookie|signature|credential|authorization|api.?key|access.?key|verifier/i.test(
          key,
        ),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Evidence URL contains unsupported access data.",
      });
  });
const optionalInstant = instant.nullable().optional();
const shortText = z.string().max(4000);
export const diagnosticSchema = z
  .object({
    code: z
      .string()
      .regex(/^[a-z0-9_.-]+$/i)
      .max(100),
    path: z.array(z.string().max(100)).max(20),
    severity: z.enum(["warning", "error"]).optional(),
  })
  .strict();
export type CaptureDiagnostic = z.infer<typeof diagnosticSchema>;
export const captureStatsSchema = z
  .object({
    durationMs: z.number().nonnegative().optional(),
    firstValueMs: z.number().nonnegative().optional(),
    nextWeekInstructionsMs: z.number().nonnegative().optional(),
    pages: z.number().int().nonnegative().optional(),
    records: z.number().int().nonnegative().optional(),
    requests: z.number().int().nonnegative().optional(),
    rateLimitRemaining: z.number().nonnegative().optional(),
    requestCost: z.number().nonnegative().optional(),
    bytes: z.number().int().nonnegative().optional(),
    retries: z.number().int().nonnegative().optional(),
  })
  .strict();
export type CaptureStats = z.infer<typeof captureStatsSchema>;
export const captureProgressSchema = z
  .object({
    phase: z.string().max(100),
    completed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().optional(),
  })
  .strict();
export const submissionSchema = z
  .object({
    workflowState: z.string().max(100).optional(),
    submittedAt: optionalInstant,
    score: z.number().nullable().optional(),
    grade: z.string().max(100).nullable().optional(),
    comments: z
      .array(
        z
          .object({
            text: z.string().max(20000),
            createdAt: optionalInstant,
            authorName: z.string().max(300).optional(),
          })
          .strict(),
      )
      .max(500)
      .optional(),
    late: z.boolean().optional(),
    missing: z.boolean().optional(),
    excused: z.boolean().optional(),
  })
  .strict();
export const rubricSchema = z
  .array(
    z
      .object({
        id: id.optional(),
        criterionId: id.optional(),
        description: shortText.optional(),
        longDescription: z.string().max(20000).optional(),
        points: z.number().nullable().optional(),
        ratings: z
          .array(
            z
              .object({
                id: id.optional(),
                description: shortText.optional(),
                longDescription: z.string().max(20000).optional(),
                points: z.number().nullable().optional(),
              })
              .strict(),
          )
          .max(100)
          .optional(),
      })
      .strict(),
  )
  .max(500);
export const courseSelectionSchema = z
  .object({
    score: z.number(),
    included: z.boolean(),
    reasons: z.array(shortText).max(50),
    override: z.boolean().optional(),
  })
  .strict();
export const courseMetadataSchema = z
  .object({
    courseCode: z.string().max(300).optional(),
    termId: id.optional(),
    termName: z.string().max(300).optional(),
    workflowState: z.string().max(100).optional(),
    // LMS calculations, never official transcript grades or evidence of mastery.
    gradeEvidence: z
      .array(
        z
          .object({
            enrollmentState: z.string().max(100).optional(),
            currentGrade: z.string().max(100).nullable().optional(),
            finalGrade: z.string().max(100).nullable().optional(),
            currentScore: z.number().finite().nullable().optional(),
            finalScore: z.number().finite().nullable().optional(),
          })
          .strict(),
      )
      .max(500)
      .optional(),
    accessRestricted: z.boolean().optional(),
    accessState: z
      .enum(["open", "not_open", "concluded", "date_restricted"])
      .optional(),
    startAt: optionalInstant,
    endAt: optionalInstant,
    selection: courseSelectionSchema.optional(),
    /** Teacher display names; retained (not scrubbed) in hosted payloads. */
    instructors: z.array(z.string().min(1).max(300)).max(50).optional(),
  })
  .strict();
export const moduleItemSchema = z
  .object({
    type: z.string().max(100),
    title: z.string().max(500).optional(),
    position: z.number().int().optional(),
    externalUrl: evidenceUrlSchema.optional(),
    pageUrl: z.string().max(4000).optional(),
    /** The containing module's Canvas id, so a course page can group items by module. */
    moduleId: id.optional(),
    contentId: id.optional(),
    dueAt: optionalInstant,
    points: z.number().nullable().optional(),
    completionRequirement: z
      .object({
        type: z.string().max(100),
        minScore: z.number().optional(),
        completed: z.boolean().optional(),
      })
      .strict()
      .optional(),
    lockInfo: z
      .object({
        unlockAt: optionalInstant,
        lockAt: optionalInstant,
        locked: z.boolean().optional(),
        explanation: shortText.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const fileMetadataSchema = z
  .object({
    id: id.optional(),
    fileId: id.optional(),
    folderId: id.optional(),
    displayName: z.string().max(1000).optional(),
    contentType: z.string().max(200).optional(),
    size: z.number().int().nonnegative().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    updatedAt: optionalInstant,
    locked: z.boolean().optional(),
    hidden: z.boolean().optional(),
    localPath: z.string().max(4000).optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    extractionStatus: z
      .enum(["ok", "partial", "unsupported", "error", "needs_ocr"])
      .optional(),
  })
  .strict();
const calendarDate = z.union([instant, z.iso.date()]);
export const calendarMetadataSchema = z
  .object({
    uid: z.string().min(1).max(1000),
    start: calendarDate,
    end: calendarDate.nullable().optional(),
    allDay: z.boolean(),
    timezone: z.string().max(200).optional(),
    lastModified: optionalInstant,
    assignmentExternalId: id.optional(),
    recurrenceId: z.string().max(200).optional(),
    location: z.string().max(500).optional(),
    onlineMeeting: z.enum(["teams", "zoom", "webex", "meet"]).optional(),
    // owner: T30. Graph calendar and meeting-invite fields (never a body or attendee list).
    /** `meeting`: an invite or an online meeting; absent for an ordinary calendar entry. */
    entryKind: z.enum(["meeting"]).optional(),
    iCalUId: z.string().max(1000).optional(),
    organizer: z.string().max(300).optional(),
    /** Join link: origin plus path only (a Zoom meeting ID path is kept; no query, no passcode). */
    joinUrl: evidenceUrlSchema.optional(),
    /** The Graph message id of the invite this entry came from, when it came from mail. */
    sourceMailId: z.string().max(1000).optional(),
    responseStatus: z.string().max(40).optional(),
    // end owner: T30
  })
  .strict();
/** Course id used for events from the student's published Outlook calendar (not a course). */
export const OUTLOOK_CALENDAR_COURSE_ID = "outlook-calendar";
// owner: T30. Outlook mail through Microsoft Graph (the student's own app registration).
/** Course id every stored Outlook message sits under; its course match is `mail.courseId`. */
export const OUTLOOK_MAIL_COURSE_ID = "outlook-mail";
/**
 * The setup checkbox's disclosure line for Microsoft Graph (the frontend's ConsentSetup shows
 * it in the consent block's list). Changing it changes CONSENT_DISCLOSURE_VERSION.
 */
export const OUTLOOK_GRAPH_DISCLOSURE =
  "Also connects your UW Outlook calendar and mail (subject, sender, date, a short preview; never full messages)";
export const mailCategorySchema = z.enum([
  "course",
  "advisor",
  "org",
  "admin",
  "meeting",
  "general",
]);
export type MailCategory = z.infer<typeof mailCategorySchema>;
/**
 * The compact, agent-ready form of one message. No body is ever stored: `preview` is Graph's
 * own `bodyPreview` (≤255 characters), `gist` a ≤280-character summary only when the
 * student's AI client wrote one. Every category carries the code's reason.
 */
export const mailMetadataSchema = z
  .object({
    messageId: z.string().min(1).max(1000),
    conversationId: z.string().max(1000).optional(),
    folder: z.string().max(100),
    fromName: z.string().max(300).optional(),
    fromAddress: z.string().max(320).optional(),
    receivedAt: instant,
    preview: z.string().max(255),
    gist: z.string().max(280).optional(),
    importance: z.enum(["low", "normal", "high"]).optional(),
    hasAttachments: z.boolean().optional(),
    categories: z.array(z.string().max(200)).max(50).optional(),
    flagged: z.boolean().optional(),
    isRead: z.boolean().optional(),
    category: mailCategorySchema,
    categoryReason: z.string().max(500),
    /** A Canvas course this message was matched to by code. */
    courseId: z.string().max(256).optional(),
    courseAccountScope: z.string().max(256).optional(),
    org: z.string().max(300).optional(),
    listId: z.string().max(500).optional(),
    /** Graph `meetingMessageType` for an invite, update or cancellation. */
    meetingMessageType: z.string().max(60).optional(),
  })
  .strict();
export type MailMetadata = z.infer<typeof mailMetadataSchema>;
/** Notes and files read through Graph wait here until the course mapper assigns a course. */
export const UNMAPPED_COURSE_ID = "unmapped";
export const notesMetadataSchema = z
  .object({
    sourceSubtype: z.enum(["onenote", "onedrive"]),
    /** Graph's id of the OneNote page or drive item. */
    itemId: z.string().min(1).max(1000),
    notebook: z.string().max(300).optional(),
    section: z.string().max(300).optional(),
    path: z.string().max(2000).optional(),
    mimeType: z.string().max(200).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    lastModified: optionalInstant,
    /** The drive item's content tag: a change means the file content changed. */
    cTag: z.string().max(500).optional(),
    /** Listed but its content not read yet (a per-sync budget); read on a later sync. */
    pending: z.boolean().optional(),
  })
  .strict();
export type NotesMetadata = z.infer<typeof notesMetadataSchema>;
export type OutlookConnectionState =
  | "not_set_up"
  | "not_connected"
  | "connected"
  | "needs_uw_approval"
  | "expired"
  | "error";
/** `magic:outlook-status`: never a token, never an address. */
export interface OutlookStatus {
  /** The Graph connection (the frontend's "Outlook" toggle). */
  outlook: OutlookConnectionState;
  scopes: string[];
  /** Calendars.ReadWrite granted (the optional write scope). */
  canWriteCalendar: boolean;
  /** Needs UW approval: whether Microsoft's admin-approval request is known to be sent. */
  approvalRequest: "sent" | "not_sent" | "unknown" | null;
  /** The Microsoft error code behind the state, when there is one (for example AADSTS65001). */
  reason: string | null;
  lastSyncAt: string | null;
  counts: { messages: number; events: number };
  /** The published-ICS fallback link is saved. */
  icsConnected: boolean;
}
export interface MailSearchItem {
  id: string;
  subject: string;
  webLink: string;
  receivedAt: string;
  fromName?: string;
  category: MailCategory;
  categoryReason: string;
  courseId?: string;
  org?: string;
  preview: string;
  gist?: string;
  importance?: "low" | "normal" | "high";
  hasAttachments?: boolean;
}
/** A calendar write the student confirms by clicking; `proposalId` is main's, never a model's. */
export interface CalendarProposal {
  proposalId: string;
  subject: string;
  start: string;
  end: string;
  timeZone: string;
  location?: string;
  joinUrl?: string;
  expiresAt: string;
}
// end owner: T30
export const crawlMetadataSchema = z
  .object({
    discoveredFrom: evidenceUrlSchema.optional(),
    depth: z.number().int().nonnegative().optional(),
    contentType: z.string().max(200).optional(),
    contentHash: z.string().max(128).optional(),
    observedAt: instant.optional(),
    fetchedAt: instant.optional(),
  })
  .strict();
export const gitlabMetadataSchema = z
  .object({
    projectId: id,
    defaultBranch: z.string().max(300).optional(),
    commitSha: z.string().max(100).optional(),
    blobSha: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    path: z.string().max(4000).optional(),
    submissionEvidence: z.boolean().optional(),
    evidenceKind: z
      .enum([
        "commit",
        "merge_request",
        "pipeline",
        "issue",
        "wiki",
        "tree",
        "file",
        "project",
      ])
      .optional(),
  })
  .strict();
export const resourceInputSchema = z
  .object({
    externalId: id,
    kind: z.enum(["assignment", "material", "event", "message", "course"]),
    courseId: id,
    courseName: z.string().min(1).max(200),
    title: z.string().min(1).max(500),
    url: evidenceUrlSchema,
    text: z.string().max(200000),
    rawHtml: z.string().max(1000000).optional(),
    contentType: z.string().max(200).optional(),
    links: z
      .array(
        z.union([
          evidenceUrlSchema,
          z
            .object({
              url: evidenceUrlSchema,
              text: shortText.optional(),
              rel: z.string().max(100).optional(),
            })
            .strict(),
        ]),
      )
      .max(4000)
      .optional(),
    parts: z
      .array(
        z
          .object({
            text: z.string().max(200000),
            page: z.number().int().positive().optional(),
            slide: z.number().int().positive().optional(),
            section: shortText.optional(),
            start: z.number().int().nonnegative().optional(),
            end: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .max(5000)
      .optional(),
    createdAt: optionalInstant,
    updatedAt: optionalInstant,
    unlockAt: optionalInstant,
    dueAt: optionalInstant,
    lockAt: optionalInstant,
    workflowState: z.string().max(100).optional(),
    submissionTypes: z.array(z.string().max(100)).max(100).optional(),
    assignmentGroupId: id.nullable().optional(),
    rubric: rubricSchema.nullable().optional(),
    submission: submissionSchema.nullable().optional(),
    course: courseMetadataSchema.optional(),
    moduleItem: moduleItemSchema.optional(),
    module: z
      .object({
        id: id.optional(),
        position: z.number().int().optional(),
        state: z.string().max(100).optional(),
        prerequisiteModuleIds: z.array(id).max(1000).optional(),
        unlockAt: optionalInstant,
        itemsCount: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    assignmentGroup: z
      .object({
        weight: z.number().optional(),
        position: z.number().int().optional(),
        rules: z
          .object({
            dropLowest: z.number().int().nonnegative().optional(),
            dropHighest: z.number().int().nonnegative().optional(),
            neverDrop: z.array(id).max(1000).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    file: fileMetadataSchema.optional(),
    calendar: calendarMetadataSchema.optional(),
    mail: mailMetadataSchema.optional(), // owner: T30
    notes: notesMetadataSchema.optional(), // owner: T30
    crawl: crawlMetadataSchema.optional(),
    gitlab: gitlabMetadataSchema.optional(),
    provenance: crawlMetadataSchema
      .extend({ sourceUrl: evidenceUrlSchema })
      .optional(),
    document: z
      .object({
        fileId: id.optional(),
        localPath: z.string().max(4000).optional(),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        sizeBytes: z.number().int().nonnegative().optional(),
        updatedAt: optionalInstant,
        extractionStatus: z
          .enum(["ok", "partial", "unsupported", "error", "needs_ocr"])
          .optional(),
        pages: z
          .array(
            z
              .object({
                page: z.number().int().positive(),
                text: z.string().max(200000),
                anchor: z.string().max(1000),
              })
              .strict(),
          )
          .max(5000),
      })
      .strict()
      .optional(),
    deadlines: z.array(deadlineClaimSchema).max(30).default([]),
    points: z.number().nonnegative().nullable().default(null),
    submitted: z.boolean().nullable().default(null),
    policy: policySchema.default({ mode: "unknown", evidence: "" }),
  })
  .strict();
export type ResourceInput = z.infer<typeof resourceInputSchema>;
export const captureBatchSchema = z
  .object({
    source: z
      .object({
        id,
        label: z.string().min(1).max(200),
        // owner: T05b: kaltura (T32), mail (T30/T35) and feed (T31) are reserved source kinds.
        kind: z.enum([
          "canvas",
          "web",
          "fixture",
          "calendar",
          "gitlab",
          "kaltura",
          "mail",
          "feed",
          "notes", // owner: T30: OneNote and OneDrive through Graph; owner: notes: session notes (passages)
          // owner: site-recipes: items code extracted from a course website's stored pages with a
          // layout recipe (D32). Kept apart from "web" so the crawler never reads them back as pages.
          "site",
        ]),
        accountScope: id,
        courseId: id,
        scope: id,
      })
      .strict(),
    observedAt: instant,
    complete: z.boolean(),
    status: z.enum([
      "ok",
      "partial",
      "needs_sign_in",
      "error",
      "inaccessible",
      "not_published",
      "needs_attention",
    ]),
    readId: id.optional(),
    diagnostics: z.array(diagnosticSchema).max(2000).optional(),
    stats: captureStatsSchema.optional(),
    progress: captureProgressSchema.optional(),
    resources: z.array(resourceInputSchema).max(2000),
  })
  .strict();
export type CaptureBatch = z.infer<typeof captureBatchSchema>;
/** Validate the envelope first so malformed records can be isolated safely. */
export const captureEnvelopeSchema = captureBatchSchema.extend({
  resources: z.array(z.unknown()).max(2000),
});
export type CaptureEnvelope = z.infer<typeof captureEnvelopeSchema>;
export interface Resource extends ResourceInput {
  id: string;
  sourceId: string;
  contentHash: string;
  version: number;
  observedAt: string;
  capturedAt: string;
  deleted: boolean;
  completed: boolean;
  fieldLastSeen?: Record<string, string>;
}
export interface SourceHealth {
  id: string;
  label: string;
  kind: CaptureBatch["source"]["kind"];
  accountScope: string;
  courseId: string;
  scope: string;
  status: CaptureBatch["status"];
  lastAttemptAt: string;
  lastSuccessAt: string | null;
  complete: boolean;
  resourceCount: number;
  diagnostics?: CaptureDiagnostic[];
  stats?: CaptureStats;
  progress?: z.infer<typeof captureProgressSchema>;
  readId?: string;
}
export interface IngestReport {
  created: number;
  changed: number;
  unchanged: number;
  deleted: number;
  ignored: boolean;
  rejected?: number;
  diagnostics?: CaptureDiagnostic[];
  readId?: string;
}
/**
 * Read-time deadline evidence. These fields are derived deterministically from
 * saved text, never persisted, so the stored `deadlineClaimSchema` is unchanged.
 */
export type DeadlineOrigin =
  | "canvas"
  | "announcement"
  | "assignment_text"
  | "syllabus"
  | "page"
  | "calendar"
  | "title";
/** A literal slice of one saved resource version. */
export interface DeadlineSpan {
  resourceId: string;
  version: number;
  contentHash: string;
  field: "title" | "text";
  start: number;
  end: number;
  text: string;
}
export interface DeadlineClaimDetails {
  origin?: DeadlineOrigin;
  span?: DeadlineSpan;
  /** late_until/closes refine `lock`; exam refines `event`. */
  detail?: "late_until" | "closes" | "exam";
  /** "day": the text names a date without a usable time; value is that day's start in America/Chicago. */
  precision?: "minute" | "day";
  /** How a missing year or relative day was anchored. Absent when fully explicit. */
  inference?: "year_from_term" | "year_from_source_date" | "relative_to_post";
  /** For an explicit change: the prior date the text says it replaces, when stated and resolvable. */
  supersedes?: string;
  /** When the source said this (announcement post time), used to order changes. */
  statedAt?: string;
  note?: string;
}
export type DeadlineEvidenceClaim = DeadlineClaim & DeadlineClaimDetails;
/** A deadline-like phrase that could not be pinned to an instant without inventing information. */
export interface UnresolvedDeadlineMention {
  kind: DeadlineClaim["kind"];
  origin: DeadlineOrigin;
  span: DeadlineSpan;
  reason: string;
}
export interface DeadlineResolution {
  dueAt: string | null;
  planningAt: string | null;
  conflict: boolean;
  claims: DeadlineEvidenceClaim[];
  reason: string;
  /** Value from the highest-authority tier, shown with its basis even while a conflict keeps `dueAt` null. */
  preferredAt?: string | null;
  basis?: DeadlineOrigin | "explicit_change" | null;
  /** Per-claim explanations: superseded, disagreeing, unconfirmed, or lower authority. */
  notes?: string[];
  unresolved?: UnresolvedDeadlineMention[];
  lockAt?: string | null;
}
/**
 * Hosted AI a student can choose. `chatgpt` stays accepted so stored preferences keep
 * parsing; `codex` and `openrouter` are the P1 additions (T05d).
 */
export const hostedProviderSchema = z.enum([
  "none",
  "chatgpt",
  "codex",
  "claude",
  "gemini",
  "openrouter",
]);
export type HostedProvider = z.infer<typeof hostedProviderSchema>;
/** Every recipient a context manifest, receipt or grant can name. */
export const aiRecipientSchema = z.enum([
  "jev",
  "local",
  "chatgpt",
  "codex",
  "claude",
  "gemini",
  "openrouter",
]);
export type AiRecipient = z.infer<typeof aiRecipientSchema>;
function privacyShape<P extends z.ZodType<HostedProvider>>(hostedProvider: P) {
  return {
    mode: z.enum(["local_only", "selective_cloud"]),
    jevEnabled: z.boolean(),
    hostedProvider,
    shareCourseText: z.boolean(),
    shareStudentWork: z.boolean(),
    shareGrades: z.boolean().optional(),
    shareComments: z.boolean().optional(),
    shareCommunications: z.boolean().optional(),
    sharePlanning: z.boolean().optional(),
    shareHolds: z.boolean().optional(),
    shareAudit: z.boolean().optional(),
    /** Show the blocking payload preview before every send, not only a category's first. */
    alwaysPreview: z.boolean().optional(),
  };
}
/**
 * Stored preferences. An unknown `hostedProvider` string (for example one written by a
 * later build) is ignored: it reads as "none", so no hosted AI other than Jev is selected
 * and `maySend` refuses every such recipient. It never throws.
 */
export const privacySchema = z
  .object(privacyShape(hostedProviderSchema.catch("none")))
  .strict();
/** The `privacy` command refuses an unknown provider instead of coercing it. */
export const privacyCommandSchema = z
  .object(privacyShape(hostedProviderSchema))
  .strict();
export type PrivacyPreferences = Omit<
  z.infer<typeof privacySchema>,
  "shareGrades" | "shareComments" | "shareCommunications"
> & {
  shareGrades?: boolean;
  shareComments?: boolean;
  shareCommunications?: boolean;
};
/**
 * Who a consent record covers. `uw` is the first-run setup checkbox: Magic Canvas reading
 * UW services with the student's own session (the Canvas page-view disclosure). The rest
 * are hosted AI recipients. `local` never needs consent.
 */
export const consentRecipientSchema = z.enum([
  "uw",
  "jev",
  "chatgpt",
  "codex",
  "claude",
  "gemini",
  "openrouter",
]);
export type ConsentRecipient = z.infer<typeof consentRecipientSchema>;
export const disclosureVersionSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
/** One per recipient, written only by the `consent` command; the time comes from code. */
export const consentRecordSchema = z
  .object({
    recipient: consentRecipientSchema,
    disclosureVersion: disclosureVersionSchema,
    grantedAt: instant,
  })
  .strict();
export type ConsentRecord = z.infer<typeof consentRecordSchema>;
export const consentChangeSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("grant"),
      recipient: consentRecipientSchema,
      disclosureVersion: disclosureVersionSchema,
    })
    .strict(),
  z
    .object({ action: z.literal("revoke"), recipient: consentRecipientSchema })
    .strict(),
]);
export type ConsentChange = z.infer<typeof consentChangeSchema>;
/**
 * The student's answer to a blocking payload preview. `payloadHash` (sha256 hex of the
 * previewed payload) binds the answer to exactly what was shown.
 */
export const previewAckSchema = z
  .object({
    id,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(["send", "decline"]),
  })
  .strict();
export type PreviewAck = z.infer<typeof previewAckSchema>;
export const defaultPrivacy: PrivacyPreferences = {
  mode: "local_only",
  jevEnabled: false,
  hostedProvider: "none",
  shareCourseText: false,
  shareStudentWork: false,
  shareGrades: false,
  shareComments: false,
  shareCommunications: false,
  sharePlanning: false,
  shareHolds: false,
  shareAudit: false,
  alwaysPreview: false,
};
export interface Link {
  id: string;
  fromId: string;
  toId: string;
  type: "specifies" | "supports" | "same_as";
  reason: string;
  status: "proposed" | "accepted" | "rejected";
  inputHash: string;
}
export interface Job {
  id: string;
  kind: string;
  resourceId: string;
  inputHash: string;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  runAfter: string;
  leaseUntil: string | null;
  leaseToken: string | null;
  error: string | null;
}
export interface Judgment {
  key: string;
  resourceId: string;
  inputHash: string;
  model: string;
  questionVersion: string;
  result: unknown;
  createdAt: string;
}
export interface Attempt {
  id: string;
  resourceId: string;
  itemId: string;
  skill: string;
  correct: boolean;
  assistance: "none" | "hint" | "explained";
  seenBefore: boolean;
  confidence: number | null;
  createdAt: string;
}
export interface EgressReceipt {
  id: string;
  recipient: string;
  purpose: string;
  categories: string[];
  resourceIds: string[];
  characters: number;
  /** `preview_required`: held until the student answers a blocking preview; nothing sent. */
  status: "blocked" | "sent" | "failed" | "preview_required";
  createdAt: string;
  /** owner: privacy. Replacements per kind in the payload of this send (counts only, never values). */
  protection?: ProtectionCounts;
}
export const ingestionSettingsSchema = z
  .object({
    collectComments: z.boolean().default(true),
    enabled: z.boolean().default(true),
    intervalMinutes: z.number().min(1).max(1440).default(10),
    jitterRatio: z.number().min(0).max(0.5).default(0.2),
    quietHours: z
      .object({
        enabled: z.boolean(),
        start: z.number().int().min(0).max(23),
        end: z.number().int().min(0).max(23),
      })
      .strict()
      .default({ enabled: true, start: 1, end: 6 }),
    metadataConcurrency: z.number().int().min(1).max(16).default(8),
    downloadConcurrency: z.number().int().min(1).max(8).default(4),
    externalRefreshHours: z.number().min(1).max(168).default(6),
    crawlMaxDepth: z.number().int().min(0).max(10).default(6),
    crawlMaxPages: z.number().int().min(1).max(1000).default(300),
    maxFileBytes: z.number().int().min(1024).max(104857600).default(104857600),
    selectedTerm: z.string().max(300).nullable().default(null),
    /**
     * fix/current-courses-only. Set by onboarding's course discovery, cleared by "Start syncing"
     * (the next manual sync): background reads wait, across restarts, until the student confirms.
     */
    awaitingCourseChoice: z.boolean().default(false),
  })
  .strict();
export type IngestionSettings = z.infer<typeof ingestionSettingsSchema>;
export const defaultIngestionSettings: IngestionSettings =
  ingestionSettingsSchema.parse({});
export const courseOverrideSchema = z
  .object({ accountScope: id, courseId: id, included: z.boolean().nullable() })
  .strict();
export type CourseOverride = z.infer<typeof courseOverrideSchema>;
export const mcpCategorySchema = z.enum([
  "course_text",
  "student_work",
  "grades",
  "comments",
  "communications",
]);
export type McpCategory = z.infer<typeof mcpCategorySchema>;
export const mcpGrantSchema = z
  .object({
    id,
    label: z.string().min(1).max(200),
    recipient: aiRecipientSchema.exclude(["jev"]),
    enabled: z.boolean(),
    courses: z
      .array(z.object({ accountScope: id, courseId: id }).strict())
      .max(500),
    categories: z.array(mcpCategorySchema).max(5),
    tokenHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type McpGrant = z.infer<typeof mcpGrantSchema>;
/** One day-plan decision about a Today rail suggestion. Local only; never shared with Jev, AI, or MCP. */
export const dayPlanEntrySchema = z
  .object({
    key: z.string().min(1).max(300),
    date: z.iso.date(),
    status: z.enum(["accepted", "skipped"]),
    block: z
      .object({
        type: z.enum(["prep", "work", "exam"]),
        resourceId: id,
        title: z.string().trim().min(1).max(200),
        courseName: z.string().max(200),
        startMin: z.number().int().min(0).max(1440),
        endMin: z.number().int().min(0).max(1440),
      })
      .strict()
      .refine((b) => b.endMin - b.startMin >= 10, {
        message: "A block needs at least 10 minutes.",
      }),
    doneAt: instant.nullable().optional(),
  })
  .strict();
export type DayPlanEntry = z.infer<typeof dayPlanEntrySchema>;
/** Student-created local calendar event. It never changes a UW, Canvas or external calendar. */
export const personalCalendarEventSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  date: z.iso.date(),
  allDay: z.boolean(),
  startsAt: instant.nullable(),
  endsAt: instant.nullable(),
  timeZone: z.string().min(1).max(100),
  location: z.string().max(300),
  notes: z.string().max(2000),
}).strict().superRefine((event, ctx) => {
  if (event.allDay ? event.startsAt !== null || event.endsAt !== null : !event.startsAt || !event.endsAt || Date.parse(event.endsAt) - Date.parse(event.startsAt) < 15 * 60_000)
    ctx.addIssue({ code: 'custom', message: 'A timed event needs at least 15 minutes; an all-day event has no instants.' });
});
export type PersonalCalendarEvent = z.infer<typeof personalCalendarEventSchema>;
/**
 * A UW GitLab project the student linked to a course by hand, for courses whose Canvas
 * material never links the project. `projectPath` is the namespace/project path.
 */
export const gitlabLinkSchema = z
  .object({
    accountScope: id,
    courseId: id,
    projectPath: z.string().min(3).max(300).regex(/^[\w.-]+(?:\/[\w.-]+)+$/),
    addedAt: instant,
  })
  .strict();
export type GitlabLink = z.infer<typeof gitlabLinkSchema>;
export const syncRunSchema = z
  .object({
    id,
    startedAt: instant,
    finishedAt: instant,
    status: z.enum([
      "ok",
      "partial",
      "needs_sign_in",
      "error",
      "unchanged",
      "cancelled",
    ]),
    action: z.enum(["manual", "background", "calendar", "external", "import"]),
    stats: captureStatsSchema.optional(),
    sourceCount: z.number().int().nonnegative().optional(),
    diagnostics: z.array(diagnosticSchema).max(2000).optional(),
  })
  .strict();
export type SyncRun = z.infer<typeof syncRunSchema>;
export type ChangeType =
  | "new"
  | "updated"
  | "date_changed"
  | "requirements_changed"
  | "submitted"
  | "graded"
  | "removed"
  | "restored";
export interface ResourceChange {
  id: string;
  resourceId: string;
  sourceId: string;
  accountScope: string;
  courseId: string;
  scope: string;
  readId: string;
  observedAt: string;
  type: ChangeType;
  oldValues: Record<string, unknown>;
  newValues: Record<string, unknown>;
}
export interface ChangeFilter {
  resourceId?: string;
  sourceId?: string;
  courseId?: string;
  accountScope?: string;
  since?: string;
  limit?: number;
}
export interface ScopeBaseline {
  sourceId: string;
  successfulReads: number;
  recordCount: number;
  emptyTextRatio: number;
  dateCoverageRatio: number;
  observedAt: string;
}
export interface Store {
  courseIntelligence(): CourseIntelligence[];
  applyCourseExtraction(
    account: string,
    course: string,
    extraction: import("./course-intelligence").CourseExtractionBatch,
    at: string,
  ): boolean;
  courseIntelligenceHistory(id: string): CourseIntelligence[];
  ingestPlanning(batch: unknown): {
    sourceId: string;
    accepted: number;
    rejected: number;
    ignored: boolean;
  };
  planningRecords(): StoredPlanningRecord[];
  /** owner: privacy. Current planning records that cannot be opened (a lost or different at-rest key). */
  planningUnreadable?(): number;
  planningSources(): PlanningSourceHealth[];
  close(): void;
  ingest(batch: unknown): IngestReport;
  ingestionSettings(): IngestionSettings;
  setIngestionSettings(value: IngestionSettings): void;
  courseOverrides(): CourseOverride[];
  setCourseOverride(value: CourseOverride): void;
  changes(filter?: ChangeFilter): ResourceChange[];
  scopeBaselines(): ScopeBaseline[];
  syncRuns(): SyncRun[];
  addSyncRun(value: SyncRun): void;
  mcpGrants(): McpGrant[];
  setMcpGrant(value: McpGrant): void;
  dayPlan(): DayPlanEntry[];
  setDayPlanEntry(value: DayPlanEntry): void;
  removeDayPlanEntry(key: string, date: string): void;
  personalCalendarEvents(): PersonalCalendarEvent[];
  setPersonalCalendarEvent(value: PersonalCalendarEvent): void;
  removePersonalCalendarEvent(id: string): void;
  /** Read and dismissed notification ids (local preference; cleared by purge). */
  notificationState?(): NotificationState;
  setNotificationState?(value: NotificationState): void;
  /** Each source's first read id; "new" changes recorded by it are the baseline, not news. */
  baselineReadIds?(): string[];
  gitlabLinks(): GitlabLink[];
  /** Adds or refreshes one course's manual GitLab project link. */
  setGitlabLink(value: GitlabLink): void;
  removeGitlabLink(accountScope: string, courseId: string, projectPath: string): void;
  /**
   * Deletes a source the student disconnected and everything captured from it; returns the
   * number of items removed. Not for failed or empty reads, which must never erase coursework.
   */
  removeSource(sourceId: string): number;
  resources(search?: string): Resource[];
  resource(id: string): Resource | undefined;
  /**
   * fix/sync-events. A token that changes whenever the stored workspace is replaced rather than
   * refreshed: an import, the sample fixture, or Delete local data (which clears it). Derived
   * state (the refresh baselines) compares it to tell its store apart.
   */
  generation?(): string;
  bumpGeneration?(): void;
  /**
   * fix/current-courses-only. Earlier stored versions of one resource, newest first (read-only);
   * lets a caller put back a version a later observation overwrote, instead of deleting.
   */
  resourceHistory?(id: string): Array<{ version: number; capturedAt: string; resource: ResourceInput }>;
  sources(): SourceHealth[];
  privacy(): PrivacyPreferences;
  setPrivacy(value: PrivacyPreferences): void;
  /** Consent seams (T06 implements): read-only records, and the only writer. */
  consents?(): ConsentRecord[];
  setConsent?(change: ConsentChange, at: string): void;
  personalDeadlineChoices(): PersonalDeadlineEvent[];
  setPersonalDeadlineChoice(change: PersonalDeadlineChange, currentSource: () => PersonalDeadlineSource): PersonalDeadlineEvent;
  /** Internal synchronous read projection. supplied resources must be the full saved store read; writes always revalidate. */
  personalWorkSnapshot(requests: readonly {canonicalResourceId: string; contributorIds?: readonly string[]}[], resources?: readonly Resource[]): {descriptors: PersonalWorkDescriptor[]; reports: PersonalWorkState[]};
  describePersonalWork(canonicalResourceId: string, contributorIds?: readonly string[]): PersonalWorkDescriptor | undefined;
  personalWorkReports(): PersonalWorkState[];
  personalWorkHistory(issueId: string, limit?: number): PersonalWorkEvent[];
  setPersonalWork(change: PersonalWorkChange): PersonalWorkState;
  personalReports(): PersonalReportState[];
  personalReportHistory(issueId: string, limit?: number): PersonalReportEvent[];
  setPersonalReport(change: PersonalReportChange): PersonalReportState;
  setCompleted(id: string, completed: boolean): void;
  links(): Link[];
  putLink(link: Link): void;
  decideLink(id: string, status: "accepted" | "rejected"): void;
  enqueue(
    kind: string,
    resourceId: string,
    inputHash: string,
    now: string,
  ): void;
  lease(now: string, leaseMs: number): Job | undefined;
  finish(job: Job, error?: string, now?: string): boolean;
  /** Defer this leased job and its kind without spending an attempt; survives restart. */
  defer(job: Job, runAfter: string, reason: string, now?: string): boolean;
  jobCooldown(kind: string): string | undefined;
  jobs(): Job[];
  judgment(key: string): Judgment | undefined;
  putJudgment(value: Judgment): boolean;
  judgments(): Judgment[];
  addAttempt(value: Attempt): void;
  attempts(resourceId?: string): Attempt[];
  addReceipt(value: EgressReceipt): void;
  receipts(): EgressReceipt[];
  identityRoster(): IdentityRoster;
  setIdentityRoster(value: IdentityRoster): void;
  autoIdentities(): AutoIdentityState;
  recordAutoIdentity(value: AutoIdentityUpdate): void;
  purge(): void;
}
export interface ContextManifest {
  effectivePolicy?: EffectiveCoursePolicy;
  recipient: AiRecipient;
  purpose: string;
  categories: string[];
  resourceIds: string[];
  characters: number;
  allowed: boolean;
  reason: string;
  payload: { course: string; title: string; text: string; policy: string };
  /** Present when free text was scrubbed for a hosted recipient; payload is the exact outgoing text. */
  redaction?: RedactionSummary;
  /** owner: privacy. Replacements per kind in `payload` (counts only); copied to the receipt. */
  protection?: ProtectionCounts;
  citationProjections?: { resourceId: string; contentHash: string; field: "text"; projectionId: string }[];
}
export interface ResourceView extends Resource {
  personalWork?: PersonalWorkDescriptor;
  /** Local user choice for planning; raw source deadline and conflict are preserved. */
  personalDeadline?: PersonalDeadlineProjection;
  /** Exact local evidence contributors used by the canonical deadline resolver. */
  deadlineContributors?: Array<{ resourceId: string; contentHash: string }>;
  deadline: DeadlineResolution;
  kindLabel: string | null;
}
export interface Snapshot {
  courseWorkAdmission?: CourseWorkAdmission;
  courseIntelligence?: CourseIntelligenceView[];
  planning?: PlanningSnapshot;
  resources: ResourceView[];
  sources: SourceHealth[];
  privacy: PrivacyPreferences;
  links: Link[];
  jobs: Job[];
  receipts: EgressReceipt[];
  attempts: Attempt[];
  fixtureMode: boolean;
  gatewayConfigured: boolean;
  generatedAt: string;
  ingestionSettings?: IngestionSettings;
  courseOverrides?: CourseOverride[];
  changes?: ResourceChange[];
  syncRuns?: SyncRun[];
  mcpGrants?: McpGrant[];
  consents?: ConsentRecord[];
  dayPlan?: DayPlanEntry[];
  personalCalendarEvents?: PersonalCalendarEvent[];
  /** Local display only; excluded from AI/MCP contexts. Latest choice per issue, not the journal. */
  personalWorkReports?: PersonalWorkState[];
  personalReports?: PersonalReportState[];
  notifications?: NotificationFeed;
  gitlabLinks?: GitlabLink[];
}
// owner: T05b. The integration seams: the learning channel (spec §8.1 of the learning spec,
// its practice addendum, and T47/T53's practice.target and practice.assessmentQuiz), the
// course map, corrections (D33), packs, UI events and the workspace command bar (D40).
const ids = (max: number) => z.array(id).max(max);
// owner: study-backend. Course-scoped practice (additive, optional): the renderer names the course's
// anchor resources; the worker's trusted resolver authorizes each one. Mutations carry a revision and
// an operation ID, like the saved study session ops.
const practiceScope = { anchorIds: z.array(id).min(1).max(50).optional() };
const practiceMutation = {
  sessionId: id.optional(),
  revision: z.number().int().nonnegative().optional(),
  operationId: id.optional(),
};
const studyFilterSchema = z.enum(["all", "starred", "missed", "iffy"]);
const anchorInputSchema = z
  .object({
    resourceId: id,
    version: z.number().int().min(0),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
  })
  .strict();
const learningOp = <T extends string, S extends z.ZodRawShape>(
  op: T,
  shape: S,
) => z.object({ op: z.literal(op), ...shape }).strict();
export const learningRequestSchema = z.discriminatedUnion("op", [
  learningOp("notebook.open", { courseId: id }),
  learningOp("notebook.include", {
    courseId: id,
    resourceId: id,
    included: z.boolean(),
  }),
  learningOp("notebook.ask", {
    courseId: id,
    question: z.string().trim().min(1).max(2000),
    scope: z
      .object({ assessmentId: id.optional(), resourceIds: ids(50).optional() })
      .strict()
      .optional(),
  }),
  learningOp("notebook.artifact", {
    courseId: id,
    kind: z.enum([
      "study_guide",
      "briefing",
      "faq",
      "glossary",
      "timeline",
      "mind_map",
    ]),
    assessmentId: id.optional(),
    rebuild: z.boolean().optional(),
  }),
  learningOp("notebook.coverage", { courseId: id, assessmentId: id }),
  learningOp("notebook.dispute", {
    artifactId: id,
    citationId: id,
    reason: z.enum([
      "quote_missing",
      "does_not_support",
      "wrong_source",
      "other",
    ]),
  }),
  learningOp("study.sessions", { resourceId: id }),
  learningOp("study.session", { sessionId: id }),
  learningOp("study.resume", { sessionId: id }),
  learningOp("study.draft", { sessionId: id, revision: z.number().int().nonnegative(), operationId: id, draft: z.string().max(2000) }),
  learningOp("study.advance", { sessionId: id, revision: z.number().int().nonnegative(), operationId: id, action: z.enum(["next", "skip"]) }),
  learningOp("study.plan", {
    resourceId: id.optional(), inputHash: id.optional(), operationId: id.optional(), goal: z.string().max(1000).optional(),
    courseId: id.optional(),
    assessmentId: id.optional(),
    minutes: z.number().int().min(5).max(120),
    difficulty: z.enum(["warmup", "normal", "push"]),
    filter: studyFilterSchema.optional(),
  }),
  learningOp("study.answer", {
    revision: z.number().int().nonnegative().optional(), operationId: id.optional(),
    sessionId: id,
    itemId: id,
    itemVersion: z.number().int().min(0),
    response: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("choice"), optionId: id }).strict(),
      z.object({ kind: z.literal("text"), text: z.string().max(2000) }).strict(),
      z
        .object({
          kind: z.literal("number"),
          value: z.number(),
          unit: z.string().max(40).optional(),
        })
        .strict(),
    ]),
    confidence: z.union([
      z.literal(0),
      z.literal(0.33),
      z.literal(0.67),
      z.literal(1),
      z.null(),
    ]),
    responseMs: z.number().int().min(0).max(86_400_000),
  }),
  learningOp("study.hint", {
    revision: z.number().int().nonnegative().optional(), operationId: id.optional(),
    sessionId: id,
    itemId: id,
    level: z.enum(["hint", "explain"]),
  }),
  learningOp("study.review", {
    cardId: id,
    rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    reviewMs: z.number().int().min(0).max(86_400_000),
    ...practiceMutation,
  }),
  learningOp("study.undoReview", { reviewId: id, ...practiceMutation }),
  learningOp("study.exam", {
    courseId: id,
    assessmentId: id,
    length: z.number().int().min(5).max(60),
    lean: z.boolean(),
    timed: z.boolean(),
  }),
  learningOp("study.submit", { sessionId: id }),
  learningOp("study.flag", {
    itemId: id,
    itemVersion: z.number().int().min(0),
    reason: z.enum([
      "wrong_key",
      "two_correct",
      "no_correct",
      "unclear",
      "off_topic",
      "not_my_course",
      "grade_wrong",
    ]),
    note: z.string().max(500).optional(),
  }),
  learningOp("study.unflag", { disputeId: id }),
  learningOp("study.generate", {
    courseId: id,
    kind: z.enum(["flashcards", "quiz"]),
    conceptIds: ids(20).optional(),
    assessmentId: id.optional(),
    count: z.number().int().min(1).max(30),
  }),
  learningOp("study.path", { courseId: id }),
  learningOp("knowledge.state", {
    courseId: id,
    ...practiceScope,
    topicIds: ids(50).optional(),
    moduleIds: ids(50).optional(),
  }),
  learningOp("knowledge.concept", { conceptId: id }),
  learningOp("knowledge.selfRate", {
    conceptId: id,
    rating: z.enum(["dont_know", "shaky", "know_it"]),
    delayed: z.boolean(),
  }),
  learningOp("knowledge.edit", {
    conceptId: id,
    edit: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("rename"),
          label: z.string().trim().min(1).max(200),
        })
        .strict(),
      z.object({ kind: z.literal("merge"), intoId: id }).strict(),
      z.object({ kind: z.literal("hide") }).strict(),
      z.object({ kind: z.literal("restore") }).strict(),
    ]),
  }),
  learningOp("knowledge.retag", {
    itemId: id,
    conceptIds: z.array(id).min(1).max(3),
    primary: id,
  }),
  learningOp("practice.path", { courseId: id, ...practiceScope }),
  learningOp("practice.checkpoint", { courseId: id, assessmentId: id }),
  learningOp("practice.quick", {
    courseId: id.optional(),
    minutes: z.union([z.literal(3), z.literal(5), z.literal(10)]),
  }),
  learningOp("practice.star", {
    targetKind: z.enum(["item", "card", "concept"]),
    targetId: id,
    starred: z.boolean(),
  }),
  learningOp("practice.card.edit", {
    itemId: id,
    itemVersion: z.number().int().min(0),
    front: z.string().max(2000).optional(),
    back: z.string().max(4000).optional(),
    explanation: z.string().max(4000).optional(),
  }),
  learningOp("practice.card.create", {
    courseId: id,
    front: z.string().trim().min(1).max(2000),
    back: z.string().trim().min(1).max(4000),
    anchor: anchorInputSchema.optional(),
    conceptIds: ids(20).optional(),
  }),
  // T47 (spec H5): "quiz me on" chosen topics; a session never widens beyond them.
  learningOp("practice.target", {
    courseId: id,
    topicIds: ids(50).optional(),
    moduleIds: ids(50).optional(),
    assessmentId: id.optional(),
    description: z.string().trim().min(1).max(500).optional(),
    filter: z.enum(["all", "starred", "missed", "iffy", "not_seen"]).optional(),
    mode: z.enum(["flashcards", "learn", "write", "test"]),
    count: z.number().int().min(1).max(60),
    difficulty: z.enum(["warmup", "normal", "push"]).optional(),
    ...practiceScope,
    operationId: id.optional(),
    // owner: study-prep. Exactly these items (the cards or questions linked to an exam, an assignment
    // or a module, as code resolved them); the pool never widens beyond them.
    itemIds: ids(200).optional(),
  }),
  // T53 (spec H3): an assessment quiz sectioned by its chapters and modules.
  learningOp("practice.assessmentQuiz", {
    courseId: id,
    assessmentId: id,
    length: z.number().int().min(5).max(60),
    sectionIds: ids(50).optional(),
    timed: z.boolean().optional(),
  }),
  learningOp("insights.overview", { courseId: id }),
  learningOp("insights.coverage", { assessmentId: id }),
  learningOp("insights.errors", { courseId: id }),
  learningOp("insights.calibration", { courseId: id.optional() }),
  learningOp("insights.history", {
    courseId: id.optional(),
    weeks: z.number().int().min(1).max(52),
  }),
  learningOp("insights.changes", { courseId: id.optional() }),
  learningOp("insights.digest", { weekStart: z.iso.date() }),
  learningOp("insights.view", {
    resourceId: id,
    version: z.number().int().min(0),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    activeSeconds: z.number().int().min(0).max(86_400),
  }),
  // owner: analytics. Practice analytics (code-only rollups, 0 tokens). Course-scoped like the
  // practice ops: the anchors are required and each is authorized by the worker's trusted resolver.
  learningOp("analytics.assignment", {
    courseId: id,
    anchorIds: z.array(id).min(1).max(50),
    assignmentId: id,
  }),
  learningOp("analytics.course", {
    courseId: id,
    anchorIds: z.array(id).min(1).max(50),
    sessions: z.number().int().min(1).max(20).optional(),
  }),
  learningOp("analytics.agendaHints", {
    courseId: id,
    anchorIds: z.array(id).min(1).max(50),
  }),
  // end owner: analytics
  // owner: exam-prep. The exam blueprint, the practice exam and interactive solving (N15, P09's
  // input). Course-scoped like the practice ops; every check runs in code (0 tokens at study time).
  learningOp("exam.blueprint", {
    courseId: id,
    anchorIds: z.array(id).min(1).max(50),
    assessmentId: id,
  }),
  learningOp("exam.build", {
    courseId: id,
    anchorIds: z.array(id).min(1).max(50),
    assessmentId: id,
    length: z.number().int().min(3).max(60),
    lean: z.boolean(),
    timed: z.boolean(),
    minutes: z.number().int().min(5).max(300).optional(),
    examConditions: z.boolean(),
    operationId: id,
  }),
  learningOp("exam.solve", {
    courseId: id,
    anchorIds: z.array(id).min(1).max(50),
    problemIds: ids(20).optional(),
    topicIds: ids(20).optional(),
    count: z.number().int().min(1).max(10),
    fade: z.boolean(),
    operationId: id,
  }),
  learningOp("exam.session", { sessionId: id }),
  learningOp("exam.answer", {
    sessionId: id,
    revision: z.number().int().nonnegative(),
    operationId: id,
    questionId: id,
    stepId: id,
    response: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("choice"), optionId: id }).strict(),
      z.object({ kind: z.literal("text"), text: z.string().max(4000) }).strict(),
      z.object({ kind: z.literal("number"), value: z.number(), unit: z.string().max(40).optional() }).strict(),
      z.object({ kind: z.literal("expression"), text: z.string().max(300) }).strict(),
      z
        .object({
          kind: z.literal("order"),
          blocks: z.array(z.object({ id, indent: z.number().int().min(0).max(8) }).strict()).max(40),
        })
        .strict(),
      z.object({ kind: z.literal("mark"), mark: z.enum(["right", "partly", "wrong"]) }).strict(),
    ]),
    /** Optional self-explanation of the step, graded against its key ideas; never required. */
    explanation: z.string().max(2000).optional(),
    confidence: z.union([z.literal(0), z.literal(0.33), z.literal(0.67), z.literal(1), z.null()]),
    responseMs: z.number().int().min(0).max(86_400_000),
  }),
  learningOp("exam.hint", {
    sessionId: id,
    revision: z.number().int().nonnegative(),
    operationId: id,
    questionId: id,
    stepId: id,
  }),
  learningOp("exam.submit", {
    sessionId: id,
    revision: z.number().int().nonnegative(),
    operationId: id,
  }),
  // end owner: exam-prep
  // owner: mastery (D57). Course mastery, 0 tokens. Course-scoped like analytics: the anchors are
  // required and each is authorized by the worker's trusted resolver.
  learningOp("course.mastery", { courseId: id, anchorIds: z.array(id).min(1).max(50) }),
  learningOp("mastery.assessment", { courseId: id, anchorIds: z.array(id).min(1).max(50), assessmentId: id }),
  learningOp("mastery.forItems", { courseId: id, anchorIds: z.array(id).min(1).max(50), itemIds: z.array(id).min(1).max(100) }),
  learningOp("mastery.history", { courseId: id, anchorIds: z.array(id).min(1).max(50) }),
  learningOp("mastery.claim", { courseId: id, anchorIds: z.array(id).min(1).max(50), topicId: id, operationId: id }),
  learningOp("mastery.hide", { courseId: id, anchorIds: z.array(id).min(1).max(50), topicId: id, hidden: z.boolean() }),
  learningOp("course.grades", { courseId: id, anchorIds: z.array(id).min(1).max(50) }),
  // end owner: mastery
]);
export type LearningRequest = z.infer<typeof learningRequestSchema>;
export type LearningOp = LearningRequest["op"];
/** The learning router's answer. `not_built` is the stub's honest answer; the router (N25) refines `data`. */
export interface LearningResult {
  op: LearningOp;
  status: "ok" | "not_built" | "unavailable" | "consent_needed" | "failed";
  message?: string;
  data?: unknown;
}
/** D33: the system settles every decision; the student may correct one in a click. There is no "confirm". */
export const correctionSchema = z.discriminatedUnion("subject", [
  z
    .object({
      subject: z.literal("scope"),
      assessmentId: id,
      target: z
        .object({
          kind: z.enum(["resource", "topic", "module", "session"]),
          id,
        })
        .strict(),
      action: z.enum(["include", "exclude"]),
    })
    .strict(),
  z
    .object({
      subject: z.literal("role"),
      resourceId: id,
      // The closed role set is the data builder's; a slug crosses here and is checked there.
      role: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/),
      assessmentId: id.optional(),
      tier: z.enum(["core", "supporting", "practice"]).optional(),
    })
    .strict(),
  // owner: agenda. D49: the student's own effort estimate for an item (5 min–40 h); it wins
  // over code's and the model's, and teaches the course's calibration.
  z
    .object({
      subject: z.literal("estimate"),
      resourceId: id,
      minutes: z.number().int().min(5).max(2400),
    })
    .strict(),
  // end owner: agenda
  // owner: study-prep. The student's correction of an item's type (it wins over code and their AI).
  z
    .object({
      subject: z.literal("item_type"),
      courseId: id,
      itemId: id,
      type: z.enum(ITEM_TYPES),
    })
    .strict(),
]);
export type Correction = z.infer<typeof correctionSchema>;
export const packScopeSchema = z
  .object({
    courseId: id,
    assessmentId: id.optional(),
    resourceIds: ids(200).optional(),
    topicIds: ids(50).optional(),
    // owner: generation. A module scope: the module's items (Resource.module.id) only.
    moduleId: id.optional(),
  })
  .strict();
export type PackScope = z.infer<typeof packScopeSchema>;
/** ui_events kinds (plan §3). "confirm" is replaced by "correct" per D33. */
export const uiEventSchema = z
  .object({
    kind: z.enum(["expand_all", "move_tier", "open", "correct"]),
    subject: id,
    detail: z.string().max(200).optional(),
  })
  .strict();
export type UiEvent = z.infer<typeof uiEventSchema>;
/** D40: the command bar's command after code resolved it. Language code can't resolve stays in `text`. */
export const workspaceCommandSchema = z
  .object({
    verb: z.enum(["open", "quiz", "cards", "explain", "due"]),
    text: z.string().max(500).optional(),
    courseId: id.optional(),
    resourceId: id.optional(),
    topicIds: ids(50).optional(),
    days: z.number().int().min(1).max(60).optional(),
  })
  .strict();
export type WorkspaceCommand = z.infer<typeof workspaceCommandSchema>;
export interface WorkspaceResult {
  verb: WorkspaceCommand["verb"];
  status: "ok" | "not_built" | "unresolved";
  /** open: the https link for the default browser (D40); the renderer calls openExternal. */
  url?: string;
  /** due: the items code resolved, soonest first. */
  items?: {
    id: string;
    title: string;
    courseName: string;
    dueAt: string;
    url: string;
  }[];
  message?: string;
}
// owner: intent. The command bar's plain-language request (typed with Ctrl+K or dictated into the
// same bar). `run` resolves and runs one registered action; `preview` runs only the code resolver
// (0 tokens, never the model) for a live hint; `prewarm` readies the AI fallback when the bar opens.
export const intentCommandSchema = z
  .object({
    text: z.string().max(2000),
    /** Caller restriction, checked after resolution; never grants permission. */
    allowedActions: z.array(z.string().min(1).max(100)).max(40).optional(),
    context: z
      .object({ courseId: id.optional(), view: z.string().max(100).optional(), noteId: id.optional(), resourceId: id.optional() })
      .strict()
      .optional(),
    /** `preview` here is deprecated: use the `intent.preview` query, which skips the snapshot. */
    mode: z.enum(["run", "preview", "prewarm"]).optional(),
  })
  .strict();
export type IntentCommand = z.infer<typeof intentCommandSchema>;
/** Surface arguments: what the student said, before code resolves them to IDs and dates. */
export interface IntentSlots {
  course?: string | null;
  assignment?: string | null;
  topics?: string[] | null;
  date?: string | null;
  /** A clock time or range as said ("3pm", "2-3:30pm"); code reads it. */
  time?: string | null;
  query?: string | null;
  kind?: "cards" | "quiz" | null;
  count?: number | null;
  scope?: "course" | "all" | null;
}
export interface IntentCandidate {
  action: string;
  args: IntentSlots;
  /** What the choice does, in the student's words. */
  label: string;
}
export interface IntentCitation {
  sourceId: string;
  resourceId: string;
  title: string;
  url: string;
  /** Exactly as it appears in the resource text; code checked it. */
  quote: string;
  start: number | null;
  end: number | null;
}
/** How the request was understood: code (0 tokens), the model, the model's cached answer, or neither. */
export type IntentPath = "code" | "ai" | "cache" | "none";
export type CommandOutcome =
  | { status: "ran"; action: string; args: Record<string, unknown>; result: unknown }
  | { status: "clarify"; question: string; candidates: IntentCandidate[] }
  | { status: "answer"; text: string; citations: IntentCitation[]; notFound: boolean; dropped: number }
  | { status: "unavailable"; reason: string }
  | { status: "preview"; hint: string | null; action: string | null; slots: IntentSlots }
  /** prewarm: whether the AI fallback is connected and ready. */
  | { status: "ready"; ai: boolean };
export type IntentCommandResult = CommandOutcome & {
  path: IntentPath;
  latencyMs: number;
  tokens: { in: number; cached: number; out: number };
};
// end owner: intent
// owner: T15. Scoped queries (O1): a view asks for what it shows instead of the whole workspace.
export const queryRequestSchema = z.discriminatedUnion("view", [
  z.object({ view: z.literal("summary") }).strict(),
  z.object({ view: z.literal("courseSpaces"), accountScope: id, courseId: id }).strict(),
  z
    .object({
      view: z.literal("resources"),
      courseId: id.optional(),
      accountScope: id.optional(),
      kinds: z.array(z.string().max(40)).max(10).optional(),
      search: z.string().max(500).optional(),
      cursor: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  z.object({ view: z.literal("resource"), id }).strict(),
  // owner: T30. The agent layer's mail search over stored fields (never a body).
  z
    .object({
      view: z.literal("mail.search"),
      text: z.string().max(500).optional(),
      category: mailCategorySchema.optional(),
      org: z.string().max(300).optional(),
      courseId: id.optional(),
      from: z.string().max(320).optional(),
      since: instant.optional(),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  z
    .object({
      view: z.literal("changes"),
      cursor: z.string().max(400).optional(),
      courseId: id.optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict(),
  // owner: guides. The personalised view of a cached study guide (op guide.view); reads only, 0 tokens.
  z
    .object({
      view: z.literal("guide"),
      courseId: id,
      kind: z.enum(["guide", "briefing", "faq", "timeline", "compare", "conceptmap"]),
      moduleId: id.optional(),
      assessmentId: id.optional(),
    })
    .strict(),
  // end owner: guides
  // owner: agenda. D49: the critical-action agenda and the launch view, read from the local
  // database only (no network, 0 model calls). `timeZone` is an IANA name for the display dates.
  z
    .object({
      view: z.literal("agenda.ranked"),
      limit: z.number().int().min(1).max(50).optional(),
      accountScope: id.optional(),
      courseId: id.optional(),
      timeZone: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      view: z.literal("workspace.bootstrap"),
      top: z.number().int().min(1).max(20).optional(),
      timeZone: z.string().min(1).max(64).optional(),
    })
    .strict(),
  // end owner: agenda
  // owner: intent. The command bar's live hint while typing or dictating: the code resolver only,
  // 0 tokens, never the model, and no snapshot recompute (the query channel).
  z
    .object({
      view: z.literal("intent.preview"),
      text: z.string().max(500),
      courseId: id.optional(),
    })
    .strict(),
  // end owner: intent
  // owner: page-views. One composite read per page: assignment.workspace, lecture.session, assessment.page.
  ...pageViewRequestSchemas,
  // end owner: page-views
  studyPrepRequestSchema, // owner: study-prep: one composite read per assessment, 0 tokens
]);
export type QueryRequest = z.infer<typeof queryRequestSchema>;
// owner: agenda. D49 result shapes; the ranking and every number in them are code's.
export type AgendaItemKind = "assignment" | "quiz" | "exam" | "discussion";
/** Slack bands for display: overdue (past due, still accepted), start_now (the latest start has passed). */
export type AgendaBand = "overdue" | "start_now" | "today" | "soon" | "week" | "later";
export interface AgendaEstimate {
  /** Bounded to 5 min–40 h. */
  minutes: number;
  /** student: the student's correction (wins); model: their AI refined it; code: the app's rule. */
  method: "code" | "model" | "student";
  label: "estimate";
  /** A per-course calibration from the student's corrections was applied. */
  calibrated: boolean;
}
export interface AgendaWeight {
  points: number | null;
  /**
   * The grade weight and how complete it is (FDB-001): `listed` is the Canvas group weight or the
   * syllabus's stated weight; `computed` is this item's share, only with complete coverage. The
   * ranking uses listed or computed only; unknown falls back to points.
   */
  grade: { basis: "listed" | "computed"; percent: number; source: "canvas_group" | "syllabus" } | null;
}
export interface AgendaItem {
  /** A resource ID, or `assessment:<id>` for a syllabus-only exam. */
  id: string;
  resourceId: string | null;
  kind: AgendaItemKind;
  title: string;
  accountScope: string;
  courseId: string;
  courseName: string;
  url: string | null;
  /** The due date, or the lock date when there's no due date (`dateKind: "closes"`). */
  dueAt: string;
  dateKind: "due" | "closes";
  lockAt: string | null;
  unlockAt: string | null;
  estimate: AgendaEstimate;
  /** dueAt − estimate − buffer. */
  latestStartAt: string;
  /** latestStartAt − now, in minutes (negative: behind). */
  slackMinutes: number;
  band: AgendaBand;
  weight: AgendaWeight;
  flags: {
    /** Canvas says missing, or past due with nothing submitted. */
    missing: boolean;
    /** Past due and still accepted. */
    late: boolean;
    /** Not unlocked yet. */
    notYetOpen: boolean;
  };
  /** One line on why it matters now: the student's AI over code's facts (checked), or code's line. */
  why: { text: string; source: "model" | "code" };
  /** 1-based position among ranked items; 0 for a flagged item that isn't ranked. */
  rank: number;
}
export interface AgendaCounts {
  /** Open items with a date (ranked plus flagged). */
  open: number;
  ranked: number;
  overdue: number;
  missing: number;
  dueToday: number;
  dueThisWeek: number;
  /** Open items with no due or lock date: not ranked. */
  undated: number;
  notYetOpen: number;
  estimatedBy: { code: number; model: number; student: number };
}
export interface AgendaClassMeeting {
  key: string;
  courseKey: string;
  title: string;
  startsAt: string;
}
export interface AgendaNarration {
  /** model: every shown line is the model's; partial: some fell back to code; code: none cached. */
  status: "model" | "partial" | "code";
  /** The hash the narration is cached under; it changes when the top items' facts or the day change. */
  factHash: string;
  /** Model lines code dropped because a number or date didn't match the facts. */
  dropped: number;
}
export interface BootstrapCourse {
  accountScope: string;
  courseId: string;
  courseName: string;
  included: boolean;
  open: number;
  missing: number;
  nextDueAt: string | null;
}
export type AgendaQueryResult =
  | {
      view: "agenda.ranked";
      generatedAt: string;
      timeZone: string;
      items: AgendaItem[];
      /** Ranked items in scope (items holds the first `limit`). */
      total: number;
      /** Flagged and not ranked: closed without a submission, or overdue past the window. Never hidden. */
      missing: AgendaItem[];
      counts: AgendaCounts;
      /** Class meetings for display only; never ranked. */
      classes: AgendaClassMeeting[];
      narration: AgendaNarration;
      modelCalls: 0;
    }
  | {
      view: "workspace.bootstrap";
      generatedAt: string;
      timeZone: string;
      fixtureMode: boolean;
      lastSyncAt: string | null;
      sources: { total: number; ok: number; attention: number };
      courses: BootstrapCourse[];
      agenda: { items: AgendaItem[]; total: number; missing: number; counts: AgendaCounts; classes: AgendaClassMeeting[]; narration: AgendaNarration };
      modelCalls: 0;
    };
// end owner: agenda
/** A list row: a resource without its bodies (text, raw HTML, parts, document pages). */
export type ResourceSummary = Omit<
  ResourceView,
  "text" | "rawHtml" | "parts" | "document"
> & {
  excerpt: string;
  textLength: number;
  document?: Omit<NonNullable<ResourceView["document"]>, "pages">;
};
export interface CourseSummary {
  accountScope: string;
  courseId: string;
  courseName: string;
  resources: number;
  open: number;
  nextDue: string | null;
  included: boolean;
}
export type QueryResult =
  | { view: "courseSpaces"; items: import("./course-core").CourseSpace[] }
  | {
      view: "summary";
      generatedAt: string;
      sources: SourceHealth[];
      privacy: PrivacyPreferences;
      consents: ConsentRecord[];
      ingestionSettings: IngestionSettings;
      courseOverrides: CourseOverride[];
      gatewayConfigured: boolean;
      fixtureMode: boolean;
      courses: CourseSummary[];
      jobs: { pending: number; running: number; failed: number; done: number };
      receipts: EgressReceipt[];
      syncRuns: SyncRun[];
      /** Pass to a "changes" query to get what changed after this summary. */
      changesCursor: string;
    }
  | {
      view: "resources";
      items: ResourceSummary[];
      total: number;
      nextCursor?: string;
    }
  | { view: "resource"; resource: ResourceView; links: Link[]; changes: ResourceChange[] }
  | { view: "mail.search"; items: MailSearchItem[] } // owner: T30
  | {
      view: "changes";
      /** Oldest first. */
      changes: ResourceChange[];
      cursor: string;
      /** false: more changed than one page can say; reload the views, then follow the new cursor. */
      complete: boolean;
    }
  // owner: guides. `guide` is the view body (packages/packs/guide GuideView | ConceptMapView).
  | {
      view: "guide";
      op: "guide.view";
      status: "ready" | "stale" | "missing" | "empty" | "blocked" | "unavailable";
      kind: "guide" | "briefing" | "faq" | "timeline" | "compare" | "conceptmap";
      courseRef: string | null;
      artifactId: string | null;
      /** True when the material changed since the guide was made; it is served until regenerated on request. */
      stale: boolean;
      changedSources: { resourceId: string; title: string; change: "changed" | "removed" | "added" }[];
      message: string | null;
      modelCalls: 0;
      guide: unknown;
    }
  // end owner: guides
  | AgendaQueryResult // owner: agenda
  | { view: "intent.preview"; preview: IntentCommandResult } // owner: intent
  | PageViewResult // owner: page-views
  | StudyPrepResult; // owner: study-prep
// end owner: T15
/** Opt-in on learning, notes and ui_event commands: answer with the result only (no snapshot). */
const replySchema = z.literal("result").optional();
export const commandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("planning-guide"),
      subjectCode: z.string().regex(/^\d{1,6}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("planning-search"),
      subjectCode: z.string().regex(/^\d{1,6}$/),
      termCode: z.string().regex(/^1\d{2}[246]$/),
      page: z.number().int().min(1).max(20).default(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("planning-sections"),
      recordId: z.string().max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal("planning-compare"),
      termCode: z.string().regex(/^1\d{2}[246]$/),
      style: z.enum(["balanced", "mornings", "compact", "lighter"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("planning-import"),
      batch: planningCaptureSchema,
    })
    .strict(),
  // Historical grade evidence for one course; refresh reads Madgrades through the desktop host.
  z.object({ type: z.literal("planning-grades"), courseKey: z.string().regex(/^uw:\d{1,6}:[A-Z0-9]{1,12}$/), refresh: z.boolean().default(false) }).strict(),
  // Handled by the desktop host's protected secret vault; never forwarded to the workspace or stored in records.
  z.object({ type: z.literal("madgrades-token"), token: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).nullable() }).strict(),
  z
    .object({
      type: z.literal("snapshot"),
      search: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("import"), batch: captureEnvelopeSchema })
    .strict(),
  z
    .object({
      type: z.literal("ingestion-settings"),
      value: ingestionSettingsSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("course-override"), value: courseOverrideSchema })
    .strict(),
  z.object({ type: z.literal("mcp-grant"), value: mcpGrantSchema }).strict(),
  z
    .object({ type: z.literal("day-plan"), entry: dayPlanEntrySchema })
    .strict(),
  z.object({ type: z.literal('personal-calendar-save'), event: personalCalendarEventSchema }).strict(),
  z.object({ type: z.literal('personal-calendar-remove'), id: z.string().uuid() }).strict(),
  z
    .object({
      type: z.literal("day-plan-remove"),
      key: z.string().min(1).max(300),
      date: z.iso.date(),
    })
    .strict(),
  z.object({ type: z.literal("personal-deadline"), value: personalDeadlineChangeSchema }).strict(),
  z.object({ type: z.literal("personal-work"), value: personalWorkChangeSchema }).strict(),
  z.object({ type: z.literal("personal-report"), value: personalReportChangeSchema }).strict(),
  z
    .object({
      type: z.literal("notifications-read"),
      ids: z.array(z.string().min(1).max(600)).max(500),
    })
    .strict(),
  z
    .object({
      type: z.literal("notification-dismiss"),
      id: z.string().min(1).max(600),
    })
    .strict(),
  z.object({ type: z.literal("fixture") }).strict(),
  // A student-supplied UW GitLab project for a course the connector could not discover.
  z
    .object({
      type: z.literal("gitlab-link"),
      accountScope: id,
      courseId: id,
      url: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      type: z.literal("gitlab-unlink"),
      accountScope: id,
      courseId: id,
      projectPath: z.string().min(1).max(300),
    })
    .strict(),
  // Removes only the Outlook calendar and its meetings from this device. Used by disconnect and sign-out.
  z.object({ type: z.literal("outlook-disconnect") }).strict(),
  // owner: T30. Removes the Graph mail and calendar records (tokens and delta links are main's).
  z.object({ type: z.literal("outlook-disconnect-graph") }).strict(),
  z
    .object({ type: z.literal("complete"), id, completed: z.boolean() })
    .strict(),
  z.object({ type: z.literal("privacy"), value: privacyCommandSchema }).strict(),
  z.object({ type: z.literal("consent"), value: consentChangeSchema }).strict(),
  z
    .object({ type: z.literal("preview.ack"), value: previewAckSchema })
    .strict(),
  z
    .object({
      type: z.literal("context"),
      id,
      recipient: aiRecipientSchema,
    })
    .strict(),
  z.object({ type: z.literal("enrich"), id }).strict(),
  z.object({ type: z.literal("work-set"), id }).strict(),
  z.object({ type: z.literal("identity-roster"), value: identityRosterSchema }).strict(),
  z.object({ type: z.literal("validate-citations"), claims: z.array(citationClaimSchema).min(1).max(200) }).strict(),
  z
    .object({
      type: z.literal("link"),
      id,
      status: z.enum(["accepted", "rejected"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("purge"),
      confirmation: z.literal("DELETE LOCAL DATA"),
    })
    .strict(),
  // owner: T05b. The seams; core's switch is exhaustive, so a variant here without a case is a type error.
  z
    .object({
      type: z.literal("map"),
      courseId: id,
      accountScope: id.optional(),
    })
    .strict(),
  z.object({ type: z.literal("correct"), value: correctionSchema }).strict(),
  z
    .object({
      type: z.literal("pack"),
      pack: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
      scope: packScopeSchema,
    })
    .strict(),
  z.object({ type: z.literal("ui_event"), value: uiEventSchema, reply: replySchema }).strict(),
  z
    .object({ type: z.literal("workspace"), value: workspaceCommandSchema })
    .strict(),
  z
    .object({ type: z.literal("learning"), request: learningRequestSchema, reply: replySchema })
    .strict(),
  // end owner: T05b
  // owner: intent
  z.object({ type: z.literal("command"), value: intentCommandSchema }).strict(),
  // end owner: intent
  // owner: notes
  z.object({ type: z.literal("notes"), request: notesRequestSchema, reply: replySchema }).strict(),
  // end owner: notes
]);
export type Command = z.infer<typeof commandSchema>;
/**
 * A learning, notes or ui_event command sent with `reply: "result"` answers with its own result
 * only: no workspace snapshot is built, cloned or sent. Without it, the reply is unchanged.
 */
export type ResultOnlyCommand = Extract<Command, { type: "learning" | "notes" | "ui_event" }> & { reply: "result" };
export type ResultOnlyCommandResult = Omit<CommandResult, "snapshot">;
/**
 * What "Start work" opens for one assignment, rebuilt from the local store.
 * The renderer supplies only an ID; it never chooses URLs or file paths.
 */
export type WorkTarget =
  | { kind: "web"; url: string }
  /** `extension` is derived from verified type evidence; cached files have no name of their own. */
  | { kind: "file"; path: string; extension: string; fallbackUrl: string };
export interface WorkItem {
  resourceId: string;
  title: string;
  role: "instructions" | "material";
  /**
   * Why a material is here: listed directly in the saved assignment (including
   * pages Magic hasn't saved, whose `resourceId` is `<assignmentId>:link:<hash>`)
   * or connected through accepted supporting evidence.
   */
  provenance?: "assignment_link" | "supporting_evidence";
  reason: string;
  target: WorkTarget;
}
export interface WorkHeldItem {
  resourceId: string;
  title: string;
  reason: string;
}
export interface WorkSet {
  /** Opaque identity of all previewed target versions and destinations. */
  previewHash: string;
  assignmentId: string;
  assignmentTitle: string;
  contentHash: string;
  /** Opened in this order; the instructions come last so they end up in front. */
  items: WorkItem[];
  /** Related items deliberately not opened (suggested matches, overflow). */
  held: WorkHeldItem[];
  notes: string[];
  /** What the saved assignment does and doesn't say, with provisional same-course context. */
  context?: AssignmentContext;
}
// owner: task-workspace (assignment-context). Produced by core `resolveAssignmentContext`.
export interface AssignmentContextLink {
  url: string;
  host: string;
  text: string | null;
  /** A saved copy with text; null means link only, contents unread. */
  captured: { resourceId: string; title: string; chars: number; contentHash: string } | null;
  note: string;
}
export interface AssignmentContextSection {
  resourceId: string;
  title: string;
  url: string;
  sourceId: string;
  /** Version of the page the span was cut from. */
  contentHash: string;
  observedAt: string;
  start: number;
  end: number;
  quote: string;
  /** Dates written near this section's heading, verbatim. */
  dates: string[];
  links: { url: string; text: string | null }[];
  /** True only through an accepted `specifies` link; otherwise the section is provisional. */
  linkedToAssignment: boolean;
  provisional: boolean;
  reason: string;
  dateConflict: string | null;
}
export interface AssignmentContextSource {
  sourceId: string;
  label: string;
  kind: SourceHealth["kind"];
  status: SourceHealth["status"];
  complete: boolean;
  lastSuccessAt: string | null;
  stale: boolean;
  note: string | null;
}
export interface AssignmentContext {
  version: number;
  assignmentId: string;
  accountScope: string;
  courseId: string;
  title: string;
  contentHash: string;
  observedAt: string;
  url: string;
  canvas: { dueAt: string | null; lockAt: string | null };
  /** The numbered unit named in the title ("Lecture 7"), if any. */
  anchor: string | null;
  instructions: { status: "captured" | "empty"; chars: number; text: string };
  /** Canvas submission types verbatim; "none" is not proof that nothing is due. */
  submission: { types: string[]; status: "listed" | "none_listed" | "unknown"; text: string };
  links: AssignmentContextLink[];
  sections: AssignmentContextSection[];
  unknowns: string[];
  sources: AssignmentContextSource[];
}
export interface WorkLaunchReceipt {
  assignmentId: string;
  assignmentTitle: string;
  at: string;
  /** "dry_run" in headless verification: nothing was opened. */
  mode: "opened" | "dry_run";
  opened: {
    resourceId: string;
    title: string;
    via: "browser" | "file" | "browser_fallback";
  }[];
  failed: { resourceId: string; title: string; reason: string }[];
  held: WorkHeldItem[];
  notes: string[];
}
// owner: task-workspace. Task-owned windows in the student's default browser.
/** Left: instructions. Right: the page the task is worked in. Support: extra pages, not placed. */
export type TaskWindowRole = "instructions" | "work" | "support";
export interface TaskWindowPage {
  key: string;
  role: TaskWindowRole;
  url: string;
  title: string;
  /** Where the URL came from; main re-derives every non-student URL from the store. */
  origin: "work_set" | "gitlab" | "student";
}
/** A window Magic saw appear for the browser process after asking for a new one. */
export interface TaskWindowRef {
  key: string;
  role: TaskWindowRole;
  url: string;
  bundleId: string;
  pid: number;
  windowNumber: number;
  placed: boolean;
  openedAt: string;
}
export interface TaskWindowCapability {
  browser: string | null;
  bundleId: string | null;
  family: "firefox" | "chromium" | "safari" | "other" | "unknown";
  /** The browser has a documented new-window switch Magic uses. */
  newWindow: boolean;
  /** Needed to place, bring forward and close task windows. */
  accessibility: boolean;
  reason?: string;
}
export type TaskWindowOutcomeState =
  | "new_window" | "new_window_unplaced" | "not_observed" | "focused" | "present" | "closed"
  | "still_open" | "missing" | "ambiguous" | "not_sent" | "test_only";
export interface TaskWindowOutcome { key: string; state: TaskWindowOutcomeState; detail?: string }
export type TaskWindowRequest =
  | { action: "status" }
  | { action: "request-access" }
  | { action: "open"; accountScope: string; resourceId: string; pages: TaskWindowPage[] }
  | { action: "continue"; accountScope: string; resourceId: string; pages: TaskWindowPage[]; windows: TaskWindowRef[] }
  | { action: "close"; accountScope: string; resourceId: string; windows: TaskWindowRef[] };
export interface TaskWindowResult {
  mode: "live" | "test_only";
  capability: TaskWindowCapability;
  /** Owned windows after this action (open: only the new ones). */
  windows: TaskWindowRef[];
  outcomes: TaskWindowOutcome[];
}
// end owner: task-workspace
export type CommandResult = {
  personalWorkReceipt?: PersonalWorkState;
  workSet?: WorkSet;
  planningComparison?: PlanningComparison;
  planningGrades?: PlanningGradeSummary;
  snapshot: Snapshot;
  manifest?: ContextManifest;
  message?: string;
  // owner: T05b. Seam results; each is filled only by its own command.
  learning?: LearningResult;
  map?: unknown;
  pack?: unknown;
  workspace?: WorkspaceResult;
  // end owner: T05b
  notes?: NotesResult; // owner: notes
  citations?: CitationResult[];
  command?: IntentCommandResult; // owner: intent
};
export const localQuestionSchema = z
  .object({
    id,
    inputHash: z.string().min(1).max(256),
    question: z.string().trim().min(1).max(2000),
  })
  .strict();
export type LocalQuestion = z.infer<typeof localQuestionSchema>;
export interface LocalStatus {
  status: "ready" | "setup_needed";
  reason: string;
  cloudDisabled: boolean;
  selectedModel: string | null;
  recommenderAvailable: boolean;
  basis: string;
}
export interface LocalAnswer {
  text: string;
  model: string | null;
  policyLimited: boolean;
  recipient: "local";
  resourceId: string;
  inputHash: string;
  sourceTitle: string;
  sourceUrl: string;
  observedAt: string;
}
/** One shared bound for the on-screen preview and local runtime input. */
export function localContextPayload(
  payload: ContextManifest["payload"],
): ContextManifest["payload"] {
  return {
    course: payload.course.slice(0, 200),
    title: payload.title.slice(0, 500),
    text: payload.text.slice(0, 6000),
    policy: payload.policy.slice(0, 2000),
  };
}
// owner: accounts. The My Magic UW account and whether it has bought the app
// (docs/accounts-and-payments.md). Tokens stay in main; the renderer sees only this status.
export type AccountPurchase = "paid" | "not-bought" | "refunded" | "test-only" | "unknown";
export type AccountStatus =
  | { state: "unconfigured" }
  | { state: "signed-out" }
  | {
      state: "signed-in";
      email: string;
      purchase: AccountPurchase;
      /** Paid, confirmed now or within the offline grace period. Nothing is locked by it yet. */
      entitled: boolean;
      /** When the server last confirmed the purchase state. */
      checkedAt?: string;
      /** The server couldn't be reached; the purchase shown is the last confirmed one. */
      offline: boolean;
    };
export interface AccountBridge {
  status(): Promise<AccountStatus>;
  /** Emails a sign-in code. */
  sendCode(email: string): Promise<{ sent: boolean; reason?: "invalid" | "rate-limited" | "unavailable" }>;
  verifyCode(email: string, code: string): Promise<{ signedIn: boolean; reason?: "invalid" | "wrong-code" | "unavailable" }>;
  signOut(): Promise<void>;
  /** Opens the website's account page to buy, in the default browser. */
  buy(): Promise<void>;
}
// end owner: accounts

/** Source-linked task facts; the same result can be consumed by Study and Daily Brief. */
export interface SourceInvestigationResult {
  status: "resolved" | "partial" | "ambiguous";
  summary: string;
  assignmentId: string;
  workSet: Pick<WorkSet, "assignmentId" | "items" | "held">;
  findings: { kind: "instruction" | "reading" | "work_target" | "context"; text: string; citations: { resourceId: string; contentHash: string; version: number; start: number; end: number; excerpt: string; provisional: boolean; sourceUrl: string }[] }[];
  unknowns: string[];
  model: string;
  client: "claude" | "codex";
  egressReceiptIds?: string[];
}
export interface AppBridge {
  /** One student-opened, read-only investigation. Operation ID permits Stop. */
  investigateAssignment?(request: { operationId: string; assignmentId: string }): Promise<SourceInvestigationResult>;
  stopAssignmentInvestigation?(operationId: string): Promise<void>;
  /** Shared typed/voice read and navigation path; main owns the action restriction. */
  intentRun?(request: { operationId: string; text: string; context?: IntentCommand["context"] }): Promise<IntentCommandResult>;
  cancelIntent?(operationId: string): Promise<void>;
  /** owner: accounts. Sign-in and purchase status; absent in builds without the bridge. */
  account?: AccountBridge;
  execute(command: ResultOnlyCommand): Promise<ResultOnlyCommandResult>;
  execute(command: Command): Promise<CommandResult>;
  /**
   * owner: stall-audit. Called when the workspace changed (at most once a second, never while
   * idle); returns the unsubscribe. The window re-reads its snapshot then instead of polling.
   */
  onChanged?(listener: () => void): () => void;
  openExternal(url: string): Promise<void>;
  /** owner: T05b. A link card (D40): the default browser, https only. */
  openLink?(url: string): Promise<void>;
  /**
   * owner: doc-window. A synced note's Word online or Google Doc in the app's signed-in document
   * window (UW single sign-on, https document hosts only); any other web link opens in the browser.
   */
  openDocument?(url: string): Promise<{ opened: "window" | "browser" }>;
  /** owner: T15. A scoped query (O1); reads only, never a command. */
  query?(request: QueryRequest): Promise<QueryResult>;
  /** Reviewed destination hash is mandatory; `only` retries previously failed IDs. */
  startWork?(id: string, previewHash: string, only?: string[]): Promise<WorkLaunchReceipt>;
  /** owner: task-workspace. Fresh, identified default-browser windows for one task. */
  taskWindows?(request: TaskWindowRequest): Promise<TaskWindowResult>;
  /** owner: pipeline. Graph reads: an assignment's references, the agenda, a course's graph and coverage. */
  graph?<Q extends GraphQuery>(request: Q): Promise<GraphResult<Q>>;
  importFile(): Promise<CommandResult | null>;
  /** owner: client-health (FDB-002). Resolves with how the window ended; `confirmed` is the only success. */
  signInUW?(service?: SignInService): Promise<SignInOutcome>;
  /** `phase: "enrollment"` (fix/current-courses-only): this term's enrollment only, before course discovery. */
  syncPlanning?(options?: { phase?: "enrollment" }): Promise<CommandResult>;
  /** `discover` (fix/current-courses-only): read only the course lists, so the student chooses first. */
  syncCanvas?(options?: { discover?: boolean; confirm?: boolean }): Promise<CommandResult>;
  signOutUW?(): Promise<void>;
  /** Saves (or with null, removes) the published Outlook calendar link in the encrypted vault. */
  setOutlookCalendar?(url: string | null): Promise<{ connected: boolean }>;
  /** Whether a link is saved. The link itself is never returned to the renderer. */
  outlookCalendarStatus?(): Promise<{ connected: boolean }>;
  // owner: T30. Outlook through the app's own Microsoft sign-in (Graph). No token crosses.
  /** Starts (or retries) the connection: silent first, Microsoft's window only if needed. */
  outlookConnect?(): Promise<OutlookStatus>;
  outlookStatus?(): Promise<OutlookStatus>;
  /** Deletes the tokens, the delta links and every stored Outlook message and Graph event. */
  outlookDisconnectGraph?(): Promise<OutlookStatus>;
  /** One message's body, fetched now and never stored. */
  outlookMailBody?(id: string): Promise<{ contentType: "text"; body: string }>;
  /** Builds a proposal the student reviews; nothing is written. */
  calendarProposeEvent?(input: {
    subject: string;
    start: string;
    end: string;
    timeZone?: string;
    location?: string;
    joinUrl?: string;
  }): Promise<CalendarProposal>;
  /** Writes the event only for a proposal main issued and the student clicked to confirm. */
  calendarCreateEvent?(proposalId: string): Promise<{ created: boolean; webLink?: string }>;
  // end owner: T30
  localStatus?(): Promise<LocalStatus>;
  localAsk?(request: LocalQuestion): Promise<LocalAnswer>;
  cancelLocal?(): Promise<void>;
  exportMcp?(id: string): Promise<string>;
  keepSignedIn?(value?: boolean): Promise<boolean>;
  /** T05e: Remember my sign-in's status, or forget it. The NetID and password never cross. */
  rememberSignIn?(op: "status" | "forget"): Promise<RememberSignInStatus>;
  /** T80: the student's AI command-line clients, each in an app-owned profile. */
  clients?: ClientsBridge;
}
/**
 * T05e (plan D39). `offered: false` in a build with the feature switched off (a UW licence).
 * `available: false` when the OS offers no protected storage, with the reason shown.
 */
export type RememberSignInStatus =
  | { offered: false }
  | { offered: true; available: boolean; reason?: string; saved: boolean };
/** T80. The AI command-line clients Magic Canvas can host in an app-owned profile. */
export type ClientId = "claude" | "codex" | "gemini";
/**
 * `signin`: the client's own sign-in. `chat` (owner: client-health, D50): the client started in
 * the student's chosen mode with tools, MCP and user customisations off, so the student can
 * check their own account (plan, usage) themselves. No course content is sent to it.
 */
export type TerminalPurpose = "signin" | "chat";
export interface ClientStatus {
  id: ClientId;
  /** A binary was found. With `problem` set it exists but isn't usable. */
  installed: boolean;
  /** Why an installed client can't be used (e.g. `--version` failed); absent when it works. */
  problem?: string;
  version?: string;
  /** The app-owned profile folder and its files exist. */
  profileReady: boolean;
  signedIn: boolean | "unknown";
  method?: "subscription" | "api-key" | "unknown";
  /** The client's own plan name when it reports one (e.g. Claude's pro/max); never identity. */
  plan?: string;
  /** True only where the client's own config directory is verified to be redirectable. */
  isolated: boolean;
  installUrl?: string;
}
export interface ClientsBridge {
  detect(): Promise<ClientStatus[]>;
  prepare(id: ClientId): Promise<ClientStatus>;
  authStatus(id: ClientId): Promise<ClientStatus>;
  choose(id: ClientId): Promise<void>;
  // owner: client-health (D50). Optional so an older main still satisfies the bridge.
  /** Checks the client in the given mode (default: its saved mode), before offering or running it. */
  health?(id: ClientId, mode?: ClientMode): Promise<ClientHealth>;
  /** Saves how the app reaches this client. Refused for a mode the client can't use here. */
  setMode?(id: ClientId, mode: ClientMode): Promise<ClientHealth>;
  /** Gemini's only route (D36): the student's own key, stored with safeStorage. Presence only. */
  geminiKey?: {
    status(): Promise<ApiKeyStatus>;
    save(key: string): Promise<ApiKeyStatus>;
    remove(): Promise<ApiKeyStatus>;
  };
  // end owner: client-health
  terminal: {
    open(id: ClientId, purpose: TerminalPurpose): Promise<{ sessionId: string }>;
    write(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    close(sessionId: string): Promise<void>;
    onData(cb: (sessionId: string, chunk: string) => void): () => void;
    onExit(cb: (sessionId: string, code: number | null) => void): () => void;
  };
}
// owner: client-health (D50, FDB-002)
export * from "./client-health";
export * from "./sign-in";
import type { ApiKeyStatus, ClientHealth, ClientMode } from "./client-health";
import type { SignInOutcome, SignInService } from "./sign-in";
// end owner: client-health
export type StoredPlanningRecord = PlanningRecord & {
  localId: string;
  sourceId: string;
  accountScope: string;
  contentHash: string;
  version: number;
  deleted: boolean;
};
export interface PlanningSourceHealth {
  id: string;
  source: PlanningCapture["source"];
  accountScope: string;
  scope: PlanningScope;
  sourceUrl: string;
  status: PlanningCapture["status"];
  completeness: PlanningCapture["completeness"];
  observedAt: string;
  lastSuccessAt: string | null;
  diagnostics: PlanningCapture["diagnostics"];
}
export interface PlanningSnapshot {
  records: StoredPlanningRecord[];
  sources: PlanningSourceHealth[];
  reconciliation?: import("./planning").AcademicReconciliation;
  /** owner: privacy. Saved records this device cannot open; they are not shown, and the view must say so. */
  unreadable?: number;
}
export interface PlanningComparison {
  termCode: string;
  createdAt: string;
  warnings: string[];
  candidates: {
    courseKey: string;
    title: string;
    packageId: string | null;
    requirements: string[];
    prerequisite: "met" | "conditional" | "unmet" | "unknown";
    prerequisiteReasons: string[];
    schedule: "clear" | "conflict" | "unknown";
    scheduleReasons: string[];
    creditMin: number | null;
    creditMax: number | null;
    seatsAvailable: number | null;
    seatStatus: string;
    multipleRequirements: boolean;
    sourceUrl: string;
    observedAt: string;
    evidence: { label: string; url: string; observedAt: string }[];
    historicalAverage: number | null;
    historicalCount: number | null;
  }[];
}
/** Count-weighted historical grade evidence for one course. Never a prediction or ranking input. */
export interface PlanningGradeAggregate {
  average: number | null; includedCount: number; excludedCount: number; totalCount: number;
  status: "known" | "partial" | "unknown";
}
export interface PlanningGradeSummary {
  courseKey: string;
  createdAt: string;
  refresh: { status: string; message: string } | null;
  warnings: string[];
  terms: (PlanningGradeAggregate & { termCode: string; label: string; sourceUrl: string; observedAt: string })[];
  instructors: (PlanningGradeAggregate & { instructorId: string; names: string[]; termCodes: string[]; sectionCount: number; coTaughtSectionsExcluded: number })[];
  overall: (PlanningGradeAggregate & { termCount: number }) | null;
}
export interface Connector {
  id: string;
  pull(signal?: AbortSignal): AsyncIterable<CaptureBatch>;
}

export type { StudySessionView, StudyEvent, StudySource, StudyCitation, StudyItemView, StudyResultData } from "./study";
