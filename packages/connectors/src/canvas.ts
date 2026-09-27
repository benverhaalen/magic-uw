import { z } from "zod";
import {
  captureBatchSchema,
  resourceInputSchema,
  type CaptureBatch,
  type CaptureDiagnostic,
  type Connector,
  type Resource,
  type ResourceInput,
  type AutoIdentityUpdate,
} from "@magic/contracts";
import {
  CanvasHttp,
  CanvasFailure,
  canvasNextPage,
  type CanvasHttpOptions,
  type CanvasScopeStats,
} from "./canvas-http";
import { readCanvasModules, createCanvasModuleRun, type CanvasModuleRun } from "./canvas-modules";
import { canvasContent } from "./canvas-content";
import {
  courseSelection,
  type CanvasSelectionOptions,
} from "./canvas-selection";
import {
  canvasId,
  courseSchema,
  canvasSubmissionSchema,
  submissionEvidence,
  assignmentSchema,
  pageSchema,
  fileSchema,
  folderSchema,
  groupSchema,
  quizSchema,
  discussionSchema,
  activitySchema,
  todoSchema,
  summarySchema,
  hashCanvas,
  courseName,
  courseResource,
  assignmentResource,
  moduleResource,
  itemResource,
  pageResource,
  fileResource,
  folderResource,
  groupResource,
  quizResource,
  discussionResource,
  discussionAuthor,
  profileSchema,
  profileIdentity,
  activityResource,
  type CanvasCourse,
} from "./canvas-models";
export { courseSelection, parseAcademicTerm } from "./canvas-selection";
export type { CanvasCourseOverride } from "./canvas-selection";
export type { CanvasRate } from "./canvas-http";
export interface CanvasProgress {
  accountScope: string;
  courseId: string;
  scope: string;
  status: CaptureBatch["status"];
  complete: boolean;
  records: number;
  durationMs: number;
}
export interface CanvasConnectorOptions
  extends CanvasHttpOptions, CanvasSelectionOptions {
  now?: () => Date;
  collectComments?: boolean;
  scopeTimeoutMs?: number;
  knownResources?: Resource[];
  onProgress?: (progress: CanvasProgress) => void;
  /** Only the encrypted vault receives this transient capability. Never persist it with coursework. */
  onCalendarFeed?: (feed: {
    accountScope: string;
    courseId: string;
    url: string;
  }) => void | Promise<void>;
  /**
   * Local scrubbing roster only: the student's own profile identity and
   * non-teacher topic/announcement authors. Never put into capture batches.
   */
  onIdentity?: (update: AutoIdentityUpdate) => void | Promise<void>;
  /** Earliest announcement window; defaults to all available historical announcements. */
  announcementsStartDate?: string;
  /** owner: T33. A warm read: only these courses get per-course reads (D37); the account reads still run. */
  onlyCourses?: string[];
  moduleRun?: CanvasModuleRun;
  onModuleRun?: (run: CanvasModuleRun) => void;
  /**
   * fix/current-courses-only. Discovery: the profile and the course lists only, so the student
   * can choose courses before the first full read. No account lists, no course content.
   */
  catalogOnly?: boolean;
}
/**
 * Canvas returns a course the student can no longer open as `{id, access_restricted_by_date:
 * true}` only (lib/api/v1/course.rb course_json), so it has no name, term or dates: it is never
 * stored or shown as a course (fix/current-courses-only).
 */
function nameless(course: CanvasCourse): boolean {
  return !!course.access_restricted_by_date && !course.name?.trim();
}
// owner: T17. Scheduler order: essentials (0), then pages (1), then the background lists (2).
const BACKGROUND_SCOPES = new Set([
  "details",
  "submissions",
  "files",
  "folders",
  "assignment-groups",
  "quizzes",
  "discussions",
]);
function scopePriority(scope: string): number {
  if (scope === "pages" || scope.startsWith("page:")) return 1;
  return BACKGROUND_SCOPES.has(scope) ? 2 : 0;
}
function failure(error: unknown, hasRecords = false): CaptureBatch["status"] {
  if (error instanceof CanvasFailure) return error.status;
  if (error instanceof z.ZodError) return "partial";
  return hasRecords ? "partial" : "error";
}
const MAX_PAGES = 20,
  MAX_RECORDS = 2000;
function diagnostic(error: unknown): CaptureDiagnostic[] {
  if (error instanceof z.ZodError)
    return error.issues.map((issue) => ({
      code: "invalid_field",
      path: issue.path.map((v) =>
        typeof v === "number" ? String(v) : String(v).slice(0, 100),
      ),
      severity: "error" as const,
    }));
  return [
    {
      code: error instanceof CanvasFailure ? error.code : "request_failed",
      path: [],
      severity: "error",
    },
  ];
}
async function pool<T>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        await operation(items[index]!);
      }
    }),
  );
}
/** The scheduler's probe reads only the documented activity summary, with the same session boundary. */
export async function fetchCanvasActivitySummary(
  options: CanvasHttpOptions,
  signal?: AbortSignal,
): Promise<{
  status: CaptureBatch["status"];
  hash?: string;
  stats: {
    requests: number;
    rateLimitRemaining?: number;
    requestCost?: number;
  };
}> {
  const http = new CanvasHttp(options);
  const items: z.infer<typeof summarySchema>[] = [];
  let url: string | null =
    `${http.origin}/api/v1/users/self/activity_stream/summary?per_page=100&only_active_courses=true`;
  const initial = url,
    seen = new Set<string>();
  try {
    for (let page = 0; url && page < MAX_PAGES; page++) {
      if (seen.has(url)) throw new CanvasFailure("partial", "pagination_cycle");
      seen.add(url);
      const response = await http.request(url, signal);
      items.push(
        ...z.array(summarySchema).max(MAX_RECORDS).parse(response.data),
      );
      if (items.length > MAX_RECORDS)
        throw new CanvasFailure("partial", "record_limit");
      url = canvasNextPage(response.link, url, initial, http.origin);
    }
    if (url) throw new CanvasFailure("partial", "page_limit");
    return {
      status: "ok",
      hash: hashCanvas(
        JSON.stringify(items.sort((a, b) => a.type.localeCompare(b.type))),
      ),
      stats: {
        requests: http.rate.requests,
        rateLimitRemaining: http.rate.remaining,
        requestCost: http.rate.cost,
      },
    };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      status: failure(error),
      stats: {
        requests: http.rate.requests,
        rateLimitRemaining: http.rate.remaining,
        requestCost: http.rate.cost,
      },
    };
  }
}
/** Each scope is independent. Streamed pages remain partial until that entire scope has finished. */
export function canvasConnector(options: CanvasConnectorOptions): Connector {
  const now = options.now ?? (() => new Date());
  return {
    id: "canvas",
    async *pull(signal) {
      signal?.throwIfAborted();
      const stop = new AbortController(),
        combined = AbortSignal.any([stop.signal, ...(signal ? [signal] : [])]);
      const http = new CanvasHttp(options),
        origin = http.origin,
        connectionHash = hashCanvas(origin).slice(0, 24);
      let accountScope = `connection:${connectionHash}`;
      let fatal: unknown,
        done = false,
        wake: (() => void) | undefined;
      const queue: CaptureBatch[] = [];
      const observationTimes = new Map<string, number>();
      const selection = () => ({
        accountScope,
        courseOverrides: options.courseOverrides,
        selectedTerm: options.selectedTerm,
        currentTime: now(),
        enrolledThisTerm: options.enrolledThisTerm,
        enrollmentAuthoritative: options.enrollmentAuthoritative,
      });
      function source(
        courseId: string,
        name: string,
        scope: string,
      ): CaptureBatch["source"] {
        return {
          id:
            scope === "connection"
              ? `canvas:${connectionHash}:status`
              : `canvas:${accountScope}:${courseId}:${scope}`,
          label: `${name.slice(0, 145)} · ${scope}`.slice(0, 200),
          kind: "canvas",
          accountScope:
            scope === "connection"
              ? `connection:${connectionHash}`
              : accountScope,
          courseId,
          scope,
        };
      }
      function emit(
        courseId: string,
        name: string,
        scope: string,
        resources: ResourceInput[],
        status: CaptureBatch["status"],
        complete: boolean,
        diagnostics: CaptureDiagnostic[] = [],
        started = performance.now(),
        pages = 0,
        requests = 0,
        recordCount = resources.length,
      ) {
        const durationMs = Math.max(0, performance.now() - started);
        const batchSource = source(courseId, name, scope);
        const observedMs = Math.max(
          now().getTime(),
          (observationTimes.get(batchSource.id) ?? -Infinity) + 1,
        );
        observationTimes.set(batchSource.id, observedMs);
        const value = captureBatchSchema.parse({
          source: batchSource,
          observedAt: new Date(observedMs).toISOString(),
          resources: [...resources],
          status,
          complete,
          diagnostics: diagnostics.slice(0, 2000),
          stats: {
            durationMs,
            pages,
            records: recordCount,
            requests,
            rateLimitRemaining: http.rate.remaining,
            requestCost: http.rate.cost,
          },
          progress: {
            phase: complete
              ? "complete"
              : status === "partial"
                ? "reading"
                : status,
            completed: recordCount,
          },
        });
        queue.push(value);
        wake?.();
        wake = undefined;
        options.onProgress?.({
          accountScope,
          courseId,
          scope,
          status,
          complete,
          records: recordCount,
          durationMs,
        });
      }
      async function collect<T>(
        course: CanvasCourse,
        scope: string,
        url: string,
        schema: z.ZodType<T>,
        map?: (item: T) => ResourceInput | null,
        single = false,
        // owner: T17. Scheduler priority (0 first); `records`: a page already read inline.
        read: { priority?: number; records?: unknown[] } = {},
      ): Promise<{
        items: T[];
        resources: ResourceInput[];
        complete: boolean;
        status: CaptureBatch["status"];
      }> {
        // The scope's own time budget starts when its first request holds a scheduler slot, not
        // while it queues behind other scopes (a course's page wave starts every page at once).
        const budget = new AbortController(),
          scopeSignal = AbortSignal.any([combined, budget.signal]);
        let budgetTimer: ReturnType<typeof setTimeout> | undefined;
        const items: T[] = [],
          resources: ResourceInput[] = [],
          diagnostics: CaptureDiagnostic[] = [];
        const seenUrls = new Set<string>(),
          seenIds = new Set<string>(),
          started = performance.now(),
          initial = url,
          requestStats: CanvasScopeStats = {
            requests: 0,
            onStart: () => {
              budgetTimer ??= setTimeout(
                () =>
                  budget.abort(
                    new DOMException("Scope time limit reached", "TimeoutError"),
                  ),
                options.scopeTimeoutMs ?? 120_000,
              );
            },
          };
        let next: string | null = url,
          pages = 0,
          status: CaptureBatch["status"] = "ok",
          invalid = false;
        try {
          while (next && pages < MAX_PAGES) {
            if (seenUrls.has(next))
              throw new CanvasFailure("partial", "pagination_cycle");
            seenUrls.add(next);
            // owner: T17. Inline records (modules' items) arrive with their list: no request.
            const inline = pages === 0 ? read.records : undefined;
            const response: { data: unknown; link: string | null } = inline
              ? { data: inline, link: null }
              : await http.request(
                  next,
                  scopeSignal,
                  requestStats,
                  read.priority ?? scopePriority(scope),
                );
            pages++;
            if (!single && !Array.isArray(response.data))
              throw new CanvasFailure("partial", "expected_array");
            const records: unknown[] = single
              ? [response.data]
              : (response.data as unknown[]);
            if (
              records.length > MAX_RECORDS ||
              items.length + records.length > MAX_RECORDS
            )
              throw new CanvasFailure("partial", "record_limit");
            for (let index = 0; index < records.length; index++) {
              try {
                const item = schema.parse(records[index]);
                const row = map?.(item);
                const record = item as Record<string, unknown>;
                const nestedAssignment = record.assignment as
                    Record<string, unknown> | undefined,
                  nestedQuiz = record.quiz as
                    Record<string, unknown> | undefined;
                const identity =
                  row?.externalId ??
                  String(
                    record.id ??
                      record.page_id ??
                      record.assignment_id ??
                      nestedAssignment?.id ??
                      nestedQuiz?.id ??
                      record.type ??
                      index,
                  );
                if (seenIds.has(identity))
                  throw new CanvasFailure("partial", "duplicate_identity");
                seenIds.add(identity);
                items.push(item);
                if (row) resources.push(row);
                if (
                  schema instanceof z.ZodObject &&
                  records[index] &&
                  typeof records[index] === "object"
                ) {
                  const fields = Object.keys(
                      records[index] as Record<string, unknown>,
                    ),
                    expected = Object.keys(schema.shape);
                  const unexpected = fields.filter(
                    (field) => !expected.includes(field),
                  ).length;
                  if (unexpected > 32 && unexpected / fields.length > 0.85) {
                    invalid = true;
                    diagnostics.push({
                      code: "many_unexpected_fields",
                      path: [String(index)],
                      severity: "warning",
                    });
                  }
                }
                const open = item as Record<string, unknown>,
                  submission = open.submission as
                    Record<string, unknown> | null | undefined;
                if (
                  submission?.workflow_state &&
                  ![
                    "submitted",
                    "unsubmitted",
                    "graded",
                    "pending_review",
                  ].includes(String(submission.workflow_state))
                )
                  diagnostics.push({
                    code: "unknown_submission_state",
                    path: ["submission", "workflow_state"],
                    severity: "warning",
                  });
                if (
                  open.workflow_state &&
                  ![
                    "available",
                    "unpublished",
                    "completed",
                    "deleted",
                    "published",
                    "unpublished",
                    "active",
                    "unlocked",
                    "locked",
                    "started",
                  ].includes(String(open.workflow_state))
                )
                  diagnostics.push({
                    code: "unknown_workflow_state",
                    path: ["workflow_state"],
                    severity: "warning",
                  });
              } catch (error) {
                invalid = true;
                diagnostics.push(
                  ...diagnostic(error).map((d) => ({
                    ...d,
                    path: [String((pages - 1) * 100 + index), ...d.path],
                  })),
                );
              }
            }
            next = single
              ? null
              : canvasNextPage(response.link, next, initial, origin);
            if (next)
              emit(
                course.id,
                courseName(course),
                scope,
                resources,
                "partial",
                false,
                diagnostics,
                started,
                pages,
                requestStats.requests,
                items.length,
              );
          }
          if (next) throw new CanvasFailure("partial", "page_limit");
          if (invalid) status = "partial";
        } catch (error) {
          if (combined.aborted) {
            // The run stopped before this scope reached the network: not read yet, not failed.
            if (budgetTimer === undefined && pages === 0)
              emit(course.id, courseName(course), scope, [], "partial", false,
                [{ code: "scope_deferred", path: [], severity: "warning" }], started);
            combined.throwIfAborted();
          }
          status = budget.signal.aborted
            ? "partial"
            : failure(error, resources.length > 0);
          diagnostics.push(
            ...(budget.signal.aborted
              ? [
                  {
                    code: "scope_time_limit",
                    path: [],
                    severity: "error" as const,
                  },
                ]
              : diagnostic(error)),
          );
        } finally {
          clearTimeout(budgetTimer);
        }
        const complete = status === "ok";
        emit(
          course.id,
          courseName(course),
          scope,
          resources,
          status,
          complete,
          diagnostics,
          started,
          pages,
          requestStats.requests,
          items.length,
        );
        return { items, resources, complete, status };
      }
      function syllabus(course: CanvasCourse) {
        if (course.syllabus_body === undefined) {
          emit(
            course.id,
            courseName(course),
            "syllabus",
            [],
            "partial",
            false,
            [{ code: "missing_field", path: ["syllabus_body"] }],
          );
          return;
        }
        try {
          const content = canvasContent(
            course.syllabus_body ?? "",
            `${origin}/courses/${course.id}/assignments/syllabus`,
          );
          const resources =
            content.text || content.links.length
              ? [
                  resourceInputSchema.parse({
                    externalId: "syllabus",
                    kind: "material",
                    courseId: course.id,
                    courseName: courseName(course),
                    title: "Syllabus",
                    url: `${origin}/courses/${course.id}/assignments/syllabus`,
                    ...content,
                  }),
                ]
              : [];
          emit(
            course.id,
            courseName(course),
            "syllabus",
            resources,
            "ok",
            true,
          );
          return resources;
        } catch (error) {
          emit(
            course.id,
            courseName(course),
            "syllabus",
            [],
            failure(error),
            false,
            diagnostic(error),
          );
        }
      }
      async function calendar(course: CanvasCourse) {
        const candidate = course.calendar?.ics;
        if (!candidate) {
          emit(
            course.id,
            courseName(course),
            "calendar-discovery",
            [],
            "inaccessible",
            false,
            [
              {
                code: "calendar_feed_unavailable",
                path: ["calendar", "ics"],
                severity: "warning",
              },
            ],
          );
          return;
        }
        if (!options.onCalendarFeed) {
          emit(
            course.id,
            courseName(course),
            "calendar-discovery",
            [],
            "partial",
            false,
            [
              {
                code: "calendar_secret_store_unconfigured",
                path: [],
                severity: "warning",
              },
            ],
          );
          return;
        }
        let valid = false;
        try {
          const url = new URL(candidate);
          valid =
            url.origin === origin &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            /^\/feeds\/calendars\/[A-Za-z0-9_-]+\.ics$/.test(url.pathname);
        } catch {}
        if (!valid) {
          emit(
            course.id,
            courseName(course),
            "calendar-discovery",
            [],
            "partial",
            false,
            [
              {
                code: "invalid_calendar_capability",
                path: ["calendar", "ics"],
              },
            ],
          );
          return;
        }
        try {
          await options.onCalendarFeed({
            accountScope,
            courseId: course.id,
            url: candidate,
          });
          emit(
            course.id,
            courseName(course),
            "calendar-discovery",
            [],
            "ok",
            true,
          );
        } catch {
          emit(
            course.id,
            courseName(course),
            "calendar-discovery",
            [],
            "error",
            false,
            [{ code: "calendar_secret_storage_failed", path: [] }],
          );
        }
      }
      async function reportIdentity(update: AutoIdentityUpdate) {
        if (combined.aborted) return;
        // Scrubbing-roster failures must not break coursework sync.
        try {
          await options.onIdentity?.(update);
        } catch {}
      }
      function noteAuthor(course: CanvasCourse, item: z.infer<typeof discussionSchema>): undefined {
        const author = discussionAuthor(item, course);
        if (author && options.onIdentity)
          void reportIdentity({ accountScope, courseId: course.id, authors: [author] });
        return undefined;
      }
      async function work() {
        const accountUrl = (path: string) =>
            `${origin}/api/v1/users/self/${path}?per_page=100${path.startsWith("activity_stream") ? "&only_active_courses=true" : ""}`,
          catalogUrl = `${origin}/api/v1/courses?enrollment_state=active&per_page=100&include[]=syllabus_body&include[]=term&include[]=teachers&include[]=total_scores&include[]=concluded`,
          historicalUrl = `${origin}/api/v1/courses?enrollment_state=completed&state[]=available&state[]=completed&per_page=100&include[]=term&include[]=total_scores&include[]=concluded`;
        let profile: z.infer<typeof profileSchema>;
        try {
          profile = profileSchema
            .parse(
              (
                await http.request(
                  `${origin}/api/v1/users/self/profile`,
                  combined, undefined, 0, { fresh: true },
                )
              ).data,
            );
        } catch (error) {
          combined.throwIfAborted();
          emit(
            "connection",
            "Canvas connection",
            "connection",
            [],
            failure(error),
            false,
            diagnostic(error),
          );
          return;
        }
        accountScope = hashCanvas(`${origin}\n${profile.id}`);
        const self = profileIdentity(profile);
        if (self) await reportIdentity({ accountScope, self });
        combined.throwIfAborted();
        const moduleRun = options.moduleRun?.accountScope === accountScope && !options.moduleRun.invalidated
          ? options.moduleRun : createCanvasModuleRun(accountScope);
        options.onModuleRun?.(moduleRun);
        const account: CanvasCourse = { id: "account", name: "Canvas account" };
        const accountJobs = [
          { scope: "todo", schema: todoSchema, path: "todo" },
          {
            scope: "upcoming-events",
            schema: activitySchema,
            path: "upcoming_events",
          },
          {
            scope: "activity",
            schema: activitySchema,
            path: "activity_stream",
          },
          {
            scope: "activity-summary",
            schema: summarySchema,
            path: "activity_stream/summary",
          },
        // fix/current-courses-only: discovery reads the course lists and nothing else.
        ].filter(() => !options.catalogOnly);
        const accountReads = accountJobs.map((job) => ({
          job,
          promise: collect(
            account,
            job.scope,
            accountUrl(job.path),
            job.schema as z.ZodType<Record<string, unknown>>,
            job.scope === "activity-summary"
              ? (item) =>
                  resourceInputSchema.parse({
                    externalId: String(item.type),
                    kind: "material",
                    courseId: "account",
                    courseName: "Canvas account",
                    title: `Activity summary: ${String(item.type)}`,
                    url: `${origin}/`,
                    text: JSON.stringify(item),
                  })
              : undefined,
          ),
        }));
        const accountSettled = Promise.allSettled(
          accountReads.map((read) => read.promise),
        );
        const catalogRead = collect(
          account,
          "courses",
          catalogUrl,
          courseSchema,
        );
        // Past-course discovery is a metadata read only. It does not delay the
        // active learning path or start a deep crawl of concluded coursework.
        const historicalRead = collect(
          account,
          "courses-completed",
          historicalUrl,
          courseSchema,
        );
        const historicalSettled = Promise.allSettled([historicalRead]);
        const catalog = await catalogRead;
        emit(
          "connection",
          "Canvas connection",
          "connection",
          [],
          catalog.status === "ok" ? "partial" : catalog.status,
          false,
        );
        for (const course of catalog.items) {
          if (nameless(course)) continue;
          const restricted =
            course.access_restricted_by_date ||
            course.workflow_state === "unpublished";
          emit(
            course.id,
            courseName(course),
            "course",
            [courseResource(course, origin, selection(), profile.id)],
            restricted
              ? course.workflow_state === "unpublished"
                ? "not_published"
                : "inaccessible"
              : "ok",
            !restricted,
          );
        }
        const reconcileCatalog = historicalRead.then((historical) => {
          combined.throwIfAborted();
          // A course can appear in both date-aware lists. Prefer the active row;
          // never replace its enrollment or grade claims with a historical copy.
          const listed = new Set(catalog.items.map((course) => course.id));
          for (const raw of historical.items) {
            if (listed.has(raw.id)) continue;
            listed.add(raw.id);
            if (nameless(raw)) continue;
            const course: CanvasCourse = { ...raw, historicalOnly: true };
            const restricted = course.access_restricted_by_date || course.workflow_state === "unpublished";
            emit(course.id, courseName(course), "course",
              [courseResource(course, origin, selection(), profile.id)],
              restricted ? course.workflow_state === "unpublished" ? "not_published" : "inaccessible" : "ok",
              !restricted,
              [{ code: "historical_course_metadata_only", path: [], severity: "warning" }]);
          }
          const complete = catalog.complete && historical.complete;
          emit("connection", "Canvas connection", "connection", [],
            complete ? "ok" : catalog.status === "needs_sign_in" || historical.status === "needs_sign_in" ? "needs_sign_in" : "partial",
            complete,
            [{ code: "active_and_completed_course_inventory", path: [], severity: "warning" }],
            performance.now(), 0, 0, listed.size);
          // Absence is evidence only after BOTH date-aware lists finish. These
          // lists cover accessible active/completed enrollments, not a transcript.
          // Failure of either query must retain all previously known coursework.
          if (!complete) return;
          for (const known of options.knownResources ?? []) {
            if (
              known.kind !== "course" ||
              known.deleted ||
              listed.has(known.courseId) ||
              known.sourceId !==
                source(known.courseId, known.courseName, "course").id
            )
              continue;
            const retained = resourceInputSchema.parse(
              Object.fromEntries(
                Object.entries(known).filter(
                  ([key]) => key in resourceInputSchema.shape,
                ),
              ),
            );
            retained.course = {
              ...retained.course,
              selection: {
                score: retained.course?.selection?.score ?? 0,
                included: false,
                reasons: ["No longer returned in the active or completed enrollment lists"],
                override: retained.course?.selection?.override,
              },
            };
            emit(
              known.courseId,
              known.courseName,
              "course",
              [retained],
              "inaccessible",
              false,
              [
                {
                  code: "absent_from_active_course_catalog",
                  path: [],
                  severity: "warning",
                },
              ],
            );
          }
        });
        const reconciled = Promise.allSettled([reconcileCatalog]);
        if (http.needsSignIn || options.catalogOnly) {
          await Promise.all([accountSettled, historicalSettled, reconciled]);
          return;
        }
        const courses = catalog.items.filter(
            (course) =>
              courseSelection(course, selection()).included &&
              (!options.onlyCourses || options.onlyCourses.includes(course.id)), // owner: T33
          ),
          byId = new Map(courses.map((c) => [c.id, c]));
        await pool(accountReads, http.concurrency, async ({ job, promise }) => {
          const rows = await promise;
          if (job.scope === "activity-summary") return;
          for (const course of courses) {
            const resources: ResourceInput[] = [],
              diagnostics: CaptureDiagnostic[] = [];
            for (const row of rows.items) {
              const assignment = row.assignment as
                z.infer<typeof assignmentSchema> | undefined;
              const id = String(
                row.course_id ??
                  assignment?.course_id ??
                  String(row.context_code ?? "").replace(/^course_/, ""),
              );
              if (id !== course.id || !byId.has(id)) continue;
              try {
                const resource = assignment
                  ? assignmentResource(
                      assignment,
                      course,
                      origin,
                      options.collectComments !== false,
                    )
                  : row.quiz
                    ? quizResource(
                        row.quiz as z.infer<typeof quizSchema>,
                        course,
                        origin,
                      )
                    : activityResource(
                        row as z.infer<typeof activitySchema>,
                        course,
                        origin,
                      );
                if (
                  !resources.some((r) => r.externalId === resource.externalId)
                )
                  resources.push(resource);
              } catch (error) {
                diagnostics.push(...diagnostic(error));
              }
            }
            emit(
              course.id,
              courseName(course),
              `account-${job.scope}`,
              resources,
              diagnostics.length ? "partial" : rows.status,
              rows.complete && !diagnostics.length,
              diagnostics,
            );
          }
        });
        const references = new Map<string, Map<string, boolean>>();
        function gather(course: CanvasCourse, resources: ResourceInput[]) {
          let refs = references.get(course.id);
          if (!refs) references.set(course.id, (refs = new Map()));
          for (const row of resources) {
            const soon = row.deadlines.some(
              (d) =>
                d.kind === "due" &&
                Date.parse(d.value) >= now().getTime() - 7 * 86400_000 &&
                Date.parse(d.value) <= now().getTime() + 14 * 86400_000,
            );
            for (const link of row.links ?? []) {
              let url: URL;
              try { url = new URL(typeof link === "string" ? link : link.url); } catch { continue; }
              const match = url.pathname.match(
                new RegExp(`^/courses/${course.id}/pages/([^/]+)$`),
              );
              if (url.origin === origin && match) {
                let slug: string;
                try { slug = decodeURIComponent(match[1]!); } catch { continue; }
                if (/^[a-zA-Z0-9_%.-]{1,256}$/.test(slug) && (refs.has(slug) || refs.size < 2000))
                  refs.set(slug, (refs.get(slug) ?? false) || soon);
              }
            }
          }
        }
        // Per-course essentials run concurrently; the HTTP scheduler prioritizes them over bodies
        // and background lists. Module validation is shared with inventory and freshness probes.
        async function moduleResources(course: CanvasCourse) {
          const captured: ResourceInput[] = [];
          const started = performance.now();
          const reused = moduleRun.results.has(`${http.origin}\n${course.id}`);
          const acquisition = await readCanvasModules(http, course.id, combined,
            moduleRun);
          const moduleDiagnostics = acquisition.diagnostics.map(code => ({ code, path: [], severity: "error" as const }));
          emit(course.id, courseName(course), "modules",
            acquisition.modules.map(entry => moduleResource(entry.module, course, origin)),
            acquisition.listComplete ? "ok" : acquisition.status === "ok" ? "partial" : acquisition.status,
            acquisition.listComplete, moduleDiagnostics, started, 0,
            reused ? 0 : acquisition.listRequests);
          for (const entry of acquisition.modules) {
            const resources: ResourceInput[] = [];
            const diagnostics: CaptureDiagnostic[] = entry.diagnostics.map(code => ({ code, path: [], severity: "error" as const }));
            for (const item of entry.items) {
              try { resources.push(itemResource(item, course, origin, entry.module.id)); }
              catch (error) { diagnostics.push(...diagnostic(error).map(d => ({ ...d, severity: "error" as const }))); }
            }
            emit(course.id, courseName(course), `module-items:${entry.module.id}`, resources,
              diagnostics.length && entry.status === "ok" ? "partial" : entry.status,
              entry.complete && !diagnostics.length, diagnostics, started, 0,
              reused ? 0 : entry.requests);
            captured.push(...resources);
          }
          return captured;
        }
        async function essentials(course: CanvasCourse) {
          const end = now().toISOString(),
            start = options.announcementsStartDate ?? "1970-01-01";
          const [assignments, items, announcements] = await Promise.all([
            collect(
              course,
              "assignments",
              `${origin}/api/v1/courses/${course.id}/assignments?per_page=100&include[]=submission&order_by=due_at`,
              assignmentSchema,
              (item) => assignmentResource(item, course, origin, options.collectComments !== false),
            ),
            moduleResources(course),
            collect(
              course,
              "announcements",
              `${origin}/api/v1/announcements?per_page=100&context_codes[]=course_${course.id}&start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}`,
              discussionSchema,
              (item) => noteAuthor(course, item) ?? discussionResource(item, course, origin),
            ),
          ]);
          gather(course, assignments.resources);
          gather(course, items);
          gather(course, announcements.resources);
        }
        const visitedPages = new Map<string, Set<string>>();
        const pageDepth = new Map<string, Map<string, number>>();
        const pageStarted = new Map<string, number>();
        const pageListRead = (course: CanvasCourse) =>
            collect(
              course,
              "pages",
              `${origin}/api/v1/courses/${course.id}/pages?per_page=100`,
              pageSchema,
              (item) => {
                const resource = pageResource(
                  { ...item, body: undefined },
                  course,
                  origin,
                );
                delete resource.rawHtml;
                return resource;
              },
            );
        async function pageBodies(
          course: CanvasCourse,
          pageList: { items: z.infer<typeof pageSchema>[] },
        ) {
            const refs = references.get(course.id) ?? new Map<string, boolean>();
            references.set(course.id, refs);
            const visited = visitedPages.get(course.id) ?? new Set<string>();
            visitedPages.set(course.id, visited);
            const depths = pageDepth.get(course.id) ?? new Map<string, number>();
            pageDepth.set(course.id, depths);
            if (!pageStarted.has(course.id)) pageStarted.set(course.id, performance.now());
            // Reading may register a view in Canvas. This accepted side effect is disclosed in Sources.
            const bodyJobs = [
              ...new Set([
                ...refs.keys(),
                ...pageList.items.map((page) => page.url),
              ]),
            ].sort(
              (a, b) =>
                Number(refs.get(b) ?? false) - Number(refs.get(a) ?? false) ||
                Number(refs.has(b)) - Number(refs.has(a)),
            );
            // Read each frontier concurrently; discoveries form the next bounded wave.
            let cursor = 0;
            while (cursor < bodyJobs.length) {
              const wave = bodyJobs.slice(cursor);
              cursor = bodyJobs.length;
              await Promise.all(wave.map(async (slug) => {
              if (http.needsSignIn) return;
              if (visited.has(slug)) return;
              if ((depths.get(slug) ?? 0) > 3) {
                emit(course.id, courseName(course), "page-discovery", [], "partial", false,
                  [{ code: "linked_page_depth", path: [], severity: "warning" }]);
                return;
              }
              if (visited.size >= 100 || performance.now() - pageStarted.get(course.id)! > 120_000) {
                emit(course.id, courseName(course), "page-discovery", [], "partial", false,
                  [{ code: "linked_page_budget", path: [], severity: "warning" }]);
                return;
              }
              visited.add(slug);
              const depth = depths.get(slug) ?? 0;
              const expand = (resources: ResourceInput[]) => {
                const before = new Set(refs.keys());
                gather(course, resources);
                for (const discovered of refs.keys()) {
                  if (!before.has(discovered) && !visited.has(discovered)) {
                    depths.set(discovered, depth + 1);
                    refs.set(discovered, (refs.get(discovered) ?? false) || (refs.get(slug) ?? false));
                    bodyJobs.push(discovered);
                  }
                }
              };
              const metadata = pageList.items.find((page) => page.url === slug);
              const scope = `page:${metadata?.page_id ?? hashCanvas(slug).slice(0, 24)}`;
              const known = options.knownResources?.find(
                (row) =>
                  row.sourceId ===
                    source(course.id, courseName(course), scope).id &&
                  row.externalId === metadata?.page_id &&
                  !row.deleted &&
                  row.updatedAt &&
                  row.updatedAt === metadata.updated_at &&
                  row.rawHtml !== undefined &&
                  row.contentHash,
              );
              if (known) {
                expand([known]);
                emit(
                  course.id,
                  courseName(course),
                  scope,
                  [
                    resourceInputSchema.parse(
                      Object.fromEntries(
                        Object.entries(known).filter(
                          ([key]) => key in resourceInputSchema.shape,
                        ),
                      ),
                    ),
                  ],
                  "ok",
                  true,
                  [
                    {
                      code: "unchanged_page_reused",
                      path: ["updated_at"],
                      severity: "warning",
                    },
                  ],
                );
                return;
              }
              const captured = await collect(
                course,
                scope,
                `${origin}/api/v1/courses/${course.id}/pages/${encodeURIComponent(slug)}`,
                pageSchema,
                (item) => {
                  if (
                    item.url !== slug ||
                    (metadata && item.page_id !== metadata.page_id)
                  )
                    throw new CanvasFailure(
                      "partial",
                      "page_identity_mismatch",
                    );
                  if (item.body == null)
                    throw new CanvasFailure("partial", "missing_page_body");
                  return pageResource(item, course, origin);
                },
                true,
              );
              expand(captured.resources);
              }));
            }
        }
        function backgroundFor(course: CanvasCourse) {
          const backgroundJobs: Array<() => Promise<unknown>> = [];
          const prefix = `${origin}/api/v1/courses/${course.id}`;
          backgroundJobs.push(async () => {
            // owner: T17. The course list row comes from the same serializer as the detail read
            // (course_json; add_helper_dependant_entries always sets calendar.ics) and already asked
            // for syllabus_body, term and total_scores. When it carries them, the read adds nothing.
            if (course.calendar?.ics !== undefined && course.syllabus_body !== undefined) {
              emit(course.id, courseName(course), "details", [], "ok", true, [
                { code: "details_from_course_list", path: [], severity: "warning" },
              ]);
              await calendar(course);
              return;
            }
            const details = await collect(
              course,
              "details",
              `${prefix}?include[]=term&include[]=syllabus_body&include[]=total_scores`,
              courseSchema,
              (item) => {
                if (item.id !== course.id)
                  throw new CanvasFailure("partial", "course_id_mismatch");
                return null;
              },
              true,
            );
            if (details.items[0]) {
              const detailed = { ...course, ...details.items[0] };
              const detailedResource = courseResource(detailed, origin, selection(), profile.id);
              // A detail response may omit total scores despite inclusion. Keep
              // this pull's explicit catalog claims rather than clear them with
              // an omitted optional field. Explicit null claims remain distinct.
              if (detailedResource.course && !detailedResource.course.gradeEvidence)
                detailedResource.course.gradeEvidence = courseResource(course, origin, selection(), profile.id).course?.gradeEvidence;
              emit(
                course.id,
                courseName(detailed),
                "course",
                [detailedResource],
                details.status,
                details.complete,
              );
              gather(detailed, syllabus(detailed) ?? []);
              await calendar(details.items[0]);
            }
          });
          if (options.collectComments !== false)
            backgroundJobs.push(() =>
              collect(
                course,
                "submissions",
                `${prefix}/students/submissions?per_page=100&include[]=submission_comments`,
                canvasSubmissionSchema,
                (item) => {
                  if (item.user_id && item.user_id !== profile.id)
                    throw new CanvasFailure(
                      "partial",
                      "submission_user_mismatch",
                    );
                  return resourceInputSchema.parse({
                    externalId: item.assignment_id,
                    kind: "material",
                    courseId: course.id,
                    courseName: courseName(course),
                    title: `Submission feedback ${item.assignment_id}`,
                    url: `${origin}/courses/${course.id}/assignments/${item.assignment_id}`,
                    text: "",
                    submission: submissionEvidence(item, origin),
                  });
                },
              ),
            );
          backgroundJobs.push(() =>
            collect(
              course,
              "files",
              `${prefix}/files?per_page=100`,
              fileSchema,
              (item) => fileResource(item, course, origin),
            ),
          );
          backgroundJobs.push(() =>
            collect(
              course,
              "folders",
              `${prefix}/folders?per_page=100`,
              folderSchema,
              (item) => folderResource(item, course, origin),
            ),
          );
          backgroundJobs.push(() =>
            collect(
              course,
              "assignment-groups",
              `${prefix}/assignment_groups?per_page=100`,
              groupSchema,
              (item) => groupResource(item, course, origin),
            ),
          );
          backgroundJobs.push(() =>
            collect(
              course,
              "quizzes",
              `${prefix}/quizzes?per_page=100`,
              quizSchema,
              (item) => quizResource(item, course, origin),
            ),
          );
          backgroundJobs.push(async () => {
            const discussions = await collect(
              course,
              "discussions",
              `${prefix}/discussion_topics?per_page=100`,
              discussionSchema,
              (item) => noteAuthor(course, item) ?? discussionResource(item, course, origin),
            );
            gather(course, discussions.resources);
          });
          return backgroundJobs;
        }
        // Each course advances independently while the scheduler bounds host concurrency and
        // serves essentials first, then pages, then background lists. Late references drain once.
        await Promise.all(
          courses.map(async (course) => {
            if (http.needsSignIn) return;
            gather(course, syllabus(course) ?? []);
            const [, pageList] = await Promise.all([
              essentials(course),
              pageListRead(course),
            ]);
            if (http.needsSignIn) return;
            await pageBodies(course, pageList);
            await Promise.all(
              backgroundFor(course).map(async (job) => {
                if (!http.needsSignIn) await job();
              }),
            );
            if (!http.needsSignIn) await pageBodies(course, { items: [] });
          }),
        );
        const [reconciliation] = await reconciled;
        if (reconciliation.status === "rejected") throw reconciliation.reason;
        if (http.needsSignIn)
          emit(
            "connection",
            "Canvas connection",
            "connection",
            [],
            "needs_sign_in",
            false,
          );
      }
      const running = work()
        .catch((error) => {
          fatal = error;
        })
        .finally(() => {
          done = true;
          wake?.();
          wake = undefined;
        });
      try {
        while (!done || queue.length) {
          if (queue.length) {
            yield queue.shift()!;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        if (fatal) throw fatal;
      } finally {
        stop.abort();
        await running;
      }
    },
  };
}
