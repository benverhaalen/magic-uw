/**
 * How the gold crawler and our ingestion reach Canvas in the bench: GET-only reads through the
 * operator's signed-in bench browser (live), or a direct HTTP client to the synthetic replica
 * (dry run). Both expose the same small interface and count their requests.
 */
import http from "node:http";
import { Cdp, evaluate, loadResource, openPage, pageUrl, type PageHandle } from "./cdp";

export interface CanvasResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export interface CanvasDownload {
  status: number;
  contentType: string;
  bytes: Uint8Array;
}
export interface CanvasTransport {
  /** The Canvas origin URLs are written with (https://canvas.wisc.edu live). */
  readonly origin: string;
  get(url: string, signal?: AbortSignal): Promise<CanvasResponse>;
  download(url: string, signal?: AbortSignal): Promise<CanvasDownload>;
  requests(): number;
  close(): Promise<void>;
}

function assertOrigin(url: string, origin: string) {
  const parsed = new URL(url);
  if (parsed.origin !== origin) throw new Error(`bench transport: refusing a read outside ${origin}`);
  return parsed;
}

/**
 * Reads in a dedicated tab of the bench browser: the page's own `fetch` for API JSON (same-origin,
 * the browser attaches its session) and `Network.loadNetworkResource` for file bytes. Method is
 * always GET. The tab is opened on `<origin>/api/v1/users/self/profile` so fetches are same-origin.
 */
export async function browserTransport(wsUrl: string, origin: string): Promise<CanvasTransport & { page: PageHandle }> {
  const cdp = await Cdp.connect(wsUrl);
  const page = await openPage(cdp, `${origin}/api/v1/users/self/profile`);
  const landed = await pageUrl(cdp, page);
  if (new URL(landed).origin !== origin) {
    await cdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
    cdp.close();
    throw new Error("The bench browser is not signed in to Canvas (the profile read left the Canvas origin). Sign in again in the session window.");
  }
  let count = 0;
  return {
    origin,
    page,
    async get(url) {
      assertOrigin(url, origin);
      count++;
      return evaluate<CanvasResponse>(
        cdp,
        page,
        `fetch(${JSON.stringify(url)}, { method: "GET", credentials: "include", headers: { Accept: "application/json" } })
          .then(async (r) => ({ status: r.status, headers: Object.fromEntries(r.headers.entries()), body: await r.text() }))`,
      );
    },
    async download(url) {
      assertOrigin(url, origin);
      count++;
      const r = await loadResource(cdp, page, url);
      const type = Object.entries(r.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "application/octet-stream";
      return { status: r.status, contentType: type, bytes: r.bytes };
    },
    requests: () => count,
    async close() {
      await cdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
      cdp.close();
    },
  };
}

/**
 * The dry run's client: HTTP to the replica, optionally through the bench proxy (absolute-form
 * requests), with the synthetic session cookie. `origin` is how URLs are written (for our ingestion
 * that is https://canvas.wisc.edu); `target` is where the replica listens. The replica renders its
 * absolute links with `x-bench-public-origin`, as Canvas renders its own origin.
 */
export function replicaTransport(options: { origin: string; target: string; cookie: string; proxy?: string }): CanvasTransport {
  let count = 0;
  const target = new URL(options.target);
  const proxy = options.proxy ? new URL(options.proxy) : undefined;
  function request(url: string, signal?: AbortSignal): Promise<{ status: number; headers: Record<string, string>; bytes: Buffer }> {
    const parsed = new URL(url);
    const real = new URL(parsed.pathname + parsed.search, target);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: proxy?.hostname ?? real.hostname,
          port: Number(proxy?.port ?? real.port),
          method: "GET",
          path: proxy ? real.href : real.pathname + real.search,
          headers: {
            host: real.host,
            cookie: options.cookie,
            accept: "application/json",
            "x-bench-public-origin": options.origin,
          },
          signal,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")])),
              bytes: Buffer.concat(chunks),
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
    });
  }
  return {
    origin: options.origin,
    async get(url, signal) {
      assertOrigin(url, options.origin);
      count++;
      const r = await request(url, signal);
      return { status: r.status, headers: r.headers, body: r.bytes.toString("utf8") };
    },
    async download(url, signal) {
      let next = assertOrigin(url, options.origin).href;
      for (let hop = 0; hop < 5; hop++) {
        count++;
        const r = await request(next, signal);
        if (r.status >= 300 && r.status < 400 && r.headers.location) {
          next = new URL(r.headers.location, next).href;
          if (new URL(next).origin !== options.origin) next = new URL(new URL(next).pathname + new URL(next).search, options.origin).href;
          continue;
        }
        return { status: r.status, contentType: r.headers["content-type"] ?? "application/octet-stream", bytes: r.bytes };
      }
      return { status: 508, contentType: "text/plain", bytes: new Uint8Array() };
    },
    requests: () => count,
    async close() {},
  };
}

/** Link-header pagination: the rel="next" URL, if any. */
export function nextLink(headers: Record<string, string>): string | undefined {
  const link = Object.entries(headers).find(([k]) => k.toLowerCase() === "link")?.[1];
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (m) return m[1];
  }
  return undefined;
}
