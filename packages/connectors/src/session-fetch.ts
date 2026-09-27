// owner: acquisition. Every read main makes in an app-owned Electron session (persist:uw,
// persist:gitlab) that must see a redirect instead of following it.
//
// `session.fetch(url, { redirect: "manual" })` does not return the 3xx the Fetch standard
// describes: Electron 44.4.5's net.fetch hands `redirect` to a ClientRequest and never listens for
// its "redirect" event, and ClientRequest cancels an unfollowed redirect with the error "Redirect
// was cancelled" (both read from the shipped electron.exe's bundled lib, and run there against a
// local 302). So every redirect became a rejected fetch:
// - course file downloads (always a redirect): 386 of 386 failed as network_error, 2026-09-27;
// - Canvas API, Kaltura and space reads: a signed-out 302 to /login was a transport error, so the
//   sign-in state (and Remember my sign-in's automatic sign-in) never followed from it;
// - the sign-in window's profile check and the UW planning reads: the same, for their redirects.
// `sessionHopFetch` drives net.request itself: a redirect becomes a 3xx Response carrying only its
// target, the request stops before the next host is contacted, and each caller keeps deciding
// what a redirect means with its own rules (host allowlists, sign-in detection).
import { readBounded } from "./network.ts";

/** The part of an Electron `ClientRequest` (net.request) a session read uses. */
export interface SessionRequest {
  on(event: "redirect", listener: (statusCode: number, method: string, redirectUrl: string) => void): unknown;
  on(event: "response", listener: (message: SessionMessage) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  abort(): void;
  end(chunk?: string): void;
}
/** The part of an Electron `IncomingMessage` a session read uses. */
export interface SessionMessage {
  statusCode: number;
  headers: Record<string, string | string[]>;
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}
/** What `open` receives: the method and the request headers, lower-cased by name. */
export interface SessionRequestInit {
  method: string;
  headers: Record<string, string>;
}
/**
 * A fetch in an app-owned session that answers a redirect with its status and `location` instead
 * of following it. `open` makes one request in the session (credentials included, redirect
 * "manual", the given method and headers); it is called once per call. A body must be a string.
 */
export function sessionHopFetch(open: (url: string, init: SessionRequestInit) => SessionRequest) {
  return (url: string, init: RequestInit = {}): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const signal = init.signal ?? undefined;
      if (signal?.aborted) return reject(signal.reason);
      if (init.body != null && typeof init.body !== "string")
        return reject(new TypeError("A session read sends only a string body"));
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => (headers[name] = value));
      const request = open(url, { method: (init.method ?? "GET").toUpperCase(), headers });
      let settled = false,
        body: ReadableStreamDefaultController<Uint8Array> | undefined,
        ended = false;
      const settle = (response: Response) => {
        if (settled) return;
        settled = true;
        resolve(response);
      };
      const fail = (error: unknown) => {
        if (!settled) {
          settled = true;
          reject(error);
        } else if (body && !ended) {
          ended = true;
          body.error(error);
        }
      };
      const onAbort = () => {
        fail(signal!.reason);
        request.abort();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => signal?.removeEventListener("abort", onAbort);
      request.on("redirect", (statusCode, _method, redirectUrl) => {
        // Not following it here (no followRedirect call) and aborting stops the request before
        // the next host is contacted; ClientRequest skips its cancel error once aborted.
        done();
        settle(new Response(null, { status: statusCode, headers: { location: redirectUrl } }));
        request.abort();
      });
      request.on("response", (message) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(message.headers))
          if (name !== "set-cookie") responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        const status = message.statusCode;
        if ([101, 204, 205, 304].includes(status)) {
          done();
          settle(new Response(null, { status, headers: responseHeaders }));
          return;
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
          },
          cancel() {
            ended = true;
            done();
            request.abort();
          },
        });
        message.on("data", (chunk) => {
          if (!ended) body!.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        });
        message.on("end", () => {
          done();
          if (!ended) {
            ended = true;
            body!.close();
          }
        });
        message.on("error", (error) => {
          done();
          fail(error);
        });
        settle(new Response(stream, { status, headers: responseHeaders }));
      });
      request.on("error", (error) => {
        done();
        fail(error);
      });
      request.end(typeof init.body === "string" ? init.body : undefined);
    });
}

/** The services main's `source-fetch` answers from a session (not graph, not a file download). */
export type SessionSourceService = "canvas" | "gitlab" | "kaltura" | "space";
export interface SessionSourceResult {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: string;
}
/**
 * What main sends the worker for one session read: the status, a fixed set of headers, a bounded
 * body, and for a redirect only its target's origin and path (never the query), so the Canvas
 * reader can tell a sign-in redirect from any other.
 */
export async function sessionSourceResult(
  response: Response,
  target: string,
  service: SessionSourceService,
  signal?: AbortSignal,
): Promise<SessionSourceResult> {
  // owner: T05b: a space check needs only the status and a bounded start of the page.
  const body =
    service === "space"
      ? await readBounded(response, 256 * 1024, signal).catch(() => "")
      : await readBounded(response, 8 * 1024 * 1024, signal);
  const headers = Object.fromEntries(
    ["content-type", "link", "retry-after", "x-request-cost", "x-rate-limit-remaining", "x-next-page"].flatMap(
      (key) => (response.headers.has(key) ? [[key, response.headers.get(key)!]] : []),
    ),
  );
  // owner: T05c (lead integration). Only the redirect target's origin and path cross.
  const moved = response.headers.get("location");
  if (moved) {
    try {
      const to = new URL(moved, target);
      headers.location = to.origin + to.pathname;
    } catch {}
  }
  return { status: response.status, url: response.url, headers, body };
}
