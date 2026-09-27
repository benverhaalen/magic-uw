import { z } from "zod";
import {
  planningCaptureSchema,
  type PlanningCapture,
  type PlanningRecord,
  type PlanningScope,
} from "./planning";
export * from "./planning";
export * from "./course-intelligence";
import type {
  CourseIntelligence,
  CourseIntelligenceView,
  EffectiveCoursePolicy,
} from "./course-intelligence";

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
  })
  .strict();
export const moduleItemSchema = z
  .object({
    type: z.string().max(100),
    title: z.string().max(500).optional(),
    position: z.number().int().optional(),
    externalUrl: evidenceUrlSchema.optional(),
    pageUrl: z.string().max(4000).optional(),
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
  })
  .strict();
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
        kind: z.enum(["canvas", "web", "fixture", "calendar", "gitlab"]),
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
export interface DeadlineResolution {
  dueAt: string | null;
  planningAt: string | null;
  conflict: boolean;
  claims: DeadlineClaim[];
  reason: string;
}
export const privacySchema = z
  .object({
    mode: z.enum(["local_only", "selective_cloud"]),
    jevEnabled: z.boolean(),
    hostedProvider: z.enum(["none", "chatgpt", "claude", "gemini"]),
    shareCourseText: z.boolean(),
    shareStudentWork: z.boolean(),
    shareGrades: z.boolean().optional(),
    shareComments: z.boolean().optional(),
    shareCommunications: z.boolean().optional(),
    sharePlanning: z.boolean().optional(),
    shareHolds: z.boolean().optional(),
    shareAudit: z.boolean().optional(),
  })
  .strict();
export type PrivacyPreferences = Omit<
  z.infer<typeof privacySchema>,
  "shareGrades" | "shareComments" | "shareCommunications"
> & {
  shareGrades?: boolean;
  shareComments?: boolean;
  shareCommunications?: boolean;
};
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
  status: "blocked" | "sent" | "failed";
  createdAt: string;
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
    recipient: z.enum(["local", "chatgpt", "claude", "gemini"]),
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
  resources(search?: string): Resource[];
  resource(id: string): Resource | undefined;
  sources(): SourceHealth[];
  privacy(): PrivacyPreferences;
  setPrivacy(value: PrivacyPreferences): void;
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
  jobs(): Job[];
  judgment(key: string): Judgment | undefined;
  putJudgment(value: Judgment): boolean;
  judgments(): Judgment[];
  addAttempt(value: Attempt): void;
  attempts(resourceId?: string): Attempt[];
  addReceipt(value: EgressReceipt): void;
  receipts(): EgressReceipt[];
  purge(): void;
}
export interface ContextManifest {
  effectivePolicy?: EffectiveCoursePolicy;
  recipient: "jev" | "chatgpt" | "claude" | "gemini" | "local";
  purpose: string;
  categories: string[];
  resourceIds: string[];
  characters: number;
  allowed: boolean;
  reason: string;
  payload: { course: string; title: string; text: string; policy: string };
}
export interface ResourceView extends Resource {
  deadline: DeadlineResolution;
  kindLabel: string | null;
}
export interface Snapshot {
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
}
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
  z.object({ type: z.literal("fixture") }).strict(),
  z
    .object({ type: z.literal("complete"), id, completed: z.boolean() })
    .strict(),
  z.object({ type: z.literal("privacy"), value: privacySchema }).strict(),
  z
    .object({
      type: z.literal("context"),
      id,
      recipient: z.enum(["jev", "chatgpt", "claude", "gemini", "local"]),
    })
    .strict(),
  z.object({ type: z.literal("enrich"), id }).strict(),
  z.object({ type: z.literal("work-set"), id }).strict(),
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
]);
export type Command = z.infer<typeof commandSchema>;
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
  reason: string;
  target: WorkTarget;
}
export interface WorkHeldItem {
  resourceId: string;
  title: string;
  reason: string;
}
export interface WorkSet {
  assignmentId: string;
  assignmentTitle: string;
  contentHash: string;
  /** Opened in this order; the instructions come last so they end up in front. */
  items: WorkItem[];
  /** Related items deliberately not opened (suggested matches, overflow). */
  held: WorkHeldItem[];
  notes: string[];
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
export type CommandResult = {
  workSet?: WorkSet;
  planningComparison?: PlanningComparison;
  snapshot: Snapshot;
  manifest?: ContextManifest;
  message?: string;
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
export interface AppBridge {
  execute(command: Command): Promise<CommandResult>;
  openExternal(url: string): Promise<void>;
  /** `only` retries a subset of the rebuilt set by resource ID. */
  startWork?(id: string, only?: string[]): Promise<WorkLaunchReceipt>;
  importFile(): Promise<CommandResult | null>;
  signInUW?(service?: "canvas" | "gitlab" | "enroll" | "myuw"): Promise<void>;
  syncPlanning?(): Promise<CommandResult>;
  syncCanvas?(): Promise<CommandResult>;
  signOutUW?(): Promise<void>;
  localStatus?(): Promise<LocalStatus>;
  localAsk?(request: LocalQuestion): Promise<LocalAnswer>;
  cancelLocal?(): Promise<void>;
  exportMcp?(id: string): Promise<string>;
}
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
export interface Connector {
  id: string;
  pull(signal?: AbortSignal): AsyncIterable<CaptureBatch>;
}
