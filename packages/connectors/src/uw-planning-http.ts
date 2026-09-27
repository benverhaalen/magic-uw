import { z } from "zod";

export type UwPlanningSource = "public-enroll" | "enroll" | "myuw" | "canvas";
export type UwPlanningFetch = (url: string, init: RequestInit) => Promise<Response>;

const origins = Object.freeze({
  "public-enroll": "https://public.enroll.wisc.edu",
  enroll: "https://enroll.wisc.edu",
  myuw: "https://my.wisc.edu",
  canvas: "https://canvas.wisc.edu",
});

/** Endpoint candidates supplied by the student; successful JSON is not schema verification. */
export const UW_PLANNING_SOURCES = Object.freeze({
  "public-enroll": Object.freeze({ origin: origins["public-enroll"], probe: "public-terms" }),
  enroll: Object.freeze({ origin: origins.enroll, probe: "student-info" }),
  myuw: Object.freeze({ origin: origins.myuw, probe: "myuw-session" }),
  canvas: Object.freeze({ origin: origins.canvas, probe: "canvas-profile" }),
});

const term = z.string().regex(/^1\d{2}[246]$/);
const subject = z.string().regex(/^\d{1,6}$/);
const courseId = z.string().regex(/^\d{1,12}(?:\.\d{1,6})?$/);
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const fixed = <K extends string>(kind: K) => z.strictObject({ kind: z.literal(kind) });

// A small structured filter vocabulary, never a supplied Elasticsearch query or script.
// The subject and status query effects were checked against live responses.
const publicFilters = z.strictObject({
  subjectCode: subject,
  enrollmentStatus: z.array(z.enum(["OPEN", "WAITLISTED", "CLOSED"])).max(3),
});

const readRequestSchema = z.discriminatedUnion("kind", [
  fixed("public-terms"),
  z.strictObject({
    kind: z.literal("public-search"),
    term,
    query: z.string().max(500).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
    page: z.number().int().min(1).max(1000),
    pageSize: z.number().int().min(1).max(100),
    sort: z.enum(["SCORE", "SUBJECT", "CATALOG_NUMBER"]),
    filters: publicFilters,
  }),
  fixed("subjects-map"),
  z.strictObject({ kind: z.literal("enrollment-packages"), term, subject, courseId }),
  fixed("student-info"),
  z.strictObject({ kind: z.literal("current-enrollment"), term }),
  fixed("degree-plans"),
  z.strictObject({ kind: z.literal("degree-plan-detail"), planId: z.string().regex(/^\d{1,15}$/) }),
  z.strictObject({ kind: z.literal("roadmap"), term }),
  fixed("degree-programs"),
  fixed("audit-metadata"),
  z.strictObject({ kind: z.literal("audit-report"), reportId: safeId }),
  fixed("myuw-session"),
  fixed("enrollment-appointments"),
  fixed("canvas-profile"),
]);

export type UwPlanningReadRequest = z.infer<typeof readRequestSchema>;
export type UwPlanningFailureStatus =
  | "needs_sign_in"
  | "forbidden"
  | "unsupported"
  | "invalid_schema"
  | "rate_limited"
  | "cancelled"
  | "error";

export class UwPlanningInputError extends Error {
  constructor(
    readonly status: "invalid_schema" | "unsupported",
    readonly code: string,
  ) {
    super("UW planning request is not supported by the read boundary");
  }
}

export interface UwPlanningRequestDescriptor {
  readonly source: UwPlanningSource;
  readonly host: string;
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly body?: string;
  readonly schemaVerified: false;
}

/** Reconstruct at the trusted native boundary; never accept caller URLs, headers, or methods. */
export function buildUwPlanningRequest(input: unknown): UwPlanningRequestDescriptor {
  const parsed = readRequestSchema.safeParse(input);
  if (!parsed.success) throw new UwPlanningInputError("invalid_schema", "invalid_request");
  const request = parsed.data;
  let source: UwPlanningSource = "enroll";
  let path: string;
  let body: string | undefined;
  switch (request.kind) {
    case "public-terms":
      source = "public-enroll";
      path = "/api/search/v1/aggregate";
      break;
    case "public-search":
      source = "public-enroll";
      path = "/api/search/v1";
      body = JSON.stringify({
        selectedTerm: request.term,
        queryString: request.query.trim() || "*",
        page: request.page,
        pageSize: request.pageSize,
        sortOrder: request.sort,
        filters: [
          { term: { "subject.subjectCode": request.filters.subjectCode } },
          ...(request.filters.enrollmentStatus.length ? [{ has_child: {
            type: "enrollmentPackage", query: { match: { "packageEnrollmentStatus.status": [...new Set(request.filters.enrollmentStatus)].join(" ") } },
          } }] : []),
        ],
      });
      break;
    case "subjects-map": path = "/api/search/v1/subjectsMap/0000"; break;
    case "enrollment-packages":
      source = "public-enroll";
      path = `/api/search/v1/enrollmentPackages/${request.term}/${request.subject}/${request.courseId}`;
      break;
    case "student-info": path = "/api/enroll/v1/studentInfo"; break;
    case "current-enrollment": path = `/api/enroll/v1/current/${request.term}`; break;
    case "degree-plans": path = "/api/planner/v1/degreePlan"; break;
    case "degree-plan-detail":
      path = `/api/planner/v1/degreePlan/${request.planId}/termcourses`;
      break;
    case "roadmap": path = `/api/planner/v1/roadmap/${request.term}`; break;
    case "degree-programs": path = "/api/dars/student-degree-programs"; break;
    case "audit-metadata": path = "/api/dars/audit-metadata"; break;
    case "audit-report": path = `/api/dars/reports/${request.reportId}`; break;
    case "myuw-session": source = "myuw"; path = "/portal/web/session.json"; break;
    case "enrollment-appointments": source = "myuw"; path = "/aries/proxy/enrollmentlookup"; break;
    case "canvas-profile": source = "canvas"; path = "/api/v1/users/self/profile"; break;
  }
  return Object.freeze({
    source,
    host: new URL(origins[source]).hostname,
    url: `${origins[source]}${path}`,
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body }),
    schemaVerified: false,
  });
}

export interface UwPlanningMetric {
  host: string;
  status: number | null;
  bytes: number;
  elapsedMs: number;
}

interface ResultMetadata {
  source?: UwPlanningSource;
  host?: string;
  httpStatus?: number;
  bytes: number;
  elapsedMs: number;
  schemaVerified: false;
}
export type UwPlanningReadResult = ResultMetadata & (
  | { status: "ok"; data: unknown }
  | { status: UwPlanningFailureStatus; code: string; cached?: boolean; retryAfterMs?: number }
);

export interface UwPlanningHttpOptions {
  /** Uses the app-owned session and its browser User-Agent; never accepts or exports credentials. */
  fetch: UwPlanningFetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  minSpacingMs?: number;
  requestTimeoutMs?: number;
  negativeCacheMs?: number;
  onMetric?: (metric: UwPlanningMetric) => void;
}

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_QUEUE_PER_HOST = 64;
const MAX_NEGATIVE_ENTRIES = 128;
const boundedOption = (value: number | undefined, fallback: number, max: number) =>
  value !== undefined && Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : fallback;

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    // The operation can already be in flight; observe its rejection even after cancellation.
    void operation.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function retryAfter(header: string | null, now: number): number {
  const requested = header === null ? NaN : /^\d+(?:\.\d+)?$/.test(header.trim())
    ? Number(header) * 1000
    : Date.parse(header) - now;
  // Suppress subsequent reads instead of holding a queue or retrying before the requested time.
  // A large finite Retry-After stays large; it is never capped to an earlier retry.
  return Number.isFinite(requested)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER - now, requested))
    : 60_000;
}

function loginLocation(input: string | null, base: string): boolean {
  if (!input) return false;
  try {
    const url = new URL(input, base);
    return /(?:^|[./_-])(?:login|signin|sign-in|netid|shibboleth|saml|idp)(?:[./_-]|$)/i.test(url.hostname + url.pathname);
  } catch { return false; }
}

/** One instance shares host pacing and bounded negative caches across independent reads. */
export class UwPlanningHttp {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly queued = new Map<string, number>();
  private readonly nextStart = new Map<string, number>();
  private readonly suppressedUntil = new Map<string, number>();
  private readonly negative = new Map<string, { until: number; status: number }>();
  private readonly now: () => number;
  private readonly spacing: number;
  private readonly timeout: number;
  private readonly negativeTtl: number;

  constructor(private readonly options: UwPlanningHttpOptions) {
    this.now = options.now ?? Date.now;
    this.spacing = boundedOption(options.minSpacingMs, 2000, 60_000);
    this.timeout = Math.max(1, boundedOption(options.requestTimeoutMs, 15_000, 120_000));
    this.negativeTtl = boundedOption(options.negativeCacheMs, 30_000, 300_000);
  }

  probe(source: UwPlanningSource, signal?: AbortSignal): Promise<UwPlanningReadResult> {
    const descriptor = Object.hasOwn(UW_PLANNING_SOURCES, source) ? UW_PLANNING_SOURCES[source] : undefined;
    return this.read({ kind: descriptor?.probe } as UwPlanningReadRequest, signal);
  }

  async read(input: UwPlanningReadRequest, signal?: AbortSignal): Promise<UwPlanningReadResult> {
    const empty = { bytes: 0, elapsedMs: 0, schemaVerified: false as const };
    if (signal?.aborted) return { ...empty, status: "cancelled", code: "cancelled" };
    let request: UwPlanningRequestDescriptor;
    try { request = buildUwPlanningRequest(input); }
    catch (error) {
      return { ...empty, status: error instanceof UwPlanningInputError ? error.status : "invalid_schema",
        code: error instanceof UwPlanningInputError ? error.code : "invalid_request" };
    }
    const base = { ...empty, source: request.source, host: request.host };
    if ((this.queued.get(request.host) ?? 0) >= MAX_QUEUE_PER_HOST)
      return { ...base, status: "error", code: "host_queue_full" };
    this.queued.set(request.host, (this.queued.get(request.host) ?? 0) + 1);
    const previous = this.tails.get(request.host) ?? Promise.resolve();
    const operation = previous.then(async () => {
      if (signal?.aborted) return { ...base, status: "cancelled" as const, code: "cancelled" };
      return this.perform(request, signal);
    });
    const tail = operation.then(() => {}, () => {}).finally(() => {
      this.queued.set(request.host, (this.queued.get(request.host) ?? 1) - 1);
      if (this.tails.get(request.host) === tail) this.tails.delete(request.host);
    });
    this.tails.set(request.host, tail);
    try { return await abortable(operation, signal); }
    catch { return { ...base, status: signal?.aborted ? "cancelled" : "error", code: signal?.aborted ? "cancelled" : "transport_failure" }; }
  }

  private async perform(request: UwPlanningRequestDescriptor, signal?: AbortSignal): Promise<UwPlanningReadResult> {
    const base = { source: request.source, host: request.host, bytes: 0, elapsedMs: 0, schemaVerified: false as const };
    const key = `${request.method} ${request.url} ${request.body ?? ""}`;
    const cached = this.negative.get(key);
    if (cached && cached.until > this.now())
      return { ...base, status: "unsupported", code: "endpoint_unsupported", httpStatus: cached.status, cached: true };
    this.negative.delete(key);
    const suppressed = (this.suppressedUntil.get(request.host) ?? 0) - this.now();
    if (suppressed > 0)
      return { ...base, status: "rate_limited", code: "host_rate_limited", retryAfterMs: suppressed, cached: true };

    const wait = Math.max(0, (this.nextStart.get(request.host) ?? 0) - this.now());
    try { await abortable((this.options.sleep ?? delay)(wait, signal), signal); }
    catch { return { ...base, status: signal?.aborted ? "cancelled" : "error", code: signal?.aborted ? "cancelled" : "pacing_failed" }; }
    if (signal?.aborted) return { ...base, status: "cancelled", code: "cancelled" };
    const started = this.now();
    this.nextStart.set(request.host, started + this.spacing);
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), this.timeout);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
    let response: Response | undefined;
    let bytes = 0;
    const metadata = (): ResultMetadata => ({ ...base, ...(response ? { httpStatus: response.status } : {}), bytes, elapsedMs: Math.max(0, this.now() - started) });
    const fail = (status: UwPlanningFailureStatus, code: string): UwPlanningReadResult => ({ ...metadata(), status, code });
    try {
      const origin = origins[request.source];
      response = await abortable(this.options.fetch(request.url, {
        method: request.method,
        ...(request.body === undefined ? {} : { body: request.body }),
        credentials: "include",
        redirect: "manual",
        headers: {
          Accept: "application/json",
          Referer: `${origin}/`,
          Origin: origin,
          "X-Requested-With": "XMLHttpRequest",
          ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        signal: requestSignal,
      }), requestSignal);
      if (response.status === 401) return fail("needs_sign_in", "unauthorized");
      // A forbidden response is not evidence of expiry (UW also uses it for request policy).
      if (response.status === 403) return fail("forbidden", "forbidden");
      if (response.status === 429) {
        const waitMs = retryAfter(response.headers.get("retry-after"), this.now());
        this.suppressedUntil.set(request.host, this.now() + waitMs);
        return { ...metadata(), status: "rate_limited", code: "host_rate_limited", retryAfterMs: waitMs };
      }
      if ([404, 405, 501].includes(response.status)) {
        for (const [entry, value] of this.negative) if (value.until <= this.now()) this.negative.delete(entry);
        if (this.negative.size >= MAX_NEGATIVE_ENTRIES) this.negative.delete(this.negative.keys().next().value!);
        this.negative.set(key, { until: this.now() + this.negativeTtl, status: response.status });
        return fail("unsupported", "endpoint_unsupported");
      }
      if ((response.status >= 300 && response.status < 400) || response.redirected || response.type === "opaqueredirect") {
        const login = loginLocation(response.headers.get("location"), request.url) || loginLocation(response.url, request.url);
        return fail(login || response.type === "opaqueredirect" ? "needs_sign_in" : "invalid_schema", login ? "login_redirect" : "unexpected_redirect");
      }
      if (response.url && response.url !== request.url) return fail("invalid_schema", "unexpected_response_url");
      if (!response.ok) return fail("error", "http_failure");
      if (/text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type") ?? ""))
        return fail("invalid_schema", "html_response");
      if (Number(response.headers.get("content-length")) > MAX_BYTES) return fail("invalid_schema", "response_byte_limit");
      let text = "";
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        try {
          while (true) {
            const chunk = await abortable(reader.read(), requestSignal);
            if (chunk.done) {
              try { text += decoder.decode(); }
              catch { return fail("invalid_schema", "invalid_encoding"); }
              break;
            }
            bytes += chunk.value.byteLength;
            if (bytes > MAX_BYTES) return fail("invalid_schema", "response_byte_limit");
            try { text += decoder.decode(chunk.value, { stream: true }); }
            catch { return fail("invalid_schema", "invalid_encoding"); }
          }
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      text = text.trim();
      if (/^</.test(text)) return fail("invalid_schema", "html_response");
      if (text.startsWith("/*") && text.endsWith("*/")) text = text.slice(2, -2).trim();
      try { return { ...metadata(), status: "ok", data: JSON.parse(text) as unknown }; }
      catch { return fail("invalid_schema", "invalid_json"); }
    } catch {
      return fail(signal?.aborted ? "cancelled" : "error", signal?.aborted ? "cancelled" : timeoutController.signal.aborted ? "request_timeout" : "transport_failure");
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      try { this.options.onMetric?.({ host: request.host, status: response?.status ?? null, bytes, elapsedMs: Math.max(0, this.now() - started) }); }
      catch { /* Metrics cannot change a read outcome. */ }
    }
  }
}
