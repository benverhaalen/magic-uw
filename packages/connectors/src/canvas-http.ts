import type { CaptureBatch } from "@magic/contracts";

export type CanvasFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;
export type CanvasFailureStatus = Exclude<CaptureBatch["status"], "ok">;
export class CanvasFailure extends Error {
  constructor(
    readonly status: CanvasFailureStatus,
    readonly code: string = status,
  ) {
    super("Canvas read did not complete");
  }
}
export interface CanvasRate {
  requests: number;
  remaining?: number;
  cost?: number;
}
export interface CanvasHttpOptions {
  fetch: CanvasFetch;
  origin?: string;
  metadataConcurrency?: number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  requestTimeoutMs?: number;
  onRate?: (rate: CanvasRate) => void;
}
export function canvasOrigin(input = "https://canvas.wisc.edu"): string {
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
const apiPaths = [
  /^\/api\/v1\/users\/self\/(?:profile|todo|upcoming_events|activity_stream(?:\/summary)?)$/,
  /^\/api\/v1\/courses(?:\/[1-9]\d*)?$/,
  /^\/api\/v1\/courses\/[1-9]\d*\/(?:assignments|assignment_groups|modules|files|folders|quizzes|discussion_topics)$/,
  /^\/api\/v1\/courses\/[1-9]\d*\/pages(?:\/[a-zA-Z0-9_%.-]+)?$/,
  /^\/api\/v1\/courses\/[1-9]\d*\/modules\/[1-9]\d*\/items(?:\/[1-9]\d*)?$/,
  /^\/api\/v1\/announcements$/,
  /^\/api\/v1\/files\/[1-9]\d*$/,
  /^\/api\/v1\/courses\/[1-9]\d*\/students\/submissions$/,
];
const allowedQuery: Record<string, RegExp> = {
  per_page: /^100$/,
  page: /^[a-zA-Z0-9_:.,=-]{1,256}$/,
  "include[]":
    /^(?:syllabus_body|term|teachers|total_scores|concluded|calendar|submission|submission_comments|items|content_details)$/,
  enrollment_state: /^active$/,
  order_by: /^due_at$/,
  only_active_courses: /^true$/,
  "context_codes[]": /^course_[1-9]\d{0,29}$/,
  start_date: /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/,
  end_date: /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/,
};
export function checkedCanvasUrl(input: string, origin: string): string {
  let url: URL;
  try {
    url = new URL(input, origin);
  } catch {
    throw new CanvasFailure("partial", "invalid_api_url");
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    !apiPaths.some((pattern) => pattern.test(url.pathname)) ||
    /%2f|%5c|%2e/i.test(url.pathname)
  )
    throw new CanvasFailure("partial", "unsafe_api_url");
  const path = url.pathname;
  const allowedKeys = new Set<string>();
  if (
    !/\/(?:profile|files\/\d+|pages\/[^/]+)$/.test(path) &&
    !/^\/api\/v1\/courses\/\d+$/.test(path) &&
    !/\/items\/\d+$/.test(path)
  ) {
    allowedKeys.add("per_page");
    allowedKeys.add("page");
  }
  let includes: string[] = [];
  if (/^\/api\/v1\/courses(?:\/\d+)?$/.test(path)) {
    includes = [
      "syllabus_body",
      "term",
      "teachers",
      "total_scores",
      "concluded",
    ];
    if (path === "/api/v1/courses") allowedKeys.add("enrollment_state");
  } else if (/\/assignments$/.test(path)) {
    includes = ["submission"];
    allowedKeys.add("order_by");
  } else if (/\/modules$/.test(path)) includes = ["items", "content_details"];
  else if (/\/items(?:\/\d+)?$/.test(path)) includes = ["content_details"];
  else if (/\/students\/submissions$/.test(path))
    includes = ["submission_comments"];
  if (includes.length) allowedKeys.add("include[]");
  if (/\/activity_stream(?:\/summary)?$/.test(path))
    allowedKeys.add("only_active_courses");
  if (path === "/api/v1/announcements")
    for (const key of ["context_codes[]", "start_date", "end_date"])
      allowedKeys.add(key);
  for (const [key, value] of url.searchParams) {
    if (
      !allowedKeys.has(key) ||
      !allowedQuery[key]?.test(value) ||
      (key === "include[]" && !includes.includes(value))
    )
      throw new CanvasFailure("partial", "unsafe_api_query");
  }
  return url.toString();
}
export function canvasNextPage(
  link: string | null,
  current: string,
  initial: string,
  origin: string,
): string | null {
  if (!link) return null;
  let next: string | null = null;
  for (const entry of link.split(/,(?=\s*<)/)) {
    const match = entry.match(/^\s*<([^>]+)>\s*((?:;\s*[^;]+)*)\s*$/);
    if (!match) throw new CanvasFailure("partial", "invalid_pagination");
    const rel = match[2]!.match(/(?:^|;)\s*rel\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
    if (!(rel?.[1] ?? rel?.[2] ?? "").split(/\s+/).includes("next")) continue;
    if (next) throw new CanvasFailure("partial", "duplicate_next_page");
    const url = new URL(
      checkedCanvasUrl(new URL(match[1]!, current).toString(), origin),
    );
    const base = new URL(initial);
    if (url.pathname !== base.pathname)
      throw new CanvasFailure("partial", "pagination_scope_changed");
    for (const key of new Set(url.searchParams.keys())) {
      if (key === "page" || key === "per_page") continue;
      if (
        JSON.stringify(url.searchParams.getAll(key).sort()) !==
        JSON.stringify(base.searchParams.getAll(key).sort())
      )
        throw new CanvasFailure("partial", "pagination_query_changed");
    }
    for (const key of new Set(base.searchParams.keys())) {
      if (key !== "page" && !url.searchParams.has(key))
        for (const value of base.searchParams.getAll(key))
          url.searchParams.append(key, value);
    }
    url.searchParams.set("per_page", "100");
    next = checkedCanvasUrl(url.toString(), origin);
  }
  return next;
}
async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export async function canvasDelay(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!ms) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
async function bodyText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const max = 8 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > max)
    throw new CanvasFailure("partial", "response_byte_limit");
  if (!response.body) return "";
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let bytes = 0,
    text = "";
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > max)
        throw new CanvasFailure("partial", "response_byte_limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export class CanvasHttp {
  readonly origin: string;
  readonly rate: CanvasRate = { requests: 0 };
  private readonly auth = new AbortController();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  readonly concurrency: number;
  constructor(private readonly options: CanvasHttpOptions) {
    this.origin = canvasOrigin(options.origin);
    this.concurrency = Math.max(
      1,
      Math.min(16, Math.floor(options.metadataConcurrency ?? 8)),
    );
  }
  get needsSignIn() {
    return this.auth.signal.aborted;
  }
  private expire(): never {
    this.auth.abort();
    throw new CanvasFailure("needs_sign_in");
  }
  async request(
    input: string,
    signal?: AbortSignal,
    scopeStats?: { requests: number },
  ): Promise<{ data: unknown; link: string | null }> {
    const url = checkedCanvasUrl(input, this.origin);
    signal?.throwIfAborted();
    if (this.needsSignIn) throw new CanvasFailure("needs_sign_in");
    if (this.active >= this.concurrency)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      for (let attempt = 0; attempt <= 4; attempt++) {
        signal?.throwIfAborted();
        if (this.needsSignIn) throw new CanvasFailure("needs_sign_in");
        const random = Math.min(
          1,
          Math.max(0, this.options.random?.() ?? Math.random()),
        );
        await (this.options.sleep ?? canvasDelay)(
          (this.rate.remaining !== undefined && this.rate.remaining < 100
            ? 600
            : 0) +
            25 +
            random * 75,
          signal,
        );
        if (this.needsSignIn) throw new CanvasFailure("needs_sign_in");
        const requestSignal = AbortSignal.any([
          AbortSignal.timeout(this.options.requestTimeoutMs ?? 15_000),
          this.auth.signal,
          ...(signal ? [signal] : []),
        ]);
        this.rate.requests++;
        if (scopeStats) scopeStats.requests++;
        const response = await abortable(
          this.options.fetch(url, {
            method: "GET",
            credentials: "include",
            redirect: "manual",
            headers: { Accept: "application/json" },
            signal: requestSignal,
          }),
          requestSignal,
        );
        for (const [header, key] of [
          ["x-rate-limit-remaining", "remaining"],
          ["x-request-cost", "cost"],
        ] as const) {
          const raw = response.headers.get(header);
          if (raw !== null && Number.isFinite(Number(raw)) && Number(raw) >= 0)
            this.rate[key] = Number(raw);
        }
        this.options.onRate?.({ ...this.rate });
        if (
          response.status === 401 ||
          (response.status >= 300 && response.status < 400) ||
          response.redirected ||
          response.type === "opaqueredirect"
        )
          this.expire();
        if (
          response.url &&
          (new URL(response.url).origin !== this.origin ||
            new URL(response.url).pathname !== new URL(url).pathname)
        )
          this.expire();
        const type = response.headers.get("content-type") ?? "";
        if (
          response.status !== 403 &&
          response.status !== 429 &&
          /text\/html|application\/xhtml\+xml/i.test(type)
        )
          this.expire();
        const body = await bodyText(response, requestSignal);
        const limited =
          response.status === 429 ||
          (response.status === 403 &&
            /rate.?limit|too many requests|throttl/i.test(body));
        if (limited) {
          if (attempt === 4)
            throw new CanvasFailure("partial", "rate_limit_exhausted");
          const retry = response.headers.get("retry-after");
          const asked =
            retry === null
              ? NaN
              : /^\d+(?:\.\d+)?$/.test(retry)
                ? Number(retry) * 1000
                : Date.parse(retry) - Date.now();
          // A server can ask for longer than a foreground scope's budget. Keep it partial instead of retrying early.
          if (asked > 30_000)
            throw new CanvasFailure(
              "partial",
              "rate_limit_wait_exceeds_budget",
            );
          await (this.options.sleep ?? canvasDelay)(
            (Number.isFinite(asked)
              ? Math.max(0, asked)
              : Math.min(30_000, 1000 * 2 ** attempt)) +
              random * 250,
            signal,
          );
          continue;
        }
        if (
          response.status === 403 ||
          /text\/html|application\/xhtml\+xml/i.test(type) ||
          /^\s*</.test(body)
        )
          this.expire();
        if (response.status === 404 || response.status === 410)
          throw new CanvasFailure("inaccessible", "not_accessible");
        if (!response.ok) throw new CanvasFailure("error", "http_failure");
        if (!/application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|$)/i.test(type))
          throw new CanvasFailure("partial", "unexpected_content_type");
        try {
          return { data: JSON.parse(body), link: response.headers.get("link") };
        } catch {
          throw new CanvasFailure("partial", "invalid_json");
        }
      }
      throw new CanvasFailure("partial", "rate_limit_exhausted");
    } catch (error) {
      signal?.throwIfAborted();
      if (this.needsSignIn) throw new CanvasFailure("needs_sign_in");
      if (error instanceof Error && error.name === "TimeoutError")
        throw new CanvasFailure("partial", "request_time_limit");
      throw error;
    } finally {
      const waiting = this.waiting.shift();
      if (waiting) waiting();
      else this.active--;
    }
  }
}
