/**
 * The bench browser's read-only proxy. HTTPS is intercepted (the bench browser trusts only this
 * proxy's certificate, by SPKI pin, for its own temporary profile) so method and path are visible.
 *
 * Phases:
 * - signin: the operator signs in. Any method to the sign-in hosts; Canvas POST only to /login paths
 *   (the SAML consumer); everything else GET/HEAD.
 * - locked (after the dashboard loads): GET/HEAD only, everywhere. Canvas POST /api/graphql passes only
 *   when the body is a query (no `mutation`). LTI launches, quiz take and logout are blocked in every
 *   phase and method. Unlisted hosts get GET/HEAD for static assets only.
 *
 * The log records method, host, path (no query string), status, bytes, time and any block reason.
 * Never bodies, headers or cookies. Upstream TLS is verified with the system CAs.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";

export type Phase = "signin" | "locked";
export interface ProxyPolicy {
  /** host or host:port of Canvas. */
  canvasHosts: string[];
  /** Hosts the operator signs in through (UW NetID, Duo, Instructure's SSO relay). */
  loginHosts: Array<string | RegExp>;
  /** Canvas's file and asset hosts (GET/HEAD). */
  fileHosts: Array<string | RegExp>;
}
/** canvas.wisc.edu's hosts, from the app's own sign-in allowlist (main.ts allowedLogin) and file hosts (network.ts). */
export const UW_POLICY: ProxyPolicy = {
  canvasHosts: ["canvas.wisc.edu"],
  loginHosts: [/(^|\.)wisc\.edu$/, "sso.canvaslms.com", /(^|\.)duosecurity\.com$/],
  fileHosts: [
    /(^|\.)instructure\.com$/, /(^|\.)canvas-user-content\.com$/, /(^|\.)inscloudgate\.net$/,
    "instructure-uploads.s3.amazonaws.com", /(^|\.)cloudfront\.net$/, /(^|\.)instructuremedia\.com$/,
  ],
};
const BLOCKED_PATHS: Array<[RegExp, string]> = [
  [/\/external_tools(\/|$)/, "lti_launch"],
  [/sessionless_launch/, "lti_launch"],
  [/\/lti\//, "lti_launch"],
  [/\/quizzes\/\d+\/take(\/|$)/, "quiz_take"],
  [/\/quizzes\/\d+\/submissions/, "quiz_take"],
  [/^\/logout(\/|$)/, "logout"],
];
const ASSET = /\.(js|mjs|css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|webp|map)$/i;

export interface ProxyEntry {
  t: string; run: string; method: string; host: string; path: string; status?: number; bytes?: number; ms?: number; blocked?: string;
}
export interface RunCounters { requests: number; blocked: number; bytes: number; blockedByReason: Record<string, number> }

export interface ProxyCert { key: string; cert: string; spki: string }

/** A self-signed certificate for the interception (openssl), cached in `dir`. */
export function proxyCertificate(dir: string): ProxyCert {
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, "proxy-key.pem"), certPath = join(dir, "proxy-cert.pem");
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    const openssl = findOpenssl();
    if (!openssl) throw new Error("openssl was not found (install it, or put Git for Windows' usr/bin on PATH); it makes the proxy's certificate.");
    execFileSync(openssl, [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "30",
      "-keyout", keyPath, "-out", certPath, "-subj", "/CN=magic-bench-proxy",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], { stdio: "ignore" });
  }
  const cert = readFileSync(certPath, "utf8");
  const der = new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" });
  return { key: readFileSync(keyPath, "utf8"), cert, spki: createHash("sha256").update(der).digest("base64") };
}
function findOpenssl(): string | undefined {
  const candidates = [
    process.env.BENCH_OPENSSL,
    "C:/Program Files/Git/usr/bin/openssl.exe",
    "C:/Program Files/Git/mingw64/bin/openssl.exe",
    "/usr/bin/openssl",
    "/opt/homebrew/bin/openssl",
    "/usr/local/bin/openssl",
  ];
  const found = candidates.find((c): c is string => !!c && existsSync(c));
  if (found) return found;
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return "openssl";
  } catch {
    return undefined;
  }
}

const matches = (host: string, list: Array<string | RegExp>) => list.some((p) => (typeof p === "string" ? p === host : p.test(host)));

export function decide(
  policy: ProxyPolicy,
  phase: Phase,
  request: { method: string; host: string; path: string; body?: string; accept?: string; dest?: string },
): string | undefined {
  const method = request.method.toUpperCase();
  const hostOnly = request.host.replace(/:\d+$/, "");
  const canvas = policy.canvasHosts.includes(request.host) || policy.canvasHosts.includes(hostOnly);
  for (const [pattern, reason] of BLOCKED_PATHS) if (pattern.test(request.path)) return reason;
  const read = method === "GET" || method === "HEAD";
  const login = matches(hostOnly, policy.loginHosts) && !canvas;
  const file = matches(hostOnly, policy.fileHosts);
  if (phase === "signin") {
    if (login) return undefined;
    if (canvas) return read || /^\/login(\/|$)/.test(request.path) ? undefined : "write_during_signin";
    if (file) return read ? undefined : "write";
    return read && (ASSET.test(request.path) || ["script", "style", "font", "image"].includes(request.dest ?? "")) ? undefined : read ? "host_not_allowed" : "write";
  }
  if (canvas) {
    if (read) return undefined;
    if (method === "POST" && request.path === "/api/graphql" && request.body !== undefined && !/\bmutation\b/i.test(request.body)) return undefined;
    return "write";
  }
  if (!read) return "write";
  if (login || file) return undefined;
  return ASSET.test(request.path) || ["script", "style", "font", "image"].includes(request.dest ?? "") ? undefined : "host_not_allowed";
}

export interface BenchProxy extends EventEmitter {
  port: number;
  controlPort: number;
  phase(): Phase;
  setPhase(phase: Phase): void;
  mark(run: string): void;
  counters(run?: string): RunCounters;
  close(): Promise<void>;
}

export async function startProxy(options: {
  policy: ProxyPolicy;
  cert: ProxyCert;
  log?: string;
  phase?: Phase;
  /** Extra CAs to trust upstream (the dry run's own HTTPS test server only). */
  upstreamCa?: string[];
}): Promise<BenchProxy> {
  const emitter = new EventEmitter() as BenchProxy;
  let phase: Phase = options.phase ?? "signin";
  let run = "idle";
  const counters = new Map<string, RunCounters>();
  const counter = (label: string) => {
    let c = counters.get(label);
    if (!c) counters.set(label, (c = { requests: 0, blocked: 0, bytes: 0, blockedByReason: {} }));
    return c;
  };
  const record = (entry: Omit<ProxyEntry, "t" | "run">) => {
    const full: ProxyEntry = { t: new Date().toISOString(), run, ...entry };
    const c = counter(run);
    c.requests++;
    c.bytes += entry.bytes ?? 0;
    if (entry.blocked) {
      c.blocked++;
      c.blockedByReason[entry.blocked] = (c.blockedByReason[entry.blocked] ?? 0) + 1;
    }
    if (options.log) appendFileSync(options.log, JSON.stringify(full) + "\n");
    emitter.emit("entry", full);
  };
  const secureContext = tls.createSecureContext({ key: options.cert.key, cert: options.cert.cert });
  const targets = new WeakMap<net.Socket, string>();
  const upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 32, ...(options.upstreamCa ? { ca: [...tls.rootCertificates, ...options.upstreamCa] } : {}) });
  const plainAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });

  function handle(req: http.IncomingMessage, res: http.ServerResponse, secureHost?: string) {
    const started = performance.now();
    let target: URL;
    try {
      target = secureHost ? new URL(req.url ?? "/", `https://${secureHost}`) : new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const host = target.host;
    const path = target.pathname;
    const method = req.method ?? "GET";
    const dest = String(req.headers["sec-fetch-dest"] ?? "");
    const forward = (body?: Buffer) => {
      const headers = { ...req.headers };
      for (const h of ["proxy-connection", "proxy-authorization", "connection", "keep-alive", "upgrade", "te", "trailer"]) delete headers[h];
      headers.host = host;
      const client = target.protocol === "https:" ? https : http;
      const upstream = client.request(
        {
          protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80),
          method, path: target.pathname + target.search, headers, agent: target.protocol === "https:" ? upstreamAgent : plainAgent,
          servername: target.hostname,
        },
        (up) => {
          let bytes = 0;
          up.on("data", (chunk: Buffer) => (bytes += chunk.length));
          up.on("end", () => {
            record({ method, host, path, status: up.statusCode, bytes, ms: Math.round(performance.now() - started) });
            if (phase === "signin" && method === "GET" && (options.policy.canvasHosts.includes(host) || options.policy.canvasHosts.includes(target.hostname)) &&
              (path === "/" || path === "/dashboard") && up.statusCode === 200 && /text\/html/.test(String(up.headers["content-type"] ?? "")))
              emitter.emit("dashboard");
          });
          const headersOut = { ...up.headers };
          delete headersOut["connection"];
          delete headersOut["keep-alive"];
          res.writeHead(up.statusCode ?? 502, headersOut);
          up.pipe(res);
        },
      );
      upstream.on("error", () => {
        record({ method, host, path, status: 502, bytes: 0, ms: Math.round(performance.now() - started) });
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end("bench proxy: upstream error");
      });
      if (body) upstream.end(body);
      else req.pipe(upstream);
    };
    const reject = (reason: string) => {
      record({ method, host, path, status: 403, bytes: 0, blocked: reason });
      req.resume();
      res.writeHead(403, { "content-type": "text/plain", "x-bench-blocked": reason });
      res.end(`Blocked by the bench's read-only proxy (${reason}). This benchmark is read-only.`);
    };
    const isGraphql = method === "POST" && path === "/api/graphql";
    if (isGraphql && phase === "locked") {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= 256 * 1024) chunks.push(c);
      });
      req.on("end", () => {
        const body = size <= 256 * 1024 ? Buffer.concat(chunks) : undefined;
        const reason = decide(options.policy, phase, { method, host, path, body: body?.toString("utf8"), dest });
        if (reason) return reject(reason);
        forward(body);
      });
      return;
    }
    const reason = decide(options.policy, phase, { method, host, path, dest });
    if (reason) return reject(reason);
    forward();
  }

  const inner = http.createServer((req, res) => handle(req, res, targets.get(req.socket as net.Socket)));
  inner.on("upgrade", (req, socket: net.Socket, head) => {
    const secureHost = targets.get(socket);
    const host = secureHost ?? new URL(req.url ?? "").host;
    const path = new URL(req.url ?? "/", `https://${host}`).pathname;
    const reason = decide(options.policy, phase, { method: "GET", host, path });
    if (reason) {
      record({ method: "GET", host, path, status: 403, blocked: reason });
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const [hostname, port] = host.split(":");
    const upstream = tls.connect({ host: hostname, port: Number(port ?? 443), servername: hostname, ...(options.upstreamCa ? { ca: [...tls.rootCertificates, ...options.upstreamCa] } : {}) }, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(req.headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`), "", ""];
      upstream.write(lines.join("\r\n"));
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
      record({ method: "GET", host, path, status: 101 });
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  const outer = http.createServer((req, res) => handle(req, res));
  outer.on("connect", (req, socket: net.Socket, head) => {
    const authority = req.url ?? "";
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext, ALPNProtocols: ["http/1.1"] });
    targets.set(secure, authority.endsWith(":443") ? authority.slice(0, -4) : authority);
    if (head.length) socket.unshift(head);
    secure.on("error", () => socket.destroy());
    inner.emit("connection", secure);
  });
  outer.on("clientError", (_e, socket) => socket.destroy());

  const control = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://control");
    if (url.pathname === "/state") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ phase, run, runs: Object.fromEntries(counters) }));
    }
    if (req.method === "POST" && url.pathname === "/mark") {
      run = url.searchParams.get("run") || "idle";
      counter(run);
      return res.writeHead(204).end();
    }
    if (req.method === "POST" && url.pathname === "/phase") {
      const to = url.searchParams.get("to");
      if (to === "signin" || to === "locked") phase = to;
      emitter.emit("phase", phase);
      return res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => outer.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  const port = (outer.address() as net.AddressInfo).port;
  const controlPort = (control.address() as net.AddressInfo).port;
  return Object.assign(emitter, {
    port,
    controlPort,
    phase: () => phase,
    setPhase(next: Phase) {
      phase = next;
      emitter.emit("phase", phase);
    },
    mark(label: string) {
      run = label;
      counter(label);
    },
    counters: (label?: string) => ({ ...counter(label ?? run) }),
    async close() {
      upstreamAgent.destroy();
      plainAgent.destroy();
      outer.closeAllConnections();
      inner.closeAllConnections();
      control.closeAllConnections();
      await Promise.all([outer, inner, control].map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
  });
}

/** The session holder's proxy, from another process: mark a run and read its counters. */
export const proxyControl = (controlPort: number) => ({
  async mark(run: string) {
    await fetch(`http://127.0.0.1:${controlPort}/mark?run=${encodeURIComponent(run)}`, { method: "POST" });
  },
  async state(): Promise<{ phase: Phase; run: string; runs: Record<string, RunCounters> }> {
    return (await fetch(`http://127.0.0.1:${controlPort}/state`)).json() as Promise<{ phase: Phase; run: string; runs: Record<string, RunCounters> }>;
  },
});
