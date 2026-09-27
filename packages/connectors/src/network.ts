import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export class MaterialReadError extends Error {
  /** owner: acquisition. `host` is a hostname only (never a path or query); `status` an HTTP status. */
  constructor(
    readonly code: string,
    readonly detail: { host?: string; status?: number } = {},
  ) {
    super(code);
  }
}
// owner: acquisition. Where a Canvas file's bytes may be fetched from (RC3). Canvas answers a file
// download with a redirect chain (canvas-lms @1c9f0bb, app/helpers/attachment_helper.rb:197-241):
//   1. the Canvas origin, with the student's session (files_controller#send_stored_file);
//   2. the account's separate files domain, if configured (application_controller.rb:2703-2711,
//      lib/host_url.rb:82-90); Instructure-hosted Canvas uses *.canvas-user-content.com, and an
//      attachment-specific prefix "a<shard>-<id>." may be added (application_controller.rb:2707-2709);
//   3. inst-fs, when the attachment is inst-fs hosted (attachment.rb:973-976; lib/inst_fs.rb:71-75,
//      321-325, 348-356: "<app_host>/files/<uuid>/<name>?token=<jwt>&download=1"); Instructure's
//      app_host has the form inst-fs-<region>-<env>.inscloudgate.net (for example
//      ui/shared/dashboard-card/util/__tests__/instFSOptimizedImageUrl.test.js:29, "inst-fs-iad-beta");
//   4. a signed S3 URL for older, non-inst-fs attachments (attachment.rb:977-984, authenticated_s3_url).
// Only hop 1 carries Canvas cookies; every later hop is authorised by the capability in its own URL.
export type CanvasFileHostClass = "canvas" | "files_domain" | "inst_fs" | "s3_legacy";
export function canvasFileHost(
  input: string,
  canvasOrigin: string = DEFAULT_CANVAS_ORIGIN,
): CanvasFileHostClass | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443"))
    return undefined;
  if (url.origin === canvasOrigin) return "canvas";
  const host = url.hostname.toLowerCase();
  if (/^(?:[a-z0-9-]+\.)+canvas-user-content\.com$/.test(host)) return "files_domain";
  if (/^inst-fs-[a-z0-9]+-[a-z0-9]+\.inscloudgate\.net$/.test(host)) return "inst_fs";
  if (host === "instructure-uploads.s3.amazonaws.com") return "s3_legacy";
  return undefined;
}
/** The host of a URL, for a diagnostic; never the path or the query. */
export function hostOnly(input: string): string {
  try {
    return new URL(input).hostname.slice(0, 100);
  } catch {
    return "invalid";
  }
}
// end owner: acquisition
export interface PublicAddress {
  address: string;
  family: number;
}
export interface PinnedRequest {
  url: URL;
  address: PublicAddress;
  signal: AbortSignal;
  headers: Readonly<Record<string, string>>;
}
export interface PublicResponse {
  response: Response;
  url: string;
  redirects: string[];
  /** owner: acquisition. The server answered a conditional GET with 304. */
  notModified?: boolean;
}
export interface PublicClient {
  get(
    url: string,
    options?: {
      signal?: AbortSignal;
      maxBytes?: number;
      onRedirect?: (url: string) => boolean | Promise<boolean>;
      /** owner: acquisition. A conditional GET (T30's validators): a 304 returns `notModified: true`. */
      conditional?: FeedValidators;
    },
  ): Promise<PublicResponse>;
  text(
    url: string,
    options?: {
      signal?: AbortSignal;
      maxBytes?: number;
      onRedirect?: (url: string) => boolean | Promise<boolean>;
    },
  ): Promise<PublicResponse & { text: string }>;
  feed(
    secretUrl: string,
    canvasOrigin: string,
    signal?: AbortSignal,
  ): Promise<string>;
  /** Reads only a published Outlook calendar link; see isOutlookPublishedCalendar. */
  outlookFeed?(secretUrl: string, signal?: AbortSignal): Promise<string>;
  /**
   * owner: T30. The same read, conditional: sends If-None-Match / If-Modified-Since from the
   * previous answer; a 304 returns `notModified` with no body read.
   */
  outlookFeedIfChanged?(
    secretUrl: string,
    validators: FeedValidators,
    signal?: AbortSignal,
  ): Promise<{ notModified: true } | ({ notModified: false; text: string } & FeedValidators)>;
  signedDownload(
    url: string,
    allowedOrigins: string[],
    signal?: AbortSignal,
  ): Promise<PublicResponse>;
  isCanvas(url: string): boolean;
}
export const DEFAULT_CANVAS_ORIGIN = "https://canvas.wisc.edu";
/** HTTP validators a feed answered with; sent back on the next read (owner: T30). */
export interface FeedValidators {
  etag?: string;
  lastModified?: string;
}
const OUTLOOK_ORIGINS = new Set(["https://outlook.office365.com", "https://outlook.office.com"]);
/**
 * A published Outlook calendar link (Settings → Calendar → Shared calendars → Publish).
 * The link is a capability: it lives only in the encrypted vault, never in records.
 */
export function isOutlookPublishedCalendar(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    OUTLOOK_ORIGINS.has(url.origin) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    /^\/owa\/calendar\/[^/]+\/[^/]+\/(?:calendar|reachcalendar)\.ics$/.test(url.pathname)
  );
}
const secretKey =
  /token|auth|cookie|password|secret|signature|credential|api[-_]?key|verifier|^sig$|^key$|^policy$|^expires$|^x-amz-|^x-goog-/i;

/** This validator is also applied at each redirect; no URL supplied by content grants credentials. */
export function publicUrl(input: string, allowSecret = false): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new MaterialReadError("invalid_url");
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443" && url.port !== "80") ||
    (!allowSecret &&
      ([...url.searchParams.keys()].some((key) => secretKey.test(key)) ||
        /\/(?:feeds|calendar_feeds)\//i.test(url.pathname)))
  )
    throw new MaterialReadError("unsafe_url");
  url.hash = "";
  return url;
}
export function isPublicAddress(address: string): boolean {
  const plain = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(plain) === 4) {
    const [a, b, c] = plain.split(".").map(Number) as [number, number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 168 || b === 0 || (b === 88 && c === 99) || b === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Only global unicast; exclude documentation, transition, mapped and special-use ranges.
  if (isIP(plain) === 6)
    return (
      /^[23][0-9a-f]{3}:/.test(plain) &&
      !/^(?:2001:(?:0:|[012]?[0-9a-f]{1,2}:|db8:)|2002:|3fff:)/.test(plain)
    );
  return false;
}
export async function readBounded(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const advertised = Number(response.headers.get("content-length"));
  if (advertised > maxBytes) {
    await response.body?.cancel();
    throw new MaterialReadError("byte_limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      signal?.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new MaterialReadError("byte_limit");
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function pinnedTransport(input: PinnedRequest): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = (
      input.url.protocol === "https:" ? httpsRequest : httpRequest
    )(
      input.url,
      {
        method: "GET",
        agent: false,
        headers: input.headers,
        signal: input.signal,
        family: input.address.family,
        // The address was checked before opening the socket. Never resolve it again.
        lookup: (_hostname, _options, callback) =>
          callback(null, input.address.address, input.address.family),
      },
      (incoming) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined && name !== "set-cookie")
            headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        const status = incoming.statusCode ?? 502;
        const body = [204, 205, 304].includes(status)
          ? null
          : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        if (!body) incoming.resume();
        resolve(new Response(body, { status, headers }));
      },
    );
    request.on("error", () => reject(new MaterialReadError("network_error")));
    request.end();
  });
}
export function createPublicClient(
  options: {
    lookup?: (hostname: string) => Promise<PublicAddress[]>;
    transport?: (request: PinnedRequest) => Promise<Response>;
    canvasOrigins?: string[];
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): PublicClient {
  const lookup =
    options.lookup ??
    ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
  const transport = options.transport ?? pinnedTransport;
  const canvasOrigins = new Set(
    options.canvasOrigins ?? [DEFAULT_CANVAS_ORIGIN],
  );
  const hosts = new Map<string, { active: number; waiting: (() => void)[] }>();
  async function acquire(
    host: string,
    signal: AbortSignal,
  ): Promise<() => void> {
    let state = hosts.get(host);
    if (!state) {
      state = { active: 0, waiting: [] };
      hosts.set(host, state);
    }
    if (state.active >= 2)
      await new Promise<void>((resolve) => state!.waiting.push(resolve));
    else state.active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = state!.waiting.shift();
      if (next) next();
      else state!.active--;
    };
    if (signal.aborted) {
      release();
      signal.throwIfAborted();
    }
    return release;
  }
  function tracked(
    response: Response,
    release: () => void,
    signal: AbortSignal,
  ): Response {
    if (!response.body) {
      release();
      return response;
    }
    const reader = response.body.getReader();
    signal.addEventListener("abort", release, { once: true });
    const finish = () => {
      signal.removeEventListener("abort", release);
      release();
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            finish();
            controller.close();
          } else controller.enqueue(next.value);
        } catch {
          finish();
          controller.error(new MaterialReadError("network_error"));
        }
      },
      async cancel() {
        try {
          await reader.cancel();
        } finally {
          finish();
        }
      },
    });
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  }
  const isCanvas = (input: string) => {
    try {
      return canvasOrigins.has(new URL(input).origin);
    } catch {
      return false;
    }
  };
  async function get(
    input: string,
    settings: {
      signal?: AbortSignal;
      onRedirect?: (url: string) => boolean | Promise<boolean>;
      /** owner: T30: conditional request headers; a 304 is then returned, not thrown. */
      conditional?: FeedValidators;
    } = {},
    mode: "public" | "feed" | "signed" = "public",
    allowedOrigins: string[] = [],
  ): Promise<PublicResponse> {
    const signal = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? 20_000),
      ...(settings.signal ? [settings.signal] : []),
    ]);
    let url = publicUrl(input, mode !== "public");
    const redirects: string[] = [];
    const visited = new Set<string>();
    for (let step = 0; step <= 5; step++) {
      signal.throwIfAborted();
      if (visited.has(url.href)) throw new MaterialReadError("redirect_loop");
      visited.add(url.href);
      if (mode === "public" && isCanvas(url.href))
        throw new MaterialReadError("canvas_route_required");
      if (
        mode !== "public" &&
        (!allowedOrigins.includes(url.origin) || url.protocol !== "https:")
      )
        throw new MaterialReadError("secret_origin_blocked", { host: url.hostname });
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await lookup(hostname);
      if (
        !addresses.length ||
        addresses.some((address) => !isPublicAddress(address.address))
      )
        throw new MaterialReadError("non_public_address");
      const release = await acquire(hostname, signal);
      let received: Response;
      try {
        received = await transport({
          url,
          address: addresses[0]!,
          signal,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; MagicCanvas/1.0; course-material reader)",
            Accept: "*/*",
            "Accept-Encoding": "identity",
            ...(settings.conditional?.etag ? { "If-None-Match": settings.conditional.etag } : {}),
            ...(settings.conditional?.lastModified
              ? { "If-Modified-Since": settings.conditional.lastModified }
              : {}),
          },
        });
      } catch {
        release();
        throw new MaterialReadError("network_error");
      }
      if (
        received.redirected ||
        (received.url && new URL(received.url).href !== url.href)
      ) {
        release();
        await received.body?.cancel();
        throw new MaterialReadError("transport_redirect");
      }
      const response = tracked(received, release, signal);
      if (response.status === 304 && settings.conditional) {
        await response.body?.cancel();
        return { response, url: url.href, redirects, notModified: true }; // owner: acquisition
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || step === 5 || mode === "feed") {
          let host = url.hostname;
          try {
            if (location) host = new URL(location, url).hostname;
          } catch {}
          throw new MaterialReadError("redirect_blocked", { host });
        }
        const target = publicUrl(
          new URL(location, url).href,
          mode === "signed",
        );
        if (settings.onRedirect && !(await settings.onRedirect(target.href)))
          throw new MaterialReadError("redirect_outside_scope");
        if (mode === "public" && isCanvas(target.href))
          throw new MaterialReadError("canvas_route_required");
        redirects.push(target.href);
        url = target;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new MaterialReadError(
          response.status === 401 || response.status === 403
            ? "inaccessible"
            : response.status === 404 || response.status === 410
              ? "not_found"
              : "http_error",
          { status: response.status, host: url.hostname }, // owner: acquisition
        );
      }
      return { response, url: url.href, redirects };
    }
    throw new MaterialReadError("redirect_limit");
  }
  return {
    get: (url, settings) => get(url, settings),
    async text(url, settings) {
      const result = await get(url, settings);
      return {
        ...result,
        text: await readBounded(
          result.response,
          settings?.maxBytes ?? options.maxBytes ?? 8 * 1024 * 1024,
          settings?.signal,
        ),
      };
    },
    async feed(secretUrl, canvasOrigin, signal) {
      const url = publicUrl(secretUrl, true);
      if (
        !canvasOrigins.has(canvasOrigin) ||
        url.origin !== canvasOrigin ||
        !/^\/feeds\/calendars\/[^/]+\.ics$/.test(url.pathname)
      )
        throw new MaterialReadError("invalid_feed");
      const result = await get(secretUrl, { signal }, "feed", [canvasOrigin]);
      const text = await readBounded(result.response, 8 * 1024 * 1024, signal);
      if (!/^\s*BEGIN:VCALENDAR\r?\n/i.test(text))
        throw new MaterialReadError("invalid_calendar");
      return text;
    },
    async outlookFeed(secretUrl, signal) {
      if (!isOutlookPublishedCalendar(secretUrl))
        throw new MaterialReadError("invalid_feed");
      const origin = new URL(secretUrl).origin;
      const result = await get(secretUrl, { signal }, "feed", [origin]);
      const text = await readBounded(result.response, 8 * 1024 * 1024, signal);
      if (!/^\s*BEGIN:VCALENDAR\r?\n/i.test(text))
        throw new MaterialReadError("invalid_calendar");
      return text;
    },
    async outlookFeedIfChanged(secretUrl, validators, signal) {
      if (!isOutlookPublishedCalendar(secretUrl))
        throw new MaterialReadError("invalid_feed");
      const origin = new URL(secretUrl).origin;
      const result = await get(secretUrl, { signal, conditional: validators }, "feed", [origin]);
      if (result.response.status === 304) return { notModified: true };
      const text = await readBounded(result.response, 8 * 1024 * 1024, signal);
      if (!/^\s*BEGIN:VCALENDAR\r?\n/i.test(text))
        throw new MaterialReadError("invalid_calendar");
      const etag = result.response.headers.get("etag")?.slice(0, 500);
      const lastModified = result.response.headers.get("last-modified")?.slice(0, 100);
      return {
        notModified: false,
        text,
        ...(etag ? { etag } : {}),
        ...(lastModified ? { lastModified } : {}),
      };
    },
    signedDownload: (url, allowedOrigins, signal) =>
      get(url, { signal }, "signed", allowedOrigins),
    isCanvas,
  };
}
