/**
 * Course core contracts (schema v6, T10/T11b; learning tables v7, T10L). Zod schemas at the store
 * boundary, the row types, and `CourseCoreStore`: the Store methods storage adds for them.
 * Every row is keyed to `sources(id) ON DELETE CASCADE`, directly or through `resources`.
 */
import { z } from "zod";
import type { Job, Resource, ResourceChange } from "./index";

/** Life sources (mail, feeds) use this course ID, since `sources.course_id` is NOT NULL. */
export const LIFE_COURSE_ID = "_life";
/** The learning anchor's key, `accountScope:courseId` (learning spec §7.2). */
export function courseKey(accountScope: string, courseId: string): string {
  return `${accountScope}:${courseId}`;
}

const text = (max: number) => z.string().min(1).max(max);
const idText = text(500);
const instant = z.iso.datetime({ offset: true });
const dateOrInstant = z.union([instant, z.iso.date()]);
const offset = z.number().int().nonnegative();

// ---------- Jobs with subjects ----------
export const subjectKinds = ["resource", "course", "assessment", "source", "pack"] as const;
export type SubjectKind = (typeof subjectKinds)[number];
export const subjectJobSchema = z
  .object({
    kind: text(200),
    subjectKind: z.enum(subjectKinds),
    subjectId: idText,
    inputHash: text(256),
    /** Required for `resource` subjects; the job cascades with it. */
    resourceId: idText.nullable().optional(),
    /** Required for `course`, `assessment` and `source` subjects; the job cascades with it. */
    sourceId: idText.nullable().optional(),
  })
  .strict();
export type SubjectJobInput = z.infer<typeof subjectJobSchema>;
/** A leased job. `resourceId` is "" for a subject that isn't a resource. */
export interface CourseJob extends Job {
  subjectKind: SubjectKind;
  subjectId: string;
  sourceId: string | null;
}

// ---------- Passages and search ----------
export interface Passage {
  pid: number;
  resourceId: string;
  version: number;
  textHash: string;
  ord: number;
  start: number;
  end: number;
  page: number | null;
  slide: number | null;
  tStart: number | null;
  tEnd: number | null;
  heading: string | null;
  tokEst: number;
  redacted: boolean;
}
export const courseRefSchema = z.object({ accountScope: idText, courseId: idText }).strict();
export type CourseRef = z.infer<typeof courseRefSchema>;
export const passageSearchSchema = z
  .object({
    query: z.string().max(2000),
    /** Omitted: every course. Empty: nothing. */
    courses: z.array(courseRefSchema).max(200).optional(),
    k: z.number().int().min(1).max(20).optional(),
    /** question: OR + bm25 + the not-found gate (default). lookup: every term, prefix-matched. */
    mode: z.enum(["question", "lookup"]).optional(),
  })
  .strict();
export type PassageSearchInput = z.infer<typeof passageSearchSchema>;
export interface PassageHit {
  pid: number;
  resourceId: string;
  sourceId: string;
  accountScope: string;
  courseId: string;
  title: string;
  url: string;
  version: number;
  start: number;
  end: number;
  page: number | null;
  slide: number | null;
  heading: string | null;
  /** bm25, lower is better (FTS5 convention). */
  score: number;
  /** ≤240 characters cut from the version text by offsets. */
  excerpt: string;
  /** Share of the query's content terms this passage contains. */
  coverage: number;
}
export interface PassageSearchResult {
  hits: PassageHit[];
  /** True when nothing in the materials supports the query: say "not in your materials". */
  notFound: boolean;
  /** The best coverage among the hits. */
  coverage: number;
  terms: string[];
}
export interface PassageText {
  passage: Passage;
  text: string;
  title: string;
  url: string;
}

// ---------- Course map ----------
export const assessmentKinds = [
  "exam", "midterm", "final", "quiz", "project", "paper", "lab", "homework", "presentation", "participation", "other",
] as const;
export const origins = ["canvas", "syllabus", "code", "jev", "pass", "student"] as const;
export const rungs = ["code", "jev", "pass", "student"] as const;
export const assessmentSchema = z
  .object({
    id: idText,
    sourceId: idText,
    /** Optional: an exam named only in the syllabus exists without a Canvas item. */
    resourceId: idText.nullable(),
    kind: z.enum(assessmentKinds),
    title: text(500),
    date: dateOrInstant.nullable(),
    /** Percent of the course grade, when stated. */
    weight: z.number().min(0).max(100).nullable(),
    format: z.string().max(200).nullable(),
    origin: z.enum(origins),
  })
  .strict();
export type AssessmentInput = z.infer<typeof assessmentSchema>;
export interface Assessment extends AssessmentInput {
  accountScope: string;
  courseId: string;
  updatedAt: string;
}
/** D33: the system settles a scope; a student correction wins and is never rewritten silently. */
export const scopeStatuses = ["provisional", "settled", "corrected", "flagged"] as const;
export const quoteRefSchema = z
  .object({
    resourceId: idText,
    version: z.number().int().positive(),
    quote: text(4000),
    start: offset.optional(),
    end: offset.optional(),
  })
  .strict();
export type QuoteRef = z.infer<typeof quoteRefSchema>;
export const assessmentScopeSchema = z
  .object({
    id: idText,
    assessmentId: idText,
    stated: text(4000),
    evidence: quoteRefSchema.nullable(),
    windowStart: dateOrInstant.nullable(),
    windowEnd: dateOrInstant.nullable(),
    status: z.enum(scopeStatuses),
    rung: z.enum(rungs),
  })
  .strict();
export type AssessmentScopeInput = z.infer<typeof assessmentScopeSchema>;
export interface AssessmentScope extends Omit<AssessmentScopeInput, "evidence"> {
  evidence: (QuoteRef & { start: number; end: number }) | null;
  updatedAt: string;
  correctedAt: string | null;
}
export const courseSessionSchema = z
  .object({
    id: idText,
    sourceId: idText,
    date: dateOrInstant.nullable(),
    ordinal: z.number().int().nonnegative().nullable(),
    title: text(500),
    topicIds: z.array(idText).max(200),
    origin: z.enum(origins),
  })
  .strict();
export type CourseSessionInput = z.infer<typeof courseSessionSchema>;
export interface CourseSession extends CourseSessionInput {
  accountScope: string;
  courseId: string;
}
export const mapLinkSchema = z
  .object({
    id: idText,
    sourceId: idText,
    fromKind: z.enum(["assessment", "assignment", "session"]),
    fromId: idText,
    toResourceId: idText,
    kind: z.enum(["covers", "practice", "reading", "recording", "related"]),
    tier: z.enum(["core", "supporting", "practice"]),
    reason: text(2000),
    rung: z.enum(rungs),
    status: z.enum(["proposed", "settled", "corrected", "rejected"]),
  })
  .strict();
export type MapLinkInput = z.infer<typeof mapLinkSchema>;
export interface MapLink extends MapLinkInput {
  accountScope: string;
  courseId: string;
  /** The target's text hash when written; the link is current while it matches. */
  inputHash: string;
  current: boolean;
  updatedAt: string;
}

// ---------- Inventory and access (D32, D40, D41) ----------
export const spaceRoutes = ["api", "public", "uw-session", "canvas-session", "own-login", "lti"] as const;
export const readStates = ["found", "read", "needs-signin", "blocked", "failed", "skipped"] as const;
export const accessStates = ["unknown", "readable", "needs-uw-signin", "needs-own-login", "link-only", "blocked"] as const;
export type AccessState = (typeof accessStates)[number];
export const courseSpaceSchema = z
  .object({
    id: idText,
    /** The inventory capture's source; the space cascades with it. */
    sourceId: idText,
    kind: text(100),
    host: text(300),
    url: z.url({ protocol: /^https?$/ }).max(4000),
    title: z.string().max(500).nullable(),
    foundInResourceId: idText.nullable(),
    route: z.enum(spaceRoutes),
    readState: z.enum(readStates),
    /** The source its reads land in (D35: "its place in the inventory"). */
    readSourceId: idText.nullable(),
    lastReadAt: instant.nullable(),
    recipeId: idText.nullable(),
    accessState: z.enum(accessStates),
    accessReason: z.string().max(1000).nullable(),
    checkedAt: instant.nullable(),
    /** D40: `link` is a click-to-open card; its content is never stored. */
    storeOrLink: z.enum(["store", "link"]),
  })
  .strict();
export type CourseSpaceInput = z.infer<typeof courseSpaceSchema>;
export interface CourseSpace extends CourseSpaceInput {
  accountScope: string;
  courseId: string;
}
/** One course's indicator chip (D41): counts by access state. */
export interface CourseAccessSummary {
  accountScope: string;
  courseId: string;
  total: number;
  readable: number;
  needsUwSignin: number;
  needsOwnLogin: number;
  linkOnly: number;
  blocked: number;
  /** Spaces that need the student (UW sign-in or their own login). */
  needsAttention: number;
  lastCheckedAt: string | null;
}
export const extractionRecipeSchema = z
  .object({
    id: idText,
    host: text(300),
    layoutHash: text(256),
    version: z.number().int().positive(),
    recipe: z.record(z.string(), z.unknown()),
    validatedAt: instant.nullable(),
  })
  .strict();
export type ExtractionRecipeInput = z.infer<typeof extractionRecipeSchema>;
export interface ExtractionRecipe extends ExtractionRecipeInput {
  hits: number;
  misses: number;
}

// ---------- Course brief (D34) and material facts (D35.1) ----------
const quoted = { quote: text(2000), start: offset, end: offset };
export const courseBriefBodySchema = z
  .object({
    schedule: z.array(z.object({ date: dateOrInstant.nullable(), title: text(500), ...quoted }).strict()).max(300),
    assessments: z
      .array(
        z
          .object({
            title: text(500),
            kind: z.enum(assessmentKinds),
            date: dateOrInstant.nullable(),
            weight: z.number().min(0).max(100).nullable(),
            scope: z.string().max(2000).nullable(),
            ...quoted,
          })
          .strict(),
      )
      .max(100),
    grading: z.array(z.object({ label: text(300), value: text(1000), ...quoted }).strict()).max(100),
    policies: z
      .array(
        z
          .object({
            kind: z.enum(["ai_use", "collaboration", "late_work", "attendance", "academic_integrity", "other"]),
            text: text(2000),
            ...quoted,
          })
          .strict(),
      )
      .max(100),
    texts: z.array(z.object({ title: text(500), ...quoted }).strict()).max(100),
    staff: z
      .array(
        z
          .object({ name: text(200), role: text(100), officeHours: z.string().max(500).nullable(), ...quoted })
          .strict(),
      )
      .max(50),
  })
  .strict();
export type CourseBriefBody = z.infer<typeof courseBriefBodySchema>;
export const courseBriefSchema = z
  .object({
    sourceId: idText,
    syllabusResourceId: idText,
    /** The syllabus text hash the brief was derived from; refused when no longer current. */
    textHash: text(256),
    passVersion: text(200),
    brief: courseBriefBodySchema,
    /** The byte-stable first block of every pack for the course; the store hashes it. */
    prefixText: z.string().min(1).max(40000),
    compileRunId: idText.nullable(),
  })
  .strict();
export type CourseBriefInput = z.infer<typeof courseBriefSchema>;
export interface CourseBrief extends CourseBriefInput {
  accountScope: string;
  courseId: string;
  version: number;
  prefixHash: string;
  createdAt: string;
}
export const materialFactKinds = [
  "term", "definition", "formula", "example", "code",
  // v9 (the material pipeline): code-first categorisation, each with its quote.
  "role", "module", "session", "date", "covers", "needs_judgment",
] as const;
/**
 * Where a fact's offsets point (v9). `text`: the resource's text. `title`: its title.
 * `structure`: a structured Canvas field (module name, content type, group); the offsets cut the
 * stored quote itself, which code read from that field.
 */
export const factBases = ["text", "title", "structure"] as const;
export type FactBasis = (typeof factBases)[number];
export const materialFactsSchema = z
  .object({
    resourceId: idText,
    textHash: text(256),
    analyzerVersion: text(200),
    facts: z
      .array(
        z
          .object({
            kind: z.enum(materialFactKinds),
            start: offset,
            end: offset,
            value: text(4000),
            basis: z.enum(factBases).optional(),
            /** Required for `structure`; stored for every basis so a reader needs no second read. */
            quote: z.string().min(1).max(2000).optional(),
          })
          .strict(),
      )
      .max(5000),
  })
  .strict();
export type MaterialFactsInput = z.infer<typeof materialFactsSchema>;
export interface MaterialFact {
  id: number;
  resourceId: string;
  textHash: string;
  kind: (typeof materialFactKinds)[number];
  start: number;
  end: number;
  value: string;
  analyzerVersion: string;
  basis: FactBasis;
  quote: string | null;
}

// ---------- AI runs, use and UI events ----------
const count = z.number().int().nonnegative();
export const ledgerEntrySchema = z
  .object({
    id: idText,
    pack: text(200),
    packVersion: text(100),
    tier: text(50),
    model: text(200),
    tokensIn: count,
    tokensCached: count,
    tokensOut: count,
    latencyMs: z.number().nonnegative(),
    checkFailures: count,
    escalated: z.boolean(),
    course: courseRefSchema.nullable(),
    createdAt: instant,
  })
  .strict();
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
export const compileRunSchema = z
  .object({
    id: idText,
    course: courseRefSchema,
    packVersion: text(100),
    model: text(200),
    tier: text(50),
    inputHash: text(256),
    tokens: count,
    latencyMs: z.number().nonnegative(),
    checkFailures: count,
    escalated: z.boolean(),
    createdAt: instant,
  })
  .strict();
export type CompileRun = z.infer<typeof compileRunSchema>;
export const uiEventSchema = z
  .object({
    kind: z.enum(["expand_all", "move_tier", "open", "confirm"]),
    subject: text(500),
    createdAt: instant,
  })
  .strict();
export type UiEvent = z.infer<typeof uiEventSchema>;
export const lifeItemSchema = z
  .object({
    id: idText,
    sourceId: idText,
    area: z.enum(["mail", "news", "events", "other"]),
    courseId: idText.nullable(),
    sender: z.string().max(300).nullable(),
    title: text(500),
    date: instant.nullable(),
    labels: z.array(text(100)).max(50),
    link: z.url({ protocol: /^https$/ }).max(4000),
    duplicateOf: idText.nullable(),
    /** B4: mail and news are gist + link; never a full body. */
    gist: z.string().max(600),
  })
  .strict();
export type LifeItem = z.infer<typeof lifeItemSchema>;

// ---------- The course graph (v9, the material pipeline) ----------
/** `covers`: a material whose covers fact names this assessment (quoted facts rank above structural ones). */
export const referenceStrengths = ["direct", "named", "module", "syllabus", "covers"] as const;
export type ReferenceStrength = (typeof referenceStrengths)[number];
export const referenceKinds = [
  "page", "file", "assignment", "quiz", "discussion", "module", "syllabus", "announcement", "external", "unresolved",
] as const;
export type ReferenceKind = (typeof referenceKinds)[number];
/** Host classes (the space host table's kinds, plus `canvas` and `other`). */
export const externalTreatments = ["store", "link"] as const;
export const externalRefSchema = z
  .object({
    sourceId: idText,
    /** Origin plus path; query and fragment dropped, so one record per page. */
    url: z.url({ protocol: /^https?$/ }).max(4000),
    title: z.string().max(500).nullable(),
    hostClass: text(100),
    treatment: z.enum(externalTreatments),
    foundInResourceId: idText.nullable(),
  })
  .strict();
export type ExternalRefInput = z.infer<typeof externalRefSchema>;
export interface ExternalRef extends ExternalRefInput {
  id: string;
  accountScope: string;
  courseId: string;
  host: string;
  firstSeen: string;
  lastSeen: string;
  /**
   * Read at query time from sync's persisted `course_spaces` (same course and URL), never stored
   * here: the space's ID and its observed access state. Null when sync hasn't recorded the URL.
   */
  spaceId: string | null;
  accessState: AccessState | null;
}
/** One outgoing reference in a resource's body: a link, or a course file or page named in it. */
export const resourceRefSchema = z
  .object({
    toResourceId: idText.nullable(),
    externalRefId: idText.nullable(),
    /** The normalised URL, or the name as written. */
    target: text(4000),
    kind: z.enum(referenceKinds),
    strength: z.enum(["direct", "named"]),
    reason: text(500),
  })
  .strict();
export type ResourceRefInput = z.infer<typeof resourceRefSchema>;
export interface ResourceRef extends ResourceRefInput {
  fromResourceId: string;
  ord: number;
  /** The source resource's content hash when written; current while it matches. */
  inputHash: string;
}
export interface GraphCounts {
  resourceId: string;
  passages: number;
  facts: number;
  refs: number;
}

export type WriteResult = { ok: true } | { ok: false; errors: string[] };
export type ChangeWithSeq = ResourceChange & { seq: number };

/** Store methods added by schema v6/v7 (implemented in packages/storage). */
export interface CourseCoreStore {
  /** `kinds` limits the lease to those kinds; each subject kind has its own staleness rule. */
  lease(now: string, leaseMs: number, kinds?: readonly string[]): CourseJob | undefined;
  /**
   * owner: course-facts. Extends a running job's lease to `now + leaseMs` while the holder still owns
   * it (same token, not yet expired). Returns the new lease end, or false when the lease was lost.
   */
  renewLease?(job: Pick<CourseJob, "id" | "leaseToken">, now: string, leaseMs: number): string | false;
  enqueueSubject(job: SubjectJobInput, now: string): boolean;

  passages(resourceId: string): Passage[];
  passage(pid: number): PassageText | undefined;
  /** Re-split a live resource's current version (the passages job). Returns the passage count. */
  rebuildPassages(resourceId: string): number;
  searchPassages(input: PassageSearchInput): PassageSearchResult;

  putAssessment(value: AssessmentInput, at: string): void;
  assessments(course?: CourseRef): Assessment[];
  /** A quote must validate against the named resource version; a student correction wins. */
  putAssessmentScope(value: AssessmentScopeInput, at: string): WriteResult;
  assessmentScopes(assessmentId: string): AssessmentScope[];
  putCourseSession(value: CourseSessionInput): void;
  courseSessions(course?: CourseRef): CourseSession[];
  putMapLink(value: MapLinkInput, at: string): WriteResult;
  mapLinks(course?: CourseRef): MapLink[];

  putCourseSpace(value: CourseSpaceInput): void;
  courseSpaces(course?: CourseRef): CourseSpace[];
  courseAccessSummary(): CourseAccessSummary[];
  putExtractionRecipe(value: ExtractionRecipeInput): void;
  extractionRecipe(host: string, layoutHash: string): ExtractionRecipe | undefined;
  recordRecipeUse(id: string, hit: boolean): void;

  /** Every quote is checked against the syllabus version; refused when its text hash is stale. */
  putCourseBrief(value: CourseBriefInput, at: string): WriteResult;
  courseBrief(course: CourseRef): CourseBrief | undefined;
  /** Replaces the resource's facts for that analyzer version; offsets checked against the text. */
  putMaterialFacts(value: MaterialFactsInput): WriteResult;
  materialFacts(resourceId: string): MaterialFact[];
  /** The course's live resources the material pipeline classified with the role `syllabus` (current text only). */
  syllabusRoleIds(course: CourseRef): string[];

  addLedgerEntry(value: LedgerEntry): void;
  ledger(limit?: number): LedgerEntry[];
  addCompileRun(value: CompileRun): void;
  compileRuns(course?: CourseRef): CompileRun[];
  addUiEvent(value: UiEvent): void;
  uiEvents(limit?: number): (UiEvent & { id: number })[];
  putLifeItem(value: LifeItem): void;
  lifeItems(area?: LifeItem["area"]): LifeItem[];

  /** The change feed by a stored monotonic counter (never the implicit rowid). */
  changesAfter(seq: number, limit?: number): ChangeWithSeq[];
  /** The pre-migration backup kept beside the database, if any (purge deletes it). */
  migrationBackup(): string | null;
}

/** Store methods added by schema v9 (the material pipeline; implemented in packages/storage). */
export interface GraphStore {
  /** A source's live resources, decoded (the save hook reads one source, not the workspace). */
  sourceResources(sourceId: string): Resource[];
  /** A course's live resources with their source's scope (`module-items:<id>`, `page:<hash>`...). */
  courseResources(course: CourseRef): (Resource & { scope: string })[];
  /** A hash over the course's live resource IDs and content hashes; changes on any change. */
  courseInventoryHash(course: CourseRef): string;
  /** The live resource's current text hash (the key material facts are checked against). */
  resourceTextHash(resourceId: string): string | undefined;
  /** Replaces the resource's outgoing references; refused when its content hash is stale. */
  putResourceRefs(fromResourceId: string, inputHash: string, refs: ResourceRefInput[]): WriteResult;
  /** Current references (the source's content hash still matches). */
  resourceRefs(fromResourceId: string): ResourceRef[];
  /** Upserts by (course, url): first seen is kept, last seen and title move forward. */
  putExternalRef(value: ExternalRefInput, at: string): string;
  externalRefs(course: CourseRef): ExternalRef[];
  /** Current `covers` facts whose value is one of these assessment resource IDs (live materials only). */
  coveringFacts(assessmentIds: readonly string[]): MaterialFact[];
  /** Per live resource of the course: passage, current fact and current reference counts. */
  graphCounts(course: CourseRef): GraphCounts[];
}

// ---------- Graph queries (the material pipeline): reads only, over IPC as `magic:graph` ----------
export interface Reference {
  resourceId: string | null;
  externalUrl: string | null;
  kind: ReferenceKind;
  title: string;
  reason: string;
  strength: ReferenceStrength;
  weight: number;
}
export type AgendaGroup = "overdue" | "today" | "week" | "later";
export interface AgendaEntry {
  key: string;
  kind: "assignment" | "quiz" | "exam" | "event" | "class";
  title: string;
  accountScope: string;
  courseId: string;
  courseName: string;
  /** ISO instant; an all-day item is placed at its local midnight. */
  at: string;
  allDay: boolean;
  dateKind: "due" | "closes" | "starts";
  group: AgendaGroup;
  /** The source scope the date came from (the most authoritative copy with a date). */
  authority: string;
  resourceIds: string[];
  submitted: boolean | null;
  references: Reference[];
}
export interface Agenda {
  date: string;
  tz: string;
  from: string;
  to: string;
  entries: AgendaEntry[];
  groups: Record<AgendaGroup, AgendaEntry[]>;
}
export interface CourseGraph {
  course: CourseRef;
  modules: {
    id: string;
    title: string;
    position: number;
    items: { itemId: string; title: string; type: string; resourceId: string | null; externalUrl: string | null; passages: number; role: string | null }[];
  }[];
  resources: { total: number; materials: number; withText: number; passages: number; byType: Record<string, number> };
  assessments: { resourceId: string; title: string; type: string; dueAt: string | null; role: string | null }[];
  references: { direct: number; named: number; external: number; unresolved: number; externalRecords: number };
  coverage: {
    /** Materials with text but no passage of their current version. */
    withoutPassages: string[];
    /** Materials without a role fact (not yet analysed, or left for judgment). */
    withoutRole: string[];
    needsJudgment: string[];
    assignmentsWithoutReferences: string[];
    unresolvedLinks: { fromResourceId: string; target: string; kind: string }[];
  };
}
export const graphQuerySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("references"), assignmentId: idText }).strict(),
  z
    .object({
      type: z.literal("agenda"),
      date: z.iso.date(),
      tz: z.string().min(1).max(100).refine((tz) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, "Unknown time zone."),
      days: z.number().int().min(1).max(60).optional(),
    })
    .strict(),
  z.object({ type: z.literal("courseGraph"), accountScope: idText, courseId: idText }).strict(),
]);
export type GraphQuery = z.infer<typeof graphQuerySchema>;
export type GraphResult<Q extends GraphQuery = GraphQuery> = Q extends { type: "references" }
  ? Reference[]
  : Q extends { type: "agenda" }
    ? Agenda
    : Q extends { type: "courseGraph" }
      ? CourseGraph
      : never;
