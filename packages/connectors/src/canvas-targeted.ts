/**
 * fix/canvas-sync-events. The smallest Canvas read that answers one change signal: one
 * assignment, or one course's assignment, announcement, discussion, quiz or submission list.
 * Never a sync: no profile, catalog, account lists, pages crawl or files.
 *
 * Batches use the full connector's source ids (`canvas:<account>:<course>:<scope>`), so a
 * targeted read and a full read describe the same stored set. A one-item read re-emits the
 * stored set with that item replaced (or removed when Canvas answers 404), as a complete batch:
 * nothing else is deleted and the source stays whole.
 */
import { z } from "zod";
import {
  captureBatchSchema,
  resourceInputSchema,
  type CaptureBatch,
  type CaptureDiagnostic,
  type Resource,
  type ResourceInput,
} from "@magic/contracts";
import { CanvasFailure, canvasNextPage, type CanvasHttp } from "./canvas-http";
import {
  assignmentResource,
  assignmentSchema,
  canvasSubmissionSchema,
  discussionResource,
  discussionSchema,
  quizResource,
  quizSchema,
  submissionEvidence,
  type CanvasCourse,
} from "./canvas-models";

export type TargetedKind =
  | "assignment"
  | "grade"
  | "announcement"
  | "discussion"
  | "quiz"
  | "submission_comment";
export interface TargetedRead {
  kind: TargetedKind;
  /** An assignment id for a one-item read; otherwise the course's list for the kind. */
  itemId?: string;
}
export interface TargetedCourse {
  accountScope: string;
  id: string;
  name: string;
}
export interface TargetedResult {
  batches: CaptureBatch[];
  requests: number;
  needsSignIn: boolean;
  complete: boolean;
}
const SCOPES: Record<TargetedKind, string> = {
  assignment: "assignments",
  grade: "assignments",
  announcement: "announcements",
  discussion: "discussions",
  quiz: "quizzes",
  submission_comment: "submissions",
};
export function targetedScope(kind: TargetedKind): string {
  return SCOPES[kind];
}
function stored(resource: Resource): ResourceInput {
  return resourceInputSchema.parse(
    Object.fromEntries(
      Object.entries(resource).filter(([key]) => key in resourceInputSchema.shape),
    ),
  );
}
const MAX_PAGES = 20;
async function list<T>(
  http: CanvasHttp,
  url: string,
  schema: z.ZodType<T>,
  signal: AbortSignal | undefined,
  count: { requests: number },
): Promise<{ items: T[]; invalid: number }> {
  const items: T[] = [];
  let invalid = 0;
  const initial = url,
    seen = new Set<string>();
  let next: string | null = url;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    if (seen.has(next)) throw new CanvasFailure("partial", "pagination_cycle");
    seen.add(next);
    count.requests++;
    const response = await http.request(next, signal, undefined, 0, { fresh: true });
    if (!Array.isArray(response.data)) throw new CanvasFailure("partial", "expected_array");
    for (const raw of response.data) {
      const parsed = schema.safeParse(raw);
      if (parsed.success) items.push(parsed.data);
      else invalid++;
    }
    next = canvasNextPage(response.link, next, initial, http.origin);
  }
  if (next) throw new CanvasFailure("partial", "page_limit");
  return { items, invalid };
}
/**
 * Runs the targeted reads for one course. `known` is the store's current resources for that
 * course (any source); only rows of the scope's own source are merged.
 */
export async function canvasTargetedRead(
  http: CanvasHttp,
  course: TargetedCourse,
  reads: TargetedRead[],
  known: Resource[],
  options: {
    now: () => Date;
    collectComments?: boolean;
    announcementsStartDate?: string;
    signal?: AbortSignal;
  },
): Promise<TargetedResult> {
  const origin = http.origin;
  const canvasCourse = { id: course.id, name: course.name } as CanvasCourse;
  const count = { requests: 0 };
  const batches: CaptureBatch[] = [];
  let complete = true;
  const source = (scope: string): CaptureBatch["source"] => ({
    id: `canvas:${course.accountScope}:${course.id}:${scope}`,
    label: `${course.name.slice(0, 145)} · ${scope}`.slice(0, 200),
    kind: "canvas",
    accountScope: course.accountScope,
    courseId: course.id,
    scope,
  });
  const emit = (
    scope: string,
    resources: ResourceInput[],
    status: CaptureBatch["status"],
    diagnostics: CaptureDiagnostic[] = [],
  ) => {
    if (status !== "ok") complete = false;
    batches.push(
      captureBatchSchema.parse({
        source: source(scope),
        observedAt: options.now().toISOString(),
        resources,
        status,
        complete: status === "ok",
        diagnostics: [{ code: "targeted_read", path: [], severity: "warning" }, ...diagnostics],
        stats: { durationMs: 0, pages: 0, records: resources.length, requests: count.requests },
      }),
    );
  };
  const comments = options.collectComments !== false;
  // One read per scope: a list read answers every item event of its kind.
  const byScope = new Map<string, TargetedRead[]>();
  for (const read of reads) {
    const scope = SCOPES[read.kind];
    byScope.set(scope, [...(byScope.get(scope) ?? []), read]);
  }
  for (const [scope, group] of byScope) {
    const prefix = `${origin}/api/v1/courses/${course.id}`;
    const whole = group.some((r) => !r.itemId || (r.kind !== "assignment" && r.kind !== "grade"));
    try {
      if (scope === "assignments" && !whole) {
        // One assignment at a time, merged into the stored set of the assignments source.
        const own = known.filter((r) => r.sourceId === source(scope).id && !r.deleted && r.kind === "assignment");
        if (!own.length) throw new CanvasFailure("partial", "no_stored_assignment_set");
        const next = new Map(own.map((r) => [r.externalId, stored(r)]));
        for (const id of new Set(group.map((r) => r.itemId!))) {
          count.requests++;
          try {
            const response = await http.request(
              `${prefix}/assignments/${encodeURIComponent(id)}?include[]=submission`,
              options.signal, undefined, 0, { fresh: true },
            );
            const item = assignmentSchema.parse(response.data);
            if (String(item.id) !== id || String(item.course_id) !== course.id)
              throw new CanvasFailure("partial", "assignment_identity_mismatch");
            next.set(id, assignmentResource(item, canvasCourse, origin, comments));
          } catch (error) {
            // Canvas answers 404 for a deleted or unpublished assignment: it leaves the set.
            if (error instanceof CanvasFailure && error.status === "inaccessible" && error.code === "not_accessible")
              next.delete(id);
            else throw error;
          }
        }
        emit(scope, [...next.values()], "ok");
        continue;
      }
      if (scope === "assignments") {
        const { items, invalid } = await list(
          http,
          `${prefix}/assignments?per_page=100&include[]=submission&order_by=due_at`,
          assignmentSchema, options.signal, count,
        );
        emit(scope, items.map((item) => assignmentResource(item, canvasCourse, origin, comments)),
          invalid ? "partial" : "ok",
          invalid ? [{ code: "invalid_field", path: [], severity: "error" }] : []);
        continue;
      }
      if (scope === "announcements") {
        const start = options.announcementsStartDate ?? "1970-01-01";
        const end = options.now().toISOString();
        const { items, invalid } = await list(
          http,
          `${origin}/api/v1/announcements?per_page=100&context_codes[]=course_${course.id}&start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}`,
          discussionSchema, options.signal, count,
        );
        emit(scope, items.map((item) => discussionResource(item, canvasCourse, origin)),
          invalid ? "partial" : "ok");
        continue;
      }
      if (scope === "discussions") {
        const { items, invalid } = await list(
          http, `${prefix}/discussion_topics?per_page=100`, discussionSchema, options.signal, count,
        );
        emit(scope, items.map((item) => discussionResource(item, canvasCourse, origin)),
          invalid ? "partial" : "ok");
        continue;
      }
      if (scope === "quizzes") {
        const { items, invalid } = await list(http, `${prefix}/quizzes?per_page=100`, quizSchema, options.signal, count);
        emit(scope, items.map((item) => quizResource(item, canvasCourse, origin)), invalid ? "partial" : "ok");
        continue;
      }
      if (scope === "submissions") {
        if (!comments) continue;
        const { items, invalid } = await list(
          http,
          `${prefix}/students/submissions?per_page=100&include[]=submission_comments`,
          canvasSubmissionSchema, options.signal, count,
        );
        emit(scope, items.map((item) =>
          resourceInputSchema.parse({
            externalId: item.assignment_id,
            kind: "material",
            courseId: course.id,
            courseName: course.name,
            title: `Submission feedback ${item.assignment_id}`,
            url: `${origin}/courses/${course.id}/assignments/${item.assignment_id}`,
            text: "",
            submission: submissionEvidence(item, origin),
          })), invalid ? "partial" : "ok");
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (http.needsSignIn) return { batches, requests: count.requests, needsSignIn: true, complete: false };
      // A failed targeted read stores nothing: the stored set stands, and the next probe asks again.
      complete = false;
    }
  }
  return { batches, requests: count.requests, needsSignIn: false, complete };
}
