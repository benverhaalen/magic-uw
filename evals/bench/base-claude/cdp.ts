/**
 * A minimal Chrome DevTools Protocol client (Node 24's WebSocket) and a Chrome launcher for the
 * bench's own browser: a fresh temporary profile, never the personal one. Reads go through the page
 * (`fetch` in a Canvas tab, so the browser attaches its own session) or `Network.loadNetworkResource`
 * (follows the file-host redirect the way a browser download does). This code never reads,
 * stores or logs a cookie value.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Handler = (params: Record<string, unknown>, sessionId?: string) => void;

export class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve(v: Record<string, unknown>): void; reject(e: Error): void }>();
  private handlers = new Map<string, Set<Handler>>();
  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number; result?: Record<string, unknown>; error?: { message?: string };
        method?: string; params?: Record<string, unknown>; sessionId?: string;
      };
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(`CDP: ${message.error.message ?? "error"}`));
        else waiter?.resolve(message.result ?? {});
      } else if (message.method) {
        for (const handler of this.handlers.get(message.method) ?? []) handler(message.params ?? {}, message.sessionId);
      }
    });
    ws.addEventListener("close", () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }
  static async connect(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`CDP: cannot connect to ${wsUrl}`)), { once: true });
    });
    return new Cdp(ws);
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: Record<string, unknown>) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(method: string, handler: Handler): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }
  close() {
    this.ws.close();
  }
}

/** Chrome or Edge on this machine; BENCH_CHROME overrides. */
export function findChrome(): string | undefined {
  const candidates = [
    process.env.BENCH_CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  return candidates.find((c): c is string => !!c && existsSync(c));
}

export interface LaunchedBrowser {
  process: ChildProcess;
  port: number;
  /** The browser-level websocket (for Target.* and Playwright MCP's --cdp-endpoint http URL). */
  wsUrl: string;
  httpEndpoint: string;
  close(): Promise<void>;
}

export async function launchChrome(options: {
  executable: string;
  userDataDir: string;
  headless: boolean;
  /** http://127.0.0.1:<port>: every request, loopback included, goes through the bench proxy. */
  proxy?: string;
  /** base64 SHA-256 of the proxy certificate's SPKI: Chrome accepts only that certificate's errors. */
  spki?: string;
  startUrl?: string;
}): Promise<LaunchedBrowser> {
  const args = [
    `--user-data-dir=${options.userDataDir}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-component-update",
    "--disable-features=Translate,OptimizationHints,MediaRouter",
    "--password-store=basic",
    ...(options.headless ? ["--headless=new"] : []),
    ...(options.proxy ? [`--proxy-server=${options.proxy}`, "--proxy-bypass-list=<-loopback>"] : []),
    ...(options.spki ? [`--ignore-certificate-errors-spki-list=${options.spki}`] : []),
    options.startUrl ?? "about:blank",
  ];
  const child = spawn(options.executable, args, { stdio: "ignore", detached: false });
  const portFile = join(options.userDataDir, "DevToolsActivePort");
  let port = 0;
  for (let i = 0; i < 300 && !port; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (existsSync(portFile)) port = Number(readFileSync(portFile, "utf8").split("\n")[0]) || 0;
    if (child.exitCode !== null) throw new Error(`Chrome exited during start (code ${child.exitCode})`);
  }
  if (!port) {
    child.kill();
    throw new Error("Chrome did not open its DevTools port within 30 s");
  }
  const httpEndpoint = `http://127.0.0.1:${port}`;
  const version = (await (await fetch(`${httpEndpoint}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  return {
    process: child,
    port,
    wsUrl: version.webSocketDebuggerUrl,
    httpEndpoint,
    async close() {
      if (child.exitCode !== null) return;
      try {
        const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
        await cdp.send("Browser.close").catch(() => {});
        cdp.close();
      } catch {}
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

export interface PageHandle {
  targetId: string;
  sessionId: string;
  frameId: string;
}

/** A new tab at `url`, attached (flattened session), after its load event. */
export async function openPage(cdp: Cdp, url: string): Promise<PageHandle> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  const loaded = new Promise<void>((resolve) => {
    const off = cdp.on("Page.loadEventFired", (_p, sid) => {
      if (sid === sessionId) {
        off();
        resolve();
      }
    });
    setTimeout(() => {
      off();
      resolve();
    }, 60_000);
  });
  await cdp.send("Page.navigate", { url }, sessionId);
  await loaded;
  const tree = await cdp.send<{ frameTree: { frame: { id: string; url: string } } }>("Page.getFrameTree", {}, sessionId);
  return { targetId, sessionId, frameId: tree.frameTree.frame.id };
}

export async function pageUrl(cdp: Cdp, page: PageHandle): Promise<string> {
  const tree = await cdp.send<{ frameTree: { frame: { url: string } } }>("Page.getFrameTree", {}, page.sessionId);
  return tree.frameTree.frame.url;
}

/** Evaluates an expression in the page and returns its JSON value. */
export async function evaluate<T>(cdp: Cdp, page: PageHandle, expression: string): Promise<T> {
  const result = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    page.sessionId,
  );
  if (result.exceptionDetails)
    throw new Error(`page: ${result.exceptionDetails.exception?.description?.split("\n")[0] ?? result.exceptionDetails.text}`);
  return result.result.value as T;
}

/** A browser-network read (follows redirects; cookies only where the browser would send them). */
export async function loadResource(
  cdp: Cdp,
  page: PageHandle,
  url: string,
): Promise<{ status: number; headers: Record<string, string>; bytes: Uint8Array }> {
  const { resource } = await cdp.send<{
    resource: { success: boolean; httpStatusCode?: number; netErrorName?: string; stream?: string; headers?: Record<string, string> };
  }>("Network.loadNetworkResource", { frameId: page.frameId, url, options: { disableCache: true, includeCredentials: true } }, page.sessionId);
  if (!resource.success || !resource.stream)
    return { status: resource.httpStatusCode ?? 0, headers: resource.headers ?? {}, bytes: new Uint8Array() };
  const chunks: Buffer[] = [];
  for (;;) {
    const chunk = await cdp.send<{ data: string; base64Encoded?: boolean; eof: boolean }>(
      "IO.read", { handle: resource.stream, size: 1 << 20 }, page.sessionId,
    );
    chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
    if (chunk.eof) break;
  }
  await cdp.send("IO.close", { handle: resource.stream }, page.sessionId).catch(() => {});
  return { status: resource.httpStatusCode ?? 200, headers: resource.headers ?? {}, bytes: Buffer.concat(chunks) };
}

/** Closes every tab and leaves one blank one: a clean slate between runs (cookies stay). */
export async function resetTabs(cdp: Cdp): Promise<void> {
  const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
  const pages = targetInfos.filter((t) => t.type === "page");
  await cdp.send("Target.createTarget", { url: "about:blank" });
  for (const page of pages) await cdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
}

/** Drops the HTTP cache (not cookies), so a later run gets no warm-cache advantage. */
export async function clearCache(cdp: Cdp): Promise<void> {
  const page = await openPage(cdp, "about:blank");
  try {
    await cdp.send("Network.enable", {}, page.sessionId);
    await cdp.send("Network.clearBrowserCache", {}, page.sessionId);
  } finally {
    await cdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
  }
}
