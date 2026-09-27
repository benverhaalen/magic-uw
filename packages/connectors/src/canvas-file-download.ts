// owner: acquisition. A Canvas file's bytes through the student's app-owned Canvas session (RC3).
// Main calls this for a `source-fetch` whose URL is a course file download: the first hop carries
// the session; each redirect is followed here, inside main, only to a host `canvasFileHost` allows
// (see network.ts for the canvas-lms source lines), and every non-Canvas hop is fetched without
// cookies. The worker never sees a redirect target, a verifier or a token.
import { canvasFileHost, MaterialReadError, type CanvasFileHostClass } from "./network.ts";

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
  /** The app-owned Canvas session (cookies); used only for the Canvas origin. */
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
  return { "x-magic-cause": "network_error" };
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
