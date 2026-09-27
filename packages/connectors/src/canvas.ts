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
} from "./canvas-http";
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
  moduleSchema,
  itemSchema,
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
      ): Promise<{
        items: T[];
        resources: ResourceInput[];
        complete: boolean;
        status: CaptureBatch["status"];
      }> {
        const scopeSignal = AbortSignal.any([
          combined,
          AbortSignal.timeout(options.scopeTimeoutMs ?? 120_000),
        ]);
        const items: T[] = [],
          resources: ResourceInput[] = [],
          diagnostics: CaptureDiagnostic[] = [];
        const seenUrls = new Set<string>(),
          seenIds = new Set<string>(),
          started = performance.now(),
          initial = url,
          requestStats = { requests: 0 };
        let next: string | null = url,
          pages = 0,
          status: CaptureBatch["status"] = "ok",
          invalid = false;
        try {
          while (next && pages < MAX_PAGES) {
            if (seenUrls.has(next))
              throw new CanvasFailure("partial", "pagination_cycle");
            seenUrls.add(next);
            const response = await http.request(
              next,
              scopeSignal,
              requestStats,
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
          combined.throwIfAborted();
          status = scopeSignal.aborted
            ? "partial"
            : failure(error, resources.length > 0);
          diagnostics.push(
            ...(scopeSignal.aborted
              ? [
                  {
                    code: "scope_time_limit",
                    path: [],
                    severity: "error" as const,
                  },
                ]
              : diagnostic(error)),
          );
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
        let profile: z.infer<typeof profileSchema>;
        try {
          profile = profileSchema
            .parse(
              (
                await http.request(
                  `${origin}/api/v1/users/self/profile`,
                  combined,
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
        ];
        const accountReads = accountJobs.map((job) => ({
          job,
          promise: collect(
            account,
            job.scope,
            `${origin}/api/v1/users/self/${job.path}?per_page=100${job.path.startsWith("activity_stream") ? "&only_active_courses=true" : ""}`,
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
          `${origin}/api/v1/courses?enrollment_state=active&per_page=100&include[]=syllabus_body&include[]=term&include[]=teachers&include[]=total_scores&include[]=concluded`,
          courseSchema,
        );
        // Past-course discovery is a metadata read only. It does not delay the
        // active learning path or start a deep crawl of concluded coursework.
        const historicalRead = collect(
          account,
          "courses-completed",
          `${origin}/api/v1/courses?enrollment_state=completed&state[]=available&state[]=completed&per_page=100&include[]=term&include[]=total_scores&include[]=concluded`,
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
        if (http.needsSignIn) {
          await Promise.all([accountSettled, historicalSettled, reconciled]);
          return;
        }
        const courses = catalog.items.filter(
            (course) => courseSelection(course, selection()).included,
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
                Date.parse(d.value) <= now().getTime() + 14 * 86400_000,
            );
            for (const link of row.links ?? []) {
              const url = new URL(typeof link === "string" ? link : link.url);
              const match = url.pathname.match(
                new RegExp(`^/courses/${course.id}/pages/([^/]+)$`),
              );
              if (url.origin === origin && match) {
                const slug = decodeURIComponent(match[1]!);
                if (/^[a-zA-Z0-9_%.-]{1,256}$/.test(slug))
                  refs.set(slug, (refs.get(slug) ?? false) || soon);
              }
            }
          }
        }
        // First useful account captures are already yielded. Run course essentials before body reads.
        await pool(courses, http.concurrency, async (course) => {
          if (http.needsSignIn) return;
          syllabus(course);
          const assignments = await collect(
            course,
            "assignments",
            `${origin}/api/v1/courses/${course.id}/assignments?per_page=100&include[]=submission&order_by=due_at`,
            assignmentSchema,
            (item) =>
              assignmentResource(
                item,
                course,
                origin,
                options.collectComments !== false,
              ),
          );
          gather(course, assignments.resources);
          if (http.needsSignIn) return;
          const modules = await collect(
            course,
            "modules",
            `${origin}/api/v1/courses/${course.id}/modules?per_page=100`,
            moduleSchema,
            (item) => moduleResource(item, course, origin),
          );
          for (const module of modules.items) {
            if (http.needsSignIn) return;
            const items = await collect(
              course,
              `module-items:${module.id}`,
              `${origin}/api/v1/courses/${course.id}/modules/${module.id}/items?per_page=100&include[]=content_details`,
              itemSchema,
              (item) => {
                if (item.module_id && item.module_id !== module.id)
                  throw new CanvasFailure("partial", "module_id_mismatch");
                return itemResource(item, course, origin);
              },
            );
            gather(course, items.resources);
          }
          if (http.needsSignIn) return;
          const end = now().toISOString(),
            start = options.announcementsStartDate ?? "1970-01-01";
          await collect(
            course,
            "announcements",
            `${origin}/api/v1/announcements?per_page=100&context_codes[]=course_${course.id}&start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}`,
            discussionSchema,
            (item) => noteAuthor(course, item) ?? discussionResource(item, course, origin),
          );
        });
        if (!http.needsSignIn)
          await pool(courses, http.concurrency, async (course) => {
            const pageList = await collect(
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
            const refs =
              references.get(course.id) ?? new Map<string, boolean>();
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
            for (const slug of bodyJobs) {
              if (http.needsSignIn) return;
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
                continue;
              }
              await collect(
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
                  if (item.body === undefined)
                    throw new CanvasFailure("partial", "missing_page_body");
                  return pageResource(item, course, origin);
                },
                true,
              );
            }
          });
        const backgroundJobs: Array<() => Promise<unknown>> = [];
        for (const course of courses) {
          const prefix = `${origin}/api/v1/courses/${course.id}`;
          backgroundJobs.push(async () => {
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
              syllabus(detailed);
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
          backgroundJobs.push(() =>
            collect(
              course,
              "discussions",
              `${prefix}/discussion_topics?per_page=100`,
              discussionSchema,
              (item) => noteAuthor(course, item) ?? discussionResource(item, course, origin),
            ),
          );
        }
        await pool(backgroundJobs, http.concurrency, async (job) => {
          if (!http.needsSignIn) await job();
        });
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
