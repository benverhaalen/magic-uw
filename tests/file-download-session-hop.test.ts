// owner: acquisition. Course files through main's Canvas session, reproduced over local HTTP
// servers: a Canvas-like origin, a 302 to the files domain, a signed inst-fs URL, a large body
// and a slow body. The live run of 2026-09-27 had 386 of 386 downloads fail as network_error:
// main used `session.fetch(url, { redirect: "manual" })`, which in Electron 44.4.5 rejects every
// redirect with "Redirect was cancelled" instead of returning the 3xx (read from the shipped
// electron.exe's bundled lib, and run there against a local 302). `ElectronLikeRequest` below
// follows that ClientRequest code path; `electronSessionFetch` follows its net.fetch wrapper.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SourceHealth } from "@magic/contracts";
import { createStore } from "@magic/storage";
import {
  causeHeaders,
  fetchCanvasFile,
  retryTransientFile,
  sessionHopFetch,
  throwIfCause,
  transientFileError,
  type SessionMessage,
} from "../packages/connectors/src/canvas-file-download";
import { itemSchema, pageSchema } from "../packages/connectors/src/canvas-models";
import { causeFromError } from "../packages/connectors/src/document-causes";
import { MaterialReadError } from "../packages/connectors/src/network";
import { ACQUISITION_APP, createIngestion } from "../apps/desktop/src/ingestion";
import { buildCourses } from "../apps/desktop/src/renderer/sources/model";
import { syntheticDocumentTerm } from "../evals/perf/documents";

const origin = "https://canvas.wisc.edu";
const FILES_DOMAIN = "a1-9.cluster1.canvas-user-content.com";
const INST_FS = "inst-fs-iad-prod.inscloudgate.net";
const download = (id: string) => `${origin}/courses/101/files/${id}/download?download_frd=1`;
const BIG = Buffer.alloc(12 * 1024 * 1024);
for (let i = 0; i < BIG.length; i += 4096) BIG.writeUInt32LE(i, i);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Seen = { host: string; path: string; cookie: string | null };
interface Rig {
  seen: Seen[];
  closed: string[];
  port(host: string): number;
  close(): Promise<void>;
}
/** Three local servers standing in for canvas.wisc.edu, the files domain and inst-fs. */
async function rig(): Promise<Rig> {
  const seen: Seen[] = [],
    closed: string[] = [];
  const servers = new Map<string, Server>();
  const serve = async (host: string, handler: (req: IncomingMessage, res: ServerResponse, path: string) => void) => {
    const server = createServer((req, res) => {
      const path = req.url ?? "/";
      seen.push({ host, path, cookie: req.headers.cookie ?? null });
      req.socket.once("close", () => closed.push(`${host}${path}`));
      handler(req, res, path);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.set(host, server);
  };
  const slow = async (res: ServerResponse, bytes: Buffer, chunk: number, pauseMs: number, stallAfter?: number) => {
    res.writeHead(200, { "content-type": "application/pdf", "content-length": String(bytes.length) });
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      if (res.destroyed) return;
      if (stallAfter !== undefined && offset >= stallAfter) return; // never finishes
      res.write(bytes.subarray(offset, offset + chunk));
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    res.end();
  };
  await serve("canvas.wisc.edu", (req, res, path) => {
    if (!/canvas_session=student/.test(req.headers.cookie ?? ""))
      return void res.writeHead(302, { location: `${origin}/login/saml` }).end();
    const id = /^\/courses\/101\/files\/(\d+)\/download/.exec(path)?.[1];
    if (id === "403") return void res.writeHead(403, { "content-type": "text/html" }).end("<h1>Unauthorized</h1><p>You don't have access to this file.</p>");
    if (id === "429") return void res.writeHead(403, { "content-type": "text/plain" }).end("403 Forbidden (Rate Limit Exceeded)\n");
    if (id === "31") return void res.writeHead(403, { "content-type": "text/html" }).end('<title>Log In to Canvas</title><form action="/login/canvas"><input type="password"></form>');
    if (id === "404") return void res.writeHead(404, { "content-type": "text/html" }).end("<h1>Page Not Found</h1>");
    if (id === "77") return void slow(res, BIG, 64 * 1024, 5, 256 * 1024); // served by Canvas itself, stalls
    const exp = id === "8" ? Date.now() - 60_000 : Date.now() + 60_000; // file 8: an already-expired signature
    res.writeHead(302, { location: `https://${FILES_DOMAIN}/files/${id}/download?download_frd=1&sf_verifier=v-${id}&exp=${exp}` }).end();
  });
  await serve(FILES_DOMAIN, (_req, res, path) => {
    const url = new URL(path, "https://x.invalid");
    const id = /^\/files\/(\d+)\/download$/.exec(url.pathname)?.[1];
    if (!id || url.searchParams.get("sf_verifier") !== `v-${id}`) return void res.writeHead(401).end();
    res.writeHead(302, { location: `https://${INST_FS}/files/u-${id}/reading.pdf?download=1&token=jwt.${url.searchParams.get("exp")}` }).end();
  });
  await serve(INST_FS, (_req, res, path) => {
    const url = new URL(path, "https://x.invalid");
    const exp = Number(url.searchParams.get("token")?.replace(/^jwt\./, ""));
    if (!(exp > Date.now())) return void res.writeHead(403, { "content-type": "application/json" }).end('{"error":"token expired"}');
    if (url.pathname === "/files/u-66/reading.pdf") return void slow(res, BIG, 64 * 1024, 5, 512 * 1024); // stalls
    void slow(res, BIG, 256 * 1024, 2); // 12 MB over ~50 chunks: large and slow, but it finishes
  });
  return {
    seen,
    closed,
    port: (host) => (servers.get(host)!.address() as AddressInfo).port,
    close: async () => {
      for (const server of servers.values()) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}

/** The Electron 44.4.5 ClientRequest redirect handling, over node:http to the rig's servers. */
class ElectronLikeRequest extends EventEmitter {
  private aborted = false;
  private request?: ReturnType<typeof httpRequest>;
  private response?: IncomingMessage;
  private followCallback?: () => void;
  constructor(
    private readonly r: Rig,
    private readonly options: { url: string; redirect: "manual" | "follow"; credentials: "include" | "omit"; headers?: Record<string, string> },
    private readonly jar: Map<string, string>,
  ) {
    super();
  }
  followRedirect() {
    if (!this.followCallback) throw new Error("followRedirect() called, but was not waiting for a redirect");
    this.followCallback();
  }
  end() {
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
        port: this.r.port(target.hostname),
        path: target.pathname + target.search,
        headers: { ...this.options.headers, ...(cookie ? { cookie } : {}) },
      },
      (res) => {
        if (this.aborted) return void res.destroy();
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          if (this.options.redirect === "manual") {
            // lib/browser/api/net-client-request.ts: an unfollowed manual redirect is cancelled.
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
    this.request.end();
  }
}
/** An Electron IncomingMessage's surface over node's (headers without undefined values). */
function electronMessage(res: IncomingMessage): SessionMessage {
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
/** Electron 44.4.5 net.fetch (lib/common/api/net-fetch.ts, fetchWithSession): it passes
 * `redirect` to the ClientRequest and listens only for "response" and "error". */
function electronSessionFetch(r: Rig, jar: Map<string, string>) {
  return (url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const request = new ElectronLikeRequest(
        r,
        { url, redirect: init.redirect === "manual" ? "manual" : "follow", credentials: "include" },
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
      request.end();
    });
}
/** The fix, as main wires it: net.request in the session, credentials included, redirect manual. */
function sessionHop(r: Rig, jar: Map<string, string>) {
  return sessionHopFetch((url, headers) => {
    const request = new ElectronLikeRequest(r, { url, redirect: "manual", credentials: "include", headers }, jar);
    const surface = {
      on(
        event: "redirect" | "response" | "error",
        listener:
          | ((statusCode: number, method: string, redirectUrl: string) => void)
          | ((message: SessionMessage) => void)
          | ((error: Error) => void),
      ) {
        if (event === "response")
          request.on("response", (res: IncomingMessage) => (listener as (message: SessionMessage) => void)(electronMessage(res)));
        else request.on(event, listener);
        return surface;
      },
      abort: () => request.abort(),
      end: () => request.end(),
    };
    return surface;
  });
}
/** Main's cookie-less hop: Node's fetch (redirect "manual" works there), to the rig's servers. */
function plain(r: Rig) {
  return (url: string, init: RequestInit) => {
    const target = new URL(url);
    return fetch(`http://127.0.0.1:${r.port(target.hostname)}${target.pathname}${target.search}`, init);
  };
}
const jar = () => new Map([["canvas.wisc.edu", "canvas_session=student"]]);
/** Main's handler, reduced: bytes on success, cause headers on failure; the worker's throwIfCause. */
async function throughMain(read: () => ReturnType<typeof fetchCanvasFile>) {
  try {
    const file = await read();
    return { bytes: new Uint8Array(await file.response.arrayBuffer()), hostClass: file.hostClass, hops: file.hops };
  } catch (error) {
    try {
      throwIfCause(new Response("", { status: 502, headers: causeHeaders(error) }));
    } catch (crossed) {
      return { error: crossed, outcome: causeFromError(crossed) };
    }
    throw error;
  }
}

test("reproduction: Electron's session.fetch with redirect manual fails every file as network_error", async () => {
  const r = await rig();
  try {
    const result = await throughMain(() =>
      fetchCanvasFile(download("9"), { origin, session: electronSessionFetch(r, jar()), plain: plain(r) }),
    );
    assert.ok("error" in result);
    assert.ok(result.error instanceof MaterialReadError);
    assert.equal(result.error.code, "network_error");
    assert.deepEqual(result.outcome, { cause: "network_error" }); // the stored diagnostic, path []
    // The redirect target was never reached: the file store is not refused, it is never asked.
    assert.deepEqual(r.seen.map((s) => s.host), ["canvas.wisc.edu"]);
  } finally {
    await r.close();
  }
});

test("fix: the session hop follows Canvas → files domain → signed inst-fs URL; a large slow body arrives whole", async () => {
  const r = await rig();
  try {
    const result = await throughMain(() =>
      fetchCanvasFile(download("9"), { origin, session: sessionHop(r, jar()), plain: plain(r) }),
    );
    assert.ok("bytes" in result, JSON.stringify(result));
    assert.equal(result.hostClass, "inst_fs");
    assert.equal(result.hops, 2);
    assert.equal(result.bytes.byteLength, BIG.byteLength);
    assert.equal(sha(result.bytes), sha(BIG));
    // Cookies only at Canvas; the signed URL's verifier and token reach their own hosts intact.
    assert.deepEqual(
      r.seen.map((s) => [s.host, s.cookie !== null]),
      [["canvas.wisc.edu", true], [FILES_DOMAIN, false], [INST_FS, false]],
    );
    assert.match(r.seen[1]!.path, /sf_verifier=v-9/);
    assert.match(r.seen[2]!.path, /token=jwt\.\d+/);
  } finally {
    await r.close();
  }
});

test("an expired signed URL is the file host's http_403: retried next check, never network_error or 'not available'", async () => {
  const r = await rig();
  try {
    const result = await throughMain(() =>
      fetchCanvasFile(download("8"), { origin, session: sessionHop(r, jar()), plain: plain(r) }),
    );
    assert.ok("error" in result);
    assert.deepEqual(result.outcome, { cause: "http_403" });
    assert.equal((result.error as MaterialReadError).code, "http_error");
    assert.equal(transientFileError(result.error), false);
  } finally {
    await r.close();
  }
});

test("Canvas refusing the file is 'not available to you'; its rate limit and login page are not", async () => {
  const r = await rig();
  try {
    const read = (id: string, cookies = jar()) =>
      throughMain(() => fetchCanvasFile(download(id), { origin, session: sessionHop(r, cookies), plain: plain(r) }));
    for (const [id, cause] of [["403", "http_403"], ["404", "http_404"]] as const) {
      const result = await read(id);
      assert.ok("error" in result);
      assert.equal((result.error as MaterialReadError).code, "inaccessible", id);
      assert.deepEqual(result.outcome, { cause });
    }
    const limited = await read("429");
    assert.ok("error" in limited);
    assert.equal(transientFileError(limited.error), true, "a rate limit is tried again");
    const loginPage = await read("31");
    assert.ok("error" in loginPage);
    assert.deepEqual(loginPage.outcome, { cause: "needs_sign_in" }, "a 403 carrying a login page is a sign-in state");
    const signedOut = await read("9", new Map());
    assert.ok("error" in signedOut);
    assert.deepEqual(signedOut.outcome, { cause: "needs_sign_in" });
  } finally {
    await r.close();
  }
});

test("a body slower than main's time limit is a timeout (transient), on either hop, and stops the request", async () => {
  const r = await rig();
  try {
    for (const id of ["66", "77"]) {
      // 66: inst-fs stalls (Node fetch); 77: Canvas serves the bytes itself and stalls (session hop).
      const result = await throughMain(() =>
        fetchCanvasFile(download(id), { origin, session: sessionHop(r, jar()), plain: plain(r), signal: AbortSignal.timeout(400) }),
      );
      assert.ok("error" in result, id);
      assert.deepEqual(result.outcome, { cause: "timeout" }, id);
      assert.equal(transientFileError(result.error), true);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(r.closed.some((c) => c.startsWith("canvas.wisc.edu/courses/101/files/77")), "the stalled session request was stopped");
  } finally {
    await r.close();
  }
});

test("retryTransientFile: transient failures back off and retry; a refusal or an abort does not", async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  let calls = 0;
  const value = await retryTransientFile(
    async () => {
      if (++calls < 3) throw new MaterialReadError(calls === 1 ? "network_error" : "timeout");
      return "bytes";
    },
    { sleep },
  );
  assert.equal(value, "bytes");
  assert.deepEqual(waits, [1_000, 4_000]);
  calls = 0;
  await assert.rejects(
    retryTransientFile(async () => {
      calls++;
      throw new MaterialReadError("http_error", { status: 503 });
    }, { sleep, delaysMs: [1, 1] }),
    (error: unknown) => error instanceof MaterialReadError && error.detail.status === 503,
  );
  assert.equal(calls, 3, "bounded: one try and two retries");
  calls = 0;
  await assert.rejects(
    retryTransientFile(async () => {
      calls++;
      throw new MaterialReadError("inaccessible", { status: 403 });
    }, { sleep }),
  );
  assert.equal(calls, 1);
  const controller = new AbortController();
  calls = 0;
  await assert.rejects(
    retryTransientFile(
      async () => {
        calls++;
        controller.abort();
        throw new MaterialReadError("network_error");
      },
      { signal: controller.signal, sleep },
    ),
  );
  assert.equal(calls, 1);
});

test("ingestion: a transient failure retries and the file gets text; a refused file is inaccessible", async () => {
  const directory = mkdtempSync(join(tmpdir(), "magic-session-hop-"));
  const store = createStore(":memory:");
  const term = syntheticDocumentTerm({ files: 10, latencyMs: 1, bandwidth: 1e9 });
  const refused = term.files[3]!.id,
    failedOnce = new Set<string>();
  let attempts = 0;
  const ingestion = createIngestion(store, {
    directory,
    now: () => new Date("2026-09-27T12:00:00Z"),
    secrets: async () => ({}),
    client: term.client,
    canvasFetch: async (url, init) => {
      const id = /\/files\/(\d+)\/download/.exec(url)?.[1];
      if (id && url.includes("/courses/")) {
        attempts++;
        if (id === refused)
          return new Response("", { status: 502, headers: causeHeaders(new MaterialReadError("inaccessible", { status: 403 })) });
        if (!failedOnce.has(id)) {
          failedOnce.add(id);
          return new Response("", { status: 502, headers: causeHeaders(new MaterialReadError("network_error", { host: "canvas.wisc.edu" })) });
        }
      }
      return term.canvasFetch(url, init);
    },
    acquisition: { ...ACQUISITION_APP, pool: false, ocrPagesPerRun: 0, downloadRetryMs: [1, 1] },
  });
  try {
    await ingestion.tick("manual");
    const readable = term.files.filter((f) => f.id !== refused && !f.name.startsWith("scan-"));
    const withText = new Set(
      store.resources().filter((r) => r.document && !r.deleted && r.text.trim()).map((r) => r.document!.fileId),
    );
    assert.deepEqual([...withText].sort(), readable.map((f) => f.id).sort());
    assert.equal(attempts, 9 * 2 + 1, "each file: one failure and one retry; the refused file once");
    const refusedSources = store.sources().filter((s) => s.scope === `file:${refused}` || s.scope === `document:${refused}`);
    assert.deepEqual(refusedSources.map((s) => s.status), ["inaccessible", "inaccessible"]);
    assert.ok(!store.sources().some((s) => s.diagnostics?.some((d) => d.code === "network_error")));
  } finally {
    await ingestion.closeExtraction();
    await ingestion.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Sources: a course's files show as one summary row, never one row per file", () => {
  const source = (scope: string, fields: Partial<SourceHealth> = {}): SourceHealth => ({
    id: `canvas:acct:c1:${scope}`, label: `Example Course 101 · ${scope}`, kind: "canvas", accountScope: "acct",
    courseId: "c1", scope, status: "ok", lastAttemptAt: "2026-09-27T09:30:00Z", lastSuccessAt: "2026-09-27T09:30:00Z",
    complete: true, resourceCount: 1, ...fields,
  });
  const failed = { status: "partial" as const, complete: false, diagnostics: [{ code: "network_error", path: [], severity: "warning" as const }] };
  const sources = [
    source("course"),
    source("assignments"),
    ...Array.from({ length: 40 }, (_, i) => String(i + 1)).flatMap((id) =>
      Number(id) <= 2
        ? [source(`file:${id}`), source(`document:${id}`)]
        : Number(id) === 3
          ? [source(`file:${id}`, { status: "inaccessible", complete: false }), source(`document:${id}`, { status: "inaccessible", complete: false })]
          : [source(`file:${id}`, failed), source(`document:${id}`, failed)],
    ),
  ];
  const [course] = buildCourses(sources);
  assert.ok(course);
  assert.equal(course.scopes.length, 3, course.scopes.map((s) => s.scope).join());
  const files = course.scopes.find((s) => s.scope === "course_files");
  assert.ok(files);
  assert.equal(files.state, "partial");
  assert.equal(course.state, "partial");
  assert.deepEqual(files.notes, [
    "2 of 40 files read. 1 file is not available to you. 37 files could not be read this time; they are tried again on the next check.",
  ]);
});

test("module items and pages: valid Canvas shapes the schema used to refuse", () => {
  // canvas-lms: a tool item with no matching tool has content_id 0; content_id and url can be null.
  const tool = itemSchema.parse({ id: 5, title: "Homework (WebAssign)", type: "ExternalTool", content_id: 0, external_url: null });
  assert.equal(tool.content_id, undefined);
  assert.equal(tool.external_url, undefined);
  assert.equal(itemSchema.parse({ id: 6, title: "Heading", type: "SubHeader", content_id: null }).content_id, undefined);
  assert.equal(itemSchema.parse({ id: 7, title: "Notes", type: "File", content_id: 5001 }).content_id, "5001");
  assert.throws(() => itemSchema.parse({ id: 8, title: "Bad", type: "File", content_id: -1 }));
  // A kept-script title keeps its Unicode and spaces in the slug (wiki_page.rb url_for).
  const page = { page_id: 1, title: "Page", body: null };
  for (const url of ["week-1-intro", "front-page-2", "カタカナ ページ", "Week_1.2%20notes"])
    assert.equal(pageSchema.parse({ ...page, url }).url, url);
  for (const url of ["", "a/b", "a?b", "a#b", "..\\x", " leading", "ctl\u0000"])
    assert.throws(() => pageSchema.parse({ ...page, url }), url);
});
