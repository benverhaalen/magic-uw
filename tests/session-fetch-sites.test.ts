// owner: acquisition. Every main-process read in an app-owned session, before and after the
// session-fetch.ts fix, over local servers (electron-session-fake.ts follows Electron 44.4.5's
// ClientRequest and session.fetch code). Before: session.fetch with redirect "manual" rejected every
// redirect, so a signed-out 302 to a login page reached each caller as a transport failure. After:
// each caller sees the redirect and decides with its own rules; no redirect target is contacted.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { CanvasFailure, CanvasHttp, canvasProfilePath, canvasProfileSignedOut } from "../packages/connectors/src/canvas-http";
import { checkSpaceAccess, type AccessTransport, type CourseSpace } from "../packages/connectors/src/canvas-inventory";
import { sessionSourceResult, type SessionSourceService } from "../packages/connectors/src/session-fetch";
import { UwPlanningHttp } from "../packages/connectors/src/uw-planning-http";
import { electronSessionFetch, electronSessionHop, type Jar } from "./electron-session-fake";

const canvas = "https://canvas.wisc.edu";
type Seen = { host: string; method: string; path: string; cookie: boolean; body: string; origin?: string; referer?: string };
type Answer = { status: number; headers: Record<string, string>; body: string };
type Handler = (req: IncomingMessage, path: string, body: string) => Answer;
const answer = (status: number, headers: Record<string, string> = {}, body = ""): Answer => ({ status, headers, body });
const redirect = (location: string) => answer(302, { location });
const signedIn = (req: IncomingMessage) => /session=student/.test(req.headers.cookie ?? "");
const json = (value: unknown) => answer(200, { "content-type": "application/json" }, JSON.stringify(value));
const handlers: Record<string, Handler> = {
  "canvas.wisc.edu": (req, path) => {
    if (!signedIn(req)) return redirect(`${canvas}/login/saml`);
    if (path.startsWith(canvasProfilePath)) return json({ id: "42", name: "Synthetic Student" });
    return json([]);
  },
  "mediaspace.wisc.edu": (req) =>
    signedIn(req)
      ? answer(200, { "content-type": "text/html" }, "<h1>Video</h1>")
      : redirect("https://login.wisc.edu/idp/profile/SAML2/Redirect/SSO?SAMLRequest=x"),
  "enroll.wisc.edu": (req, path) => {
    if (!signedIn(req)) return redirect("https://login.wisc.edu/idp/profile/SAML2/Redirect/SSO");
    if (path === "/api/enroll/v1/current/1272") return redirect("https://enroll.wisc.edu/api/enroll/v2/current/1272");
    return json({ studentInfo: { synthetic: true } });
  },
  "public.enroll.wisc.edu": (req, _path, body) => json({ method: req.method, body: JSON.parse(body || "null") }),
  "login.wisc.edu": () => answer(200, {}, "<title>Log in</title><input type=password>"),
};
async function rig() {
  const seen: Seen[] = [];
  const servers = new Map<string, Server>();
  for (const [host, handler] of Object.entries(handlers)) {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        const path = req.url ?? "/";
        seen.push({
          host, method: req.method ?? "", path, cookie: !!req.headers.cookie, body,
          ...(req.headers.origin ? { origin: req.headers.origin } : {}),
          ...(req.headers.referer ? { referer: req.headers.referer } : {}),
        });
        const reply = handler(req, path, body);
        res.writeHead(reply.status, reply.headers).end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.set(host, server);
  }
  const route = (host: string) => {
    const server = servers.get(host);
    if (!server) throw new Error(`no route to ${host}`);
    return (server.address() as AddressInfo).port;
  };
  return {
    seen,
    route,
    close: async () => {
      for (const server of servers.values()) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
type Rig = Awaited<ReturnType<typeof rig>>;
const code = (result: Awaited<ReturnType<UwPlanningHttp["read"]>>) => ("code" in result ? result.code : undefined);
const signedInJar = (): Jar =>
  new Map(["canvas.wisc.edu", "mediaspace.wisc.edu", "enroll.wisc.edu", "public.enroll.wisc.edu"].map((h) => [h, "session=student"]));
const fetches = (r: Rig, jar: Jar) => ({
  before: electronSessionFetch(r.route, jar),
  after: electronSessionHop(r.route, jar),
});
/** main's source-fetch for a session service (main.ts: fetch, sessionSourceResult, post) and the
 * worker's side (worker.ts sourceFetch: an error reply rejects, a result becomes a Response). */
function sourceFetch(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, service: SessionSourceService) {
  return async (url: string, init?: RequestInit) => {
    let result;
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        credentials: "include",
        redirect: "manual",
        headers: { Accept: service === "canvas" ? "application/json+canvas-string-ids" : "text/html" },
        ...(init?.signal ? { signal: init.signal } : {}),
      });
      result = await sessionSourceResult(response, url, service);
    } catch {
      throw new Error("Source read unavailable"); // main posted { error: true }
    }
    return new Response(result.body, { status: result.status, headers: result.headers });
  };
}

test("Canvas API reads (main.ts source-fetch): a signed-out 302 to /login is needs_sign_in, not a transport error", async () => {
  const r = await rig();
  try {
    const { before, after } = fetches(r, new Map());
    const old = new CanvasHttp({ fetch: sourceFetch(before, "canvas"), origin: canvas });
    await assert.rejects(old.request(`${canvas}/api/v1/courses?per_page=100`), (error: unknown) => {
      assert.ok(!(error instanceof CanvasFailure && error.status === "needs_sign_in"));
      return true;
    });
    assert.equal(old.needsSignIn, false, "reproduction: the sign-in state never followed");

    const http = new CanvasHttp({ fetch: sourceFetch(after, "canvas"), origin: canvas });
    await assert.rejects(http.request(`${canvas}/api/v1/courses?per_page=100`), (error: unknown) =>
      error instanceof CanvasFailure && error.status === "needs_sign_in",
    );
    assert.equal(http.needsSignIn, true);
    // main's own check on a sync's profile read (Remember my sign-in's automatic sign-in).
    const profile = await sourceFetch(after, "canvas")(`${canvas}${canvasProfilePath}`);
    assert.equal(
      canvasProfileSignedOut(
        { status: profile.status, body: await profile.text(), contentType: profile.headers.get("content-type"), location: profile.headers.get("location"), url: profile.url },
        canvas,
      ),
      true,
    );
    assert.equal(profile.headers.get("location"), `${canvas}/login/saml`, "origin and path only");
    assert.ok(!r.seen.some((s) => s.host === "login.wisc.edu"));
  } finally {
    await r.close();
  }
});

test("Canvas API reads: signed in, JSON arrives as before", async () => {
  const r = await rig();
  try {
    const http = new CanvasHttp({ fetch: sourceFetch(fetches(r, signedInJar()).after, "canvas"), origin: canvas });
    const profile = await http.request(`${canvas}${canvasProfilePath}`);
    assert.deepEqual(profile.data, { id: "42", name: "Synthetic Student" });
    assert.ok(r.seen.every((s) => s.cookie));
  } finally {
    await r.close();
  }
});

test("Kaltura and space checks (main.ts source-fetch 'space'): a redirect to UW login is needs-uw-signin", async () => {
  const r = await rig();
  try {
    const space: CourseSpace = {
      id: "s1", courseId: "4242", kind: "video", host: "mediaspace.wisc.edu",
      url: "https://mediaspace.wisc.edu/media/Lecture+1/1_abc", foundIn: "module_item", foundAt: "1",
      route: "uw_session", treatment: "link", label: "Lecture 1", readState: "linked", jev: false,
      access: { state: "unknown", checkedAt: null, action: "none" },
    };
    // ingestion.ts sessionTransport over the worker's spaceFetch.
    const transport = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): AccessTransport => async (url, signal) => {
      const response = await sourceFetch(fetchImpl, "space")(url, signal ? { signal } : {});
      return { status: response.status, location: response.headers.get("location"), body: await response.text().catch(() => "") };
    };
    const check = (session: AccessTransport) =>
      checkSpaceAccess([space], { session, now: () => new Date("2026-09-27T12:00:00Z"), canvas: () => ({ state: "readable" }) });
    const { before, after } = fetches(r, new Map());
    const [old] = await check(transport(before));
    assert.deepEqual([old!.access.state, old!.access.reason], ["blocked", "unreachable"], "reproduction");
    const [fixed] = await check(transport(after));
    assert.deepEqual([fixed!.access.state, fixed!.access.reason, fixed!.access.action], ["needs-uw-signin", "redirected_to_sign_in", "sign_in_app_window"]);
    assert.ok(!r.seen.some((s) => s.host === "login.wisc.edu"), "the login host is never requested");
  } finally {
    await r.close();
  }
});

test("sign-in window profile check (main.ts): a redirect is 'not yet signed in', not a failed check", async () => {
  const r = await rig();
  try {
    // main.ts did-finish-load: confirmed only by an ok JSON profile with a numeric id.
    const check = async (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) => {
      const response = await fetchImpl(`${canvas}${canvasProfilePath}`, {
        method: "GET", credentials: "include", redirect: "manual",
        headers: { Accept: "application/json+canvas-string-ids" }, signal: AbortSignal.timeout(10_000),
      });
      const text = response.ok ? await response.text() : "";
      const profile = text ? (JSON.parse(text) as { id?: unknown }) : {};
      return { status: response.status, confirmed: response.ok && /^\d+$/.test(String(profile.id ?? "")) };
    };
    const signedOut = fetches(r, new Map());
    await assert.rejects(check(signedOut.before), /Redirect was cancelled/, "reproduction: signin.check-failed");
    assert.deepEqual(await check(signedOut.after), { status: 302, confirmed: false });
    assert.deepEqual(await check(fetches(r, signedInJar()).after), { status: 200, confirmed: true });
  } finally {
    await r.close();
  }
});

test("UW planning reads (uw-planning-http.ts over main's session): sign-in, redirects, a POST with its body", async () => {
  const r = await rig();
  const planning = (fetchImpl: (url: string, init: RequestInit) => Promise<Response>) =>
    new UwPlanningHttp({ fetch: fetchImpl, minSpacingMs: 0, sleep: async () => {} });
  try {
    const signedOut = fetches(r, new Map());
    const old = await planning(signedOut.before).read({ kind: "student-info" });
    assert.deepEqual([old.status, code(old)], ["error", "transport_failure"], "reproduction");
    const fixed = await planning(signedOut.after).read({ kind: "student-info" });
    assert.deepEqual([fixed.status, code(fixed)], ["needs_sign_in", "login_redirect"]);

    const http = planning(fetches(r, signedInJar()).after);
    const info = await http.read({ kind: "student-info" });
    assert.equal(info.status, "ok");
    // A redirect that is not a sign-in is not followed: the planning boundary reads fixed URLs only.
    const moved = await http.read({ kind: "current-enrollment", term: "1272" });
    assert.deepEqual([moved.status, code(moved)], ["invalid_schema", "unexpected_redirect"]);
    assert.ok(!r.seen.some((s) => s.path.startsWith("/api/enroll/v2/")), "the redirect target is never contacted");
    const search = await http.read({
      kind: "public-search", term: "1272", query: "calculus", page: 1, pageSize: 10, sort: "SCORE",
      filters: { subjectCode: "600", enrollmentStatus: [] },
    });
    assert.equal(search.status, "ok", JSON.stringify(search));
    const posted = r.seen.find((s) => s.host === "public.enroll.wisc.edu")!;
    assert.equal(posted.method, "POST");
    assert.equal(JSON.parse(posted.body).queryString, "calculus");
    assert.equal(posted.origin, "https://public.enroll.wisc.edu");
    assert.equal(posted.referer, "https://public.enroll.wisc.edu/");
    assert.ok(!r.seen.some((s) => s.host === "login.wisc.edu"));
  } finally {
    await r.close();
  }
});
