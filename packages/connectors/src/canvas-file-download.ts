// owner: acquisition. A Canvas file's bytes through the student's app-owned Canvas session (RC3).
// Main calls this for a `source-fetch` whose URL is a course file download: the first hop carries
// the session; each redirect is followed here, inside main, only to a host `canvasFileHost` allows
// (see network.ts for the canvas-lms source lines), and every non-Canvas hop is fetched without
// cookies. The worker never sees a redirect target, a verifier or a token.
import { canvasFileHost, MaterialReadError, readBounded, type CanvasFileHostClass } from "./network.ts";
import { classifyCanvasAuth } from "./canvas-http.ts";

/** `/courses/:cid/files/:id/download` on the Canvas origin, with only `download_frd`. */
export function canvasFileDownloadUrl(input: string, origin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    /%2f|%5c|%2e/i.test(url.pathname) ||
    !/^\/courses\/[1-9]\d{0,29}\/files\/[1-9]\d{0,29}\/download$/.test(url.pathname) ||
    [...url.searchParams.keys()].some((key) => key !== "download_frd")
  )
    return undefined;
  return url.href;
}
export function canvasFileDownloadPath(origin: string, courseId: string, fileId: string) {
  return `${origin}/courses/${courseId}/files/${fileId}/download?download_frd=1`;
}
export interface CanvasFileFetchDeps {
  origin: string;
  /** The app-owned Canvas session (cookies); used only for the Canvas origin. In the app this is
   * `sessionHopFetch` over net.request, never `session.fetch` (session-fetch.ts). */
  session(url: string, init: RequestInit): Promise<Response>;
  /** A cookie-less fetch for the files domain, inst-fs and signed S3 hops. */
  plain(url: string, init: RequestInit): Promise<Response>;
  signal?: AbortSignal;
  maxHops?: number;
}
export interface CanvasFileResult {
  response: Response;
  /** The class of the host that answered, for the trial log; never the host's URL. */
  hostClass: CanvasFileHostClass;
  hops: number;
}
export async function fetchCanvasFile(
  input: string,
  deps: CanvasFileFetchDeps,
): Promise<CanvasFileResult> {
  const first = canvasFileDownloadUrl(input, deps.origin);
  if (!first) throw new MaterialReadError("unsafe_url");
  let url = first,
    hostClass: CanvasFileHostClass = "canvas";
  const seen = new Set<string>();
  for (let hop = 0; hop <= (deps.maxHops ?? 5); hop++) {
    deps.signal?.throwIfAborted();
    if (seen.has(url)) throw new MaterialReadError("redirect_loop", { host: new URL(url).hostname });
    seen.add(url);
    const init: RequestInit = {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "*/*" },
      ...(deps.signal ? { signal: deps.signal } : {}),
    };
    let response: Response;
    try {
      response =
        hostClass === "canvas"
          ? await deps.session(url, { ...init, credentials: "include" })
          : await deps.plain(url, { ...init, credentials: "omit" });
    } catch (error) {
      if (deps.signal?.aborted) throw error;
      throw new MaterialReadError("network_error", { host: new URL(url).hostname });
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      let next: URL;
      try {
        next = new URL(location ?? "", url);
      } catch {
        throw new MaterialReadError("redirect_blocked", { host: new URL(url).hostname });
      }
      const nextClass = canvasFileHost(next.href, deps.origin);
      // A Canvas redirect to its own login page is a sign-in state, not a file host problem.
      if (nextClass === "canvas" && /^\/login(?:\/|$)/.test(next.pathname))
        throw new MaterialReadError("login_page");
      if (!nextClass) throw new MaterialReadError("redirect_blocked", { host: next.hostname });
      // Never go back to the Canvas origin (with cookies) from a non-Canvas hop.
      if (nextClass === "canvas" && hostClass !== "canvas")
        throw new MaterialReadError("redirect_blocked", { host: next.hostname });
      url = next.href;
      hostClass = nextClass;
      continue;
    }
    if (response.status === 401 && hostClass === "canvas") {
      await response.body?.cancel().catch(() => {});
      throw new MaterialReadError("login_page", { status: 401 });
    }
    // Canvas itself refusing the file: not available to this student, not a failure to retry;
    // a 403 is read as the API's are (classifyCanvasAuth: a rate limit or a login page is not a
    // refusal). A file host's 4xx stays http_error: an expired signed URL is signed again on the
    // next check, which starts at Canvas.
    if (hostClass === "canvas" && [403, 404, 410].includes(response.status)) {
      const verdict =
        response.status === 403
          ? classifyCanvasAuth(403, await readBounded(response, 64 * 1024, deps.signal).catch(() => ""))
          : "inaccessible";
      if (response.status !== 403) await response.body?.cancel().catch(() => {});
      if (verdict === "rate_limited") throw new MaterialReadError("http_error", { status: 429, host: new URL(url).hostname });
      if (verdict === "suspect") throw new MaterialReadError("login_page"); // no status: needs_sign_in
      throw new MaterialReadError("inaccessible", { status: response.status });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new MaterialReadError("http_error", {
        status: response.status,
        host: new URL(url).hostname,
      });
    }
    return { response, hostClass, hops: hop };
  }
  throw new MaterialReadError("redirect_limit", { host: new URL(url).hostname });
}
/** Main's answer for a failed file read: the cause crosses as headers, never the URL. */
export function causeHeaders(error: unknown): Record<string, string> {
  if (error instanceof MaterialReadError)
    return {
      "x-magic-cause": error.code,
      ...(error.detail.host ? { "x-magic-cause-host": error.detail.host } : {}),
      ...(error.detail.status ? { "x-magic-cause-status": String(error.detail.status) } : {}),
    };
  // main's time limit (AbortSignal.timeout) is its own cause, not a network error.
  if (error instanceof Error && error.name === "TimeoutError") return { "x-magic-cause": "timeout" };
  return { "x-magic-cause": "network_error" };
}
/** A failure worth another try in the same check: the connection, main's time limit, or a file
 * service that is briefly unavailable. A refusal, a missing file, a limit or sign-in is not. */
export function transientFileError(error: unknown): boolean {
  if (!(error instanceof MaterialReadError)) return false;
  if (error.code === "network_error" || error.code === "timeout") return true;
  return error.code === "http_error" && [408, 425, 429, 500, 502, 503, 504].includes(error.detail.status ?? 0);
}
/** The waits before the second and third tries of one file (ingestion's session download). */
export const FILE_RETRY_DELAYS_MS = [1_000, 4_000];
/** Runs one file read, again after each delay while the failure is transient; stops on abort. */
export async function retryTransientFile<T>(
  run: () => Promise<T>,
  options: { signal?: AbortSignal; delaysMs?: readonly number[]; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
): Promise<T> {
  const delays = options.delaysMs ?? FILE_RETRY_DELAYS_MS,
    sleep = options.sleep ?? abortableSleep;
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await run();
    } catch (error) {
      if (options.signal?.aborted || attempt >= delays.length || !transientFileError(error)) throw error;
      await sleep(delays[attempt]!, options.signal);
    }
  }
}
function abortableSleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}
/** The worker's side: turns main's cause headers back into the error. */
export function throwIfCause(response: Response) {
  const code = response.headers.get("x-magic-cause");
  if (!code) return;
  const host = response.headers.get("x-magic-cause-host") ?? undefined,
    status = Number(response.headers.get("x-magic-cause-status")) || undefined;
  throw new MaterialReadError(code, {
    ...(host ? { host } : {}),
    ...(status ? { status } : {}),
  });
}
