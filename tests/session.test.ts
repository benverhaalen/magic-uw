import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CanvasFailure,
  CanvasHttp,
  canvasProfileSignedOut,
  classifyCanvasAuth,
} from "../packages/connectors/src/canvas-http";
import { canvasConnector } from "../packages/connectors/src/canvas";
import { createSyntheticCanvasUniversity } from "../packages/connectors/src/canvas-fixture";
import type { UwPlanningReadResult } from "../packages/connectors/src/uw-planning-http";
import {
  closeAction,
  defaultSessionSettings,
  hasCanvasSession,
  launchSession,
  loginItemSettings,
  parseSessionSettings,
  planningProbe,
  planningSessionConfirmed,
  readSessionSettings,
  singleFlight,
  trayBitmap,
  trayMenu,
  trayWanted,
  writeSessionSettings,
} from "../apps/desktop/src/keep-signed-in";
import { createStore } from "@magic/storage";
import type { CaptureBatch } from "@magic/contracts";

const origin = "https://canvas.synthetic.test";
const profile = `${origin}/api/v1/users/self/profile`;
const scope = `${origin}/api/v1/courses/42/assignments?per_page=100`;
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
const unauthenticated = () =>
  json({ status: "unauthenticated", errors: [{ message: "user authorization required" }] }, 401);
// A synthetic NetID-style login page (no real UW markup).
const loginPage =
  '<html><head><title>NetID Login</title></head><body><form action="/idp/profile/SAML2/Redirect/SSO"><input type="password" name="j_password"></form></body></html>';
const unauthorized = () =>
  json({ status: "unauthorized", errors: [{ message: "user not authorized to perform that action" }] }, 401);

function fakeCanvas(route: (path: string) => Response) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const http = new CanvasHttp({
    origin,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, init });
      await Promise.resolve();
      return route(path);
    },
    sleep: async () => {},
    random: () => 0,
  });
  const profileReads = () =>
    calls.filter((call) => call.path === "/api/v1/users/self/profile").length;
  return { http, calls, profileReads };
}
async function failure(promise: Promise<unknown>): Promise<CanvasFailure> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CanvasFailure, `expected CanvasFailure, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the read to fail");
}

test("classification table: status codes and the body status field", () => {
  const rows: Array<[number, string, ReturnType<typeof classifyCanvasAuth>]> = [
    [401, JSON.stringify({ status: "unauthenticated" }), "suspect"],
    [401, JSON.stringify({ status: "unauthorized" }), "inaccessible"],
    [401, "", "suspect"],
    [401, JSON.stringify({ errors: [{ message: "unauthorized" }] }), "suspect"],
    [403, JSON.stringify({ errors: [{ message: "Rate Limit Exceeded" }] }), "rate_limited"],
    [403, JSON.stringify({ message: "not authorized" }), "inaccessible"],
    [403, "", "inaccessible"],
    [403, loginPage, "suspect"],
    [429, "", "rate_limited"],
    [200, "[]", "pass"],
    [404, "", "pass"],
  ];
  for (const [status, body, verdict] of rows)
    assert.equal(classifyCanvasAuth(status, body), verdict, `${status} ${body}`);
});

test("profile confirmation table: what counts as signed out", () => {
  const rows: Array<[string, Parameters<typeof canvasProfileSignedOut>[0], boolean]> = [
    ["401 unauthenticated", { status: 401, body: JSON.stringify({ status: "unauthenticated" }) }, true],
    ["401 unauthorized", { status: 401, body: JSON.stringify({ status: "unauthorized" }) }, false],
    ["bare 401", { status: 401, body: "" }, false],
    ["200 with an unauthenticated body", { status: 200, body: JSON.stringify({ status: "unauthenticated" }) }, false],
    ["302 to Canvas /login", { status: 302, body: "", location: "/login" }, true],
    ["302 to Canvas /login/saml", { status: 302, body: "", location: `${origin}/login/saml` }, true],
    ["302 to login.wisc.edu", { status: 302, body: "", location: "https://login.wisc.edu/idp/profile/SAML2/Redirect/SSO" }, true],
    ["302 elsewhere on Canvas", { status: 302, body: "", location: `${origin}/courses` }, false],
    ["302 to a lookalike host", { status: 302, body: "", location: "https://login.wisc.edu.example/" }, false],
    ["302 without Location", { status: 302, body: "" }, false],
    ["final URL moved to login.wisc.edu", { status: 200, body: "", url: "https://login.wisc.edu/idp/" }, true],
    ["final URL moved to Canvas /login", { status: 200, body: "", url: `${origin}/login/canvas` }, true],
    ["final URL is the profile", { status: 200, body: "{}", url: profile }, false],
    ["NetID login HTML", { status: 200, body: loginPage, contentType: "text/html" }, true],
    ["other HTML", { status: 200, body: "<html><title>Canvas</title></html>", contentType: "text/html" }, false],
    ["500", { status: 500, body: "" }, false],
  ];
  for (const [label, facts, signedOut] of rows)
    assert.equal(canvasProfileSignedOut(facts, origin), signedOut, label);
});

test("a login redirect or login page on the profile confirms the expiry", async () => {
  for (const confirm of [
    () => new Response(null, { status: 302, headers: { location: "https://login.wisc.edu/idp/profile/SAML2/Redirect/SSO" } }),
    () => new Response(null, { status: 302, headers: { location: `${origin}/login` } }),
    () => new Response(loginPage, { headers: { "content-type": "text/html" } }),
  ]) {
    const canvas = fakeCanvas((path) => (path.endsWith("/profile") ? confirm() : unauthenticated()));
    assert.equal((await failure(canvas.http.request(scope))).status, "needs_sign_in");
    assert.equal(canvas.http.needsSignIn, true);
    assert.equal(canvas.profileReads(), 1);
    const own = fakeCanvas(() => confirm());
    assert.equal((await failure(own.http.request(profile))).status, "needs_sign_in");
    assert.equal(own.calls.length, 1);
  }
  // A 403 carrying a login page is never a permission error: it is confirmed too.
  const forbidden = fakeCanvas((path) =>
    path.endsWith("/profile")
      ? unauthenticated()
      : new Response(loginPage, { status: 403, headers: { "content-type": "text/html" } }),
  );
  assert.equal((await failure(forbidden.http.request(scope))).status, "needs_sign_in");
});

test("an unauthenticated scope read confirmed by a profile 401 declares needs_sign_in", async () => {
  const canvas = fakeCanvas((path) =>
    path.endsWith("/profile") ? unauthenticated() : unauthenticated(),
  );
  const error = await failure(canvas.http.request(scope));
  assert.equal(error.status, "needs_sign_in");
  assert.equal(canvas.http.needsSignIn, true);
  assert.equal(canvas.profileReads(), 1);
  // The confirming read goes through the same fetch path and session policy.
  const confirm = canvas.calls.find((call) => call.path.endsWith("/profile"))!;
  assert.equal(confirm.init?.method, "GET");
  assert.equal(confirm.init?.credentials, "include");
  assert.equal(confirm.init?.redirect, "manual");
  // Later reads stop without a request.
  const before = canvas.calls.length;
  assert.equal((await failure(canvas.http.request(scope))).status, "needs_sign_in");
  assert.equal(canvas.calls.length, before);
});

test("a profile 200 means the session is not expired: the scope stays partial", async () => {
  const canvas = fakeCanvas((path) =>
    path.endsWith("/profile") ? json({ id: 9001 }) : unauthenticated(),
  );
  const error = await failure(canvas.http.request(scope));
  assert.equal(error.status, "partial");
  assert.equal(error.code, "sign_in_not_confirmed");
  assert.equal(canvas.http.needsSignIn, false);
  assert.equal(canvas.profileReads(), 1);
});

test("a bare 401, another error or a non-login redirect on the profile stays partial", async () => {
  for (const confirm of [
    () => new Response(null, { status: 401 }),
    unauthorized,
    () => json({ errors: [{ message: "unauthorized" }] }, 401),
    () => new Response(null, { status: 302, headers: { location: `${origin}/courses` } }),
    () => new Response(null, { status: 500 }),
  ]) {
    const canvas = fakeCanvas((path) => (path.endsWith("/profile") ? confirm() : unauthenticated()));
    assert.equal((await failure(canvas.http.request(scope))).status, "partial");
    assert.equal(canvas.http.needsSignIn, false);
  }
});

test("unauthorized 401 and a non-rate-limit 403 mark only that scope inaccessible", async () => {
  for (const response of [unauthorized, () => json({ message: "not authorized" }, 403)]) {
    const canvas = fakeCanvas((path) => (path.endsWith("/profile") ? json({ id: 1 }) : response()));
    const error = await failure(canvas.http.request(scope));
    assert.equal(error.status, "inaccessible");
    assert.equal(error.code, "not_authorized");
    assert.equal(canvas.http.needsSignIn, false);
    assert.equal(canvas.profileReads(), 0);
  }
});

test("a rate-limit 403 retries and is never treated as sign-in or inaccessible", async () => {
  let scopeCalls = 0;
  const canvas = fakeCanvas((path) => {
    if (path.endsWith("/profile")) return json({ id: 1 });
    scopeCalls++;
    return scopeCalls < 3
      ? json({ errors: [{ message: "Rate Limit Exceeded" }] }, 403, { "retry-after": "0" })
      : json([]);
  });
  assert.deepEqual((await canvas.http.request(scope)).data, []);
  assert.equal(scopeCalls, 3);
  assert.equal(canvas.http.needsSignIn, false);
  assert.equal(canvas.profileReads(), 0);
});

test("redirects and login pages are confirmed by the profile read before expiry", async () => {
  for (const response of [
    () => new Response(null, { status: 302, headers: { location: "https://login.wisc.edu/" } }),
    () => new Response("<html>NetID</html>", { headers: { "content-type": "text/html" } }),
    () => new Response("<html>NetID</html>", { headers: { "content-type": "application/json" } }),
  ]) {
    const expired = fakeCanvas((path) => (path.endsWith("/profile") ? unauthenticated() : response()));
    assert.equal((await failure(expired.http.request(scope))).status, "needs_sign_in");
    assert.equal(expired.profileReads(), 1);
    const signedIn = fakeCanvas((path) => (path.endsWith("/profile") ? json({ id: 1 }) : response()));
    assert.equal((await failure(signedIn.http.request(scope))).status, "partial");
    assert.equal(signedIn.http.needsSignIn, false);
  }
});

test("the profile read is its own confirmation, and concurrent scopes share one confirmation", async () => {
  const own = fakeCanvas(() => unauthenticated());
  assert.equal((await failure(own.http.request(profile))).status, "needs_sign_in");
  assert.equal(own.calls.length, 1);

  const shared = fakeCanvas(() => unauthenticated());
  const scopes = [41, 42, 43, 44].map((id) =>
    failure(shared.http.request(`${origin}/api/v1/courses/${id}/assignments?per_page=100`)),
  );
  for (const error of await Promise.all(scopes)) assert.equal(error.status, "needs_sign_in");
  assert.equal(shared.profileReads(), 1);
});

test("an expiry and a re-sign-in keep every stored record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-expiry-"));
  const store = createStore(join(directory, "test.sqlite"));
  try {
    const university = createSyntheticCanvasUniversity({ origin, rateLimit: false });
    let expired = false;
    let hour = 15;
    const pull = async () => {
      const batches: CaptureBatch[] = [];
      for await (const batch of canvasConnector({
        origin,
        fetch: (url, init) => (expired ? Promise.resolve(unauthenticated()) : university.fetch(url, init)),
        now: () => new Date(`2026-09-26T${hour}:00:00Z`),
        sleep: async () => {},
        random: () => 0,
      }).pull())
        batches.push(batch);
      return batches;
    };
    const live = () => store.resources().filter((resource) => !resource.deleted).length;
    for (const batch of await pull()) store.ingest(batch);
    const count = live();
    assert.ok(count > 0);
    expired = true;
    hour = 16;
    const expiredBatches = await pull();
    assert.equal(expiredBatches.at(-1)!.status, "needs_sign_in");
    for (const batch of expiredBatches) store.ingest(batch);
    assert.equal(live(), count);
    assert.ok(store.sources().some((source) => source.status === "needs_sign_in"));
    expired = false;
    hour = 17;
    for (const batch of await pull()) store.ingest(batch);
    assert.equal(live(), count);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("launch check reads cookie names only and decides with 0 requests", () => {
  const session = [{ name: "canvas_session", domain: "canvas.wisc.edu" }];
  const duoOnly = [
    { name: "_cfduid_remember", domain: ".duosecurity.com" },
    { name: "AWSALB", domain: "canvas.wisc.edu" },
  ];
  assert.equal(hasCanvasSession(session), true);
  assert.equal(hasCanvasSession([{ name: "canvas_session", domain: ".canvas.wisc.edu" }]), true);
  assert.equal(hasCanvasSession([{ name: "canvas_session", domain: "evil.example" }]), false);
  assert.equal(hasCanvasSession(duoOnly), false);
  const base = { signedInBefore: true, keepSignedIn: true, headless: false };
  assert.deepEqual(launchSession({ ...base, cookies: session }), { state: "signed_in" });
  assert.deepEqual(launchSession({ ...base, cookies: duoOnly }), {
    state: "sign_in_again",
    openSignIn: true,
  });
  assert.deepEqual(launchSession({ ...base, keepSignedIn: false, cookies: [] }), {
    state: "sign_in_again",
    openSignIn: false,
  });
  assert.deepEqual(launchSession({ ...base, headless: true, cookies: [] }), {
    state: "sign_in_again",
    openSignIn: false,
  });
  // First run: nothing opens by itself; the consent step comes first.
  assert.deepEqual(launchSession({ ...base, signedInBefore: false, cookies: [] }), {
    state: "first_run",
  });
});

test("a second sign-in call waits for the open window instead of returning", async () => {
  const flight = singleFlight<boolean>();
  let opened = 0;
  let finish!: (value: boolean) => void;
  const start = () => {
    opened++;
    return new Promise<boolean>((resolve) => {
      finish = resolve;
    });
  };
  const first = flight.run(start);
  const second = flight.run(start);
  assert.equal(flight.pending, true);
  let secondDone = false;
  void second.then(() => {
    secondDone = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened, 1);
  assert.equal(secondDone, false);
  finish(true);
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(flight.pending, false);
  const third = flight.run(async () => false);
  assert.equal(await third, false);
  assert.equal(opened, 1);
});

test("the My UW and Enroll windows close only on a confirmed session read", () => {
  const meta = { host: "my.wisc.edu", source: "myuw", bytes: 10, elapsedMs: 1 };
  const ok = (data: unknown) => ({ ...meta, status: "ok", data }) as unknown as UwPlanningReadResult;
  const myuw = {
    person: {
      firstName: "Synthetic", lastName: "Student", displayName: "Synthetic Student",
      userName: "synthetic", sessionKey: "synthetic-key", serverName: "portal.synthetic", version: "1",
    },
  };
  assert.deepEqual(planningProbe("myuw"), { kind: "myuw-session" });
  assert.deepEqual(planningProbe("enroll"), { kind: "student-info" });
  assert.equal(planningSessionConfirmed("myuw", ok(myuw)), true);
  assert.equal(planningSessionConfirmed("myuw", ok({ person: {} })), false);
  assert.equal(planningSessionConfirmed("enroll", ok({ personAttributes: { emplid: "9000000001" } })), true);
  assert.equal(planningSessionConfirmed("enroll", ok({ personAttributes: { emplid: "not-an-id" } })), false);
  assert.equal(planningSessionConfirmed("enroll", ok({})), false);
  const blocked = { ...meta, status: "needs_sign_in", code: "unauthorized" } as unknown as UwPlanningReadResult;
  assert.equal(planningSessionConfirmed("myuw", blocked), false);
  assert.equal(planningSessionConfirmed("enroll", blocked), false);
});

test("keep-signed-in close, quit and login-item decisions", () => {
  // Closing the window.
  assert.equal(closeAction({ keepSignedIn: true, quitting: false }), "hide");
  assert.equal(closeAction({ keepSignedIn: false, quitting: false }), "close");
  assert.equal(closeAction({ keepSignedIn: true, quitting: true }), "close");
  assert.equal(closeAction({ keepSignedIn: false, quitting: true }), "close");
  // The login item: never for the dev binary.
  assert.equal(loginItemSettings({ isPackaged: false, keepSignedIn: true }), null);
  assert.equal(loginItemSettings({ isPackaged: false, keepSignedIn: false }), null);
  assert.deepEqual(loginItemSettings({ isPackaged: true, keepSignedIn: true }), { openAtLogin: true });
  assert.deepEqual(loginItemSettings({ isPackaged: true, keepSignedIn: false }), { openAtLogin: false });
  // The tray.
  assert.equal(trayWanted({ keepSignedIn: true, headless: false }), true);
  assert.equal(trayWanted({ keepSignedIn: false, headless: false }), false);
  assert.equal(trayWanted({ keepSignedIn: true, headless: true }), false);
  assert.deepEqual(trayMenu.map((item) => item.action), ["open", "signout", "quit"]);
  assert.equal(trayBitmap(32).length, 32 * 32 * 4);
});

test("the keep-signed-in setting defaults on and round-trips through its file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-settings-"));
  try {
    const path = join(directory, "session-settings.json");
    assert.deepEqual(await readSessionSettings(path), { keepSignedIn: true, signedInBefore: false });
    await writeFile(path, "{not json");
    assert.deepEqual(await readSessionSettings(path), defaultSessionSettings);
    await writeSessionSettings(path, { keepSignedIn: false, signedInBefore: true });
    assert.deepEqual(await readSessionSettings(path), { keepSignedIn: false, signedInBefore: true });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      keepSignedIn: false,
      signedInBefore: true,
    });
    assert.deepEqual(parseSessionSettings({ keepSignedIn: "yes", extra: 1 }), defaultSessionSettings);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
