import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";
import { z } from "zod";
import {
  captureBatchSchema,
  instant,
  resourceInputSchema,
  type CaptureBatch,
  type Connector,
  type ResourceInput,
} from "@magic/contracts";

export interface CanvasConnectorOptions {
  /** Use an app-owned browser session's fetch. Never copy cookies into headers. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  origin?: string;
  now?: () => Date;
}

const canvasId = z
  .union([
    z.number().int().positive().safe(),
    z.string().regex(/^[1-9]\d{0,29}$/),
  ])
  .transform(String);
const profileSchema = z.object({ id: canvasId });
const courseSchema = z.object({
  id: canvasId,
  name: z.string().min(1).max(200),
  syllabus_body: z.string().max(1_000_000).nullable().optional(),
});
const submissionSchema = z.object({
  assignment_id: canvasId.optional(),
  workflow_state: z
    .enum(["submitted", "unsubmitted", "graded", "pending_review"])
    .optional(),
  submitted_at: instant.nullable().optional(),
});
const assignmentSchema = z.object({
  id: canvasId,
  course_id: canvasId,
  name: z.string().min(1).max(500),
  description: z.string().max(1_000_000).nullable(),
  due_at: instant.nullable(),
  lock_at: instant.nullable(),
  points_possible: z.number().finite().nonnegative().nullable(),
  submission: submissionSchema.nullable().optional(),
});
type Course = z.infer<typeof courseSchema>;
type Assignment = z.infer<typeof assignmentSchema>;
type FailureStatus = "error" | "partial" | "needs_sign_in";
class CaptureFailure extends Error {
  constructor(readonly status: FailureStatus) {
    super("Canvas capture did not complete");
  }
}
const MAX_PAGES = 20;
const MAX_RECORDS = 2000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Parsing never creates a DOM, loads resources, or executes source markup. */
function plainText(html: string): string {
  const pieces: string[] = [];
  let suppressed = 0;
  const hidden = new Set([
    "script",
    "style",
    "template",
    "noscript",
    "iframe",
    "object",
    "svg",
  ]);
  const blocks = new Set([
    "p",
    "div",
    "li",
    "ul",
    "ol",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "br",
    "tr",
    "section",
    "article",
    "blockquote",
    "pre",
    "table",
  ]);
  const parser = new Parser(
    {
      onopentag(name) {
        if (hidden.has(name)) suppressed++;
        if (!suppressed && blocks.has(name)) pieces.push("\n");
      },
      ontext(value) {
        if (!suppressed) pieces.push(value);
      },
      onclosetag(name) {
        if (hidden.has(name)) suppressed = Math.max(0, suppressed - 1);
        if (!suppressed && blocks.has(name)) pieces.push("\n");
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  // Keep whitespace inside code examples; it can change their meaning.
  const text = pieces
    .join("")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Truncation would silently change the evidence. Oversized documents stay partial.
  if (text.length > 200_000) throw new CaptureFailure("partial");
  return text;
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function checkedOrigin(input: string): string {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Canvas requires an HTTPS origin");
  return url.origin;
}
function checkedApiUrl(
  input: string,
  origin: string,
  expectedPath?: string,
): string {
  const url = new URL(input, origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith("/api/v1/") ||
    (expectedPath && url.pathname !== expectedPath)
  )
    throw new CaptureFailure("partial");
  // The session is the only authentication mechanism; a Link must not introduce one.
  if (
    [...url.searchParams.keys()].some((key) =>
      /token|authorization|cookie|password/i.test(key),
    )
  )
    throw new CaptureFailure("partial");
  return url.toString();
}
function nextPage(
  link: string | null,
  current: string,
  origin: string,
): string | null {
  if (!link) return null;
  let next: string | null = null;
  // Canvas uses RFC 5988 Link headers. Commas inside URLs stay within <...>.
  const entries = link.split(/,(?=\s*<)/);
  for (const entry of entries) {
    const match = entry.match(/^\s*<([^>]+)>\s*((?:;\s*[^;]+)*)\s*$/);
    if (!match) throw new CaptureFailure("partial");
    const rel = match[2]!.match(/(?:^|;)\s*rel\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
    if ((rel?.[1] ?? rel?.[2] ?? "").split(/\s+/).includes("next")) {
      if (next) throw new CaptureFailure("partial");
      next = checkedApiUrl(
        new URL(match[1]!, current).toString(),
        origin,
        new URL(current).pathname,
      );
    }
  }
  return next;
}
async function limitedText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const advertised = response.headers.get("content-length");
  if (advertised && Number(advertised) > MAX_RESPONSE_BYTES)
    throw new CaptureFailure("partial");
  if (!response.body) throw new CaptureFailure("partial");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0,
    body = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new CaptureFailure("partial");
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function failureStatus(error: unknown, hasRecords = false): FailureStatus {
  if (error instanceof CaptureFailure && error.status === "needs_sign_in")
    return "needs_sign_in";
  if (
    error instanceof z.ZodError ||
    (error instanceof CaptureFailure && error.status === "partial")
  )
    return "partial";
  return hasRecords ? "partial" : "error";
}
function submissionState(assignment: Assignment): boolean | null {
  const submission = assignment.submission;
  if (!submission) return null;
  if (submission.assignment_id && submission.assignment_id !== assignment.id)
    throw new CaptureFailure("partial");
  if (submission.submitted_at) return true;
  if (
    submission.workflow_state === "submitted" ||
    submission.workflow_state === "pending_review"
  )
    return true;
  if (submission.workflow_state === "unsubmitted") return false;
  // A grade can be entered for an offline task or missing work; it alone proves no submission.
  return null;
}
function assignmentResource(
  assignment: Assignment,
  course: Course,
  origin: string,
): ResourceInput {
  if (assignment.course_id !== course.id) throw new CaptureFailure("partial");
  const deadlines: ResourceInput["deadlines"] = [];
  for (const [field, kind] of [
    ["due_at", "due"],
    ["lock_at", "lock"],
  ] as const) {
    const value = assignment[field];
    if (value)
      deadlines.push({
        value,
        kind,
        quote: `${field}: ${value}`,
        authority: "structured",
        scopeConfirmed: true,
      });
  }
  return resourceInputSchema.parse({
    externalId: assignment.id,
    kind: "assignment",
    courseId: course.id,
    courseName: course.name,
    title: assignment.name,
    url: `${origin}/courses/${course.id}/assignments/${assignment.id}`,
    text: plainText(assignment.description ?? ""),
    deadlines,
    points: assignment.points_possible,
    submitted: submissionState(assignment),
    policy: { mode: "unknown", evidence: "" },
  });
}

/** Read-only Canvas API capture. Complete means this endpoint scope finished, never all coursework. */
export function canvasConnector(options: CanvasConnectorOptions): Connector {
  const origin = checkedOrigin(options.origin ?? "https://canvas.wisc.edu");
  const originHash = hash(origin).slice(0, 24);
  const now = options.now ?? (() => new Date());
  const statusSource: CaptureBatch["source"] = {
    id: `canvas:${originHash}:status`,
    label: "Canvas connection",
    kind: "canvas",
    accountScope: `connection:${originHash}`,
    courseId: "connection",
    scope: "connection",
  };
  async function request(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; link: string | null }> {
    signal?.throwIfAborted();
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(15_000),
      ...(signal ? [signal] : []),
    ]);
    const response = await options.fetch(checkedApiUrl(url, origin), {
      method: "GET",
      credentials: "include",
      redirect: "manual",
      headers: { Accept: "application/json" },
      signal: requestSignal,
    });
    if (
      response.status === 401 ||
      response.status === 403 ||
      (response.status >= 300 && response.status < 400) ||
      response.type === "opaqueredirect" ||
      response.redirected
    )
      throw new CaptureFailure("needs_sign_in");
    if (!response.ok) throw new CaptureFailure("error");
    // Detect a transport that ignored redirect:manual without trusting its response body.
    if (response.url && new URL(response.url).origin !== origin)
      throw new CaptureFailure("needs_sign_in");
    const type = response.headers.get("content-type") ?? "";
    if (/text\/html|application\/xhtml\+xml/i.test(type))
      throw new CaptureFailure("needs_sign_in");
    if (!/application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|$)/i.test(type))
      throw new CaptureFailure("partial");
    const body = await limitedText(response, requestSignal);
    if (/^\s*</.test(body)) throw new CaptureFailure("needs_sign_in");
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new CaptureFailure("partial");
    }
    return { data, link: response.headers.get("link") };
  }
  async function collect<T>(
    initial: string,
    schema: z.ZodType<T>,
    signal: AbortSignal | undefined,
    accept?: (items: T[]) => void,
  ): Promise<{
    items: T[];
    status: CaptureBatch["status"];
    complete: boolean;
  }> {
    const items: T[] = [];
    const seen = new Set<string>();
    let url: string | null = initial;
    try {
      for (let page = 0; url && page < MAX_PAGES; page++) {
        if (seen.has(url)) throw new CaptureFailure("partial");
        seen.add(url);
        const response = await request(url, signal);
        const parsed = z.array(schema).max(MAX_RECORDS).parse(response.data);
        if (items.length + parsed.length > MAX_RECORDS)
          throw new CaptureFailure("partial");
        accept?.(parsed);
        items.push(...parsed);
        url = nextPage(response.link, url, origin);
      }
      if (url) throw new CaptureFailure("partial");
      return { items, status: "ok", complete: true };
    } catch (error) {
      signal?.throwIfAborted();
      return {
        items,
        status: failureStatus(error, items.length > 0),
        complete: false,
      };
    }
  }
  return {
    id: "canvas",
    async *pull(signal) {
      signal?.throwIfAborted();
      const batch = (
        source: CaptureBatch["source"],
        status: CaptureBatch["status"],
        complete: boolean,
        resources: ResourceInput[] = [],
      ): CaptureBatch =>
        captureBatchSchema.parse({
          source,
          observedAt: now().toISOString(),
          status,
          complete,
          resources,
        });
      let accountScope: string;
      try {
        const { data } = await request(
          `${origin}/api/v1/users/self/profile`,
          signal,
        );
        const { id } = profileSchema.parse(data);
        accountScope = hash(`${origin}\n${id}`);
      } catch (error) {
        signal?.throwIfAborted();
        yield batch(statusSource, failureStatus(error), false);
        return;
      }
      const courseIds = new Set<string>();
      const courses = await collect(
        `${origin}/api/v1/courses?enrollment_state=active&per_page=100&include[]=syllabus_body`,
        courseSchema,
        signal,
        (items) => {
          const ids = new Set<string>();
          for (const course of items) {
            if (ids.has(course.id) || courseIds.has(course.id))
              throw new CaptureFailure("partial");
            ids.add(course.id);
          }
          for (const id of ids) courseIds.add(id);
        },
      );
      yield batch(statusSource, courses.status, courses.complete);
      if (courses.status === "needs_sign_in") return;
      for (const course of courses.items) {
        signal?.throwIfAborted();
        const source = (
          scope: "assignments" | "syllabus",
        ): CaptureBatch["source"] => ({
          id: `canvas:${accountScope}:${course.id}:${scope}`,
          label: `${course.name.slice(0, 175)} · ${scope}`,
          kind: "canvas",
          accountScope,
          courseId: course.id,
          scope,
        });
        try {
          if (course.syllabus_body === undefined) {
            yield batch(source("syllabus"), "partial", false);
          } else {
            const text = plainText(course.syllabus_body ?? "");
            const resources: ResourceInput[] = text
              ? [
                  resourceInputSchema.parse({
                    externalId: "syllabus",
                    kind: "material",
                    courseId: course.id,
                    courseName: course.name,
                    title: "Syllabus",
                    url: `${origin}/courses/${course.id}/assignments/syllabus`,
                    text,
                    deadlines: [],
                    points: null,
                    submitted: null,
                    policy: { mode: "unknown", evidence: "" },
                  }),
                ]
              : [];
            yield batch(source("syllabus"), "ok", true, resources);
          }
        } catch (error) {
          signal?.throwIfAborted();
          yield batch(source("syllabus"), failureStatus(error), false);
        }
        const resources: ResourceInput[] = [];
        const assignmentIds = new Set<string>();
        const assignments = await collect(
          `${origin}/api/v1/courses/${course.id}/assignments?per_page=100&include[]=submission`,
          assignmentSchema,
          signal,
          (items) => {
            const pageResources = items.map((item) =>
              assignmentResource(item, course, origin),
            );
            const ids = new Set<string>();
            for (const item of pageResources) {
              if (
                ids.has(item.externalId) ||
                assignmentIds.has(item.externalId)
              )
                throw new CaptureFailure("partial");
              ids.add(item.externalId);
            }
            for (const id of ids) assignmentIds.add(id);
            resources.push(...pageResources);
          },
        );
        yield batch(
          source("assignments"),
          assignments.status,
          assignments.complete,
          resources,
        );
        if (assignments.status === "needs_sign_in") {
          yield batch(statusSource, "needs_sign_in", false);
          return;
        }
      }
    },
  };
}
