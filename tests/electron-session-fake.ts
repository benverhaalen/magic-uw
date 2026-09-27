// owner: acquisition. Electron 44.4.5's session request code paths over node:http, for tests that
// cannot start Electron. Read from the shipped electron.exe's bundled lib:
// - ClientRequest (lib/browser/api/net-client-request.ts): with redirect "manual", a redirect is
//   emitted as "redirect"; unless followRedirect() is called during it, or the request is aborted,
//   the request dies with Error("Redirect was cancelled").
// - net.fetch / session.fetch (lib/common/api/net-fetch.ts, fetchWithSession): passes `redirect`
//   to the ClientRequest and listens only for "response" and "error".
// `route` maps a logical hostname (canvas.wisc.edu) to a local server's port; the jar holds the
// session's cookies per hostname and is sent only with credentials "include".
import { EventEmitter } from "node:events";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { sessionHopFetch, type SessionMessage, type SessionRequest } from "../packages/connectors/src/session-fetch";

export type Route = (hostname: string) => number;
export type Jar = Map<string, string>;
interface Options {
  url: string;
  method?: string;
  redirect: "manual" | "follow";
  credentials: "include" | "omit";
  headers?: Record<string, string>;
}
export class ElectronLikeRequest extends EventEmitter {
  private aborted = false;
  private request?: ReturnType<typeof httpRequest>;
  private response?: IncomingMessage;
  private followCallback?: () => void;
  private body?: string;
  constructor(
    private readonly route: Route,
    private readonly options: Options,
    private readonly jar: Jar,
  ) {
    super();
  }
  followRedirect() {
    if (!this.followCallback) throw new Error("followRedirect() called, but was not waiting for a redirect");
    this.followCallback();
  }
  end(chunk?: string) {
    this.body = chunk;
    this.start(this.options.url);
  }
  abort() {
    if (!this.aborted) process.nextTick(() => this.emit("abort"));
    this.aborted = true;
    this.die();
  }
  private die(error?: Error) {
    if (error) this.emit("error", error);
    this.request?.destroy();
    this.response?.destroy(error);
  }
  private start(url: string) {
    const target = new URL(url);
    const cookie = this.options.credentials === "include" ? this.jar.get(target.hostname) : undefined;
    this.request = httpRequest(
      {
        host: "127.0.0.1",
        port: this.route(target.hostname),
        path: target.pathname + target.search,
        method: this.options.method ?? "GET",
        headers: { ...this.options.headers, ...(cookie ? { cookie } : {}) },
      },
      (res) => {
        if (this.aborted) return void res.destroy();
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          if (this.options.redirect === "manual") {
            let follow = false;
            this.followCallback = () => (follow = true);
            try {
              this.emit("redirect", status, "GET", next, {});
            } finally {
              this.followCallback = undefined;
              if (!follow && !this.aborted) this.die(new Error("Redirect was cancelled"));
            }
            if (follow) this.start(next);
            return;
          }
          this.emit("redirect", status, "GET", next, {});
          return this.start(next);
        }
        this.response = res;
        this.emit("response", res);
      },
    );
    this.request.on("error", (error) => {
      if (!this.aborted) this.die(error);
    });
    this.request.end(this.body);
  }
}
/** An Electron IncomingMessage's surface over node's (headers without undefined values). */
export function electronMessage(res: IncomingMessage): SessionMessage {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) headers[name] = value;
  return {
    statusCode: res.statusCode ?? 0,
    headers,
    on(event: "data" | "end" | "error", listener: ((chunk: Uint8Array) => void) | (() => void) | ((error: Error) => void)) {
      res.on(event, listener);
      return this;
    },
  };
}
/** What main used before: Electron's session.fetch (fetchWithSession), redirect passed through. */
export function electronSessionFetch(route: Route, jar: Jar) {
  return (url: string, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => (headers[name] = value));
      const request = new ElectronLikeRequest(
        route,
        {
          url,
          method: init.method ?? "GET",
          redirect: init.redirect === "manual" ? "manual" : "follow",
          credentials: init.credentials === "omit" ? "omit" : "include",
          headers,
        },
        jar,
      );
      request.on("response", (res: IncomingMessage) => {
        const message = electronMessage(res);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            message.on("data", (chunk) => controller.enqueue(chunk));
            message.on("end", () => controller.close());
            message.on("error", (error) => controller.error(error));
          },
        });
        resolve(new Response(body, { status: message.statusCode }));
      });
      request.on("error", reject);
      request.end(typeof init.body === "string" ? init.body : undefined);
    });
}
/** What main uses now (main.ts sessionFetch): net.request in the session, redirect "manual". */
export function electronSessionHop(route: Route, jar: Jar) {
  return sessionHopFetch((url, init) => {
    const request = new ElectronLikeRequest(
      route,
      { url, method: init.method, redirect: "manual", credentials: "include", headers: init.headers },
      jar,
    );
    const surface: SessionRequest = {
      on(
        event: "redirect" | "response" | "error",
        listener:
          | ((statusCode: number, method: string, redirectUrl: string) => void)
          | ((message: SessionMessage) => void)
          | ((error: Error) => void),
      ) {
        if (event === "response") {
          const onMessage = listener as (message: SessionMessage) => void;
          request.on("response", (res: IncomingMessage) => onMessage(electronMessage(res)));
        } else request.on(event, listener);
        return surface;
      },
      abort: () => request.abort(),
      end: (chunk?: string) => request.end(chunk),
    };
    return surface;
  });
}
